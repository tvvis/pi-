import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { ansibleExec, ansibleUpload, type ExecResult } from "./ansible.ts";
import { highlightLine } from "./highlight.ts";

// ---------------------------------------------------------------------------
// MD5 helpers — used by file_upload to verify integrity end-to-end so the
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
      "Use `path` for any multi-step work: write the script to a local file first, then call run_script with path. Do not embed scripts in inline commands via heredoc (`cat > x.sh <<EOF` / `tee` / `base64 -d | bash`) — the upload path is the only supported way to run a non-trivial script.",
      "Use `command` only for short, throwaway shell snippets and one-shot `# @assert:` checks. For multi-step procedures, make multiple `command` calls (or switch to `path`).",
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
        theme.fg("text", label);
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

  // -------------------------------------------------------------------------
  // file_upload — uploads a NON-EXECUTABLE file from local cwd to a remote
  // Ansible host. Strictly separated from run_script so scripts always go
  // through the upload-and-execute path with assertion-based validation.
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: "file_upload",
    label: "File Upload",
    description:
      "Upload a single file (configs, data, certificates, scripts, static assets, etc.) from the local working directory to a remote Ansible host and automatically verify its integrity by computing the local MD5 and running `md5sum` on the remote host. The remote file is written as-is and is NOT executed.",
    promptSnippet:
      "Upload a single file to a remote Ansible host and verify its MD5",
    promptGuidelines: [
      "Use file_upload to upload any file type: configs, data files, certificates, scripts, static assets, templates, log archives, etc.",
      "file_upload automatically computes the local MD5 and runs `md5sum` on the remote host to verify integrity end-to-end. The result line `MD5 verified: SUCCESS` or `MD5 verified: ERROR` is the source of truth — do NOT run a separate md5sum via run_script or local bash after upload; the verification is already part of file_upload.",
      "Specify an explicit absolute remotePath. file_upload does not auto-pick a destination directory the way run_script does.",
      "For multi-step remote work that needs both data and scripts, upload files with file_upload, then use run_script to upload and execute scripts. Never embed large blobs in inline run_script commands.",
    ],
    renderShell: "self",
    parameters: Type.Object({
      host: Type.String({
        description: "Ansible agent host",
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

      // Script/Makefile/shebang upload restrictions removed — file_upload
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
      return new Text(text, 1, 0);
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
        // error into a result with `details: {}` (not undefined) — see
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
      // red Result: FAILED — drop Size, it is not the actionable signal.
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
