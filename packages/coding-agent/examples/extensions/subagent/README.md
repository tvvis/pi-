# Subagent Example

Delegate tasks to specialized subagents with isolated context windows.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C propagates to kill subagent processes
- **Persisted child sessions**: Each subagent run is saved as a real session file linked to the parent, auto-named, and browsable/resumable from `/resume`

## Session Persistence

Each subagent invocation runs a separate `pi` process that persists its own session file (it no longer runs with `--no-session`). The child session:

- Is linked back to the calling (parent) session via `parentRelation: "subagent"` in its header, using `--parent-session <parent-file> --parent-relation subagent`.
- Is auto-named `subagent:<agent> - <task>` (task whitespace-normalized and capped at 40 chars), so it is recognizable in `/resume`.
- Lands in the same project session directory as the parent (the child runs in the parent's cwd), so it shows up under that project in `/resume`.

In the `/resume` session tree, all `subagent` children of a session are gathered under a virtual **subagent** group node (collapsed by default, not written to disk). Expand the group to see the individual child sessions; each can be resumed independently as a standalone session (resuming a child does not return to the parent).

When the parent itself runs without a session file (e.g. `pi --no-session`), the child still persists but has no parent linkage.

## Generic Mode & Parent Control

A subagent is a generic `pi` process. The parent (calling) agent controls what the child loads and knows:

- **Generic mode**: omit `agent` to run a generic subagent (no named preset). Use `label` to name it in `/resume` (defaults to `subagent`).
- **Named preset**: pass `agent: "<name>"` to load a discovered agent's system prompt/tools/model as defaults (see [Agent Definitions](#agent-definitions)). The parent controls below still override the preset.
- **Skills**: `skills: ["<path>", ...]` loads specific skills (`--skill`); `noSkills: true` disables skill discovery (`--no-skills`). Combine both to load *only* the given skills.
- **Context**: `systemPrompt: "<text>"` overrides the child's system prompt (`--system-prompt`); `appendSystemPrompt: ["<text-or-file>", ...]` appends context (`--append-system-prompt`).
- **Tools / model**: `tools: [...]` (`--tools`) and `model: "<provider/id>"`.

All of these can be set at the top level (applies to every child) and overridden per item in `tasks[]` / `chain[]`. Merge priority: **item > top-level > agent preset default**.

### Generic example (no skills, restricted tools)
```
{ task: "Summarize README.md", noSkills: true, tools: ["read"], label: "summarizer" }
```

### Parent-controlled context example
```
{ task: "Review this diff", appendSystemPrompt: ["Focus on security issues."], skills: ["~/.pi/agent/skills/security"] }
```

## Structure

```
subagent/
├── README.md            # This file
├── index.ts             # The extension (entry point)
├── agents.ts            # Agent discovery logic
├── agents/              # Sample agent definitions
│   ├── scout.md         # Fast recon, returns compressed context
│   ├── planner.md       # Creates implementation plans
│   ├── reviewer.md      # Code review
│   └── worker.md        # General-purpose (full capabilities)
└── prompts/             # Workflow presets (prompt templates)
    ├── implement.md     # scout -> planner -> worker
    ├── scout-and-plan.md    # scout -> planner (no implementation)
    └── implement-and-review.md  # worker -> reviewer -> worker
```

## Installation

From the repository root, symlink the files:

```bash
# Symlink the extension (must be in a subdirectory with index.ts)
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/index.ts" ~/.pi/agent/extensions/subagent/index.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/agents.ts" ~/.pi/agent/extensions/subagent/agents.ts

# Symlink agents
mkdir -p ~/.pi/agent/agents
for f in packages/coding-agent/examples/extensions/subagent/agents/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/agents/$(basename "$f")
done

# Symlink workflow prompts
mkdir -p ~/.pi/agent/prompts
for f in packages/coding-agent/examples/extensions/subagent/prompts/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/prompts/$(basename "$f")
done
```

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and tool/model configuration.

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Only loads **user-level agents** from `~/.pi/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

When running interactively, the tool prompts for confirmation before running project-local agents. Set `confirmProjectAgents: false` to disable.

## Usage

### Single agent
```
Use scout to find all authentication code
```

### Parallel execution
```
Run 2 scouts in parallel: one to find models, one to find providers
```

### Chained workflow
```
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

### Workflow prompts
```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ task, agent? }` | One task; `agent` optional (omit for a generic subagent) |
| Parallel | `{ tasks: [...] }` | Multiple tasks run concurrently (max 8, 4 concurrent) |
| Chain | `{ chain: [...] }` | Sequential with `{previous}` placeholder |

## Output Display

**Collapsed view** (default):
- Status icon (✓/✗/⏳) and agent name
- Last 5-10 items (tool calls and text)
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O):
- Full task text
- All tool calls with formatted arguments
- Final output rendered as Markdown
- Per-task usage (for chain/parallel)

**Parallel mode streaming**:
- Shows all tasks with live status (⏳ running, ✓ done, ✗ failed)
- Updates as each task makes progress
- Shows "2/3 done, 1 running" status
- Returns each completed task's final output to the parent model, capped at 50 KB per task
- Returns failure diagnostics from stderr/error messages when a child exits before producing output

**Tool call formatting** (mimics built-in tools):
- `$ command` for bash
- `read ~/path:1-10` for read
- `grep /pattern/ in ~/path` for grep
- etc.

## Agent Definitions

Named agents are **optional presets**. Omit `agent` to run a generic subagent fully controlled by the parent (see [Generic Mode & Parent Control](#generic-mode--parent-control)). When `agent` is given, the agent's system prompt/tools/model are used as defaults.

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: claude-haiku-4-5
---

System prompt for the agent goes here.
```

**Locations:**
- `~/.pi/agent/agents/*.md` - User-level (always loaded)
- `.pi/agents/*.md` - Project-level (only with `agentScope: "project"` or `"both"`)

Project agents override user agents with the same name when `agentScope: "both"`.

## Sample Agents

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| `scout` | Fast codebase recon | Haiku | read, grep, find, ls, bash |
| `planner` | Implementation plans | Sonnet | read, grep, find, ls |
| `reviewer` | Code review | Sonnet | read, grep, find, ls, bash |
| `worker` | General-purpose | Sonnet | (all default) |

## Workflow Prompts

| Prompt | Flow |
|--------|------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

## Error Handling

- **Exit code != 0**: Tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: User abort (Ctrl+C) kills subprocess, throws error
- **Chain mode**: Stops at first failing step, reports which step failed

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Parallel model-visible output is capped at 50 KB per task; full results remain in tool details
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent
