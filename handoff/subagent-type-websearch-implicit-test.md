# Subagent `type` parameter — implicit websearch delegation test

## Original goal

User asked: can subagent specify "websearch-type" tools? After explanation that `web_search` is a server-side provider tool (not a pi function tool), user requested adding a `type` parameter to subagent where `"standard"` = default generic subagent and other types = user-defined presets (system prompt + model + tools). User chose: **`type` reuses existing agent presets** (`type: "websearch"` == `agent: "websearch"`).

## What was accomplished

- Added `type` parameter to the subagent extension tool (top-level + per-item in `tasks[]`/`chain[]`).
  - `type: "standard"` (default) = generic subagent, no preset loaded.
  - `type: "<name>"` = loads that agent preset from `~/.pi/agent/agents/*.md`, equivalent to `agent: "<name>"`.
  - `type` and `agent` are mutually exclusive per scope; conflict → hard error returned before spawning.
- Three exported helper functions: `presetNameFrom`, `presetDisplayName`, `validateTypeAgentExclusivity`.
- Updated: tool description (mentions `type`), `renderCall` display names (show preset name from `type`), project-agent confirm dialog (collects resolved preset names including `type`).
- Added 7 unit tests for the helpers; all 15 tests in the file pass.
- Added changelog entry under `[Unreleased] → Added`.

## Current state

Code is complete and verified:
- `biome check` — clean (no fixes needed on my files).
- `tsgo --noEmit` — my files have zero errors. Only 2 pre-existing errors in `packages/ai/test/*` (from another session's in-progress `packages/ai/src` model-registry changes).
- Tests — 15/15 pass.
- **Not committed** (per AGENTS.md, only commit when explicitly asked).

## Immediate next action (new session goal)

**Test the subagent with an implicit websearch delegation.** The user wants to see if the LLM, when given a task that needs fresh web data, will **on its own** choose to delegate to the `websearch` agent preset — WITHOUT the caller explicitly specifying `type: "websearch"` or `agent: "websearch"`.

Concrete test: ask a time-sensitive factual question (e.g. "what's the latest stable version of Bun?" or "what's new in Node.js 24?") and delegate it as a generic/standard subagent task. Observe whether the LLM:
1. Recognizes it needs web search.
2. Spawns a subagent with `type: "websearch"` (or `agent: "websearch"`) on its own.
3. Or fails to do so and tries to answer from training data (which would indicate the tool description needs better hints about available presets).

## Key files and why they matter

| File | Why |
|------|-----|
| `packages/coding-agent/examples/extensions/subagent/index.ts` | The subagent extension. Contains the `type` parameter schema, `presetNameFrom`/`presetDisplayName`/`validateTypeAgentExclusivity` helpers, `execute()` resolution logic, and `renderCall`. This is the main implementation file. |
| `packages/coding-agent/test/subagent-args.test.ts` | Unit tests for `buildSubagentArgs`, `buildSubagentSessionName`, and the 3 new resolution helpers. |
| `packages/coding-agent/CHANGELOG.md` | Changelog entry added under `[Unreleased] → Added`. |
| `~/.pi/agent/agents/websearch.md` | User's existing `websearch` agent preset. Uses `model: deepseek/deepseek-v4-flash`, `noTools: true`, `noContext: true`, `replaceSystemPrompt: true`. Body is a web research specialist system prompt. This is what `type: "websearch"` loads. |
| `packages/coding-agent/examples/extensions/subagent/agents.ts` | Agent discovery + config parsing. Defines `AgentConfig` with `noTools`, `noContext`, `replaceSystemPrompt` fields (pre-existing from another session). |

## Key decisions and rationale

- **`type` reuses agent presets, not a new registry.** User explicitly chose this. `type: "websearch"` == `agent: "websearch"`. No separate config file or format needed.
- **`"standard"` is reserved** as the explicit "no preset" value. Any other string is treated as an agent preset name.
- **`type` and `agent` are mutually exclusive** per scope (top-level or per-item). If both set → hard error before spawning. Rationale: avoids ambiguity; `type` is the newer/preferred field, `agent` is legacy alias.
- **Resolution helpers are exported** for testability, matching the existing pattern (`buildSubagentArgs` etc. are also exported).
- **`type` is per-scope only** (no inheritance across scopes). Top-level `type` applies to single mode only; per-item `type`/`agent` for parallel/chain. This mirrors how `agent` already worked.
- **Override semantics unchanged**: `model`/`tools`/`systemPrompt` etc. still override the preset's frontmatter values (priority: item > top-level > agent preset). So `type: "websearch", model: "foo"` overrides the preset's model.

## Gotchas / open questions

- **Pre-existing uncommitted changes from another session** are in the working tree:
  - Same `index.ts` file has `noTools`/`noContext`/`replaceSystemPrompt` support (agent preset fields) added by another session. My `type` work layers on top — complementary, not conflicting.
  - `packages/ai/src/providers/openai-responses*.ts` and `packages/ai/src/types.ts` modified (web search compat support). These cause 2 tsgo errors in `packages/ai/test/*` (stale model id `"qwen/qwen3-32b"` in test files vs regenerated union). **Not my files, not my errors** — do not fix them.
  - `packages/coding-agent/CHANGELOG.md` was already modified by another session; I inserted my entry mid-section.
- **The `websearch` agent preset requires a model with `compat.webSearch: true`** in the model registry. The preset uses `deepseek/deepseek-v4-flash`. If that model's `webSearch` compat isn't enabled in the current model registry, the subagent will run but won't actually get the `web_search` server-side tool injected. Verify the model config if web search doesn't work.
- **Tool description hint quality**: The tool description now says `type: "<preset>"` loads a named agent preset, but does NOT enumerate available presets. The LLM discovers preset names from the agent list shown in the "Available agents" error or from session context. If the LLM doesn't know "websearch" exists, it may not use it implicitly. This is the core thing the test is checking. If the LLM fails to pick websearch implicitly, the fix would be to enrich the tool description or system prompt with available agent preset names.

## Uncommitted git state

Files I modified (mine to commit):
- `packages/coding-agent/examples/extensions/subagent/index.ts`
- `packages/coding-agent/test/subagent-args.test.ts`
- `packages/coding-agent/CHANGELOG.md`

Files modified by other sessions (NOT mine — do not stage these):
- `.pi/extensions/handoff.ts`, `.pi/extensions/remote-executor/*.ts`
- `packages/agent/src/agent-loop.ts`, `packages/agent/test/agent-loop.test.ts`
- `packages/ai/CHANGELOG.md`, `packages/ai/src/providers/openai-responses*.ts`, `packages/ai/src/types.ts`
- `packages/coding-agent/docs/extensions.md`, `packages/coding-agent/src/core/agent-session.ts`, `packages/coding-agent/src/core/extensions/types.ts`, `packages/coding-agent/src/core/model-registry.ts`
- `packages/coding-agent/test/suite/regressions/2860-replaced-session-context.test.ts`
- Untracked: `.pi/handoff.md`, `handoff/`, `packages/ai/test/openai-responses-web-search.test.ts`
