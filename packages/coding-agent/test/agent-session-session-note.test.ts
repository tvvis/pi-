import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

const NOTE_MARKER = "PLAN-DRAFT-NOTE-MARKER";

describe("AgentSession.setSessionNote", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-session-note-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			initialState: { model, systemPrompt: "Test", tools: [] },
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
	});

	afterEach(() => {
		session.dispose();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("appends the note to the system prompt", () => {
		expect(session.systemPrompt).not.toContain(NOTE_MARKER);

		session.setSessionNote(`Read the plan draft at ~/.pi/draft/abc/draft.md. ${NOTE_MARKER}`);

		expect(session.systemPrompt).toContain(NOTE_MARKER);
	});

	it("removes the note when set to undefined", () => {
		session.setSessionNote(NOTE_MARKER);
		expect(session.systemPrompt).toContain(NOTE_MARKER);

		session.setSessionNote(undefined);

		expect(session.systemPrompt).not.toContain(NOTE_MARKER);
	});
});
