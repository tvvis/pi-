import type {
	Api,
	Model,
	ModelThinkingLevel,
	SimpleStreamOptions,
	StreamOptions,
	ThinkingBudgets,
	ThinkingLevel,
} from "../types.ts";

export function buildBaseOptions(_model: Model<Api>, options?: SimpleStreamOptions, apiKey?: string): StreamOptions {
	return {
		temperature: options?.temperature,
		maxTokens: options?.maxTokens,
		signal: options?.signal,
		apiKey: apiKey || options?.apiKey,
		transport: options?.transport,
		cacheRetention: options?.cacheRetention,
		sessionId: options?.sessionId,
		headers: options?.headers,
		onPayload: options?.onPayload,
		onResponse: options?.onResponse,
		timeoutMs: options?.timeoutMs,
		websocketConnectTimeoutMs: options?.websocketConnectTimeoutMs,
		maxRetries: options?.maxRetries,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		metadata: options?.metadata,
	};
}

/**
 * Collapse "xhigh" to "high" for token-budget purposes; pass other standard
 * levels and `undefined` through unchanged. Custom labels are returned as-is;
 * the caller (`adjustMaxTokensForThinking`) skips them because they have no
 * defined budget.
 */
export function clampReasoning(effort: ModelThinkingLevel | undefined): Exclude<ThinkingLevel, "xhigh"> | undefined {
	return effort === "xhigh" ? "high" : (effort as Exclude<ThinkingLevel, "xhigh"> | undefined);
}

export function adjustMaxTokensForThinking(
	// Undefined means no explicit caller cap. Use the model cap and fit thinking inside it.
	baseMaxTokens: number | undefined,
	modelMaxTokens: number,
	reasoningLevel: ModelThinkingLevel,
	customBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
	const defaultBudgets: ThinkingBudgets = {
		minimal: 1024,
		low: 2048,
		medium: 8192,
		high: 16384,
	};
	const budgets = { ...defaultBudgets, ...customBudgets };

	const minOutputTokens = 1024;
	const level = clampReasoning(reasoningLevel);
	if (!level || !(level in budgets)) {
		// Custom or "off" levels have no token budget; pass the model cap through unchanged.
		return { maxTokens: modelMaxTokens, thinkingBudget: 0 };
	}
	const thinkingBudget: number = budgets[level] ?? 0;
	const maxTokens =
		baseMaxTokens === undefined ? modelMaxTokens : Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);

	if (maxTokens <= thinkingBudget) {
		return { maxTokens, thinkingBudget: Math.max(0, maxTokens - minOutputTokens) };
	}

	return { maxTokens, thinkingBudget };
}
