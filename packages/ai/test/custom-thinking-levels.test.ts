import { describe, expect, it } from "vitest";
import { clampThinkingLevel, getModel, getSupportedThinkingLevels, resolveThinkingLevelValue } from "../src/models.ts";

describe("customThinkingLevels", () => {
	describe("DeepSeek V4 (built-in custom levels)", () => {
		it("exposes only the native labels (no 'off', no pi-level indirection)", () => {
			const model = getModel("deepseek", "deepseek-v4-flash");
			expect(model).toBeDefined();
			expect(model!.customThinkingLevels).toEqual([
				{ label: "high", value: "high" },
				{ label: "max", value: "max" },
			]);
			expect(getSupportedThinkingLevels(model!)).toEqual(["high", "max"]);
		});

		it("resolves a selected label to the upstream value verbatim", () => {
			const model = getModel("deepseek", "deepseek-v4-pro");
			expect(model).toBeDefined();
			expect(resolveThinkingLevelValue(model!, "high")).toBe("high");
			expect(resolveThinkingLevelValue(model!, "max")).toBe("max");
			// A label not declared in customThinkingLevels is undefined (caller should omit reasoning).
			expect(resolveThinkingLevelValue(model!, "xhigh")).toBeUndefined();
		});

		it("clamps arbitrary requested levels to the first available entry", () => {
			const model = getModel("deepseek", "deepseek-v4-flash");
			expect(model).toBeDefined();
			// Custom-level models have no canonical ladder, so anything off-cycle snaps to the first entry.
			expect(clampThinkingLevel(model!, "off")).toBe("high");
			expect(clampThinkingLevel(model!, "minimal")).toBe("high");
			expect(clampThinkingLevel(model!, "max")).toBe("max");
		});
	});

	describe("fallback when no customThinkingLevels are set", () => {
		it("uses the standard thinkingLevelMap cycle", () => {
			const model = getModel("openai", "gpt-5.5");
			expect(model).toBeDefined();
			expect(model!.customThinkingLevels).toBeUndefined();
			expect(getSupportedThinkingLevels(model!)).toEqual(["off", "low", "medium", "high", "xhigh"]);
			expect(resolveThinkingLevelValue(model!, "high")).toBe("high");
			expect(resolveThinkingLevelValue(model!, "xhigh")).toBe("xhigh");
		});
	});
});
