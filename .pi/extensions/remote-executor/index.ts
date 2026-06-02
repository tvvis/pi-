import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { ansibleExec, ansibleUpload, type ExecResult } from "./ansible.ts";
import { highlightLine } from "./highlight.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AssertionResult {
  line: number;
  command: string;
  passed: boolean;
  stdout?: string;
  stderr?: string;
}

interface RunScriptDetails {
  mode: "script" | "command";
  source: string;       // script path or "inline"
  host: string;
  remotePath: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  assertions: AssertionResult[];
  allAssertionsPassed: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause =
    err instanceof Error && err.cause
      ? ` (cause: ${err.cause instanceof Error ? err.cause.message : String(err.cause)})`
      : "";
  return `${message}${cause}`;
}

function parseAssertions(
  content: string,
): Array<{ line: number; command: string }> {
  const out: Array<{ line: number; command: string }> = [];
  for (const [i, line] of content.split("\n").entries()) {
    const m = line.match(/^\s*#\s*@assert:\s*(.+)/);
    if (m) out.push({ line: i + 1, command: m[1].trim() });
  }
  return out;
}

async function runRemoteScript(
  host: string,
  scriptContent: string,
  scriptPath: string,
  remotePath: string,
  signal?: AbortSignal,
): Promise<{ output: string; details: RunScriptDetails }> {
  const parsed = parseAssertions(scriptContent);

  try {
    await ansibleUpload(host, scriptPath, remotePath, signal);
  } catch (err) {
    throw new Error(`Upload failed: ${formatError(err)}`);
  }

  let result: ExecResult;
  try {
    result = await ansibleExec(host, `bash ${remotePath}`, signal);
  } catch (err) {
    throw new Error(`Remote execution failed: ${formatError(err)}`);
  }

  const { assertions, allAssertionsPassed } = await runAssertions(
    host,
    parsed,
    signal,
  );

  const output = buildOutput(
    `Script: ${scriptPath}`,
    remotePath,
    result,
    assertions,
    allAssertionsPassed,
  );

  const details: RunScriptDetails = {
    mode: "script",
    source: scriptPath,
    host,
    remotePath,
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    assertions,
    allAssertionsPassed,
  };

  if (!allAssertionsPassed || (!!result.stderr && assertions.length === 0)) {
    throw Object.assign(new Error(output), { runScriptDetails: details });
  }

  return { output, details };
}

async function runRemoteCommand(
  host: string,
  command: string,
  signal?: AbortSignal,
): Promise<{ output: string; details: RunScriptDetails }> {
  const parsed = parseAssertions(command);

  // Strip assertion lines from the command body before execution
  const bodyLines = command
    .split("\n")
    .filter((line) => !line.match(/^\s*#\s*@assert:/));
  const body = bodyLines.join("\n").trim();

  let result: ExecResult;
  try {
    result = await ansibleExec(host, body, signal);
  } catch (err) {
    throw new Error(`Remote execution failed: ${formatError(err)}`);
  }

  const { assertions, allAssertionsPassed } = await runAssertions(
    host,
    parsed,
    signal,
  );

  const remotePath = `(inline command)`;
  const output = buildOutput("Command", remotePath, result, assertions, allAssertionsPassed);

  const details: RunScriptDetails = {
    mode: "command",
    source: "inline",
    host,
    remotePath,
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    assertions,
    allAssertionsPassed,
  };

  if (!allAssertionsPassed || (!!result.stderr && assertions.length === 0)) {
    throw Object.assign(new Error(output), { runScriptDetails: details });
  }

  return { output, details };
}

async function runAssertions(
  host: string,
  parsed: Array<{ line: number; command: string }>,
  signal?: AbortSignal,
): Promise<{ assertions: AssertionResult[]; allAssertionsPassed: boolean }> {
  const assertions: AssertionResult[] = [];
  let allAssertionsPassed = true;
  for (const a of parsed) {
    try {
      const ar = await ansibleExec(host, a.command, signal);
      const passed = ar.status === 0;
      if (!passed) allAssertionsPassed = false;
      assertions.push({
        line: a.line,
        command: a.command,
        passed,
        stdout: ar.stdout || undefined,
        stderr: ar.stderr || undefined,
      });
    } catch (err) {
      allAssertionsPassed = false;
      assertions.push({
        line: a.line,
        command: a.command,
        passed: false,
        stderr: formatError(err),
      });
    }
  }
  return { assertions, allAssertionsPassed };
}

function buildOutput(
  label: string,
  remotePath: string,
  result: ExecResult,
  assertions: AssertionResult[],
  allAssertionsPassed: boolean,
): string {
  const out: string[] = [];
  out.push(`--- ${label} ---`);
  out.push(`Remote: ${remotePath}`);
  out.push(`Exit code: ${result.status}`);

  if (result.stdout) {
    out.push(`\n[stdout]`);
    out.push(result.stdout.trimEnd());
  } else {
    out.push(`[stdout] (none)`);
  }
  if (result.stderr) {
    out.push(`\n[stderr]`);
    out.push(result.stderr.trimEnd());
  } else {
    out.push(`[stderr] (none)`);
  }

  if (assertions.length > 0) {
    out.push(`\n--- Assertions (${assertions.length}) ---`);
    for (const a of assertions) {
      out.push(
        `\n[${a.passed ? "PASS" : "FAIL"}] Line ${a.line}: ${a.command}`,
      );
      if (a.stdout) out.push(`  stdout: ${a.stdout.trimEnd()}`);
      if (a.stderr) out.push(`  stderr: ${a.stderr.trimEnd()}`);
    }
    out.push(
      `\n\nAssertion summary: ${
        allAssertionsPassed ? "ALL PASSED" : "FAILURES DETECTED"
      }`,
    );
  }

  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "run_script",
    label: "Run Script",
    description:
      "Execute a bash script or inline command on a remote Ansible host and run # @assert: assertions. Use path for existing script files (uploads and executes remotely), or command for inline commands (executes directly, no upload).",
    promptSnippet:
      "Upload and execute a bash script or inline command on a remote Ansible host with assertion-based validation",
    promptGuidelines: [
      "For the full workflow, host selection rules, and assertion patterns, load the `script-validator` skill.",
    ],
    renderShell: "self",
    parameters: Type.Object({
      host: Type.String({
        description: "Ansible agent host",
      }),
      path: Type.Optional(
        Type.String({
          description:
            "Path to an existing bash script file to upload and execute (relative to working directory)",
        }),
      ),
      command: Type.Optional(
        Type.String({
          description:
            "Inline command(s) to execute on the remote server. Supports multiline and # @assert: lines. Use for one-off commands without creating a file.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!params.path && !params.command) {
        throw new Error("Either path or command must be provided.");
      }
      if (params.path && params.command) {
        throw new Error("Provide path or command, not both.");
      }

      const host = params.host;

      if (params.command !== undefined) {
        const { output, details } = await runRemoteCommand(
          host,
          params.command,
          signal,
        );
        return {
          content: [{ type: "text", text: output }],
          details,
        };
      }

      const scriptPath = resolve(ctx.cwd, params.path!);
      const scriptName = basename(scriptPath);
      const remotePath = `/opt/qihoo/ansible-agent/${scriptName}`;

      let scriptContent: string;
      try {
        scriptContent = await readFile(scriptPath, "utf-8");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to read script: ${message}`);
      }

      const { output, details } = await runRemoteScript(
        host,
        scriptContent,
        scriptPath,
        remotePath,
        signal,
      );

      return {
        content: [{ type: "text", text: output }],
        details,
      };
    },

    // ── TUI rendering ──────────────────────────────────────────────

    renderCall(args, theme, _context) {
      const host = String(args.host ?? "");
      let label: string;
      if (args.path) {
        label = basename(String(args.path));
      } else if (args.command) {
        const firstLine = String(args.command).split("\n")[0].trim();
        const MAX = 80;
        label = firstLine.length > MAX
          ? `${firstLine.slice(0, MAX - 1)}…`
          : firstLine || "(command)";
      } else {
        label = "inline";
      }
      const text =
        theme.fg("toolTitle", theme.bold("run_script")) +
        " → " +
        theme.fg("accent", host) +
        "  " +
        theme.fg("muted", label);
      return new Text(text, 1, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as RunScriptDetails | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }

      const lines: string[] = [];

      // --- Header: exit code -------------------------------------------------
      const exitLabel =
        details.exitCode === 0
          ? theme.fg("dim", `exit: ${details.exitCode}`)
          : theme.fg("error", `exit: ${details.exitCode}`);
      const header = `${exitLabel}  ${theme.fg("dim", details.remotePath)}`;
      lines.push(header);

      // --- Full output --------------------------------------------------------

      // stdout — keyword highlight
      lines.push("");
      if (details.stdout) {
        lines.push(theme.fg("dim", "stdout"));
        for (const line of details.stdout.trimEnd().split("\n")) {
          lines.push(`  ${highlightLine(line, theme)}`);
        }
      } else {
        lines.push(theme.fg("dim", "stdout (none)"));
      }

      // stderr — keyword highlight
      if (details.stderr) {
        lines.push("");
        lines.push(theme.fg("warning", "stderr"));
        for (const line of details.stderr.trimEnd().split("\n")) {
          lines.push(`  ${highlightLine(line, theme)}`);
        }
      }

      // assertions
      if (details.assertions.length > 0) {
        lines.push("");
        const passed = details.assertions.filter((a) => a.passed).length;
        const total = details.assertions.length;
        const allPassed = passed === total;
        const summary = allPassed
          ? theme.fg("success", `✓ assertions: ${passed}/${total}`)
          : theme.fg("error", `✗ assertions: ${passed}/${total}`);
        lines.push(summary);

        for (const a of details.assertions) {
          const mark = a.passed
            ? theme.fg("success", "PASS")
            : theme.fg("error", "FAIL");
          lines.push(
            `  ${mark}  ${theme.fg("dim", `L${a.line}:`)} ${a.command}`,
          );
          if (a.stdout) {
            for (const line of a.stdout.trimEnd().split("\n")) {
              lines.push(`        ${highlightLine(line, theme)}`);
            }
          }
          if (a.stderr) {
            for (const line of a.stderr.trimEnd().split("\n")) {
              lines.push(`        ${highlightLine(line, theme)}`);
            }
          }
        }
      }

      return new Text(lines.join("\n"), 1, 0);
    },
  });
}
