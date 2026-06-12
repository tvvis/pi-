import { Container, type Focusable, type TUI } from "@earendil-works/pi-tui";

export type AuthSelectorProvider = {
	id: string;
	name: string;
	authType: "api_key" | "oauth";
};

export class OAuthSelectorComponent extends Container implements Focusable {
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
	}

	constructor(_tui: TUI, _providers: AuthSelectorProvider[], _onSelect: (provider: AuthSelectorProvider) => void) {
		super();
	}
}
