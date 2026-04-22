const VENICE_BASE_URL = "https://api.venice.ai/api/v1";
const DEFAULT_MODEL = "openai-gpt-4o-mini-2024-07-18";

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

const SUBTASK_DECOMPOSITION_SYSTEM_PROMPT = `Ты помощник по планированию работ. Пользователь присылает одну крупную задачу (текст с фронтенда).

Твоя задача: разбить её на мелкие, конкретные подзадачи. Каждая подзадача должна быть выполнима отдельно, с ясным результатом.

Ответь ТОЛЬКО валидным JSON-массивом. Никакого текста, пояснений или markdown до или после JSON.

Формат каждого элемента массива строго такой (ключи в двойных кавычках):
{"title":"краткое название подзадачи","task":"развёрнутое описание: что именно сделать"}

Правила:
- Язык полей title и task совпадает с языком входной задачи пользователя.
- От 2 подзадач (если задача действительно крупная) до разумного максимума (обычно не больше 12), без дубликатов.
- title — одна строка, коротко; task — одна строка с достаточной детализацией.`;

function stripJsonFence(raw: string): string {
	const t = raw.trim();
	const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	return m ? m[1].trim() : t;
}

function parseSubtasksResponse(raw: string): SubtaskItem[] {
	let data: unknown;
	try {
		data = JSON.parse(stripJsonFence(raw));
	} catch {
		throw new Error("Model returned invalid JSON");
	}
	if (!Array.isArray(data)) {
		throw new Error("Expected a JSON array of subtasks");
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

/**
 * Отправляет задачу с фронтенда в LLM с системным промптом на разбиение на подзадачи.
 * Возвращает массив { title, task }.
 */
export async function decomposeTaskIntoSubtasks(
	env: Pick<Env, "VENICE_API_KEY">,
	userTask: string,
	options?: { model?: string },
): Promise<SubtaskItem[]> {
	const raw = await sendLlmRequest(
		env,
		[
			{ role: "system", content: SUBTASK_DECOMPOSITION_SYSTEM_PROMPT },
			{ role: "user", content: userTask.trim() },
		],
		options,
	);
	return parseSubtasksResponse(raw);
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
	const res = await fetch(`${VENICE_BASE_URL}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${env.VENICE_API_KEY}`,
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
