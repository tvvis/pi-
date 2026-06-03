import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent, formatCwdForFooter } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage?: AssistantUsage;
}): AgentSession {
	const usage = options.usage;
	const entries =
		usage === undefined
			? []
			: [
					{
						type: "message",
						message: {
							role: "assistant",
							usage,
						},
					},
				];

	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getSessionName: () => options.sessionName,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		modelRegistry: {
			isUsingOAuth: () => false,
		},
	};

	return session as unknown as AgentSession;
}

function createFooterData(providerCount: number): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
		getDeepSeekBalance: () => null,
		onDeepSeekBalanceChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("formatCwdForFooter", () => {
	it("does not abbreviate sibling paths that share the home prefix", () => {
		expect(formatCwdForFooter("/home/user2", "/home/user")).toBe("/home/user2");
	});

	it("abbreviates the home directory and descendants", () => {
		expect(formatCwdForFooter("/home/user", "/home/user")).toBe("~");
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe("~/project");
	});
});

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps all lines within width for wide session names", () => {
		const width = 93;
		const session = createSession({ sessionName: "한글".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps stats line within width for wide model and provider names", () => {
		const width = 60;
		const session = createSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("omits the thinking level indicator for minimax providers", () => {
		const width = 120;
		for (const provider of ["minimax", "minimax-cn"]) {
			const session = createSession({
				sessionName: "",
				modelId: "MiniMax-M2.7",
				provider,
				reasoning: true,
				thinkingLevel: "high",
				usage: {
					input: 100,
					output: 200,
					cacheRead: 0,
					cacheWrite: 0,
					cost: { total: 0.001 },
				},
			});
			const footer = new FooterComponent(session, createFooterData(1));

			const lines = footer.render(width);
			const statsLine = lines[1] ?? "";
			// Should not contain the thinking level or "thinking off" text
			expect(stripAnsi(statsLine)).not.toContain("thinking off");
			expect(stripAnsi(statsLine)).not.toContain("• high");
			expect(stripAnsi(statsLine)).not.toContain("• low");
			expect(stripAnsi(statsLine)).not.toContain("• medium");
		}
	});

	it("shows the thinking level indicator for non-minimax reasoning models", () => {
		const width = 120;
		const session = createSession({
			sessionName: "",
			modelId: "claude-sonnet-4-5",
			provider: "anthropic",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 100,
				output: 200,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.001 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		const statsLine = stripAnsi(lines[1] ?? "");
		expect(statsLine).toContain("• high");
	});
});

// Minimal ANSI escape stripper for assertions that need plain text.
function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}
