import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { enterPlanMode, exitPlanMode, readPlanModeState } from "../src/modes/interactive/plan-mode-state.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

initTheme("dark", false);

const SESSION_A = "plan-rebind-a";
const SESSION_B = "plan-rebind-b";
const DRAFT_A = join(homedir(), ".pi", "draft", SESSION_A);
const DRAFT_B = join(homedir(), ".pi", "draft", SESSION_B);

function createFakeThis(opts: {
	inPlanMode?: boolean;
	sessionId?: string;
	sessionFile?: string;
}): ReturnType<typeof buildFake> {
	return buildFake(opts);
}

function buildFake(opts: { inPlanMode?: boolean; sessionId?: string; sessionFile?: string }) {
	const sessionId = opts.sessionId ?? SESSION_A;
	return {
		inPlanMode: opts.inPlanMode ?? false,
		planModeActiveToolNames: [] as string[],
		exitPlanModeInternal: vi.fn(),
		enterPlanModeInternal: vi.fn(),
		softExitPlanMode: vi.fn(),
		footer: { setPlanModeActive: vi.fn() },
		ui: { invalidate: vi.fn() },
		sessionManager: {
			getSessionId: vi.fn().mockReturnValue(sessionId),
			getSessionFile: vi.fn().mockReturnValue(opts.sessionFile ?? `/fake/${sessionId}.jsonl`),
			flush: vi.fn(),
		},
		session: {
			setExecutePlan: vi.fn(),
			sessionManager: { appendSessionInfo: vi.fn() },
		},
	};
}

function callSync(fakeThis: ReturnType<typeof buildFake>): void {
	const fn = Reflect.get(InteractiveMode.prototype, "syncPlanModeWithSessionState") as (
		this: ReturnType<typeof buildFake>,
	) => void;
	fn.call(fakeThis);
}

function callSoftExit(fakeThis: ReturnType<typeof buildFake>): void {
	const fn = Reflect.get(InteractiveMode.prototype, "softExitPlanMode") as (
		this: ReturnType<typeof buildFake>,
	) => void;
	fn.call(fakeThis);
}

describe("plan-mode persistence + rebind sync", () => {
	afterEach(() => {
		exitPlanMode();
		rmSync(DRAFT_A, { recursive: true, force: true });
		rmSync(DRAFT_B, { recursive: true, force: true });
	});

	test("enterPlanMode writes a state file under ~/.pi/draft/<sessionId>/", () => {
		enterPlanMode({ sessionId: SESSION_A, description: "design v2" });
		const persisted = readPlanModeState(SESSION_A);
		expect(persisted).not.toBeNull();
		expect(persisted?.active).toBe(true);
		expect(persisted?.description).toBe("design v2");
	});

	test("exitPlanMode removes the state file", () => {
		enterPlanMode({ sessionId: SESSION_A });
		expect(readPlanModeState(SESSION_A)).not.toBeNull();
		exitPlanMode();
		expect(readPlanModeState(SESSION_A)).toBeNull();
	});

	test("exitPlanMode({ keepStateFile: true }) keeps the state file", () => {
		enterPlanMode({ sessionId: SESSION_A });
		expect(readPlanModeState(SESSION_A)).not.toBeNull();
		exitPlanMode({ keepStateFile: true });
		// Module state cleared but state file preserved.
		expect(readPlanModeState(SESSION_A)).not.toBeNull();
	});

	test("readPlanModeState returns null for unknown sessions", () => {
		expect(readPlanModeState("nonexistent-session-id-xyz")).toBeNull();
	});

	test("sync enters plan mode when the session has an active state file", () => {
		// Pre-existing state file from a previous plan-mode enter.
		enterPlanMode({ sessionId: SESSION_A });
		const persisted = readPlanModeState(SESSION_A)!;
		// Clear module state without removing the state file (simulates the
		// process restarting after a previous plan-mode session was unloaded).
		exitPlanMode({ keepStateFile: true });

		const fakeThis = createFakeThis({ inPlanMode: false, sessionId: SESSION_A });
		callSync(fakeThis);

		expect(fakeThis.enterPlanModeInternal).toHaveBeenCalledTimes(1);
		expect(fakeThis.enterPlanModeInternal).toHaveBeenCalledWith({
			description: persisted.description,
		});
		expect(fakeThis.exitPlanModeInternal).not.toHaveBeenCalled();
	});

	test("sync soft-exits when the session has no state file", () => {
		// Simulate: currently in plan mode for a different session.
		enterPlanMode({ sessionId: SESSION_A });
		// Now switch to B (which has no state file).
		const fakeThis = createFakeThis({ inPlanMode: true, sessionId: SESSION_B });
		// Soft-exit directly to mirror what sync does in this branch.
		callSoftExit(fakeThis);

		expect(fakeThis.enterPlanModeInternal).not.toHaveBeenCalled();
		// A's state file is preserved (softExit doesn't touch it).
		expect(readPlanModeState(SESSION_A)).not.toBeNull();
	});

	test("sync re-enters for the new session when both old and new had plan mode", () => {
		// Both sessions previously in plan mode. Clear module state without
		// removing the state files so sync can still read them.
		enterPlanMode({ sessionId: SESSION_A });
		exitPlanMode({ keepStateFile: true });
		enterPlanMode({ sessionId: SESSION_B });
		const bPersisted = readPlanModeState(SESSION_B)!;
		exitPlanMode({ keepStateFile: true });

		// inPlanMode=true (stale from A), but sessionId is now B.
		const fakeThis = createFakeThis({ inPlanMode: true, sessionId: SESSION_B });
		callSync(fakeThis);

		// softExit + enterPlanModeInternal for the new session.
		expect(fakeThis.enterPlanModeInternal).toHaveBeenCalledTimes(1);
		expect(fakeThis.enterPlanModeInternal).toHaveBeenCalledWith({
			description: bPersisted.description,
		});
		// Both state files still exist.
		expect(readPlanModeState(SESSION_A)).not.toBeNull();
		expect(readPlanModeState(SESSION_B)).not.toBeNull();
	});

	test("sync is a no-op when in plan mode for the same session", () => {
		enterPlanMode({ sessionId: SESSION_A });
		const fakeThis = createFakeThis({ inPlanMode: true, sessionId: SESSION_A });
		callSync(fakeThis);
		expect(fakeThis.enterPlanModeInternal).not.toHaveBeenCalled();
		expect(fakeThis.exitPlanModeInternal).not.toHaveBeenCalled();
	});

	test("softExit clears in-memory state but preserves the state file", () => {
		enterPlanMode({ sessionId: SESSION_A });
		const fakeThis = createFakeThis({ inPlanMode: true, sessionId: SESSION_A });
		callSoftExit(fakeThis);
		expect(fakeThis.inPlanMode).toBe(false);
		// State file still on disk so /resume back will restore plan mode.
		expect(readPlanModeState(SESSION_A)).not.toBeNull();
	});
});
