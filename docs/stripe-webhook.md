# Stripe webhook (`POST /api/stripe-webhook`)

Worker сохраняет успешные сессии **Stripe Checkout** в таблицу Supabase `public.stripe_payments` после события `checkout.session.completed`. Связка с пользователем:

1. **Приоритет** — поле `client_reference_id` в Checkout Session (фронтенд добавляет его к Stripe Payment Link для пользователя Supabase).
2. **Fallback** — email покупателя сопоставляется с `public.profiles.email`.

## Stripe Dashboard

1. Откройте **Developers → Webhooks → Add endpoint**.
2. **Endpoint URL**:  
   `https://<ваш-поддомен>.workers.dev/api/stripe-webhook`  
   (локально см. раздел Stripe CLI ниже).
3. **Events**: включите `checkout.session.completed` и **`customer.subscription.updated`** (обновление даты следующего списания для подписок).
4. Скопируйте **Signing secret** (`whsec_…`) — это переменная `STRIPE_WEBHOOK_SECRET`.

## Секреты Cloudflare Worker

Задайте значения (не коммитьте в git):

```bash
cd aiboardBackend/aiboard
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put STRIPE_SECRET_KEY
```

| Переменная | Назначение |
|------------|------------|
| `STRIPE_WEBHOOK_SECRET` | Signing secret эндпоинта в Stripe (`whsec_…`). |
| `SUPABASE_URL` | URL проекта Supabase (`https://xxx.supabase.co`). |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key — только на сервере, обходит RLS для вставки строк. |
| `STRIPE_SECRET_KEY` | Secret key из Stripe Dashboard (`sk_test_…` / `sk_live_…`). Нужен для верификации вебхука (`constructEventAsync`), при подписке — для **`subscriptions.retrieve`** (дата `current_period_end` при сохранении Checkout). |

Уже используемый ключ Venice не трогаем: `VENICE_API_KEY` по-прежнему в `.dev.vars` локально или через `wrangler secret`.

Локально можно собрать файл **`aiboardBackend/aiboard/.dev.vars`** (файл в `.gitignore`):

```env
VENICE_API_KEY=...
STRIPE_WEBHOOK_SECRET=whsec_...
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
STRIPE_SECRET_KEY=sk_test_...
```

## Supabase

Примените миграции из фронтенд-репозитория: [`myproject/supabase/migrations/`](../../../myproject/supabase/migrations/) (`supabase db push` или SQL в Dashboard), в том числе таблица `stripe_payments` и колонки подписки (`stripe_subscription_id`, `subscription_period_end`).

## Локальная отладка со Stripe CLI

1. Установите [Stripe CLI](https://stripe.com/docs/stripe-cli).
2. Авторизуйтесь: `stripe login`.
3. Запустите воркер: `npm run dev` в `aiboardBackend/aiboard` (по умолчанию порт **8787**).
4. В отдельном терминале:

```bash
stripe listen --forward-to http://127.0.0.1:8787/api/stripe-webhook
```

CLI выведет **webhook signing secret** для форвардинга — подставьте его в `.dev.vars` как `STRIPE_WEBHOOK_SECRET` на время локальных тестов.

5. Триггер тестового события (после реальной оплаты или из Dashboard → отправить тестовое событие типа `checkout.session.completed`).

## Деплой

После настройки секретов:

```bash
npm run deploy
```

Убедитесь, что в Stripe указан URL продакшен-воркера и актуальный signing secret из Dashboard (не от Stripe CLI).
