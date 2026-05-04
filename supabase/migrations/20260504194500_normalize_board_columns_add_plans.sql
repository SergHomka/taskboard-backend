-- Если у доски нет колонки «Планы», сдвигаем позиции и добавляем её первой (как на канбан и как создаёт Telegram-worker).

DO $$
DECLARE r RECORD;
BEGIN
	FOR r IN
		SELECT b.id AS bid
		FROM public.boards b
		WHERE NOT EXISTS (
			SELECT 1
			FROM public.board_columns c
			WHERE c.board_id = b.id AND c.title = 'Планы'
		)
	LOOP
		UPDATE public.board_columns
		SET position = position + 1
		WHERE board_id = r.bid;

		INSERT INTO public.board_columns (board_id, title, color_hex, position)
		VALUES (r.bid, 'Планы', '#3B82F6', 0);
	END LOOP;
END $$;
