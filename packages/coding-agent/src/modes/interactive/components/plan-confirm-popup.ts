/**
 * Plan confirmation popup.
 *
 * Shown when the model calls `plan({ready: true})`. Renders the plan
 * draft (read from `~/.pi/draft/<session-id>/current.md`) above a row
 * of three choices:
 *
 *   1. 执行      — exit plan mode, write final plan, proceed
 *   2. 继续完善  — stay in plan mode, continue Q&A
 *   3. 新 session — fork to a new session in execute mode
 *
 * The user navigates with ↑/↓ (or 1/2/3) and confirms with Enter. Esc
 * is treated as choice 2 (continue refining) so the plan is not lost.
 */

import { readFile } from "node:fs/promises";
import { Container, type Focusable, getKeybindings, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { theme } from "../theme/theme.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export type PlanChoice = 1 | 2 | 3;

const CHOICES: ReadonlyArray<{ key: PlanChoice; label: string; hint: string }> = [
	{ key: 1, label: "执行", hint: "exit plan mode, write final, execute" },
	{ key: 2, label: "继续完善", hint: "stay in plan mode, continue Q&A" },
	{ key: 3, label: "新 session", hint: "fork to a new session, execute there" },
];

const POPUP_INNER_WIDTH = 80;

const MAX_PLAN_LINES = 18; // long plans get clipped; scrollable view is future work

export interface PlanConfirmPopupOptions {
	/** Absolute path to the draft file (e.g. ~/.pi/draft/<sid>/current.md). */
	draftPath: string;
	/** Resolved plan text. If provided, skips the readFile() call. */
	planText?: string;
}

export class PlanConfirmPopup extends Container implements Focusable {
	private selectedIndex = 1; // default to "继续完善" so a stray Enter never executes
	private onSubmitCallback: (choice: PlanChoice) => void;
	private planContent = "";
	private planEmpty = true;
	private listContainer: Container;
	private draftPath: string;
	private loadError: string | undefined;
	private preloadedText: string | undefined;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
	}

	constructor(opts: PlanConfirmPopupOptions, onSubmit: (choice: PlanChoice) => void) {
		super();
		this.onSubmitCallback = onSubmit;
		this.draftPath = opts.draftPath;
		this.preloadedText = opts.planText;

		this.addChild(new Text(chalk.bold.cyan("Plan ready for review"), 1, 0));
		this.addChild(new Text(theme.fg("muted", `Draft: ${this.draftPath}`), 1, 0));
		this.addChild(new Spacer(1));
		// Body / list / hints are added in finishRender() once the draft is loaded.
		this.listContainer = new Container();
	}

	/**
	 * Async load the draft and finalize the popup layout. Call right
	 * after the popup is constructed.
	 */
	async finishRender(tui: { invalidate: () => void; requestRender: () => void }): Promise<void> {
		if (this.preloadedText !== undefined) {
			this.planContent = this.preloadedText;
			this.planEmpty = this.planContent.trim().length === 0;
		} else {
			try {
				const text = await readFile(this.draftPath, "utf-8");
				this.planContent = text;
				this.planEmpty = text.trim().length === 0;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException)?.code;
				if (code === "ENOENT") {
					this.planEmpty = true;
					this.planContent = "";
				} else {
					this.loadError = error instanceof Error ? error.message : String(error);
				}
			}
		}

		if (this.loadError !== undefined) {
			this.addChild(new Text(theme.fg("error", `Failed to read draft: ${this.loadError}`), 1, 0));
		} else if (this.planEmpty) {
			this.addChild(new Text(theme.fg("warning", "(Plan is empty — refine before confirming.)"), 1, 0));
		} else {
			const lines = this.planContent.split("\n");
			const shown = lines.slice(0, MAX_PLAN_LINES);
			for (const line of shown) {
				this.addChild(new Text(truncateToWidth(line, POPUP_INNER_WIDTH), 1, 0));
			}
			if (lines.length > MAX_PLAN_LINES) {
				this.addChild(
					new Text(
						theme.fg("muted", `... (${lines.length - MAX_PLAN_LINES} more lines, total ${lines.length})`),
						1,
						0,
					),
				);
			}
		}

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
		tui.invalidate();
		tui.requestRender();
	}

	private updateList(): void {
		this.listContainer.clear();
		for (let i = 0; i < CHOICES.length; i++) {
			const choice = CHOICES[i]!;
			const isSelected = i === this.selectedIndex;
			const isDisabled = this.planEmpty && choice.key === 1;
			const marker = isSelected ? theme.fg("accent", "→ ") : "  ";
			const number = theme.fg(isDisabled ? "muted" : "borderAccent", `${choice.key}.`);
			const labelText = isDisabled
				? theme.fg("muted", `${choice.label} (disabled — empty plan)`)
				: isSelected
					? theme.fg("accent", choice.label)
					: chalk.white(choice.label);
			const hint = theme.fg("muted", `  ${choice.hint}`);
			this.listContainer.addChild(new Text(`  ${marker}${number} ${labelText}${hint}`, 1, 0));
		}
	}

	private submit(choice: PlanChoice): void {
		if (this.planEmpty && choice === 1) return;
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
