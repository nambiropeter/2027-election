CREATE TABLE IF NOT EXISTS polls (
  id SERIAL PRIMARY KEY,
  question TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS poll_options (
  id SERIAL PRIMARY KEY,
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS votes (
  id BIGSERIAL PRIMARY KEY,
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  device_hash CHAR(64) NOT NULL,
  ip_hash CHAR(64) NOT NULL,
  ip_address INET,
  country_code CHAR(2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (poll_id, device_hash)
);

CREATE INDEX IF NOT EXISTS idx_votes_poll_id ON votes (poll_id);
CREATE INDEX IF NOT EXISTS idx_votes_option_id ON votes (option_id);

INSERT INTO polls (question, is_active)
SELECT 'What is your general feeling about the 2027 elections in Kenya?', TRUE
WHERE NOT EXISTS (SELECT 1 FROM polls);

INSERT INTO poll_options (poll_id, label, sort_order)
SELECT p.id, v.label, v.sort_order
FROM (VALUES
  ('Very positive', 1),
  ('Neutral', 2),
  ('Concerned', 3),
  ('Very concerned', 4)
) AS v(label, sort_order)
CROSS JOIN polls p
WHERE p.is_active = TRUE
  AND NOT EXISTS (SELECT 1 FROM poll_options WHERE poll_id = p.id);
