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
