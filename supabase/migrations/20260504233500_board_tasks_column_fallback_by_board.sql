-- Дополнение к board_tasks_sync_board_id_from_column:
-- если клиент прислал несуществующий column_id, но передал корректный board_id,
-- пытаемся подобрать колонку этой доски (с приоритетом position=0).

CREATE OR REPLACE FUNCTION public.board_tasks_sync_board_id_from_column()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	v_board_id uuid;
	v_column_id uuid;
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

	-- Fallback: если column_id не найден, но есть board_id — подбираем колонку доски.
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

		IF v_column_id IS NOT NULL THEN
			NEW.column_id := v_column_id;
			NEW.board_id := v_board_id;
			RETURN NEW;
		END IF;
	END IF;

	RAISE EXCEPTION 'Колонка не найдена для board_tasks.column_id: % (board_id=%)', NEW.column_id, NEW.board_id;
END;
$$;
