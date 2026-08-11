/**
 * When the user cancels the ask dialog, the tool must not feed a "cancelled"
 * error back to the model. It resolves with an empty result and
 * `terminate: true` so the agent loop stops the turn and waits for the user's
 * next input instead of generating a response to the cancel.
 */

import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";
import { createAskToolDefinition } from "../../../src/core/tools/ask.ts";
import { wrapToolDefinition } from "../../../src/core/tools/tool-definition-wrapper.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

type AskSelection = { value: string; cancelled: boolean };

function makeCtx(selection: AskSelection): ExtensionContext {
	const ctx = {
		hasUI: true,
		ui: {
			// Simulate the interactive UI resolving with the given selection.
			custom: async () => selection,
		},
	} as unknown as ExtensionContext;
	return ctx;
}

function runAsk(selection: AskSelection) {
	const definition = createAskToolDefinition();
	return definition.execute(
		"call-1",
		{ question: "Pick one", options: ["a", "b"] },
		undefined,
		undefined,
		makeCtx(selection),
	);
}

describe("ask tool cancel", () => {
	it("resolves instead of throwing when the user cancels", async () => {
		await expect(runAsk({ value: "", cancelled: true })).resolves.toBeDefined();
	});

	it("terminates the turn on cancel and sends no cancel text to the model", async () => {
		const result = await runAsk({ value: "", cancelled: true });
		expect(result.terminate).toBe(true);
		const text = result.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("");
		expect(text).toBe("");
	});

	it("returns the selected value without terminating for a normal selection", async () => {
		const result = await runAsk({ value: "a", cancelled: false });
		expect(result.terminate).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "a" }]);
	});
});

describe("ask tool cancel through the agent loop", () => {
	it("stops the turn without another LLM call when the user cancels", async () => {
		const harness: Harness = await createHarness({
			tools: [wrapToolDefinition(createAskToolDefinition(), () => makeCtx({ value: "", cancelled: true }))],
			initialActiveToolNames: ["ask"],
		});
		try {
			// First response: the model asks via the ask tool. Second response would
			// be the model reacting to the tool result — it must never be consumed.
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("ask", { question: "Proceed?", options: ["yes", "no"] }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("should never be consumed"),
			]);

			await harness.session.prompt("start");

			expect(harness.session.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
			const toolResult = harness.session.messages[2] as ToolResultMessage;
			expect(toolResult.role).toBe("toolResult");
			expect(toolResult.isError).toBe(false);
			expect(getMessageText(toolResult)).toBe("");
			// The follow-up LLM response was never requested.
			expect(harness.getPendingResponseCount()).toBe(1);
		} finally {
			harness.cleanup();
		}
	});
});
