import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const askSchema = Type.Object({
	question: Type.String({ description: "The question to present to the user" }),
	options: Type.Array(Type.String(), {
		description: "List of options for the user to choose from (2-5 items recommended)",
	}),
});

export type AskToolInput = Static<typeof askSchema>;

export function createAskToolDefinition(): ToolDefinition<typeof askSchema, undefined> {
	return {
		name: "ask",
		label: "ask",
		description:
			"Present a question to the user with a set of options. The user selects one option, and the result is the selected text. Use this when you need user input to proceed (e.g., choices about implementation, confirmation of ambiguous intent, or selecting from alternatives).",
		promptSnippet: "Present a question with options for the user to choose from",
		promptGuidelines: [
			"Use ask when you need the user to make a decision between multiple options before continuing",
			"Keep options concise (1-5 words each) and the question clear",
			"Do not use ask for simple yes/no questions - just ask in your response and let the user reply",
			"Only use ask when you are at a decision point and cannot proceed without user input",
		],
		parameters: askSchema,
		executionMode: "sequential",
		async execute(_toolCallId, { question, options }, signal, _onUpdate, ctx) {
			if (options.length === 0) {
				throw new Error("ask requires at least one option");
			}

			if (!ctx.hasUI) {
				throw new Error("ask tool requires an interactive UI (not available in this mode)");
			}

			// Yield to the event loop so the tool call render can show before the selector replaces the editor.
			await new Promise((resolve) => setTimeout(resolve, 0));

			const selection = await ctx.ui.select(question, options, { signal });

			if (signal?.aborted) {
				throw new Error("User cancelled the selection");
			}

			if (selection === undefined) {
				throw new Error("No option was selected");
			}

			return {
				content: [{ type: "text", text: selection }],
				details: undefined,
			};
		},
	};
}

export function createAskTool(): AgentTool<typeof askSchema> {
	return wrapToolDefinition(createAskToolDefinition());
}
