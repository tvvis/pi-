import type { SessionInfo } from "../../../core/session-manager.ts";
import { canonicalizePath as _canonicalizePath } from "../../../utils/paths.ts";

/** A session tree node for hierarchical display */
export interface SessionTreeNode {
	session: SessionInfo;
	children: SessionTreeNode[];
	/** True for synthetic group nodes (not backed by a real session file). */
	virtual?: boolean;
	/** Label for virtual group nodes (e.g. "subagent"). */
	virtualLabel?: string;
}

/** Flattened node for display with tree structure info */
export interface FlatSessionNode {
	session: SessionInfo;
	depth: number;
	isLast: boolean;
	/** For each ancestor level, whether there are more siblings after it */
	ancestorContinues: boolean[];
	/** Whether this session has any children (for fold marker) */
	hasChildren: boolean;
	/** Whether this node's subtree is currently collapsed */
	isFolded: boolean;
	/** True for synthetic group nodes (not backed by a real session file). */
	virtual?: boolean;
	/** Label for virtual group nodes (e.g. "subagent"). */
	virtualLabel?: string;
}

export function canonicalizePath(path: string | undefined): string | undefined {
	if (!path) return path;
	return _canonicalizePath(path);
}

/**
 * Synthetic, stable path for the virtual "subagent" group node that sits
 * under a parent session. Used as the key for `foldedPaths` / `sessionByPath`
 * so the group survives re-filtering. The `::subagent` suffix never collides
 * with a real filesystem path, and `canonicalizePath` falls back to the raw
 * string for non-existent paths, keeping the key stable.
 */
export function subagentGroupPath(parentPath: string): string {
	return `${canonicalizePath(parentPath) ?? parentPath}::subagent`;
}

/**
 * Build a tree structure from sessions based on parentSessionPath.
 * Returns root nodes sorted by modified date (descending).
 *
 * After the parent/child tree is built, subagent children
 * (`parentRelation === "subagent"`) of every node are gathered under a
 * synthetic virtual "subagent" group node so the `/resume` tree shows them
 * collapsed as a single branch. Human-created children (fork/plan) are left
 * attached directly to their parent.
 */
export function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
	const byPath = new Map<string, SessionTreeNode>();

	for (const session of sessions) {
		const sessionPath = canonicalizePath(session.path) ?? session.path;
		byPath.set(sessionPath, { session, children: [] });
	}

	const roots: SessionTreeNode[] = [];

	for (const session of sessions) {
		const sessionPath = canonicalizePath(session.path) ?? session.path;
		const node = byPath.get(sessionPath)!;
		const parentPath = canonicalizePath(session.parentSessionPath);

		if (parentPath && byPath.has(parentPath)) {
			byPath.get(parentPath)!.children.push(node);
		} else {
			roots.push(node);
		}
	}

	// Sort children and roots by modified date (descending)
	const sortNodes = (nodes: SessionTreeNode[]): void => {
		nodes.sort((a, b) => b.session.modified.getTime() - a.session.modified.getTime());
		for (const node of nodes) {
			sortNodes(node.children);
		}
	};
	sortNodes(roots);

	injectSubagentGroups(roots);

	return roots;
}

/**
 * Gather each node's direct `parentRelation === "subagent"` children under a
 * synthetic virtual group node. Mutates the tree in place. A group node is only
 * inserted when there is at least one subagent child, so a parent whose
 * subagent children were all filtered out by search shows no empty group.
 */
export function injectSubagentGroups(roots: SessionTreeNode[]): void {
	const walk = (node: SessionTreeNode): void => {
		const subagentChildren: SessionTreeNode[] = [];
		const otherChildren: SessionTreeNode[] = [];
		for (const child of node.children) {
			if (child.session.parentRelation === "subagent") {
				subagentChildren.push(child);
			} else {
				otherChildren.push(child);
			}
		}

		if (subagentChildren.length > 0) {
			subagentChildren.sort((a, b) => b.session.modified.getTime() - a.session.modified.getTime());
			const latestModified = subagentChildren.reduce(
				(max, child) => (child.session.modified.getTime() > max.getTime() ? child.session.modified : max),
				subagentChildren[0]!.session.modified,
			);
			const groupPath = subagentGroupPath(node.session.path);
			const virtualSession: SessionInfo = {
				path: groupPath,
				id: `${node.session.id}-subagent`,
				cwd: node.session.cwd,
				name: "subagent",
				parentSessionPath: node.session.path,
				created: node.session.created,
				modified: latestModified,
				messageCount: subagentChildren.length,
				firstMessage: "subagent",
				allMessagesText: "",
			};
			const virtualNode: SessionTreeNode = {
				session: virtualSession,
				children: subagentChildren,
				virtual: true,
				virtualLabel: "subagent",
			};
			node.children = [...otherChildren, virtualNode];
			node.children.sort((a, b) => b.session.modified.getTime() - a.session.modified.getTime());

			// Recurse into the real children (both the kept siblings and the
			// subagent sessions now nested under the virtual group) so their own
			// subagent descendants get grouped. Do NOT recurse into the virtual
			// node itself: its direct children are exactly `subagentChildren`,
			// and re-grouping them would nest groups infinitely.
			for (const child of otherChildren) walk(child);
			for (const child of subagentChildren) walk(child);
			return;
		}

		for (const child of node.children) {
			walk(child);
		}
	};

	for (const root of roots) {
		walk(root);
	}
}

/**
 * Build a map of child canonical path -> parent canonical path from the tree
 * structure (including virtual group nodes). Used for cursor-driven ancestor
 * walks so that virtual group nodes are treated as real ancestors of the
 * subagent sessions nested under them.
 */
export function buildTreeParentMap(roots: SessionTreeNode[]): Map<string, string> {
	const parentByPath = new Map<string, string>();
	const walk = (node: SessionTreeNode, parentPath: string | undefined): void => {
		const nodePath = canonicalizePath(node.session.path) ?? node.session.path;
		if (parentPath !== undefined) {
			parentByPath.set(nodePath, parentPath);
		}
		for (const child of node.children) {
			walk(child, nodePath);
		}
	};
	for (const root of roots) {
		walk(root, undefined);
	}
	return parentByPath;
}

/**
 * Flatten tree into display list with tree structure metadata.
 * `foldedPaths` (canonicalized session paths) hides the entire subtree of
 * matching nodes. Used for the default-collapsed session tree.
 */
export function flattenSessionTree(roots: SessionTreeNode[], foldedPaths?: Set<string>): FlatSessionNode[] {
	const result: FlatSessionNode[] = [];
	const folded = foldedPaths ?? new Set<string>();

	const walk = (node: SessionTreeNode, depth: number, ancestorContinues: boolean[], isLast: boolean): void => {
		const nodePath = canonicalizePath(node.session.path) ?? node.session.path;
		const hasChildren = node.children.length > 0;
		result.push({
			session: node.session,
			depth,
			isLast,
			ancestorContinues,
			hasChildren,
			isFolded: folded.has(nodePath),
			virtual: node.virtual,
			virtualLabel: node.virtualLabel,
		});

		if (folded.has(nodePath)) return; // subtree collapsed

		for (let i = 0; i < node.children.length; i++) {
			const childIsLast = i === node.children.length - 1;
			// Only show continuation line for non-root ancestors
			const continues = depth > 0 ? !isLast : false;
			walk(node.children[i]!, depth + 1, [...ancestorContinues, continues], childIsLast);
		}
	};

	for (let i = 0; i < roots.length; i++) {
		walk(roots[i]!, 0, [], i === roots.length - 1);
	}

	return result;
}
