# API для фронтенда (чат с LLM)

Базовый URL продакшена:

`https://aiboard.siarheikhamiakou.workers.dev`

Локально (`wrangler dev`): `http://localhost:8787`

Все пути ниже относительны к этому origin. Для запросов из браузера с другого домена включены **CORS** (`Access-Control-Allow-Origin: *`, поддерживаются `GET`, `POST`, `OPTIONS`).

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
  "model": "openai-gpt-oss-120b"
}
```

Поле `model` необязательно; если не передать, используется модель по умолчанию на бэкенде (`openai-gpt-oss-120b`).

**Вариант B — цепочка сообщений (формат как у OpenAI Chat):**

```json
{
  "messages": [
    { "role": "system", "content": "Отвечай кратко." },
    { "role": "user", "content": "Привет!" }
  ],
  "model": "openai-gpt-oss-120b"
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

## Безопасность

Ключ к Venice хранится только на Cloudflare (секрет `VENICE_API_KEY`); фронтенду ключ не передаётся.

Публичные эндпоинты могут быть использованы кем угодно (расход квоты). Для продакшена имеет смысл добавить авторизацию, rate limiting или вызывать LLM только с вашего бэкенда.
