/**
 * Per-Model Compaction Extension
 *
 * Configures per-model auto-compaction thresholds. When the configured ratio
 * is exceeded, prompts the user with three options: compress now, start a new
 * session, or continue without compressing.
 *
 * The threshold is a *ratio* of the active model's context window
 * (tokens / contextWindow, 0..1) rather than a fixed token count, so it
 * naturally adapts to models with different context windows.
 *
 * Configuration: add to `~/.pi/agent/settings.json` (or `<cwd>/.pi/settings.json`):
 *
 * ```json
 * {
 *   "perModelCompaction": {
 *     "defaultRatio": 0.85,
 *     "ratios": {
 *       "anthropic/claude-sonnet-4-5": 0.7,
 *       "anthropic/claude-opus-4-5": 0.6,
 *       "openai/gpt-5": 0.8
 *     },
 *     "repromptDelta": 0.1,
 *     "skipBuiltIn": true
 *   }
 * }
 * ```
 *
 * - `ratios`: Map of `"provider/model-id"` (or wildcard patterns with `*`
 *   on either side) to threshold ratio in [0, 1]. Matched in declaration
 *   order; first hit wins.
 * - `defaultRatio`: Fallback ratio when no entry matches. `0` (the default if
 *   the key is absent) disables the prompt and falls through to pi's built-in
 *   auto-compaction.
 * - `repromptDelta`: After the user picks "Continue", re-prompt only after
 *   usage grows by this much (default 0.1 = 10% of context window).
 * - `skipBuiltIn`: When `true` (default if any ratio is configured), the
 *   extension's `turn_end` check is the sole trigger. Set to `false` to let
 *   pi's built-in auto-compaction also run as a safety net.
 *
 * Place this file at `~/.pi/agent/extensions/per-model-compaction.ts` for
 * auto-load, or run with `pi -e ./examples/extensions/per-model-compaction.ts`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Types
// ============================================================================

export interface PerModelCompactionConfig {
	ratios: Record<string, number>;
	defaultRatio: number;
	repromptDelta: number;
	skipBuiltIn: boolean;
}

export const DEFAULT_CONFIG: PerModelCompactionConfig = {
	ratios: {},
	defaultRatio: 0,
	repromptDelta: 0.1,
	skipBuiltIn: true,
};

/** Resolved prompt state tracked between events to avoid re-prompt spam. */
export interface PromptState {
	usageTokensAtPrompt: number;
	ratio: number;
}

// ============================================================================
// Pure helpers (exported for testing)
// ============================================================================

/**
 * Match a `"provider/model-id"` key against a pattern. Patterns may use `*`
 * for either side: `"provider/star"` matches any model from a provider,
 * `"star/model-id"` matches the same model across providers.
 */
export function modelMatches(pattern: string, key: string): boolean {
	if (pattern === key) return true;
	const [patProvider, ...patRest] = pattern.split("/");
	const patModel = patRest.join("/");
	if (patProvider === undefined || patModel === undefined) return false;
	const [keyProvider, ...keyRest] = key.split("/");
	const keyModel = keyRest.join("/");
	if (patProvider === "*" && patModel === keyModel) return true;
	if (patModel === "*" && patProvider === keyProvider) return true;
	return false;
}

/** Resolve the threshold ratio for a model. First matching pattern wins. */
export function resolveRatio(model: Model<any>, cfg: PerModelCompactionConfig): number {
	const key = `${model.provider}/${model.id}`;
	for (const [pattern, ratio] of Object.entries(cfg.ratios)) {
		if (modelMatches(pattern, key)) return ratio;
	}
	return cfg.defaultRatio;
}

function isValidRatio(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Read the `perModelCompaction` block from settings.json. Project-local overrides global. */
export function loadConfig(cwd: string, paths?: string[]): PerModelCompactionConfig {
	const candidates = paths ?? [join(getAgentDir(), "settings.json"), join(cwd, ".pi", "settings.json")];

	for (const path of candidates) {
		if (!existsSync(path)) continue;
		try {
			const content = readFileSync(path, "utf-8");
			const parsed = JSON.parse(content) as { perModelCompaction?: unknown };
			if (parsed && typeof parsed === "object" && parsed.perModelCompaction) {
				return normalizeConfig(parsed.perModelCompaction);
			}
		} catch {
			// Try the next candidate
		}
	}

	return DEFAULT_CONFIG;
}

export function normalizeConfig(raw: unknown): PerModelCompactionConfig {
	if (!raw || typeof raw !== "object") return DEFAULT_CONFIG;
	const candidate = raw as Partial<PerModelCompactionConfig>;

	const ratios: Record<string, number> = {};
	if (candidate.ratios && typeof candidate.ratios === "object") {
		for (const [key, value] of Object.entries(candidate.ratios)) {
			if (isValidRatio(value)) ratios[key] = value;
		}
	}

	return {
		ratios,
		defaultRatio: isValidRatio(candidate.defaultRatio) ? candidate.defaultRatio : DEFAULT_CONFIG.defaultRatio,
		repromptDelta: isValidRatio(candidate.repromptDelta) ? candidate.repromptDelta : DEFAULT_CONFIG.repromptDelta,
		skipBuiltIn: typeof candidate.skipBuiltIn === "boolean" ? candidate.skipBuiltIn : DEFAULT_CONFIG.skipBuiltIn,
	};
}

/** Whether a prompt should fire given the current usage and prior prompt state. */
export function shouldPrompt(
	usageTokens: number,
	contextWindow: number,
	ratio: number,
	lastPrompt: PromptState | null,
	repromptDelta: number,
): boolean {
	if (usageTokens <= 0 || contextWindow <= 0) return false;
	if (ratio <= 0) return false;
	const usedRatio = usageTokens / contextWindow;
	if (usedRatio < ratio) return false;
	if (!lastPrompt) return true;
	if (lastPrompt.usageTokensAtPrompt >= usageTokens) return false;
	const lastUsageRatio = lastPrompt.usageTokensAtPrompt / contextWindow;
	return usedRatio - lastUsageRatio >= repromptDelta;
}

function formatPercent(value: number): string {
	return `${Math.round(value * 100)}%`;
}

// ============================================================================
// Extension entry point
// ============================================================================

export default function (pi: ExtensionAPI) {
	let config: PerModelCompactionConfig = DEFAULT_CONFIG;
	let activeModel: Model<any> | undefined;
	let lastPrompt: PromptState | null = null;
	let compacting = false;
	// Set on model_select, cleared on the next turn_start. While set,
	// turn_end skips the usage check. This gates compaction prompts to the
	// "first turn_end after a turn_start" so the new model gets to respond
	// at least once before we evaluate its context usage.
	let suppressUntilFirstTurn = false;

	pi.on("session_start", (_event, ctx) => {
		config = loadConfig(ctx.cwd);
		lastPrompt = null;
		compacting = false;
		suppressUntilFirstTurn = false;
	});

	pi.on("model_select", (event) => {
		activeModel = event.model;
		lastPrompt = null;
		suppressUntilFirstTurn = true;
	});

	pi.on("turn_start", () => {
		// A turn has begun on the active model; the gate is open.
		suppressUntilFirstTurn = false;
	});

	async function showPrompt(ctx: ExtensionContext, currentRatio: number, usedRatio: number): Promise<void> {
		if (!ctx.hasUI) {
			// No interactive UI: auto-compact to stay within budget. print/json
			// modes skip the dialog entirely.
			compacting = true;
			ctx.compact({
				onComplete: () => {
					compacting = false;
				},
				onError: (error) => {
					compacting = false;
					ctx.ui.notify(`Auto-compaction failed: ${error.message}`, "error");
				},
			});
			return;
		}

		const title = `Context at ${formatPercent(usedRatio)} of ${activeModel!.id} (threshold ${formatPercent(currentRatio)})`;
		const choice = await ctx.ui.select(title, [
			`Compress now (${formatPercent(usedRatio)} used)`,
			"Start new session",
			"Continue without compressing",
		]);

		const usage = ctx.getContextUsage();
		if (usage && usage.tokens !== null) {
			lastPrompt = { usageTokensAtPrompt: usage.tokens, ratio: currentRatio };
		}

		if (choice === undefined || choice === null) return;
		if (choice.startsWith("Compress now")) {
			compacting = true;
			ctx.compact({
				onComplete: () => {
					compacting = false;
					ctx.ui.notify("Compaction complete", "info");
				},
				onError: (error) => {
					compacting = false;
					ctx.ui.notify(`Compaction failed: ${error.message}`, "error");
				},
			});
		} else if (choice === "Start new session") {
			// newSession() is only safe in command context, so prefill the
			// editor with the built-in /new command and ask the user to
			// confirm with Enter. The interactive mode onSubmit handler
			// intercepts /new directly, so no extension command needs to be
			// registered (which would otherwise leak into the / autocomplete).
			ctx.ui.setEditorText("/new");
			ctx.ui.notify("Press Enter to start a new session, Esc to cancel", "info");
		}
		// "Continue" - lastPrompt is already set; next turn_end re-evaluates
		// against repromptDelta.
	}

	pi.on("turn_end", async (_event, ctx) => {
		if (compacting) return;
		if (!activeModel) return;

		// No turn_start has occurred since the last model_select (or the gate
		// is still up for some other reason). The new model hasn't had a
		// chance to respond yet; skip the check.
		if (suppressUntilFirstTurn) return;

		const ratio = resolveRatio(activeModel, config);
		if (ratio <= 0) return;

		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null) return;
		if (usage.contextWindow <= 0) return;

		if (!shouldPrompt(usage.tokens, usage.contextWindow, ratio, lastPrompt, config.repromptDelta)) {
			return;
		}

		const usedRatio = usage.tokens / usage.contextWindow;
		await showPrompt(ctx, ratio, usedRatio);
	});

	// Safety net: when skipBuiltIn is false, intercept pi's built-in
	// auto-compaction and show the same dialog. Lets users keep reserveTokens
	// as a hard backstop while still getting a friendly prompt first.
	pi.on("session_before_compact", async (_event, ctx) => {
		if (config.skipBuiltIn) return;
		if (compacting) return;
		if (!activeModel) return;
		if (!ctx.hasUI) return;

		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null) return;
		const ratio = resolveRatio(activeModel, config);
		if (ratio <= 0) return;
		const usedRatio = usage.tokens / usage.contextWindow;
		if (usedRatio < ratio) return;

		const choice = await ctx.ui.select(
			`Context at ${formatPercent(usedRatio)} of ${activeModel.id} (threshold ${formatPercent(ratio)}). Compress?`,
			[`Compress now (${formatPercent(usedRatio)} used)`, "Start new session", "Continue without compressing"],
		);
		if (choice === undefined || choice === null) return;
		if (choice.startsWith("Compress now")) {
			// Let the built-in continue. Mark compacting so turn_end doesn't
			// re-prompt while this is in flight.
			compacting = true;
		} else if (choice === "Start new session") {
			ctx.ui.setEditorText("/new");
			ctx.ui.notify("Press Enter to start a new session, Esc to cancel", "info");
			return { cancel: true };
		} else {
			// "Continue": cancel the built-in compaction. The user can run
			// /compact manually when they're ready.
			return { cancel: true };
		}
	});
}
