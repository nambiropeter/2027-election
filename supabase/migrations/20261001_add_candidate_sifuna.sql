-- Adds Edwin Sifuna to the active poll.
--
-- Idempotent and safe on a live poll: it only inserts a new option row, so
-- existing votes and their option ids are untouched. "Undecided" is pushed to
-- the end so it stays the last choice on the ballot.

DO $$
DECLARE
  v_poll_id INTEGER;
BEGIN
  SELECT id INTO v_poll_id
  FROM polls
  WHERE is_active = TRUE
  ORDER BY id DESC
  LIMIT 1;

  IF v_poll_id IS NULL THEN
    RAISE NOTICE 'No active poll found; skipping candidate insert.';
    RETURN;
  END IF;

  -- Keep "Undecided" last on the ballot.
  UPDATE poll_options
  SET sort_order = 99
  WHERE poll_id = v_poll_id
    AND label LIKE 'Undecided%';

  INSERT INTO poll_options (poll_id, label, sort_order)
  SELECT
    v_poll_id,
    'Edwin Sifuna - ODM: The Firebrand; focus on party loyalty and accountability.',
    7
  WHERE NOT EXISTS (
    SELECT 1 FROM poll_options
    WHERE poll_id = v_poll_id AND label LIKE 'Edwin Sifuna%'
  );
END
$$;
