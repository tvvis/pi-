import path from "node:path";
import { type Component, sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import type { RecentFile } from "../sidebar-recent-files-store.ts";
import { theme } from "../theme/theme.ts";

export type { RecentFile };

const PAD_X = 1;

export class SidebarRecentFiles implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];
	private readonly getFiles: () => RecentFile[];
	private readonly cwd: string;
	private readonly getVersion: () => string;

	constructor(getFiles: () => RecentFile[], cwd: string, getVersion: () => string) {
		this.getFiles = getFiles;
		this.cwd = cwd;
		this.getVersion = getVersion;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}
		const lines = this.buildLines(width);
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	private buildLines(width: number): string[] {
		const pad = " ".repeat(PAD_X);
		const innerWidth = Math.max(1, width - PAD_X * 2);
		const rule = theme.fg("borderMuted", "─".repeat(innerWidth));

		const out: string[] = [];
		out.push(`${pad}${theme.fg("white", theme.bold(`PI MINUS v${this.getVersion()}`))}`);
		out.push(`${pad}${rule}`);

		const files = this.getFiles();
		out.push(`${pad}${theme.fg("muted", "Recent Files")}`);

		if (files.length === 0) {
			out.push(`${pad}${theme.fg("dim", "(none)")}`);
		} else {
			for (let i = 0; i < files.length; i++) {
				const file = files[i]!;
				const lines = this.formatRow(i + 1, file, pad, innerWidth);
				for (const line of lines) out.push(line);
			}
		}

		return out.map((line) => fitToWidth(line, width - 1)).map((line) => line + theme.fg("borderMuted", "│"));
	}

	private formatRow(index: number, file: RecentFile, pad: string, innerWidth: number): string[] {
		// Layout: 2 cols prefix. Digit is "highlight" (borderAccent) so it contrasts with the path.
		// edit/write share the prefix; path color signals the tool (edit=accent, write=success).
		// When path overflows the line, the row wraps to 2 lines: line 1 shows the basename
		// (most important — always visible, line is well-utilised), line 2 shows the dirname
		// (context, truncated if needed) with a `↳ ` indent matching the prefix width.
		const lineWidth = Math.max(1, innerWidth - 2);
		const displayPath = this.displayPath(file.absPath);
		const wrapped = wrapPath(displayPath, lineWidth);
		const pathColor = file.tool === "write" ? "success" : "accent";
		const firstPrefix = `${pad}${theme.fg("borderAccent", String(index))}${theme.fg("muted", "-")}`;
		const contIndent = `${pad}${theme.fg("muted", "↳ ")}`;

		if (wrapped.length === 1) {
			return [`${firstPrefix}${theme.fg(pathColor, wrapped[0]!)}`];
		}
		// wrapped = [basename, dirname] — basename on line 1, dirname on line 2
		return [`${firstPrefix}${theme.fg(pathColor, wrapped[0]!)}`, `${contIndent}${theme.fg(pathColor, wrapped[1]!)}`];
	}

	private displayPath(absPath: string): string {
		const rel = path.relative(this.cwd, absPath);
		if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
			return rel;
		}
		return absPath;
	}
}

function truncateText(text: string, maxWidth: number): string {
	if (visibleWidth(text) <= maxWidth) return text;
	const ellipsis = "…";
	const truncated = sliceByColumn(text, 0, Math.max(1, maxWidth - visibleWidth(ellipsis)));
	return truncated + ellipsis;
}

/** Truncate from the left, preserving the tail (useful for keeping file extensions). */
function truncateTextLeft(text: string, maxWidth: number): string {
	if (visibleWidth(text) <= maxWidth) return text;
	const ellipsis = "…";
	const keepWidth = Math.max(1, maxWidth - visibleWidth(ellipsis));
	const totalWidth = visibleWidth(text);
	const startCol = totalWidth - keepWidth;
	const truncated = sliceByColumn(text, startCol, keepWidth);
	return ellipsis + truncated;
}

/**
 * Wrap a path to fit a column. Returns 1 line if the path fits, 2 lines otherwise.
 *
 * When wrapping is needed, returns [basename, dirname]:
 * - Line 1 (basename): the filename — always visible, fills the line well.
 * - Line 2 (dirname): the directory portion — context, truncated from the right
 *   if needed. Left-truncation is used only for the basename when it alone
 *   exceeds textWidth, so the file extension is preserved.
 */
function wrapPath(text: string, textWidth: number): string[] {
	if (visibleWidth(text) <= textWidth) return [text];

	const lastSlash = text.lastIndexOf("/");
	if (lastSlash === -1) {
		return [truncateText(text, textWidth)];
	}

	const basename = text.slice(lastSlash + 1);
	const dirname = text.slice(0, lastSlash + 1); // keeps trailing /

	// Line 1: basename (most important). Left-truncate to preserve extension.
	const line1 = visibleWidth(basename) <= textWidth ? basename : truncateTextLeft(basename, textWidth);

	// Line 2: dirname (context). Right-truncate to show the path root.
	const line2 = visibleWidth(dirname) <= textWidth ? dirname : truncateText(dirname, textWidth);

	return [line1, line2];
}

function fitToWidth(line: string, width: number): string {
	const w = visibleWidth(line);
	if (w === width) return line;
	if (w > width) return sliceByColumn(line, 0, width);
	return line + " ".repeat(width - w);
}
