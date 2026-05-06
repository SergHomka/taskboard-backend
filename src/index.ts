/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import {
	decomposeUserTask,
	sendLlmRequest,
	type ChatMessage,
} from "./llm";
import {
	listDifyDatasets,
	retrieveDifyDataset,
	type RetrieveDifyDatasetOptions,
} from "./difyRetrieve";
import { handleStripeWebhook } from "./stripeWebhook";
import { handleTelegramWebhook } from "./telegramWebhook";

const corsHeaders: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

function jsonWithCors(data: unknown, init?: ResponseInit): Response {
	const headers = new Headers(init?.headers);
	for (const [k, v] of Object.entries(corsHeaders)) {
		headers.set(k, v);
	}
	headers.set("Content-Type", "application/json");
	return new Response(JSON.stringify(data), { ...init, headers });
}

function emptyWithCors(status = 204): Response {
	const headers = new Headers();
	for (const [k, v] of Object.entries(corsHeaders)) {
		headers.set(k, v);
	}
	return new Response(null, { status, headers });
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/api/stripe-webhook" && request.method === "POST") {
			return handleStripeWebhook(request, env);
		}

		if (url.pathname === "/api/telegram-webhook") {
			return handleTelegramWebhook(request, env, ctx);
		}

		if (url.pathname.startsWith("/api/") && request.method === "OPTIONS") {
			return emptyWithCors(204);
		}

		if (url.pathname === "/api/dify/retrieve" && request.method === "POST") {
			let body: unknown;
			try {
				body = await request.json();
			} catch {
				return jsonWithCors(
					{ ok: false, error: "Invalid JSON body." },
					{ status: 400 },
				);
			}
			if (typeof body !== "object" || body === null) {
				return jsonWithCors(
					{ ok: false, error: "Body must be a JSON object." },
					{ status: 400 },
				);
			}
			const o = body as Record<string, unknown>;
			const datasetId = o.dataset_id;
			const queryText = o.query;
			const retrieval_model = o.retrieval_model;
			const external_retrieval_model = o.external_retrieval_model;
			const attachment_ids = o.attachment_ids;

			if (typeof datasetId !== "string" || !datasetId.trim()) {
				return jsonWithCors(
					{ ok: false, error: 'Provide non-empty string "dataset_id".' },
					{ status: 400 },
				);
			}
			if (typeof queryText !== "string" || !queryText.trim()) {
				return jsonWithCors(
					{ ok: false, error: 'Provide non-empty string "query".' },
					{ status: 400 },
				);
			}

			const rm =
				retrieval_model !== undefined &&
				retrieval_model !== null &&
				typeof retrieval_model === "object" &&
				!Array.isArray(retrieval_model)
					? (retrieval_model as Record<string, unknown>)
					: undefined;

			let extModel: RetrieveDifyDatasetOptions["external_retrieval_model"];
			if (
				external_retrieval_model !== undefined &&
				external_retrieval_model !== null &&
				typeof external_retrieval_model === "object" &&
				!Array.isArray(external_retrieval_model)
			) {
				extModel =
					external_retrieval_model as RetrieveDifyDatasetOptions["external_retrieval_model"];
			}

			let attIds: string[] | null | undefined;
			if (attachment_ids === null) {
				attIds = null;
			} else if (Array.isArray(attachment_ids)) {
				const ids = attachment_ids.filter(
					(x): x is string => typeof x === "string" && x.length > 0,
				);
				attIds = ids.length ? ids : undefined;
			}

			try {
				const result = await retrieveDifyDataset(env, datasetId, queryText, {
					retrieval_model: rm,
					external_retrieval_model: extModel,
					attachment_ids: attIds,
				});
				return jsonWithCors({
					ok: true,
					query: result.query,
					records: result.records,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonWithCors({ ok: false, error: message }, { status: 500 });
			}
		}

		if (url.pathname === "/api/dify/datasets" && request.method === "GET") {
			const pageRaw = url.searchParams.get("page");
			const limitRaw = url.searchParams.get("limit");
			const keyword = url.searchParams.get("keyword") ?? undefined;
			const includeAllRaw = url.searchParams.get("include_all");

			let page: number | undefined;
			let limit: number | undefined;
			if (pageRaw !== null && pageRaw !== "") {
				page = Number.parseInt(pageRaw, 10);
				if (!Number.isFinite(page) || page < 1) {
					return jsonWithCors(
						{ ok: false, error: 'Query "page" must be a positive integer.' },
						{ status: 400 },
					);
				}
			}
			if (limitRaw !== null && limitRaw !== "") {
				limit = Number.parseInt(limitRaw, 10);
				if (!Number.isFinite(limit) || limit < 1) {
					return jsonWithCors(
						{ ok: false, error: 'Query "limit" must be a positive integer.' },
						{ status: 400 },
					);
				}
			}

			const include_all =
				includeAllRaw === "1" ||
				includeAllRaw === "true" ||
				includeAllRaw === "yes";

			const tag_ids = url.searchParams.getAll("tag_ids").filter(Boolean);

			try {
				const list = await listDifyDatasets(env, {
					page,
					limit,
					keyword: keyword ?? undefined,
					include_all: include_all || undefined,
					tag_ids: tag_ids.length ? tag_ids : undefined,
				});
				return jsonWithCors({
					ok: true,
					data: list.data,
					has_more: list.has_more,
					limit: list.limit,
					total: list.total,
					page: list.page,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonWithCors({ ok: false, error: message }, { status: 500 });
			}
		}

		if (url.pathname === "/api/llm-test" && request.method === "GET") {
			const prompt =
				url.searchParams.get("q") ?? "Ответь одним коротким словом: работает?";
			try {
				const reply = await sendLlmRequest(env, [
					{ role: "user", content: prompt },
				]);
				return jsonWithCors({ ok: true, reply });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonWithCors({ ok: false, error: message }, { status: 500 });
			}
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			let body: unknown;
			try {
				body = await request.json();
			} catch {
				return jsonWithCors(
					{ ok: false, error: "Invalid JSON body." },
					{ status: 400 },
				);
			}
			if (typeof body !== "object" || body === null) {
				return jsonWithCors(
					{ ok: false, error: "Body must be a JSON object." },
					{ status: 400 },
				);
			}
			const o = body as Record<string, unknown>;
			const prompt = o.prompt;
			const messagesRaw = o.messages;
			const model =
				typeof o.model === "string" && o.model.length > 0 ? o.model : undefined;

			let messages: ChatMessage[];
			if (prompt !== undefined && messagesRaw !== undefined) {
				return jsonWithCors(
					{ ok: false, error: 'Use either "prompt" or "messages", not both.' },
					{ status: 400 },
				);
			}
			if (typeof prompt === "string" && prompt.length > 0) {
				messages = [{ role: "user", content: prompt }];
			} else if (Array.isArray(messagesRaw) && messagesRaw.length > 0) {
				messages = messagesRaw as ChatMessage[];
			} else {
				return jsonWithCors(
					{ ok: false, error: 'Provide "prompt" or non-empty "messages".' },
					{ status: 400 },
				);
			}

			try {
				const reply = await sendLlmRequest(env, messages, { model });
				return jsonWithCors({ ok: true, reply });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonWithCors({ ok: false, error: message }, { status: 500 });
			}
		}

		if (url.pathname === "/api/subtasks" && request.method === "POST") {
			let body: unknown;
			try {
				body = await request.json();
			} catch {
				return jsonWithCors(
					{ ok: false, error: "Invalid JSON body." },
					{ status: 400 },
				);
			}
			if (typeof body !== "object" || body === null) {
				return jsonWithCors(
					{ ok: false, error: "Body must be a JSON object." },
					{ status: 400 },
				);
			}
			const task = (body as Record<string, unknown>).task;
			const modelField = (body as Record<string, unknown>).model;
			const model =
				typeof modelField === "string" && modelField.length > 0
					? modelField
					: undefined;
			if (typeof task !== "string" || !task.trim()) {
				return jsonWithCors(
					{ ok: false, error: 'Provide non-empty string "task".' },
					{ status: 400 },
				);
			}
			try {
				const { boardTitle, subtasks } = await decomposeUserTask(env, task, {
					model,
				});
				const payload: Record<string, unknown> = { ok: true, subtasks };
				if (boardTitle) payload.board_title = boardTitle;
				return jsonWithCors(payload);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonWithCors({ ok: false, error: message }, { status: 500 });
			}
		}

		return new Response("Привет, мир!");
	},
} satisfies ExportedHandler<Env>;
