CREATE TABLE IF NOT EXISTS contacts (id serial PRIMARY KEY, name text NOT NULL, phone_enc text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sends (week_start date NOT NULL, soldier_key text NOT NULL, soldier_name text NOT NULL, params_hash text NOT NULL, wamid text, status text NOT NULL, error text, sent_at timestamptz NOT NULL DEFAULT now(), status_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (week_start, soldier_key));
CREATE INDEX IF NOT EXISTS sends_wamid ON sends (wamid);
