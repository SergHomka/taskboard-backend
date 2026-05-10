import {
	retrieveDifyDataset,
	type DifyRetrieveRecord,
	type RetrieveDifyDatasetOptions,
} from "./difyRetrieve";
import { sendLlmRequest } from "./llm";

/** Как в Dify Knowledge API `query` (макс. длина). */
const RETRIEVE_QUERY_MAX_CHARS = 250;

/** Суммарный лимит текста контекста для Venice. */
const CONTEXT_MAX_CHARS = 14_000;

export const KNOWLEDGE_CONSULTANT_SYSTEM_PROMPT =
	"Ты консультат по сайту AI Board. Отвечай на вопросы строго по базе знаний";

type KnowledgeConsultEnv = Pick<Env, "VENICE_API_KEY" | "DIFY_DATASET_API_KEY"> &
	Partial<Pick<Env, "DIFY_API_BASE">>;

function buildContextFromRecords(
	records: DifyRetrieveRecord[] | undefined,
	maxChars: number,
): string {
	if (records == null || records.length === 0) {
		return "(В базе знаний не найдено подходящих фрагментов.)";
	}

	const parts: string[] = [];
	let total = 0;
	let n = 0;

	for (const rec of records) {
		const seg = rec.segment;
		if (seg == null) {
			continue;
		}
		const docName = seg.document?.name;
		const text = [seg.answer, seg.content]
			.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
			.join("\n\n")
			.trim();
		if (text === "") {
			continue;
		}

		n += 1;
		const header = docName
			? `[Фрагмент ${n}, документ: ${docName}]`
			: `[Фрагмент ${n}]`;
		const block = `${header}\n${text}`;
		const sep = parts.length === 0 ? 0 : 2;
		if (total + sep + block.length > maxChars) {
			parts.push(
				"(…дальнейшие фрагменты обрезаны по лимиту контекста.)",
			);
			break;
		}
		if (sep > 0) {
			total += 2;
		}
		parts.push(block);
		total += block.length;
	}

	if (parts.length === 0) {
		return "(В базе знаний не найдено текстовых фрагментов.)";
	}

	return parts.join("\n\n---\n\n");
}

export type ConsultWithKnowledgeBaseArgs = {
	datasetId: string;
	userQuestion: string;
	model?: string;
	retrieveOptions?: RetrieveDifyDatasetOptions;
};

/**
 * Retrieve в Dify, затем ответ пользователю через Venice с фиксированным системным промптом консультанта.
 */
export async function consultWithKnowledgeBase(
	env: KnowledgeConsultEnv,
	args: ConsultWithKnowledgeBaseArgs,
): Promise<string> {
	const q = args.userQuestion.trim();
	if (!q) {
		throw new Error("userQuestion пустой");
	}

	const retrieveQuery =
		q.length > RETRIEVE_QUERY_MAX_CHARS
			? q.slice(0, RETRIEVE_QUERY_MAX_CHARS)
			: q;

	const retrieved = await retrieveDifyDataset(
		env,
		args.datasetId,
		retrieveQuery,
		args.retrieveOptions,
	);

	const context = buildContextFromRecords(
		retrieved.records,
		CONTEXT_MAX_CHARS,
	);

	const userPayload = `Вопрос пользователя:
${q}

Контекст из базы знаний:
${context}`;

	return sendLlmRequest(
		env,
		[
			{ role: "system", content: KNOWLEDGE_CONSULTANT_SYSTEM_PROMPT },
			{ role: "user", content: userPayload },
		],
		{ model: args.model },
	);
}
