/**
 * Plan mode state.
 *
 * Tracks whether the agent is in plan mode and provides the helpers
 * (draft root, path guard) that the write/edit/bash tools consult at
 * execute time. State is intentionally module-level and session-scoped:
 * it is set when the user enters plan mode and cleared when they exit
 * or the session is unloaded. It is NOT persisted to the session file.
 */

import { homedir } from "node:os";
import { join, sep } from "node:path";

export interface PlanModeState {
	active: true;
	sessionId: string;
	description?: string;
	/** Absolute path of the draft directory: ~/.pi/draft/<sessionId>/ */
	draftRoot: string;
	enteredAt: number;
	/**
	 * True when plan mode was entered without a description. The system
	 * prompt section is injected on the next user message instead of
	 * immediately on entry.
	 */
	pendingPromptInjection: boolean;
}

let currentState: PlanModeState | null = null;

export function getPlanModeState(): PlanModeState | null {
	return currentState;
}

export function isInPlanMode(): boolean {
	return currentState?.active === true;
}

export function getDraftRoot(): string | null {
	return currentState?.draftRoot ?? null;
}

export interface EnterPlanModeOptions {
	sessionId: string;
	description?: string;
}

export function enterPlanMode(opts: EnterPlanModeOptions): PlanModeState {
	currentState = {
		active: true,
		sessionId: opts.sessionId,
		description: opts.description,
		draftRoot: join(homedir(), ".pi", "draft", opts.sessionId),
		enteredAt: Date.now(),
		pendingPromptInjection: opts.description === undefined,
	};
	return currentState;
}

export function exitPlanMode(): void {
	currentState = null;
}

export function clearPendingPromptInjection(): void {
	if (currentState) {
		currentState.pendingPromptInjection = false;
	}
}

/**
 * Thrown by the write/edit tools when the target path is outside the
 * plan-mode draft root. The message is surfaced to the model so it can
 * self-correct (rewrite to a draft path or call plan(ready=true) to
 * exit plan mode).
 */
export class PlanModeWriteError extends Error {
	constructor(attemptedPath: string, draftRoot: string) {
		super(
			`Plan mode: writes are restricted to ${draftRoot}/* (attempted: ${attemptedPath}). ` +
				`Move the file under the draft root, or call plan({ready: true}) to exit plan mode.`,
		);
		this.name = "PlanModeWriteError";
	}
}

/**
 * Thrown by the bash tool when called in plan mode. Bash is fully
 * disabled; the model must use read/grep/find/ls/ask instead.
 */
export class PlanModeBashDisabledError extends Error {
	constructor() {
		super(
			"Plan mode: bash is disabled. Use read/grep/find/ls/ask for exploration; " +
				"write drafts to ~/.pi/draft/<session-id>/ via the write tool.",
		);
		this.name = "PlanModeBashDisabledError";
	}
}

/**
 * Thrown by the plan tool when called outside plan mode.
 */
export class PlanToolRequiresPlanModeError extends Error {
	constructor() {
		super("plan tool can only be called while in plan mode");
		this.name = "PlanToolRequiresPlanModeError";
	}
}

/**
 * Check whether an absolute path is allowed by the plan-mode write
 * guard. Returns true if plan mode is off, or if the path lives
 * inside the draft root.
 */
export function isPathAllowedInPlanMode(absolutePath: string): boolean {
	if (!currentState) return true;
	const draftRoot = currentState.draftRoot;
	const resolved = absolutePath;
	if (resolved === draftRoot) return true;
	return resolved.startsWith(draftRoot + sep);
}

/**
 * Module-level switch consulted by the plan tool to know whether to
 * pop the confirmation UI. Set by the popup component when the user
 * dismisses it. Kept here so the plan tool stub in Phase 1 can grow
 * into the real interaction without moving code.
 */
let phase3HooksInstalled = false;
export function markPlanModePopupHooksInstalled(): void {
	phase3HooksInstalled = true;
}
export function arePlanModePopupHooksInstalled(): boolean {
	return phase3HooksInstalled;
}

/**
 * Handler invoked when the plan tool finishes the confirmation popup
 * and has a user choice. The interactive mode installs this on enter
 * and clears it on exit. Returning a Promise is fine; the plan tool
 * does not await it (fire-and-forget so the user sees the side
 * effect immediately after dismissing the popup).
 */
type PlanModeChoice = 1 | 2 | 3;
type PlanModeChoiceHandler = (choice: PlanModeChoice) => void | Promise<void>;
let planModeChoiceHandler: PlanModeChoiceHandler | null = null;

export function setPlanModeChoiceHandler(handler: PlanModeChoiceHandler | null): void {
	planModeChoiceHandler = handler;
}

export function triggerPlanModeChoice(choice: PlanModeChoice): void | Promise<void> {
	if (!planModeChoiceHandler) return;
	return planModeChoiceHandler(choice);
}

/**
 * Derive a filesystem-safe slug for a finalized plan.
 *
 * Strategy (in order):
 *   1. Look for the first H1 line: `# Plan: <Title>`. Use the title.
 *   2. Look for the first H1 line: `# <Title>`. Use the title.
 *   3. Fall back to `plan-<unix-millis>`.
 *
 * The slug is lowercased, non-alphanumerics collapsed to hyphens, leading
 * and trailing hyphens stripped, and capped at 80 chars to keep file
 * listings readable.
 */
export function derivePlanSlug(content: string): string {
	const lines = content.split("\n");
	let title: string | undefined;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("# ")) {
			const heading = trimmed.slice(2).trim();
			const match = heading.match(/^plan\s*[:\-—]\s*(.+)$/i);
			title = match ? match[1]!.trim() : heading;
			break;
		}
	}
	const base = title ? slugify(title) : "";
	return base || `plan-${Date.now()}`;
}

function slugify(input: string): string {
	return (
		input
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 80) || ""
	);
}
