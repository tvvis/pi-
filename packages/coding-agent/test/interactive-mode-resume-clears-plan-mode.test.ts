import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

initTheme("dark", false);

describe("InteractiveMode /resume preserves per-session plan-mode via persistence", () => {
	function createFakeThis(overrides?: { inPlanMode?: boolean; missingCwd?: boolean }) {
		const switchSession = vi
			.fn()
			.mockImplementationOnce(async () => ({ cancelled: false }))
			.mockImplementation(async () => ({ cancelled: false }));
		return {
			loadingAnimation: { stop: vi.fn() } as { stop: () => void } | undefined,
			statusContainer: { clear: vi.fn() },
			inPlanMode: overrides?.inPlanMode ?? false,
			exitPlanModeInternal: vi.fn(),
			runtimeHost: {
				switchSession,
			},
			renderCurrentSessionState: vi.fn(),
			showStatus: vi.fn(),
			promptForMissingSessionCwd: vi.fn().mockResolvedValue(undefined),
			ui: { requestRender: vi.fn() },
			handleFatalRuntimeError: vi.fn().mockResolvedValue(undefined),
		};
	}

	test("does NOT call exitPlanModeInternal in handleResumeSession (handled by rebind sync instead)", async () => {
		const fakeThis = createFakeThis({ inPlanMode: true });
		const handleResumeSession = Reflect.get(InteractiveMode.prototype, "handleResumeSession") as (
			this: typeof fakeThis,
			sessionPath: string,
		) => Promise<{ cancelled: boolean }>;

		const result = await handleResumeSession.call(fakeThis, "/tmp/some-session.jsonl");

		// Plan-mode exit is NOT done in handleResumeSession: the state file
		// on disk preserves the outgoing session's plan-mode, and the rebind
		// sync for the incoming session reads ITS state file to decide
		// whether to enter plan mode.
		expect(fakeThis.exitPlanModeInternal).not.toHaveBeenCalled();
		expect(fakeThis.runtimeHost.switchSession).toHaveBeenCalledTimes(1);
		expect(fakeThis.renderCurrentSessionState).toHaveBeenCalledTimes(1);
		expect(fakeThis.handleFatalRuntimeError).not.toHaveBeenCalled();
		expect(result.cancelled).toBe(false);
	});

	test("does not touch plan-mode when not active", async () => {
		const fakeThis = createFakeThis({ inPlanMode: false });
		const handleResumeSession = Reflect.get(InteractiveMode.prototype, "handleResumeSession") as (
			this: typeof fakeThis,
			sessionPath: string,
		) => Promise<{ cancelled: boolean }>;

		await handleResumeSession.call(fakeThis, "/tmp/some-session.jsonl");

		expect(fakeThis.exitPlanModeInternal).not.toHaveBeenCalled();
		expect(fakeThis.runtimeHost.switchSession).toHaveBeenCalledTimes(1);
		expect(fakeThis.renderCurrentSessionState).toHaveBeenCalledTimes(1);
		expect(fakeThis.handleFatalRuntimeError).not.toHaveBeenCalled();
	});
});
