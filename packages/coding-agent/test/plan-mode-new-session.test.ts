import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { enterPlanMode, exitPlanMode, getDraftRoot } from "../src/modes/interactive/plan-mode-state.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

initTheme("dark", false);

const SESSION_ID = "plan-new-session-test";
const DRAFT_DIR = join(homedir(), ".pi", "draft", SESSION_ID);

function createFakeThis() {
	return {
		inPlanMode: true as boolean,
		exitPlanModeInternal: vi.fn(),
		runtimeHost: {
			newSession: vi.fn().mockResolvedValue({ cancelled: false }),
			fork: vi.fn().mockResolvedValue({ cancelled: false }),
		},
		renderCurrentSessionState: vi.fn(),
		session: { setSessionNote: vi.fn() },
		showStatus: vi.fn(),
		handleFatalRuntimeError: vi.fn().mockResolvedValue(undefined),
	};
}

function handlePlanModeChoice(fakeThis: ReturnType<typeof createFakeThis>, choice: 1 | 2 | 3): Promise<void> {
	const fn = Reflect.get(InteractiveMode.prototype, "handlePlanModeChoice") as (
		this: ReturnType<typeof createFakeThis>,
		choice: 1 | 2 | 3,
	) => Promise<void>;
	return fn.call(fakeThis, choice);
}

describe("InteractiveMode plan-mode choice 3 (new session)", () => {
	afterEach(() => {
		exitPlanMode();
		rmSync(DRAFT_DIR, { recursive: true, force: true });
	});

	test("creates a clean new session and injects the draft path into the system prompt", async () => {
		enterPlanMode({ sessionId: SESSION_ID });
		const draftRoot = getDraftRoot()!;
		mkdirSync(draftRoot, { recursive: true });
		writeFileSync(join(draftRoot, "draft.md"), "# Plan: test\n", "utf-8");
		const expectedDraftPath = join(draftRoot, "draft.md");

		const fakeThis = createFakeThis();
		await handlePlanModeChoice(fakeThis, 3);

		expect(fakeThis.exitPlanModeInternal).toHaveBeenCalledTimes(1);
		expect(fakeThis.exitPlanModeInternal).toHaveBeenCalledWith("execute");
		// Clean new session, NOT a fork — no inherited planning conversation.
		expect(fakeThis.runtimeHost.newSession).toHaveBeenCalledTimes(1);
		expect(fakeThis.runtimeHost.fork).not.toHaveBeenCalled();
		// The previous draft's path is injected into the new session's
		// system prompt so the model reads the plan and executes it.
		expect(fakeThis.session.setSessionNote).toHaveBeenCalledTimes(1);
		const note = fakeThis.session.setSessionNote.mock.calls[0]![0] as string;
		expect(note).toContain(expectedDraftPath);
		expect(fakeThis.handleFatalRuntimeError).not.toHaveBeenCalled();
	});

	test("does not inject a note when there is no draft root", async () => {
		exitPlanMode(); // no plan-mode state → getDraftRoot() returns null

		const fakeThis = createFakeThis();
		await handlePlanModeChoice(fakeThis, 3);

		expect(fakeThis.runtimeHost.newSession).toHaveBeenCalledTimes(1);
		expect(fakeThis.runtimeHost.fork).not.toHaveBeenCalled();
		expect(fakeThis.session.setSessionNote).not.toHaveBeenCalled();
	});

	test("does not inject a note when the draft file is missing", async () => {
		enterPlanMode({ sessionId: SESSION_ID });
		// Draft root is set, but no draft.md file exists on disk.
		expect(existsSync(join(getDraftRoot()!, "draft.md"))).toBe(false);

		const fakeThis = createFakeThis();
		await handlePlanModeChoice(fakeThis, 3);

		expect(fakeThis.runtimeHost.newSession).toHaveBeenCalledTimes(1);
		expect(fakeThis.runtimeHost.fork).not.toHaveBeenCalled();
		expect(fakeThis.session.setSessionNote).not.toHaveBeenCalled();
	});

	test("does not inject a note or render when newSession is cancelled", async () => {
		enterPlanMode({ sessionId: SESSION_ID });
		const draftRoot = getDraftRoot()!;
		mkdirSync(draftRoot, { recursive: true });
		writeFileSync(join(draftRoot, "draft.md"), "# Plan: test\n", "utf-8");

		const fakeThis = createFakeThis();
		fakeThis.runtimeHost.newSession = vi.fn().mockResolvedValue({ cancelled: true });
		await handlePlanModeChoice(fakeThis, 3);

		expect(fakeThis.session.setSessionNote).not.toHaveBeenCalled();
		expect(fakeThis.renderCurrentSessionState).not.toHaveBeenCalled();
	});
});
