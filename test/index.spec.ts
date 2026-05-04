import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const TG_OWNER_ID = "10000000-0000-4000-8000-000000000001";
const TG_NEW_BOARD_ID = "20000000-0000-4000-8000-000000000002";

function assignTelegramEnv() {
	Object.assign(env as Record<string, string>, {
		TELEGRAM_WEBHOOK_SECRET: "tg-secret",
		TELEGRAM_BOT_TOKEN: "123456:ABC",
		TELEGRAM_INGEST_BOARD_OWNER_USER_ID: TG_OWNER_ID,
		SUPABASE_URL: "https://example.supabase.co",
		SUPABASE_SERVICE_ROLE_KEY: "service-role",
		VENICE_API_KEY: "venice-key",
		STRIPE_WEBHOOK_SECRET: "whsec_test_placeholder",
	});
}

describe("Hello World worker", () => {
	it("responds with Hello World! (unit style)", async () => {
		const request = new IncomingRequest("http://example.com");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(await response.text()).toMatchInlineSnapshot(`"Привет, мир!"`);
	});

	it("responds with Hello World! (integration style)", async () => {
		const response = await SELF.fetch("https://example.com");
		expect(await response.text()).toMatchInlineSnapshot(`"Привет, мир!"`);
	});
});

describe("POST /api/telegram-webhook", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns 401 when secret token header does not match", async () => {
		assignTelegramEnv();
		const ctx = createExecutionContext();
		const request = new IncomingRequest(
			"http://example.com/api/telegram-webhook",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Telegram-Bot-Api-Secret-Token": "wrong",
				},
				body: JSON.stringify({
					message: { chat: { id: 1 }, text: "hello" },
				}),
			},
		);
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it("returns 400 when body is not JSON", async () => {
		assignTelegramEnv();
		const ctx = createExecutionContext();
		const request = new IncomingRequest(
			"http://example.com/api/telegram-webhook",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Telegram-Bot-Api-Secret-Token": "tg-secret",
				},
				body: "not-json",
			},
		);
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
	});

	it("returns OK immediately and completes LLM / RPC ingest / Telegram via waitUntil", async () => {
		assignTelegramEnv();
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			async (
				input: RequestInfo | URL,
				init?: RequestInit,
			): Promise<Response> => {
				const url =
					typeof input === "string"
						? input
						: input instanceof URL
							? input.href
							: input.url;

				const method =
					input instanceof Request ? input.method : (init?.method ?? "GET");

				if (url.includes("api.venice.ai")) {
					return new Response(
						JSON.stringify({
							choices: [
								{
									message: {
										content: JSON.stringify({
											board_title: "Sprint planning",
											subtasks: [
												{ title: "One", task: "First step" },
												{ title: "Two", task: "Second step" },
											],
										}),
									},
								},
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (url.includes("/rpc/telegram_ingest_board_and_tasks")) {
					if (method === "POST") {
						return new Response(
							JSON.stringify({
								board_id: TG_NEW_BOARD_ID,
								tasks_created: 2,
							}),
							{
								status: 200,
								headers: { "Content-Type": "application/json" },
							},
						);
					}
				}

				if (url.includes("api.telegram.org")) {
					return new Response(JSON.stringify({ ok: true }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}

				return new Response(`unexpected fetch: ${url}`, { status: 500 });
			},
		);

		const ctx = createExecutionContext();
		const request = new IncomingRequest(
			"http://example.com/api/telegram-webhook",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Telegram-Bot-Api-Secret-Token": "tg-secret",
				},
				body: JSON.stringify({
					message: { chat: { id: 999 }, text: "Plan my sprint" },
				}),
			},
		);

		const response = await worker.fetch(request, env, ctx);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("OK");

		await waitOnExecutionContext(ctx);

		const urls = fetchSpy.mock.calls.map((c) =>
			typeof c[0] === "string"
				? c[0]
				: c[0] instanceof URL
					? c[0].href
					: (c[0] as Request).url,
		);

		const rpcCallBody = fetchSpy.mock.calls.find((c) => {
			const u =
				typeof c[0] === "string"
					? c[0]
					: c[0] instanceof URL
						? c[0].href
						: (c[0] as Request).url;
			return u.includes("/rpc/telegram_ingest_board_and_tasks");
		})?.[1] as RequestInit | undefined;
		expect(rpcCallBody?.body).toBeDefined();
		expect(
			JSON.parse(String(rpcCallBody!.body)).p_board_title,
		).toBe("Sprint planning");

		expect(urls.some((u) => u.includes("api.venice.ai"))).toBe(true);
		expect(
			urls.some((u) => u.includes("/rpc/telegram_ingest_board_and_tasks")),
		).toBe(true);
		expect(urls.some((u) => u.includes("api.telegram.org"))).toBe(true);
	});

	it("returns OK without calling Venice when message has no text", async () => {
		assignTelegramEnv();
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		const ctx = createExecutionContext();
		const request = new IncomingRequest(
			"http://example.com/api/telegram-webhook",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Telegram-Bot-Api-Secret-Token": "tg-secret",
				},
				body: JSON.stringify({
					message: { chat: { id: 1 } },
				}),
			},
		);

		const response = await worker.fetch(request, env, ctx);
		expect(response.status).toBe(200);
		await waitOnExecutionContext(ctx);

		const urls = fetchSpy.mock.calls.map((c) =>
			typeof c[0] === "string"
				? c[0]
				: c[0] instanceof URL
					? c[0].href
					: (c[0] as Request).url,
		);
		expect(urls.some((u) => u.includes("api.venice.ai"))).toBe(false);
	});
});
