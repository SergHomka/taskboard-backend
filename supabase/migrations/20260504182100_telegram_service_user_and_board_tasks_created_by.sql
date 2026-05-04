-- Telegram ingest: сервисный пользователь + атрибуция карточек
-- Идемпотентно: можно применять повторно.

ALTER TABLE public.board_tasks
	ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id);

COMMENT ON COLUMN public.board_tasks.created_by IS 'Кто создал карточку; задачи из Telegram — сервисный пользователь ingest.';

INSERT INTO auth.users (
	instance_id,
	id,
	aud,
	role,
	email,
	encrypted_password,
	email_confirmed_at,
	raw_app_meta_data,
	raw_user_meta_data,
	created_at,
	updated_at,
	confirmation_token,
	recovery_token,
	is_sso_user,
	is_anonymous
)
SELECT
	'00000000-0000-0000-0000-000000000000',
	'b01eda72-0000-4000-8000-000000000001',
	'authenticated',
	'authenticated',
	'telegram-ingest@internal.aiboard.local',
	crypt(gen_random_uuid()::text, gen_salt('bf')),
	now(),
	'{"provider":"email","providers":["email"]}'::jsonb,
	'{"telegram_ingest_bot":true}'::jsonb,
	now(),
	now(),
	'',
	'',
	false,
	false
WHERE NOT EXISTS (
	SELECT 1 FROM auth.users WHERE id = 'b01eda72-0000-4000-8000-000000000001'
);

-- Колонка email в auth.identities — generated, не указывать в INSERT
INSERT INTO auth.identities (
	provider_id,
	user_id,
	identity_data,
	provider,
	last_sign_in_at,
	created_at,
	updated_at,
	id
)
SELECT
	'b01eda72-0000-4000-8000-000000000001',
	'b01eda72-0000-4000-8000-000000000001',
	jsonb_build_object(
		'sub', 'b01eda72-0000-4000-8000-000000000001',
		'email', 'telegram-ingest@internal.aiboard.local',
		'email_verified', true,
		'phone_verified', false,
		'provider_id', 'b01eda72-0000-4000-8000-000000000001'
	),
	'email',
	now(),
	now(),
	now(),
	gen_random_uuid()
WHERE NOT EXISTS (
	SELECT 1 FROM auth.identities
	WHERE provider = 'email'
		AND provider_id = 'b01eda72-0000-4000-8000-000000000001'
);
