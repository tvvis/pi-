/**
 * Plan mode state.
 *
 * Tracks whether the agent is in plan mode and provides the helpers
 * (draft root, path guard) that the write/edit/bash tools consult at
 * execute time. The in-memory `currentState` is module-level and is
 * the live source of truth for the running process; the state file at
 * `~/.pi/draft/<sessionId>/.plan-mode-state.json` is the per-session
 * persisted record, written on enter and removed on exit. It is read
 * on session rebind so /resume of a previously-plan-mode session
 * restores plan mode.
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

export interface PlanModeState {
	active: true;
	sessionId: string;
	description?: string;
	/** Absolute path of the draft directory: ~/.pi/draft/<sessionId>/ */
	draftRoot: string;
	enteredAt: number;
}

const STATE_FILENAME = ".plan-mode-state.json";

interface PersistedPlanModeState {
	active: true;
	description?: string;
	enteredAt: number;
}

let currentState: PlanModeState | null = null;

export function getPlanModeState(): PlanModeState | null {
	return currentState;
}

/** Currently active plan-mode session id, or undefined. Useful for callers
 * that need to compare the current module-level state against a fresh
 * session id (e.g. session rebind sync). */
export function getPlanModeSessionId(): string | undefined {
	return currentState?.sessionId;
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
	const draftRoot = join(homedir(), ".pi", "draft", opts.sessionId);
	currentState = {
		active: true,
		sessionId: opts.sessionId,
		description: opts.description,
		draftRoot,
		enteredAt: Date.now(),
	};
	persistState(draftRoot, {
		active: true,
		description: opts.description,
		enteredAt: currentState.enteredAt,
	});
	return currentState;
}

export function exitPlanMode(opts: { keepStateFile?: boolean } = {}): void {
	const draftRoot = currentState?.draftRoot;
	currentState = null;
	if (!opts.keepStateFile && draftRoot) {
		removePersistedState(draftRoot);
	}
}

/**
 * Read the persisted plan mode state for a session. Returns the state
 * when the session was last in plan mode, or `null` if it never was
 * or the state file is missing/corrupt.
 */
export function readPlanModeState(sessionId: string): { active: true; description?: string; enteredAt: number } | null {
	if (!sessionId) return null;
	const filePath = join(homedir(), ".pi", "draft", sessionId, STATE_FILENAME);
	try {
		const content = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(content) as Partial<PersistedPlanModeState>;
		if (parsed && parsed.active === true && typeof parsed.enteredAt === "number") {
			return {
				active: true,
				description: typeof parsed.description === "string" ? parsed.description : undefined,
				enteredAt: parsed.enteredAt,
			};
		}
		return null;
	} catch {
		return null;
	}
}

function persistState(draftRoot: string, state: PersistedPlanModeState): void {
	try {
		mkdirSync(draftRoot, { recursive: true });
		writeFileSync(join(draftRoot, STATE_FILENAME), JSON.stringify(state));
	} catch {
		// Best-effort persistence. Plan mode works in-memory regardless.
	}
}

function removePersistedState(draftRoot: string): void {
	try {
		unlinkSync(join(draftRoot, STATE_FILENAME));
	} catch {
		// Best-effort: missing file or any other failure is non-fatal.
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
type PlanModeChoice = 1 | 2 | 3 | 4;
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
 * Derive the human-readable plan title from a draft.
 *
 * Strategy (in order):
 *   1. Look for the first H1 line: `# Plan: <Title>`. Return the title.
 *   2. Look for the first H1 line: `# <Title>`. Return the heading.
 *
 * Returns `undefined` when no H1 is found. The system prompt requires
 * `# Plan: <title>` so a fresh draft always produces a title; this function
 * is forgiving as a fallback for older or hand-edited drafts.
 */
export function derivePlanTitle(content: string): string | undefined {
	const lines = content.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("# ")) {
			const heading = trimmed.slice(2).trim();
			const match = heading.match(/^plan\s*[:\-—]\s*(.+)$/i);
			const title = match ? match[1]!.trim() : heading;
			return title.length > 0 ? title : undefined;
		}
	}
	return undefined;
}

/**
 * Derive a filesystem-safe slug for a finalized plan.
 *
 * Strategy (in order):
 *   1. Look for the first H1 line via {@link derivePlanTitle}.
 *   2. Fall back to `plan-<unix-millis>`.
 *
 * The slug is lowercased, non-alphanumerics collapsed to hyphens, leading
 * and trailing hyphens stripped, and capped at 80 chars to keep file
 * listings readable.
 */
export function derivePlanSlug(content: string): string {
	const title = derivePlanTitle(content);
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
