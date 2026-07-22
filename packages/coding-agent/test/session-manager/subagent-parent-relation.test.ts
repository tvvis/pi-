import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

describe("SessionManager parent relation: subagent", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("writes parentSession and parentRelation: subagent into the header", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-sm-subagent-"));
		tempDirs.push(tempDir);
		const parentPath = join(tempDir, "parent.jsonl");

		const session = SessionManager.create(tempDir, tempDir, {
			parentSession: parentPath,
			parentRelation: "subagent",
		});

		const header = session.getHeader();
		expect(header).not.toBeNull();
		expect(header!.parentSession).toBe(parentPath);
		expect(header!.parentRelation).toBe("subagent");
	});

	it("persists the subagent relation to the session file on flush", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-sm-subagent-"));
		tempDirs.push(tempDir);
		const parentPath = join(tempDir, "parent.jsonl");

		const session = SessionManager.create(tempDir, tempDir, {
			parentSession: parentPath,
			parentRelation: "subagent",
		});
		session.flush();

		const sessionFile = session.getSessionFile()!;
		const firstLine = readFileSync(sessionFile, "utf-8").split("\n")[0]!;
		const header = JSON.parse(firstLine) as { parentSession?: string; parentRelation?: string };
		expect(header.parentSession).toBe(parentPath);
		expect(header.parentRelation).toBe("subagent");
	});

	it("exposes the subagent relation through SessionManager.list", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-sm-subagent-"));
		tempDirs.push(tempDir);
		const parentPath = join(tempDir, "parent.jsonl");

		const session = SessionManager.create(tempDir, tempDir, {
			parentSession: parentPath,
			parentRelation: "subagent",
		});
		// Append an assistant message so the session file is written and listable.
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const sessions = await SessionManager.list(tempDir, tempDir);
		const info = sessions.find((s) => s.id === session.getSessionId());
		expect(info).toBeDefined();
		expect(info!.parentRelation).toBe("subagent");
	});
});
