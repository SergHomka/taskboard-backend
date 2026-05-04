-- FK-проверки учитывают RLS на родительской таблице. При SECURITY DEFINER и владельце
-- без BYPASSRLS вставка в boards может пройти, а следующая вставка в board_tasks —
-- упасть с board_tasks_board_id_fkey. Отключаем RLS на время вызова функции.

CREATE OR REPLACE FUNCTION public.telegram_ingest_board_and_tasks(
	p_owner_id uuid,
	p_board_title text,
	p_created_by uuid,
	p_tasks jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
	v_board_id uuid;
	v_column_id uuid;
	v_pos int;
	v_inserted int := 0;
	el jsonb;
	v_title text;
	v_task text;
	v_creator uuid;
	v_bt_title text;
BEGIN
	IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_owner_id) THEN
		RAISE EXCEPTION 'Владелец доски не найден в auth.users (проверьте TELEGRAM_INGEST_BOARD_OWNER_USER_ID): %', p_owner_id;
	END IF;

	v_creator := NULL;
	IF p_created_by IS NOT NULL AND EXISTS (SELECT 1 FROM auth.users WHERE id = p_created_by) THEN
		v_creator := p_created_by;
	END IF;

	INSERT INTO public.boards (user_id, title, description)
	VALUES (
		p_owner_id,
		left(regexp_replace(trim(p_board_title), '\s+', ' ', 'g'), 120),
		''
	)
	RETURNING id INTO v_board_id;

	INSERT INTO public.board_columns (board_id, title, color_hex, position) VALUES
		(v_board_id, 'Планы', '#3B82F6', 0),
		(v_board_id, 'В работе', '#F59E0B', 1),
		(v_board_id, 'Сделано', '#10B981', 2);

	SELECT id INTO v_column_id
	FROM public.board_columns
	WHERE board_id = v_board_id AND position = 0
	LIMIT 1;

	IF v_column_id IS NULL THEN
		RAISE EXCEPTION 'Не создана колонка «Планы»';
	END IF;

	SELECT COALESCE(MAX(position), -1) + 1 INTO v_pos
	FROM public.board_tasks
	WHERE column_id = v_column_id;

	FOR el IN SELECT * FROM jsonb_array_elements(COALESCE(p_tasks, '[]'::jsonb))
	LOOP
		v_title := trim(COALESCE(el->>'title', ''));
		v_task := trim(COALESCE(el->>'task', ''));
		IF length(v_title) < 1 OR length(v_task) < 1 THEN
			CONTINUE;
		END IF;

		v_bt_title := left(v_title, 100);

		INSERT INTO public.board_tasks (
			board_id,
			column_id,
			title,
			description,
			color_hex,
			focus_minutes,
			position,
			pomodoro_remaining_seconds,
			created_by
		) VALUES (
			v_board_id,
			v_column_id,
			v_bt_title,
			v_task,
			'#3B82F6',
			25,
			v_pos,
			1500,
			v_creator
		);

		v_pos := v_pos + 1;
		v_inserted := v_inserted + 1;
	END LOOP;

	RETURN jsonb_build_object(
		'board_id', v_board_id,
		'tasks_created', v_inserted
	);
END;
$$;

REVOKE ALL ON FUNCTION public.telegram_ingest_board_and_tasks(uuid, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.telegram_ingest_board_and_tasks(uuid, text, uuid, jsonb) TO service_role;
