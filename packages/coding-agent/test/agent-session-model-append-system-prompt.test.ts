import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("AgentSession model-conditional system prompt appends", () => {
	let tempDir: string;
	let agentDir: string;
	let fragmentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(
			join(tmpdir(), `pi-model-append-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`),
		);
		agentDir = join(tempDir, "agent");
		fragmentDir = join(tempDir, "fragments");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(fragmentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function makeSession(model: Model<any>, authProviders: string[] = []) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		for (const provider of authProviders) {
			authStorage.setRuntimeApiKey(provider, "test-key");
		}
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model,
			settingsManager,
			sessionManager,
			resourceLoader,
			authStorage,
		});
		return { session, settingsManager };
	}

	it("appends a model-conditional fragment when the model matches the pattern", async () => {
		const claudeFragment = join(fragmentDir, "claude.md");
		writeFileSync(claudeFragment, "CLAUDE-SPECIFIC-GUIDANCE", "utf-8");

		const settingsManager = SettingsManager.create(tempDir, agentDir);
		settingsManager.setModelAppendSystemPrompts({
			"claude-*": claudeFragment,
			"gpt-*": "GPT-SPECIFIC-GUIDANCE",
		});

		const { session } = await makeSession(getModel("anthropic", "claude-sonnet-4-5")!);
		expect(session.systemPrompt).toContain("CLAUDE-SPECIFIC-GUIDANCE");
		expect(session.systemPrompt).not.toContain("GPT-SPECIFIC-GUIDANCE");

		session.dispose();
	});

	it("does not append a fragment when the model does not match any pattern", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		settingsManager.setModelAppendSystemPrompts({
			"claude-*": "CLAUDE-SPECIFIC-GUIDANCE",
		});

		const { session } = await makeSession(getModel("openai", "gpt-4o")!);
		expect(session.systemPrompt).not.toContain("CLAUDE-SPECIFIC-GUIDANCE");
		session.dispose();
	});

	it("rebuilds the system prompt when the model is changed", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		settingsManager.setModelAppendSystemPrompts({
			"claude-*": "CLAUDE-SPECIFIC-GUIDANCE",
			"gpt-*": "GPT-SPECIFIC-GUIDANCE",
		});

		const { session } = await makeSession(getModel("anthropic", "claude-sonnet-4-5")!, ["anthropic", "openai"]);
		expect(session.systemPrompt).toContain("CLAUDE-SPECIFIC-GUIDANCE");
		expect(session.systemPrompt).not.toContain("GPT-SPECIFIC-GUIDANCE");

		await session.setModel(getModel("openai", "gpt-4o")!);
		expect(session.systemPrompt).toContain("GPT-SPECIFIC-GUIDANCE");
		expect(session.systemPrompt).not.toContain("CLAUDE-SPECIFIC-GUIDANCE");

		session.dispose();
	});

	it("layers model appends after the regular APPEND_SYSTEM.md content", async () => {
		const appendFile = join(agentDir, "APPEND_SYSTEM.md");
		writeFileSync(appendFile, "GLOBAL-APPEND", "utf-8");

		const settingsManager = SettingsManager.create(tempDir, agentDir);
		settingsManager.setModelAppendSystemPrompts({
			"claude-*": "CLAUDE-SPECIFIC-GUIDANCE",
		});

		const { session } = await makeSession(getModel("anthropic", "claude-sonnet-4-5")!);
		const prompt = session.systemPrompt;
		const globalIdx = prompt.indexOf("GLOBAL-APPEND");
		const modelIdx = prompt.indexOf("CLAUDE-SPECIFIC-GUIDANCE");
		expect(globalIdx).toBeGreaterThanOrEqual(0);
		expect(modelIdx).toBeGreaterThan(globalIdx);

		session.dispose();
	});
});
