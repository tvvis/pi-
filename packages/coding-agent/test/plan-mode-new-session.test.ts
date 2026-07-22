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
		enterPlanModeInternal: vi.fn(),
		carryOverPlanModel: vi.fn().mockResolvedValue(undefined),
		runtimeHost: {
			newSession: vi.fn().mockResolvedValue({ cancelled: false }),
			switchSession: vi.fn().mockResolvedValue({ cancelled: false }),
			fork: vi.fn().mockResolvedValue({ cancelled: false }),
		},
		sessionManager: { getSessionFile: vi.fn().mockReturnValue("/fake/parent-session.jsonl") },
		renderCurrentSessionState: vi.fn(),
		session: {
			setSessionNote: vi.fn(),
			setExecutePlan: vi.fn(),
			prompt: vi.fn().mockResolvedValue(undefined),
			sessionManager: { appendSessionInfo: vi.fn() },
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

describe("InteractiveMode plan-mode choice 3 (new session + auto-execute)", () => {
	afterEach(() => {
		exitPlanMode();
		rmSync(DRAFT_DIR, { recursive: true, force: true });
	});

	test("creates a clean new session, injects executePlan, and auto-prompts execution", async () => {
		enterPlanMode({ sessionId: SESSION_ID });
		const draftRoot = getDraftRoot()!;
		mkdirSync(draftRoot, { recursive: true });
		writeFileSync(join(draftRoot, "draft.md"), "# Plan: test\n", "utf-8");
		const expectedDraftPath = join(draftRoot, "draft.md");

		const fakeThis = createFakeThis();
		await handlePlanModeChoice(fakeThis, 3);

		expect(fakeThis.exitPlanModeInternal).toHaveBeenCalledTimes(1);
		expect(fakeThis.exitPlanModeInternal).toHaveBeenCalledWith("execute");
		// Clean new session with lineage back to the planning session, NOT a fork.
		expect(fakeThis.runtimeHost.newSession).toHaveBeenCalledTimes(1);
		expect(fakeThis.runtimeHost.newSession).toHaveBeenCalledWith({
			parentSession: "/fake/parent-session.jsonl",
			parentRelation: "plan",
		});
		expect(fakeThis.runtimeHost.fork).not.toHaveBeenCalled();
		// The draft path is injected into the new session's system prompt
		// via setExecutePlan (NOT via sessionNote).
		expect(fakeThis.session.setExecutePlan).toHaveBeenCalledTimes(1);
		expect(fakeThis.session.setExecutePlan).toHaveBeenCalledWith({
			planPath: expectedDraftPath,
			title: "test",
		});
		// The execution turn is kicked off automatically.
		expect(fakeThis.session.prompt).toHaveBeenCalledTimes(1);
		// The planning session's model is carried into the new session instead
		// of the re-derived default (captured before the rebind).
		expect(fakeThis.carryOverPlanModel).toHaveBeenCalledTimes(1);
		expect(fakeThis.carryOverPlanModel).toHaveBeenCalledWith({ provider: "faux", id: "plan-model" });
		const promptText = fakeThis.session.prompt.mock.calls[0]![0] as string;
		expect(promptText).toContain(expectedDraftPath);
		// New session is auto-named from the plan H1 title for /resume traceability.
		expect(fakeThis.session.sessionManager.appendSessionInfo).toHaveBeenCalledTimes(1);
		expect(fakeThis.session.sessionManager.appendSessionInfo).toHaveBeenCalledWith("test");
		expect(fakeThis.handleFatalRuntimeError).not.toHaveBeenCalled();
		// Choice 3 must NOT trigger the queue-and-switch-back flow.
		expect(fakeThis.runtimeHost.switchSession).not.toHaveBeenCalled();
		expect(fakeThis.enterPlanModeInternal).not.toHaveBeenCalled();
	});

	test("does not inject a plan or prompt when there is no draft root", async () => {
		exitPlanMode(); // no plan-mode state → getDraftRoot() returns null

		const fakeThis = createFakeThis();
		await handlePlanModeChoice(fakeThis, 3);

		expect(fakeThis.runtimeHost.newSession).toHaveBeenCalledTimes(1);
		expect(fakeThis.runtimeHost.fork).not.toHaveBeenCalled();
		expect(fakeThis.session.setExecutePlan).not.toHaveBeenCalled();
		expect(fakeThis.session.prompt).not.toHaveBeenCalled();
	});

	test("does not inject a plan or prompt when the draft file is missing", async () => {
		enterPlanMode({ sessionId: SESSION_ID });
		// Draft root is set, but no draft.md file exists on disk.
		expect(existsSync(join(getDraftRoot()!, "draft.md"))).toBe(false);

		const fakeThis = createFakeThis();
		await handlePlanModeChoice(fakeThis, 3);

		expect(fakeThis.runtimeHost.newSession).toHaveBeenCalledTimes(1);
		expect(fakeThis.runtimeHost.fork).not.toHaveBeenCalled();
		expect(fakeThis.session.setExecutePlan).not.toHaveBeenCalled();
		expect(fakeThis.session.prompt).not.toHaveBeenCalled();
	});

	test("does not inject or render when newSession is cancelled", async () => {
		enterPlanMode({ sessionId: SESSION_ID });
		const draftRoot = getDraftRoot()!;
		mkdirSync(draftRoot, { recursive: true });
		writeFileSync(join(draftRoot, "draft.md"), "# Plan: test\n", "utf-8");

		const fakeThis = createFakeThis();
		fakeThis.runtimeHost.newSession = vi.fn().mockResolvedValue({ cancelled: true });
		await handlePlanModeChoice(fakeThis, 3);

		expect(fakeThis.session.setExecutePlan).not.toHaveBeenCalled();
		expect(fakeThis.renderCurrentSessionState).not.toHaveBeenCalled();
		expect(fakeThis.session.prompt).not.toHaveBeenCalled();
	});

	test("auto-names the new session from a plain H1 (no `Plan:` prefix)", async () => {
		enterPlanMode({ sessionId: SESSION_ID });
		const draftRoot = getDraftRoot()!;
		mkdirSync(draftRoot, { recursive: true });
		writeFileSync(join(draftRoot, "draft.md"), "# Refactor the auth flow\n\nbody\n", "utf-8");

		const fakeThis = createFakeThis();
		await handlePlanModeChoice(fakeThis, 3);

		expect(fakeThis.session.sessionManager.appendSessionInfo).toHaveBeenCalledTimes(1);
		expect(fakeThis.session.sessionManager.appendSessionInfo).toHaveBeenCalledWith("Refactor the auth flow");
	});

	test("does not auto-name when the draft has no H1 heading", async () => {
		enterPlanMode({ sessionId: SESSION_ID });
		const draftRoot = getDraftRoot()!;
		mkdirSync(draftRoot, { recursive: true });
		writeFileSync(join(draftRoot, "draft.md"), "no headings here\njust body text\n", "utf-8");

		const fakeThis = createFakeThis();
		await handlePlanModeChoice(fakeThis, 3);

		expect(fakeThis.session.setExecutePlan).toHaveBeenCalledTimes(1);
		expect(fakeThis.session.prompt).toHaveBeenCalledTimes(1);
		expect(fakeThis.session.sessionManager.appendSessionInfo).not.toHaveBeenCalled();
	});

	test("caps auto-named titles at 80 characters", async () => {
		enterPlanMode({ sessionId: SESSION_ID });
		const draftRoot = getDraftRoot()!;
		mkdirSync(draftRoot, { recursive: true });
		const longTitle = "a".repeat(200);
		writeFileSync(join(draftRoot, "draft.md"), `# Plan: ${longTitle}\n`, "utf-8");

		const fakeThis = createFakeThis();
		await handlePlanModeChoice(fakeThis, 3);

		expect(fakeThis.session.sessionManager.appendSessionInfo).toHaveBeenCalledTimes(1);
		const name = fakeThis.session.sessionManager.appendSessionInfo.mock.calls[0]![0] as string;
		expect(name.length).toBeLessThanOrEqual(80);
		expect(name.endsWith("...")).toBe(true);
	});
});
