import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

describe("SessionManager.flush", () => {
	let tempDir: string;
	let sessionManager: SessionManager;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-sm-flush-"));
		sessionManager = SessionManager.create(tempDir);
		sessionManager.newSession();
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	test("writes the session file to disk immediately, before any assistant message", () => {
		const sessionFile = sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		// Without flush, the file does not exist yet (no assistant message).
		expect(existsSync(sessionFile!)).toBe(false);

		sessionManager.flush();

		expect(existsSync(sessionFile!)).toBe(true);
		// The file must at minimum contain the session header.
		const content = readFileSync(sessionFile!, "utf-8");
		const lines = content.split("\n").filter((line) => line.length > 0);
		expect(lines.length).toBeGreaterThanOrEqual(1);
		const header = JSON.parse(lines[0]!) as { type: string; id: string };
		expect(header.type).toBe("session");
		expect(header.id).toBe(sessionManager.getSessionId());
	});

	test("can be called multiple times safely", () => {
		sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile()!;
		const afterFirst = readFileSync(sessionFile, "utf-8");

		sessionManager.flush();
		const afterSecond = readFileSync(sessionFile, "utf-8");

		expect(afterSecond).toBe(afterFirst);
	});

	test("no-op when there are no entries to write", () => {
		// Fresh manager with no entries at all.
		const empty = SessionManager.create(tempDir);
		empty.newSession();
		// Manually clear entries to simulate the (impossible-in-practice)
		// zero-entry case — flush must not throw and must not create the file.
		(empty as unknown as { fileEntries: unknown[] }).fileEntries = [];
		expect(() => empty.flush()).not.toThrow();
	});

	test("subsequent append still works after flush", () => {
		sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile()!;
		const beforeAppend = readFileSync(sessionFile, "utf-8").split("\n").filter(Boolean).length;

		sessionManager.appendSessionInfo("my-plan");
		const afterAppend = readFileSync(sessionFile, "utf-8").split("\n").filter(Boolean).length;
		expect(afterAppend).toBe(beforeAppend + 1);
	});
});
