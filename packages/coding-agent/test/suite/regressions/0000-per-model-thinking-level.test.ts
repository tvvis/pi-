import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

describe("per-model thinking level overrides", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("falls back to defaultThinkingLevel when no per-model override is configured", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			settings: { defaultThinkingLevel: "low" },
		});
		harnesses.push(harness);

		await harness.session.setModel(harness.getModel("faux-2")!);
		expect(harness.session.thinkingLevel).toBe("low");
	});

	it("uses the per-model override when one is configured via settings manager", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			settings: { defaultThinkingLevel: "low" },
		});
		harnesses.push(harness);

		// Provider name comes from the faux registration; resolve it from an existing model.
		const provider = harness.getModel().provider;
		harness.settingsManager.setThinkingLevelForModel(provider, "faux-2", "high");

		await harness.session.setModel(harness.getModel("faux-2")!);
		expect(harness.session.thinkingLevel).toBe("high");
	});

	it("does not carry over the current thinking level when switching to an unconfigured model", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			settings: { defaultThinkingLevel: "medium" },
		});
		harnesses.push(harness);

		harness.session.setThinkingLevel("high");
		expect(harness.session.thinkingLevel).toBe("high");

		await harness.session.setModel(harness.getModel("faux-2")!);
		expect(harness.session.thinkingLevel).toBe("medium");
	});

	it("remembers a manually chosen level for the current model and restores it on return", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			settings: { defaultThinkingLevel: "medium" },
		});
		harnesses.push(harness);
		const modelOne = harness.getModel("faux-1")!;
		const modelTwo = harness.getModel("faux-2")!;

		harness.session.setThinkingLevel("high");
		expect(harness.settingsManager.getThinkingLevelForModel(modelOne.provider, modelOne.id)).toBe("high");

		await harness.session.setModel(modelTwo);
		expect(harness.session.thinkingLevel).toBe("medium");
		expect(harness.settingsManager.getThinkingLevelForModel(modelOne.provider, modelOne.id)).toBe("high");

		await harness.session.setModel(modelOne);
		expect(harness.session.thinkingLevel).toBe("high");
	});

	it("does not update the global defaultThinkingLevel when a model-level level changes", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			settings: { defaultThinkingLevel: "low" },
		});
		harnesses.push(harness);

		harness.session.setThinkingLevel("high");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("low");
		expect(harness.session.thinkingLevel).toBe("high");
	});

	it("clearThinkingLevelForModel restores fallback to the global default", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			settings: { defaultThinkingLevel: "low" },
		});
		harnesses.push(harness);
		const modelOne = harness.getModel("faux-1")!;

		harness.session.setThinkingLevel("high");
		expect(harness.session.thinkingLevel).toBe("high");

		harness.settingsManager.clearThinkingLevelForModel(modelOne.provider, modelOne.id);
		await harness.session.setModel(harness.getModel("faux-2")!);
		await harness.session.setModel(modelOne);
		expect(harness.session.thinkingLevel).toBe("low");
	});

	it("unconfigured models fall back to DEFAULT_THINKING_LEVEL when no global default is set", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
		});
		harnesses.push(harness);

		await harness.session.setModel(harness.getModel("faux-2")!);
		expect(harness.session.thinkingLevel).toBe("medium");
	});
});
