-- Week 7+ extras: SSL certificate expiry, domain registration expiry, and basic SEO checks.
-- One row per site, removed with the site. Reminder columns record which expiry date and
-- which threshold (30/14/7/1/0 days) was last reminded, so each threshold is sent once per
-- certificate or registration and a renewal starts a fresh series.
CREATE TABLE IF NOT EXISTS site_insights (
  site_id UUID PRIMARY KEY REFERENCES sites (id) ON DELETE CASCADE,
  ssl_expires_at TIMESTAMPTZ,
  ssl_valid_from TIMESTAMPTZ,
  ssl_issuer TEXT,
  ssl_subject TEXT,
  ssl_checked_at TIMESTAMPTZ,
  ssl_reminded_for TIMESTAMPTZ,
  ssl_reminded_days INTEGER,
  domain_name TEXT,
  domain_expires_at TIMESTAMPTZ,
  domain_checked_at TIMESTAMPTZ,
  domain_error TEXT,
  domain_reminded_for TIMESTAMPTZ,
  domain_reminded_days INTEGER,
  seo_checked_at TIMESTAMPTZ,
  seo_result JSONB,
  seo_issues TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS site_insights_domain_checked_idx ON site_insights (domain_checked_at NULLS FIRST);
CREATE INDEX IF NOT EXISTS site_insights_seo_checked_idx ON site_insights (seo_checked_at NULLS FIRST);

-- Plan defaults until the plan split is decided: basic SEO checks are a Pro feature.
-- Starter keeps SSL and domain expiry. selfhosted is unchanged (everything on).
UPDATE plan_gates SET seo_check = false, seo_enabled = false WHERE tier = 'starter';
