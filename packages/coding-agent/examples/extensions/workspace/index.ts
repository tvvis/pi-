/**
 * Workspace Extension
 *
 * Single tool `workspace` with an `action` parameter for sharing information
 * across projects through a shared, cross-project workspace.
 *
 * Storage model (symlinks only):
 *   <root>/<project>/<path>  ->  symlink  ->  <cwd>/<path>
 *
 *   link create the symlink. The physical file at <cwd>/<path> must already
 *        exist (write it with the built-in write tool first).
 *   find list symlinks under workspace/<project>/ (recursive). Optional `path`
 *        scopes the search to a subdirectory.
 *
 * Use the built-in `read` tool to fetch the content of a linked file once its
 * path is known.
 *
 * `project` is optional. When omitted, it is auto-detected from `git
 * rev-parse --show-toplevel`, falling back to the cwd basename.
 *
 * Workspace root defaults to `~/.pi/agent/workspace/`. Override via the
 * `PI_WORKSPACE_ROOT` environment variable.
 */

import { execSync } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import { mkdir, readdir, readlink, rm, stat, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const PROJECT_RE = /^[a-zA-Z0-9_.-]+$/;
const DEFAULT_ROOT = join(homedir(), ".pi/agent/workspace");

function expandHome(p: string): string {
	return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function detectProject(cwd: string): string {
	try {
		const top = execSync("git rev-parse --show-toplevel", {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (top) return basename(top);
	} catch {
		// not a git repo or git unavailable
	}
	return basename(cwd) || "default";
}

function validateProject(name: string): void {
	if (!PROJECT_RE.test(name)) {
		throw new Error(`Invalid project name: ${name} (allowed: [a-zA-Z0-9_.-]+)`);
	}
}

function normalizePath(p: string): string {
	const cleaned = p.replace(/^@/, "");
	if (isAbsolute(cleaned) || cleaned.startsWith("/")) {
		throw new Error(`Absolute path not allowed: ${p}`);
	}
	const segments = cleaned.split("/").filter(Boolean);
	for (const seg of segments) {
		if (seg === "." || seg === "..") throw new Error(`Path traversal not allowed: ${p}`);
	}
	const result = segments.join("/");
	if (!result) throw new Error("Path must not be empty");
	return result;
}

function fmtBytes(n: number): string {
	if (n < 1024) return `${n}B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
	return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

type Entry = { relPath: string; kind: "symlink" | "file" | "dir"; target?: string; size: number };

async function walkEntries(dir: string, prefix: string): Promise<Entry[]> {
	const items = await readdir(dir, { withFileTypes: true });
	items.sort((a, b) => a.name.localeCompare(b.name));
	const out: Entry[] = [];
	for (const item of items) {
		const full = join(dir, item.name);
		const rel = prefix ? `${prefix}/${item.name}` : item.name;
		if (item.isSymbolicLink()) {
			let target = "";
			let size = 0;
			try {
				target = await readlink(full);
				const st = await stat(full);
				size = st.isFile() ? st.size : 0;
			} catch {
				target = "(unreadable)";
			}
			out.push({ relPath: rel, kind: "symlink", target, size });
		} else if (item.isDirectory()) {
			out.push({ relPath: `${rel}/`, kind: "dir", size: 0 });
			out.push(...(await walkEntries(full, rel)));
		} else if (item.isFile()) {
			const st = await stat(full);
			out.push({ relPath: rel, kind: "file", size: st.size });
		}
	}
	return out;
}

export default function (pi: ExtensionAPI) {
	const root = expandHome(process.env.PI_WORKSPACE_ROOT ?? DEFAULT_ROOT);

	try {
		const homeLink = join(homedir(), "workspace");
		if (!existsSync(homeLink)) {
			symlinkSync(root, homeLink);
		}
	} catch {
		// ignore: permission denied or filesystem doesn't support symlinks
	}

	pi.registerTool({
		name: "workspace",
		label: "Workspace",
		description: [
			"Share and get information across projects.",
			"",
			"Actions:",
			"  link  share a file (under cwd) into the workspace",
			"  find  get published entries; pass `path` to scope to a subdirectory",
			"",
			"`project` is optional; auto-detected from git toplevel, falling back to cwd basename.",
		].join("\n"),
		promptSnippet: "Share & Get",
		promptGuidelines: [
			"Use workspace link when the user wants to share information with other projects; call link again with the same path to update a published entry.",
			"Use workspace find when the user needs information published by other projects, then read or edit it via the built-in tools.",
		],
		parameters: Type.Object({
			action: StringEnum(["link", "find"] as const),
			project: Type.Optional(
				Type.String({
					description: "Project namespace. Auto-detected from git toplevel / cwd basename when omitted.",
				}),
			),
			path: Type.Optional(
				Type.String({
					description:
						"Forward-slash path within the project. Required for link; scopes find to a subdirectory when used with action=find.",
				}),
			),
		}),

		async execute(_id, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) {
				return { content: [{ type: "text" as const, text: "Cancelled" }], details: {} };
			}

			const project = params.project ?? detectProject(ctx.cwd);
			validateProject(project);
			const cwd = ctx.cwd;
			await mkdir(join(root, project), { recursive: true });

			switch (params.action) {
				case "link":
					return doLink(root, project, cwd, params.path);
				case "find":
					return doFind(root, project, params.path);
			}
		},
	});
}

async function doLink(root: string, project: string, cwd: string, pathParam: string | undefined) {
	if (!pathParam) throw new Error("path required for action=link");
	const cleanPath = normalizePath(pathParam);
	const link = join(root, project, cleanPath);
	const physical = join(cwd, cleanPath);

	if (!existsSync(physical)) {
		throw new Error(
			`Physical file does not exist: ${physical}\n` +
				`Write the file first (e.g., with the built-in write tool), then call workspace link.`,
		);
	}
	const pst = await stat(physical);
	if (!pst.isFile()) {
		throw new Error(`Physical entry is not a regular file: ${physical}`);
	}

	if (existsSync(link)) await rm(link, { force: true });
	await mkdir(dirname(link), { recursive: true });
	const target = relative(dirname(link), physical);
	await symlink(target, link);

	return {
		content: [
			{
				type: "text" as const,
				text: `Linked ${link} -> ${target} (${fmtBytes(pst.size)})`,
			},
		],
		details: {
			action: "link" as const,
			project,
			path: pathParam,
			physicalPath: physical,
			workspaceLink: link,
			bytes: pst.size,
		},
	};
}

async function doFind(root: string, project: string, pathParam: string | undefined) {
	const sub = pathParam ? normalizePath(pathParam) : "";
	const base = sub ? join(root, project, sub) : join(root, project);
	if (!existsSync(base)) {
		return {
			content: [{ type: "text" as const, text: `No entries under ${base.replace(root, "<root>")}` }],
			details: { action: "find" as const, project, entries: [] },
		};
	}
	const entries = await walkEntries(base, sub);
	if (entries.length === 0) {
		return {
			content: [{ type: "text" as const, text: `No entries under ${base.replace(root, "<root>")}` }],
			details: { action: "find" as const, project, entries: [] },
		};
	}
	const lines = entries.map((e) => {
		if (e.kind === "symlink") {
			const size = e.size > 0 ? ` (${fmtBytes(e.size)})` : "";
			return `${e.relPath} -> ${e.target}${size}`;
		}
		if (e.kind === "dir") return `${e.relPath}`;
		return `${e.relPath}  ${fmtBytes(e.size)}`;
	});
	return {
		content: [{ type: "text" as const, text: lines.join("\n") }],
		details: {
			action: "find" as const,
			project,
			entries: entries.map((e) => ({ relPath: e.relPath, kind: e.kind, target: e.target, size: e.size })),
		},
	};
}
