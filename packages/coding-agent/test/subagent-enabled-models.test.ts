import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readEnabledModelsFromSettings } from "../examples/extensions/subagent/index.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";

describe("subagent readEnabledModelsFromSettings", () => {
	const tmpDirs: string[] = [];
	const originalEnv = process.env[ENV_AGENT_DIR];

	const makeDir = () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-models-"));
		tmpDirs.push(dir);
		return dir;
	};

	afterEach(() => {
		for (const dir of tmpDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		if (originalEnv === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = originalEnv;
	});

	it("reads enabledModels from the global agent settings", () => {
		const agentDir = makeDir();
		process.env[ENV_AGENT_DIR] = agentDir;
		fs.writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify({ enabledModels: ["deepseek/deepseek-v4-flash", "ark/glm-5.2", "  ", 42] }),
		);
		expect(readEnabledModelsFromSettings(makeDir())).toEqual(["deepseek/deepseek-v4-flash", "ark/glm-5.2"]);
	});

	it("falls back to project settings when the global file has no enabledModels", () => {
		process.env[ENV_AGENT_DIR] = makeDir();
		const projectDir = makeDir();
		fs.mkdirSync(path.join(projectDir, ".pi"));
		fs.writeFileSync(
			path.join(projectDir, ".pi", "settings.json"),
			JSON.stringify({ enabledModels: ["kimi-coding/k3-256k"] }),
		);
		expect(readEnabledModelsFromSettings(projectDir)).toEqual(["kimi-coding/k3-256k"]);
	});

	it("returns [] when nothing is configured", () => {
		process.env[ENV_AGENT_DIR] = makeDir();
		expect(readEnabledModelsFromSettings(makeDir())).toEqual([]);
	});

	it("returns [] on malformed JSON", () => {
		const agentDir = makeDir();
		process.env[ENV_AGENT_DIR] = agentDir;
		fs.writeFileSync(path.join(agentDir, "settings.json"), "{ not json");
		expect(readEnabledModelsFromSettings(makeDir())).toEqual([]);
	});
});
