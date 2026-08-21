# workspace

A single tool, `workspace`, for **sharing and getting** information across
projects through a shared directory of **symlinks**.

## Layout

```
~/.pi/agent/workspace/
└── my-project/
    ├── docs/
    │   └── overview.md  ->  /abs/path/to/project/docs/overview.md
    └── snippets/
        └── auth.ts      ->  /abs/path/to/project/snippets/auth.ts
```

Each project gets its own subdirectory. Entries inside are symlinks pointing at
the physical file under the project directory. Editing the physical file updates
the workspace view instantly.

## Workflow

1. Write the file in the project directory (built-in `write` tool).
2. Call `workspace share` to publish it.
3. Other projects: `workspace get` to browse, then `read` / `edit` / `write`
   on the physical path.

## Tool

| action | required     | optional | effect                                                       |
| ------ | ------------ | -------- | ------------------------------------------------------------ |
| share  | `path`       | `project`| publish `<cwd>/<path>` into the workspace                   |
| get    | —            | `project`, `path` (subdir) | list published entries (recursive); pass `path` to scope to a subdirectory |

`project` is optional and defaults to the git toplevel basename (falling back
to the cwd basename).

## Configuration

| env var             | default                  | meaning                  |
| ------------------- | ------------------------ | ------------------------ |
| `PI_WORKSPACE_ROOT` | `~/.pi/agent/workspace/` | workspace root directory |

## Usage

```bash
pi -e ./examples/extensions/workspace
```

Or copy to `~/.pi/agent/extensions/workspace/` for auto-discovery.