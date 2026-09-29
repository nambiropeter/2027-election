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
SELECT 'With Chief Justice (Rtd) David Maraga joining the race, which candidate do you believe has the right vision to lead Kenya in 2027?', TRUE
WHERE NOT EXISTS (SELECT 1 FROM polls);

INSERT INTO poll_options (poll_id, label, sort_order)
SELECT p.id, v.label, v.sort_order
FROM (VALUES
  ('William Ruto - UDA (Kenya Kwanza): The Incumbent; Bottom-Up Transformation.', 1),
  ('Kalonzo Musyoka - Wiper (Azimio): The Diplomat; focus on stability and unity.', 2),
  ('David Maraga - United Green Movement: The Jurist; focus on integrity and the rule of law.', 3),
  ('Fred Matiang''i - Jubilee Party: The Reformer; focus on efficient service delivery.', 4),
  ('Okiya Omtatah - NRA: The Defender; focus on constitutionalism and the common man.', 5),
  ('Rigathi Gachagua - TBD: The Regional Voice; strong focus on Mt. Kenya interests.', 6),
  ('Edwin Sifuna - ODM: The Firebrand; focus on party loyalty and accountability.', 7),
  ('Undecided - Still weighing the impact of these new entries.', 99)
) AS v(label, sort_order)
CROSS JOIN polls p
WHERE p.is_active = TRUE
  AND NOT EXISTS (SELECT 1 FROM poll_options WHERE poll_id = p.id);
