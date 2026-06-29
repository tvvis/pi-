import { MODELS } from "./models.generated.ts";
import type {
	Api,
	CustomThinkingLevel,
	KnownProvider,
	Model,
	ModelThinkingLevel,
	ThinkingLevelMap,
	Usage,
} from "./types.ts";

const modelRegistry: Map<string, Map<string, Model<Api>>> = new Map();

// Initialize registry from MODELS on module load
for (const [provider, models] of Object.entries(MODELS)) {
	const providerModels = new Map<string, Model<Api>>();
	for (const [id, model] of Object.entries(models)) {
		providerModels.set(id, model as Model<Api>);
	}
	modelRegistry.set(provider, providerModels);
}

type ModelApi<
	TProvider extends KnownProvider,
	TModelId extends keyof (typeof MODELS)[TProvider],
> = (typeof MODELS)[TProvider][TModelId] extends { api: infer TApi } ? (TApi extends Api ? TApi : never) : never;

export function getModel<TProvider extends KnownProvider, TModelId extends keyof (typeof MODELS)[TProvider]>(
	provider: TProvider,
	modelId: TModelId,
): Model<ModelApi<TProvider, TModelId>> {
	const providerModels = modelRegistry.get(provider);
	return providerModels?.get(modelId as string) as Model<ModelApi<TProvider, TModelId>>;
}

export function getProviders(): KnownProvider[] {
	return Array.from(modelRegistry.keys()) as KnownProvider[];
}

export function getModels<TProvider extends KnownProvider>(
	provider: TProvider,
): Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[] {
	const models = modelRegistry.get(provider);
	return models ? (Array.from(models.values()) as Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[]) : [];
}

export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	usage.cost.input = (model.cost.input / 1000000) * usage.input;
	usage.cost.output = (model.cost.output / 1000000) * usage.output;
	usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (model.cost.cacheWrite / 1000000) * usage.cacheWrite;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/**
 * Returns a copy of `model` with `overrides` shallow-merged into its
 * `thinkingLevelMap`. Lets `settings.json` further restrict or remap a model's
 * thinking levels at runtime without rebuilding `models.generated.ts`.
 * Returns `model` unchanged when `overrides` is empty. Does not mutate the input.
 */
export function withThinkingLevelOverrides<TApi extends Api>(
	model: Model<TApi>,
	overrides: ThinkingLevelMap,
): Model<TApi> {
	if (Object.keys(overrides).length === 0) return model;
	return {
		...model,
		thinkingLevelMap: { ...model.thinkingLevelMap, ...overrides },
	};
}

/**
 * Returns a copy of `model` with `overrides` fully replacing its
 * `customThinkingLevels` (TUI shows `label`, provider sends `value` verbatim).
 * Lets `settings.json` swap a model's per-model cycle for a custom one without
 * rebuilding `models.generated.ts`. Returns `model` unchanged when
 * `overrides` is empty. Does not mutate the input.
 */
export function withCustomThinkingLevelsOverrides<TApi extends Api>(
	model: Model<TApi>,
	overrides: readonly CustomThinkingLevel[],
): Model<TApi> {
	if (overrides.length === 0) return model;
	return {
		...model,
		customThinkingLevels: overrides,
	};
}

export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): string[] {
	// Custom levels fully replace the standard cycle (TUI shows labels verbatim,
	// provider sends values verbatim — no pi-level indirection).
	if (model.customThinkingLevels && model.customThinkingLevels.length > 0) {
		return model.customThinkingLevels.map((entry) => entry.label);
	}
	if (!model.reasoning) return ["off"];

	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh") return mapped !== undefined;
		return true;
	});
}

/**
 * Resolve a TUI-selected level label to the value that should be sent to the
 * upstream API. For custom levels this looks up the entry's `value`; for the
 * standard cycle this falls back to `model.thinkingLevelMap` and finally to
 * the label itself. Returns `undefined` when the level is disabled (`null` in
 * the map), so callers can omit the reasoning parameter entirely.
 */
export function resolveThinkingLevelValue<TApi extends Api>(model: Model<TApi>, label: string): string | undefined {
	if (model.customThinkingLevels) {
		const entry = model.customThinkingLevels.find((e) => e.label === label);
		return entry ? entry.value : undefined;
	}
	const mapped = model.thinkingLevelMap?.[label as ModelThinkingLevel];
	if (mapped === null) return undefined;
	if (mapped === undefined) return label;
	return mapped;
}

export function clampThinkingLevel<TApi extends Api>(model: Model<TApi>, level: string): string {
	const availableLevels = getSupportedThinkingLevels(model);
	if (availableLevels.includes(level)) return level;

	// Custom-level models don't expose a canonical ladder, so just snap to the
	// first available entry instead of trying to find a "closest" pi-level.
	if (model.customThinkingLevels) {
		return availableLevels[0] ?? level;
	}

	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level as ModelThinkingLevel);
	if (requestedIndex === -1) return availableLevels[0] ?? "off";

	for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	return availableLevels[0] ?? "off";
}

/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
