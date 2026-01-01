-- Cloud plan limits: starter and pro, with no free cloud tier.
-- Existing plan_gates columns stay; retention remains in days (12 months = 365,
-- 24 months = 730). New columns cover status pages, seats, and feature flags.
-- seo_enabled is kept in sync with seo_check for older readers.

ALTER TABLE plan_gates
  ADD COLUMN IF NOT EXISTS status_page_count INTEGER,
  ADD COLUMN IF NOT EXISTS seat_count INTEGER,
  ADD COLUMN IF NOT EXISTS ssl_check BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS domain_expiry BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS seo_check BOOLEAN NOT NULL DEFAULT false;

UPDATE plan_gates SET seo_check = seo_enabled;

INSERT INTO plan_gates (
  tier, site_count, min_interval_seconds, retention_days,
  alert_channels, seo_enabled, heartbeat_check_count,
  status_page_count, seat_count, ssl_check, domain_expiry, seo_check
) VALUES
  (
    'no_plan', NULL, NULL, NULL,
    ARRAY['email']::TEXT[], false, NULL,
    NULL, NULL, false, false, false
  ),
  (
    'starter', 15, 60, 365,
    ARRAY['email', 'slack', 'discord', 'webhook']::TEXT[], true, 5,
    1, 1, true, true, true
  ),
  (
    'pro', 60, 30, 730,
    ARRAY['email', 'slack', 'discord', 'webhook']::TEXT[], true, 25,
    5, 3, true, true, true
  )
ON CONFLICT (tier) DO UPDATE SET
  site_count = excluded.site_count,
  min_interval_seconds = excluded.min_interval_seconds,
  retention_days = excluded.retention_days,
  alert_channels = excluded.alert_channels,
  seo_enabled = excluded.seo_enabled,
  heartbeat_check_count = excluded.heartbeat_check_count,
  status_page_count = excluded.status_page_count,
  seat_count = excluded.seat_count,
  ssl_check = excluded.ssl_check,
  domain_expiry = excluded.domain_expiry,
  seo_check = excluded.seo_check;

-- selfhosted stays unlimited (this is the free version).
UPDATE plan_gates
   SET status_page_count = NULL,
       seat_count = NULL,
       ssl_check = true,
       domain_expiry = true,
       seo_check = true,
       seo_enabled = true,
       alert_channels = ARRAY['email', 'slack', 'sms', 'discord', 'webhook']::TEXT[]
 WHERE tier = 'selfhosted';

-- Legacy 'cloud' placeholder is no longer a usable free plan. Keep the row
-- so existing user rows still satisfy the foreign key, but grant no entitlements.
-- Creates are refused with PLAN_REQUIRED in cloud mode; NULL caps keep any
-- already-created checks running and readable.
UPDATE plan_gates
   SET site_count = NULL,
       min_interval_seconds = NULL,
       retention_days = NULL,
       heartbeat_check_count = NULL,
       status_page_count = NULL,
       seat_count = NULL,
       ssl_check = false,
       domain_expiry = false,
       seo_check = false,
       seo_enabled = false,
       alert_channels = ARRAY['email']::TEXT[]
 WHERE tier = 'cloud';

UPDATE users SET tier = 'no_plan' WHERE tier = 'hosted_free';
DELETE FROM plan_gates WHERE tier = 'hosted_free';

-- A user may have more than one status page (pro allows 5).
ALTER TABLE status_pages DROP CONSTRAINT IF EXISTS status_pages_user_id_key;
CREATE INDEX IF NOT EXISTS status_pages_user_id_idx ON status_pages (user_id);

-- Billing interval lives on the subscription row only. No prices or payment ids.
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  plan TEXT NOT NULL REFERENCES plan_gates (tier),
  billing_interval TEXT NOT NULL CHECK (billing_interval IN ('monthly', 'yearly')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'canceled', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
