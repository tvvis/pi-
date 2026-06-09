/**
 * Combined selector + text input for the ask tool.
 *
 * Shows a list of options above a text input field. The user can either:
 * - Use ↑/↓ to highlight an option and Enter to select it
 * - Type a custom answer and press Enter
 * - Type a number (1-9) to quick-select the corresponding option
 */

import { Container, type Focusable, getKeybindings, Input, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export interface AskSelectorOptions {
	tui?: TUI;
}

export class AskSelectorComponent extends Container implements Focusable {
	private options: string[];
	private input: Input;
	private selectedIndex = 0;
	private onSubmitCallback: (value: string) => void;
	private onCancelCallback: () => void;
	private listContainer: Container;
	private inputContainer: Container;

	// Focusable implementation
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		question: string,
		options: string[],
		onSubmit: (value: string) => void,
		onCancel: () => void,
		_opts?: AskSelectorOptions,
	) {
		super();

		this.options = options;
		this.onSubmitCallback = onSubmit;
		this.onCancelCallback = onCancel;

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(question)), 1, 0));
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));

		this.inputContainer = new Container();
		this.addChild(this.inputContainer);
		this.input = new Input();
		this.inputContainer.addChild(this.input);

		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "select") +
					"  " +
					rawKeyHint("type", "custom") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));

		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		if (this.options.length === 0) {
			return;
		}
		for (let i = 0; i < this.options.length; i++) {
			const isSelected = i === this.selectedIndex;
			const marker = isSelected ? theme.fg("accent", "→ ") : "  ";
			const number = theme.fg("muted", `${i + 1}.`);
			const label = isSelected ? theme.fg("accent", this.options[i]) : this.options[i];
			this.listContainer.addChild(new Text(`${marker}${number} ${label}`, 1, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();

		// Esc cancels
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
			return;
		}

		// When the input has text, give it all key input (except navigation that we override)
		const inputText = this.input.getValue();

		// Number key 1-9 for quick-select
		if (inputText === "" && /^[1-9]$/.test(keyData)) {
			const idx = Number.parseInt(keyData, 10) - 1;
			if (idx >= 0 && idx < this.options.length) {
				this.onSubmitCallback(this.options[idx]);
				return;
			}
		}

		// Up/Down for navigation — only meaningful when input is empty
		if (inputText === "" && this.options.length > 0) {
			if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
				this.selectedIndex = Math.max(0, this.selectedIndex - 1);
				this.updateList();
				return;
			}
			if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
				this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
				this.updateList();
				return;
			}
		}

		// Enter submits
		if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const text = this.input.getValue().trim();
			if (text) {
				this.onSubmitCallback(text);
			} else if (this.options.length > 0) {
				const opt = this.options[this.selectedIndex];
				if (opt) this.onSubmitCallback(opt);
			} else {
				this.onCancelCallback();
			}
			return;
		}

		// Otherwise, forward to the input field
		this.input.handleInput(keyData);
	}

	dispose(): void {
		// No-op
	}
}
