import { describe, expect, it } from "vitest";
import { enterAskMode, exitAskMode, isInAskMode } from "../../../src/modes/interactive/ask-mode-state.ts";
import { createHarness } from "../harness.ts";

describe("ask mode", () => {
	it("disables all active tools and switches the system prompt to Q&A identity", async () => {
		const harness = await createHarness();
		try {
			await harness.session.bindExtensions({});
			expect(harness.session.getActiveToolNames().sort()).toEqual(["ask", "bash", "edit", "read", "write"]);
			expect(harness.session.systemPrompt).toContain("expert coding assistant");

			harness.session.setAskMode(true);

			expect(isInAskMode()).toBe(true);
			expect(harness.session.getActiveToolNames()).toEqual([]);
			expect(harness.session.systemPrompt).toContain("Q&A assistant");
			expect(harness.session.systemPrompt).not.toContain("expert coding assistant");
		} finally {
			exitAskMode();
			harness.cleanup();
		}
	});

	it("restores the previous tool set when toggled off", async () => {
		const harness = await createHarness();
		try {
			await harness.session.bindExtensions({});
			const before = harness.session.getActiveToolNames().sort();

			harness.session.setAskMode(true);
			expect(harness.session.getActiveToolNames()).toEqual([]);

			harness.session.setAskMode(false);
			expect(isInAskMode()).toBe(false);
			expect(harness.session.getActiveToolNames().sort()).toEqual(before);
			expect(harness.session.systemPrompt).toContain("expert coding assistant");
		} finally {
			exitAskMode();
			harness.cleanup();
		}
	});

	it("applies ask mode to a session created while ask mode is active", async () => {
		enterAskMode();
		const harness = await createHarness();
		try {
			await harness.session.bindExtensions({});

			expect(harness.session.getActiveToolNames()).toEqual([]);
			expect(harness.session.systemPrompt).toContain("Q&A assistant");
		} finally {
			exitAskMode();
			harness.cleanup();
		}
	});

	it("blocks tool execution while ask mode is active", async () => {
		const harness = await createHarness();
		try {
			await harness.session.bindExtensions({});
			harness.session.setAskMode(true);

			const assistantMessage = {
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "" }],
				api: "openai-chat" as const,
				provider: "openai" as const,
				model: "gpt-4o",
				stopReason: "stop" as const,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			const toolCall = { type: "toolCall" as const, id: "1", name: "read", arguments: { path: "/etc/passwd" } };
			await expect(
				harness.session.agent.beforeToolCall!({
					assistantMessage,
					toolCall,
					args: toolCall.arguments,
					context: { messages: [], systemPrompt: harness.session.systemPrompt },
				}),
			).rejects.toThrow("Ask mode: the read tool is not available");
		} finally {
			exitAskMode();
			harness.cleanup();
		}
	});
});
