/**
 * System prompt construction and project context loading
 */

import { existsSync, readFileSync } from "node:fs";
import type { Model } from "@earendil-works/pi-ai";
import { minimatch } from "minimatch";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import type { PromptSlotMap } from "./prompt-slots.ts";
import { substitutePromptVars } from "./prompt-slots.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/**
	 * Ask mode context. When true, the system prompt is replaced with a Q&A
	 * assistant identity and no file/bash/edit/write tools are advertised.
	 */
	askMode?: boolean;
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
	/**
	 * Plan mode context. When present, the system prompt is augmented
	 * with a "Plan Mode" section that lays out the restrictions and
	 * workflow. The model uses this to know it cannot modify project
	 * files and must call `plan({ready: true})` to request confirmation.
	 */
	planMode?: {
		draftRoot: string;
		description?: string;
	};
	/**
	 * Execute-plan context. When present (and `planMode` is absent),
	 * the system prompt is augmented with an "Executing Plan" section
	 * that points the model at the approved plan path. The user's
	 * slot body (see {@link customPrompts}) layers execution behavior
	 * guidance on top of the structural skeleton.
	 */
	executePlan?: {
		/** Absolute path of the finalized plan file. */
		planPath: string;
		/** Optional one-line plan title for prompt-level summary. */
		title?: string;
	};
	/**
	 * User-authored prompt bodies keyed by slot id (see `PROMPT_SLOTS`).
	 * Values come from the prompts file; missing keys → no contribution
	 * for that slot. Bodies are inserted under the matching `## `
	 * heading and may contain `${name}` placeholders which the
	 * builder resolves against per-slot variable maps.
	 */
	customPrompts?: PromptSlotMap;
}

/** Base identity for ask mode (Q&A assistant, no project mutation). */
export const ASK_MODE_SYSTEM_PROMPT =
	"You are a helpful Q&A assistant. Answer the user's questions clearly and concisely using your existing knowledge and reasoning.";

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
		planMode,
		executePlan,
		customPrompts,
		askMode,
	} = options;
	const resolvedCwd = cwd;
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const date = `${year}-${month}-${day}`;
	const workingContext = `\nCurrent date: ${date}\nCurrent working directory: ${promptCwd}`;

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n<project_context>\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
			}
			prompt += "</project_context>\n";
		}

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		// Add date and working directory last
		prompt += workingContext;

		return prompt;
	}

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	// File exploration guidelines
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	let prompt: string;

	if (askMode) {
		// Always include these
		addGuideline("Be concise in your responses");
		addGuideline("Answer based on your existing knowledge");
		addGuideline("Do not guess; say so if you do not know");

		const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

		prompt = `${ASK_MODE_SYSTEM_PROMPT}

Available tools:
${toolsList}

Guidelines:
${guidelines}`;
	} else {
		// Get absolute paths to documentation and examples
		const readmePath = getReadmePath();
		const docsPath = getDocsPath();
		const examplesPath = getExamplesPath();

		// Always include these
		addGuideline("Be concise in your responses");
		addGuideline("Show file paths clearly when working with files");

		const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

		prompt = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.${workingContext}

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;
	}

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n<project_context>\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
		}
		prompt += "</project_context>\n";
	}

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	// Date and working directory: the default prompt places them right after the
	// identity line so the model sees its working context up front. Custom and
	// ask-mode prompts keep them at the end.
	if (askMode) {
		prompt += workingContext;
	}

	if (planMode && !askMode) {
		prompt += `\n\n## Plan Mode\n\nYou are in plan mode. You must NOT modify any project files.\n\n`;
		prompt += `Available tools:\n`;
		prompt += `- read, grep, find, ls: read project files\n`;
		prompt += `- ask: ask the user structured questions to resolve ambiguity and confirm decisions\n`;
		prompt += `- write, edit: ONLY to \`${planMode.draftRoot}/*\` (other paths throw PlanModeWriteError)\n`;
		prompt += `- bash: disabled\n`;
		prompt += `- plan: call with \`ready=true\` to request user confirmation\n\n`;
		prompt += `Workflow:\n`;
		prompt += `1. Investigate: read the relevant code/config/docs to understand the current state before proposing anything. Do not plan from assumptions.\n`;
		prompt += `2. Clarify: surface the key open questions and decision points (scope, approach, breaking changes, edge cases, trade-offs, defaults) and confirm the important ones with the user before finalizing the plan. Use \`ask\` for discrete choices, or ask in your response and wait for the user's reply for open-ended clarification. Do not silently fill gaps with assumptions - a plan built on unconfirmed guesses is not ready.\n`;
		prompt += `3. Draft: write the plan to \`${planMode.draftRoot}/draft.md\` using \`write\` or \`edit\`. Start the draft with a single \`# Plan: <title>\` heading on the first line (required - the title is used to auto-name child sessions in \`/resume\` so plan/derive relationships stay traceable).\n`;
		prompt += `4. Confirm: call \`plan({ready: true})\` only once the key questions are resolved AND the draft is complete, then wait for the user to choose: execute / refine / new session. Calling ready prematurely - with unresolved assumptions or before confirming the important decisions - just bounces the plan back for refinement. When in doubt, ask one more round instead of calling ready.\n`;
		if (planMode.description) {
			prompt += `\nThe user is planning: ${planMode.description}\n`;
		}
		const planModeSlot = customPrompts?.planMode;
		if (planModeSlot && planModeSlot.trim().length > 0) {
			prompt += `\n${planModeSlot.trim()}\n`;
		}
	}

	if (executePlan && !askMode) {
		prompt += `\n\n## Executing Plan\n\n`;
		prompt += `An approved plan is at \`${executePlan.planPath}\`. `;
		if (executePlan.title) {
			prompt += `Title: **${executePlan.title}**. `;
		}
		prompt += `Read it before acting - the plan is the source of truth.\n`;
		const executePlanSlot = customPrompts?.executePlan;
		if (executePlanSlot && executePlanSlot.trim().length > 0) {
			const vars: Record<string, string | undefined> = {
				planPath: executePlan.planPath,
				planTitle: executePlan.title,
			};
			prompt += `\n${substitutePromptVars(executePlanSlot.trim(), vars)}\n`;
		}
	}

	return prompt;
}

/**
 * Resolve a user-provided prompt fragment: if `value` points to an existing
 * file, read its contents; otherwise return the string verbatim. Matches the
 * convention used by `--append-system-prompt` and `APPEND_SYSTEM.md`.
 */
export function resolvePromptInput(value: string): string {
	if (existsSync(value)) {
		try {
			return readFileSync(value, "utf-8");
		} catch {
			return value;
		}
	}
	return value;
}

/**
 * Resolve model-conditional system prompt appends against the given model.
 *
 * Each entry in `map` is a pattern (minimatch glob, case-insensitive) mapping
 * to a prompt fragment. Patterns are matched against `provider/modelId` and
 * `modelId`. Values follow the `resolvePromptInput` convention (file path is
 * read, otherwise the string is used verbatim).
 *
 * Returns the resolved fragments in insertion order. Patterns that do not
 * match the model, or whose value is empty/non-string, are skipped.
 */
export function resolveModelAppendSystemPrompts(
	model: Model<any> | undefined,
	map: Record<string, string> | undefined,
): string[] {
	if (!model || !map) {
		return [];
	}
	const fullId = `${model.provider}/${model.id}`;
	const fragments: string[] = [];
	for (const [pattern, value] of Object.entries(map)) {
		if (typeof value !== "string" || value.length === 0) {
			continue;
		}
		if (!minimatch(fullId, pattern, { nocase: true }) && !minimatch(model.id, pattern, { nocase: true })) {
			continue;
		}
		fragments.push(resolvePromptInput(value));
	}
	return fragments;
}
