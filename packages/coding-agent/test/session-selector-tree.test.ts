import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../src/core/session-manager.ts";
import {
	buildSessionTree,
	buildTreeParentMap,
	flattenSessionTree,
	injectSubagentGroups,
	subagentGroupPath,
} from "../src/modes/interactive/components/session-selector-tree.ts";

function makeSession(overrides: Partial<SessionInfo> & { id: string; modified: Date }): SessionInfo {
	return {
		path: overrides.path ?? `/tmp/${overrides.id}.jsonl`,
		id: overrides.id,
		cwd: overrides.cwd ?? "",
		name: overrides.name,
		parentSessionPath: overrides.parentSessionPath,
		parentRelation: overrides.parentRelation,
		created: overrides.created ?? new Date(0),
		modified: overrides.modified,
		messageCount: overrides.messageCount ?? 1,
		firstMessage: overrides.firstMessage ?? "(no messages)",
		allMessagesText: overrides.allMessagesText ?? "",
	};
}

const PARENT = "/tmp/parent.jsonl";

describe("session selector tree - subagent grouping", () => {
	it("groups subagent children under a virtual node, leaving fork children direct", () => {
		const sessions: SessionInfo[] = [
			makeSession({ id: "parent", path: PARENT, modified: new Date("2026-01-01T00:00:00.000Z") }),
			makeSession({
				id: "sub1",
				path: "/tmp/sub1.jsonl",
				parentSessionPath: PARENT,
				parentRelation: "subagent",
				modified: new Date("2026-01-02T00:00:00.000Z"),
			}),
			makeSession({
				id: "sub2",
				path: "/tmp/sub2.jsonl",
				parentSessionPath: PARENT,
				parentRelation: "subagent",
				modified: new Date("2026-01-03T00:00:00.000Z"),
			}),
			makeSession({
				id: "fork1",
				path: "/tmp/fork1.jsonl",
				parentSessionPath: PARENT,
				parentRelation: "fork",
				modified: new Date("2026-01-04T00:00:00.000Z"),
			}),
		];

		const roots = buildSessionTree(sessions);
		expect(roots).toHaveLength(1);
		const parent = roots[0]!;
		expect(parent.session.id).toBe("parent");

		// Parent has two direct children: the fork child and the virtual group.
		expect(parent.children).toHaveLength(2);
		const virtual = parent.children.find((c) => c.virtual);
		const fork = parent.children.find((c) => c.session.id === "fork1");
		expect(virtual).toBeDefined();
		expect(fork).toBeDefined();
		expect(fork!.virtual).toBeUndefined();

		// Virtual node holds both subagent children.
		expect(virtual!.children.map((c) => c.session.id).sort()).toEqual(["sub1", "sub2"]);
	});

	it("synthesizes the virtual node path, name, modified and messageCount", () => {
		const sessions: SessionInfo[] = [
			makeSession({ id: "parent", path: PARENT, modified: new Date("2026-01-01T00:00:00.000Z") }),
			makeSession({
				id: "sub1",
				path: "/tmp/sub1.jsonl",
				parentSessionPath: PARENT,
				parentRelation: "subagent",
				modified: new Date("2026-01-02T00:00:00.000Z"),
			}),
			makeSession({
				id: "sub2",
				path: "/tmp/sub2.jsonl",
				parentSessionPath: PARENT,
				parentRelation: "subagent",
				modified: new Date("2026-01-05T00:00:00.000Z"),
			}),
		];

		const roots = buildSessionTree(sessions);
		const virtual = roots[0]!.children.find((c) => c.virtual)!;
		expect(virtual.session.path).toBe(subagentGroupPath(PARENT));
		expect(virtual.session.path).toBe(`${PARENT}::subagent`);
		expect(virtual.session.name).toBe("subagent");
		expect(virtual.virtualLabel).toBe("subagent");
		// modified = latest child, messageCount = number of children
		expect(virtual.session.modified.getTime()).toBe(new Date("2026-01-05T00:00:00.000Z").getTime());
		expect(virtual.session.messageCount).toBe(2);
		// The virtual group itself carries no relation tag.
		expect(virtual.session.parentRelation).toBeUndefined();
	});

	it("does not insert a virtual node when there are no subagent children", () => {
		const sessions: SessionInfo[] = [
			makeSession({ id: "parent", path: PARENT, modified: new Date("2026-01-01T00:00:00.000Z") }),
			makeSession({
				id: "fork1",
				path: "/tmp/fork1.jsonl",
				parentSessionPath: PARENT,
				parentRelation: "fork",
				modified: new Date("2026-01-02T00:00:00.000Z"),
			}),
		];

		const roots = buildSessionTree(sessions);
		const parent = roots[0]!;
		expect(parent.children).toHaveLength(1);
		expect(parent.children[0]!.session.id).toBe("fork1");
		expect(parent.children.some((c) => c.virtual)).toBe(false);
	});

	it("omits the virtual node when all subagent children are filtered out", () => {
		// Simulate search filtering: only the parent and a fork child survive.
		const sessions: SessionInfo[] = [
			makeSession({ id: "parent", path: PARENT, modified: new Date("2026-01-01T00:00:00.000Z") }),
			makeSession({
				id: "fork1",
				path: "/tmp/fork1.jsonl",
				parentSessionPath: PARENT,
				parentRelation: "fork",
				modified: new Date("2026-01-02T00:00:00.000Z"),
			}),
		];

		const roots = buildSessionTree(sessions);
		injectSubagentGroups(roots); // idempotent; still no subagent children
		expect(roots[0]!.children.some((c) => c.virtual)).toBe(false);
	});

	it("flattenSessionTree includes the virtual node with correct depth and fold state", () => {
		const sessions: SessionInfo[] = [
			makeSession({ id: "parent", path: PARENT, modified: new Date("2026-01-01T00:00:00.000Z") }),
			makeSession({
				id: "sub1",
				path: "/tmp/sub1.jsonl",
				parentSessionPath: PARENT,
				parentRelation: "subagent",
				modified: new Date("2026-01-02T00:00:00.000Z"),
			}),
		];

		const roots = buildSessionTree(sessions);
		const groupPath = subagentGroupPath(PARENT);

		// With the virtual group folded (default), its child is hidden.
		const folded = flattenSessionTree(roots, new Set([groupPath]));
		expect(folded.map((n) => n.session.id)).toEqual(["parent", "parent-subagent"]);
		const virtualFlat = folded.find((n) => n.virtual)!;
		expect(virtualFlat.depth).toBe(1);
		expect(virtualFlat.hasChildren).toBe(true);
		expect(virtualFlat.isFolded).toBe(true);

		// Expanded: the subagent child appears at depth 2.
		const expanded = flattenSessionTree(roots, new Set());
		expect(expanded.map((n) => n.session.id)).toEqual(["parent", "parent-subagent", "sub1"]);
		const childFlat = expanded.find((n) => n.session.id === "sub1")!;
		expect(childFlat.depth).toBe(2);
	});

	it("buildTreeParentMap links subagent children through the virtual node", () => {
		const sessions: SessionInfo[] = [
			makeSession({ id: "parent", path: PARENT, modified: new Date("2026-01-01T00:00:00.000Z") }),
			makeSession({
				id: "sub1",
				path: "/tmp/sub1.jsonl",
				parentSessionPath: PARENT,
				parentRelation: "subagent",
				modified: new Date("2026-01-02T00:00:00.000Z"),
			}),
		];

		const roots = buildSessionTree(sessions);
		const parentMap = buildTreeParentMap(roots);
		const groupPath = subagentGroupPath(PARENT);

		// subagent child -> virtual group -> parent
		expect(parentMap.get("/tmp/sub1.jsonl")).toBe(groupPath);
		expect(parentMap.get(groupPath)).toBe(PARENT);
		expect(parentMap.has(PARENT)).toBe(false); // root has no parent
	});
});
