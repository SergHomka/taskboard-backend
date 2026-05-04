import { decomposeTaskIntoSubtasks } from "./llm";

const TG_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";
const BOARD_TITLE_MAX_LEN = 120;
const TG_TEXT_LIMIT = 4096;
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Совпадает с миграцией `telegram_service_user_and_board_tasks_created_by` в Supabase. */
const TELEGRAM_INGEST_SERVICE_USER_ID =
	"b01eda72-0000-4000-8000-000000000001";

function isUuid(s: string): boolean {
	return UUID_RE.test(s.trim());
}

function resolveTelegramServiceUserId(env: Env): string {
	const raw = env.TELEGRAM_SERVICE_USER_ID?.trim();
	if (raw && isUuid(raw)) return raw;
	return TELEGRAM_INGEST_SERVICE_USER_ID;
}

function truthySecret(envStr?: string): boolean {
	return Boolean(envStr?.trim());
}

/** GET — только диагностика (ничего секретного). */
export function telegramWebhookDiagnostics(request: Request, env: Env): Response {
	const u = new URL(request.url);
	const workerOrigin = `${u.protocol}//${u.host}`;
	let supabaseHost = "";
	try {
		const raw = env.SUPABASE_URL?.trim();
		if (raw) supabaseHost = new URL(raw).host;
	} catch {
		supabaseHost = "(неверный URL)";
	}
	const configured =
		truthySecret(env.TELEGRAM_BOT_TOKEN) &&
		truthySecret(env.SUPABASE_URL) &&
		truthySecret(env.SUPABASE_SERVICE_ROLE_KEY) &&
		truthySecret(env.TELEGRAM_INGEST_BOARD_OWNER_USER_ID) &&
		truthySecret(env.VENICE_API_KEY);

	return Response.json(
		{
			ok: true,
			configured_for_telegram_ingest: configured,
			webhook_post_url: `${workerOrigin}/api/telegram-webhook`,
			supabase_host: supabaseHost || null,
			secrets_present: {
				TELEGRAM_BOT_TOKEN: truthySecret(env.TELEGRAM_BOT_TOKEN),
				TELEGRAM_WEBHOOK_SECRET: truthySecret(env.TELEGRAM_WEBHOOK_SECRET),
				SUPABASE_URL: truthySecret(env.SUPABASE_URL),
				SUPABASE_SERVICE_ROLE_KEY: truthySecret(env.SUPABASE_SERVICE_ROLE_KEY),
				TELEGRAM_INGEST_BOARD_OWNER_USER_ID: truthySecret(
					env.TELEGRAM_INGEST_BOARD_OWNER_USER_ID,
				),
				VENICE_API_KEY: truthySecret(env.VENICE_API_KEY),
			},
			steps: [
				"В Telegram Bot API выполните setWebhook на webhook_post_url (HTTPS).",
				"Если в Workers задан TELEGRAM_WEBHOOK_SECRET — при setWebhook передайте тот же secret_token.",
				"TELEGRAM_INGEST_BOARD_OWNER_USER_ID должен быть существующим auth.users.id (владелец новых досок).",
				"SUPABASE_URL и ключ должны быть от того же проекта Supabase, куда применены миграции RPC.",
			],
		},
		{
			headers: {
				"Content-Type": "application/json; charset=utf-8",
				"Cache-Control": "no-store",
			},
		},
	);
}

function telegramOk(): Response {
	return new Response("OK", { status: 200 });
}

type TelegramMessage = {
	chat?: { id?: number };
	text?: string;
	caption?: string;
};
type TelegramUpdate = {
	message?: TelegramMessage;
	edited_message?: TelegramMessage;
};

function getChatIdFromUpdate(update: TelegramUpdate): number | undefined {
	const msg = update.message ?? update.edited_message;
	const id = msg?.chat?.id;
	return typeof id === "number" ? id : undefined;
}

function getTextFromUpdate(update: TelegramUpdate): string | undefined {
	const msg = update.message ?? update.edited_message;
	const raw = msg?.text ?? msg?.caption;
	if (typeof raw !== "string") return undefined;
	const t = raw.trim();
	return t.length ? t : undefined;
}

function boardTitleFromTelegramText(text: string): string {
	const singleLine = text.trim().replace(/\s+/g, " ");
	if (!singleLine) {
		return `Telegram ${new Date().toISOString().slice(0, 16)}`;
	}
	if (singleLine.length <= BOARD_TITLE_MAX_LEN) return singleLine;
	return `${singleLine.slice(0, BOARD_TITLE_MAX_LEN - 1)}…`;
}

function chunkTelegramText(text: string): string[] {
	if (text.length <= TG_TEXT_LIMIT) return [text];
	const out: string[] = [];
	for (let i = 0; i < text.length; i += TG_TEXT_LIMIT) {
		out.push(text.slice(i, i + TG_TEXT_LIMIT));
	}
	return out;
}

async function sendTelegramText(
	token: string,
	chatId: number,
	text: string,
): Promise<void> {
	const url = `https://api.telegram.org/bot${token}/sendMessage`;
	for (const chunk of chunkTelegramText(text)) {
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chat_id: chatId, text: chunk }),
		});
		if (!res.ok) {
			const body = await res.text();
			console.error("Telegram sendMessage failed:", res.status, body);
		}
	}
}

type RpcIngestResult = {
	board_id?: string;
	tasks_created?: number;
};

async function ingestBoardAndTasksViaRpc(
	env: Env,
	ownerUserId: string,
	boardTitle: string,
	tasks: { title: string; task: string }[],
	createdByUserId: string,
): Promise<{ tasksCreated: number }> {
	const base = env.SUPABASE_URL.trim().replace(/\/$/, "");
	const key = env.SUPABASE_SERVICE_ROLE_KEY.trim();
	const url = `${base}/rest/v1/rpc/telegram_ingest_board_and_tasks`;

	const res = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
			apikey: key,
			Authorization: `Bearer ${key}`,
			Prefer: "return=representation",
		},
		body: JSON.stringify({
			p_owner_id: ownerUserId,
			p_board_title: boardTitle,
			p_created_by: createdByUserId,
			p_tasks: tasks,
		}),
	});

	const rawBody = await res.text();
	let data: unknown;
	try {
		data = rawBody.length ? JSON.parse(rawBody) : null;
	} catch {
		throw new Error(
			rawBody.length
				? rawBody
				: `RPC telegram_ingest_board_and_tasks: HTTP ${res.status}`,
		);
	}

	if (!res.ok) {
		throw new Error(postgrestErrorMessage(data, rawBody || `HTTP ${res.status}`));
	}

	const payload = normalizeRpcIngestPayload(data);
	const n =
		typeof payload.tasks_created === "number" ? payload.tasks_created : 0;

	if (typeof payload.board_id !== "string" || !isUuid(payload.board_id)) {
		throw new Error("RPC вернул некорректный board_id");
	}

	return { tasksCreated: n };
}

function postgrestErrorMessage(data: unknown, fallback: string): string {
	if (typeof data === "object" && data !== null) {
		const o = data as Record<string, unknown>;
		if (typeof o.message === "string") return o.message;
		if (typeof o.error === "string") return o.error;
		if (typeof o.error_description === "string") return o.error_description;
	}
	return fallback;
}

/** PostgREST может вернуть jsonb как объект, строку JSON или обёртку с именем функции. */
function normalizeRpcIngestPayload(data: unknown): RpcIngestResult {
	if (data == null) return {};
	if (typeof data === "string") {
		try {
			return normalizeRpcIngestPayload(JSON.parse(data));
		} catch {
			return {};
		}
	}
	if (typeof data === "object" && !Array.isArray(data)) {
		const o = data as Record<string, unknown>;
		if ("board_id" in o || "tasks_created" in o) {
			return data as RpcIngestResult;
		}
		const inner = o.telegram_ingest_board_and_tasks;
		if (typeof inner === "string") {
			try {
				return normalizeRpcIngestPayload(JSON.parse(inner));
			} catch {
				return {};
			}
		}
		if (inner != null && typeof inner === "object" && !Array.isArray(inner)) {
			return inner as RpcIngestResult;
		}
	}
	if (Array.isArray(data) && data.length > 0) {
		const row = data[0];
		if (row != null && typeof row === "object" && !Array.isArray(row)) {
			return normalizeRpcIngestPayload(row);
		}
	}
	return {};
}

async function runTelegramTaskPipeline(
	env: Env,
	chatId: number,
	userText: string,
): Promise<void> {
	const token = env.TELEGRAM_BOT_TOKEN?.trim();
	if (!token) {
		console.error("TELEGRAM_BOT_TOKEN is missing");
		return;
	}

	const ownerUserId = env.TELEGRAM_INGEST_BOARD_OWNER_USER_ID?.trim();

	const supabaseUrl = env.SUPABASE_URL?.trim();
	const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();

	if (!supabaseUrl || !serviceKey) {
		await sendTelegramText(
			token,
			chatId,
			"Ошибка конфигурации: не заданы SUPABASE_URL или SUPABASE_SERVICE_ROLE_KEY в секретах Worker.",
		);
		return;
	}

	if (!ownerUserId || !isUuid(ownerUserId)) {
		await sendTelegramText(
			token,
			chatId,
			"Ошибка конфигурации: задайте TELEGRAM_INGEST_BOARD_OWNER_USER_ID — UUID пользователя Supabase Auth (`auth.users.id`), от имени которого создаётся новая доска при каждом сообщении.",
		);
		return;
	}

	try {
		const ingestUserId = resolveTelegramServiceUserId(env);
		const tasks = await decomposeTaskIntoSubtasks(env, userText);
		const boardTitle = boardTitleFromTelegramText(userText);
		const { tasksCreated } = await ingestBoardAndTasksViaRpc(
			env,
			ownerUserId,
			boardTitle,
			tasks,
			ingestUserId,
		);
		const n = tasksCreated;
		await sendTelegramText(
			token,
			chatId,
			n === 1
				? `Создана доска «${boardTitle}» и 1 задача (колонка «Планы»).`
				: `Создана доска «${boardTitle}». Задач в «Планы»: ${n}.`,
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.error("telegram webhook pipeline:", msg);
		await sendTelegramText(token, chatId, `Не удалось создать задачи: ${msg}`);
	}
}

export async function handleTelegramWebhook(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	if (request.method === "GET") {
		return telegramWebhookDiagnostics(request, env);
	}

	if (request.method !== "POST") {
		return new Response("Method Not Allowed", { status: 405 });
	}

	const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
	if (webhookSecret) {
		const headerSecret = request.headers.get(TG_SECRET_HEADER);
		if (headerSecret !== webhookSecret) {
			console.warn(
				"telegram webhook: неверный или отсутствует заголовок X-Telegram-Bot-Api-Secret-Token (проверьте secret_token при setWebhook)",
			);
			return new Response("Unauthorized", { status: 401 });
		}
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return new Response("Bad Request", { status: 400 });
	}

	if (typeof body !== "object" || body === null) {
		return telegramOk();
	}

	const update = body as TelegramUpdate;
	const chatId = getChatIdFromUpdate(update);
	const text = getTextFromUpdate(update);

	if (chatId !== undefined && text !== undefined) {
		const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
		if (!botToken) {
			console.error("TELEGRAM_BOT_TOKEN is missing");
			return telegramOk();
		}
		ctx.waitUntil(
			runTelegramTaskPipeline(env, chatId, text).catch((err) => {
				console.error("telegram waitUntil pipeline:", err);
			}),
		);
	}

	return telegramOk();
}
