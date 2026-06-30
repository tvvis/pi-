import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, parseSgrMouse, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class TestComponent implements Component {
	lines: string[] = [];
	handleInput = undefined as ((data: string) => void) | undefined;
	invalidate(): void {}
	render(_width: number): string[] {
		return this.lines;
	}
}

function getRows(terminal: VirtualTerminal, count: number): string[] {
	const out: string[] = [];
	for (let i = 0; i < count; i++) {
		// peek into xterm's buffer for row `i` of the visible viewport
		const xterm = (
			terminal as unknown as {
				xterm: {
					buffer: {
						active: {
							getLine: (i: number) => { translateToString: (trim: boolean) => string } | undefined;
							viewportY: number;
						};
					};
				};
			}
		).xterm;
		const line = xterm.buffer.active.getLine(xterm.buffer.active.viewportY + i);
		out.push(line ? line.translateToString(true) : "");
	}
	return out;
}

describe("TUI scrollable viewport", () => {
	it("shows the bottom of long content by default", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		component.lines = Array.from({ length: 10 }, (_, i) => `Line ${i}`);
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();

		assert.deepStrictEqual(getRows(terminal, 5), ["Line 5", "Line 6", "Line 7", "Line 8", "Line 9"]);
		assert.strictEqual(tui.getViewportTopOffset(), 0);
		assert.strictEqual(tui.isAtBottom(), true);
		assert.strictEqual(tui.getMaxViewportTopOffset(), 5);

		tui.stop();
	});

	it("scrollUp reveals older content; isAtBottom becomes false", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		component.lines = Array.from({ length: 10 }, (_, i) => `Line ${i}`);
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();

		tui.scrollUp(2);
		await terminal.waitForRender();
		assert.deepStrictEqual(getRows(terminal, 5), ["Line 3", "Line 4", "Line 5", "Line 6", "Line 7"]);
		assert.strictEqual(tui.getViewportTopOffset(), 2);
		assert.strictEqual(tui.isAtBottom(), false);

		tui.stop();
	});

	it("scrollUp is clamped at the top of the content", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		component.lines = Array.from({ length: 10 }, (_, i) => `Line ${i}`);
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();

		tui.scrollUp(100);
		await terminal.waitForRender();
		assert.deepStrictEqual(getRows(terminal, 5), ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4"]);
		assert.strictEqual(tui.getViewportTopOffset(), 5);
		assert.strictEqual(tui.getMaxViewportTopOffset(), 5);

		tui.stop();
	});

	it("scrollDown returns toward the bottom; scrollToBottom snaps to the tail", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		component.lines = Array.from({ length: 10 }, (_, i) => `Line ${i}`);
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();

		tui.scrollUp(4);
		await terminal.waitForRender();
		assert.deepStrictEqual(getRows(terminal, 5), ["Line 1", "Line 2", "Line 3", "Line 4", "Line 5"]);

		tui.scrollDown(2);
		await terminal.waitForRender();
		assert.deepStrictEqual(getRows(terminal, 5), ["Line 3", "Line 4", "Line 5", "Line 6", "Line 7"]);

		tui.scrollToBottom();
		await terminal.waitForRender();
		assert.deepStrictEqual(getRows(terminal, 5), ["Line 5", "Line 6", "Line 7", "Line 8", "Line 9"]);
		assert.strictEqual(tui.isAtBottom(), true);

		tui.stop();
	});

	it("keeps the user's anchor when new content is appended while scrolled up", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		component.lines = Array.from({ length: 10 }, (_, i) => `Line ${i}`);
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();

		tui.scrollUp(2);
		await terminal.waitForRender();
		// Visible: ["Line 3", "Line 4", "Line 5", "Line 6", "Line 7"]

		component.lines = [...component.lines, "Line 10", "Line 11", "Line 12"];
		tui.requestRender();
		await terminal.waitForRender();

		// The user is still anchored on the same content; only new content
		// has been added below the visible window.
		assert.deepStrictEqual(getRows(terminal, 5), ["Line 3", "Line 4", "Line 5", "Line 6", "Line 7"]);
		assert.strictEqual(tui.isAtBottom(), false);

		tui.stop();
	});

	it("auto-follows new content at the bottom when at the bottom", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		component.lines = Array.from({ length: 5 }, (_, i) => `Line ${i}`);
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();
		assert.deepStrictEqual(getRows(terminal, 5), ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4"]);

		component.lines = [...component.lines, "Line 5", "Line 6"];
		tui.requestRender();
		await terminal.waitForRender();
		assert.deepStrictEqual(getRows(terminal, 5), ["Line 2", "Line 3", "Line 4", "Line 5", "Line 6"]);
		assert.strictEqual(tui.isAtBottom(), true);

		tui.stop();
	});

	it("resets to auto-follow when content shrinks past the user's anchor", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		component.lines = Array.from({ length: 10 }, (_, i) => `Line ${i}`);
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();

		tui.scrollUp(8);
		await terminal.waitForRender();
		assert.strictEqual(tui.isAtBottom(), false);

		// Shrink the content to fewer lines than the anchor would need.
		component.lines = ["A", "B"];
		tui.requestRender();
		await terminal.waitForRender();

		assert.strictEqual(tui.isAtBottom(), true, "Shrink past the anchor should snap back to the bottom");
		assert.deepStrictEqual(getRows(terminal, 5), ["A", "B", "", "", ""]);

		tui.stop();
	});
});

describe("TUI mouse event dispatch", () => {
	it("parses SGR wheel up/down sequences", () => {
		const up = parseSgrMouse("\x1b[<64;20;10M");
		assert.deepStrictEqual(up, { kind: "wheel", direction: "up", x: 20, y: 10 });

		const down = parseSgrMouse("\x1b[<65;1;1M");
		assert.deepStrictEqual(down, { kind: "wheel", direction: "down", x: 1, y: 1 });
	});

	it("parses SGR press/release/move with button bits", () => {
		const press = parseSgrMouse("\x1b[<0;5;3M");
		assert.deepStrictEqual(press, { kind: "press", button: "left", x: 5, y: 3 });

		const release = parseSgrMouse("\x1b[<0;5;3m");
		assert.deepStrictEqual(release, { kind: "release", button: "left", x: 5, y: 3 });

		const middlePress = parseSgrMouse("\x1b[<1;5;3M");
		assert.deepStrictEqual(middlePress, { kind: "press", button: "middle", x: 5, y: 3 });

		const move = parseSgrMouse("\x1b[<32;5;3M");
		assert.deepStrictEqual(move, { kind: "move", button: "left", x: 5, y: 3 });
	});

	it("returns undefined for non-mouse input", () => {
		assert.strictEqual(parseSgrMouse("a"), undefined);
		assert.strictEqual(parseSgrMouse("\x1b[A"), undefined);
		assert.strictEqual(parseSgrMouse(""), undefined);
	});

	it("invokes onMouseWheel and never forwards the escape to the focused component", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		component.lines = Array.from({ length: 20 }, (_, i) => `Line ${i}`);
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		await terminal.waitForRender();

		let wheelCount = 0;
		let lastDirection: "up" | "down" | undefined;
		tui.onMouseWheel = (e) => {
			wheelCount += 1;
			lastDirection = e.direction;
		};

		// Track that the component never sees the raw SGR sequence by
		// monkey-patching its handleInput.
		let componentGotInput = false;
		const orig = component.handleInput;
		component.handleInput = (data) => {
			if (data.startsWith("\x1b[<")) componentGotInput = true;
			orig?.call(component, data);
		};

		terminal.sendInput("\x1b[<64;10;5M"); // wheel up
		terminal.sendInput("\x1b[<65;10;5M"); // wheel down

		assert.strictEqual(wheelCount, 2, "Both wheel events should reach the callback");
		assert.strictEqual(lastDirection, "down");
		assert.strictEqual(componentGotInput, false, "Focused component must not receive the raw SGR sequence");

		tui.stop();
	});

	it("invokes onMouseButton for press/release events", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		await terminal.waitForRender();

		const events: string[] = [];
		tui.onMouseButton = (e) => {
			if (e.kind === "wheel") return;
			events.push(`${e.kind}:${e.button}`);
		};

		terminal.sendInput("\x1b[<0;5;3M"); // left press
		terminal.sendInput("\x1b[<0;5;3m"); // left release

		assert.deepStrictEqual(events, ["press:left", "release:left"]);

		tui.stop();
	});

	it("does not call the mouse callbacks for non-mouse input", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		await terminal.waitForRender();

		let wheelCalls = 0;
		let buttonCalls = 0;
		tui.onMouseWheel = () => {
			wheelCalls += 1;
		};
		tui.onMouseButton = () => {
			buttonCalls += 1;
		};

		terminal.sendInput("hello");
		terminal.sendInput("\x1b[A"); // arrow up

		assert.strictEqual(wheelCalls, 0);
		assert.strictEqual(buttonCalls, 0);

		tui.stop();
	});
});

describe("TUI mouse tracking mode", () => {
	it("ProcessTerminal writes the SGR mouse enable sequences on start and disable on stop", async () => {
		const origIsTTY = (process.stdout as { isTTY?: boolean }).isTTY;
		(process.stdout as { isTTY?: boolean }).isTTY = true;
		const stdoutWrites: string[] = [];
		const origWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((data: string | Uint8Array, ...rest: unknown[]) => {
			stdoutWrites.push(typeof data === "string" ? data : data.toString());
			return (origWrite as (...a: unknown[]) => boolean)(data, ...rest);
		}) as typeof process.stdout.write;

		try {
			const { ProcessTerminal } = await import("../src/terminal.ts");
			const stdinListeners: Array<(data: string) => void> = [];
			const origOn = process.stdin.on.bind(process.stdin);
			process.stdin.on = ((event: string, listener: (...a: unknown[]) => void) => {
				if (event === "data") stdinListeners.push(listener as (data: string) => void);
				return (origOn as (...a: unknown[]) => unknown)(event, listener);
			}) as typeof process.stdin.on;

			// Reset kitty protocol detection so the start path runs.
			const { setKittyProtocolActive } = await import("../src/keys.ts");
			setKittyProtocolActive(false);

			const term = new ProcessTerminal();
			term.start(
				() => {},
				() => {},
			);
			await new Promise((r) => setTimeout(r, 200));
			term.stop();

			const allOut = stdoutWrites.join("");
			assert.ok(allOut.includes("\x1b[?1002h"), "should enable button-event tracking on start");
			assert.ok(allOut.includes("\x1b[?1006h"), "should enable SGR encoding on start");
			assert.ok(allOut.includes("\x1b[?1002l"), "should disable button-event tracking on stop");
			assert.ok(allOut.includes("\x1b[?1006l"), "should disable SGR encoding on stop");
		} finally {
			process.stdout.write = origWrite;
			(process.stdout as { isTTY?: boolean }).isTTY = origIsTTY;
		}
	});

	it("PI_TUI_NO_MOUSE=1 suppresses the mouse enable sequences", async () => {
		const origEnv = process.env.PI_TUI_NO_MOUSE;
		process.env.PI_TUI_NO_MOUSE = "1";
		const stdoutWrites: string[] = [];
		const origWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((data: string | Uint8Array, ...rest: unknown[]) => {
			stdoutWrites.push(typeof data === "string" ? data : data.toString());
			return (origWrite as (...a: unknown[]) => boolean)(data, ...rest);
		}) as typeof process.stdout.write;

		try {
			const { ProcessTerminal } = await import("../src/terminal.ts");
			const { setKittyProtocolActive } = await import("../src/keys.ts");
			setKittyProtocolActive(false);

			const term = new ProcessTerminal();
			term.start(
				() => {},
				() => {},
			);
			await new Promise((r) => setTimeout(r, 200));
			term.stop();

			const allOut = stdoutWrites.join("");
			assert.ok(!allOut.includes("\x1b[?1002h"), "PI_TUI_NO_MOUSE should suppress mouse enable");
			assert.ok(!allOut.includes("\x1b[?1006h"), "PI_TUI_NO_MOUSE should suppress SGR encoding");
		} finally {
			process.stdout.write = origWrite;
			if (origEnv === undefined) delete process.env.PI_TUI_NO_MOUSE;
			else process.env.PI_TUI_NO_MOUSE = origEnv;
		}
	});
});
