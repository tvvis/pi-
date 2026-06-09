import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { type Static, Type } from "typebox";
import { AskSelectorComponent } from "../../modes/interactive/components/ask-selector.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const askSchema = Type.Object({
	question: Type.String({ description: "The question to present to the user" }),
	options: Type.Array(Type.String(), {
		description: "List of options for the user to choose from (2-5 items recommended)",
	}),
});

export type AskToolInput = Static<typeof askSchema>;

const MAX_QUESTION_RENDER_WIDTH = 60;

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1)}…`;
}

function formatAskCall(args: { question?: string } | undefined): string {
	const question = args?.question;
	if (!question) {
		return theme.fg("toolTitle", theme.bold("ask"));
	}
	return `${theme.fg("toolTitle", theme.bold("ask"))} ${chalk.bold.cyan(truncate(question, MAX_QUESTION_RENDER_WIDTH))}`;
}

function formatAskResult(content: Array<{ type: string; text?: string }> | undefined): string {
	const textBlock = content?.find((c) => c.type === "text") as { type: "text"; text: string } | undefined;
	const text = textBlock?.text;
	if (!text) return theme.fg("muted", "(no answer)");
	return chalk.white(text);
}

type AskRenderState = Record<string, never>;

export function createAskToolDefinition(): ToolDefinition<typeof askSchema, undefined, AskRenderState> {
	return {
		name: "ask",
		label: "ask",
		renderShell: "self",
		description:
			"Present a question to the user with a set of options. The user either selects an option, types a custom answer, or cancels. Use this when you need user input to proceed (e.g., choices about implementation, confirmation of ambiguous intent, or selecting from alternatives).",
		promptSnippet: "Present a question with options for the user to choose from",
		promptGuidelines: [
			"Use ask when you need the user to make a decision between multiple options before continuing",
			"Keep options concise (1-5 words each) and the question clear",
			"The user can also type a custom answer; the ask tool always shows a text input alongside the options",
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

			// Yield so the tool call render can show before the UI replaces the editor.
			await new Promise((resolve) => setTimeout(resolve, 0));

			const selection = await ctx.ui.custom<{ value: string; cancelled: boolean }>((_tui, _theme, _kb, done) => {
				let resolved = false;
				const onAbort = () => {
					if (resolved) return;
					resolved = true;
					done({ value: "", cancelled: true });
				};
				signal?.addEventListener("abort", onAbort, { once: true });

				const component = new AskSelectorComponent(
					question,
					options,
					(value) => {
						if (resolved) return;
						resolved = true;
						signal?.removeEventListener("abort", onAbort);
						done({ value, cancelled: false });
					},
					() => {
						if (resolved) return;
						resolved = true;
						signal?.removeEventListener("abort", onAbort);
						done({ value: "", cancelled: true });
					},
				);
				return component;
			});

			if (signal?.aborted || selection.cancelled) {
				throw new Error("User cancelled the selection");
			}

			return {
				content: [{ type: "text", text: selection.value }],
				details: undefined,
			};
		},
		renderCall(args) {
			return new Text(formatAskCall(args), 0, 0);
		},
		renderResult(result) {
			return new Text(formatAskResult(result.content), 0, 0);
		},
	};
}

export function createAskTool(): AgentTool<typeof askSchema> {
	return wrapToolDefinition(createAskToolDefinition());
}
