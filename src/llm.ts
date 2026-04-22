import OpenAI from "openai";

const VENICE_BASE_URL = "https://api.venice.ai/api/v1";
const DEFAULT_MODEL = "openai-gpt-oss-120b";

export type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;

/**
 * Sends a chat completion request to Venice (OpenAI-compatible API).
 * Configure `VENICE_API_KEY` via `npx wrangler secret put VENICE_API_KEY`.
 */
export async function sendLlmRequest(
	env: Pick<Env, "VENICE_API_KEY">,
	messages: ChatMessage[],
	options?: { model?: string },
): Promise<string> {
	const client = new OpenAI({
		apiKey: env.VENICE_API_KEY,
		baseURL: VENICE_BASE_URL,
	});

	const response = await client.chat.completions.create({
		model: options?.model ?? DEFAULT_MODEL,
		messages,
	});

	const content = response.choices[0]?.message?.content;
	if (content == null || content === "") {
		throw new Error("LLM returned empty content");
	}
	if (typeof content !== "string") {
		throw new Error("Multimodal content is not supported");
	}
	return content;
}
