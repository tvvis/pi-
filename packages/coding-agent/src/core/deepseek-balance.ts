/**
 * DeepSeek account balance lookup.
 *
 * Hits GET https://api.deepseek.com/user/balance with the provider's API key
 * and parses the response. Used to surface the remaining credit in the
 * interactive footer. Failures (network, auth, parsing) resolve to null so
 * callers can show a placeholder without disturbing the main loop.
 *
 * Keep the surface small: callers fire-and-forget, then read the cached
 * value via FooterDataProvider.
 */

const DEEPSEEK_BALANCE_PATH = "/user/balance";
const DEFAULT_BALANCE_TIMEOUT_MS = 5_000;

export type DeepSeekBalance = {
	/** Available credit remaining, as a stringified decimal in `currency` units. */
	available: string;
	/** Topped-up total balance if the account distinguishes it, otherwise equal to `available`. */
	total: string;
	/** ISO currency code reported by DeepSeek (e.g. "USD"). */
	currency: string;
};

type DeepSeekBalanceInfo = {
	currency?: string;
	total_balance?: string | number;
	granted_balance?: string | number;
	topped_up_balance?: string | number;
};

type DeepSeekBalanceResponse = {
	is_available?: boolean;
	balance_infos?: DeepSeekBalanceInfo[];
};

/**
 * Fetch the DeepSeek account balance. Resolves to null on any failure
 * (timeout, non-2xx, non-JSON, missing fields, account with no balance info)
 * so callers can treat all errors the same and just leave the footer placeholder.
 */
export async function fetchDeepSeekBalance(
	apiKey: string,
	baseUrl: string,
	signal?: AbortSignal,
): Promise<DeepSeekBalance | null> {
	const url = new URL(DEEPSEEK_BALANCE_PATH, baseUrl).toString();

	const timeoutSignal = AbortSignal.timeout(DEFAULT_BALANCE_TIMEOUT_MS);
	const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	let response: Response;
	try {
		response = await fetch(url, {
			method: "GET",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			signal: combinedSignal,
		});
	} catch {
		// Network error, abort, or timeout. Treat as no-data.
		return null;
	}

	if (!response.ok) {
		return null;
	}

	let body: DeepSeekBalanceResponse;
	try {
		body = (await response.json()) as DeepSeekBalanceResponse;
	} catch {
		return null;
	}

	// DeepSeek returns one entry per currency the account holds. If the account
	// has none (new account, no top-up, etc.) bail with null.
	const info = body.balance_infos?.[0];
	if (!info) {
		return null;
	}

	const total = info.total_balance;
	const currency = info.currency;
	if (total === undefined || total === "" || !currency) {
		return null;
	}

	// Prefer topped-up over granted; both are summed as the available spend.
	const available = info.topped_up_balance ?? info.granted_balance ?? total;
	if (available === undefined || available === "") {
		return null;
	}

	return {
		available: String(available),
		total: String(total),
		currency,
	};
}

/**
 * Format a balance for one-line footer display. Returns null when the
 * amount cannot be parsed (e.g. non-numeric string) so the caller can
 * fall back to a placeholder instead of printing garbage.
 */
export function formatDeepSeekBalanceForFooter(balance: DeepSeekBalance): string | null {
	const amount = Number.parseFloat(balance.available);
	if (!Number.isFinite(amount)) return null;
	return `${amount.toFixed(2)} ${balance.currency}`;
}
