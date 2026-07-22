import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { enterPlanMode, exitPlanMode, getDraftRoot } from "../src/modes/interactive/plan-mode-state.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

initTheme("dark", false);

const SESSION_ID = "plan-queue-test";
const DRAFT_DIR = join(homedir(), ".pi", "draft", SESSION_ID);
const PARENT_SESSION_FILE = "/fake/parent-session.jsonl";
const QUEUED_SESSION_FILE = "/fake/queued-session.jsonl";

function createFakeThis() {
	const newSession = vi.fn().mockImplementation(async () => ({ cancelled: false }));
	// getSessionFile() is called twice on the happy path of choice 4:
	//   1. Before newSession, to capture parentSessionFile.
	//   2. After newSession, to capture queuedSessionFile (current session path).
	// On the cancelled newSession path, only call 1 happens.
	const sessionManager = {
		getSessionFile: vi
			.fn()
			.mockReturnValueOnce(PARENT_SESSION_FILE) // call 1: parentSessionFile
			.mockReturnValueOnce(QUEUED_SESSION_FILE) // call 2: queuedSessionFile
			.mockReturnValue(PARENT_SESSION_FILE),
		getSessionId: vi.fn().mockReturnValue(SESSION_ID),
		flush: vi.fn(),
	};
	return {
		inPlanMode: true as boolean,
		loadingAnimation: undefined as { stop: () => void } | undefined,
		statusContainer: { clear: vi.fn() },
		exitPlanModeInternal: vi.fn(),
		enterPlanModeInternal: vi.fn(),
		carryOverPlanModel: vi.fn().mockResolvedValue(undefined),
		runtimeHost: {
			newSession,
			switchSession: vi.fn().mockResolvedValue({ cancelled: false }),
			fork: vi.fn().mockResolvedValue({ cancelled: false }),
		},
		sessionManager,
		renderCurrentSessionState: vi.fn(),
		session: {
			setSessionNote: vi.fn(),
			setExecutePlan: vi.fn(),
			prompt: vi.fn().mockResolvedValue(undefined),
			sessionManager: { appendSessionInfo: vi.fn(), flush: vi.fn() },
			model: { provider: "faux", id: "plan-model" },
		},
		showStatus: vi.fn(),
		showError: vi.fn(),
		handleFatalRuntimeError: vi.fn().mockResolvedValue(undefined),
	};
}

function handlePlanModeChoice(fakeThis: ReturnType<typeof createFakeThis>, choice: 1 | 2 | 3 | 4): Promise<void> {
	const fn = Reflect.get(InteractiveMode.prototype, "handlePlanModeChoice") as (
		this: ReturnType<typeof createFakeThis>,
		choice: 1 | 2 | 3 | 4,
	) => Promise<void>;
	return fn.call(fakeThis, choice);
}

describe("InteractiveMode plan-mode choice 4 (queue + continue planning)", () => {
	afterEach(() => {
		exitPlanMode();
		rmSync(DRAFT_DIR, { recursive: true, force: true });
	});

	test("stops the in-flight working loader and clears the status container", async () => {
		enterPlanMode({ sessionId: SESSION_ID });
		const draftRoot = getDraftRoot()!;
		mkdirSync(draftRoot, { recursive: true });
		writeFileSync(join(draftRoot, "draft.md"), "# Plan: test\n", "utf-8");

		const fakeThis = createFakeThis();
		// Simulate an active working loader from the model turn that just
		// called plan({ready:true}). Without cleanup, this widget would
		// remain in the status container after the session swap, because
		// agent_end on the old runtime never fires (it was aborted by
		// dispose()).
		const stop = vi.fn();
		fakeThis.loadingAnimation = { stop };

		await handlePlanModeChoice(fakeThis, 4);

		expect(stop).toHaveBeenCalledTimes(1);
		expect(fakeThis.loadingAnimation).toBeUndefined();
		expect(fakeThis.statusContainer.clear).toHaveBeenCalled();
	});

	test("is a no-op on the loader when nothing is in flight", async () => {
		enterPlanMode({ sessionId: SESSION_ID });
		const draftRoot = getDraftRoot()!;
		mkdirSync(draftRoot, { recursive: true });
		writeFileSync(join(draftRoot, "draft.md"), "# Plan: test\n", "utf-8");

		const fakeThis = createFakeThis();
		// loadingAnimation is undefined; statusContainer.clear should still
		// be called (cheap and keeps the path consistent with option 3 / /new).
		await handlePlanModeChoice(fakeThis, 4);

		expect(fakeThis.loadingAnimation).toBeUndefined();
		expect(fakeThis.statusContainer.clear).toHaveBeenCalled();
	});

	test("creates a clean queued session with setExecutePlan and switches back to original", async () => {
		enterPlanMode({ sessionId: SESSION_ID });
		const draftRoot = getDraftRoot()!;
		mkdirSync(draftRoot, { recursive: true });
		writeFileSync(join(draftRoot, "draft.md"), "# Plan: test\n", "utf-8");
		const expectedDraftPath = join(draftRoot, "draft.md");

		const fakeThis = createFakeThis();
		await handlePlanModeChoice(fakeThis, 4);

		// Clean new session with lineage back to the planning session, NOT a fork.
		expect(fakeThis.runtimeHost.newSession).toHaveBeenCalledTimes(1);
		expect(fakeThis.runtimeHost.newSession).toHaveBeenCalledWith({
			parentSession: PARENT_SESSION_FILE,
			parentRelation: "plan",
		});
		expect(fakeThis.runtimeHost.fork).not.toHaveBeenCalled();
		// The queued session receives the draft path via setExecutePlan
		// (system prompt context), NOT via sessionNote or auto-prompt.
		expect(fakeThis.session.setExecutePlan).toHaveBeenCalledTimes(1);
		expect(fakeThis.session.setExecutePlan).toHaveBeenCalledWith({
			planPath: expectedDraftPath,
			title: "test",
		});
		expect(fakeThis.session.setSessionNote).not.toHaveBeenCalled();
		// Crucially: NO auto-prompt. The queued session is not executed
		// automatically; the user resumes it later via /resume.
		expect(fakeThis.session.prompt).not.toHaveBeenCalled();
		// The planning session's model is carried into the queued session
		// instead of the re-derived default (captured before the rebind).
		expect(fakeThis.carryOverPlanModel).toHaveBeenCalledTimes(1);
		expect(fakeThis.carryOverPlanModel).toHaveBeenCalledWith({ provider: "faux", id: "plan-model" });
		// Force-flush the queued session so it appears in /resume and the
		// session tree immediately, instead of waiting for the (never
		// arriving) first assistant message.
		expect(fakeThis.session.sessionManager.flush).toHaveBeenCalledTimes(1);
		// Switch back to the original planning session.
		expect(fakeThis.runtimeHost.switchSession).toHaveBeenCalledTimes(1);
		expect(fakeThis.runtimeHost.switchSession).toHaveBeenCalledWith(PARENT_SESSION_FILE);
		// Queued session is auto-named from the plan H1 title for /resume traceability.
		expect(fakeThis.session.sessionManager.appendSessionInfo).toHaveBeenCalledTimes(1);
		expect(fakeThis.session.sessionManager.appendSessionInfo).toHaveBeenCalledWith("test");
		expect(fakeThis.handleFatalRuntimeError).not.toHaveBeenCalled();
		// Plan-mode restoration on the original session is now handled by
		// the rebind sync (via the persisted state file), not by the
		// choice 4 handler itself.
		expect(fakeThis.exitPlanModeInternal).not.toHaveBeenCalled();
		expect(fakeThis.enterPlanModeInternal).not.toHaveBeenCalled();
		// Final status mentions the queued session path.
		const statusCalls = fakeThis.showStatus.mock.calls.map((c) => c[0] as string);
		expect(statusCalls.some((s) => s.includes(QUEUED_SESSION_FILE))).toBe(true);
	});

	test("does nothing in the queued session when there is no draft root", async () => {
		exitPlanMode(); // no plan-mode state → getDraftRoot() returns null

		const fakeThis = createFakeThis();
		await handlePlanModeChoice(fakeThis, 4);

		expect(fakeThis.runtimeHost.newSession).toHaveBeenCalledTimes(1);
		expect(fakeThis.runtimeHost.fork).not.toHaveBeenCalled();
		expect(fakeThis.session.setExecutePlan).not.toHaveBeenCalled();
		expect(fakeThis.session.prompt).not.toHaveBeenCalled();
		// Still flushes + switches back even without a draft.
		expect(fakeThis.session.sessionManager.flush).toHaveBeenCalledTimes(1);
		expect(fakeThis.runtimeHost.switchSession).toHaveBeenCalledTimes(1);
	});

	test("does not inject a plan when the draft file is missing", async () => {
		enterPlanMode({ sessionId: SESSION_ID });
		// Draft root is set, but no draft.md file exists on disk.
		expect(existsSync(join(getDraftRoot()!, "draft.md"))).toBe(false);

		const fakeThis = createFakeThis();
		await handlePlanModeChoice(fakeThis, 4);

		expect(fakeThis.runtimeHost.newSession).toHaveBeenCalledTimes(1);
		expect(fakeThis.runtimeHost.fork).not.toHaveBeenCalled();
		expect(fakeThis.session.setExecutePlan).not.toHaveBeenCalled();
		expect(fakeThis.session.prompt).not.toHaveBeenCalled();
		expect(fakeThis.session.sessionManager.flush).toHaveBeenCalledTimes(1);
		expect(fakeThis.runtimeHost.switchSession).toHaveBeenCalledTimes(1);
	});

	test("does not flush or switch when newSession is cancelled", async () => {
		enterPlanMode({ sessionId: SESSION_ID });
		const draftRoot = getDraftRoot()!;
		mkdirSync(draftRoot, { recursive: true });
		writeFileSync(join(draftRoot, "draft.md"), "# Plan: test\n", "utf-8");

		const fakeThis = createFakeThis();
		fakeThis.runtimeHost.newSession = vi.fn().mockResolvedValue({ cancelled: true });
		await handlePlanModeChoice(fakeThis, 4);

		expect(fakeThis.session.setExecutePlan).not.toHaveBeenCalled();
		expect(fakeThis.renderCurrentSessionState).not.toHaveBeenCalled();
		expect(fakeThis.session.prompt).not.toHaveBeenCalled();
		// On cancellation we stay in the original session; no flush needed.
		expect(fakeThis.session.sessionManager.flush).not.toHaveBeenCalled();
		expect(fakeThis.runtimeHost.switchSession).not.toHaveBeenCalled();
		// Plan-mode state is preserved by the rebind flow (which doesn't fire
		// on cancellation because newSession returns before teardown).
		expect(fakeThis.exitPlanModeInternal).not.toHaveBeenCalled();
		expect(fakeThis.enterPlanModeInternal).not.toHaveBeenCalled();
	});

	test("auto-names the queued session from a plain H1 (no `Plan:` prefix)", async () => {
		enterPlanMode({ sessionId: SESSION_ID });
		const draftRoot = getDraftRoot()!;
		mkdirSync(draftRoot, { recursive: true });
		writeFileSync(join(draftRoot, "draft.md"), "# Refactor the auth flow\n\nbody\n", "utf-8");

		const fakeThis = createFakeThis();
		await handlePlanModeChoice(fakeThis, 4);

		expect(fakeThis.session.sessionManager.appendSessionInfo).toHaveBeenCalledTimes(1);
		expect(fakeThis.session.sessionManager.appendSessionInfo).toHaveBeenCalledWith("Refactor the auth flow");
	});

	test("does not auto-name when the draft has no H1 heading", async () => {
		enterPlanMode({ sessionId: SESSION_ID });
		const draftRoot = getDraftRoot()!;
		mkdirSync(draftRoot, { recursive: true });
		writeFileSync(join(draftRoot, "draft.md"), "no headings here\njust body text\n", "utf-8");

		const fakeThis = createFakeThis();
		await handlePlanModeChoice(fakeThis, 4);

		expect(fakeThis.session.setExecutePlan).toHaveBeenCalledTimes(1);
		expect(fakeThis.session.prompt).not.toHaveBeenCalled();
		expect(fakeThis.session.sessionManager.appendSessionInfo).not.toHaveBeenCalled();
	});

	test("caps auto-named titles at 80 characters", async () => {
		enterPlanMode({ sessionId: SESSION_ID });
		const draftRoot = getDraftRoot()!;
		mkdirSync(draftRoot, { recursive: true });
		const longTitle = "a".repeat(200);
		writeFileSync(join(draftRoot, "draft.md"), `# Plan: ${longTitle}\n`, "utf-8");

		const fakeThis = createFakeThis();
		await handlePlanModeChoice(fakeThis, 4);

		expect(fakeThis.session.sessionManager.appendSessionInfo).toHaveBeenCalledTimes(1);
		const name = fakeThis.session.sessionManager.appendSessionInfo.mock.calls[0]![0] as string;
		expect(name.length).toBeLessThanOrEqual(80);
		expect(name.endsWith("...")).toBe(true);
	});

	test("skips switch-back and shows a warning when switchSession fails", async () => {
		enterPlanMode({ sessionId: SESSION_ID });
		const draftRoot = getDraftRoot()!;
		mkdirSync(draftRoot, { recursive: true });
		writeFileSync(join(draftRoot, "draft.md"), "# Plan: test\n", "utf-8");

		const fakeThis = createFakeThis();
		fakeThis.runtimeHost.switchSession = vi.fn().mockResolvedValue({ cancelled: true });
		await handlePlanModeChoice(fakeThis, 4);

		// The queued session was still set up.
		expect(fakeThis.session.setExecutePlan).toHaveBeenCalledTimes(1);
		expect(fakeThis.session.prompt).not.toHaveBeenCalled();
		// Surface the queued session path so the user can find it via /resume.
		const statusCalls = fakeThis.showStatus.mock.calls.map((c) => c[0] as string);
		expect(statusCalls.some((s) => s.includes(QUEUED_SESSION_FILE))).toBe(true);
	});
});
