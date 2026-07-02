/**
 * Plan confirmation popup.
 *
 * Shown when the model calls `plan({ready: true})`. The plan draft is
 * rendered in the chat by the plan tool (see `pushChatMarkdown`) before
 * the popup opens, so the popup only needs to present the three
 * choices:
 *
 *   1. 执行      — exit plan mode, write final plan, proceed
 *   2. 继续完善  — stay in plan mode, continue Q&A
 *   3. 新 session — clean new session, execute plan from draft
 *
 * The user navigates with ↑/↓ (or 1/2/3) and confirms with Enter. Esc
 * is treated as choice 2 (continue refining) so the plan is not lost.
 */

import { Container, type Focusable, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { theme } from "../theme/theme.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export type PlanChoice = 1 | 2 | 3;

const CHOICES: ReadonlyArray<{ key: PlanChoice; label: string; hint: string }> = [
	{ key: 1, label: "执行", hint: "exit plan mode, write final, execute" },
	{ key: 2, label: "继续完善", hint: "stay in plan mode, continue Q&A" },
	{ key: 3, label: "新 session", hint: "clean session, execute plan from draft" },
];

export interface PlanConfirmPopupOptions {
	/** Optional label shown above the choices. */
	title?: string;
}

export class PlanConfirmPopup extends Container implements Focusable {
	private selectedIndex = 1; // default to "继续完善" so a stray Enter never executes
	private onSubmitCallback: (choice: PlanChoice) => void;
	private listContainer: Container;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
	}

	constructor(_opts: PlanConfirmPopupOptions, onSubmit: (choice: PlanChoice) => void) {
		super();
		this.onSubmitCallback = onSubmit;
		this.listContainer = new Container();

		this.addChild(new Text(chalk.bold.cyan("Plan ready for review"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("1-3", "quick") +
					"  " +
					rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "confirm") +
					"  " +
					keyHint("tui.select.cancel", "refine"),
				1,
				0,
			),
		);

		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		for (let i = 0; i < CHOICES.length; i++) {
			const choice = CHOICES[i]!;
			const isSelected = i === this.selectedIndex;
			const marker = isSelected ? theme.fg("accent", "→ ") : "  ";
			const number = theme.fg("borderAccent", `${choice.key}.`);
			const labelText = isSelected ? theme.fg("accent", choice.label) : chalk.white(choice.label);
			const hint = theme.fg("muted", `  ${choice.hint}`);
			this.listContainer.addChild(new Text(`  ${marker}${number} ${labelText}${hint}`, 1, 0));
		}
	}

	private submit(choice: PlanChoice): void {
		this.onSubmitCallback(choice);
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();

		if (kb.matches(keyData, "tui.select.cancel")) {
			// Esc = continue refining (preserve the draft, do nothing destructive)
			this.submit(2);
			return;
		}

		if (/^[1-3]$/.test(keyData)) {
			const idx = Number.parseInt(keyData, 10) - 1;
			const choice = CHOICES[idx];
			if (choice) this.submit(choice.key);
			return;
		}

		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
			return;
		}
		if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(CHOICES.length - 1, this.selectedIndex + 1);
			this.updateList();
			return;
		}

		if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const choice = CHOICES[this.selectedIndex];
			if (choice) this.submit(choice.key);
		}
	}

	dispose(): void {
		// No-op for now
	}
}
