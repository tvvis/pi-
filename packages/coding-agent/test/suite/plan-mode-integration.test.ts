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
		const result = await write.execute("tc1", { path: join(draft, "current.md"), content: "# Plan: x\n" });
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
});
