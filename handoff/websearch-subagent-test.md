# Web Search via DeepSeek Responses API + Subagent

## Original goal

User wants their local DeepSeek V4 Flash model to use DeepSeek's Responses API with the built-in `web_search` tool. They want other models (on any API) to access web search via a dedicated **subagent** (not a function tool). The subagent must run with **no pi tools**, **no context files**, and **no default system prompt** — fully isolated, parent-injected only.

## What was accomplished

### 1. Generic `web_search` support in pi's `openai-responses` provider
- Added `OpenAIResponsesCompat.webSearch?: boolean` flag (types.ts).
- `convertResponsesTools` gains `includeWebSearch` option — appends `{ type: "web_search" }` to the request `tools` array.
- `buildParams` in `openai-responses.ts` passes `{ includeWebSearch: compat.webSearch }`.
- `processResponsesStream` explicitly tolerates `web_search_call` output items (no-op branches in `output_item.added` and `output_item.done`).
- `OpenAIResponsesCompatSchema` in `model-registry.ts` allows `webSearch` for models.json validation.
- Unit test: `packages/ai/test/openai-responses-web-search.test.ts` (4 tests, pass).
- Changelog entry added to `packages/ai/CHANGELOG.md`.

### 2. User's models.json configured
- `~/.pi/agent/models.json` — added `deepseek` provider with `deepseek-v4-flash` using `api: "openai-responses"`, `baseUrl: "https://api.deepseek.com"`, `compat: { webSearch: true }`, `reasoning: true`.
- This **replaces** the built-in completions `deepseek-v4-flash` (same provider+id). `deepseek-v4-pro` stays on completions (untouched).
- Auth: `deepseek` key is in `~/.pi/agent/auth.json` (not env). `DEEPSEEK_API_KEY` env is unset.
- `--list-models` confirms the model appears.

### 3. Subagent extension enhanced (repo example, user-symlinked)
- `packages/coding-agent/examples/extensions/subagent/agents.ts`: `AgentConfig` gains `noTools`, `noContext`, `replaceSystemPrompt` boolean fields + `parseBoolean` helper.
- `packages/coding-agent/examples/extensions/subagent/index.ts`:
  - `SubagentArgsOptions` gains optional `noTools`, `noContext`.
  - `buildSubagentArgs` emits `--no-tools` and `--no-context-files`.
  - `runSingleAgent` reads the three flags from the agent preset; `replaceSystemPrompt` makes the body go via `--system-prompt` (override) instead of `--append-system-prompt`.
- Test: `packages/coding-agent/test/subagent-args.test.ts` — added `--no-tools`/`--no-context-files` case (8/8 pass).

### 4. websearch subagent preset created
- `~/.pi/agent/agents/websearch.md` (user-level, global):
  - `model: deepseek/deepseek-v4-flash`
  - `noTools: true`, `noContext: true`, `replaceSystemPrompt: true`
  - Body = web research specialist system prompt (always search, cite sources, no file/command usage, leaf task — don't ask questions).
- Frontmatter verified to parse correctly (all 3 flags = true).

## Current state

All code changes complete and verified:
- `npm run check` passes for all changed files (biome, pinned-deps, ts-imports, shrinkwrap, tsgo).
- 2 **pre-existing** tsgo errors remain in `packages/ai/test/openai-completions-tool-choice.test.ts` and `with-thinking-level-overrides.test.ts` — `qwen/qwen3-32b` was renamed to `qwen/qwen3.6-27b` in groq models but tests not updated. **Unrelated to this work, present on HEAD.**
- Unit tests pass: `openai-responses-web-search.test.ts` (4/4), `subagent-args.test.ts` (8/8), other responses tests (31/31).
- **End-to-end live test NOT yet run** — this is the immediate next step.

## Ordered next steps

1. **Run the live end-to-end test** to confirm web_search actually triggers and returns sourced results:
   ```bash
   cd /mnt/d/code/github/pi-mono
   ./pi-test.sh --mode json -p --no-tools --no-context-files \
     --system-prompt "$(sed -n '/^---$/,/^---$/!p' ~/.pi/agent/agents/websearch.md)" \
     --model deepseek/deepseek-v4-flash "Task: 今天上海天气"
   ```
   - This spawns a child pi process exactly as the subagent tool would.
   - Verify: output contains an assistant message with a real answer (weather info) that could only come from web search. In JSON mode, look for `web_search_call` items in the response or sourced text.
   - Costs a small number of DeepSeek tokens (user has been asked for permission; they said "subagent测试" = go test it).

2. **If web_search works**: optionally test the full subagent delegation path (main model calls `subagent` tool with `agent: "websearch"`). This requires an interactive session or a main-model prompt that triggers delegation.

3. **If errors occur**: check whether DeepSeek's `/responses` endpoint rejects any params (e.g., `prompt_cache_key`, `include`, `reasoning.summary`). The doc says unsupported params are silently ignored, but verify. Also check `reasoning.effort` values — default thinkingLevelMap is unset, so effort may be sent as "none" in the no-level edge case.

## Key files and why they matter

| File | Why |
|---|---|
| `packages/ai/src/types.ts` | `OpenAIResponsesCompat.webSearch` flag definition |
| `packages/ai/src/providers/openai-responses.ts` | `getCompat` defaults webSearch:false; `buildParams` passes it to `convertResponsesTools` |
| `packages/ai/src/providers/openai-responses-shared.ts` | `convertResponsesTools` appends `{type:"web_search"}`; `processResponsesStream` tolerates `web_search_call` items |
| `packages/coding-agent/src/core/model-registry.ts` | `OpenAIResponsesCompatSchema` allows `webSearch` in models.json |
| `packages/ai/test/openai-responses-web-search.test.ts` | Unit test for web_search tool conversion (4 tests) |
| `packages/coding-agent/examples/extensions/subagent/agents.ts` | AgentConfig + parseBoolean for noTools/noContext/replaceSystemPrompt |
| `packages/coding-agent/examples/extensions/subagent/index.ts` | buildSubagentArgs emits --no-tools/--no-context-files; runSingleAgent handles replaceSystemPrompt |
| `packages/coding-agent/test/subagent-args.test.ts` | Tests for new flags (8 tests) |
| `~/.pi/agent/models.json` | User config: deepseek-v4-flash on openai-responses + webSearch |
| `~/.pi/agent/agents/websearch.md` | User config: websearch subagent preset (isolated mode) |
| `/mnt/c/Users/wuxuchen/Desktop/ds.md` | DeepSeek Responses API doc (reference for endpoint/tools/events) |

## Key decisions and rationale

- **`webSearch` as a model compat flag** (not a runtime toggle): simplest, opt-in per-model via models.json. Defaults false so no behavior change for existing models.
- **web_search tool in `convertResponsesTools`** (not buildParams directly): keeps it testable as a pure function; the `includeWebSearch` option is only passed by `openai-responses` provider (azure/codex can adopt later).
- **Replace built-in completions flash via models.json** (not generate-models.ts): avoids changing behavior for all pi users; personal config only. `mergeCustomModels` replaces by (provider, id) so pro is untouched.
- **Subagent approach** (not a pi function tool): user explicitly wanted a dedicated subagent, not a `web_search(query)` function tool. The subagent runs flash with server-side web_search; main model stays on its own API.
- **Three separate frontmatter booleans** (noTools/noContext/replaceSystemPrompt) rather than a single `isolated` flag: more flexible for future agents that want partial isolation.
- **`--system-prompt` (override) for replaceSystemPrompt**: verified that `buildSystemPrompt` uses the `customPrompt` branch (body only + date/cwd) and skips the default coding-agent prompt construction entirely.

## Gotchas / open questions

- **Pre-existing tsgo errors**: `qwen/qwen3-32b` in 2 test files (`openai-completions-tool-choice.test.ts:160`, `with-thinking-level-overrides.test.ts:12`). Not caused by this work. Would need renaming to `qwen/qwen3.6-27b` to fix.
- **`.pi/extensions/handoff.ts` is modified** by another session — do not touch.
- **`web_search_call` items are NOT replayed** in multi-turn. DeepSeek doc says replay is optional ("原样回传即可"). If multi-turn search context issues arise, replay logic needs to be added (would require storing web_search_call items in AssistantMessage).
- **Citations/URLs not surfaced in TUI**: `response.output_text.annotation.added` events are not handled; url_citation annotations are dropped. The answer text comes through but without inline source URLs visible to pi. This is acceptable for v1.
- **`tool_choice` is `auto`**: the model decides when to search. Not forced.
- **Reasoning effort**: the responses flash model has `reasoning: true` with no `thinkingLevelMap`. When the agent passes a thinking level, it's sent as `effort` directly. When no level is passed (edge case), `effort: "none"` may be sent — DeepSeek's acceptance of "none" is unverified.
- **Running pi**: `./pi-test.sh` runs from source (bun src/cli.ts) — changes apply immediately. The installed `pi` command symlinks to `dist/` — would need rebuild for changes to take effect.
- **subagent extension is symlinked**: `~/.pi/agent/extensions/subagent` → `packages/coding-agent/examples/extensions/subagent`. Modifying the repo example directly affects the user's extension.

## Uncommitted git state

Modified files (all uncommitted):
- `packages/ai/src/types.ts`
- `packages/ai/src/providers/openai-responses.ts`
- `packages/ai/src/providers/openai-responses-shared.ts`
- `packages/coding-agent/src/core/model-registry.ts`
- `packages/ai/test/openai-responses-web-search.test.ts` (new)
- `packages/ai/CHANGELOG.md`
- `packages/coding-agent/examples/extensions/subagent/agents.ts`
- `packages/coding-agent/examples/extensions/subagent/index.ts`
- `packages/coding-agent/test/subagent-args.test.ts`

User config files (outside repo, not in git):
- `~/.pi/agent/models.json` (modified — added deepseek provider)
- `~/.pi/agent/agents/websearch.md` (new)
