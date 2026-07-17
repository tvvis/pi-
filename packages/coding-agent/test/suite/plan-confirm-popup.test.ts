/**
 * Unit tests for the simplified PlanConfirmPopup.
 *
 * The popup is a pure UI component: it shows the 4 options and forwards
 * keyboard input. After the B block simplification it no longer reads
 * the draft file, has no `MAX_PLAN_LINES` cap, and the 4 options are
 * always available (no "execute" disabling for empty drafts — the
 * plan tool surfaces empty/missing drafts in the chat instead).
 */

import { describe, expect, it } from "vitest";
import { type PlanChoice, PlanConfirmPopup } from "../../src/modes/interactive/components/plan-confirm-popup.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

initTheme("dark");

function makePopup() {
	const submitted: PlanChoice[] = [];
	const popup = new PlanConfirmPopup({}, (choice) => {
		submitted.push(choice);
	});
	return { popup, submitted };
}

describe("PlanConfirmPopup (simplified)", () => {
	it("renders 4 options without reading any file", () => {
		const { popup } = makePopup();
		// Just check we can render and don't throw; no file IO happened.
		const lines = popup.render(80);
		expect(lines.length).toBeGreaterThan(0);
		// No "failed to read" or "Plan is empty" messages.
		const flat = lines.join("\n");
		expect(flat).not.toContain("Failed to read");
		expect(flat).not.toContain("Plan is empty");
		// All 4 choice labels appear.
		expect(flat).toContain("执行");
		expect(flat).toContain("继续完善");
		expect(flat).toContain("新 session");
		expect(flat).toContain("队列");
	});

	it("default selection is choice 2 (继续完善) so a stray Enter never executes", () => {
		const { popup, submitted } = makePopup();
		popup.handleInput("\n"); // Enter
		expect(submitted).toEqual([2]);
	});

	it("keys 1/2/3/4 select the corresponding choice", () => {
		for (const expected of [1, 2, 3, 4] as const) {
			const { popup, submitted } = makePopup();
			popup.handleInput(String(expected));
			expect(submitted).toEqual([expected]);
		}
	});

	it("Esc maps to choice 2 (refine)", () => {
		const { popup, submitted } = makePopup();
		// Send the Esc byte directly to avoid coupling to keybinding config.
		popup.handleInput("\x1b");
		expect(submitted).toEqual([2]);
	});

	it("arrow down from default (index 1) lands on choice 3", () => {
		const { popup, submitted } = makePopup();
		popup.handleInput("\x1b[B"); // down arrow
		popup.handleInput("\n");
		expect(submitted).toEqual([3]);
	});

	it("arrow up from default (index 1) lands on choice 1", () => {
		const { popup, submitted } = makePopup();
		popup.handleInput("\x1b[A"); // up arrow
		popup.handleInput("\n");
		expect(submitted).toEqual([1]);
	});

	it("arrow up at the top (index 0) stays at the top — Enter confirms choice 1", () => {
		const { popup, submitted } = makePopup();
		popup.handleInput("\x1b[A"); // up arrow: index 1 -> 0
		popup.handleInput("\x1b[A"); // up arrow at top: stays at 0
		popup.handleInput("\n");
		expect(submitted).toEqual([1]);
	});

	it("arrow down at the bottom (index 3) stays at the bottom — Enter confirms choice 4", () => {
		const { popup, submitted } = makePopup();
		popup.handleInput("\x1b[B"); // down: index 1 -> 2
		popup.handleInput("\x1b[B"); // down: index 2 -> 3
		popup.handleInput("\x1b[B"); // down at bottom: stays at 3
		popup.handleInput("\n");
		expect(submitted).toEqual([4]);
	});

	it("does not call onSubmit when the key is unhandled", () => {
		const { popup, submitted } = makePopup();
		popup.handleInput("z");
		popup.handleInput("x");
		popup.handleInput("hello");
		expect(submitted).toEqual([]);
	});
});
