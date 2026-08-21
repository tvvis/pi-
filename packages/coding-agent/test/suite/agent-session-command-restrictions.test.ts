/**
 * End-to-end characterization for the per-provider command restrictions wired
 * through AgentSession: when the bash tool rejects a command for a restricted
 * provider, the session aborts the in-flight agent run and emits a
 * `command_restricted` event so UI modes can surface the block to the user.
 */

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession command restrictions", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("aborts the in-flight agent run and emits command_restricted when bash rejects a command", async () => {
		// Create a harness whose faux provider is registered under the restricted
		// provider name, so the default bash tool (wired by AgentSession with
		// getModel: () => this.model) applies the policy.
		const harness = await createHarness({
			provider: "minimax-cn",
			models: [{ id: "MiniMax-M2", name: "MiniMax-M2" }],
		});
		harnesses.push(harness);

		expect(harness.session.model?.provider).toBe("minimax-cn");

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf /tmp/x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("should not be reached"),
		]);

		await harness.session.prompt("do something dangerous");

		const restrictedEvents = harness.eventsOfType("command_restricted");
		expect(restrictedEvents.length).toBe(1);
		expect(restrictedEvents[0]?.command).toBe("rm -rf /tmp/x");
		expect(restrictedEvents[0]?.reason).toMatch(/recursive and force/);

		// The bash tool was blocked, so the agent loop aborted mid-run. The
		// final assistant message should be aborted, not the queued follow-up.
		const assistants = harness.session.messages.filter((m) => m.role === "assistant");
		expect(assistants.length).toBeGreaterThan(0);
		const last = assistants[assistants.length - 1] as { stopReason?: string };
		expect(last.stopReason).toBe("aborted");
	});

	it("does not emit command_restricted when the active provider is unrestricted", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf /tmp/x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("ok"),
		]);

		await harness.session.prompt("do something dangerous");

		expect(harness.eventsOfType("command_restricted")).toEqual([]);
	});
});
