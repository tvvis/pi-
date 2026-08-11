import { describe, expect, it } from "vitest";
import {
	getModel,
	getSupportedThinkingLevels,
	withCustomThinkingLevelsOverrides,
	withThinkingLevelOverrides,
} from "../src/models.ts";

describe("withThinkingLevelOverrides", () => {
	it("changes the supported levels visible to the TUI cycle", () => {
		const model = getModel("openai", "gpt-5.5");
		expect(model).toBeDefined();

		// Built-in: gpt-5.5 exposes off/low/medium/high/xhigh (minimal is unsupported).
		expect(getSupportedThinkingLevels(model!)).toEqual(["off", "low", "medium", "high", "xhigh"]);

		// User hides high + xhigh and remaps low → "low-effort".
		const wrapped = withThinkingLevelOverrides(model!, { high: null, xhigh: null, low: "low-effort" });
		expect(getSupportedThinkingLevels(wrapped)).toEqual(["off", "low", "medium"]);
	});

	it("can re-enable a level the built-in map disables", () => {
		const model = getModel("openai", "gpt-5.5");
		expect(model).toBeDefined();

		const wrapped = withThinkingLevelOverrides(model!, { minimal: "minimal" });
		expect(wrapped.thinkingLevelMap?.minimal).toBe("minimal");
		expect(wrapped.thinkingLevelMap?.xhigh).toBe("xhigh");
	});

	it("returns the same content when no overrides are provided", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeDefined();

		const wrapped = withThinkingLevelOverrides(model!, {});
		expect(wrapped.thinkingLevelMap).toEqual(model!.thinkingLevelMap);
	});

	it("does not affect models that use customThinkingLevels (which bypass the map entirely)", () => {
		const model = getModel("deepseek", "deepseek-v4-flash");
		expect(model).toBeDefined();
		expect(model!.customThinkingLevels).toBeDefined();

		const wrapped = withThinkingLevelOverrides(model!, { high: null });
		// thinkingLevelMap still reflects the override (callers can still inspect it).
		expect(wrapped.thinkingLevelMap?.high).toBeNull();
		// But the TUI cycle is driven by customThinkingLevels, not thinkingLevelMap.
		expect(getSupportedThinkingLevels(wrapped)).toEqual(["high", "max"]);
	});
});

describe("withCustomThinkingLevelsOverrides", () => {
	it("fully replaces the model's customThinkingLevels without mutating the input", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeDefined();
		expect(model!.customThinkingLevels).toBeUndefined();

		const overrides = [
			{ label: "high", value: "high" },
			{ label: "max", value: "max" },
		];
		const wrapped = withCustomThinkingLevelsOverrides(model!, overrides);

		// Original is untouched.
		expect(model!.customThinkingLevels).toBeUndefined();
		// The wrapped model now exposes only the override entries.
		expect(wrapped.customThinkingLevels).toEqual(overrides);
		expect(getSupportedThinkingLevels(wrapped)).toEqual(["high", "max"]);
		expect(wrapped).not.toBe(model);
	});

	it("replaces an existing custom cycle", () => {
		const model = getModel("deepseek", "deepseek-v4-flash");
		expect(model).toBeDefined();
		expect(model!.customThinkingLevels).toEqual([
			{ label: "high", value: "high" },
			{ label: "max", value: "max" },
		]);

		const wrapped = withCustomThinkingLevelsOverrides(model!, [
			{ label: "low", value: "low" },
			{ label: "med", value: "medium" },
			{ label: "big", value: "xhigh" },
		]);
		expect(wrapped.customThinkingLevels).toEqual([
			{ label: "low", value: "low" },
			{ label: "med", value: "medium" },
			{ label: "big", value: "xhigh" },
		]);
		expect(getSupportedThinkingLevels(wrapped)).toEqual(["low", "med", "big"]);
	});

	it("returns the model unchanged when overrides are empty", () => {
		const model = getModel("deepseek", "deepseek-v4-flash");
		expect(model).toBeDefined();

		const wrapped = withCustomThinkingLevelsOverrides(model!, []);
		expect(wrapped).toBe(model);
	});
});
