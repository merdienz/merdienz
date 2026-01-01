CREATE TABLE plan_gates (
  tier TEXT PRIMARY KEY,
  site_count INTEGER,
  min_interval_seconds INTEGER,
  retention_days INTEGER,
  alert_channels TEXT[] NOT NULL DEFAULT ARRAY['email']::TEXT[],
  seo_enabled BOOLEAN NOT NULL DEFAULT false,
  heartbeat_check_count INTEGER
);

-- selfhosted is uncapped. Cloud values are placeholders (min interval 60s).
-- hosted_free is kept unused: there is no free hosted tier.
INSERT INTO plan_gates (
  tier, site_count, min_interval_seconds, retention_days,
  alert_channels, seo_enabled, heartbeat_check_count
) VALUES
  (
    'selfhosted', NULL, NULL, NULL,
    ARRAY['email', 'slack', 'sms', 'webhook']::TEXT[], true, NULL
  ),
  (
    'cloud', 20, 60, 90,
    ARRAY['email', 'slack', 'sms', 'webhook']::TEXT[], true, 50
  ),
  (
    'hosted_free', 3, 300, 7,
    ARRAY['email']::TEXT[], false, 3
  );

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  api_key TEXT NOT NULL UNIQUE,
  tier TEXT NOT NULL DEFAULT 'selfhosted' REFERENCES plan_gates (tier),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL DEFAULT 300,
  timeout_ms INTEGER NOT NULL DEFAULT 10000,
  up_status_codes TEXT NOT NULL DEFAULT '2xx,3xx',
  enabled BOOLEAN NOT NULL DEFAULT true,
  current_status TEXT NOT NULL DEFAULT 'unknown',
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX sites_user_id_idx ON sites (user_id);
CREATE INDEX sites_due_idx ON sites (enabled, last_checked_at);

CREATE TABLE check_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  probe_a_ok BOOLEAN,
  probe_a_http_status INTEGER,
  probe_a_latency_ms INTEGER,
  probe_a_error TEXT,
  probe_b_ok BOOLEAN,
  probe_b_http_status INTEGER,
  probe_b_latency_ms INTEGER,
  probe_b_error TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX check_results_site_checked_idx ON check_results (site_id, checked_at DESC);

CREATE TABLE incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'open',
  alerted BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX incidents_site_status_idx ON incidents (site_id, status);
