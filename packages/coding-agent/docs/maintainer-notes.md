# Maintainer Notes

Internal-only notes for the maintainer. Not part of the user-facing docs (not in `docs.json`).

## Hidden from `/` autocomplete (pending decision)

These 11 slash commands have been removed from `BUILTIN_SLASH_COMMANDS` and from
`interactive-mode.ts`'s `onSubmit` dispatch. They no longer appear in the `/`
popup and typing them does nothing. The dispatchers and dead handler methods
were cleaned up. The underlying components/utilities and the `app.session.fork`
keybinding (which still calls `showUserMessageSelector`) are left intact.

Commands hidden:

- `/scoped-models`
- `/share`
- `/copy`
- `/name`
- `/import`
- `/session`
- `/changelog`
- `/fork`
- `/clone`
- `/login`
- `/logout`

### If the user later wants to fully remove them

The following references still mention these command names and may want
updating. They are intentionally left intact for now so the commands can be
re-enabled cheaply.

User-facing docs / strings:

- `packages/coding-agent/README.md`
- `packages/coding-agent/docs/usage.md`
- `packages/coding-agent/docs/keybindings.md`
- `packages/coding-agent/CHANGELOG.md` — only edit the `[Unreleased]` section;
  released sections are immutable.
- `packages/coding-agent/src/cli/args.ts:369` — help text mentions `/share`
  (also references `PI_SHARE_VIEWER_URL`; only the `/share` text needs removing
  if the env var stays).
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts:580` —
  "Use `/changelog` to view full changelog." upgrade hint.

JSDoc / error messages still mentioning the names:

- `packages/coding-agent/src/core/auth-storage.ts:504` — `/login` hint.
- `packages/coding-agent/src/core/auth-guidance.ts:8` — `/login` hint.
- `packages/coding-agent/src/core/model-registry.ts:868,1017` — `/login` hint.
- `packages/coding-agent/src/core/extensions/types.ts:1251,1341` — `/login`
  hint.
- `packages/coding-agent/src/core/agent-session.ts:220,377,1060,3072` —
  `/session`, `/login`, `/copy` hints.
- `packages/coding-agent/src/core/agent-session-runtime.ts:38,391` — `/import`
  hint.

Stale keybinding actions (still wired, still work — review whether to drop or
keep as keybind-only access):

- `app.session.fork` in `DEFAULT_APP_KEYBINDINGS` (still calls
  `showUserMessageSelector`).
- `app.models.*` actions (used only by the now-orphaned
  `ScopedModelsSelectorComponent`; safe to drop if that component is also
  removed).

Components / utilities still exported as internal API:

- `packages/coding-agent/src/modes/interactive/components/scoped-models-selector.ts`
- The `LoginDialogComponent` import in `interactive-mode.ts` (still used by
  `showLoginAuthTypeSelector`, which itself is currently unreachable from any
  user-visible flow once `/login` and `/logout` are gone — review).

Tests:

- `packages/coding-agent/test/suite/regressions/3217-scoped-model-order.test.ts`
  — still passes; only covers the component, not the slash command.

## `write` tool: skip-unchanged optimization

**Status**: Proposed
**Date**: 2026-06-16

### Problem

When the agent calls `write` with content identical to the existing file, it silently overwrites — no diff, no feedback. In practice this causes the same file to be written **10+ times** in a single session (observed with `config_common.conf` during `multi_branch_c` test-plan creation). The agent has no signal that the write was redundant, so it keeps re-issuing it across multiple reasoning turns.

### Proposal

Before writing, compare `content` against the existing file:

| Situation | Action | Return string |
|-----------|--------|---------------|
| File does not exist | Write normally | `Created: {path}` |
| Content differs | Overwrite | `Overwritten: {path}` |
| Content is identical | Skip (no I/O) | `Unchanged: {path} (skipped)` |

### Why this works

- **Tool-level fix** — no skill prompt changes needed; the agent sees `Unchanged (skipped)` and stops retrying.
- **Preserves semantics** — when content genuinely differs, `write` still overwrites as before.
- **Cheap** — one `fs.readFile` + string compare before the write; negligible cost vs. a full overwrite.
- **Self-correcting** — even if the agent's reasoning is buggy (re-dispatching writes it already did), the tool catches it.

### Alternatives considered

| Alternative | Why rejected |
|------------|-------------|
| `skip_if_exists` parameter | Too aggressive — would block legitimate overwrites with different content |
| Skill-level rule ("check before writing") | Unreliable — agent behavior can't be guaranteed by prompt alone |
| Return diff on overwrite | Nice-to-have but orthogonal; the key fix is the `Unchanged` signal |

### Implementation sketch

In the `write` tool handler (wherever `fs.writeFile` is called):

```ts
const existing = await fs.readFile(path, 'utf8').catch(() => null);
if (existing !== null && existing === content) {
  return { status: 'Unchanged', path, detail: 'skipped' };
}
await fs.mkdir(dirname(path), { recursive: true });
await fs.writeFile(path, content);
return { status: existing === null ? 'Created' : 'Overwritten', path };
```

### Open question

- Should `edit` tool also get a similar guard? (If `oldText` matches but `newText` equals the current text at that location, it's a no-op edit.)

## write tool: skip-unchanged optimization

### Problem

Agent sometimes writes the same file multiple times in one session (e.g. `configs/B/config_common.conf` was written 10+ times when creating a test_plan scene). Each write is a no-op in terms of content but:
- Wastes tool call budget
- Makes the conversation log noisy and hard to audit
- Gives the agent no signal that the file already had that content

### Root cause

The `write` tool unconditionally overwrites and always returns the same result regardless of whether the file changed. The agent cannot distinguish "I just created this" from "I just overwrote with identical content".

### Proposed change

Before writing, read the existing file (if any) and compare content:

| Case | Behavior | Return value |
|------|----------|-------------|
| File does not exist | Write normally | `Created: {path}` |
| Content differs | Overwrite normally | `Overwritten: {path}` |
| Content identical | Skip write | `Unchanged: {path} (skipped)` |

### Why not other approaches

- **`skip_if_exists` flag**: breaks the legitimate "overwrite with new content" use case
- **Skill-level rules** ("check before writing"): unreliable — agent behavior is non-deterministic; tool-level enforcement is the correct layer
- **Batch write requirement**: over-constrains valid workflows where incremental writes are intentional

### Implementation notes

- Content comparison should be exact string match (no normalization)
- The `skipped` signal in the return value is the key feature — it lets the agent learn and stop retrying
- No new parameters needed; fully backward compatible
- Consider: should `edit` tool also get a similar check? (lower priority since `edit` requires matching `oldText` which already implies content awareness)

## `write` tool: skip unchanged overwrites

**Status**: Proposed
**Date**: 2026-06-16

### Problem

When the agent calls `write` with content identical to the existing file, it silently overwrites — no diff, no feedback. In practice this causes the same file to be written **10+ times** in a single session (observed with `config_common.conf` during `multi_branch_c` test-plan creation). The agent has no signal that the write was redundant, so it keeps re-issuing it across multiple reasoning turns.

### Proposal

Before writing, compare `content` against the existing file:

| Situation | Action | Return string |
|-----------|--------|---------------|
| File does not exist | Write normally | `Created: {path}` |
| Content differs | Overwrite | `Overwritten: {path}` |
| Content is identical | Skip (no I/O) | `Unchanged: {path} (skipped)` |

### Why this works

- **Tool-level fix** — no skill prompt changes needed; the agent sees `Unchanged (skipped)` and stops retrying.
- **Preserves semantics** — when content genuinely differs, `write` still overwrites as before.
- **Cheap** — one `fs.readFile` + string compare before the write; negligible cost vs. a full overwrite.
- **Self-correcting** — even if the agent's reasoning is buggy (re-dispatching writes it already did), the tool catches it.

### Alternatives considered

| Alternative | Why rejected |
|------------|-------------|
| `skip_if_exists` parameter | Too aggressive — would block legitimate overwrites with different content |
| Skill-level rule ("check before writing") | Unreliable — agent behavior can't be guaranteed by prompt alone |
| Return diff on overwrite | Nice-to-have but orthogonal; the key fix is the `Unchanged` signal |

### Implementation sketch

In the `write` tool handler (wherever `fs.writeFile` is called):

```ts
const existing = await fs.readFile(path, 'utf8').catch(() => null);
if (existing !== null && existing === content) {
  return { status: 'Unchanged', path, detail: 'skipped' };
}
await fs.mkdir(dirname(path), { recursive: true });
await fs.writeFile(path, content);
return { status: existing === null ? 'Created' : 'Overwritten', path };
```

### Open question

- Should `edit` tool also get a similar guard? (If `oldText` matches but `newText` equals the current text at that location, it's a no-op edit.)
