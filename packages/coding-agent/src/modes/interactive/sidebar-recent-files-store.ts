import type { SessionManager } from "../../core/session-manager.ts";

/** Custom entry type identifier used to persist sidebar recent files in the session. */
export const SIDEBAR_RECENT_FILES_CUSTOM_TYPE = "sidebar-recent-files";

/** Shape of a sidebar recent file record. */
export type RecentFile = {
	/** Absolute path used when opening the file. */
	absPath: string;
	/** Last time this file was edited or written, in epoch ms. */
	lastTouchedAt: number;
	/** Most recent tool that touched this file. */
	tool: "edit" | "write";
};

/** Max number of recent files kept in the sidebar (and persisted per session). */
export const MAX_RECENT_FILES = 9;

/** Payload shape stored under `CustomEntry.data`. */
interface RecentFilesPayload {
	files: RecentFile[];
}

function isRecentFile(value: unknown): value is RecentFile {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.absPath === "string" &&
		(v.tool === "edit" || v.tool === "write") &&
		(typeof v.lastTouchedAt === "number" || typeof v.lastTouchedAt === "undefined")
	);
}

/**
 * Load the latest sidebar recent files list from the session, walking the
 * current branch from leaf to root and taking the most recent custom entry
 * of our type.
 *
 * Returns an empty array if the session has no entry, the entry is malformed,
 * or the current branch has never recorded a file.
 */
export function loadRecentFiles(sessionManager: SessionManager): RecentFile[] {
	const branch = sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (!entry || entry.type !== "custom") continue;
		if (entry.customType !== SIDEBAR_RECENT_FILES_CUSTOM_TYPE) continue;
		const data = entry.data as RecentFilesPayload | undefined;
		if (!data || !Array.isArray(data.files)) continue;
		const files: RecentFile[] = [];
		for (const candidate of data.files) {
			if (!isRecentFile(candidate)) continue;
			files.push({
				absPath: candidate.absPath,
				lastTouchedAt: typeof candidate.lastTouchedAt === "number" ? candidate.lastTouchedAt : 0,
				tool: candidate.tool,
			});
			if (files.length >= MAX_RECENT_FILES) break;
		}
		return files;
	}
	return [];
}

/**
 * Persist the sidebar recent files list as a custom entry on the current
 * leaf. No-op when the session is in-memory.
 */
export function persistRecentFiles(sessionManager: SessionManager, files: RecentFile[]): void {
	if (!sessionManager.isPersisted()) return;
	const payload: RecentFilesPayload = { files };
	sessionManager.appendCustomEntry(SIDEBAR_RECENT_FILES_CUSTOM_TYPE, payload);
}
