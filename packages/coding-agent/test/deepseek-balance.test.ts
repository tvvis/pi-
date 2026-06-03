import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchDeepSeekBalance, formatDeepSeekBalanceForFooter } from "../src/core/deepseek-balance.ts";

const ORIGINAL_FETCH = globalThis.fetch;

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
	return new Response(JSON.stringify(body), {
		status: init.status ?? 200,
		headers: { "content-type": "application/json" },
	});
}

describe("fetchDeepSeekBalance", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		globalThis.fetch = ORIGINAL_FETCH;
	});

	it("returns parsed balance on a successful 2xx response", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse({
				is_available: true,
				balance_infos: [
					{
						currency: "CNY",
						total_balance: "50.00",
						granted_balance: "10.00",
						topped_up_balance: "40.00",
					},
				],
			}),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const promise = fetchDeepSeekBalance("sk-test", "https://api.deepseek.com/");
		await vi.runAllTimersAsync();
		const result = await promise;

		expect(result).toEqual({ available: "40.00", total: "50.00", currency: "CNY" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://api.deepseek.com/user/balance");
		expect((init as RequestInit).method).toBe("GET");
		expect((init as RequestInit).headers).toMatchObject({
			Accept: "application/json",
			Authorization: "Bearer sk-test",
		});
	});

	it("falls back to granted_balance when topped_up_balance is absent", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			jsonResponse({
				is_available: true,
				balance_infos: [{ currency: "USD", total_balance: "10.00", granted_balance: "10.00" }],
			}),
		) as unknown as typeof fetch;

		const promise = fetchDeepSeekBalance("sk", "https://api.deepseek.com");
		await vi.runAllTimersAsync();
		expect(await promise).toEqual({ available: "10.00", total: "10.00", currency: "USD" });
	});

	it("returns null when balance_infos is empty or missing", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ is_available: true })) as unknown as typeof fetch;

		const promise = fetchDeepSeekBalance("sk", "https://api.deepseek.com");
		await vi.runAllTimersAsync();
		expect(await promise).toBeNull();
	});

	it("returns null when total_balance is missing", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(
				jsonResponse({ is_available: true, balance_infos: [{ currency: "CNY" }] }),
			) as unknown as typeof fetch;

		const promise = fetchDeepSeekBalance("sk", "https://api.deepseek.com");
		await vi.runAllTimersAsync();
		expect(await promise).toBeNull();
	});

	it("returns null on non-2xx", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(jsonResponse({ error: "auth" }, { status: 401 })) as unknown as typeof fetch;

		const promise = fetchDeepSeekBalance("sk", "https://api.deepseek.com");
		await vi.runAllTimersAsync();
		expect(await promise).toBeNull();
	});

	it("returns null on network errors", async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;

		const promise = fetchDeepSeekBalance("sk", "https://api.deepseek.com");
		await vi.runAllTimersAsync();
		expect(await promise).toBeNull();
	});

	it("returns null when the response body is not valid JSON", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(new Response("not json", { status: 200 })) as unknown as typeof fetch;

		const promise = fetchDeepSeekBalance("sk", "https://api.deepseek.com");
		await vi.runAllTimersAsync();
		expect(await promise).toBeNull();
	});
});

describe("formatDeepSeekBalanceForFooter", () => {
	it("formats a valid balance as `<amount> <currency>`", () => {
		expect(formatDeepSeekBalanceForFooter({ available: "12.345", total: "50", currency: "USD" })).toBe("12.35 USD");
	});

	it("returns null when the amount is not a finite number", () => {
		expect(formatDeepSeekBalanceForFooter({ available: "abc", total: "0", currency: "USD" })).toBeNull();
	});
});
