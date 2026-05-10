declare namespace Cloudflare {
	interface Env {
		/**
		 * API key Venice (OpenAI-compatible). Локально: файл `.dev.vars` в корне worker
		 * (`VENICE_API_KEY=...`) или `npx wrangler secret put VENICE_API_KEY`.
		 */
		VENICE_API_KEY: string;
		/**
		 * Ключ Dataset / Knowledge API в Dify (панель базы знаний → API / Service API).
		 * `POST /datasets/{id}/retrieve` и др. Секрет: `npx wrangler secret put DIFY_DATASET_API_KEY`.
		 */
		DIFY_DATASET_API_KEY?: string;
		/**
		 * Базовый URL Knowledge API (например self-hosted). По умолчанию `https://api.dify.ai/v1`.
		 * Без завершающего слэша.
		 */
		DIFY_API_BASE?: string;
		/**
		 * UUID базы знаний по умолчанию для POST /api/knowledge-chat, если в теле нет dataset_id.
		 * Vars или секрет по желанию; например `.dev.vars` / `wrangler vars`.
		 */
		DIFY_KNOWLEDGE_DATASET_ID?: string;
		/** Signing secret из Stripe Dashboard → Webhooks (`whsec_...`). */
		STRIPE_WEBHOOK_SECRET: string;
		/**
		 * Restricted Stripe secret key (`sk_test_...` / `sk_live_...`).
		 * Нужен конструктору SDK для `constructEvent`; без реальных вызовов API можно указать тестовый ключ из Dashboard.
		 */
		STRIPE_SECRET_KEY?: string;
		SUPABASE_URL: string;
		SUPABASE_SERVICE_ROLE_KEY: string;
		/** Токен от @BotFather (`123456:ABC-...`). Секрет: `wrangler secret put TELEGRAM_BOT_TOKEN`. */
		TELEGRAM_BOT_TOKEN: string;
		/**
		 * Тот же `secret_token`, что в `setWebhook`. Заголовок `X-Telegram-Bot-Api-Secret-Token`.
		 * Пустая строка — без проверки заголовка (только для локальной отладки).
		 */
		TELEGRAM_WEBHOOK_SECRET: string;
		/**
		 * UUID (`auth.users.id`) — владелец каждой новой доски, создаваемой при сообщении из Telegram.
		 */
		TELEGRAM_INGEST_BOARD_OWNER_USER_ID: string;
		/**
		 * UUID сервисного пользователя для атрибуции карточек из Telegram (`board_tasks.created_by`).
		 * Если не задан — используется пользователь из миграции `telegram_service_user_and_board_tasks_created_by`.
		 */
		TELEGRAM_SERVICE_USER_ID?: string;
	}
}
