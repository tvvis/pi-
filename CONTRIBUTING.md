# Contributing to pi

This project is maintained by a single developer. There is no external PR review flow and no contributor gate.

If you want to report a bug or request a feature, open an issue. If you want to submit a change, open a PR — it will be reviewed and merged at the maintainer's discretion.

## The One Rule

**You must understand your code.** If you cannot explain what your changes do and how they interact with the rest of the system, your PR will be closed.

Using AI to write code is fine. Submitting AI-generated slop without understanding it is not.

If you use an agent, run it from the `pi-mono` root directory so it picks up `AGENTS.md` automatically. Your agent must follow the rules and guidelines in that file.

## Before Submitting a PR

```bash
npm run check
./test.sh
```

Both must pass.

Do not edit `CHANGELOG.md`. Changelog entries are added by the maintainer.

If you are adding a new provider to `packages/ai`, see `AGENTS.md` for required tests.

## Philosophy

pi's core is minimal. If your feature does not belong in the core, it should be an extension. PRs that bloat the core will likely be rejected.
