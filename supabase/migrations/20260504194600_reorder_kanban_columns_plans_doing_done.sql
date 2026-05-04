-- Стандартный порядок колонок: Планы → В работе → Сделано (только доски ровно из этих трёх колонок).

DO $$
DECLARE bid uuid;
BEGIN
	FOR bid IN
		SELECT board_id
		FROM public.board_columns
		GROUP BY board_id
		HAVING COUNT(*) = 3
			AND COUNT(*) FILTER (WHERE title IN ('Планы', 'В работе', 'Сделано')) = 3
	LOOP
		UPDATE public.board_columns
		SET position = position + 100
		WHERE board_id = bid;

		UPDATE public.board_columns
		SET position = 0
		WHERE board_id = bid AND title = 'Планы';

		UPDATE public.board_columns
		SET position = 1
		WHERE board_id = bid AND title = 'В работе';

		UPDATE public.board_columns
		SET position = 2
		WHERE board_id = bid AND title = 'Сделано';
	END LOOP;
END $$;
