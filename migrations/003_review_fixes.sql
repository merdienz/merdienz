CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key_prefix TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key_hash TEXT;

UPDATE users
   SET api_key_prefix = left(api_key, 8),
       api_key_hash = encode(digest(convert_to(api_key, 'UTF8'), 'sha256'), 'hex')
 WHERE api_key IS NOT NULL
   AND api_key_hash IS NULL;

ALTER TABLE users ALTER COLUMN api_key_prefix SET NOT NULL;
ALTER TABLE users ALTER COLUMN api_key_hash SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_api_key_hash_uq ON users (api_key_hash);
ALTER TABLE users DROP COLUMN IF EXISTS api_key;
ALTER TABLE users ALTER COLUMN tier DROP DEFAULT;

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS token_hash TEXT;
UPDATE sessions
   SET token_hash = encode(digest(convert_to(token, 'UTF8'), 'sha256'), 'hex')
 WHERE token IS NOT NULL
   AND token_hash IS NULL;
ALTER TABLE sessions ALTER COLUMN token_hash SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_uq ON sessions (token_hash);
ALTER TABLE sessions DROP COLUMN IF EXISTS token;

ALTER TABLE check_results ADD COLUMN IF NOT EXISTS probe_b_via TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS incidents_one_open_idx
  ON incidents (site_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS alert_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  last_error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS alert_outbox_unsent_idx
  ON alert_outbox (created_at) WHERE sent_at IS NULL;
