import { matchesKey, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
		terminal: { rows: 24, columns: 80 },
	} as unknown as TUI;
}

describe("CustomEditor home/end in input box", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		// keybindings are a global singleton
		setKeybindings(new KeybindingsManager());
	});

	it("moves the cursor to line start on Home and does not scroll the chat", () => {
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const editor = new CustomEditor(createFakeTui(), getEditorTheme(), keybindings);
		editor.focused = true;
		editor.setText("hello world");

		let scrollTopCalls = 0;
		let scrollBottomCalls = 0;
		editor.onAction("app.viewport.scrollTop", () => scrollTopCalls++);
		editor.onAction("app.viewport.scrollBottom", () => scrollBottomCalls++);

		// Move cursor to end with End, then Home should bring it to column 0.
		editor.handleInput("\x1b[F"); // End
		expect(editor.getCursor()).toEqual({ line: 0, col: 11 });
		editor.handleInput("\x1b[H"); // Home
		expect(editor.getCursor()).toEqual({ line: 0, col: 0 });

		expect(scrollTopCalls).toBe(0);
		expect(scrollBottomCalls).toBe(0);
	});

	it("moves the cursor to line end on End and does not scroll the chat", () => {
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const editor = new CustomEditor(createFakeTui(), getEditorTheme(), keybindings);
		editor.focused = true;
		editor.setText("hello world");

		let scrollTopCalls = 0;
		let scrollBottomCalls = 0;
		editor.onAction("app.viewport.scrollTop", () => scrollTopCalls++);
		editor.onAction("app.viewport.scrollBottom", () => scrollBottomCalls++);

		editor.handleInput("\x1b[F"); // End
		expect(editor.getCursor()).toEqual({ line: 0, col: 11 });

		expect(scrollTopCalls).toBe(0);
		expect(scrollBottomCalls).toBe(0);
	});

	it("still moves the cursor on Home/End when the editor spans multiple lines", () => {
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const editor = new CustomEditor(createFakeTui(), getEditorTheme(), keybindings);
		editor.focused = true;
		editor.setText("line1\nline-two\nline3");

		let scrollTopCalls = 0;
		let scrollBottomCalls = 0;
		editor.onAction("app.viewport.scrollTop", () => scrollTopCalls++);
		editor.onAction("app.viewport.scrollBottom", () => scrollBottomCalls++);

		// Move to line 1 ("line-two") explicitly. setText lands cursor at line 2 col 5,
		// so Up moves to line 1.
		editor.handleInput("\x1b[A"); // Up -> line 1 (line-two)
		expect(editor.getCursor().line).toBe(1);

		editor.handleInput("\x1b[F"); // End -> col 8 of line-two
		expect(editor.getCursor()).toEqual({ line: 1, col: 8 });

		editor.handleInput("\x1b[H"); // Home -> col 0 of line-two
		expect(editor.getCursor()).toEqual({ line: 1, col: 0 });

		editor.handleInput("\x1b[F"); // End -> col 8 of line-two
		expect(editor.getCursor()).toEqual({ line: 1, col: 8 });

		expect(scrollTopCalls).toBe(0);
		expect(scrollBottomCalls).toBe(0);
	});

	it("does not steal Home/End that an extension shortcut explicitly handles", () => {
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const editor = new CustomEditor(createFakeTui(), getEditorTheme(), keybindings);
		editor.focused = true;
		editor.setText("hello world");

		let scrollTopCalls = 0;
		let scrollBottomCalls = 0;
		editor.onAction("app.viewport.scrollTop", () => scrollTopCalls++);
		editor.onAction("app.viewport.scrollBottom", () => scrollBottomCalls++);

		let extensionHomeCalls = 0;
		editor.onExtensionShortcut = (data) => {
			if (matchesKey(data, "home")) {
				extensionHomeCalls++;
				return true;
			}
			return false;
		};

		editor.handleInput("\x1b[H"); // Home
		expect(extensionHomeCalls).toBe(1);
		expect(scrollTopCalls).toBe(0);

		editor.handleInput("\x1b[F"); // End -> editor (no extension handler)
		// Cursor stays at end of single line "hello world" (col 11)
		expect(editor.getCursor()).toEqual({ line: 0, col: 11 });
		expect(scrollBottomCalls).toBe(0);
	});

	it("still scrolls the chat on Home/End when the input box is empty", () => {
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const editor = new CustomEditor(createFakeTui(), getEditorTheme(), keybindings);
		editor.focused = true;
		// empty input: nothing to position the cursor in
		expect(editor.getText()).toBe("");

		let scrollTopCalls = 0;
		let scrollBottomCalls = 0;
		editor.onAction("app.viewport.scrollTop", () => scrollTopCalls++);
		editor.onAction("app.viewport.scrollBottom", () => scrollBottomCalls++);

		editor.handleInput("\x1b[H"); // Home
		expect(scrollTopCalls).toBe(1);
		expect(scrollBottomCalls).toBe(0);

		editor.handleInput("\x1b[F"); // End
		expect(scrollTopCalls).toBe(1);
		expect(scrollBottomCalls).toBe(1);
	});

	it("switches back to cursor positioning as soon as the input has text", () => {
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const editor = new CustomEditor(createFakeTui(), getEditorTheme(), keybindings);
		editor.focused = true;

		let scrollTopCalls = 0;
		let scrollBottomCalls = 0;
		editor.onAction("app.viewport.scrollTop", () => scrollTopCalls++);
		editor.onAction("app.viewport.scrollBottom", () => scrollBottomCalls++);

		// Empty input: Home scrolls.
		editor.handleInput("\x1b[H");
		expect(scrollTopCalls).toBe(1);

		// Type a character -> input is now non-empty.
		editor.handleInput("x");
		expect(editor.getText()).toBe("x");

		// Home now positions the cursor instead of scrolling.
		editor.handleInput("\x1b[H");
		expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
		expect(scrollTopCalls).toBe(1);

		editor.handleInput("\x1b[F");
		expect(editor.getCursor()).toEqual({ line: 0, col: 1 });
		expect(scrollBottomCalls).toBe(0);
	});

	it("treats only-typed-text as non-empty (typing-then-backspace falls back to scroll)", () => {
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const editor = new CustomEditor(createFakeTui(), getEditorTheme(), keybindings);
		editor.focused = true;

		let scrollTopCalls = 0;
		editor.onAction("app.viewport.scrollTop", () => scrollTopCalls++);

		// Type and then delete the character: input goes back to empty.
		editor.handleInput("x");
		editor.handleInput("\x7f"); // backspace
		expect(editor.getText()).toBe("");

		editor.handleInput("\x1b[H"); // Home -> scroll
		expect(scrollTopCalls).toBe(1);
	});

	it("treats whitespace-only input as empty and still scrolls on Home/End", () => {
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const editor = new CustomEditor(createFakeTui(), getEditorTheme(), keybindings);
		editor.focused = true;

		let scrollTopCalls = 0;
		let scrollBottomCalls = 0;
		editor.onAction("app.viewport.scrollTop", () => scrollTopCalls++);
		editor.onAction("app.viewport.scrollBottom", () => scrollBottomCalls++);

		// Only spaces, no real content.
		editor.handleInput("   ");
		expect(editor.getText()).toBe("   ");

		editor.handleInput("\x1b[H"); // Home -> scroll
		expect(scrollTopCalls).toBe(1);

		editor.handleInput("\x1b[F"); // End -> scroll
		expect(scrollBottomCalls).toBe(1);
	});

	it("switches to cursor positioning the moment a real character is typed among spaces", () => {
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const editor = new CustomEditor(createFakeTui(), getEditorTheme(), keybindings);
		editor.focused = true;

		let scrollTopCalls = 0;
		editor.onAction("app.viewport.scrollTop", () => scrollTopCalls++);

		editor.handleInput("  ");
		editor.handleInput("\x1b[H");
		expect(scrollTopCalls).toBe(1);

		// Now type a real character -> Home positions the cursor instead of scrolling.
		editor.handleInput("x");
		editor.handleInput("\x1b[H");
		expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
		expect(scrollTopCalls).toBe(1);
	});
});
