/**
 * Plan tool.
 *
 * The model calls this tool to signal that its plan draft is ready
 * for the user to confirm. The tool pops a 3-option confirmation UI
 * (execute / refine / new session) and returns the choice to the
 * model as a descriptive text result.
 */

import { join } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { type Static, Type } from "typebox";
import { type PlanChoice, PlanConfirmPopup } from "../../modes/interactive/components/plan-confirm-popup.ts";
import {
	getDraftRoot,
	isInPlanMode,
	PlanToolRequiresPlanModeError,
	triggerPlanModeChoice,
} from "../../modes/interactive/plan-mode-state.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const planSchema = Type.Object({
	ready: Type.Optional(
		Type.Boolean({
			description: "Set to true when the plan draft is ready for the user to confirm",
		}),
	),
});

export type PlanToolInput = Static<typeof planSchema>;

function formatPlanCall(args: { ready?: boolean } | undefined): string {
	if (args?.ready === true) {
		return `${theme.fg("toolTitle", theme.bold("plan"))} ${chalk.green("ready")}`;
	}
	return theme.fg("toolTitle", theme.bold("plan"));
}

function formatPlanResult(content: Array<{ type: string; text?: string }> | undefined): string {
	const textBlock = content?.find((c) => c.type === "text") as { type: "text"; text: string } | undefined;
	return textBlock?.text ? chalk.white(textBlock.text) : theme.fg("muted", "(no result)");
}

const CHOICE_LABELS: Record<PlanChoice, string> = {
	1: "执行 (exit plan mode, write final plan, proceed)",
	2: "继续完善 (stay in plan mode, continue Q&A)",
	3: "新 session (fork to a new session, execute there)",
};

const CHOICE_INSTRUCTIONS: Record<PlanChoice, string> = {
	1:
		"User chose to execute. Plan mode is now OFF. The system has already written the final plan to " +
		"`<cwd>/.pi/<slug>.md` (slug derived from the plan title). Proceed to implement the plan.",
	2:
		"User wants to continue refining. Plan mode stays ON. Continue Q&A and update the draft at " +
		"`~/.pi/draft/<session-id>/current.md` until the plan is ready.",
	3:
		"User wants to start a new session. The new session was created; the old draft path was surfaced in the status bar. " +
		"Switch to it and read the draft to execute the plan.",
};

type PlanRenderState = Record<string, never>;

export function createPlanToolDefinition(): ToolDefinition<typeof planSchema, { choice: PlanChoice }, PlanRenderState> {
	return {
		name: "plan",
		label: "plan",
		renderShell: "self",
		description:
			"Plan-mode tool. Call with ready=true to signal that the plan draft at " +
			"~/.pi/draft/<session-id>/current.md is complete and request user confirmation. " +
			"This tool is only usable in plan mode.",
		promptSnippet: "Signal that the plan is ready for user confirmation",
		promptGuidelines: [
			"Call plan({ready: true}) only when the plan draft is fully written and you are at a decision point",
			"The user will be shown the plan and asked to choose: execute / refine / new session",
			"Do not call this tool outside plan mode",
		],
		parameters: planSchema,
		executionMode: "sequential",
		async execute(_toolCallId, { ready }, signal, _onUpdate, ctx) {
			if (!isInPlanMode()) {
				throw new PlanToolRequiresPlanModeError();
			}

			if (ready !== true) {
				throw new Error("plan tool currently only supports ready=true");
			}

			if (!ctx.hasUI) {
				throw new Error("plan tool requires an interactive UI (not available in this mode)");
			}

			// Yield so the tool call render can show before the popup replaces it.
			await new Promise((resolve) => setTimeout(resolve, 0));

			const draftRoot = getDraftRoot();
			if (!draftRoot) {
				throw new Error("plan tool: no draft root (plan mode state missing)");
			}
			const draftPath = join(draftRoot, "current.md");

			const choice = await ctx.ui.custom<PlanChoice>((tui, _theme, _kb, done) => {
				let resolved = false;
				const onAbort = () => {
					if (resolved) return;
					resolved = true;
					done(2); // Esc = refine
				};
				signal?.addEventListener("abort", onAbort, { once: true });

				const popup = new PlanConfirmPopup({ draftPath }, (value) => {
					if (resolved) return;
					resolved = true;
					signal?.removeEventListener("abort", onAbort);
					done(value);
				});
				// Load the draft outside the constructor so the popup renders
				// the layout immediately, then fills the body when the file
				// arrives. Errors surface as inline text in the popup.
				void popup.finishRender(tui);
				return popup;
			});

			if (signal?.aborted) {
				void triggerPlanModeChoice(2); // abort = refine (preserve draft)
				throw new Error("Operation aborted");
			}

			// Fire-and-forget: the interactive mode handles the per-choice
			// side effect (exit plan mode, fork to new session, ...).
			// The popup is already dismissed; the user sees the result
			// immediately while the model is told about the choice.
			void triggerPlanModeChoice(choice);

			return {
				content: [
					{
						type: "text",
						text:
							`User chose: ${CHOICE_LABELS[choice] ?? `option ${choice}`}\n\n` +
							(CHOICE_INSTRUCTIONS[choice] ?? `User chose option ${choice}.`),
					},
				],
				details: { choice },
			};
		},
		renderCall(args) {
			return new Text(formatPlanCall(args), 0, 0);
		},
		renderResult(result) {
			return new Text(formatPlanResult(result.content), 0, 0);
		},
	};
}

export function createPlanTool() {
	return wrapToolDefinition(createPlanToolDefinition());
}
