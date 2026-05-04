const VENICE_BASE_URL = "https://api.venice.ai/api/v1";
const DEFAULT_MODEL = "openai-gpt-4o-mini-2024-07-18";
const BOARD_TITLE_MAX_CHARS = 64;
const BOARD_TITLE_MAX_WORDS = 7;
const TITLE_LEADING_STOP_WORDS = new Set([
	"необходимо",
	"нужно",
	"надо",
	"требуется",
	"реализовать",
	"сделать",
	"создать",
	"разработать",
	"внедрить",
	"добавить",
	"build",
	"create",
	"implement",
	"add",
	"need",
	"must",
	"should",
]);

/** Сообщение в формате OpenAI-compatible Chat Completions (тело POST). */
export type ChatMessage = {
	role: string;
	content: unknown;
	name?: string;
	tool_calls?: unknown;
	tool_call_id?: string;
};

/** Одна подзадача после разбиения крупной задачи (формат для фронтенда). */
export type SubtaskItem = { title: string; task: string };

/** Результат разбиения: краткое название доски + подзадачи. */
export type TaskDecomposition = {
	/** Краткое название канбан-доски; может быть null при устаревшем формате ответа модели. */
	boardTitle: string | null;
	subtasks: SubtaskItem[];
};

const SUBTASK_DECOMPOSITION_SYSTEM_PROMPT = `Ты помощник по планированию работ. Пользователь присылает одну крупную задачу (текст с фронтенда).

Твоя задача:
1) Придумать короткое, ёмкое название будущей канбан-доски, отражающее всю задачу целиком.
2) Разбить задачу на мелкие, конкретные подзадачи — каждая выполнима отдельно, с ясным результатом.

Ответь ТОЛЬКО одним валидным JSON-объектом. Никакого текста, пояснений или markdown до или после JSON.

Структура ответа (ключи в двойных кавычках):
{
  "board_title": "краткое название доски — 2–7 слов, до 64 символов, без переносов строк",
  "subtasks": [
    {"title":"краткое название подзадачи","task":"развёрнутое описание: что именно сделать"}
  ]
}

Правила board_title:
- Тот же язык, что у пользователя.
- Без префиксов вроде «Доска:», «Проект:»; только суть.
- Не копируй исходную формулировку задачи целиком.
- Нельзя писать длинное предложение; только короткий заголовок как имя проекта/инициативы.
- Максимум 7 слов и максимум 64 символа.

Правила subtasks:
- Язык полей title и task совпадает с языком входной задачи пользователя.
- От 2 подзадач (если задача действительно крупная) до разумного максимума (обычно не больше 12), без дубликатов.
- title — одна строка, коротко; task — одна строка с достаточной детализацией.

Если модель по ошибке вернула только массив подзадач без обёртки — это допустимо как запасной формат (массив объектов с title и task).`;

function stripJsonFence(raw: string): string {
	const t = raw.trim();
	const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	return m ? m[1].trim() : t;
}

function normalizeBoardTitle(raw: string): string | null {
	let title = raw.trim().replace(/\s+/g, " ");
	if (!title) return null;

	title = title.replace(/^["'«»„”“]+|["'«»„”“]+$/g, "").trim();
	title = title.replace(/[.,;:!?-]+$/g, "").trim();
	if (!title) return null;

	const words = title.split(/\s+/).filter(Boolean);
	let start = 0;
	while (start < words.length) {
		const token = words[start].toLowerCase().replace(/[.,;:!?'"«»]/g, "");
		if (!TITLE_LEADING_STOP_WORDS.has(token)) break;
		start++;
	}
	const normalizedWords = words.slice(start);
	if (normalizedWords.length > 0) {
		title = normalizedWords.join(" ");
	}

	const clippedWords = title.split(/\s+/).filter(Boolean);
	if (clippedWords.length > BOARD_TITLE_MAX_WORDS) {
		title = clippedWords.slice(0, BOARD_TITLE_MAX_WORDS).join(" ");
	}

	if (title.length > BOARD_TITLE_MAX_CHARS) {
		title = title.slice(0, BOARD_TITLE_MAX_CHARS).trimEnd();
		title = title.replace(/[.,;:!?-]+$/g, "").trim();
	}

	return title || null;
}

function parseSubtasksArray(data: unknown, ctx: string): SubtaskItem[] {
	if (!Array.isArray(data)) {
		throw new Error(`Expected ${ctx} to be a JSON array of subtasks`);
	}
	const out: SubtaskItem[] = [];
	for (let i = 0; i < data.length; i++) {
		const item = data[i];
		if (!item || typeof item !== "object") {
			throw new Error(`Subtask at index ${i} is not an object`);
		}
		const rec = item as Record<string, unknown>;
		const title = rec.title;
		const task = rec.task;
		if (typeof title !== "string" || typeof task !== "string") {
			throw new Error(
				`Subtask at index ${i} must have string "title" and "task"`,
			);
		}
		if (!title.trim() || !task.trim()) {
			throw new Error(`Subtask at index ${i} has empty title or task`);
		}
		out.push({ title: title.trim(), task: task.trim() });
	}
	if (out.length === 0) {
		throw new Error("Model returned an empty subtask list");
	}
	return out;
}

function parseDecompositionResponse(raw: string): TaskDecomposition {
	let data: unknown;
	try {
		data = JSON.parse(stripJsonFence(raw));
	} catch {
		throw new Error("Model returned invalid JSON");
	}

	if (Array.isArray(data)) {
		return {
			boardTitle: null,
			subtasks: parseSubtasksArray(data, "response"),
		};
	}

	if (!data || typeof data !== "object") {
		throw new Error("Expected a JSON object or array");
	}

	const root = data as Record<string, unknown>;
	const subtasksRaw = root.subtasks;

	if (!Array.isArray(subtasksRaw)) {
		throw new Error('Expected JSON object with non-empty array "subtasks"');
	}

	const subtasks = parseSubtasksArray(subtasksRaw, "subtasks");

	let boardTitle: string | null = null;
	const bt = root.board_title;
	if (typeof bt === "string" && bt.trim()) {
		boardTitle = normalizeBoardTitle(bt);
	}

	return { boardTitle, subtasks };
}

/**
 * Разбивает задачу через LLM: краткое название доски + подзадачи.
 */
export async function decomposeUserTask(
	env: Pick<Env, "VENICE_API_KEY">,
	userTask: string,
	options?: { model?: string },
): Promise<TaskDecomposition> {
	const raw = await sendLlmRequest(
		env,
		[
			{ role: "system", content: SUBTASK_DECOMPOSITION_SYSTEM_PROMPT },
			{ role: "user", content: userTask.trim() },
		],
		options,
	);
	return parseDecompositionResponse(raw);
}

/**
 * То же разбиение; возвращает только подзадачи (обратная совместимость API).
 */
export async function decomposeTaskIntoSubtasks(
	env: Pick<Env, "VENICE_API_KEY">,
	userTask: string,
	options?: { model?: string },
): Promise<SubtaskItem[]> {
	const { subtasks } = await decomposeUserTask(env, userTask, options);
	return subtasks;
}

type VeniceChatResponse = {
	choices?: Array<{ message?: { content?: string | null } }>;
	error?: { message?: string };
};

/**
 * POST https://api.venice.ai/api/v1/chat/completions (OpenAI-compatible).
 * Секрет: `npx wrangler secret put VENICE_API_KEY`.
 */
export async function sendLlmRequest(
	env: Pick<Env, "VENICE_API_KEY">,
	messages: ChatMessage[],
	options?: { model?: string },
): Promise<string> {
	const apiKey = env.VENICE_API_KEY?.trim();
	if (!apiKey) {
		throw new Error(
			"VENICE_API_KEY не задан. Локально: в папке worker создайте файл .dev.vars с строкой VENICE_API_KEY=ваш_ключ (https://venice.ai), перезапустите wrangler dev. Или: npx wrangler secret put VENICE_API_KEY",
		);
	}

	const res = await fetch(`${VENICE_BASE_URL}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model: options?.model ?? DEFAULT_MODEL,
			messages,
		}),
	});

	let data: VeniceChatResponse;
	try {
		data = (await res.json()) as VeniceChatResponse;
	} catch {
		throw new Error(`LLM response is not JSON (HTTP ${res.status})`);
	}

	if (!res.ok) {
		const msg = data.error?.message ?? res.statusText;
		if (res.status === 401) {
			throw new Error(
				`Venice API 401 (Unauthorized): проверьте VENICE_API_KEY — действующий ключ с https://venice.ai, без пробелов; локально — .dev.vars или wrangler secret put. Ответ: ${msg}`,
			);
		}
		throw new Error(`LLM error ${res.status}: ${msg}`);
	}

	const content = data.choices?.[0]?.message?.content;
	if (content == null || content === "") {
		throw new Error("LLM returned empty content");
	}
	if (typeof content !== "string") {
		throw new Error("Multimodal content is not supported");
	}
	return content;
}
