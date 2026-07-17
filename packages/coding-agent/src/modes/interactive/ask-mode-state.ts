/**
 * Ask mode state.
 *
 * Tracks whether the agent is in ask mode. In ask mode the agent acts as a
 * pure Q&A assistant: no file, bash, edit, or write tools are available.
 *
 * State is intentionally module-level and session-scoped: it is set when the
 * user enters ask mode and cleared when they exit or the session is unloaded.
 * It is NOT persisted to the session file.
 */

export interface AskModeState {
	active: true;
	enteredAt: number;
}

let currentState: AskModeState | null = null;

export function getAskModeState(): AskModeState | null {
	return currentState;
}

export function isInAskMode(): boolean {
	return currentState?.active === true;
}

export function enterAskMode(): AskModeState {
	currentState = {
		active: true,
		enteredAt: Date.now(),
	};
	return currentState;
}

export function exitAskMode(): void {
	currentState = null;
}
