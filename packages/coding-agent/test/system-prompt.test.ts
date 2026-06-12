import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { buildSystemPrompt, resolveModelAppendSystemPrompts, resolvePromptInput } from "../src/core/system-prompt.ts";

function makeModel(provider: string, id: string): Model<any> {
	return {
		id,
		name: id,
		provider,
		api: "openai-completions",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	};
}

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});

		test("instructs models to resolve pi docs and examples under absolute base paths", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				"- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
			);
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});
});

describe("resolvePromptInput", () => {
	test("returns the string verbatim when the value is not a file path", () => {
		expect(resolvePromptInput("just a fragment")).toBe("just a fragment");
	});

	test("reads file contents when the value points to an existing file", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-resolve-prompt-input-"));
		try {
			const file = join(dir, "fragment.md");
			writeFileSync(file, "file content", "utf-8");
			expect(resolvePromptInput(file)).toBe("file content");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("resolveModelAppendSystemPrompts", () => {
	test("returns [] when model is undefined", () => {
		expect(resolveModelAppendSystemPrompts(undefined, { "claude-*": "x" })).toEqual([]);
	});

	test("returns [] when map is undefined", () => {
		expect(resolveModelAppendSystemPrompts(makeModel("anthropic", "claude-sonnet-4-5"), undefined)).toEqual([]);
	});

	test("matches against provider/modelId", () => {
		const result = resolveModelAppendSystemPrompts(makeModel("anthropic", "claude-sonnet-4-5"), {
			"anthropic/*": "anthropic-wide",
		});
		expect(result).toEqual(["anthropic-wide"]);
	});

	test("matches against modelId", () => {
		const result = resolveModelAppendSystemPrompts(makeModel("anthropic", "claude-sonnet-4-5"), {
			"claude-sonnet-4-*": "sonnet-4-specific",
		});
		expect(result).toEqual(["sonnet-4-specific"]);
	});

	test("glob match is case-insensitive", () => {
		const result = resolveModelAppendSystemPrompts(makeModel("anthropic", "Claude-Opus-4-5"), {
			"claude-opus-*": "opus guidance",
		});
		expect(result).toEqual(["opus guidance"]);
	});

	test("returns [] when no pattern matches", () => {
		const result = resolveModelAppendSystemPrompts(makeModel("google", "gemini-1.5-pro"), {
			"claude-*": "x",
			"gpt-*": "y",
		});
		expect(result).toEqual([]);
	});

	test("preserves insertion order across multiple matches", () => {
		const result = resolveModelAppendSystemPrompts(makeModel("anthropic", "claude-sonnet-4-5"), {
			"claude-*": "a",
			"*-sonnet-*": "b",
			"anthropic/claude-sonnet-4-5": "c",
		});
		expect(result).toEqual(["a", "b", "c"]);
	});

	test("skips empty and non-string values", () => {
		const result = resolveModelAppendSystemPrompts(makeModel("anthropic", "claude-sonnet-4-5"), {
			"claude-*": "",
			"-sonnet-": "   ",
			"claude-sonnet-4-5": 42 as unknown as string,
			"*-4-5": "kept",
		});
		expect(result).toEqual(["kept"]);
	});

	test("reads file content for matching entries", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-model-append-"));
		try {
			const file = join(dir, "fragment.md");
			writeFileSync(file, "claude-specific guidance", "utf-8");
			const result = resolveModelAppendSystemPrompts(makeModel("anthropic", "claude-sonnet-4-5"), {
				"claude-*": file,
			});
			expect(result).toEqual(["claude-specific guidance"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
