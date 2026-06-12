/**
 * API key resolution for tests.
 * Supports both direct env vars and credentials from ~/.pi/agent/auth.json.
 *
 * @deprecated OAuth support has been removed. This helper only resolves
 *             credentials stored in auth.json (API key entries).
 *             Use process.env directly for tests.
 */
export async function resolveApiKey(provider: string): Promise<string | undefined> {
	// Check env vars first
	const envKey = getApiKeyEnvVar(provider);
	if (envKey && process.env[envKey]) {
		return process.env[envKey];
	}

	// Check auth.json for stored API keys
	try {
		const { homedir } = await import("os");
		const { join } = await import("path");
		const { existsSync, readFileSync } = await import("fs");
		const authPath = join(homedir(), ".pi", "agent", "auth.json");
		if (existsSync(authPath)) {
			const auth = JSON.parse(readFileSync(authPath, "utf-8"));
			const entry = auth[provider];
			if (entry?.type === "api_key" && entry.key) {
				return entry.key;
			}
		}
	} catch {
		// Ignore
	}

	return undefined;
}

function getApiKeyEnvVar(provider: string): string | undefined {
	const map: Record<string, string> = {
		anthropic: "ANTHROPIC_API_KEY",
		openai: "OPENAI_API_KEY",
		"azure-openai-responses": "AZURE_OPENAI_API_KEY",
		deepseek: "DEEPSEEK_API_KEY",
		groq: "GROQ_API_KEY",
		cerebras: "CEREBRAS_API_KEY",
		xai: "XAI_API_KEY",
		minimax: "MINIMAX_API_KEY",
		moonshotai: "MOONSHOT_API_KEY",
		huggingface: "HF_TOKEN",
		fireworks: "FIREWORKS_API_KEY",
		together: "TOGETHER_API_KEY",
		opencode: "OPENCODE_API_KEY",
		"github-copilot": "COPILOT_GITHUB_TOKEN",
		"openai-codex": "OPENAI_CODEX_API_KEY",
	};
	return map[provider];
}
