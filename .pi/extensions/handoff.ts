/**
 * Handoff extension - transfer context to a new session
 *
 * Summarizes the current session into a progress file at handoff/<name>.md (name chosen by the model),
 * then starts a new session with a short continuation prompt that points to that file.
 *
 * Usage:
 *   /handoff                       - continue the current work
 *   /handoff implement phase two   - carry over context for a specific next goal
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { complete, type Message, type StopReason } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	BorderedLoader,
	convertToLlm,
	getAgentDir,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for continuing, produce a handoff that lets a fresh session continue the work with zero context loss.

Derive everything from the conversation; do not invent facts. The progress doc must capture at minimum: the original goal, what was accomplished, the current state, ordered next steps (immediate action first), key files and why they matter, key decisions and rationale, and any gotchas / open questions / uncommitted git state the next session must know.

You decide the doc's structure (Markdown) and a short descriptive file name. The doc is always written to handoff/<name>.md (relative to the project root), where <name> is a kebab-case slug you derive from the session's work (e.g. handoff/fix-login-bug.md). Do not use any other directory or path.

Then produce a SHORT continuation prompt for the new session that points to the file you chose and states the immediate next action. It must not duplicate the doc.

Output EXACTLY this format and nothing else - no markdown code fence around the output, no preamble, no commentary, and no text after the summary:

FILE: handoff/<name>.md
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

interface HandoffGeneration {
	text: string;
	thinking: string;
	stopReason: StopReason;
	errorMessage?: string;
}

type ParseResult =
	| { ok: true; parsed: ParsedHandoff; notes: string[] }
	| { ok: false; diagnostic: string };

function lineText(body: string, index: number): string {
	const end = body.indexOf("\n", index);
	return end >= 0 ? body.slice(index, end) : body.slice(index);
}

interface MarkerHit {
	index: number;
	line: string;
	loose: boolean;
}

function findMarker(body: string, keyword: "PROMPT" | "SUMMARY"): MarkerHit | null {
	// Strict: === KEYWORD === with tolerant whitespace (handles indentation,
	// trailing spaces, and CRLF). Requires >=2 '=' on each side so prose
	// mentions of "PROMPT"/"SUMMARY" never match.
	const strict = body.match(new RegExp(`^[ \\t]*={2,}[ \\t]*${keyword}[ \\t]*={2,}[ \\t]*$`, "im"));
	if (strict && strict.index != null) {
		return { index: strict.index, line: lineText(body, strict.index), loose: false };
	}
	// Loose fallback (only when the === style is absent): the keyword is the
	// only alphabetic token on its line, possibly wrapped in markdown /
	// box-drawing decoration. Matches "## SUMMARY", "**PROMPT**",
	// "--- SUMMARY ---", "[PROMPT]", "PROMPT:" while rejecting prose lines
	// that contain other words (e.g. "## Summary of work").
	const loose = body.match(new RegExp(`^[ \\t]*[^A-Za-z\\n]*${keyword}[^A-Za-z\\n]*[ \\t]*$`, "im"));
	if (loose && loose.index != null) {
		return { index: loose.index, line: lineText(body, loose.index), loose: true };
	}
	return null;
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}…<+${text.length - max} chars>`;
}

interface DiagnosticInput {
	reason: string;
	rawLength: number;
	fenceStripped: boolean;
	promptMarker: MarkerHit | null;
	summaryMarker: MarkerHit | null;
	body: string;
	stopReason?: StopReason;
	thinking?: string;
}

function buildDiagnostic(d: DiagnosticInput): string {
	const out: string[] = [];
	out.push("=== HANDOFF PARSE FAILURE DIAGNOSTIC ===");
	out.push("");
	out.push(`Reason: ${d.reason}`);
	out.push(`Raw output length: ${d.rawLength} chars`);
	if (d.stopReason) {
		const hint =
			d.stopReason === "length"
				? " (output was truncated by the provider - the handoff exceeded the output token limit)"
				: d.stopReason === "error"
					? " (provider reported an error)"
					: "";
		out.push(`Model stopReason: ${d.stopReason}${hint}`);
	}
	out.push(`Surrounding code fence stripped: ${d.fenceStripped}`);
	out.push("");
	const fmt = (m: MarkerHit | null) =>
		m ? `found at index ${m.index} (loose=${m.loose}); line=${JSON.stringify(m.line)}` : "NOT FOUND";
	out.push(`PROMPT marker:  ${fmt(d.promptMarker)}`);
	out.push(`SUMMARY marker: ${fmt(d.summaryMarker)}`);
	out.push("");
	if (d.thinking && d.thinking.trim()) {
		out.push("--- Model thinking preview (first 1500 chars) ---");
		out.push(truncate(d.thinking, 1500));
		out.push("");
	}
	out.push("--- Body preview (first 800 chars) ---");
	out.push(truncate(d.body, 800));
	out.push("");
	out.push("--- Body tail (last 400 chars) ---");
	out.push(d.body.length > 400 ? d.body.slice(-400) : d.body);
	out.push("");
	out.push("=== END DIAGNOSTIC ===");
	return out.join("\n");
}

function parseHandoff(gen: HandoffGeneration): ParseResult {
	const notes: string[] = [];
	const text = gen.text;
	const rawLength = text.length;

	let fenceStripped = false;
	let body = text.trim();
	const fence = body.match(/^```[^\n]*\n([\s\S]*?)\n?```\s*$/);
	if (fence) {
		body = fence[1].trim();
		fenceStripped = true;
		notes.push("Stripped a surrounding markdown code fence.");
	}

	const promptMarker = findMarker(body, "PROMPT");
	const summaryMarker = findMarker(body, "SUMMARY");

	const fail = (reason: string): ParseResult => {
		const fullReason =
			gen.stopReason === "length" ? `${reason} [stopReason=length: output truncated]` : reason;
		return {
			ok: false,
			diagnostic: buildDiagnostic({
				reason: fullReason,
				rawLength,
				fenceStripped,
				promptMarker,
				summaryMarker,
				body,
				stopReason: gen.stopReason,
				thinking: gen.thinking,
			}),
		};
	};

	if (!body) {
		return fail("Model returned no text content (output is empty).");
	}
	if (!promptMarker) return fail("PROMPT marker not found.");
	if (!summaryMarker) return fail("SUMMARY marker not found.");
	if (promptMarker.index >= summaryMarker.index) {
		return fail("PROMPT marker appears at or after SUMMARY marker (wrong order).");
	}

	if (promptMarker.loose) notes.push(`Used loose match for PROMPT marker: ${JSON.stringify(promptMarker.line)}.`);
	if (summaryMarker.loose) notes.push(`Used loose match for SUMMARY marker: ${JSON.stringify(summaryMarker.line)}.`);

	const pIdx = promptMarker.index;
	const sIdx = summaryMarker.index;

	const header = body.slice(0, pIdx);
	const promptLineEnd = body.indexOf("\n", pIdx);
	const prompt = promptLineEnd >= 0 ? body.slice(promptLineEnd + 1, sIdx).trim() : "";
	const summaryLineEnd = body.indexOf("\n", sIdx);
	const summary = summaryLineEnd >= 0 ? body.slice(summaryLineEnd + 1).trim() : "";

	// FILE line in the header. Case-insensitive; tolerate markdown decoration
	// (## FILE, **FILE**) and surrounding backticks/quotes around the path.
	const fileMatch = header.match(/^[ \t]*[#*>`]*[ \t]*file[ \t]*:[ \t]*([^\n]+)/im);
	let file: string | undefined;
	if (fileMatch) {
		file = fileMatch[1].replace(/[`"'*#]/g, "").trim();
	}

	if (!file) return fail("FILE path not found in the header before the PROMPT marker.");
	if (!prompt) return fail("Continuation prompt is empty (nothing between PROMPT and SUMMARY markers).");
	if (!summary) return fail("Summary doc is empty (nothing after the SUMMARY marker).");

	return { ok: true, parsed: { file, prompt, summary }, notes };
}

/**
 * Force the handoff doc under handoff/<name>.md. The model chooses <name>;
 * the directory is fixed. Only the base name of the model's output is kept,
 * which blocks path traversal and absolute paths.
 */
function resolveHandoffPath(file: string): string {
	const base = file.replace(/[\\/]+/g, "/").split("/").pop() ?? "";
	const name = base.trim().replace(/\.md$/i, "").trim() || "handoff";
	return `handoff/${name}.md`;
}

/**
 * Persistent location for failure dumps. Uses the pi agent dir (~/.pi/agent)
 * rather than tmpdir so the artifacts survive a reboot and are discoverable
 * next to pi-debug.log. The TUI does not persist console.error by default, so
 * this file is the primary forensic trail when a handoff fails.
 */
function handoffDumpPath(): string {
	return join(getAgentDir(), `handoff-failed-${Date.now()}.md`);
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
			const result = await ctx.ui.custom<HandoffGeneration | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, `Generating handoff...`);
				loader.onAbort = () => done(null);

				const doGenerate = async (): Promise<HandoffGeneration | null> => {
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

					// Set an explicit maxTokens so providers don't fall back to a low
					// API default and truncate the handoff doc mid-output (which was
					// the dominant cause of "Failed to parse handoff output": the
					// ===SUMMARY=== marker never arrived).
					const maxTokens = ctx.model!.maxTokens > 0 ? ctx.model!.maxTokens : undefined;

					const response = await complete(
						ctx.model!,
						{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
						{ apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal, maxTokens },
					);

					if (response.stopReason === "aborted") {
						return null;
					}

					const text = response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");
					const thinking = response.content
						.filter((c): c is { type: "thinking"; thinking: string } => c.type === "thinking")
						.map((c) => c.thinking)
						.join("\n");

					const gen: HandoffGeneration = { text, thinking, stopReason: response.stopReason };
					if (response.errorMessage) gen.errorMessage = response.errorMessage;
					return gen;
				};

				doGenerate()
					.then(done)
					.catch((err) => {
						// Route unexpected errors (auth, network, provider stream setup)
						// through the same error path as stopReason="error" so they produce
						// a persistent dump + specific toast instead of a misleading
						// "Cancelled".
						console.error("Handoff generation failed:", err);
						done({
							text: "",
							thinking: "",
							stopReason: "error",
							errorMessage: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err),
						});
					});

				return loader;
			});

			if (result === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			// Surface provider errors distinctly instead of letting them fall through
			// to a confusing "failed to parse" message (the text is usually empty).
			// This branch also receives unexpected throws from doGenerate (auth /
			// network), routed here via the .catch above with stopReason="error".
			if (result.stopReason === "error") {
				const dumpPath = handoffDumpPath();
				const errMsg = result.errorMessage ?? "(no error message)";
				const dumpBody = `Handoff generation failed.\n\nstopReason: ${result.stopReason}\nerrorMessage: ${errMsg}\n\n--- Model thinking preview ---\n${truncate(result.thinking, 1500)}\n\n--- Model text output ---\n${result.text || "(empty)"}\n`;
				await writeFile(dumpPath, dumpBody, "utf8");
				console.error(`[handoff] generation failed (stopReason=error): ${errMsg}\nDump: ${dumpPath}`);
				ctx.ui.notify(`Handoff failed: ${truncate(errMsg, 120)}. See ${dumpPath}`, "error");
				return;
			}

			const parseResult = parseHandoff(result);
			if (!parseResult.ok) {
				const dumpPath = handoffDumpPath();
				await writeFile(
					dumpPath,
					`${parseResult.diagnostic}\n\n=== RAW MODEL OUTPUT ===\n${result.text}\n`,
					"utf8",
				);
				console.error(`[handoff] parse failed.\n${parseResult.diagnostic}\nRaw output dumped to ${dumpPath}`);
				const reasonText = (parseResult.diagnostic.split("\n").find((l) => l.startsWith("Reason:")) ?? "parse failed").replace(
					/^Reason:\s*/,
					"",
				);
				ctx.ui.notify(`Handoff failed: ${reasonText}. Details: ${dumpPath}`, "error");
				return;
			}

			const { parsed, notes } = parseResult;
			if (notes.length) {
				console.error(`[handoff] parse notes: ${notes.join(" ")}`);
			}

			// Record progress: write the summary to handoff/<name>.md. The model
			// picks <name>; the directory is fixed and the path is sanitized to
			// block traversal / absolute paths.
			const relPath = resolveHandoffPath(parsed.file);
			const filePath = resolve(ctx.cwd, relPath);
			await mkdir(dirname(filePath), { recursive: true });
			await writeFile(filePath, `${parsed.summary}\n`, "utf8");

			// Start a new session with the short continuation prompt as a draft.
			// Carry the current model over: newSession re-derives the model from CLI
			// flags + saved default, so without this the new session reverts.
			const currentModel = ctx.model;
			const newSessionResult = await ctx.newSession({
				parentSession: currentSessionFile,
				withSession: async (replacementCtx) => {
					if (currentModel) {
						await replacementCtx.setModel(currentModel);
					}
					replacementCtx.ui.setEditorText(parsed.prompt);
					replacementCtx.ui.notify(`Handoff written to ${relPath}. Submit to continue.`, "info");
				},
			});

			if (newSessionResult.cancelled) {
				ctx.ui.notify("New session cancelled", "info");
			}
		},
	});
}
