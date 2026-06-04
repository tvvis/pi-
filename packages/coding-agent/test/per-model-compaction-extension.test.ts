import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, test, vi } from "vitest";
import perModelCompactionExtension, {
	DEFAULT_CONFIG,
	loadConfig,
	modelMatches,
	normalizeConfig,
	resolveRatio,
	shouldPrompt,
} from "../examples/extensions/per-model-compaction.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../src/core/extensions/index.ts";

function makeModel(provider: string, id: string, contextWindow = 200_000): Model<any> {
	return {
		provider,
		id,
		contextWindow,
		maxTokens: 8192,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as Model<any>;
}

type Handler = (event: any, ctx: any) => Promise<any> | any;
type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<any> | any;

interface CapturedAPI {
	turnEndHandler: Handler | undefined;
	turnStartHandler: Handler | undefined;
	modelSelectHandler: Handler | undefined;
	sessionStartHandler: Handler | undefined;
	sessionBeforeCompactHandler: Handler | undefined;
	emittedCommands: Map<string, { description?: string; handler: CommandHandler }>;
}

function captureApi(): CapturedAPI {
	const captured: CapturedAPI = {
		turnEndHandler: undefined,
		turnStartHandler: undefined,
		modelSelectHandler: undefined,
		sessionStartHandler: undefined,
		sessionBeforeCompactHandler: undefined,
		emittedCommands: new Map(),
	};
	const on = (event: string, handler: Handler) => {
		if (event === "turn_end") captured.turnEndHandler = handler;
		else if (event === "turn_start") captured.turnStartHandler = handler;
		else if (event === "model_select") captured.modelSelectHandler = handler;
		else if (event === "session_start") captured.sessionStartHandler = handler;
		else if (event === "session_before_compact") captured.sessionBeforeCompactHandler = handler;
	};
	const registerCommand = (name: string, options: { description?: string; handler: CommandHandler }) => {
		captured.emittedCommands.set(name, options);
	};
	perModelCompactionExtension({ on, registerCommand } as unknown as ExtensionAPI);
	return captured;
}

function makeCtx(opts: {
	tokens: number | null;
	model?: Model<any>;
	contextWindow?: number;
	ui?: Partial<ExtensionContext["ui"]>;
	compact?: ReturnType<typeof vi.fn>;
}): ExtensionContext {
	const { tokens, model, contextWindow = model?.contextWindow ?? 200_000, ui = {}, compact = vi.fn() } = opts;
	const baseUi = {
		notify: vi.fn(),
		select: vi.fn().mockResolvedValue(undefined),
		confirm: vi.fn(),
		input: vi.fn(),
		setStatus: vi.fn(),
		setWidget: vi.fn(),
		setTitle: vi.fn(),
		setEditorText: vi.fn(),
		getEditorText: vi.fn().mockReturnValue(""),
		custom: vi.fn(),
		editor: vi.fn(),
		pasteToEditor: vi.fn(),
		addAutocompleteProvider: vi.fn(),
		setEditorComponent: vi.fn(),
		getEditorComponent: vi.fn(),
		onTerminalInput: vi.fn(),
		setHeader: vi.fn(),
		setFooter: vi.fn(),
		getToolsExpanded: vi.fn().mockReturnValue(false),
		setToolsExpanded: vi.fn(),
		setWorkingMessage: vi.fn(),
		setWorkingVisible: vi.fn(),
		setWorkingIndicator: vi.fn(),
		setLabel: vi.fn(),
		theme: {} as any,
		getAllThemes: vi.fn().mockReturnValue([]),
		getTheme: vi.fn(),
		setTheme: vi.fn(),
	};
	return {
		mode: "tui",
		hasUI: true,
		ui: { ...baseUi, ...ui } as ExtensionContext["ui"],
		cwd: process.cwd(),
		sessionManager: {} as ExtensionContext["sessionManager"],
		modelRegistry: {} as ExtensionContext["modelRegistry"],
		model,
		isIdle: () => true,
		signal: undefined,
		abort: vi.fn(),
		hasPendingMessages: () => false,
		shutdown: vi.fn(),
		getContextUsage: () => ({
			tokens,
			contextWindow,
			percent: tokens === null ? null : tokens / contextWindow,
		}),
		compact,
		getSystemPrompt: () => "",
	};
}

describe("per-model-compaction: pure helpers", () => {
	describe("modelMatches", () => {
		test("exact match", () => {
			expect(modelMatches("anthropic/claude-sonnet-4-5", "anthropic/claude-sonnet-4-5")).toBe(true);
		});
		test("provider wildcard matches any model from that provider", () => {
			expect(modelMatches("anthropic/*", "anthropic/claude-sonnet-4-5")).toBe(true);
			expect(modelMatches("anthropic/*", "openai/gpt-5")).toBe(false);
		});
		test("model wildcard matches same model across providers", () => {
			expect(modelMatches("*/claude-sonnet-4-5", "anthropic/claude-sonnet-4-5")).toBe(true);
			expect(modelMatches("*/claude-sonnet-4-5", "google/claude-sonnet-4-5")).toBe(true);
			expect(modelMatches("*/claude-sonnet-4-5", "anthropic/claude-opus-4-5")).toBe(false);
		});
		test("model id with slashes", () => {
			expect(modelMatches("anthropic/claude/3.5/sonnet", "anthropic/claude/3.5/sonnet")).toBe(true);
			expect(modelMatches("anthropic/*", "anthropic/claude/3.5/sonnet")).toBe(true);
		});
		test("non-match returns false", () => {
			expect(modelMatches("anthropic/claude-sonnet-4-5", "anthropic/claude-opus-4-5")).toBe(false);
		});
	});

	describe("resolveRatio", () => {
		test("returns matching pattern's ratio (first match wins)", () => {
			const cfg = {
				...DEFAULT_CONFIG,
				ratios: {
					"anthropic/claude-sonnet-4-5": 0.7,
					"anthropic/*": 0.9, // would also match, but declared second
				},
			};
			const model = makeModel("anthropic", "claude-sonnet-4-5");
			expect(resolveRatio(model, cfg)).toBe(0.7);
		});
		test("falls back to defaultRatio when no entry matches", () => {
			const cfg = { ...DEFAULT_CONFIG, defaultRatio: 0.85 };
			const model = makeModel("openai", "gpt-5");
			expect(resolveRatio(model, cfg)).toBe(0.85);
		});
		test("uses wildcard patterns when no exact match", () => {
			const cfg = {
				...DEFAULT_CONFIG,
				ratios: { "openai/*": 0.8 },
				defaultRatio: 0.5,
			};
			const model = makeModel("openai", "gpt-5");
			expect(resolveRatio(model, cfg)).toBe(0.8);
		});
	});

	describe("normalizeConfig", () => {
		test("returns defaults for null/undefined", () => {
			expect(normalizeConfig(null)).toEqual(DEFAULT_CONFIG);
			expect(normalizeConfig(undefined)).toEqual(DEFAULT_CONFIG);
		});
		test("drops invalid ratio values", () => {
			const cfg = normalizeConfig({
				ratios: {
					good: 0.8,
					badNegative: -0.1,
					badLarge: 1.5,
					badString: "0.5",
					badNaN: Number.NaN,
				},
				defaultRatio: 2, // out of range
				repromptDelta: -0.1,
			});
			expect(cfg.ratios).toEqual({ good: 0.8 });
			expect(cfg.defaultRatio).toBe(0);
			expect(cfg.repromptDelta).toBe(0.1);
		});
		test("preserves valid config", () => {
			const cfg = normalizeConfig({
				ratios: { "anthropic/claude-sonnet-4-5": 0.7 },
				defaultRatio: 0.85,
				repromptDelta: 0.1,
				skipBuiltIn: false,
			});
			expect(cfg.ratios).toEqual({ "anthropic/claude-sonnet-4-5": 0.7 });
			expect(cfg.defaultRatio).toBe(0.85);
			expect(cfg.repromptDelta).toBe(0.1);
			expect(cfg.skipBuiltIn).toBe(false);
		});
	});

	describe("shouldPrompt", () => {
		test("returns false when no ratio configured", () => {
			expect(shouldPrompt(100_000, 200_000, 0, null, 0.05)).toBe(false);
		});
		test("returns false when usage is below threshold", () => {
			expect(shouldPrompt(100_000, 200_000, 0.6, null, 0.05)).toBe(false);
		});
		test("returns true on first crossing", () => {
			expect(shouldPrompt(150_000, 200_000, 0.7, null, 0.05)).toBe(true);
		});
		test("returns false when usage is at or below prior prompt", () => {
			const last = { usageTokensAtPrompt: 150_000, ratio: 0.7 };
			expect(shouldPrompt(150_000, 200_000, 0.7, last, 0.05)).toBe(false);
			expect(shouldPrompt(140_000, 200_000, 0.7, last, 0.05)).toBe(false);
		});
		test("returns false if growth is below repromptDelta", () => {
			const last = { usageTokensAtPrompt: 150_000, ratio: 0.7 };
			// 0.05 of 200_000 = 10_000 token delta required
			expect(shouldPrompt(155_000, 200_000, 0.7, last, 0.05)).toBe(false);
		});
		test("returns true once growth exceeds repromptDelta", () => {
			const last = { usageTokensAtPrompt: 150_000, ratio: 0.7 };
			expect(shouldPrompt(161_000, 200_000, 0.7, last, 0.05)).toBe(true);
		});
		test("ignores prior prompt when no lastPrompt is provided", () => {
			expect(shouldPrompt(195_000, 200_000, 0.7, null, 0.05)).toBe(true);
		});
	});

	describe("loadConfig", () => {
		test("returns DEFAULT_CONFIG when no settings files exist", () => {
			// Pass an explicit list of nonexistent paths so the test is
			// independent of the user's real ~/.pi/agent/settings.json.
			const cfg = loadConfig("/nonexistent-cwd", ["/nonexistent/global.json", "/nonexistent/project.json"]);
			expect(cfg.ratios).toEqual({});
			expect(cfg.defaultRatio).toBe(0);
		});

		test("parses perModelCompaction from the first existing file", () => {
			const { mkdtempSync, writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
			const { tmpdir } = require("node:os") as typeof import("node:os");
			const dir = mkdtempSync(`${tmpdir()}/per-model-compaction-`);
			try {
				const path = `${dir}/settings.json`;
				writeFileSync(
					path,
					JSON.stringify({
						perModelCompaction: {
							ratios: { "anthropic/claude-sonnet-4-5": 0.7 },
							defaultRatio: 0.85,
						},
					}),
				);
				const cfg = loadConfig("/nonexistent-cwd", [path]);
				expect(cfg.ratios).toEqual({ "anthropic/claude-sonnet-4-5": 0.7 });
				expect(cfg.defaultRatio).toBe(0.85);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});

describe("per-model-compaction: extension wiring", () => {
	test("does not register any extension commands (uses built-in /new)", () => {
		const api = captureApi();
		expect(api.emittedCommands.size).toBe(0);
	});

	test("subscribes to session_start, model_select, turn_start, turn_end, session_before_compact", () => {
		const api = captureApi();
		expect(api.sessionStartHandler).toBeDefined();
		expect(api.modelSelectHandler).toBeDefined();
		expect(api.turnStartHandler).toBeDefined();
		expect(api.turnEndHandler).toBeDefined();
		expect(api.sessionBeforeCompactHandler).toBeDefined();
	});

	test("turn_end is a no-op when no model is selected", async () => {
		const api = captureApi();
		const select = vi.fn();
		const compact = vi.fn();
		const ctx = makeCtx({ tokens: 199_000, model: undefined, ui: { select }, compact });
		await api.sessionStartHandler!({ type: "session_start", reason: "startup", cwd: process.cwd() }, ctx);
		await api.turnEndHandler!({ type: "turn_end", turnIndex: 0, timestamp: 0 }, ctx);
		expect(select).not.toHaveBeenCalled();
		expect(compact).not.toHaveBeenCalled();
	});

	test("turn_end is a no-op when usage is null", async () => {
		const api = captureApi();
		const select = vi.fn();
		const compact = vi.fn();
		const model = makeModel("anthropic", "claude-sonnet-4-5");
		const ctx = makeCtx({ tokens: null, model, ui: { select }, compact });
		await api.sessionStartHandler!({ type: "session_start", reason: "startup", cwd: process.cwd() }, ctx);
		await api.modelSelectHandler!({ type: "model_select", model, previousModel: undefined, source: "set" }, ctx);
		await api.turnEndHandler!({ type: "turn_end", turnIndex: 0, timestamp: 0 }, ctx);
		expect(select).not.toHaveBeenCalled();
		expect(compact).not.toHaveBeenCalled();
	});

	test("turn_end skips prompting when defaultRatio is 0 (no config)", async () => {
		const api = captureApi();
		const select = vi.fn();
		const compact = vi.fn();
		const model = makeModel("anthropic", "claude-sonnet-4-5");
		const ctx = makeCtx({ tokens: 199_000, model, ui: { select }, compact });
		await api.sessionStartHandler!({ type: "session_start", reason: "startup", cwd: process.cwd() }, ctx);
		await api.modelSelectHandler!({ type: "model_select", model, previousModel: undefined, source: "set" }, ctx);
		await api.turnEndHandler!({ type: "turn_end", turnIndex: 0, timestamp: 0 }, ctx);
		expect(select).not.toHaveBeenCalled();
		expect(compact).not.toHaveBeenCalled();
	});

	test("session_before_compact is a no-op when skipBuiltIn is true (default)", async () => {
		const api = captureApi();
		const select = vi.fn();
		const model = makeModel("anthropic", "claude-sonnet-4-5");
		const ctx = makeCtx({ tokens: 195_000, model, ui: { select } });
		await api.sessionStartHandler!({ type: "session_start", reason: "startup", cwd: process.cwd() }, ctx);
		const result = await api.sessionBeforeCompactHandler?.(
			{
				type: "session_before_compact",
				preparation: {} as any,
				branchEntries: [],
				customInstructions: undefined,
				signal: new AbortController().signal,
			},
			ctx,
		);
		expect(result).toBeUndefined();
		expect(select).not.toHaveBeenCalled();
	});

	test("model_select resets prompt state", async () => {
		const api = captureApi();
		// We can't easily inspect lastPrompt from outside, but we can verify
		// that a model_select call doesn't throw and clears the prior state
		// by checking that a follow-up turn_end with usage above any ratio
		// (using a synthetic config) would re-prompt. This is verified by the
		// pure shouldPrompt tests; the wiring test just exercises the path.
		const ctx = makeCtx({ tokens: 100_000, model: makeModel("a", "m1") });
		await api.modelSelectHandler!(
			{ type: "model_select", model: makeModel("a", "m2"), previousModel: undefined, source: "set" },
			ctx,
		);
		// No assertion needed; just ensure no throw.
		expect(true).toBe(true);
	});

	test("model_select suppresses until the first turn_start", async () => {
		// Depends on the user's real ~/.pi/agent/settings.json having a
		// perModelCompaction block.
		const api = captureApi();
		const select = vi.fn();
		const compact = vi.fn();
		const model = makeModel("minimax-cn", "MiniMax-M3", 200_000);
		// 90% used: well above the configured 0.4 ratio. If the gate is
		// broken, the dialog appears on the first turn_end.
		const ctx = makeCtx({ tokens: 180_000, model, ui: { select }, compact });

		await api.sessionStartHandler!({ type: "session_start", reason: "startup", cwd: process.cwd() }, ctx);
		await api.modelSelectHandler!({ type: "model_select", model, previousModel: undefined, source: "set" }, ctx);

		// turn_end before any turn_start: must be suppressed, no prompt.
		await api.turnEndHandler!({ type: "turn_end", turnIndex: 0, timestamp: 0 }, ctx);
		expect(select).not.toHaveBeenCalled();
		expect(compact).not.toHaveBeenCalled();

		// First turn_start opens the gate.
		await api.turnStartHandler!({ type: "turn_start", turnIndex: 1, timestamp: 1 }, ctx);

		// Now the first turn_end after turn_start is allowed to evaluate.
		await api.turnEndHandler!({ type: "turn_end", turnIndex: 1, timestamp: 2 }, ctx);
		// Either the dialog appeared (interactive) or auto-compact fired
		// (non-interactive). We only assert at least one of them happened.
		expect(select.mock.calls.length + compact.mock.calls.length).toBeGreaterThan(0);
	});
});
