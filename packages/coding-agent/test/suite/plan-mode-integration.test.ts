/**
 * Integration tests for plan mode at the AgentSession layer.
 *
 * Drives the full path: enterPlanMode + setActiveToolsByName flips the
 * system prompt and tool guards; write/edit/bash/plan tools consult the
 * module-level plan-mode state at execute time. The confirmation popup
 * (plan tool with ready=true in plan mode) needs a real UI and is not
 * covered here; plan-mode-state.test.ts covers the state machine.
 */

import { rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import {
	enterPlanMode,
	exitPlanMode,
	getDraftRoot,
	PlanModeBashDisabledError,
	PlanModeWriteError,
	PlanToolRequiresPlanModeError,
} from "../../src/modes/interactive/plan-mode-state.ts";
import { createHarness, type Harness } from "./harness.ts";

const SESSION_ID = "plan-integration-test";
const PLAN_TOOLS = ["read", "grep", "find", "ls", "ask", "write", "edit", "plan"];
const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "ask"];

function getTool(harness: Harness, name: string): AgentTool {
	const tool = harness.session.agent.state.tools.find((t) => t.name === name);
	if (!tool) {
		const active = harness.session.agent.state.tools.map((t) => t.name).join(", ");
		throw new Error(`tool "${name}" not active; active: [${active}]`);
	}
	return tool;
}

describe("plan mode integration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		exitPlanMode();
		rmSync(join(homedir(), ".pi", "draft", SESSION_ID), { recursive: true, force: true });
	});

	it("does not include the plan tool in the default active set", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		expect(harness.session.getActiveToolNames()).not.toContain("plan");
		// ...but it is registered and can be activated.
		expect(harness.session.getAllTools().map((t) => t.name)).toContain("plan");
	});

	it("injects the Plan Mode section into the system prompt on enter", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		expect(harness.session.systemPrompt).not.toContain("## Plan Mode");

		enterPlanMode({ sessionId: SESSION_ID, description: "add rate limiting" });
		harness.session.setActiveToolsByName(PLAN_TOOLS);

		const prompt = harness.session.systemPrompt;
		expect(prompt).toContain("## Plan Mode");
		expect(prompt).toContain("You are in plan mode");
		expect(prompt).toContain("The user is planning: add rate limiting");
		const draft = getDraftRoot();
		expect(draft).toBe(join(homedir(), ".pi", "draft", SESSION_ID));
		expect(prompt).toContain(draft!);
	});

	it("drops the Plan Mode section on exit", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		enterPlanMode({ sessionId: SESSION_ID });
		harness.session.setActiveToolsByName(PLAN_TOOLS);
		expect(harness.session.systemPrompt).toContain("## Plan Mode");

		exitPlanMode();
		harness.session.setActiveToolsByName(DEFAULT_TOOLS);
		expect(harness.session.systemPrompt).not.toContain("## Plan Mode");
	});

	it("write tool throws PlanModeWriteError outside the draft root", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		enterPlanMode({ sessionId: SESSION_ID });
		harness.session.setActiveToolsByName(PLAN_TOOLS);

		const write = getTool(harness, "write");
		await expect(
			write.execute("tc1", { path: "/tmp/pi-plan-mode-forbidden.txt", content: "x" }),
		).rejects.toBeInstanceOf(PlanModeWriteError);
	});

	it("write tool succeeds inside the draft root", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		enterPlanMode({ sessionId: SESSION_ID });
		harness.session.setActiveToolsByName(PLAN_TOOLS);

		const write = getTool(harness, "write");
		const draft = getDraftRoot()!;
		const result = await write.execute("tc1", { path: join(draft, "draft.md"), content: "# Plan: x\n" });
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		expect(text).toContain("Successfully wrote");
	});

	it("bash tool throws PlanModeBashDisabledError", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		// Grab the bash tool instance before entering plan mode (bash is not in
		// the plan-mode active set). The guard checks module-level state, not
		// the active tool set, so this still exercises the plan-mode path.
		const bash = getTool(harness, "bash");
		enterPlanMode({ sessionId: SESSION_ID });
		harness.session.setActiveToolsByName(PLAN_TOOLS);

		await expect(bash.execute("tc1", { command: "ls" })).rejects.toBeInstanceOf(PlanModeBashDisabledError);
	});

	it("plan tool throws PlanToolRequiresPlanModeError outside plan mode", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		// Activate the plan tool so we can grab its instance, then make sure
		// plan mode is off before calling execute.
		harness.session.setActiveToolsByName(PLAN_TOOLS);
		exitPlanMode();

		const plan = getTool(harness, "plan");
		await expect(plan.execute("tc1", { ready: true })).rejects.toBeInstanceOf(PlanToolRequiresPlanModeError);
	});

	it("plan tool pushes the draft to chat and shows the popup when ready", async () => {
		// Use the unwrapped ToolDefinition so we can pass a mock ctx.
		const { createPlanToolDefinition } = await import("../../src/core/tools/plan.ts");
		const def = createPlanToolDefinition();

		enterPlanMode({ sessionId: SESSION_ID });
		// Write a draft that the plan tool will read and push to chat.
		const draft = getDraftRoot()!;
		await mkdir(draft, { recursive: true });
		const draftContent = "# Plan: ship the thing\n\n## Approach\ndo it\n";
		await writeFile(join(draft, "draft.md"), draftContent, "utf-8");

		const pushCalls: Array<{ content: string; opts?: { title?: string } }> = [];
		let customCalled = 0;
		const ctx = {
			hasUI: true,
			ui: {
				pushChatMarkdown: (content: string, opts?: { title?: string }) => {
					pushCalls.push({ content, opts });
				},
				custom: <T>(_factory: unknown) => {
					customCalled++;
					return Promise.resolve(1 as T);
				},
			},
		};

		const result = await def.execute("tc1", { ready: true }, undefined, undefined, ctx as never);

		// pushChatMarkdown was called with the draft content and a title.
		expect(pushCalls).toHaveLength(1);
		expect(pushCalls[0]!.content).toBe(draftContent);
		expect(pushCalls[0]!.opts?.title).toContain("Plan draft");

		// The popup factory was invoked.
		expect(customCalled).toBe(1);

		// The result text is the short single-line form (D block).
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		expect(text).toBe("User chose option 1.");
		expect(result.details).toEqual({ choice: 1 });
	});

	it("plan tool pushes a warning when the draft is missing", async () => {
		const { createPlanToolDefinition } = await import("../../src/core/tools/plan.ts");
		const def = createPlanToolDefinition();

		enterPlanMode({ sessionId: SESSION_ID });
		// Don't write a draft — file doesn't exist.
		const pushCalls: Array<{ content: string; opts?: { title?: string } }> = [];
		const ctx = {
			hasUI: true,
			ui: {
				pushChatMarkdown: (content: string, opts?: { title?: string }) => {
					pushCalls.push({ content, opts });
				},
				custom: <T>(_factory: unknown) => Promise.resolve(2 as T),
			},
		};

		await def.execute("tc1", { ready: true }, undefined, undefined, ctx as never);

		expect(pushCalls).toHaveLength(1);
		expect(pushCalls[0]!.content).toMatch(/empty or missing/i);
	});
});

describe("AgentSession execute-plan + customPrompts", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		exitPlanMode();
	});

	it("setExecutePlan adds the Executing Plan section with the plan path", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		expect(harness.session.systemPrompt).not.toContain("## Executing Plan");

		harness.session.setExecutePlan({ planPath: "/tmp/.pi/custom.md", title: "Custom plan" });

		const prompt = harness.session.systemPrompt;
		expect(prompt).toContain("## Executing Plan");
		expect(prompt).toContain("`/tmp/.pi/custom.md`");
		expect(prompt).toContain("Title: **Custom plan**");
	});

	it("setExecutePlan(undefined) clears the section", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.setExecutePlan({ planPath: "/tmp/.pi/x.md" });
		expect(harness.session.systemPrompt).toContain("## Executing Plan");
		harness.session.setExecutePlan(undefined);
		expect(harness.session.systemPrompt).not.toContain("## Executing Plan");
	});

	it("loads planMode slot body from <cwd>/.pi/prompts.md", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		// AgentSession uses harness.tempDir as its cwd (not sessionManager.getCwd()).
		const piDir = join(harness.tempDir, ".pi");
		await mkdir(piDir, { recursive: true });
		await writeFile(join(piDir, "prompts.md"), "## Plan Mode\n\nUSER_PROMPT_MARKER: ask goal first\n", "utf-8");
		enterPlanMode({ sessionId: SESSION_ID });
		harness.session.setActiveToolsByName(PLAN_TOOLS);

		const prompt = harness.session.systemPrompt;
		expect(prompt).toContain("## Plan Mode");
		expect(prompt).toContain("USER_PROMPT_MARKER: ask goal first");
	});

	it("loads executePlan slot body from <cwd>/.pi/prompts.md and substitutes planPath var", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const piDir = join(harness.tempDir, ".pi");
		await mkdir(piDir, { recursive: true });
		await writeFile(join(piDir, "prompts.md"), `## Executing Plan\n\nread \${planPath} and follow it\n`, "utf-8");
		harness.session.setExecutePlan({ planPath: "/tmp/.pi/x.md", title: "My Plan" });

		const prompt = harness.session.systemPrompt;
		expect(prompt).toContain("read /tmp/.pi/x.md and follow it");
		expect(prompt).toContain("Title: **My Plan**");
	});

	it("missing prompts file: skeleton still emits, no slot body", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		enterPlanMode({ sessionId: SESSION_ID });
		harness.session.setActiveToolsByName(PLAN_TOOLS);
		const prompt = harness.session.systemPrompt;
		expect(prompt).toContain("## Plan Mode");
		// Skeleton wording remains
		expect(prompt).toContain("PlanModeWriteError");
		// No extra slot body
		expect(prompt).not.toContain("USER_PROMPT_MARKER");
	});
});
