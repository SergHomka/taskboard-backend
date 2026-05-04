-- Исправление permission denied for table users:
-- триггер больше не читает auth.users и не зависит от прав на эту таблицу.
-- Также делаем функцию SECURITY DEFINER, чтобы fallback мог создать board/columns.

CREATE OR REPLACE FUNCTION public.board_tasks_sync_board_id_from_column()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
	v_board_id uuid;
	v_column_id uuid;
	v_owner_id uuid;
	v_board_title text;
BEGIN
	-- Основной путь: колонка существует => board_id всегда берём из неё.
	SELECT bc.board_id
	INTO v_board_id
	FROM public.board_columns bc
	WHERE bc.id = NEW.column_id;

	IF v_board_id IS NOT NULL THEN
		NEW.board_id := v_board_id;
		RETURN NEW;
	END IF;

	-- Fallback 1: колонка не найдена, но board_id валиден.
	IF NEW.board_id IS NOT NULL THEN
		SELECT bc.id, bc.board_id
		INTO v_column_id, v_board_id
		FROM public.board_columns bc
		WHERE bc.board_id = NEW.board_id
		ORDER BY
			CASE WHEN bc.position = 0 THEN 0 ELSE 1 END,
			bc.position ASC,
			bc.created_at ASC
		LIMIT 1;

		IF v_column_id IS NULL THEN
			INSERT INTO public.board_columns (board_id, title, color_hex, position) VALUES
				(NEW.board_id, 'Планы', '#3B82F6', 0),
				(NEW.board_id, 'В работе', '#F59E0B', 1),
				(NEW.board_id, 'Сделано', '#10B981', 2)
			ON CONFLICT DO NOTHING;

			SELECT bc.id, bc.board_id
			INTO v_column_id, v_board_id
			FROM public.board_columns bc
			WHERE bc.board_id = NEW.board_id
			ORDER BY
				CASE WHEN bc.position = 0 THEN 0 ELSE 1 END,
				bc.position ASC,
				bc.created_at ASC
			LIMIT 1;
		END IF;

		IF v_column_id IS NOT NULL THEN
			NEW.column_id := v_column_id;
			NEW.board_id := v_board_id;
			RETURN NEW;
		END IF;
	END IF;

	-- Fallback 2: и board_id, и column_id невалидны => создаём новую доску и колонки.
	SELECT b.user_id
	INTO v_owner_id
	FROM public.boards b
	WHERE b.user_id IS NOT NULL
	ORDER BY b.created_at DESC
	LIMIT 1;

	IF v_owner_id IS NULL THEN
		v_owner_id := 'b01eda72-0000-4000-8000-000000000001'::uuid;
	END IF;

	v_board_title := left(
		COALESCE(NULLIF(trim(NEW.title), ''), 'Telegram задача') || ' • Telegram',
		120
	);

	INSERT INTO public.boards (user_id, title, description)
	VALUES (v_owner_id, v_board_title, '')
	RETURNING id INTO v_board_id;

	INSERT INTO public.board_columns (board_id, title, color_hex, position) VALUES
		(v_board_id, 'Планы', '#3B82F6', 0),
		(v_board_id, 'В работе', '#F59E0B', 1),
		(v_board_id, 'Сделано', '#10B981', 2);

	SELECT bc.id INTO v_column_id
	FROM public.board_columns bc
	WHERE bc.board_id = v_board_id AND bc.position = 0
	LIMIT 1;

	NEW.board_id := v_board_id;
	NEW.column_id := v_column_id;
	RETURN NEW;
END;
$$;
