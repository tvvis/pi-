import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("../src/core/deepseek-balance.ts", () => ({
	fetchDeepSeekBalance: fetchMock,
}));

// Import after the mock so InteractiveMode picks up the stubbed module.
const { InteractiveMode } = await import("../src/modes/interactive/interactive-mode.ts");

function createFakeThis() {
	const fake: any = Object.create(InteractiveMode.prototype);
	fake.lastDeepSeekBalanceRefreshAt = 0;
	const session = {
		state: {
			model: { provider: "deepseek", baseUrl: "https://api.deepseek.com" },
		},
		modelRegistry: {
			getApiKeyForProvider: vi.fn().mockResolvedValue("sk-test"),
		},
	};
	fake.runtimeHost = { session };
	fake.footerDataProvider = {
		setDeepSeekBalance: vi.fn(),
	};
	// Expose for assertions.
	(fake as any)._session = session;
	return fake;
}

function callRefresh(fake: any, now: number) {
	const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now);
	try {
		fake.refreshDeepSeekBalance();
	} finally {
		dateSpy.mockRestore();
	}
}

async function drainMicrotasks() {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("InteractiveMode.refreshDeepSeekBalance throttling", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.PI_OFFLINE;
	});

	afterEach(() => {
		delete process.env.PI_OFFLINE;
	});

	test("fetches on the first call, then skips within 120s", async () => {
		const fake = createFakeThis();
		fetchMock.mockResolvedValue({ available: "1", total: "1", currency: "USD" });

		callRefresh(fake, 1_000_000);
		await drainMicrotasks();

		callRefresh(fake, 1_030_000); // 30s later — within window
		await drainMicrotasks();

		callRefresh(fake, 1_120_000); // 120s later — at the boundary
		await drainMicrotasks();

		expect(fake._session.modelRegistry.getApiKeyForProvider).toHaveBeenCalledTimes(2);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	test("fetches again after 120s have elapsed", async () => {
		const fake = createFakeThis();
		fetchMock.mockResolvedValue({ available: "1", total: "1", currency: "USD" });

		callRefresh(fake, 1_000_000);
		await drainMicrotasks();

		callRefresh(fake, 1_120_001); // just past the window
		await drainMicrotasks();

		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	test("is a no-op for non-deepseek models", async () => {
		const fake = createFakeThis();
		fake.session.state.model.provider = "openai";

		callRefresh(fake, 1_000_000);
		await drainMicrotasks();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(fake._session.modelRegistry.getApiKeyForProvider).not.toHaveBeenCalled();
	});

	test("is a no-op when PI_OFFLINE is set", async () => {
		process.env.PI_OFFLINE = "1";
		const fake = createFakeThis();

		callRefresh(fake, 1_000_000);
		await drainMicrotasks();

		expect(fetchMock).not.toHaveBeenCalled();
	});
});
