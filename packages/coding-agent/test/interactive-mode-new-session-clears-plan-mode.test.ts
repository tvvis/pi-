import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

initTheme("dark", false);

describe("InteractiveMode /new clears plan mode", () => {
	function createFakeThis(overrides?: { inPlanMode?: boolean }) {
		return {
			loadingAnimation: { stop: vi.fn() } as { stop: () => void } | undefined,
			statusContainer: { clear: vi.fn() },
			inPlanMode: overrides?.inPlanMode ?? false,
			exitPlanModeInternal: vi.fn(),
			runtimeHost: {
				newSession: vi.fn().mockResolvedValue({ cancelled: false }),
			},
			renderCurrentSessionState: vi.fn(),
			chatContainer: { addChild: vi.fn(), children: [] },
			ui: { requestRender: vi.fn() },
			handleFatalRuntimeError: vi.fn().mockResolvedValue(undefined),
		};
	}

	test("exits plan mode before creating a new session", async () => {
		const fakeThis = createFakeThis({ inPlanMode: true });
		const handleClearCommand = Reflect.get(InteractiveMode.prototype, "handleClearCommand") as (
			this: typeof fakeThis,
		) => Promise<void>;

		await handleClearCommand.call(fakeThis);

		expect(fakeThis.exitPlanModeInternal).toHaveBeenCalledTimes(1);
		expect(fakeThis.exitPlanModeInternal).toHaveBeenCalledWith("manual");
		expect(fakeThis.runtimeHost.newSession).toHaveBeenCalledTimes(1);
		expect(fakeThis.renderCurrentSessionState).toHaveBeenCalledTimes(1);
		expect(fakeThis.handleFatalRuntimeError).not.toHaveBeenCalled();
		expect(fakeThis.chatContainer.addChild).toHaveBeenCalled();
	});

	test("does not exit plan mode when not active", async () => {
		const fakeThis = createFakeThis({ inPlanMode: false });
		const handleClearCommand = Reflect.get(InteractiveMode.prototype, "handleClearCommand") as (
			this: typeof fakeThis,
		) => Promise<void>;

		await handleClearCommand.call(fakeThis);

		expect(fakeThis.exitPlanModeInternal).not.toHaveBeenCalled();
		expect(fakeThis.runtimeHost.newSession).toHaveBeenCalledTimes(1);
		expect(fakeThis.renderCurrentSessionState).toHaveBeenCalledTimes(1);
		expect(fakeThis.handleFatalRuntimeError).not.toHaveBeenCalled();
		expect(fakeThis.chatContainer.addChild).toHaveBeenCalled();
	});
});
