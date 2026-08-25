# Handoff: `/handoff` quick command

## Goal

Build a `/handoff` quick command (slash command) for pi that: summarizes the current session, records progress to a file, and natively starts a new session carrying a short continuation prompt.

## Done

- Explored pi's prompt-template system (`.pi/prompts/*.md` → `/name` slash commands) and session-management CLI flags (`--continue`, `--fork`, `ctx.newSession()`).
- **First attempt** — built `/handoff` as a prompt template at `.pi/prompts/handoff.md`. Iterated through user feedback:
  - User: don't hardcode the file path — let the agent decide ("让agent自己发挥").
  - User: don't add unrequested requirements (e.g. "shouldn't pollute repo / not committed").
  - User: start a new session natively, not print a `pi "..."` command-line invocation.
- **Key discovery** — a prompt template's agent only has bash/files tools; it cannot trigger pi's `/new` or call `ctx.newSession()`. Native new-session requires an **extension**.
- Found the official canonical example: `packages/coding-agent/examples/extensions/handoff.ts` — registers `/handoff`, uses `complete()` to generate a continuation prompt, lets user edit it, then calls `ctx.newSession()` to open a new session with the prompt as a draft.
- **Built the adapted extension** at `.pi/extensions/handoff.ts`:
  - System prompt instructs the LLM to produce: a progress doc (structure/Markdown of its choice), a file path (model-chosen, no dedicated handoff folder), and a short continuation prompt pointing to that file.
  - Output format: `FILE:` / `===PROMPT===` / `===SUMMARY===` delimiters, parsed by `parseHandoff()`.
  - Extension writes the summary to the model-chosen path (`mkdir -p` parent, `writeFile`).
  - Calls `ctx.newSession()` with the continuation prompt placed as a draft via `setEditorText()` — **no edit modal** (removed per user request).
  - Goal argument is optional: `/handoff` infers next step; `/handoff <goal>` carries a specific goal.
- Deleted the obsolete prompt template `.pi/prompts/handoff.md`.
- Reverted the `.gitignore` change (had added then removed `.pi/handoff.md`).
- **Verified**: extension loads in tmux test (`pi-test.sh --no-env`); `/handoff` registers with correct description; a model (glm-5.2) is available.

## Current state

- `/handoff` is functional and registered. The extension is at `.pi/extensions/handoff.ts`.
- **Not yet tested end-to-end** — the tmux test used `--no-env` (no API keys), so the `complete()` LLM call wasn't exercised. The execution path mirrors the canonical example exactly (same API calls), but hasn't been run with a real model.
- The continuation prompt is placed as a **draft** in the new session (user hits Enter to submit). Auto-submit via `sendUserMessage()` is an unmade decision.

## Next steps

1. **Test end-to-end**: run `/handoff` in a real pi session (with API key) to confirm the LLM call, file writing, and new-session flow all work.
2. **Decide auto-submit vs draft**: if the user wants the new session to immediately continue without manual submit, switch `setEditorText(prompt)` to `replacementCtx.sendUserMessage(prompt)` (or equivalent) in the `withSession` callback.
3. **Commit** `.pi/extensions/handoff.ts` if satisfied (currently untracked).

## Key files

- `.pi/extensions/handoff.ts` — the new `/handoff` extension (the only file changed this session).
- `packages/coding-agent/examples/extensions/handoff.ts` — the canonical example it was adapted from (in `examples/**/*`, type-checked by `npm run check`).
- `packages/coding-agent/src/core/extensions/types.ts` — `ExtensionAPI`, `ExtensionCommandContext`, `ctx.newSession()`, `ctx.ui` signatures.
- `packages/coding-agent/src/core/extensions/loader.ts` — virtual modules available to extensions (confirms `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `typebox`, node builtins).
- `packages/coding-agent/docs/prompt-templates.md` — prompt template docs (reference for the deleted template approach).

## Key decisions & rationale

- **Extension over prompt template**: only extensions can call `ctx.newSession()` to natively start a new session. Prompt templates expand into prompts the agent executes, but the agent's tools (bash/files) cannot trigger `/new`.
- **Model chooses file path & doc structure**: user explicitly said "让agent自己发挥" — don't hardcode the path. The system prompt tells the LLM to pick a sensible relative path; the extension writes wherever it says.
- **No edit modal**: user said "去掉编辑这一步". The `ctx.ui.editor()` call from the example was removed entirely; the continuation prompt goes straight to the new session as a draft.
- **Structured output (FILE/PROMPT/SUMMARY)**: needed because the extension must extract three things (path, prompt, doc) from one LLM response. Delimiter-based parsing (`===PROMPT===` / `===SUMMARY===`) is more robust than JSON for Markdown content.
- **Draft, not auto-submit**: conservative default — the generated prompt is visible before the user submits. Can switch to auto-submit if desired.

## Gotchas / open questions

- `.pi/extensions/` is **not** in the root `tsconfig.json` `include` (only `packages/*/src`, `packages/*/test`, `examples/**/*`). So `npm run check` does NOT type-check extensions — they're loaded via jiti at runtime. Syntax was verified with `biome format` (parses OK), but type errors would only surface at runtime.
- The extension needs a **model selected** (`ctx.model`). With `--no-env` (no API keys), the `complete()` call would fail on missing API key — but loading and command registration work fine.
- **Concurrent sessions**: `.pi/handoff.md` (or whatever path the model picks) is a single overwritten file. If two sessions hand off simultaneously, the second clobbers the first. This was accepted as a tradeoff (user didn't want a dedicated folder for namespacing).
- The `[p]` badge shown next to `/handoff` in the autocomplete is **unexplained** — grep didn't locate the rendering logic. It's benign (the command executes via its handler, confirmed by the correct description appearing). Worth understanding if curious.
- **Other modified files in `git status`** (`packages/ai/src/providers/openai-completions.ts`, `packages/coding-agent/CHANGELOG.md`, `packages/coding-agent/src/core/system-prompt.ts`, `packages/coding-agent/src/core/tools/plan.ts`, `packages/coding-agent/src/modes/print-mode.ts`, `scripts/update-models.sh`) are from **other concurrent sessions** — not touched by this session.

## Git state

- Only change this session: `.pi/extensions/handoff.ts` (new, untracked, ready to commit).
- `.gitignore` was modified then reverted — currently clean (matches HEAD).
- `.pi/prompts/handoff.md` was created then deleted — not present.
- Nothing committed.
