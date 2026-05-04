-- Убираем автосоздание новой доски на каждую вставку board_tasks (Fallback 2).
-- Telegram-должен идти через RPC telegram_ingest_board_and_tasks (одна доска на сообщение).
-- Оставляем: синхронизацию board_id по column_id; восстановление трёх колонок только если доска уже существует.

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
	v_board_exists boolean := false;
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

	-- Fallback: колонка не найдена, но board_id указывает на существующую доску.
	IF NEW.board_id IS NOT NULL THEN
		SELECT EXISTS(SELECT 1 FROM public.boards b WHERE b.id = NEW.board_id)
		INTO v_board_exists;

		IF v_board_exists THEN
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
					(NEW.board_id, 'Сделано', '#10B981', 2);

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
	END IF;

	RAISE EXCEPTION
		'Некорректные board_id/column_id для board_tasks. Используйте RPC telegram_ingest_board_and_tasks или укажите существующую колонку/доску. column_id=%, board_id=%',
		NEW.column_id, NEW.board_id;
END;
$$;
