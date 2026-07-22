import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

async function flushPromises(): Promise<void> {
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

function stripAnsi(text: string): string {
	return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function makeSession(overrides: Partial<SessionInfo> & { id: string }): SessionInfo {
	return {
		path: overrides.path ?? `/tmp/${overrides.id}.jsonl`,
		id: overrides.id,
		cwd: overrides.cwd ?? "",
		name: overrides.name,
		parentSessionPath: overrides.parentSessionPath,
		parentRelation: overrides.parentRelation,
		created: overrides.created ?? new Date(0),
		modified: overrides.modified ?? new Date(0),
		messageCount: overrides.messageCount ?? 1,
		firstMessage: overrides.firstMessage ?? "hello",
		allMessagesText: overrides.allMessagesText ?? "hello",
	};
}

const PARENT = "/tmp/parent.jsonl";

describe("session selector subagent virtual group rendering", () => {
	const keybindings = new KeybindingsManager();

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	function makeSessions(): SessionInfo[] {
		return [
			makeSession({ id: "parent", path: PARENT, name: "Parent", modified: new Date("2026-01-01T00:00:00.000Z") }),
			makeSession({
				id: "sub1",
				path: "/tmp/sub1.jsonl",
				name: "subagent:scout - find auth",
				parentSessionPath: PARENT,
				parentRelation: "subagent",
				modified: new Date("2026-01-02T00:00:00.000Z"),
			}),
			makeSession({
				id: "sub2",
				path: "/tmp/sub2.jsonl",
				name: "subagent:worker - fix bug",
				parentSessionPath: PARENT,
				parentRelation: "subagent",
				modified: new Date("2026-01-03T00:00:00.000Z"),
			}),
			makeSession({
				id: "fork1",
				path: "/tmp/fork1.jsonl",
				name: "Forked work",
				parentSessionPath: PARENT,
				parentRelation: "fork",
				modified: new Date("2026-01-04T00:00:00.000Z"),
			}),
		];
	}

	it("shows subagent children under a virtual 'subagent' group with the ◆ edge tag", async () => {
		const sessions = makeSessions();
		// Current session is a subagent child so its ancestor path (parent ->
		// virtual group) stays expanded and the whole branch is visible.
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
			"/tmp/sub1.jsonl",
		);
		await flushPromises();

		const output = stripAnsi(selector.render(120).join("\n"));
		// The virtual group header is rendered.
		expect(output).toContain("subagent");
		// Both subagent children are visible with the ◆ relation tag.
		expect(output).toContain("◆ subagent:scout - find auth");
		expect(output).toContain("◆ subagent:worker - fix bug");
		// The fork child keeps its own edge tag and is a direct child.
		expect(output).toContain("⎇ Forked work");
	});

	it("hides the subagent group when the parent branch is collapsed", async () => {
		const sessions = makeSessions();
		// No current session: every node with children is folded by default.
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("Parent");
		// Parent is folded, so the virtual group and its children are hidden.
		expect(output).not.toContain("subagent:scout - find auth");
		expect(output).not.toContain("Forked work");
	});
});
