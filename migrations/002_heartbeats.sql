CREATE TABLE heartbeat_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  ping_token UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  period_seconds INTEGER,
  cron_expr TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  grace_seconds INTEGER NOT NULL DEFAULT 300,
  status TEXT NOT NULL DEFAULT 'new',
  last_ping_at TIMESTAMPTZ,
  last_start_at TIMESTAMPTZ,
  last_exit_code INTEGER,
  expected_at TIMESTAMPTZ,
  grace_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT heartbeat_schedule_chk CHECK (
    (period_seconds IS NOT NULL AND cron_expr IS NULL)
    OR (period_seconds IS NULL AND cron_expr IS NOT NULL)
  ),
  CONSTRAINT heartbeat_period_chk CHECK (period_seconds IS NULL OR period_seconds >= 1),
  CONSTRAINT heartbeat_grace_chk CHECK (grace_seconds >= 0)
);

CREATE INDEX heartbeat_checks_user_id_idx ON heartbeat_checks (user_id);
CREATE INDEX heartbeat_checks_eval_idx ON heartbeat_checks (status, grace_until);

CREATE TABLE heartbeat_pings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id UUID NOT NULL REFERENCES heartbeat_checks (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_ip TEXT,
  user_agent TEXT,
  body_excerpt TEXT,
  exit_code INTEGER
);

CREATE INDEX heartbeat_pings_check_received_idx ON heartbeat_pings (check_id, received_at DESC);
