-- Гарантируем согласованность board_tasks.board_id с выбранной колонкой.
-- Это убирает падения по board_tasks_board_id_fkey, если клиент присылает
-- корректный column_id, но некорректный/устаревший board_id.

CREATE OR REPLACE FUNCTION public.board_tasks_sync_board_id_from_column()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	v_board_id uuid;
BEGIN
	SELECT bc.board_id
	INTO v_board_id
	FROM public.board_columns bc
	WHERE bc.id = NEW.column_id;

	IF v_board_id IS NULL THEN
		RAISE EXCEPTION 'Колонка не найдена для board_tasks.column_id: %', NEW.column_id;
	END IF;

	NEW.board_id := v_board_id;
	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS board_tasks_sync_board_id_from_column_trg ON public.board_tasks;

CREATE TRIGGER board_tasks_sync_board_id_from_column_trg
BEFORE INSERT OR UPDATE OF column_id, board_id
ON public.board_tasks
FOR EACH ROW
EXECUTE FUNCTION public.board_tasks_sync_board_id_from_column();
