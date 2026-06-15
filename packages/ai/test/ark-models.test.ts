import { afterEach, describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import { getModel } from "../src/models.ts";

const originalArkApiKey = process.env.ARK_API_KEY;

afterEach(() => {
	if (originalArkApiKey === undefined) {
		delete process.env.ARK_API_KEY;
	} else {
		process.env.ARK_API_KEY = originalArkApiKey;
	}
});

describe("Ark models", () => {
	it("registers the hardcoded glm-5.1 model via OpenAI-compatible Chat Completions API", () => {
		const model = getModel("ark", "glm-5.1");

		expect(model).toBeDefined();
		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("ark");
		expect(model.baseUrl).toBe("https://ark.cn-beijing.volces.com/api/coding/v3");
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text"]);
		expect(model.contextWindow).toBe(200000);
		expect(model.maxTokens).toBe(131072);
		expect(model.cost).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});
		expect(model.compat).toEqual({
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
		});
	});

	it("resolves ARK_API_KEY from the environment", () => {
		process.env.ARK_API_KEY = "test-ark-key";

		expect(findEnvKeys("ark")).toEqual(["ARK_API_KEY"]);
		expect(getEnvApiKey("ark")).toBe("test-ark-key");
	});
});
