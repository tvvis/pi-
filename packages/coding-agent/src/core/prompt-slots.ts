/**
 * Named prompt slot registry.
 *
 * The user can override built-in system prompt sections (currently
 * `## Plan Mode` and `## Executing Plan`) by putting the corresponding
 * `## ` heading in their prompts file (see `loadPromptSlots`). The body
 * of that section becomes the slot content; missing sections are
 * silently omitted, so the slot list can grow without forcing every
 * user to update their file.
 *
 * Adding a new slot:
 *   1. Add an entry to {@link PROMPT_SLOTS} below (key → canonical
 *      heading text, used for matching and rendering).
 *   2. Read the body via `loadPromptSlots(...)[key]` in
 *      `buildSystemPrompt` (or wherever the slot is consumed) and
 *      emit it under the matching `## ` heading.
 *
 * Slot keys are namespaced by feature (e.g. `planMode`, `executePlan`)
 * to avoid collisions when more features land their own overrides.
 */

export const PROMPT_SLOTS = {
	planMode: "Plan Mode",
	executePlan: "Executing Plan",
} as const;

export type PromptSlotKey = keyof typeof PROMPT_SLOTS;

/** Canonical heading text for a given slot key. */
export function promptSlotHeading(key: PromptSlotKey): string {
	return PROMPT_SLOTS[key];
}

/**
 * Map of slotKey → user-authored body text (or undefined when the
 * file is missing or has no matching `## ` heading). Returned by
 * {@link loadPromptSlots}.
 */
export type PromptSlotMap = Readonly<Record<PromptSlotKey, string | undefined>>;

const VAR_PATTERN = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

/**
 * Substitute `${name}` placeholders in `template` using `vars`.
 *
 * Missing variables are left as-is (the literal `${name}` remains in the
 * output) so missing context never silently swallows user content. Names
 * follow JS identifier rules; no nested expressions or filters.
 */
export function substitutePromptVars(template: string, vars: Readonly<Record<string, string | undefined>>): string {
	return template.replace(VAR_PATTERN, (match, name: string) => {
		const value = vars[name];
		return value === undefined ? match : value;
	});
}

/**
 * Parse a prompts file into per-slot bodies.
 *
 * Each `## <heading>` line (case-insensitive, trimmed) starts a section;
 * section body runs until the next `## ` heading or end of file. The
 * first section whose heading matches a slot in {@link PROMPT_SLOTS}
 * (case-insensitive, exact match) populates that slot; repeated matches
 * keep the first one.
 *
 * Returns an object with every registered slot set to its body or
 * `undefined` when absent.
 */
export function parsePromptSlots(content: string): PromptSlotMap {
	const normalizeHeading = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();
	const headingsByLower = new Map<string, PromptSlotKey>();
	for (const [key, heading] of Object.entries(PROMPT_SLOTS) as Array<[PromptSlotKey, string]>) {
		headingsByLower.set(normalizeHeading(heading), key);
	}

	const result: Record<PromptSlotKey, string | undefined> = {
		planMode: undefined,
		executePlan: undefined,
	};

	const lines = content.split(/\r?\n/);
	let currentKey: PromptSlotKey | null = null;
	let buffer: string[] = [];

	const flush = (): void => {
		if (currentKey === null) return;
		const body = buffer.join("\n").replace(/^\n+|\s+$/g, "");
		if (result[currentKey] === undefined && body.length > 0) {
			result[currentKey] = body;
		}
		buffer = [];
	};

	for (const line of lines) {
		const match = line.match(/^##\s+(.+?)\s*$/);
		if (match) {
			flush();
			currentKey = headingsByLower.get(normalizeHeading(match[1]!)) ?? null;
			continue;
		}
		if (currentKey !== null) {
			buffer.push(line);
		}
	}
	flush();

	return result;
}
