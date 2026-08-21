import { readFile } from "node:fs/promises";
import { basename } from "node:path";

export interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

export async function ansibleExec(
  host: string,
  command: string,
  signal?: AbortSignal,
): Promise<ExecResult> {
  const url = `http://${host}:6677/ansible/agent/exec`;
  const body = new URLSearchParams({
    command,
    executable: "/bin/sh",
    become: "0",
    becomeMethod: "sudo",
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal,
  });

  if (!res.ok) {
    const text = (await res.text()).trim();
    throw new Error(
      text ? `ansible-exec HTTP ${res.status}: ${text}` : `ansible-exec HTTP ${res.status}`,
    );
  }

  const json = (await res.json()) as Record<string, unknown>;
  return {
    status: Number(json.status ?? -1),
    stdout: String(json.stdout ?? ""),
    stderr: String(json.stderr ?? ""),
  };
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Upload an arbitrary Blob to a remote path. Used by both file_upload (which
 * reads a local file into a Blob) and run_script (which uploads script
 * content it already holds in memory, so script and command modes share one
 * upload path).
 */
export async function ansibleUploadBlob(
  host: string,
  blob: Blob,
  filename: string,
  remotePath: string,
  signal?: AbortSignal,
): Promise<void> {
  const url = `http://${host}:6677/ansible/agent/upload`;
  const form = new FormData();
  form.set("dest", remotePath);
  form.set("src", blob, filename);

  const res = await fetch(url, {
    method: "PUT",
    body: form,
    signal,
  });

  const text = (await res.text()).trim();
  if (!res.ok || !text.includes("SUCCESS")) {
    throw new Error(
      text ? `ansible-upload HTTP ${res.status}: ${text}` : `ansible-upload HTTP ${res.status}`,
    );
  }
}

export async function ansibleUpload(
  host: string,
  localPath: string,
  remotePath: string,
  signal?: AbortSignal,
): Promise<void> {
  const file = await readFile(localPath);
  await ansibleUploadBlob(host, new Blob([file]), basename(localPath), remotePath, signal);
}

// ---------------------------------------------------------------------------
// Detached execution
//
// run_script used to execute `bash <script>` as a single blocking HTTP request
// to /ansible/agent/exec. The remote endpoint only returns once the script
// exits, so a long script produced no HTTP traffic for minutes. pi's global
// undici dispatcher (DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300s) then aborted the
// fetch with a Headers/BodyTimeoutError long before the script finished. The
// client saw a failure, the # @assert: report was never collected, and the
// remote `bash` kept running as an orphan because closing the socket does not
// kill the spawned process.
//
// The detached model fixes all three problems:
//   - Launch the script via `setsid ... &` so it runs in its own session,
//     fully decoupled from the exec request. The launch request returns
//     immediately; the script survives the HTTP connection closing.
//   - Poll completion with a tiny `test -f <exitfile>` request every few
//     seconds. Every single fetch is sub-second, so the global HTTP idle
//     timeout never fires. The overall wall-clock budget is enforced here in
//     JS by the poll loop, not by any single fetch. This is runtime-agnostic
//     (works under both Node's undici fetch and Bun's native fetch).
//   - stdout/stderr/exit code are written to files on the remote, so the
//     result is always recoverable even if the poll loop gives up (timeout)
//     or the agent aborts. The caller gets the remote PID + log paths and can
//     re-check or kill later.
// ---------------------------------------------------------------------------

/** Remote artifact files for one detached job, all derived from `jobId`. */
export interface DetachedJobPaths {
  /** The uploaded script. */
  script: string;
  /** Script stdout capture. */
  out: string;
  /** Script stderr capture. */
  err: string;
  /** Exit-code marker file (presence == done). */
  exit: string;
  /** PID of the detached process. */
  pid: string;
}

/** Where detached job artifacts live on the remote. */
export const REMOTE_JOB_BASE_DIR = "/opt/qihoo/ansible-agent";

export function detachedJobPaths(jobId: string): DetachedJobPaths {
  const base = `${REMOTE_JOB_BASE_DIR}/${jobId}`;
  return {
    script: `${base}.sh`,
    out: `${base}.out`,
    err: `${base}.err`,
    exit: `${base}.exit`,
    pid: `${base}.pid`,
  };
}

export type DetachedOutcome =
  | { status: "completed"; exitCode: number; stdout: string; stderr: string }
  | {
      status: "timeout" | "aborted";
      pid: string | undefined;
      partialStdout: string;
      partialStderr: string;
    };

/**
 * Launch `bash <script>` detached on the remote and poll until it exits, the
 * timeout expires, or the signal aborts. Each remote call is short, so this
 * is immune to the global HTTP idle timeout that broke the old blocking call.
 *
 * `timeoutMs === 0` means no wall-clock cap (poll until `signal` aborts).
 */
export async function ansibleExecDetached(
  host: string,
  paths: DetachedJobPaths,
  opts: { timeoutMs: number; signal?: AbortSignal; pollIntervalMs?: number },
): Promise<DetachedOutcome> {
  const { timeoutMs, signal } = opts;
  const pollIntervalMs = opts.pollIntervalMs ?? 2000;

  // Launch: setsid detaches the script into its own session so it survives
  // the exec request returning; redirected stdio + `&` background it. The
  // inner `sh -c` writes stdout/stderr/exitcode to the artifact files.
  const launchCmd =
    `setsid sh -c 'bash "$0" >"$1" 2>"$2"; echo $? > "$3"' ` +
    `'${paths.script}' '${paths.out}' '${paths.err}' '${paths.exit}' ` +
    `</dev/null >/dev/null 2>&1 & ` +
    `echo $! > '${paths.pid}' && echo launched`;
  const launch = await ansibleExec(host, launchCmd, signal);
  if (launch.status !== 0 || !launch.stdout.includes("launched")) {
    throw new Error(
      `Failed to launch detached script: ${launch.stderr || launch.stdout || "(no output)"}`,
    );
  }

  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
  const pollCmd = `test -f '${paths.exit}' && echo DONE || echo RUNNING`;
  let firstPoll = true;

  while (true) {
    if (signal?.aborted) return await partialOutcome(host, paths, "aborted", signal);

    let poll: ExecResult;
    try {
      poll = await ansibleExec(host, pollCmd, signal);
    } catch (err) {
      if (signal?.aborted) return await partialOutcome(host, paths, "aborted", signal);
      // Transient poll error (network blip, agent restart). Retry after a
      // short sleep; the detached script is unaffected. If this exhausts the
      // remaining budget, the next deadline check reports timeout.
      await sleep(1000, signal);
      firstPoll = false;
      continue;
    }

    if (poll.stdout.trim() === "DONE") {
      try {
        const [exitR, outR, errR] = await Promise.all([
          ansibleExec(host, `cat '${paths.exit}'`, signal),
          ansibleExec(host, `cat '${paths.out}'`, signal),
          ansibleExec(host, `cat '${paths.err}'`, signal),
        ]);
        const code = Number.parseInt(exitR.stdout.trim(), 10);
        return {
          status: "completed",
          exitCode: Number.isNaN(code) ? -1 : code,
          stdout: outR.stdout,
          stderr: errR.stdout,
        };
      } catch (err) {
        if (signal?.aborted) return await partialOutcome(host, paths, "aborted", signal);
        throw new Error(`Failed to read completed script output: ${formatErr(err)}`);
      }
    }

    // Still running. Confirm the budget is not exhausted before sleeping;
    // checking after the poll (not before) avoids declaring timeout for a
    // script that finished during the last interval.
    if (Date.now() >= deadline) return await partialOutcome(host, paths, "timeout", signal);

    const remaining = deadline - Date.now();
    const sleepMs = firstPoll
      ? Math.min(500, Math.max(0, remaining))
      : Math.min(pollIntervalMs, Math.max(0, remaining));
    firstPoll = false;
    await sleep(sleepMs, signal);
  }
}

/** Best-effort partial snapshot (PID + tail of stdout/stderr) for timeout/abort. */
async function partialOutcome(
  host: string,
  paths: DetachedJobPaths,
  status: "timeout" | "aborted",
  signal?: AbortSignal,
): Promise<DetachedOutcome> {
  let pid: string | undefined;
  let partialStdout = "";
  let partialStderr = "";
  // On abort the signal is already aborted, so these best-effort fetches
  // (which pass the signal) will throw and leave the partial empty. The
  // caller still gets the locally-known logPaths via RunScriptDetails, so
  // the result remains recoverable.
  try {
    pid = (await ansibleExec(host, `cat '${paths.pid}' 2>/dev/null`, signal)).stdout.trim() || undefined;
  } catch {}
  try {
    partialStdout = (await ansibleExec(host, `tail -c 8192 '${paths.out}' 2>/dev/null`, signal)).stdout;
  } catch {}
  try {
    partialStderr = (await ansibleExec(host, `tail -c 8192 '${paths.err}' 2>/dev/null`, signal)).stdout;
  } catch {}
  return { status, pid, partialStdout, partialStderr };
}

/** Remove all artifact files for a completed job. Best-effort, never throws. */
export async function ansibleCleanupJob(
  host: string,
  paths: DetachedJobPaths,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await ansibleExec(
      host,
      `rm -f '${paths.script}' '${paths.out}' '${paths.err}' '${paths.exit}' '${paths.pid}'`,
      signal,
    );
  } catch {}
}

function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Resolve after `ms`, but wake immediately if `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
