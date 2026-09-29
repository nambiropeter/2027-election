-- Hardens the poll schema: row level security, tamper-resistant one-vote
-- enforcement, O(1) tallies, and database-backed rate limiting so the
-- serverless (Supabase Edge Function) path does not need Redis.

-- ---------------------------------------------------------------------------
-- 1. Columns used by the new vote pipeline
-- ---------------------------------------------------------------------------

ALTER TABLE votes ADD COLUMN IF NOT EXISTS fingerprint_hash CHAR(64);
ALTER TABLE votes ADD COLUMN IF NOT EXISTS user_agent_hash CHAR(64);

-- Denormalised tally. Counting 10M rows per page load does not scale; the
-- trigger below keeps this exact and lets /poll read seven rows instead.
ALTER TABLE poll_options ADD COLUMN IF NOT EXISTS vote_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_votes_fingerprint ON votes (poll_id, fingerprint_hash);
CREATE INDEX IF NOT EXISTS idx_votes_created_at ON votes (created_at);

-- device_hash is the hard one-vote key. Older databases already carry this as
-- a UNIQUE constraint; only add the index when that constraint is absent, so
-- the uniqueness guarantee is never dropped mid-migration.
DO $$
DECLARE
  v_has_constraint BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'votes'
      AND c.contype = 'u'
      AND (
        SELECT array_agg(a.attname::text ORDER BY a.attname::text)
        FROM unnest(c.conkey) AS k(attnum)
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      ) = ARRAY['device_hash', 'poll_id']
  ) INTO v_has_constraint;

  IF NOT v_has_constraint THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_votes_poll_device ON votes (poll_id, device_hash);
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Tally maintenance
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION sync_option_vote_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE poll_options SET vote_count = vote_count + 1 WHERE id = NEW.option_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE poll_options SET vote_count = GREATEST(vote_count - 1, 0) WHERE id = OLD.option_id;
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' AND NEW.option_id IS DISTINCT FROM OLD.option_id THEN
    UPDATE poll_options SET vote_count = GREATEST(vote_count - 1, 0) WHERE id = OLD.option_id;
    UPDATE poll_options SET vote_count = vote_count + 1 WHERE id = NEW.option_id;
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_option_vote_count ON votes;
CREATE TRIGGER trg_sync_option_vote_count
AFTER INSERT OR UPDATE OR DELETE ON votes
FOR EACH ROW EXECUTE FUNCTION sync_option_vote_count();

-- One-time backfill of the new counter column. Guarded so re-running this file
-- (the Node server applies it on boot) never rescans the whole votes table.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM poll_options WHERE vote_count > 0)
     AND EXISTS (SELECT 1 FROM votes) THEN
    UPDATE poll_options o
    SET vote_count = COALESCE(c.total, 0)
    FROM (
      SELECT option_id, COUNT(*)::INTEGER AS total FROM votes GROUP BY option_id
    ) c
    WHERE c.option_id = o.id;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. Database-backed rate limiting (no Redis needed on the serverless path)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_expires_at ON rate_limits (expires_at);

-- Returns TRUE when the caller is still inside the allowance.
CREATE OR REPLACE FUNCTION consume_rate_limit(
  p_key TEXT,
  p_limit INTEGER,
  p_window_seconds INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_hits INTEGER;
BEGIN
  INSERT INTO rate_limits (bucket_key, hits, expires_at)
  VALUES (p_key, 1, NOW() + make_interval(secs => p_window_seconds))
  ON CONFLICT (bucket_key) DO UPDATE
    SET hits = CASE
          WHEN rate_limits.expires_at < NOW() THEN 1
          ELSE rate_limits.hits + 1
        END,
        expires_at = CASE
          WHEN rate_limits.expires_at < NOW()
            THEN NOW() + make_interval(secs => p_window_seconds)
          ELSE rate_limits.expires_at
        END
  RETURNING hits INTO v_hits;

  RETURN v_hits <= p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION prune_rate_limits()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM rate_limits WHERE expires_at < NOW() - INTERVAL '1 hour';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Read + write API used by the edge functions and the Node server
-- ---------------------------------------------------------------------------

-- Replaced by poll_results; the old version was reachable by the public anon
-- key over PostgREST RPC.
DROP FUNCTION IF EXISTS poll_option_totals(INTEGER);

CREATE OR REPLACE FUNCTION poll_results(p_poll_id INTEGER)
RETURNS TABLE (
  id INTEGER,
  label TEXT,
  sort_order INTEGER,
  votes INTEGER
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT o.id, o.label, o.sort_order, o.vote_count AS votes
  FROM poll_options o
  WHERE o.poll_id = p_poll_id
  ORDER BY o.sort_order ASC, o.id ASC;
$$;

CREATE OR REPLACE FUNCTION has_voted(p_poll_id INTEGER, p_device_hash CHAR(64))
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT v.option_id
  FROM votes v
  WHERE v.poll_id = p_poll_id AND v.device_hash = p_device_hash
  LIMIT 1;
$$;

-- Single atomic entry point for casting a vote. Every integrity check runs
-- inside one transaction so concurrent requests cannot interleave between the
-- "have you voted?" read and the insert.
--
-- status is one of: ok | already_voted | poll_closed | invalid_option |
--                   fingerprint_limit
CREATE OR REPLACE FUNCTION cast_vote(
  p_poll_id INTEGER,
  p_option_id INTEGER,
  p_device_hash CHAR(64),
  p_ip_hash CHAR(64),
  p_fingerprint_hash CHAR(64),
  p_user_agent_hash CHAR(64),
  p_country_code CHAR(2),
  p_max_per_fingerprint INTEGER DEFAULT 25
)
RETURNS TABLE (status TEXT, option_id INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing_option INTEGER;
  v_fingerprint_votes INTEGER;
  v_inserted INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM polls WHERE id = p_poll_id AND is_active = TRUE
  ) THEN
    RETURN QUERY SELECT 'poll_closed'::TEXT, NULL::INTEGER;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM poll_options WHERE id = p_option_id AND poll_id = p_poll_id
  ) THEN
    RETURN QUERY SELECT 'invalid_option'::TEXT, NULL::INTEGER;
    RETURN;
  END IF;

  SELECT v.option_id INTO v_existing_option
  FROM votes v
  WHERE v.poll_id = p_poll_id AND v.device_hash = p_device_hash
  LIMIT 1;

  IF FOUND THEN
    RETURN QUERY SELECT 'already_voted'::TEXT, v_existing_option;
    RETURN;
  END IF;

  -- Soft throttle: caps automated fan-out from a single network/browser
  -- signature without hard-blocking shared connections (Kenyan mobile CGNAT
  -- puts many genuine voters behind one address range).
  IF p_fingerprint_hash IS NOT NULL AND p_max_per_fingerprint > 0 THEN
    SELECT COUNT(*)::INTEGER INTO v_fingerprint_votes
    FROM votes v
    WHERE v.poll_id = p_poll_id AND v.fingerprint_hash = p_fingerprint_hash;

    IF v_fingerprint_votes >= p_max_per_fingerprint THEN
      RETURN QUERY SELECT 'fingerprint_limit'::TEXT, NULL::INTEGER;
      RETURN;
    END IF;
  END IF;

  INSERT INTO votes (
    poll_id, option_id, device_hash, ip_hash,
    fingerprint_hash, user_agent_hash, country_code
  )
  VALUES (
    p_poll_id, p_option_id, p_device_hash, p_ip_hash,
    p_fingerprint_hash, p_user_agent_hash, p_country_code
  )
  ON CONFLICT (poll_id, device_hash) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 THEN
    SELECT v.option_id INTO v_existing_option
    FROM votes v
    WHERE v.poll_id = p_poll_id AND v.device_hash = p_device_hash
    LIMIT 1;
    RETURN QUERY SELECT 'already_voted'::TEXT, v_existing_option;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'ok'::TEXT, p_option_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Row level security
--
-- The anon key ships in the browser, so PostgREST must expose nothing. No
-- policies are defined on purpose: every legitimate read and write goes
-- through the edge functions using the service role, which bypasses RLS.
-- ---------------------------------------------------------------------------

ALTER TABLE polls ENABLE ROW LEVEL SECURITY;
ALTER TABLE poll_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;

-- Deliberately ENABLE and not FORCE: FORCE would subject the table owner to
-- RLS as well, which would starve the SECURITY DEFINER functions above (they
-- run as the owner) and the self-hosted Node server's direct connection. With
-- plain ENABLE, the owner and service_role still work while anon and
-- authenticated - the roles whose keys ship in the browser - get nothing.

-- SECURITY DEFINER functions must never be reachable by PUBLIC.
REVOKE ALL ON FUNCTION poll_results(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION has_voted(INTEGER, CHAR(64)) FROM PUBLIC;
REVOKE ALL ON FUNCTION cast_vote(INTEGER, INTEGER, CHAR(64), CHAR(64), CHAR(64), CHAR(64), CHAR(2), INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION consume_rate_limit(TEXT, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION prune_rate_limits() FROM PUBLIC;
REVOKE ALL ON FUNCTION sync_option_vote_count() FROM PUBLIC;

-- The anon/authenticated/service_role roles only exist on Supabase. Guarding
-- on pg_roles lets this same file run against a plain self-hosted Postgres.
DO $$
DECLARE
  v_fn TEXT;
  v_functions TEXT[] := ARRAY[
    'poll_results(INTEGER)',
    'has_voted(INTEGER, CHAR(64))',
    'cast_vote(INTEGER, INTEGER, CHAR(64), CHAR(64), CHAR(64), CHAR(64), CHAR(2), INTEGER)',
    'consume_rate_limit(TEXT, INTEGER, INTEGER)',
    'prune_rate_limits()'
  ];
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON polls, poll_options, votes, rate_limits FROM anon';
    EXECUTE 'REVOKE ALL ON SEQUENCE polls_id_seq, poll_options_id_seq, votes_id_seq FROM anon';
    FOREACH v_fn IN ARRAY v_functions LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_fn);
    END LOOP;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON polls, poll_options, votes, rate_limits FROM authenticated';
    EXECUTE 'REVOKE ALL ON SEQUENCE polls_id_seq, poll_options_id_seq, votes_id_seq FROM authenticated';
    FOREACH v_fn IN ARRAY v_functions LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', v_fn);
    END LOOP;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    FOREACH v_fn IN ARRAY v_functions LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
    END LOOP;
  END IF;
END
$$;
