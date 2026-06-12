# Development

See [AGENTS.md](https://github.com/earendil-works/pi-mono/blob/main/AGENTS.md) for additional guidelines.

## Setup

```bash
git clone https://github.com/earendil-works/pi-mono
cd pi-mono
npm install
npm run build:fast
```

Run from source:

```bash
/path/to/pi-mono/pi-test.sh
```

The script can be run from any directory. Pi keeps the caller's current working directory.

## Building

Two build targets are available; the Bun-compiled single-file binary is the recommended one for day-to-day development because of its fast startup time.

| Command | Output | Startup | Notes |
| --- | --- | --- | --- |
| `npm run build` | `dist/cli.js` (Node.js script) | ~20s | Default. Skips Bun compile. Use only when you need to run via `node` or `tsx`. |
| `npm run build:fast` | `dist/pi` (Bun single-file binary) | ~0.5s | **Use this for development.** Compiles to a self-contained ELF executable. Also requires `bun` on `$PATH`. |
| `npm run build:binary` | `dist/pi` (Bun single-file binary) | ~0.5s | Alias for `build:fast` at the coding-agent package level. Builds workspace deps first. |

**Always rebuild with `npm run build:fast` after pulling or modifying source.** The Bun binary is the version your `$PATH` symlink (`pi`) should point to:

```bash
ln -sf "$(pwd)/packages/coding-agent/dist/pi" /usr/local/bin/pi
# or wherever you keep your local bins, e.g. ~/.hermes/node/bin/pi
```

The dist `pi` binary bundles the full CLI, the image-resize worker, and the photon WASM blob; no Node.js runtime is required to launch it.

## Forking / Rebranding

Configure via `package.json`:

```json
{
  "piConfig": {
    "name": "pi",
    "configDir": ".pi"
  }
}
```

Change `name`, `configDir`, and `bin` field for your fork. Affects CLI banner, config paths, and environment variable names.

## Path Resolution

Three execution modes: npm install, standalone binary, tsx from source.

**Always use `src/config.ts`** for package assets:

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

Never use `__dirname` directly for package assets.

## Debug Command

`/debug` (hidden) writes to `~/.pi/agent/pi-debug.log`:
- Rendered TUI lines with ANSI codes
- Last messages sent to the LLM

## Testing

```bash
./test.sh                         # Run non-LLM tests (no API keys needed)
npm test                          # Run all tests
npm test -- test/specific.test.ts # Run specific test
```

## Project Structure

```
packages/
  ai/           # LLM provider abstraction
  agent/        # Agent loop and message types  
  tui/          # Terminal UI components
  coding-agent/ # CLI and interactive mode
```
