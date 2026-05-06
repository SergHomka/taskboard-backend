/**
 * Dify Knowledge API (datasets / knowledge bases).
 * - Список: GET /datasets — https://docs.dify.ai/api-reference/knowledge-bases/list-knowledge-bases
 * - Одна база: GET /datasets/{id} — https://docs.dify.ai/api-reference/knowledge-bases/get-knowledge-base
 * - Retrieve: POST /datasets/{id}/retrieve — https://docs.dify.ai/api-reference/knowledge-bases/retrieve-chunks-from-a-knowledge-base-test-retrieval
 *
 * Для `indexing_technique: economy` векторной коллекции нет: если в вызове не передан
 * `retrieval_model.search_method`, перед retrieve выполняется GET деталей датасета;
 * подставляется `keyword_search` и в тело подмешивается `retrieval_model_dict` (и запасные
 * поля top_k / reranking_enable / score_threshold_enabled), иначе API может уйти в semantic и дать Collection not found.
 * Секрет: `npx wrangler secret put DIFY_DATASET_API_KEY`.
 */
const DIFY_DEFAULT_API_BASE = "https://api.dify.ai/v1";
const DIFY_QUERY_MAX_LENGTH = 250;

function normalizeApiBase(raw: string | undefined): string {
	const base = (raw?.trim() || DIFY_DEFAULT_API_BASE).replace(/\/+$/, "");
	return base;
}

/** Минимальный набор, если Dify не вернул полный retrieval_model_dict. */
const RETRIEVAL_MODEL_FALLBACK: Record<string, unknown> = {
	reranking_enable: false,
	top_k: 3,
	score_threshold_enabled: false,
	score_threshold: null,
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isEconomyIndexing(indexingTechnique: unknown): boolean {
	if (typeof indexingTechnique !== "string") {
		return false;
	}
	const t = indexingTechnique.trim().toLowerCase();
	return t === "economy" || t === "economical";
}

function extractDifyErrorMessage(data: unknown, fallback: string): string {
	if (data !== null && typeof data === "object") {
		const o = data as Record<string, unknown>;
		if (typeof o.message === "string" && o.message.length > 0) {
			return o.message;
		}
		if (typeof o.error === "string" && o.error.length > 0) {
			return o.error;
		}
		if (o.error !== null && typeof o.error === "object") {
			const e = o.error as Record<string, unknown>;
			if (typeof e.message === "string" && e.message.length > 0) {
				return e.message;
			}
		}
	}
	return fallback;
}

/** Тело POST (обязателен query; остальное по схеме OpenAPI). */
export type DifyRetrieveRequestBody = {
	query: string;
	retrieval_model?: Record<string, unknown>;
	external_retrieval_model?: {
		top_k?: number;
		score_threshold?: number;
		score_threshold_enabled?: boolean;
	};
	attachment_ids?: string[] | null;
};

export type DifyRetrieveSegment = {
	id?: string;
	position?: number;
	document_id?: string;
	content?: string;
	answer?: string;
	document?: {
		id?: string;
		name?: string;
		data_source_type?: string;
	};
};

export type DifyRetrieveRecord = {
	segment?: DifyRetrieveSegment;
	score?: number;
	child_chunks?: Array<{
		id?: string;
		content?: string;
		position?: number;
		score?: number;
	}>;
};

/** Ответ 200 — основные поля для RAG; полная схема шире. */
export type DifyRetrieveResponse = {
	query?: { content?: string };
	records?: DifyRetrieveRecord[];
};

export type RetrieveDifyDatasetOptions = {
	retrieval_model?: DifyRetrieveRequestBody["retrieval_model"];
	external_retrieval_model?: DifyRetrieveRequestBody["external_retrieval_model"];
	attachment_ids?: DifyRetrieveRequestBody["attachment_ids"];
	/** Self-hosted или иной хост; иначе `env.DIFY_API_BASE` или cloud. */
	baseUrl?: string;
};

type DifyEnv = Pick<Env, "DIFY_DATASET_API_KEY"> &
	Partial<Pick<Env, "DIFY_API_BASE">>;

function getDifyBaseUrl(
	env: DifyEnv,
	overrideBaseUrl?: string,
): string {
	return normalizeApiBase(
		overrideBaseUrl?.trim() || env.DIFY_API_BASE?.trim(),
	);
}

function requireDifyApiKey(env: DifyEnv): string {
	const apiKey = env.DIFY_DATASET_API_KEY?.trim();
	if (!apiKey) {
		throw new Error(
			"DIFY_DATASET_API_KEY не задан. Локально: `.dev.vars` с DIFY_DATASET_API_KEY=... (ключ Knowledge API в Dify → Service API), или `npx wrangler secret put DIFY_DATASET_API_KEY`",
		);
	}
	return apiKey;
}

/** Элемент списка баз знаний (полная схема шире). */
export type DifyDatasetSummary = {
	id: string;
	name?: string;
	description?: string;
	[key: string]: unknown;
};

export type DifyDatasetListResponse = {
	data: DifyDatasetSummary[];
	has_more?: boolean;
	limit?: number;
	total?: number;
	page?: number;
};

export type ListDifyDatasetsOptions = {
	page?: number;
	limit?: number;
	keyword?: string;
	include_all?: boolean;
	tag_ids?: string[];
	baseUrl?: string;
};

/** Ответ GET /datasets/{dataset_id} (основные поля). */
export type DifyDatasetDetail = {
	id: string;
	name?: string;
	indexing_technique?: string;
	retrieval_model_dict?: Record<string, unknown>;
	[key: string]: unknown;
};

/**
 * Карточка одной базы знаний. GET /datasets/{dataset_id}.
 */
export async function getDifyDatasetDetail(
	env: DifyEnv,
	datasetId: string,
	options?: { baseUrl?: string },
): Promise<DifyDatasetDetail> {
	const apiKey = requireDifyApiKey(env);
	const id = datasetId.trim();
	if (!id) {
		throw new Error("dataset_id пустой");
	}

	const baseUrl = getDifyBaseUrl(env, options?.baseUrl);
	const url = `${baseUrl}/datasets/${encodeURIComponent(id)}`;

	const res = await fetch(url, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${apiKey}`,
		},
	});

	let data: unknown;
	try {
		data = await res.json();
	} catch {
		throw new Error(`Dify get dataset: ответ не JSON (HTTP ${res.status})`);
	}

	if (!res.ok) {
		const msg = extractDifyErrorMessage(data, res.statusText);
		if (res.status === 401) {
			throw new Error(
				`Dify Knowledge API 401 (Unauthorized): проверьте DIFY_DATASET_API_KEY. Ответ: ${msg}`,
			);
		}
		throw new Error(`Dify get dataset error ${res.status}: ${msg}`);
	}

	return data as DifyDatasetDetail;
}

/**
 * Список баз знаний (dataset id и метаданные). GET /datasets.
 */
export async function listDifyDatasets(
	env: DifyEnv,
	options?: ListDifyDatasetsOptions,
): Promise<DifyDatasetListResponse> {
	const apiKey = requireDifyApiKey(env);
	const baseUrl = getDifyBaseUrl(env, options?.baseUrl);

	const params = new URLSearchParams();
	if (options?.page !== undefined) {
		params.set("page", String(options.page));
	}
	if (options?.limit !== undefined) {
		params.set("limit", String(options.limit));
	}
	if (options?.keyword !== undefined && options.keyword.trim() !== "") {
		params.set("keyword", options.keyword.trim());
	}
	if (options?.include_all === true) {
		params.set("include_all", "true");
	}
	if (options?.tag_ids?.length) {
		for (const id of options.tag_ids) {
			if (id.trim()) params.append("tag_ids", id.trim());
		}
	}

	const qs = params.toString();
	const url = qs ? `${baseUrl}/datasets?${qs}` : `${baseUrl}/datasets`;

	const res = await fetch(url, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${apiKey}`,
		},
	});

	let data: unknown;
	try {
		data = await res.json();
	} catch {
		throw new Error(`Dify list datasets: ответ не JSON (HTTP ${res.status})`);
	}

	if (!res.ok) {
		const msg = extractDifyErrorMessage(data, res.statusText);
		if (res.status === 401) {
			throw new Error(
				`Dify Knowledge API 401 (Unauthorized): проверьте DIFY_DATASET_API_KEY — ключ Dataset/Knowledge API из Dify. Ответ: ${msg}`,
			);
		}
		throw new Error(`Dify list datasets error ${res.status}: ${msg}`);
	}

	const parsed = data as DifyDatasetListResponse;
	if (!Array.isArray(parsed.data)) {
		throw new Error("Dify list datasets: в ответе нет массива data");
	}
	return parsed;
}

/**
 * Поиск чанков в базе знаний Dify.
 *
 * @param datasetId UUID базы (Dataset / Knowledge) в Dify
 * @param query Текст запроса (макс. 250 символов по API)
 */
export async function retrieveDifyDataset(
	env: DifyEnv,
	datasetId: string,
	query: string,
	options?: RetrieveDifyDatasetOptions,
): Promise<DifyRetrieveResponse> {
	const apiKey = requireDifyApiKey(env);

	const id = datasetId.trim();
	if (!id) {
		throw new Error("dataset_id пустой");
	}

	const q = query.trim();
	if (!q) {
		throw new Error("query пустой");
	}
	if (q.length > DIFY_QUERY_MAX_LENGTH) {
		throw new Error(
			`query длиннее ${DIFY_QUERY_MAX_LENGTH} символов (ограничение Dify Knowledge API)`,
		);
	}

	const baseUrl = getDifyBaseUrl(env, options?.baseUrl);
	const url = `${baseUrl}/datasets/${encodeURIComponent(id)}/retrieve`;

	const body: DifyRetrieveRequestBody = { query: q };

	const userRm = options?.retrieval_model;
	const userHasSearchMethod =
		userRm != null &&
		typeof userRm === "object" &&
		"search_method" in userRm &&
		userRm.search_method != null &&
		String(userRm.search_method).length > 0;

	if (!userHasSearchMethod) {
		const detail = await getDifyDatasetDetail(env, id, {
			baseUrl: options?.baseUrl,
		});
		const dict = isPlainObject(detail.retrieval_model_dict)
			? detail.retrieval_model_dict
			: {};
		const merged: Record<string, unknown> = {
			...RETRIEVAL_MODEL_FALLBACK,
			...dict,
		};
		if (isEconomyIndexing(detail.indexing_technique)) {
			merged.search_method = "keyword_search";
		}
		body.retrieval_model =
			userRm != null && isPlainObject(userRm as unknown)
				? { ...merged, ...(userRm as Record<string, unknown>) }
				: merged;
	} else if (userRm !== undefined) {
		body.retrieval_model = userRm;
	}

	if (options?.external_retrieval_model !== undefined) {
		body.external_retrieval_model = options.external_retrieval_model;
	}
	if (options?.attachment_ids !== undefined) {
		body.attachment_ids = options.attachment_ids;
	}

	const res = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
	});

	let data: unknown;
	try {
		data = await res.json();
	} catch {
		throw new Error(`Dify retrieve: ответ не JSON (HTTP ${res.status})`);
	}

	if (!res.ok) {
		const msg = extractDifyErrorMessage(data, res.statusText);
		if (res.status === 401) {
			throw new Error(
				`Dify Knowledge API 401 (Unauthorized): проверьте DIFY_DATASET_API_KEY — ключ Dataset/Knowledge API из Dify. Ответ: ${msg}`,
			);
		}
		throw new Error(`Dify retrieve error ${res.status}: ${msg}`);
	}

	return data as DifyRetrieveResponse;
}
