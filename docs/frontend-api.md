# API для фронтенда (чат с LLM)

Базовый URL продакшена:

`https://aiboard.siarheikhamiakou.workers.dev`

Локально (`wrangler dev`): `http://localhost:8787`

Все пути ниже относительны к этому origin. Для запросов из браузера с другого домена включены **CORS** (`Access-Control-Allow-Origin: *`, поддерживаются `GET`, `POST`, `OPTIONS`).

Вызовы к LLM на бэкенде идут **POST**-запросом на Venice OpenAI-compatible API: `https://api.venice.ai/api/v1/chat/completions` (секрет `VENICE_API_KEY`).

---

## `POST /api/chat` (рекомендуется для UI)

Один запрос — один ответ модели. Удобно для форм и Postman.

### Заголовки

| Заголовок      | Значение            |
|----------------|---------------------|
| `Content-Type` | `application/json`  |

### Тело (JSON)

**Вариант A — одно пользовательское сообщение:**

```json
{
  "prompt": "Объясни зачем нужен TypeScript одним предложением.",
  "model": "openai-gpt-4o-mini-2024-07-18"
}
```

Поле `model` необязательно; если не передать, используется модель по умолчанию на бэкенде (`openai-gpt-4o-mini-2024-07-18`).

**Вариант B — цепочка сообщений (формат как у OpenAI Chat):**

```json
{
  "messages": [
    { "role": "system", "content": "Отвечай кратко." },
    { "role": "user", "content": "Привет!" }
  ],
  "model": "openai-gpt-4o-mini-2024-07-18"
}
```

Нужно передать либо `prompt` (строка), либо `messages` (массив). Оба сразу — ошибка `400`.

Допустимые `role` в элементах `messages`: в основном `system`, `user`, `assistant` (как в OpenAI Chat Completions).

### Успешный ответ

HTTP `200`, JSON:

```json
{
  "ok": true,
  "reply": "Текст ответа модели."
}
```

### Ошибки

| Код | Тело (пример) | Когда |
|-----|----------------|--------|
| `400` | `{"ok":false,"error":"Provide \"prompt\" or non-empty \"messages\"."}` и др. | Неверное или пустое тело |
| `500` | `{"ok":false,"error":"…"}` | Ошибка провайдера LLM или внутренняя |

---

## `POST /api/subtasks` (разбиение задачи на подзадачи)

Передаёте одну формулировку задачи с фронтенда; бэкенд добавляет **системный промпт** и просит модель вернуть список мелких подзадач.

### Тело (JSON)

```json
{
  "task": "Сделать экран настроек профиля с аватаром и сменой пароля",
  "model": "openai-gpt-4o-mini-2024-07-18"
}
```

- **`task`** (обязательно) — описание крупной задачи.
- **`model`** — необязательно; по умолчанию как у остального API.

### Успешный ответ

HTTP `200`:

```json
{
  "ok": true,
  "subtasks": [
    { "title": "Верстка блока профиля", "task": "Сверстать карточку с полями имени и email по макету." },
    { "title": "Загрузка аватара", "task": "Добавить input file, превью и отправку файла на API." }
  ]
}
```

Каждый элемент: **`title`** — короткое название, **`task`** — описание подзадачи (валидный JSON, не сокращённый формат с фигурными скобками без кавычек).

### Ошибки

Те же коды `400` / `500`, что у `/api/chat`; при невалидном JSON от модели — `500` с текстом ошибки парсинга.

---

## `GET /api/llm-test`

Упрощённая проверка «жив ли LLM». Удобно открыть в браузере или вызвать из curl.

### Query-параметры

| Параметр | Обязательный | Описание |
|----------|--------------|----------|
| `q`      | Нет          | Текст пользователя. Если не указан, уходит короткий тестовый промпт по умолчанию. |

Пример:  
`GET /api/llm-test?q=Сколько%20будет%202%2B2%3F`

### Ответ

Как у `POST /api/chat`: `{"ok":true,"reply":"..."}` или `{"ok":false,"error":"..."}` с `500`.

---

## Пример: `fetch` из React / браузера

```typescript
const API_BASE = "https://aiboard.siarheikhamiakou.workers.dev";

async function askLlm(prompt: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  const data = (await res.json()) as { ok: boolean; reply?: string; error?: string };
  if (!res.ok || !data.ok) {
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return data.reply ?? "";
}
```

---

## Postman

1. Метод **POST**, URL: `https://aiboard.siarheikhamiakou.workers.dev/api/chat`
2. **Body** → **raw** → **JSON**, например: `{"prompt":"Hello"}`
3. Отправить; в **Body** ответа смотреть поле `reply`.

Для **GET**: URL `.../api/llm-test` и при необходимости вкладка **Params** → `q`.

---

## `POST /api/telegram-webhook` (Telegram Bot → доска)

Эндпоинт для **webhook** Telegram: BotFather указывает URL вида  
`https://<ваш-worker>/api/telegram-webhook`.

### Что происходит

1. Telegram шлёт **POST** с телом [Update](https://core.telegram.org/bots/api#update) (JSON).
2. Если задан секрет вебхука, заголовок **`X-Telegram-Bot-Api-Secret-Token`** должен совпадать с `TELEGRAM_WEBHOOK_SECRET` (как при `setWebhook` с `secret_token`).
3. Worker **сразу** отвечает **`200`** и текстом **`OK`** (чтобы Telegram не делал лишние повторы).
4. В фоне (`waitUntil`): из `message` или `edited_message` берётся **`text`**, при его отсутствии — **`caption`**; текст отправляется в ту же логику разбиения, что и `POST /api/subtasks` (`decomposeTaskIntoSubtasks` → Venice API).
5. Для **каждого** такого сообщения в Supabase одним вызовом **`telegram_ingest_board_and_tasks`** (Postgres RPC, одна транзакция) создаются **новая доска** с владельцем из секрета **`TELEGRAM_INGEST_BOARD_OWNER_USER_ID`**, три колонки (**Планы**, **В работе**, **Сделано**) и карточки в **«Планы»**. Так исключаются ошибки FK из‑за нескольких отдельных HTTP‑запросов к PostgREST.
6. Заголовок доски — текст сообщения (до 120 символов), при необходимости усечён.
7. **`created_by`** заполняется только если UUID из `TELEGRAM_SERVICE_USER_ID` / сервисный пользователь существует в `auth.users`; иначе вставляется `NULL` (чтобы не ломать FK).
8. В чат приходит короткое сообщение бота с названием доски и числом задач или текст ошибки.

В проекте должна быть применена миграция [`supabase/migrations/20260504210000_telegram_ingest_board_and_tasks_rpc.sql`](D:/GitHub/TaskBoardFornBack/aiboardBackend/aiboard/supabase/migrations/20260504210000_telegram_ingest_board_and_tasks_rpc.sql).

### Переменные окружения (Wrangler secrets / `.dev.vars`)

| Переменная | Назначение |
|------------|------------|
| `TELEGRAM_BOT_TOKEN` | Токен бота от @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Тот же `secret_token`, что при настройке webhook; пустое значение отключает проверку заголовка (только для отладки) |
| `TELEGRAM_INGEST_BOARD_OWNER_USER_ID` | **Обязательно**: UUID пользователя Supabase (`auth.users.id`), который будет **владельцем** каждой новой доски из Telegram |
| `TELEGRAM_SERVICE_USER_ID` | Необязательно: переопределить UUID для поля `board_tasks.created_by` |
| `VENICE_API_KEY` | Ключ Venice для LLM |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Запись в БД от имени service role |

Старые секреты `TELEGRAM_DEFAULT_BOARD_ID` / `TELEGRAM_DEFAULT_COLUMN_ID` больше не используются.

### Ошибки HTTP на входе webhook

| Код | Когда |
|-----|--------|
| `401` | Задан `TELEGRAM_WEBHOOK_SECRET`, но заголовок секрета не совпал |
| `400` | Тело запроса не парсится как JSON |

Ошибки после приёма апдейта (LLM, Supabase) пользователю уходят **сообщением в Telegram**, ответ webhook остаётся **`200 OK`**.

---

## Безопасность

Ключ к Venice хранится только на Cloudflare (секрет `VENICE_API_KEY`); фронтенду ключ не передаётся.

Публичные эндпоинты могут быть использованы кем угодно (расход квоты). Для продакшена имеет смысл добавить авторизацию, rate limiting или вызывать LLM только с вашего бэкенда.
