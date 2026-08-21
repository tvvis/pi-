import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import {
  ansibleCleanupJob,
  ansibleExec,
  ansibleExecDetached,
  ansibleUpload,
  ansibleUploadBlob,
  detachedJobPaths,
  type ExecResult,
} from "./ansible.ts";
import { highlightLine, highlightShell } from "./highlight.ts";

// ---------------------------------------------------------------------------
// MD5 helpers - used by file_upload to verify integrity end-to-end so the
// agent never has to run a separate md5sum on either side.
// ---------------------------------------------------------------------------

function md5File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("md5");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => {
      hash.update(chunk);
    });
    stream.on("end", () => {
      resolve(hash.digest("hex"));
    });
  });
}

interface RemoteMd5Result {
  hash: string;
  raw: string;
}

async function getRemoteMd5(
  host: string,
  remotePath: string,
  signal?: AbortSignal,
): Promise<RemoteMd5Result> {
  const result = await ansibleExec(host, `md5sum ${remotePath}`, signal);
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    const detail = stderr || stdout || "(no output)";
    throw new Error(`md5sum exited with status ${result.status}: ${detail}`);
  }
  const match = result.stdout.match(/^([a-fA-F0-9]{32})\s+/m);
  if (!match) {
    throw new Error(
      `Could not parse md5sum output on remote: ${result.stdout.trim() || "(empty)"}`,
    );
  }
  return { hash: match[1].toLowerCase(), raw: result.stdout.trim() };
}

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
  exitCode: number | null;   // null when the script did not finish (timeout/aborted)
  stdout: string;
  stderr: string;
  assertions: AssertionResult[];
  allAssertionsPassed: boolean;
  status: "completed" | "timeout" | "aborted";
  remotePid?: string;
  logPaths?: { out: string; err: string; exit: string; pid: string };
}

/** Default wall-clock budget (seconds) for a run_script call when `timeout` is omitted. */
const DEFAULT_TIMEOUT_SEC = 600;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toolDivider(theme: Theme): Component {
  return {
    render(width: number): string[] {
      return [theme.fg("borderMuted", "─".repeat(Math.max(0, width)))];
    },
    invalidate(): void {},
  };
}

function withTopDivider(content: Component, theme: Theme): Component {
  const container = new Container();
  container.addChild(toolDivider(theme));
  container.addChild(content);
  return container;
}

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

async function runDetached(
  host: string,
  scriptContent: string,
  source: string,
  mode: "script" | "command",
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ output: string; details: RunScriptDetails }> {
  const parsed = parseAssertions(scriptContent);

  // Command mode: strip assertion lines before execution. Script mode runs
  // the file as-is (assertions are parsed separately, never passed to bash).
  const body =
    mode === "command"
      ? scriptContent
          .split("\n")
          .filter((line) => !line.match(/^\s*#\s*@assert:/))
          .join("\n")
      : scriptContent;

  const jobId = `rs_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
  const paths = detachedJobPaths(jobId);

  try {
    await ansibleUploadBlob(host, new Blob([body]), `${jobId}.sh`, paths.script, signal);
  } catch (err) {
    throw new Error(`Upload failed: ${formatError(err)}`);
  }

  const outcome = await ansibleExecDetached(host, paths, { timeoutMs, signal });

  // Assertions check stable post-run state, so only run them once the script
  // has actually finished. While still running (timeout/aborted) there is
  // nothing meaningful to assert.
  let assertions: AssertionResult[] = [];
  let allAssertionsPassed = true;
  if (outcome.status === "completed") {
    ({ assertions, allAssertionsPassed } = await runAssertions(host, parsed, signal));
  }

  const details: RunScriptDetails = {
    mode,
    source,
    host,
    remotePath: paths.script,
    exitCode: outcome.status === "completed" ? outcome.exitCode : null,
    stdout: outcome.status === "completed" ? outcome.stdout : outcome.partialStdout,
    stderr: outcome.status === "completed" ? outcome.stderr : outcome.partialStderr,
    assertions,
    allAssertionsPassed,
    status: outcome.status,
    remotePid: outcome.status === "completed" ? undefined : outcome.pid,
    logPaths: { out: paths.out, err: paths.err, exit: paths.exit, pid: paths.pid },
  };

  if (outcome.status === "completed") {
    await ansibleCleanupJob(host, paths, signal);
    const output = buildOutput(
      mode === "script" ? `Script: ${source}` : "Command",
      paths.script,
      { status: outcome.exitCode, stdout: outcome.stdout, stderr: outcome.stderr },
      assertions,
      allAssertionsPassed,
    );
    if (!allAssertionsPassed || (!!outcome.stderr && assertions.length === 0)) {
      throw Object.assign(new Error(output), { toolResultDetails: details });
    }
    return { output, details };
  }

  // timeout or aborted: keep artifact files so the caller can re-poll/kill.
  // Report as an error (isError) but with structured details so callers can
  // distinguish "still running" from a real script failure.
  const output = buildTimeoutOutput(details, timeoutMs);
  throw Object.assign(new Error(output), { toolResultDetails: details });
}

function buildTimeoutOutput(details: RunScriptDetails, timeoutMs: number): string {
  const label = details.mode === "script" ? `Script: ${details.source}` : "Command";
  const kind = details.status === "timeout" ? "TIMEOUT" : "ABORTED";
  const out: string[] = [];
  out.push(`--- ${label} --- (${kind})`);
  out.push(`Remote: ${details.remotePath}`);
  if (details.status === "timeout") {
    out.push(
      `Status: script still running on remote after ${Math.round(timeoutMs / 1000)}s (timeout reached).`,
    );
  } else {
    out.push(`Status: agent aborted; script still running on remote.`);
  }
  if (details.remotePid) {
    out.push(
      `PID: ${details.remotePid}  (stop: kill ${details.remotePid}, force: kill -9 ${details.remotePid})`,
    );
  }
  if (details.logPaths) {
    out.push(
      `Logs: out=${details.logPaths.out} err=${details.logPaths.err} exit=${details.logPaths.exit}`,
    );
    out.push(
      `Re-check when finished: run_script command -> "cat '${details.logPaths.exit}'; echo ---OUT---; cat '${details.logPaths.out}'; echo ---ERR---; cat '${details.logPaths.err}'"`,
    );
  }
  out.push(`Assertions: skipped (script did not finish).`);

  out.push(`\n[partial stdout]`);
  out.push(details.stdout.trimEnd() || "(none)");
  out.push(`\n[partial stderr]`);
  out.push(details.stderr.trimEnd() || "(none)");

  out.push(
    `\nNOTE: This is a ${kind}, not a script failure. The script is still running on the remote. Do not assume it succeeded or failed.`,
  );
  return out.join("\n");
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
      "Execute a bash script or inline command on a remote host and run # @assert: assertions. This is the ONLY supported way to run anything on remote hosts: the tool talks directly to the host's remote-execution agent over its management port, so SSH must never be used (no `ssh` from bash; use file_upload to copy files instead of `scp`). Use path for existing script files (uploads and executes remotely), or command for inline commands (executes directly, no upload). Scripts run detached on the remote: a long script is polled to completion and never killed by the HTTP layer; the optional timeout (default 600s) bounds the whole call and, if exceeded, reports the still-running PID and log paths instead of a false failure.",
    promptSnippet:
      "Run bash on a remote host with assertion-based validation - the only remote-execution channel; never use SSH",
    promptGuidelines: [
      "run_script is the ONLY mechanism for remote execution. Never use `ssh`, `scp`, or any local bash command to run or copy things on remote hosts: every remote command goes through run_script, every file transfer through file_upload.",
      "Use `path` for any multi-step work: write the script to a local file first, then call run_script with path. Do not embed scripts in inline commands via heredoc (`cat > x.sh <<EOF` / `tee` / `base64 -d | bash`) - the upload path is the only supported way to run a non-trivial script.",
      "Use `command` only for short, throwaway shell snippets and one-shot `# @assert:` checks. For multi-step procedures, make multiple `command` calls (or switch to `path`).",
      "Pass `timeout` (seconds) for long-running scripts. The default is 600s; the script runs detached so a timeout does NOT kill it - the result reports the still-running PID and log paths. Re-check later with a `command` call that cats the exit/log files; do not assume a timeout means success or failure.",
    ],
    renderShell: "self",
    parameters: Type.Object({
      host: Type.String({
        description:
          "Remote host to execute on. Bare hostname or IP only; the tool connects to the host's remote-execution agent directly, so do not include user@, ports, or ssh options.",
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
      timeout: Type.Optional(
        Type.Number({
          description:
            "Overall timeout in seconds for the whole call (upload + run + assertions). Default 600. 0 = no timeout (poll until the agent aborts). The script runs detached; on timeout it keeps running and the result reports the still-running PID and log paths instead of failing.",
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
      const timeoutSec =
        typeof params.timeout === "number" && params.timeout >= 0
          ? params.timeout
          : DEFAULT_TIMEOUT_SEC;
      const timeoutMs = timeoutSec === 0 ? 0 : timeoutSec * 1000;

      if (params.command !== undefined) {
        const { output, details } = await runDetached(
          host,
          params.command,
          "inline",
          "command",
          timeoutMs,
          signal,
        );
        return {
          content: [{ type: "text", text: output }],
          details,
        };
      }

      const scriptPath = resolve(ctx.cwd, params.path!);

      let scriptContent: string;
      try {
        scriptContent = await readFile(scriptPath, "utf-8");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to read script: ${message}`);
      }

      const { output, details } = await runDetached(
        host,
        scriptContent,
        scriptPath,
        "script",
        timeoutMs,
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
      const timeoutSuffix =
        typeof args.timeout === "number"
          ? " " + theme.fg("dim", `(timeout ${args.timeout}s)`)
          : "";
      const headerPrefix =
        theme.fg("toolTitle", theme.bold("run_script")) +
        theme.fg("dim", " → ") +
        theme.fg("accent", host) +
        timeoutSuffix;

      // Path-based script: show basename
      if (args.path) {
        const label = basename(String(args.path));
        return withTopDivider(
          new Text(headerPrefix + "  " + theme.fg("text", label), 1, 0),
          theme,
        );
      }

      // Inline command
      if (args.command !== undefined) {
        const raw = String(args.command);
        const lines = raw.split("\n");
        // Strip trailing blank lines so "cmd\n" stays single-line
        while (lines.length > 1 && lines[lines.length - 1].trim() === "") {
          lines.pop();
        }

        if (lines.length <= 1) {
          // Single-line: compact display
          const single = lines[0] ?? "";
          const display = single
            ? highlightShell(single, theme)
            : "(empty)";
          return withTopDivider(
            new Text(
              headerPrefix + "  " + theme.fg("text", "$ ") + display,
              1,
              0,
            ),
            theme,
          );
        }

        // Multi-line: boxed code block
        const out: string[] = [];
        out.push(headerPrefix + theme.fg("dim", `  (${lines.length} lines)`));
        for (const line of lines) {
          out.push(
            "  " +
              theme.fg("dim", "│") +
              " " +
              (line ? highlightShell(line, theme) : ""),
          );
        }
        return withTopDivider(new Text(out.join("\n"), 1, 0), theme);
      }

      return withTopDivider(
        new Text(headerPrefix + "  " + theme.fg("text", "inline"), 1, 0),
        theme,
      );
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as RunScriptDetails | undefined;

      // Empty/absent details => a hard error thrown without structured
      // details (upload/launch/read failure). Surface the error message.
      if (!details || Object.keys(details).length === 0) {
        const text = result.content[0];
        const raw = text?.type === "text" ? text.text : "";
        return new Text(theme.fg("error", raw || "Result: FAILED"), 0, 0);
      }

      const lines: string[] = [];

      // --- Timeout / aborted: script still running on the remote -----------
      if (details.status === "timeout" || details.status === "aborted") {
        const tag = details.status === "timeout" ? "TIMEOUT" : "ABORTED";
        lines.push(theme.fg("warning", `${tag}: script still running on remote`));
        if (details.remotePid) {
          lines.push(theme.fg("dim", `pid: ${details.remotePid}`));
        }
        if (details.logPaths) {
          lines.push(theme.fg("dim", `logs: ${details.logPaths.out}`));
        }
        if (details.stdout) {
          lines.push(theme.fg("dim", "partial stdout"));
          for (const line of details.stdout.trimEnd().split("\n")) {
            lines.push(`  ${highlightLine(line, theme)}`);
          }
        }
        if (details.stderr) {
          lines.push(theme.fg("warning", "partial stderr"));
          for (const line of details.stderr.trimEnd().split("\n")) {
            lines.push(`  ${highlightLine(line, theme)}`);
          }
        }
        return new Text(lines.join("\n"), 1, 0);
      }

      // --- Completed: header with exit code ---------------------------------
      const exit = details.exitCode ?? -1;
      const exitLabel =
        exit === 0
          ? theme.fg("dim", `exit: ${exit}`)
          : theme.fg("error", `exit: ${exit}`);
      const header = `${exitLabel}  ${theme.fg("dim", details.remotePath)}`;
      lines.push(header);

      // --- Full output --------------------------------------------------------

      // stdout - keyword highlight
      lines.push("");
      if (details.stdout) {
        lines.push(theme.fg("dim", "stdout"));
        for (const line of details.stdout.trimEnd().split("\n")) {
          lines.push(`  ${highlightLine(line, theme)}`);
        }
      } else {
        lines.push(theme.fg("dim", "stdout (none)"));
      }

      // stderr - keyword highlight
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

  // -------------------------------------------------------------------------
  // file_upload - uploads a NON-EXECUTABLE file from local cwd to a remote
  // Ansible host. Strictly separated from run_script so scripts always go
  // through the upload-and-execute path with assertion-based validation.
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: "file_upload",
    label: "File Upload",
    description:
      "Upload a single file to a remote host. Supports any file type: configs, data, certificates, scripts, static assets, templates, log archives, etc. Specify an explicit absolute remotePath.",
    promptSnippet:
      "Upload a single file to a remote host",
    promptGuidelines: [
      "file_upload is the only way to copy files to remote hosts. Never use `scp`, `ssh`, or local bash to transfer files to remote machines.",
      "Specify an explicit absolute remotePath. file_upload does not auto-pick a destination directory.",
      "For multi-step remote work that needs both data and scripts, upload files with file_upload, then use run_script to upload and execute scripts. Never embed large blobs in inline run_script commands.",
    ],
    renderShell: "self",
    parameters: Type.Object({
      host: Type.String({
        description: "Remote host",
      }),
      path: Type.String({
        description:
          "Path to the local file to upload (relative to the working directory).",
      }),
      remotePath: Type.String({
        description:
          "Absolute destination path on the remote host, e.g. /etc/nginx/nginx.conf",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const host = params.host;
      const localPath = resolve(ctx.cwd, params.path);
      const remotePath = params.remotePath;

      if (!remotePath.startsWith("/")) {
        throw new Error(
          `remotePath must be an absolute path on the remote host, got: ${remotePath}`,
        );
      }

      // --- Defensive non-executable check (prompt is the primary control) ---
      let fileStat;
      try {
        fileStat = await stat(localPath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to stat source file: ${message}`);
      }
      if (!fileStat.isFile()) {
        throw new Error(`Source is not a regular file: ${localPath}`);
      }

      // Script/Makefile/shebang upload restrictions removed - file_upload
      // now accepts any file type.

      // --- Upload (explicit if-else: throw on failure, run MD5 only on success) ---
      let uploadError: string | null = null;
      try {
        await ansibleUpload(host, localPath, remotePath, signal);
      } catch (err) {
        uploadError = err instanceof Error ? err.message : String(err);
      }

      if (uploadError) {
        throw new Error(`Upload failed: ${uploadError}`);
      }

      // --- MD5 verification (gated: only reached when upload succeeded) ---
      let localMd5: string;
      try {
        localMd5 = await md5File(localPath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`MD5 verification failed (local): ${message}`);
      }

      let remoteMd5 = "";
      let remoteMd5Error: string | undefined;
      try {
        const r = await getRemoteMd5(host, remotePath, signal);
        remoteMd5 = r.hash;
      } catch (err) {
        remoteMd5Error =
          err instanceof Error ? err.message : String(err);
      }

      const md5Verified = remoteMd5 !== "" && localMd5 === remoteMd5;
      const md5verifiedLine = remoteMd5Error
        ? `MD5 verified: ERROR   (${remoteMd5Error})`
        : md5Verified
          ? `MD5 verified: SUCCESS`
          : `MD5 verified: ERROR   local=${localMd5} remote=${remoteMd5}`;

      // MD5 mismatch / md5sum failure: drop Size, the actionable signal is
      // the mismatch reason and the FAILED result.
      const output = md5Verified
        ? [
            `Size:    ${fileStat.size} bytes`,
            md5verifiedLine,
            `Result:  SUCCESS`,
          ].join("\n")
        : [md5verifiedLine, `Result:  FAILED`].join("\n");

      return {
        content: [{ type: "text", text: output }],
        details: {
          host,
          localPath,
          remotePath,
          size: fileStat.size,
          md5: localMd5,
          md5Verified,
          remoteMd5: remoteMd5 || undefined,
          remoteMd5Error,
        },
      };
    },

    renderCall(args, theme, context) {
      const host = String(args.host ?? "");
      // Resolve the local path against the working directory so the call
      // line shows the full absolute path that execute() will actually
      // upload, not the user-supplied (possibly relative) argument.
      const localPath = resolve(context.cwd, String(args.path ?? ""));
      const remotePath = String(args.remotePath ?? "");
      // Fixed color map: host accent, labels dim, paths plain. Local/Remote
      // labels live next to their paths so the call line is self-describing.
      const text =
        theme.fg("toolTitle", theme.bold("file_upload")) +
        theme.fg("dim", " → ") +
        theme.fg("accent", host) +
        " " +
        theme.fg("dim", "Local:") +
        " " +
        theme.fg("text", localPath) +
        theme.fg("dim", " → ") +
        theme.fg("dim", "Remote:") +
        " " +
        theme.fg("text", remotePath);
      return withTopDivider(new Text(text, 1, 0), theme);
    },

    renderResult(result, _options, theme) {
      const details = result.details as
        | {
            host: string;
            localPath: string;
            remotePath: string;
            size: number;
            md5: string;
            md5Verified: boolean;
            remoteMd5?: string;
            remoteMd5Error?: string;
          }
        | undefined;

      if (!details || !details.host) {
        // Error path: execute() threw. The framework wraps the thrown
        // error into a result with `details: {}` (not undefined) - see
        // packages/agent/src/agent-loop.ts `createErrorToolResult`. We
        // must also treat that empty-object case as a failure, otherwise
        // the MD5 mismatch branch would read `details.md5` / `details
        // .remoteMd5` as undefined and render "local=undefined remote=?".
        const text = result.content[0];
        const raw = text?.type === "text" ? text.text.trim() : "";
        const inline = raw
          ? `${theme.fg("error", "Result: FAILED")}  ${theme.fg("error", raw)}`
          : `${theme.fg("error", "Result: FAILED")}`;
        return new Text(inline, 0, 0);
      }

      // MD5 mismatch / md5sum failure: upload reached the remote but the
      // bytes are not trustworthy. Collapse to the failure reason and a
      // red Result: FAILED - drop Size, it is not the actionable signal.
      if (!details.md5Verified) {
        const verifiedLabel = details.remoteMd5Error
          ? `ERROR   (${details.remoteMd5Error})`
          : `ERROR   local=${details.md5} remote=${details.remoteMd5 ?? "?"}`;
        const lines = [
          `${theme.fg("dim", "MD5 verified:")} ${theme.fg("error", verifiedLabel)}`,
          `${theme.fg("dim", "Result:")}  ${theme.fg("error", "FAILED")}`,
        ];
        return new Text(lines.join("\n"), 0, 0);
      }

      // All good: upload succeeded, MD5 matches.
      const lines: string[] = [
        `${theme.fg("dim", "Size:")}    ${details.size} bytes`,
        `${theme.fg("dim", "MD5 verified:")} ${theme.fg("success", "SUCCESS")}`,
        `${theme.fg("dim", "Result:")}  ${theme.fg("success", "SUCCESS")}`,
      ];

      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
