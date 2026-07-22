import { describe, expect, it } from "vitest";
import { buildSubagentArgs, buildSubagentSessionName } from "../examples/extensions/subagent/index.ts";

describe("subagent session naming", () => {
	it("builds subagent:<agent> - <task>", () => {
		expect(buildSubagentSessionName("scout", "find auth code")).toBe("subagent:scout - find auth code");
	});

	it("normalizes whitespace in the task", () => {
		expect(buildSubagentSessionName("worker", "  fix\n\nthe   bug  ")).toBe("subagent:worker - fix the bug");
	});

	it("caps the task at 40 chars without an ellipsis", () => {
		const longTask = "a".repeat(60);
		const name = buildSubagentSessionName("scout", longTask);
		expect(name).toBe(`subagent:scout - ${"a".repeat(40)}`);
		expect(name).not.toContain("…");
		expect(name).not.toContain("...");
	});
});

describe("subagent child process args", () => {
	it("links to the parent session and names the child", () => {
		const args = buildSubagentArgs({
			agentName: "scout",
			task: "find auth code",
			resolvedModel: "anthropic/claude-haiku",
			tools: ["read", "grep"],
			parentSessionFile: "/tmp/parent.jsonl",
			noSkills: false,
			skills: undefined,
			systemPrompt: undefined,
			appendSystemPrompt: undefined,
		});

		expect(args).toContain("--parent-session");
		expect(args.slice(args.indexOf("--parent-session") + 1, args.indexOf("--parent-session") + 3)).toEqual([
			"/tmp/parent.jsonl",
			"--parent-relation",
		]);
		expect(args).toContain("subagent");
		expect(args[args.indexOf("--parent-relation") + 1]).toBe("subagent");
		expect(args).toContain("--name");
		expect(args[args.indexOf("--name") + 1]).toBe("subagent:scout - find auth code");
		expect(args).toContain("--model");
		expect(args).toContain("--tools");
		// The child persists its own session.
		expect(args).not.toContain("--no-session");
		expect(args).not.toContain("--no-skills");
	});

	it("passes --no-skills when requested", () => {
		const args = buildSubagentArgs({
			agentName: "scout",
			task: "say hi",
			resolvedModel: undefined,
			tools: undefined,
			parentSessionFile: "/tmp/parent.jsonl",
			noSkills: true,
			skills: undefined,
			systemPrompt: undefined,
			appendSystemPrompt: undefined,
		});
		expect(args).toContain("--no-skills");
	});

	it("passes parent-controlled skills and context", () => {
		const args = buildSubagentArgs({
			agentName: "subagent",
			task: "do the thing",
			resolvedModel: undefined,
			tools: undefined,
			parentSessionFile: "/tmp/parent.jsonl",
			noSkills: true,
			skills: ["/path/to/skill-a", "/path/to/skill-b"],
			systemPrompt: "You are a generic worker.",
			appendSystemPrompt: ["extra context", "/path/to/context.md"],
		});

		// Skills: --no-skills plus explicit --skill paths.
		expect(args).toContain("--no-skills");
		expect(args.filter((a) => a === "--skill")).toHaveLength(2);
		expect(args[args.indexOf("--skill") + 1]).toBe("/path/to/skill-a");
		// Context: system prompt override + appended context.
		expect(args[args.indexOf("--system-prompt") + 1]).toBe("You are a generic worker.");
		expect(args.filter((a) => a === "--append-system-prompt")).toHaveLength(2);
	});

	it("omits parent linkage when there is no parent session file", () => {
		const args = buildSubagentArgs({
			agentName: "worker",
			task: "do the thing",
			resolvedModel: undefined,
			tools: undefined,
			parentSessionFile: undefined,
			noSkills: false,
			skills: undefined,
			systemPrompt: undefined,
			appendSystemPrompt: undefined,
		});

		expect(args).not.toContain("--parent-session");
		expect(args).not.toContain("--parent-relation");
		expect(args).not.toContain("--model");
		expect(args).not.toContain("--tools");
		expect(args).not.toContain("--no-session");
		expect(args).toContain("--name");
	});
});
