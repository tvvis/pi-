import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	loadRecentFiles,
	MAX_RECENT_FILES,
	persistRecentFiles,
	type RecentFile,
	SIDEBAR_RECENT_FILES_CUSTOM_TYPE,
} from "../../src/modes/interactive/sidebar-recent-files-store.ts";

function makeRecentFile(absPath: string, tool: "edit" | "write" = "edit", offset = 0): RecentFile {
	return { absPath, lastTouchedAt: 1_700_000_000_000 + offset, tool };
}

function createTempDir(): string {
	const dir = join(tmpdir(), `pi-sidebar-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("sidebar-recent-files-store", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir && existsSync(dir)) {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	});

	it("exports a stable custom entry type id", () => {
		expect(SIDEBAR_RECENT_FILES_CUSTOM_TYPE).toBe("sidebar-recent-files");
	});

	it("returns an empty list when no entry is recorded", () => {
		const dir = createTempDir();
		tempDirs.push(dir);
		const session = SessionManager.create(dir);
		expect(loadRecentFiles(session)).toEqual([]);
	});

	it("returns the latest entry on the current branch", () => {
		const dir = createTempDir();
		tempDirs.push(dir);
		const session = SessionManager.create(dir);
		// Need an assistant message to trigger initial flush
		session.appendMessage({
			role: "user",
			content: "u",
			timestamp: 1,
		});
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "a" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});

		persistRecentFiles(session, [makeRecentFile("/a")]);
		persistRecentFiles(session, [makeRecentFile("/a"), makeRecentFile("/b", "write", 1)]);

		const loaded = loadRecentFiles(session);
		expect(loaded).toHaveLength(2);
		expect(loaded[0]?.absPath).toBe("/a");
		expect(loaded[1]?.absPath).toBe("/b");
		expect(loaded[1]?.tool).toBe("write");
	});

	it("survives close and reopen of the session", () => {
		const dir = createTempDir();
		tempDirs.push(dir);
		const first = SessionManager.create(dir);
		first.appendMessage({ role: "user", content: "u", timestamp: 1 });
		first.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "a" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		persistRecentFiles(first, [makeRecentFile("/x"), makeRecentFile("/y", "write", 1)]);
		const sessionFile = first.getSessionFile();
		expect(sessionFile).toBeDefined();

		const reopened = SessionManager.open(sessionFile!);
		const loaded = loadRecentFiles(reopened);
		expect(loaded.map((f) => f.absPath)).toEqual(["/x", "/y"]);
		expect(loaded[1]?.tool).toBe("write");
	});

	it("ignores malformed entries and falls back to a previous valid one", () => {
		const dir = createTempDir();
		tempDirs.push(dir);
		const session = SessionManager.create(dir);
		session.appendMessage({ role: "user", content: "u", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "a" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});

		// Valid entry first
		persistRecentFiles(session, [makeRecentFile("/good")]);
		// Then a malformed one (manually written, not validated by the store)
		session.appendCustomEntry(SIDEBAR_RECENT_FILES_CUSTOM_TYPE, { files: "not-an-array" });
		// And a third with partially-bad records
		session.appendCustomEntry(SIDEBAR_RECENT_FILES_CUSTOM_TYPE, {
			files: [makeRecentFile("/ok"), { absPath: 42, tool: "edit" }, null],
		});

		const loaded = loadRecentFiles(session);
		expect(loaded.map((f) => f.absPath)).toEqual(["/ok"]);
	});

	it("returns an empty list when following a branch that never recorded files", () => {
		const dir = createTempDir();
		tempDirs.push(dir);
		const session = SessionManager.create(dir);
		session.appendMessage({ role: "user", content: "u1", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "a1" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		persistRecentFiles(session, [makeRecentFile("/a")]);
		const lastLeaf = session.getLeafId()!;
		// Branch back to the first user message and add a new turn with no files
		const userEntry = session.getEntries().find((e) => e.type === "message" && e.message.role === "user");
		session.branch(userEntry!.id);
		session.appendMessage({ role: "user", content: "u2", timestamp: 3 });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "a2" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 4,
		});
		// Sanity: leaf has moved
		expect(session.getLeafId()).not.toBe(lastLeaf);
		// No recent-files custom entry exists on the new branch path
		expect(loadRecentFiles(session)).toEqual([]);
	});

	it("respects MAX_RECENT_FILES when loading oversized payloads", () => {
		const dir = createTempDir();
		tempDirs.push(dir);
		const session = SessionManager.create(dir);
		session.appendMessage({ role: "user", content: "u", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "a" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});

		const oversized = Array.from({ length: MAX_RECENT_FILES + 5 }, (_, i) => makeRecentFile(`/p${i}`));
		session.appendCustomEntry(SIDEBAR_RECENT_FILES_CUSTOM_TYPE, { files: oversized });

		const loaded = loadRecentFiles(session);
		expect(loaded).toHaveLength(MAX_RECENT_FILES);
	});
});
