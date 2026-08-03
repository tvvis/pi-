/**
 * Handoff extension - transfer context to a new session
 *
 * Summarizes the current session into a progress file (path chosen by the model),
 * then starts a new session with a short continuation prompt that points to that file.
 *
 * Usage:
 *   /handoff                       - continue the current work
 *   /handoff implement phase two   - carry over context for a specific next goal
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { complete, type Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for continuing, produce a handoff that lets a fresh session continue the work with zero context loss.

Derive everything from the conversation; do not invent facts. The progress doc must capture at minimum: the original goal, what was accomplished, the current state, ordered next steps (immediate action first), key files and why they matter, key decisions and rationale, and any gotchas / open questions / uncommitted git state the next session must know.

You decide the doc's structure (Markdown) and the file path to write it to. Choose a sensible relative path yourself; do not create a dedicated handoff folder.

Then produce a SHORT continuation prompt for the new session that points to the file you chose and states the immediate next action. It must not duplicate the doc.

Output EXACTLY this format and nothing else:

FILE: <relative path>
===PROMPT===
<short continuation prompt>
===SUMMARY===
<the full progress doc as Markdown>`;

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "compaction") {
		return {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
			timestamp: new Date(entry.timestamp).getTime(),
		};
	}
	return undefined;
}

function getHandoffMessages(branch: SessionEntry[]): AgentMessage[] {
	let compactionIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "compaction") {
			compactionIndex = i;
			break;
		}
	}
	if (compactionIndex < 0) {
		return branch.map(entryToMessage).filter((message) => message !== undefined);
	}

	const compaction = branch[compactionIndex];
	const firstKeptIndex =
		compaction.type === "compaction" ? branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId) : -1;
	const compactedBranch = [
		compaction,
		...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []),
		...branch.slice(compactionIndex + 1),
	];
	return compactedBranch.map(entryToMessage).filter((message) => message !== undefined);
}

interface ParsedHandoff {
	file: string;
	prompt: string;
	summary: string;
}

function parseHandoff(text: string): ParsedHandoff | undefined {
	const summaryMarker = "===SUMMARY===";
	const promptMarker = "===PROMPT===";
	const sIdx = text.indexOf(summaryMarker);
	const pIdx = text.indexOf(promptMarker);
	if (sIdx < 0 || pIdx < 0 || pIdx > sIdx) return undefined;
	const header = text.slice(0, pIdx);
	const prompt = text.slice(pIdx + promptMarker.length, sIdx).trim();
	const summary = text.slice(sIdx + summaryMarker.length).trim();
	const fileMatch = header.match(/^FILE:\s*(.+)$/m);
	const file = fileMatch?.[1]?.trim();
	if (!file || !prompt || !summary) return undefined;
	return { file, prompt, summary };
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("handoff", {
		description: "Summarize this session to a file and start a new session to continue",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("handoff requires interactive mode", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			const goal = args.trim();
			const messages = getHandoffMessages(ctx.sessionManager.getBranch());

			if (messages.length === 0) {
				ctx.ui.notify("No conversation to hand off", "error");
				return;
			}

			const llmMessages = convertToLlm(messages);
			const conversationText = serializeConversation(llmMessages);
			const currentSessionFile = ctx.sessionManager.getSessionFile();

			// Generate the handoff (progress doc + file path + continuation prompt).
			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, `Generating handoff...`);
				loader.onAbort = () => done(null);

				const doGenerate = async () => {
					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
					if (!auth.ok || !auth.apiKey) {
						throw new Error(auth.ok ? `No API key for ${ctx.model!.provider}` : auth.error);
					}

					const goalSection = goal
						? `## User's Goal for New Thread\n\n${goal}`
						: `## User's Goal for New Thread\n\n(No explicit goal given. Infer the most logical next step from the conversation.)`;

					const userMessage: Message = {
						role: "user",
						content: [
							{
								type: "text",
								text: `## Conversation History\n\n${conversationText}\n\n${goalSection}`,
							},
						],
						timestamp: Date.now(),
					};

					const response = await complete(
						ctx.model!,
						{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
						{ apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
					);

					if (response.stopReason === "aborted") {
						return null;
					}

					return response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");
				};

				doGenerate()
					.then(done)
					.catch((err) => {
						console.error("Handoff generation failed:", err);
						done(null);
					});

				return loader;
			});

			if (result === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			const parsed = parseHandoff(result);
			if (!parsed) {
				ctx.ui.notify("Failed to parse handoff output", "error");
				return;
			}

			// Record progress: write the summary to the model-chosen path.
			const filePath = resolve(ctx.cwd, parsed.file);
			await mkdir(dirname(filePath), { recursive: true });
			await writeFile(filePath, `${parsed.summary}\n`, "utf8");

			// Start a new session with the short continuation prompt as a draft.
			const newSessionResult = await ctx.newSession({
				parentSession: currentSessionFile,
				withSession: async (replacementCtx) => {
					replacementCtx.ui.setEditorText(parsed.prompt);
					replacementCtx.ui.notify(`Handoff written to ${parsed.file}. Submit to continue.`, "info");
				},
			});

			if (newSessionResult.cancelled) {
				ctx.ui.notify("New session cancelled", "info");
			}
		},
	});
}
