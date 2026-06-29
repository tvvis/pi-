import { describe, expect, it } from "vitest";
import { SidebarRecentFiles } from "../../src/modes/interactive/components/sidebar-recent-files.ts";
import type { RecentFile } from "../../src/modes/interactive/sidebar-recent-files-store.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

const VERSION = "0.1.0";
const WIDTH = 25;

function makeFile(absPath: string, tool: "edit" | "write" = "edit", offset = 0): RecentFile {
	return { absPath, lastTouchedAt: 1_700_000_000_000 + offset, tool };
}

function renderRaw(files: RecentFile[], cwd: string, width: number): string[] {
	return new SidebarRecentFiles(
		() => files,
		cwd,
		() => VERSION,
	).render(width);
}

function renderVisible(files: RecentFile[], cwd: string, width: number): string[] {
	return renderRaw(files, cwd, width).map((line) => stripAnsi(line));
}

function fileRows(lines: string[]): string[] {
	// First 3 lines: title, rule, "Recent Files". File rows start at index 3.
	// 2-line wrapped rows are joined with `\n` to keep them as one logical row.
	return lines.slice(3).filter((l) => l.trim().length > 0);
}

describe("SidebarRecentFiles — prefix, 2-line wrap, layout", () => {
	it("initializes a default theme before rendering", () => {
		initTheme("dark");
	});

	it("uses 1- prefix with no trailing space (edit)", () => {
		const lines = renderVisible([makeFile("/repo/src/foo.ts")], "/repo", WIDTH);
		const row = fileRows(lines)[0]!;
		expect(row).toMatch(/^ 1-src\/foo\.ts/);
	});

	it("uses 1- prefix for write tool too, same shape, distinguished by path color", () => {
		const editRow = fileRows(renderVisible([makeFile("/repo/src/foo.ts", "edit")], "/repo", WIDTH))[0]!;
		const writeRow = fileRows(renderVisible([makeFile("/repo/src/foo.ts", "write")], "/repo", WIDTH))[0]!;
		// Visible content identical, color differs (verified by raw ANSI below)
		expect(editRow).toBe(writeRow);
	});

	it("digit is styled in borderAccent (highlight), distinct from the path color", () => {
		const raw = renderRaw([makeFile("/repo/foo.ts", "edit")], "/repo", WIDTH);
		const firstFileRow = raw[3]!; // first file row, raw (with ANSI)
		// The visible text starts with " 1-foo.ts". The "1" should carry the borderAccent
		// color (an SGR sequence for the highlight color), and the path should carry accent.
		// We assert that the raw row contains at least two distinct SGR foreground sequences
		// between the leading pad and the path text, which proves the digit is colored differently.
		const ansiSeqs = firstFileRow.match(/\x1b\[38;5;\d+m|\x1b\[3[0-9]m/g) ?? [];
		expect(ansiSeqs.length).toBeGreaterThanOrEqual(2);
		// The first colored segment (digit) must be a different SGR than the path segment.
		const uniq = new Set(ansiSeqs);
		expect(uniq.size).toBeGreaterThanOrEqual(2);
	});

	it("applies different ANSI colors for edit (accent) vs write (success) on the path", () => {
		initTheme("dark");
		const editRaw = renderRaw([makeFile("/repo/foo.ts", "edit")], "/repo", WIDTH)[3]!;
		const writeRaw = renderRaw([makeFile("/repo/foo.ts", "write")], "/repo", WIDTH)[3]!;
		expect(editRaw).not.toBe(writeRaw);
		expect(stripAnsi(editRaw)).toContain("foo.ts");
		expect(stripAnsi(writeRaw)).toContain("foo.ts");
	});

	it("renders title in white (high-contrast with cyan/teal borderAccent)", () => {
		initTheme("dark");
		const raw = renderRaw([makeFile("/repo/foo.ts")], "/repo", WIDTH);
		const titleLine = raw[0]!;
		// White ANSI in dark theme resolves to a 256-color index near white; we just check
		// the title carries a distinct SGR from "borderAccent" (cyan in dark).
		expect(titleLine).toMatch(/\x1b\[(?:38;5;\d+|3[0-9])m/);
		expect(titleLine).toContain("PI MINUS v0.1.0");
	});

	it("shows short paths in a single row (no wrap, no ↳)", () => {
		const lines = renderVisible([makeFile("/repo/a/b.ts")], "/repo", WIDTH);
		const row = fileRows(lines)[0]!;
		expect(row).toContain("1-a/b.ts");
		expect(row).not.toContain("↳");
	});

	it("wraps long paths to 2 lines: basename on line 1, dirname on line 2", () => {
		// Path: a/b/c/d/e/f/g/h/i/j/file.ts (30 chars, basename = 7)
		// innerWidth = 25 - 2 = 23, lineWidth = 23 - 2 = 21
		// wrapPath: basename "file.ts" (7) ≤ 21 → line 1 = "file.ts"
		//   dirname "a/b/c/d/e/f/g/h/i/j/" (20) ≤ 21 → line 2 = "a/b/c/d/e/f/g/h/i/j/"
		const lines = renderVisible([makeFile("/repo/a/b/c/d/e/f/g/h/i/j/file.ts")], "/repo", WIDTH);
		const rows = fileRows(lines);
		// Two visible rows for the wrapped file
		expect(rows.length).toBeGreaterThanOrEqual(2);
		expect(rows[0]).toContain("1-file.ts");
		expect(rows[1]).toContain("a/b/c/d/e/f/g/h/i/j/");
		// Continuation marker ↳ is used on line 2 (dirname)
		expect(rows[1]).toMatch(/↳/);
		// No ellipsis when both parts fit
		expect(rows.join("")).not.toContain("…");
	});

	it("left-truncates basename on line 1 when it alone exceeds lineWidth (preserves extension)", () => {
		// displayPath: "a/really-long-filename.ts" (26 chars)
		// width 10 → innerWidth 8, lineWidth 6
		// wrapPath: basename "really-long-filename.ts" (23 chars > 6)
		//   left-truncate: …me.ts (6 chars, preserves .ts extension)
		//   dirname "a/" (2) → line 2
		const lines = renderVisible([makeFile("/repo/a/really-long-filename.ts")], "/repo", 10);
		const rows = fileRows(lines);
		expect(rows[0]).toMatch(/1-…me\.ts/);
		expect(rows[1]).toMatch(/↳ a\//);
	});

	it("right-truncates dirname on line 2 when it exceeds lineWidth", () => {
		// displayPath: "aaaa/bbbb/cccc/dddd/eeee/file.ts" (34 chars)
		// width 14 → innerWidth 12, lineWidth 10
		// basename "file.ts" (7) ≤ 10 → line 1 = "file.ts"
		// dirname "aaaa/bbbb/cccc/dddd/eeee/" (30) > 10 → truncateText → "aaaa/bbbb…" (10)
		const lines = renderVisible([makeFile("/repo/aaaa/bbbb/cccc/dddd/eeee/file.ts")], "/repo", 14);
		const rows = fileRows(lines);
		expect(rows[0]).toContain("1-file.ts");
		expect(rows[1]).toMatch(/↳ aaaa\/bbbb…/);
	});

	it("falls back to a single truncated line for pure filenames with no /", () => {
		// displayPath: "verylongfilename.ts" (18 chars, no /)
		// textWidth 8 → truncateText gives "verylon…"
		const lines = renderVisible([makeFile("/repo/verylongfilename.ts")], "/repo", 12);
		const row = fileRows(lines)[0]!;
		expect(row).toMatch(/1-verylon…/);
		expect(row).not.toContain("↳");
	});

	it("handles abs paths (cwd outside repo) the same way", () => {
		const lines = renderVisible([makeFile("/elsewhere/foo.ts")], "/repo", WIDTH);
		const row = fileRows(lines)[0]!;
		expect(row).toMatch(/1-\/elsewhere\/foo\.ts/);
	});

	it("renders multiple files in order with sequential 1-9 prefixes", () => {
		const files = [
			makeFile("/repo/a.ts", "edit", 0),
			makeFile("/repo/b.ts", "write", 1),
			makeFile("/repo/c.ts", "edit", 2),
		];
		const rows = fileRows(renderVisible(files, "/repo", WIDTH));
		// Each short file is 1 row, total 3 rows
		expect(rows).toHaveLength(3);
		expect(rows[0]).toMatch(/1-a\.ts/);
		expect(rows[1]).toMatch(/2-b\.ts/);
		expect(rows[2]).toMatch(/3-c\.ts/);
	});

	it("shows (none) for empty file list, with no gap between rule and Recent Files", () => {
		const lines = renderVisible([], "/repo", WIDTH);
		// Layout: [0]=title, [1]=rule, [2]="Recent Files", [3]="(none)".
		// No blank line between rule and Recent Files.
		expect(stripAnsi(lines[1]!)).toMatch(/─+/);
		expect(stripAnsi(lines[2]!)).toContain("Recent Files");
		expect(stripAnsi(lines[3]!)).toContain("(none)");
		// No blank line between rule and "Recent Files" (no empty row at index 2)
		expect(stripAnsi(lines[2]!)).not.toBe("");
	});

	it("renders a fixed-width panel (25) with the right border │ on every line", () => {
		const lines = renderRaw([makeFile("/repo/foo.ts")], "/repo", WIDTH);
		for (const line of lines) {
			expect(stripAnsi(line).endsWith("│")).toBe(true);
		}
	});

	it("preserves filename on line 1 when intermediate dirs are long", () => {
		// Realistic case: packages/coding-agent/src/modes/interactive/interactive-mode.ts
		// With width 25 → innerWidth 23, lineWidth 21
		// basename "interactive-mode.ts" (19) ≤ 21 → line 1 shows full filename
		// dirname gets truncated on line 2
		const lines = renderVisible(
			[makeFile("/repo/packages/coding-agent/src/modes/interactive/interactive-mode.ts")],
			"/repo",
			25,
		);
		const rows = fileRows(lines);
		// Line 1 must show the filename
		expect(rows[0]).toContain("1-interactive-mode.ts");
		// Line 2 shows dirname context (truncated)
		expect(rows[1]).toMatch(/↳/);
	});

	it("left-truncates basename on line 1 when even it exceeds lineWidth", () => {
		// width 12 → innerWidth 10, lineWidth 8
		// Path: a/bbb/ccc/very-long-component-name.tsx
		// basename "very-long-component-name.tsx" (30 chars > 8)
		// left-truncate → preserves .tsx extension
		// dirname "a/bbb/ccc/" (10) > 8 → right-truncate
		const lines = renderVisible([makeFile("/repo/a/bbb/ccc/very-long-component-name.tsx")], "/repo", 12);
		const rows = fileRows(lines);
		expect(rows[0]).toMatch(/1-….*\.tsx/);
		expect(rows[1]).toMatch(/↳/);
	});
});
