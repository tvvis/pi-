/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Each mode accepts an optional `model` field. Model resolution priority
 * (highest first):
 *   1. Per-item model in parallel/chain
 *   2. Call-site model
 *   3. Agent frontmatter `model:`
 *   4. Parent's `~/.pi/agent/settings.json` (`defaultProvider`/`defaultModel`)
 *   5. pi's built-in default (no `--model` flag)
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

/**
 * Resolve the parent's default model from `settings.json` (project overrides global).
 * Returns `undefined` when neither file is readable or `defaultModel` is unset.
 */
function resolveDefaultModelFromSettings(cwd: string): string | undefined {
	const candidates = [path.join(getAgentDir(), "settings.json"), path.join(cwd, ".pi", "settings.json")];
	for (const filePath of candidates) {
		if (!existsSync(filePath)) continue;
		try {
			const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as {
				defaultProvider?: unknown;
				defaultModel?: unknown;
			};
			const model = typeof parsed.defaultModel === "string" ? parsed.defaultModel.trim() : "";
			if (!model) continue;
			const provider = typeof parsed.defaultProvider === "string" ? parsed.defaultProvider.trim() : "";
			return provider ? `${provider}/${model}` : model;
		} catch {
			// Try the next candidate.
		}
	}
	return undefined;
}

/**
 * Read the model list the parent configured in `settings.json` (`enabledModels`).
 * Used to advertise valid `model` values in the tool description so the LLM can
 * pass one directly without inspecting settings first. Returns `[]` when unset.
 */
export function readEnabledModelsFromSettings(cwd: string): string[] {
	const candidates = [path.join(getAgentDir(), "settings.json"), path.join(cwd, ".pi", "settings.json")];
	for (const filePath of candidates) {
		if (!existsSync(filePath)) continue;
		try {
			const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as { enabledModels?: unknown };
			if (!Array.isArray(parsed.enabledModels)) continue;
			const models = parsed.enabledModels
				.filter((m): m is string => typeof m === "string")
				.map((m) => m.trim())
				.filter((m) => m.length > 0);
			if (models.length > 0) return models;
		} catch {
			// Try the next candidate.
		}
	}
	return [];
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown" | "generic";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

/**
 * Build the display name for a subagent child session:
 * `subagent:<agent> - <task>` with the task whitespace-normalized and capped
 * at 40 chars (no ellipsis, to keep the name short).
 */
export function buildSubagentSessionName(agent: string, task: string): string {
	return `subagent:${agent} - ${task.replace(/\s+/g, " ").trim().slice(0, 40)}`;
}

export interface SubagentArgsOptions {
	agentName: string;
	task: string;
	resolvedModel: string | undefined;
	tools: string[] | undefined;
	parentSessionFile: string | undefined;
	noSkills: boolean;
	skills: string[] | undefined;
	systemPrompt: string | undefined;
	appendSystemPrompt: string[] | undefined;
	/** Disable all pi function tools in the child (`--no-tools`). */
	noTools?: boolean;
	/** Skip project context files in the child (`--no-context-files`). */
	noContext?: boolean;
}

/**
 * Construct the CLI args for a subagent child process. The child persists its
 * own session (no `--no-session`) and, when a parent session file is known,
 * links back to it via `--parent-session`/`--parent-relation subagent` so the
 * `/resume` tree can group it under the parent. The parent controls the child's
 * skills (`--skill`/`--no-skills`) and context (`--system-prompt`/
 * `--append-system-prompt`).
 */
export function buildSubagentArgs(options: SubagentArgsOptions): string[] {
	const args: string[] = ["--mode", "json", "-p"];
	if (options.resolvedModel) args.push("--model", options.resolvedModel);
	if (options.tools && options.tools.length > 0) args.push("--tools", options.tools.join(","));
	if (options.noTools) args.push("--no-tools");
	if (options.noContext) args.push("--no-context-files");
	if (options.noSkills) args.push("--no-skills");
	if (options.skills) {
		for (const skill of options.skills) args.push("--skill", skill);
	}
	if (options.systemPrompt) args.push("--system-prompt", options.systemPrompt);
	if (options.appendSystemPrompt) {
		for (const part of options.appendSystemPrompt) args.push("--append-system-prompt", part);
	}
	if (options.parentSessionFile) {
		args.push("--parent-session", options.parentSessionFile, "--parent-relation", "subagent");
	}
	args.push("--name", buildSubagentSessionName(options.agentName, options.task));
	return args;
}

/**
 * Parent-controlled configuration for a subagent child. Values are merged
 * item-level > top-level before being passed to `runSingleAgent`.
 */
interface SubagentConfig {
	model: string | undefined;
	tools: string[] | undefined;
	systemPrompt: string | undefined;
	appendSystemPrompt: string[] | undefined;
	skills: string[] | undefined;
	noSkills: boolean;
	label: string | undefined;
}

type SubagentConfigOverride = Partial<SubagentConfig>;

function mergeSubagentConfig(parent: SubagentConfig, item: SubagentConfigOverride): SubagentConfig {
	return {
		model: item.model ?? parent.model,
		tools: item.tools ?? parent.tools,
		systemPrompt: item.systemPrompt ?? parent.systemPrompt,
		appendSystemPrompt: item.appendSystemPrompt ?? parent.appendSystemPrompt,
		skills: item.skills ?? parent.skills,
		noSkills: item.noSkills ?? parent.noSkills,
		label: item.label ?? parent.label,
	};
}

const TYPE_AGENT_CONFLICT =
	'Specify only one of `type` or `agent` for a subagent. Use `type: "standard"` (the default) for a generic subagent with no preset.';

/** Minimal shape of a subagent scope used for `type`/`agent` resolution. */
interface TypeAgentScope {
	type?: string;
	agent?: string;
}

/** Minimal shape of subagent params used for `type`/`agent` resolution. */
interface TypeAgentParams extends TypeAgentScope {
	tasks?: readonly TypeAgentScope[];
	chain?: readonly TypeAgentScope[];
}

/**
 * Validate that no subagent scope sets both `type` and `agent`. They are
 * alternative ways to name a preset; only one may be used per scope. Returns
 * the conflict message when a scope is malformed, otherwise `undefined`.
 */
export function validateTypeAgentExclusivity(params: TypeAgentParams): string | undefined {
	if (params.type !== undefined && params.agent !== undefined) return TYPE_AGENT_CONFLICT;
	if (params.tasks)
		for (const t of params.tasks) if (t.type !== undefined && t.agent !== undefined) return TYPE_AGENT_CONFLICT;
	if (params.chain)
		for (const s of params.chain) if (s.type !== undefined && s.agent !== undefined) return TYPE_AGENT_CONFLICT;
	return undefined;
}

/**
 * Resolve the agent preset name to load for a subagent scope. Assumes
 * `validateTypeAgentExclusivity` has already passed (no `type`+`agent` conflict).
 *
 * - `type: "standard"` (or both omitted) -> `undefined` (generic subagent, no preset)
 * - `type: "<name>"` -> `"<name>"` (loads that agent preset)
 * - `agent: "<name>"` (legacy alias) -> `"<name>"`
 */
export function presetNameFrom(type: string | undefined, agent: string | undefined): string | undefined {
	if (type === "standard") return undefined;
	return type ?? agent;
}

/**
 * Display name for a subagent scope (call rendering + streaming placeholders).
 * Falls back to `label` or "subagent" for the generic case.
 */
export function presetDisplayName(
	type: string | undefined,
	agent: string | undefined,
	label: string | undefined,
): string {
	return presetNameFrom(type, agent) ?? label ?? "subagent";
}

interface RunSingleAgentOptions {
	defaultCwd: string;
	agents: AgentConfig[];
	/** Named agent preset to load; `undefined` runs a generic subagent. */
	agentName: string | undefined;
	task: string;
	cwd: string | undefined;
	step: number | undefined;
	signal: AbortSignal | undefined;
	onUpdate: OnUpdateCallback | undefined;
	makeDetails: (results: SingleResult[]) => SubagentDetails;
	/** Parent-controlled config, already merged item-level > top-level. */
	config: SubagentConfig;
	defaultModel: string | undefined;
	parentSessionFile: string | undefined;
}

async function runSingleAgent(opts: RunSingleAgentOptions): Promise<SingleResult> {
	const {
		defaultCwd,
		agents,
		agentName,
		task,
		cwd,
		step,
		signal,
		onUpdate,
		makeDetails,
		config,
		defaultModel,
		parentSessionFile,
	} = opts;
	const agent = agentName ? agents.find((a) => a.name === agentName) : undefined;

	if (agentName && !agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const displayName = agent ? agent.name : (config.label ?? "subagent");
	const agentSource = agent ? agent.source : "generic";
	const resolvedModel = config.model ?? agent?.model ?? defaultModel;
	const effectiveTools = config.tools ?? agent?.tools;
	const noTools = agent?.noTools ?? false;
	const noContext = agent?.noContext ?? false;
	const replaceSystemPrompt = agent?.replaceSystemPrompt ?? false;

	const args = buildSubagentArgs({
		agentName: displayName,
		task,
		resolvedModel,
		tools: effectiveTools,
		parentSessionFile,
		noSkills: config.noSkills,
		skills: config.skills,
		systemPrompt: config.systemPrompt,
		appendSystemPrompt: config.appendSystemPrompt,
		noTools,
		noContext,
	});

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: displayName,
		agentSource,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: resolvedModel,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent?.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push(replaceSystemPrompt ? "--system-prompt" : "--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.Optional(Type.String({ description: "Named agent preset to invoke; omit for a generic subagent" })),
	type: Type.Optional(
		Type.String({
			description:
				'Subagent type for this task: "standard" (default) for a generic subagent, or a registered agent preset name. Mutually exclusive with `agent`.',
		}),
	),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	model: Type.Optional(Type.String({ description: "Model override for this task (e.g. provider/model-id)" })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist override for this task (--tools)" })),
	systemPrompt: Type.Optional(Type.String({ description: "System prompt override for this task (--system-prompt)" })),
	appendSystemPrompt: Type.Optional(
		Type.Array(Type.String(), {
			description: "Context appended to the system prompt for this task (text or file path)",
		}),
	),
	skills: Type.Optional(Type.Array(Type.String(), { description: "Skill paths to load for this task (--skill)" })),
	noSkills: Type.Optional(Type.Boolean({ description: "Disable skills for this task (--no-skills)" })),
	label: Type.Optional(Type.String({ description: "Short label for a generic subagent (used in session name)" })),
});

const ChainItem = Type.Object({
	agent: Type.Optional(Type.String({ description: "Named agent preset to invoke; omit for a generic subagent" })),
	type: Type.Optional(
		Type.String({
			description:
				'Subagent type for this step: "standard" (default) for a generic subagent, or a registered agent preset name. Mutually exclusive with `agent`.',
		}),
	),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	model: Type.Optional(Type.String({ description: "Model override for this step" })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist override for this step (--tools)" })),
	systemPrompt: Type.Optional(Type.String({ description: "System prompt override for this step (--system-prompt)" })),
	appendSystemPrompt: Type.Optional(
		Type.Array(Type.String(), {
			description: "Context appended to the system prompt for this step (text or file path)",
		}),
	),
	skills: Type.Optional(Type.Array(Type.String(), { description: "Skill paths to load for this step (--skill)" })),
	noSkills: Type.Optional(Type.Boolean({ description: "Disable skills for this step (--no-skills)" })),
	label: Type.Optional(Type.String({ description: "Short label for a generic subagent (used in session name)" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(
		Type.String({ description: "Named agent preset to invoke (single mode); omit for a generic subagent" }),
	),
	type: Type.Optional(
		Type.String({
			description:
				'Subagent type. "standard" (default) runs a generic subagent with no preset. Any other value names a registered agent preset (system prompt + model + tools), equivalent to `agent`. Mutually exclusive with `agent`.',
		}),
	),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	model: Type.Optional(
		Type.String({
			description:
				"Model override (e.g. 'provider/model-id'). Falls back to the call-site, then the agent frontmatter, then settings.json defaultModel, then pi's built-in default.",
		}),
	),
	tools: Type.Optional(
		Type.Array(Type.String(), { description: "Tool allowlist for the child (--tools). Overrides agent tools." }),
	),
	systemPrompt: Type.Optional(Type.String({ description: "Override the child's system prompt (--system-prompt)." })),
	appendSystemPrompt: Type.Optional(
		Type.Array(Type.String(), { description: "Context appended to the child's system prompt (text or file path)." }),
	),
	skills: Type.Optional(Type.Array(Type.String(), { description: "Skill paths to load in the child (--skill)." })),
	noSkills: Type.Optional(
		Type.Boolean({
			description: "Disable skills discovery/loading in the child process (passes --no-skills). Default: false.",
			default: false,
		}),
	),
	label: Type.Optional(
		Type.String({
			description: "Short label for a generic subagent, used in the session name. Default: 'subagent'.",
		}),
	),
});

export default function (pi: ExtensionAPI) {
	// Advertise the parent's configured models in the tool schema so the LLM
	// can set `model` directly instead of checking settings first.
	const enabledModels = readEnabledModelsFromSettings(process.cwd());
	const availableModelsDescription =
		enabledModels.length > 0
			? ` Available models (from settings.json enabledModels): ${enabledModels.join(", ")}. Pass one of these as \`model\` (top-level or per-item) to control which model a subagent uses.`
			: "";

	// Inject the live model list into the `model` parameter descriptions too.
	for (const schema of [SubagentParams, TaskItem, ChainItem]) {
		const modelProp = schema.properties.model as unknown as { description?: string } | undefined;
		if (modelProp && availableModelsDescription) {
			modelProp.description = `${modelProp.description ?? ""}${availableModelsDescription}`.trim();
		}
	}

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			'Delegate tasks to subagents with isolated context. Each subagent is a generic pi process: use `type: "standard"` (the default) for a generic subagent, or `type: "<preset>"` to load a named agent preset (system prompt + model + tools). `agent` is a legacy alias for `type`.',
			"The parent controls the child's skills (`skills`/`noSkills`), context (`systemPrompt`/`appendSystemPrompt`), tools, and model; per-item overrides apply in parallel/chain.",
			"Modes: single (task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			'Named agent presets are discovered from ~/.pi/agent/agents (default scope "user"); set agentScope: "both" (or "project") to include .pi/agents.',
			"Model resolution (highest first): per-item model, call-site `model`, agent frontmatter `model`, then settings.json defaultProvider/defaultModel, then pi's built-in default.",
			availableModelsDescription,
		]
			.filter(Boolean)
			.join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;
			const defaultModelFromSettings = resolveDefaultModelFromSettings(ctx.cwd);
			// Parent session file (undefined when the parent runs with --no-session).
			// Each child session links back to this same parent so /resume groups them.
			const parentSessionFile = ctx.sessionManager.getSessionFile();
			// Top-level parent-controlled config; each item may override these.
			const baseConfig: SubagentConfig = {
				model: params.model,
				tools: params.tools,
				systemPrompt: params.systemPrompt,
				appendSystemPrompt: params.appendSystemPrompt,
				skills: params.skills,
				noSkills: params.noSkills ?? false,
				label: params.label,
			};

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = params.task !== undefined;
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			// `type` and `agent` are alternative ways to name a preset; reject calls that set both.
			const typeAgentError = validateTypeAgentExclusivity(params);
			if (typeAgentError) {
				return {
					content: [{ type: "text", text: typeAgentError }],
					details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
					isError: true,
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain)
					for (const step of params.chain) {
						const n = presetNameFrom(step.type, step.agent);
						if (n) requestedAgentNames.add(n);
					}
				if (params.tasks)
					for (const t of params.tasks) {
						const n = presetNameFrom(t.type, t.agent);
						if (n) requestedAgentNames.add(n);
					}
				const topLevelPreset = presetNameFrom(params.type, params.agent);
				if (topLevelPreset) requestedAgentNames.add(topLevelPreset);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent({
						defaultCwd: ctx.cwd,
						agents,
						agentName: presetNameFrom(step.type, step.agent),
						task: taskWithContext,
						cwd: step.cwd,
						step: i + 1,
						signal,
						onUpdate: chainUpdate,
						makeDetails: makeDetails("chain"),
						config: mergeSubagentConfig(baseConfig, step),
						defaultModel: defaultModelFromSettings,
						parentSessionFile,
					});
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${result.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: presetDisplayName(params.tasks[i].type, params.tasks[i].agent, params.tasks[i].label),
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent({
						defaultCwd: ctx.cwd,
						agents,
						agentName: presetNameFrom(t.type, t.agent),
						task: t.task,
						cwd: t.cwd,
						step: undefined,
						signal,
						// Per-task update callback
						onUpdate: (partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails: makeDetails("parallel"),
						config: mergeSubagentConfig(baseConfig, t),
						defaultModel: defaultModelFromSettings,
						parentSessionFile,
					});
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.task !== undefined) {
				const result = await runSingleAgent({
					defaultCwd: ctx.cwd,
					agents,
					agentName: presetNameFrom(params.type, params.agent),
					task: params.task,
					cwd: params.cwd,
					step: undefined,
					signal,
					onUpdate,
					makeDetails: makeDetails("single"),
					config: baseConfig,
					defaultModel: defaultModelFromSettings,
					parentSessionFile,
				});
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", presetDisplayName(step.type, step.agent, step.label)) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", presetDisplayName(t.type, t.agent, t.label))}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = presetDisplayName(args.type, args.agent, args.label);
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
