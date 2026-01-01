ALTER TABLE sites
  ADD COLUMN public_on_status BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE heartbeat_checks
  ADD COLUMN public_on_status BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE status_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE heartbeat_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id UUID NOT NULL REFERENCES heartbeat_checks (id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'open',
  reason TEXT
);

CREATE INDEX heartbeat_incidents_check_status_idx ON heartbeat_incidents (check_id, status);
