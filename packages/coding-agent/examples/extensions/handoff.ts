/**
 * Handoff extension - transfer context to a new session
 *
 * Summarizes the current session into a progress file at handoff/<name>.md (name chosen by the model),
 * then starts a new session with a short continuation prompt that points to that file.
 *
 * The handoff is delivered through a forced `write_handoff` tool call rather than free-text
 * markers. The tool call is forced via `tool_choice` (injected per-provider through onPayload),
 * so the output is structurally constrained and does not depend on the model choosing to emit
 * a specific text format. This avoids failures where an agentic model stops with `toolUse`
 * intent (trying to "investigate" before writing) and never produces the markers.
 *
 * Usage:
 *   /handoff                       - continue the current work
 *   /handoff implement phase two   - carry over context for a specific next goal
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type Api,
	complete,
	type Message,
	type Model,
	type StopReason,
	type Tool,
	type ToolCall,
	Type,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ModelRegistry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, convertToLlm, getAgentDir, serializeConversation } from "@earendil-works/pi-coding-agent";

const HANDOFF_TOOL_NAME = "write_handoff";

/**
 * Default model used to generate the handoff summary. The summary is a
 * one-shot, context-heavy writing task, so it is pinned to a capable model
 * rather than the session's current (possibly small/fast) model. If the
 * preferred model is unavailable or has no auth configured, fall back to the
 * current session model.
 */
const SUMMARY_MODEL_PROVIDER = "minimax-cn";
const SUMMARY_MODEL_ID = "MiniMax-M3";

const SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for continuing, produce a handoff that lets a fresh session continue the work with zero context loss.

Derive everything from the conversation; do not invent facts. The progress doc must capture at minimum: the original goal, what was accomplished, the current state, ordered next steps (immediate action first), key files and why they matter, key decisions and rationale, and any gotchas / open questions / uncommitted git state the next session must know.

Deliver the result by calling the \`${HANDOFF_TOOL_NAME}\` tool exactly once. Do not output any prose, preamble, or commentary - just the tool call. The tool takes three string arguments:
- \`file\`: a kebab-case slug for the file name (e.g. "fix-login-bug"). No directory, no ".md" extension.
- \`prompt\`: a SHORT continuation prompt for the new session that points to handoff/<file>.md and states the immediate next action. It must not duplicate the doc.
- \`summary\`: the full progress document as Markdown.`;

/**
 * Tool the model is forced to call to deliver the handoff. The schema constrains
 * the three required fields; `tool_choice` (set via onPayload) constrains the
 * model to actually call it.
 */
const writeHandoffTool: Tool = {
	name: HANDOFF_TOOL_NAME,
	description:
		"Deliver the handoff result. Call exactly once with the progress doc (Markdown) in `summary`, a kebab-case file slug in `file`, and a short continuation prompt in `prompt`.",
	parameters: Type.Object({
		file: Type.String({
			description:
				"Kebab-case slug for the handoff file name, e.g. 'fix-login-bug'. No directory, no '.md' extension.",
		}),
		prompt: Type.String({
			description:
				"A short continuation prompt for the new session pointing to handoff/<file>.md and stating the immediate next action. Do not duplicate the summary.",
		}),
		summary: Type.String({
			description: "The full progress document as Markdown.",
		}),
	}),
};

/**
 * Per-API `tool_choice` payload that forces a call to `toolName`. Returned value
 * is injected into the provider request body via onPayload (the typed `toolChoice`
 * option is not wired for every provider, so onPayload is the uniform path).
 * Returns undefined for APIs where forced tool choice is unsupported; for those
 * we still register the tool and rely on the model calling it.
 */
function forcedToolChoice(api: string, toolName: string): unknown {
	switch (api) {
		case "openai-completions":
			return { type: "function", function: { name: toolName } };
		case "anthropic-messages":
			return { type: "tool", name: toolName };
		case "openai-responses":
		case "azure-openai-responses":
			return { type: "function", name: toolName };
		default:
			return undefined;
	}
}

/**
 * Resolve the model that generates the handoff summary. Pinned to
 * `minimax-cn/MiniMax-M3` by default (a one-shot, context-heavy writing task),
 * falling back to the current session model when the preferred model is
 * missing or has no auth configured.
 */
function resolveSummaryModel(registry: ModelRegistry, currentModel: Model<Api>): Model<Api> {
	const preferred = registry.find(SUMMARY_MODEL_PROVIDER, SUMMARY_MODEL_ID);
	if (preferred && registry.hasConfiguredAuth(preferred)) {
		return preferred;
	}
	return currentModel;
}

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
	/** First tool call in the response, if any. Expected to be `write_handoff`. */
	toolCall?: ToolCall;
	errorMessage?: string;
}

type ParseResult = { ok: true; parsed: ParsedHandoff; notes: string[] } | { ok: false; diagnostic: string };

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}…<+${text.length - max} chars>`;
}

interface ToolCallDiagnosticInput {
	reason: string;
	stopReason?: StopReason;
	toolCall?: ToolCall;
	file: string;
	prompt: string;
	summary: string;
	text?: string;
	thinking?: string;
}

function buildToolCallDiagnostic(d: ToolCallDiagnosticInput): string {
	const out: string[] = [];
	out.push("=== HANDOFF PARSE FAILURE DIAGNOSTIC ===");
	out.push("");
	out.push(`Reason: ${d.reason}`);
	out.push(`Mode: structured tool call (${HANDOFF_TOOL_NAME})`);
	if (d.stopReason) {
		const hint =
			d.stopReason === "length"
				? " (output was truncated by the provider - the tool arguments exceeded the output token limit)"
				: d.stopReason === "error"
					? " (provider reported an error)"
					: "";
		out.push(`Model stopReason: ${d.stopReason}${hint}`);
	}
	out.push(`Tool call present: ${d.toolCall ? `yes (name=${JSON.stringify(d.toolCall.name)})` : "no"}`);
	if (d.toolCall) {
		out.push(`Tool argument keys: ${JSON.stringify(Object.keys(d.toolCall.arguments ?? {}))}`);
	}
	out.push(`file length: ${d.file.length}, prompt length: ${d.prompt.length}, summary length: ${d.summary.length}`);
	out.push("");
	if (d.thinking?.trim()) {
		out.push("--- Model thinking preview (first 1500 chars) ---");
		out.push(truncate(d.thinking, 1500));
		out.push("");
	}
	if (d.toolCall) {
		out.push("--- toolCall.arguments (first 2000 chars) ---");
		try {
			out.push(truncate(JSON.stringify(d.toolCall.arguments, null, 2), 2000));
		} catch {
			out.push("(could not serialize arguments)");
		}
		out.push("");
	} else {
		// No tool call: show whatever text/thinking the model emitted instead, so
		// the "did not call write_handoff" case is diagnosable (e.g. a provider
		// that ignored tool_choice and produced a preamble or free text).
		out.push("--- Model text output (first 800 chars) ---");
		out.push(truncate(d.text ?? "(empty)", 800));
		out.push("");
	}
	out.push("=== END DIAGNOSTIC ===");
	return out.join("\n");
}

/**
 * Parse the handoff from the forced `write_handoff` tool call. With `tool_choice`
 * enforced, the response always contains the tool call; the only failure modes are
 * a wrong tool name, missing/empty arguments, or a provider that ignored
 * `tool_choice` and emitted no tool call at all.
 */
function parseHandoff(gen: HandoffGeneration): ParseResult {
	const fail = (
		reason: string,
		toolCall: ToolCall | undefined,
		file: string,
		prompt: string,
		summary: string,
	): ParseResult => ({
		ok: false,
		diagnostic: buildToolCallDiagnostic({
			reason,
			stopReason: gen.stopReason,
			toolCall,
			file,
			prompt,
			summary,
			text: gen.text,
			thinking: gen.thinking,
		}),
	});

	if (!gen.toolCall) {
		return fail(
			`Model did not call the ${HANDOFF_TOOL_NAME} tool. The selected provider/api may not support forced tool calls (tool_choice was not enforced).`,
			undefined,
			"",
			"",
			"",
		);
	}

	if (gen.toolCall.name !== HANDOFF_TOOL_NAME) {
		return fail(
			`Model called tool ${JSON.stringify(gen.toolCall.name)} but expected ${JSON.stringify(HANDOFF_TOOL_NAME)}.`,
			gen.toolCall,
			"",
			"",
			"",
		);
	}

	const args = (gen.toolCall.arguments ?? {}) as { file?: unknown; prompt?: unknown; summary?: unknown };
	const file = typeof args.file === "string" ? args.file.trim() : "";
	const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
	const summary = typeof args.summary === "string" ? args.summary.trim() : "";

	if (!file) {
		return fail(
			`Tool call ${HANDOFF_TOOL_NAME} is missing a non-empty \`file\` argument.`,
			gen.toolCall,
			file,
			prompt,
			summary,
		);
	}
	if (!prompt) {
		return fail(
			`Tool call ${HANDOFF_TOOL_NAME} is missing a non-empty \`prompt\` argument.`,
			gen.toolCall,
			file,
			prompt,
			summary,
		);
	}
	if (!summary) {
		return fail(
			`Tool call ${HANDOFF_TOOL_NAME} is missing a non-empty \`summary\` argument.`,
			gen.toolCall,
			file,
			prompt,
			summary,
		);
	}

	return { ok: true, parsed: { file, prompt, summary }, notes: [`Parsed from ${HANDOFF_TOOL_NAME} tool call.`] };
}

/**
 * Force the handoff doc under handoff/<name>.md. The model chooses <name>;
 * the directory is fixed. Only the base name of the model's output is kept,
 * which blocks path traversal and absolute paths.
 */
function resolveHandoffPath(file: string): string {
	const base =
		file
			.replace(/[\\/]+/g, "/")
			.split("/")
			.pop() ?? "";
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

			// Generate the summary with a capable default model rather than the
			// session's current model, which may be a small/fast model unsuited
			// to the one-shot, context-heavy summarization task.
			const summaryModel = resolveSummaryModel(ctx.modelRegistry, ctx.model);

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
				const loader = new BorderedLoader(tui, theme, `Generating handoff with ${summaryModel.name}...`);
				loader.onAbort = () => done(null);

				const doGenerate = async (): Promise<HandoffGeneration | null> => {
					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(summaryModel);
					if (!auth.ok || !auth.apiKey) {
						throw new Error(auth.ok ? `No API key for ${summaryModel.provider}` : auth.error);
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
					// API default and truncate the handoff doc mid-output.
					const maxTokens = summaryModel.maxTokens > 0 ? summaryModel.maxTokens : undefined;

					// Force the model to call `write_handoff` so the output is a
					// structured tool call, not free-text markers the model may fail
					// to produce. The choice is injected per-API via onPayload (the
					// typed toolChoice option is not wired for every provider).
					const toolChoice = forcedToolChoice(summaryModel.api, HANDOFF_TOOL_NAME);

					// For Anthropic reasoning models, disable thinking: summarization
					// needs none, and Anthropic rejects `tool_choice: { type: "tool" }`
					// while extended thinking is enabled. (openai-completions already
					// defaults to thinking disabled when no reasoningEffort is passed;
					// openai-responses defaults to effort "none".)
					const disableThinking = summaryModel.api === "anthropic-messages" ? { thinkingEnabled: false } : {};

					const response = await complete(
						summaryModel,
						{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage], tools: [writeHandoffTool] },
						{
							apiKey: auth.apiKey,
							headers: auth.headers,
							signal: loader.signal,
							maxTokens,
							...disableThinking,
							onPayload: (payload) => {
								if (toolChoice !== undefined) {
									(payload as Record<string, unknown>).tool_choice = toolChoice;
								}
								return payload;
							},
						},
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
					const toolCall = response.content.find((c): c is ToolCall => c.type === "toolCall");

					const gen: HandoffGeneration = { text, thinking, stopReason: response.stopReason, toolCall };
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
					`${parseResult.diagnostic}\n\n=== RAW MODEL OUTPUT ===\n${result.text}\n\n=== RAW TOOL CALL ===\n${
						result.toolCall ? JSON.stringify(result.toolCall, null, 2) : "(none)"
					}\n`,
					"utf8",
				);
				console.error(`[handoff] parse failed.\n${parseResult.diagnostic}\nRaw output dumped to ${dumpPath}`);
				const reasonText = (
					parseResult.diagnostic.split("\n").find((l) => l.startsWith("Reason:")) ?? "parse failed"
				).replace(/^Reason:\s*/, "");
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
