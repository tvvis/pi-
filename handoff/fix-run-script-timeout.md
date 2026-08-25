# Fix `run_script` Long-Run Timeout / Orphan / Lost-Report Bug

## Original Goal

`run_script` (from the `.pi/extensions/remote-executor` extension) had broken long-run behavior: when executing a long-running script (e.g. `soc-uninstall.sh` on `11.121.250.96`), even with `timeout=900` explicitly passed, the call returned a timeout error long before 900s — but the script itself was **NOT killed** and kept running as an orphan. The `# @assert:` report was lost, and the caller couldn't distinguish "tool timed out" from "script failed." The cause of the early timeout was unknown.

## Root Cause (Confirmed)

The early timeout was **neither the pi harness tool-timeout nor a `run_script`-level timeout**. It was the **global undici HTTP idle timeout**:

- `packages/coding-agent/src/core/http-dispatcher.ts` installs a global undici dispatcher at startup (`cli.ts:18`, `main.ts:687`) with `headersTimeout` and `bodyTimeout` = `DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000` (5 min). No custom `httpIdleTimeoutMs` was set by the user, so the 300s default applied.
- This dispatcher governs **every** `fetch()` in the process, including `run_script`'s `fetch("http://host:6677/ansible/agent/exec")` in `ansible.ts`.
- The remote `/agent/exec` endpoint runs `bash <script>` synchronously and returns a single JSON response only after the script exits. While a long script runs (>5 min), no HTTP data flows. After 300s, undici raises `HeadersTimeoutError`/`BodyTimeoutError` and rejects the fetch — independent of the `AbortSignal` and independent of any `timeout` argument.
- `run_script`'s schema had **no `timeout` parameter** at all — `timeout=900` was silently dropped. The `timeout` param existed only on the built-in `bash` tool (enforced in the harness `exec`), not on this extension tool which uses raw `fetch`.
- Closing the fetch only tore down the client TCP socket; the remote agent did not kill the spawned `bash`, so it ran to completion as an orphan.
- In `runRemoteScript`, `ansibleExec` was awaited before `runAssertions`; when exec threw, assertions never ran. Both timeout and script failure surfaced as the same `"Remote execution failed: …"` string. Additionally, `createErrorToolResult` hard-coded `details: {}`, so thrown errors lost structured details and `renderResult` showed "exit: undefined" (the error message in `content` was silently dropped when `renderResult` was defined and `details` was truthy-but-empty).

## What Was Accomplished

A 4-part fix was implemented and validated at the type + unit-test level:

### 1. Framework tweak — `packages/agent/src/agent-loop.ts`
- `createErrorToolResult(message: string)` → `createErrorToolResult(messageOrError: unknown)`: now extracts an attached `toolResultDetails` object from thrown Errors and puts it in the result's `details` (previously hard-coded `{}`). Backward-compatible: plain throws still yield `details: {}`.
- 3 call sites (lines ~622, ~659, ~698) now pass the raw `error` instead of `error.message`.
- **Note:** The user initially pushed back on this change ("no, stop. agent-loop is for what?"). After explanation, the user said "现在的实现没有问题" (the current implementation is fine), indicating acceptance. This is a published-package change (`@earendil-works/pi-agent-core`) for a project-local extension — the trade-off was explained and accepted.

### 2. Detached execution — `.pi/extensions/remote-executor/ansible.ts` (fully rewritten)
- New model: `setsid sh -c '…' … </dev/null >/dev/null 2>&1 &` launches the script in its own session (survives the exec request returning). Inner `sh -c` writes stdout/stderr/exit code to marker files (`<jobId>.out`, `.err`, `.exit`, `.pid`).
- Poll loop: every ~2s, a tiny `test -f '<exitfile>' && echo DONE || echo RUNNING` fetch. **Every fetch is sub-second**, so the global HTTP idle timeout never fires. The overall wall-clock budget is enforced by the JS poll loop — runtime-agnostic (Node + Bun).
- On DONE: reads exit code + stdout + stderr via `cat`. On timeout/abort: best-effort partial snapshot (PID + `tail -c 8192` of stdout/stderr).
- Added: `ansibleUploadBlob`, `ansibleExecDetached`, `ansibleCleanupJob`, `detachedJobPaths`, `DetachedJobPaths`, `DetachedOutcome`, `REMOTE_JOB_BASE_DIR`, `sleep` (abort-aware).
- Deadline check is done **after** polling (not before) to avoid declaring timeout for a script that finished during the last interval.

### 3. `run_script` tool rewrite — `.pi/extensions/remote-executor/index.ts`
- Added real `timeout` param (seconds, default 600, `0` = no cap). `timeout=900` now actually works.
- Unified `runRemoteScript` + `runRemoteCommand` into a single `runDetached(host, scriptContent, source, mode, timeoutMs, signal)`.
- `RunScriptDetails` gained: `status: "completed" | "timeout" | "aborted"`, `remotePid?`, `logPaths?`, `exitCode: number | null`.
- On timeout/aborted: throws `Object.assign(new Error(output), { toolResultDetails: details })` → `isError=true` (red bg) + structured details preserved via the framework tweak. The message includes PID, kill command, log paths, re-check command, partial stdout/stderr, and a "do not assume success or failure" note. Artifact files are **kept** (not cleaned up) so the caller can re-poll.
- On completed: cleans up job files; throws on failure (assertions/exit/stderr), returns normally on success.
- Assertions are only run when `status === "completed"` (stable post-run state).
- `renderCall`: shows `(timeout Ns)` suffix when `timeout` is provided.
- `renderResult`: handles `status === "timeout"|"aborted"` with a distinct warning-colored block (PID, logs, partial output); fixed empty-details fallback to show `content[0].text` for hard errors (upload/launch/read failures); uses `details.exitCode ?? -1` for the completed header.
- Updated `description`, `promptSnippet`, `promptGuidelines` to document detached execution and `timeout`.

### 4. Docs — `.pi/skills/script-validator/SKILL.md`
- Added "Long-running scripts: `timeout` and detached execution" subsection documenting the three `status` outcomes (`completed` / `timeout` / `aborted`), the `timeout` param, and that a timeout does NOT kill the script.

## Current State

- **Code is written and committed to the working tree (not git-committed).** All changes are uncommitted.
- **Type-checks clean:** Extension files pass `tsgo` (via temp tsconfig). The only main-project `tsgo` errors are 2 pre-existing ones in `packages/ai/test/*` (model ID types — another session's work, not touched by this session).
- **Tests pass:** `agent-loop.test.ts` 20/20 (added 1 regression test for `toolResultDetails` preservation).
- **NOT runtime-validated** against a real remote host. The core unvalidated assumption: the remote ansible agent lets a `setsid … &` backgrounded process survive the exec request returning.
- **NOT active in the current pi session** — extensions are loaded at startup; the new code only takes effect after a **pi restart**.

## Ordered Next Steps

1. **Test the detached execution mechanism against a real host.** The user said "现在的实现没有问题，做一下测试吧" (the current implementation is fine, let's do testing). Validate that:
   - The `setsid … &` launch returns immediately from the exec endpoint.
   - The backgrounded process survives (keeps running, writes marker files).
   - The `test -f <exitfile>` poll correctly detects RUNNING then DONE.
   - stdout/stderr/exit files are captured correctly.
   - Use host `11.121.250.96` unless the user says otherwise. Keep tests harmless (sleep/echo, no mutations).
2. **If pi has been restarted**, test end-to-end via the real `run_script` tool with a short script + `timeout` param.
3. **If pi has NOT been restarted**, either restart pi to load the new extension, or test the detached mechanism via a standalone probe (node script replicating the launch/poll fetches to `http://<host>:6677/ansible/agent/exec`).
4. **If the `setsid &` assumption fails** (remote agent kills backgrounded processes), adjust the launch strategy (e.g., `nohup` + `disown`, or double-fork, or a different detachment method).
5. After validation, consider committing the changes (user's decision).

## Key Files and Why They Matter

| File | Role |
|------|------|
| `.pi/extensions/remote-executor/ansible.ts` | Transport layer. Rewritten with detached launch/poll primitives (`ansibleExecDetached`, `ansibleUploadBlob`, `ansibleCleanupJob`, `detachedJobPaths`). This is the core of the fix. |
| `.pi/extensions/remote-executor/index.ts` | Tool definitions. `run_script` now has `timeout` param, `runDetached` orchestrator, `buildTimeoutOutput`, updated `renderResult`/`renderCall`/schema/description. `file_upload` is unchanged. |
| `packages/agent/src/agent-loop.ts` | Core agent loop (published). `createErrorToolResult` tweaked to preserve `toolResultDetails` on thrown errors. Enables `run_script` timeout to be `isError=true` + structured details. |
| `packages/agent/test/agent-loop.test.ts` | Added regression test "should preserve toolResultDetails attached to a thrown error". |
| `.pi/skills/script-validator/SKILL.md` | Docs for the script-validator skill. Updated with timeout/detached execution section. |
| `packages/coding-agent/src/core/http-dispatcher.ts` | The root cause file (NOT modified). `DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000` + global `headersTimeout`/`bodyTimeout`. Read-only reference. |

## Key Decisions and Rationale

- **Detached + poll instead of per-request dispatcher exemption:** The detached model sidesteps the global HTTP idle timeout entirely (every fetch is sub-second) and is runtime-agnostic (works on Bun too, which ignores undici's dispatcher). A per-fetch undici dispatcher exemption would be Node-only and wouldn't solve the orphan/lost-report problems.
- **`setsid` for detachment:** Creates a new session, detaching from the controlling terminal/session. Combined with redirected stdio (`</dev/null >/dev/null 2>&1`), the process survives the exec request returning. `setsid` is available on all Linux.
- **Poll on exit-file existence (not PID liveness):** The exit file is the authoritative "done" signal. PID is for reporting/kill only. Avoids subshell-exit races.
- **Timeout does NOT kill the script:** A long uninstall interrupted mid-way could leave the system half-uninstalled. The detached model lets it finish; the caller gets PID + log paths to re-check or kill manually.
- **Framework tweak (`toolResultDetails`) for `isError=true` + structured details:** `AgentToolResult` has no `isError` field; throwing is the only path to `isError=true`. Without the tweak, throwing loses `details` (hard-coded `{}`). The tweak enables timeout = `isError=true` (red bg) + rich details. Trade-off: published-package change for a local extension. User accepted after explanation.
- **Default timeout 600s:** Safety net to prevent infinite hangs if `timeout` is omitted. The user explicitly passes `timeout=900` for long ops. `0` = no cap (poll until abort).
- **Deadline checked after poll (not before):** Avoids declaring timeout for a script that finished during the last poll interval.
- **Artifact files kept on timeout/aborted, cleaned up on completed:** So the caller can re-poll/inspect after a timeout.

## Gotchas / Open Questions / Uncommitted Git State

### Uncommitted git state (this session's changes only)
- `M .pi/extensions/remote-executor/ansible.ts` — rewritten (detached primitives)
- `M .pi/extensions/remote-executor/index.ts` — rewritten (timeout param, runDetached, renderResult)
- `M packages/agent/src/agent-loop.ts` — `createErrorToolResult` tweak
- `M packages/agent/test/agent-loop.test.ts` — regression test added
- `M .pi/skills/script-validator/SKILL.md` — docs updated
- **Other modified files in the working tree belong to OTHER concurrent sessions** (`packages/ai/*`, `packages/coding-agent/src/core/*`, `packages/coding-agent/examples/*`, `.pi/extensions/handoff.ts`, etc.). **Do NOT touch or commit those.**

### Critical gotchas
1. **Pi restart required.** The new extension code is NOT loaded in the current session. Until pi restarts, `run_script` still uses the old broken blocking-fetch behavior. Testing the new code via the `run_script` tool requires a restart.
2. **Unvalidated assumption: `setsid &` survival.** The "script keeps running detached" promise depends on the remote ansible agent NOT killing backgrounded processes when the exec request returns. If the agent kills the process group on disconnect, `setsid` (new session) should protect against it, but this has NOT been tested against the real host. If it fails, the timeout report still shows (poll loop times out seeing no exit file), but the "keeps running" promise is broken.
3. **The agent-loop.ts change is a published-package change.** It's backward-compatible (plain throws still yield `details: {}`), but it alters the error path for ALL tools. The user initially pushed back, then accepted after explanation. If the user changes their mind, the alternative is: revert agent-loop.ts + regression test, make timeout return a normal result (`isError=false`, green bg) with structured details — observability is identical, only bg color differs.
4. **`.pi/extensions` is NOT biome-checked** (biome's `files.includes` only covers `packages/*/src`, `test`, `examples`). Extension files use 2-space indentation (not biome's tab style). `tsgo` (tsconfig `include`) also does NOT cover `.pi/extensions` — they're loaded at runtime via tsx. Type-checking
