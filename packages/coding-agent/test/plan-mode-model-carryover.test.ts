import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

initTheme("dark", false);

const PLAN_MODEL = { provider: "faux", id: "plan-model" } as never;
const DEFAULT_MODEL = { provider: "faux", id: "default-model" } as never;

function callCarryOver(
	fakeThis: { session: { model: unknown; setModel: (m: unknown) => Promise<void> } },
	planModel: unknown,
): Promise<void> {
	const fn = Reflect.get(InteractiveMode.prototype, "carryOverPlanModel") as (
		this: { session: { model: unknown; setModel: (m: unknown) => Promise<void> } },
		planModel: unknown,
	) => Promise<void>;
	return fn.call(fakeThis, planModel);
}

describe("InteractiveMode.carryOverPlanModel", () => {
	test("re-applies the planning model when the new session's model differs", async () => {
		const setModel = vi.fn().mockResolvedValue(undefined);
		await callCarryOver({ session: { model: DEFAULT_MODEL, setModel } }, PLAN_MODEL);
		expect(setModel).toHaveBeenCalledTimes(1);
		expect(setModel).toHaveBeenCalledWith(PLAN_MODEL);
	});

	test("is a no-op when the new session already uses the planning model", async () => {
		const setModel = vi.fn().mockResolvedValue(undefined);
		await callCarryOver({ session: { model: PLAN_MODEL, setModel } }, PLAN_MODEL);
		expect(setModel).not.toHaveBeenCalled();
	});

	test("is a no-op when no planning model was captured", async () => {
		const setModel = vi.fn().mockResolvedValue(undefined);
		await callCarryOver({ session: { model: DEFAULT_MODEL, setModel } }, undefined);
		expect(setModel).not.toHaveBeenCalled();
	});

	test("swallows setModel failures so the new session keeps its fallback model", async () => {
		const setModel = vi.fn().mockRejectedValue(new Error("no api key"));
		await expect(callCarryOver({ session: { model: DEFAULT_MODEL, setModel } }, PLAN_MODEL)).resolves.toBeUndefined();
		expect(setModel).toHaveBeenCalledTimes(1);
	});
});
