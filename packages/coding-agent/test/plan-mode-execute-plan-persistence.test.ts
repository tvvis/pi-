import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("AgentSession.setExecutePlan persistence", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			const h = harnesses.pop()!;
			h.cleanup();
		}
	});

	test("appends an execute_plan entry that buildSessionContext restores", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.session.setExecutePlan({ planPath: "/abs/draft.md", title: "My Plan" });

		// The in-memory session manager now holds the marker entry.
		const entries = harness.sessionManager.getEntries();
		const marker = entries.find((e) => e.type === "execute_plan");
		expect(marker).toBeDefined();
		expect(marker).toMatchObject({ planPath: "/abs/draft.md", title: "My Plan" });

		// buildSessionContext restores the execute-plan context from the entry.
		expect(harness.sessionManager.buildSessionContext().executePlan).toEqual({
			planPath: "/abs/draft.md",
			title: "My Plan",
		});
		// And the live getter agrees.
		expect(harness.session.executePlan).toEqual({ planPath: "/abs/draft.md", title: "My Plan" });
	});

	test("appends a clear entry (empty planPath) when called with undefined", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.session.setExecutePlan({ planPath: "/abs/draft.md", title: "My Plan" });
		harness.session.setExecutePlan(undefined);

		// The last execute_plan entry is the clear marker.
		const entries = harness.sessionManager.getEntries().filter((e) => e.type === "execute_plan");
		expect(entries.at(-1)).toMatchObject({ planPath: "" });
		// Cleared in-memory and in the resolved context.
		expect(harness.session.executePlan).toBeUndefined();
		expect(harness.sessionManager.buildSessionContext().executePlan).toBeUndefined();
	});

	test("{ persist: false } does not append a new entry (restore path)", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const before = harness.sessionManager.getEntries().length;
		harness.session.setExecutePlan({ planPath: "/abs/draft.md" }, { persist: false });
		const after = harness.sessionManager.getEntries().length;

		expect(after).toBe(before);
		// In-memory state is still set so the system prompt reflects it.
		expect(harness.session.executePlan).toEqual({ planPath: "/abs/draft.md" });
	});
});

describe("execute_plan disk round-trip", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-execute-plan-rt-"));
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	test("appendExecutePlan + flush + reopen restores executePlan via buildSessionContext", () => {
		const sm = SessionManager.create(tempDir);
		sm.newSession();
		// Seed an assistant message so _persist writes through immediately,
		// mirroring a real execution session that has at least one turn.
		sm.appendModelChange("faux", "faux-1");
		sm.appendExecutePlan("/abs/queued-draft.md", "Queued Plan");
		sm.flush();
		const file = sm.getSessionFile()!;
		expect(existsSync(file)).toBe(true);

		const reopened = SessionManager.open(file, undefined, tempDir);
		const ctx = reopened.buildSessionContext();
		expect(ctx.executePlan).toEqual({ planPath: "/abs/queued-draft.md", title: "Queued Plan" });
	});

	test("a later clear entry overrides a previous set on reload", () => {
		const sm = SessionManager.create(tempDir);
		sm.newSession();
		sm.appendModelChange("faux", "faux-1");
		sm.appendExecutePlan("/abs/draft.md", "First");
		sm.appendExecutePlan(undefined);
		sm.flush();
		const file = sm.getSessionFile()!;

		const reopened = SessionManager.open(file, undefined, tempDir);
		expect(reopened.buildSessionContext().executePlan).toBeUndefined();
	});
});
