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

describe("buildSystemPrompt plan mode", () => {
	test("does not include the Plan Mode section by default", () => {
		const prompt = buildSystemPrompt({
			selectedTools: [],
			contextFiles: [],
			skills: [],
			cwd: process.cwd(),
		});
		expect(prompt).not.toContain("## Plan Mode");
	});

	test("includes the Plan Mode section when planMode is set", () => {
		const prompt = buildSystemPrompt({
			selectedTools: [],
			contextFiles: [],
			skills: [],
			cwd: process.cwd(),
			planMode: { draftRoot: "/home/user/.pi/draft/abc123" },
		});
		expect(prompt).toContain("## Plan Mode");
		expect(prompt).toContain("/home/user/.pi/draft/abc123/*");
		expect(prompt).toContain("PlanModeWriteError");
		expect(prompt).toContain("plan({ready: true})");
		// Plan drafts must start with `# Plan: <title>` so child sessions can be auto-named.
		expect(prompt).toContain("# Plan: <title>");
	});

	test("includes the description when provided", () => {
		const prompt = buildSystemPrompt({
			selectedTools: [],
			contextFiles: [],
			skills: [],
			cwd: process.cwd(),
			planMode: { draftRoot: "/tmp/draft", description: "add rate limiting" },
		});
		expect(prompt).toContain("The user is planning: add rate limiting");
	});

	test("omits the description line when not provided", () => {
		const prompt = buildSystemPrompt({
			selectedTools: [],
			contextFiles: [],
			skills: [],
			cwd: process.cwd(),
			planMode: { draftRoot: "/tmp/draft" },
		});
		expect(prompt).not.toContain("The user is planning:");
	});

	test("emits no user body when customPrompts.planMode is absent", () => {
		const prompt = buildSystemPrompt({
			selectedTools: [],
			contextFiles: [],
			skills: [],
			cwd: process.cwd(),
			planMode: { draftRoot: "/tmp/draft" },
		});
		// Skeleton wording remains, but no slot body slipped in.
		expect(prompt).toContain("## Plan Mode");
		expect(prompt).not.toContain("Ask one question at a time");
	});

	test("inserts the planMode slot body when provided", () => {
		const prompt = buildSystemPrompt({
			selectedTools: [],
			contextFiles: [],
			skills: [],
			cwd: process.cwd(),
			planMode: { draftRoot: "/tmp/draft" },
			customPrompts: {
				planMode: "Ask one question at a time, in order: goal → scope → acceptance.",
				executePlan: undefined,
			},
		});
		expect(prompt).toContain("## Plan Mode");
		expect(prompt).toContain("Ask one question at a time");
		// Skeleton still present (slot doesn't replace it).
		expect(prompt).toContain("`plan({ready: true})`");
	});

	test("ignores empty/whitespace-only slot bodies", () => {
		const prompt = buildSystemPrompt({
			selectedTools: [],
			contextFiles: [],
			skills: [],
			cwd: process.cwd(),
			planMode: { draftRoot: "/tmp/draft" },
			customPrompts: { planMode: "   \n\n  ", executePlan: undefined },
		});
		expect(prompt).toContain("## Plan Mode");
		expect(prompt).not.toContain("Ask one question at a time");
	});
});

describe("buildSystemPrompt executePlan", () => {
	test("does not include the Executing Plan section by default", () => {
		const prompt = buildSystemPrompt({
			selectedTools: [],
			contextFiles: [],
			skills: [],
			cwd: process.cwd(),
		});
		expect(prompt).not.toContain("## Executing Plan");
	});

	test("includes skeleton with planPath when executePlan is set", () => {
		const prompt = buildSystemPrompt({
			selectedTools: [],
			contextFiles: [],
			skills: [],
			cwd: process.cwd(),
			executePlan: { planPath: "/tmp/.pi/add-rate-limiting.md" },
		});
		expect(prompt).toContain("## Executing Plan");
		expect(prompt).toContain("`/tmp/.pi/add-rate-limiting.md`");
		expect(prompt).toContain("source of truth");
	});

	test("renders title when provided", () => {
		const prompt = buildSystemPrompt({
			selectedTools: [],
			contextFiles: [],
			skills: [],
			cwd: process.cwd(),
			executePlan: { planPath: "/tmp/.pi/x.md", title: "Add rate limiting" },
		});
		expect(prompt).toContain("Title: **Add rate limiting**");
	});

	test("substitutes planPath / planTitle placeholders inside the executePlan slot body", () => {
		const prompt = buildSystemPrompt({
			selectedTools: [],
			contextFiles: [],
			skills: [],
			cwd: process.cwd(),
			executePlan: { planPath: "/tmp/.pi/x.md", title: "X" },
			customPrompts: { planMode: undefined, executePlan: `Read \${planPath} (title: \${planTitle}) and proceed.` },
		});
		expect(prompt).toContain("Read /tmp/.pi/x.md (title: X) and proceed");
	});

	test("leaves unresolved placeholder literal intact when var missing", () => {
		const prompt = buildSystemPrompt({
			selectedTools: [],
			contextFiles: [],
			skills: [],
			cwd: process.cwd(),
			executePlan: { planPath: "/tmp/.pi/x.md" },
			customPrompts: { planMode: undefined, executePlan: `title=\${planTitle} path=\${planPath}` },
		});
		expect(prompt).toContain(`title=\${planTitle}`); // literal kept
		expect(prompt).toContain("path=/tmp/.pi/x.md"); // substituted
	});

	test("no skeleton or slot when executePlan is absent", () => {
		const prompt = buildSystemPrompt({
			selectedTools: [],
			contextFiles: [],
			skills: [],
			cwd: process.cwd(),
		});
		expect(prompt).not.toContain("Executing Plan");
		expect(prompt).not.toContain("source of truth");
	});
});

describe("buildSystemPrompt customPrompts", () => {
	test("does not insert slots when both keys are undefined", () => {
		const prompt = buildSystemPrompt({
			selectedTools: [],
			contextFiles: [],
			skills: [],
			cwd: process.cwd(),
			planMode: { draftRoot: "/tmp/draft" },
			executePlan: { planPath: "/tmp/.pi/x.md" },
			customPrompts: { planMode: undefined, executePlan: undefined },
		});
		expect(prompt).toContain("## Plan Mode");
		expect(prompt).toContain("## Executing Plan");
		// No user text slipped in.
		expect(prompt).not.toContain("Ask one question");
		expect(prompt).not.toContain("proceed");
	});
});
