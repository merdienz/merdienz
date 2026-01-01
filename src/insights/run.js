import { allowsPrivateTargets } from '../guard.js';
import { createSafeFetch } from '../probes/safe-fetch.js';
import { lookupDomainExpiry, recordDomainResult, registrableDomain } from './domain.js';
import { recordSeoResult, runSeoCheck } from './seo.js';

export const INSIGHTS_RECHECK_HOURS = 24;

// Picks at most one site per account per tick, oldest check first, so one account with many
// sites cannot hold back the others. Only sites that are scheduled for checks (enabled, not on
// billing hold, inside the plan's site count) and whose plan has the feature are picked.
async function claimDue(db, { now, limit, domainOn, seoOn }) {
  const { rows } = await db.query(
    `WITH ranked AS (
       SELECT s.id, s.name, s.url, s.user_id, u.email AS user_email,
              (g.domain_expiry AND $3::boolean
                AND (i.domain_checked_at IS NULL OR i.domain_checked_at <= $1::timestamptz - make_interval(hours => $5))) AS want_domain,
              (g.seo_check AND $4::boolean
                AND (i.seo_checked_at IS NULL OR i.seo_checked_at <= $1::timestamptz - make_interval(hours => $5))) AS want_seo,
              LEAST(COALESCE(i.domain_checked_at, 'epoch'::timestamptz), COALESCE(i.seo_checked_at, 'epoch'::timestamptz)) AS oldest,
              ROW_NUMBER() OVER (PARTITION BY s.user_id ORDER BY s.created_at ASC) AS site_rn,
              g.site_count
         FROM sites s
         JOIN users u ON u.id = s.user_id
         JOIN plan_gates g ON g.tier = u.tier
         LEFT JOIN site_insights i ON i.site_id = s.id
        WHERE s.enabled = true
          AND s.billing_hold = false
     ),
     eligible AS (
       SELECT * FROM ranked
        WHERE (site_count IS NULL OR site_rn <= site_count)
          AND (want_domain OR want_seo)
     ),
     one_per_user AS (
       SELECT DISTINCT ON (user_id) * FROM eligible ORDER BY user_id, oldest ASC, id
     )
     SELECT * FROM one_per_user ORDER BY oldest ASC, id LIMIT $2`,
    [now, limit, domainOn, seoOn, INSIGHTS_RECHECK_HOURS]
  );
  const claimed = [];
  for (const row of rows) {
    // Claim before any network call, so a slow or failing target is retried a day later,
    // not on every tick. The conditional update makes the claim safe across processes.
    const res = await db.query(
      `INSERT INTO site_insights (site_id, domain_checked_at, seo_checked_at, updated_at)
       VALUES ($1, CASE WHEN $2::boolean THEN $4::timestamptz END, CASE WHEN $3::boolean THEN $4::timestamptz END, $4)
       ON CONFLICT (site_id) DO UPDATE SET
         domain_checked_at = CASE WHEN $2::boolean THEN $4::timestamptz ELSE site_insights.domain_checked_at END,
         seo_checked_at = CASE WHEN $3::boolean THEN $4::timestamptz ELSE site_insights.seo_checked_at END,
         updated_at = $4
       WHERE ($2::boolean AND (site_insights.domain_checked_at IS NULL OR site_insights.domain_checked_at <= $4::timestamptz - make_interval(hours => $5)))
          OR ($3::boolean AND (site_insights.seo_checked_at IS NULL OR site_insights.seo_checked_at <= $4::timestamptz - make_interval(hours => $5)))
       RETURNING site_id`,
      [row.id, row.want_domain, row.want_seo, now, INSIGHTS_RECHECK_HOURS]
    );
    if (res.rowCount) claimed.push(row);
  }
  return claimed;
}

export function insightsFetchFor(config) {
  return createSafeFetch({ allowPrivate: allowsPrivateTargets(config), maxRedirects: 3 });
}

export async function runInsightsTick(deps) {
  const { db, config, logger } = deps;
  const now = config.now ? new Date(config.now()) : new Date();
  const domainOn = config.domainExpiryLookup === 'rdap';
  const seoOn = config.seoChecks !== 'off';
  if (!domainOn && !seoOn) return { picked: 0 };
  const fetchFn = deps.insightsFetchFn || insightsFetchFor(config);
  const sites = await claimDue(db, { now, limit: config.insightsPerTick || 5, domainOn, seoOn });
  const out = [];
  for (const site of sites) {
    const entry = { siteId: site.id };
    if (site.want_domain) {
      let domain = null;
      try {
        domain = registrableDomain(new URL(site.url).hostname);
        if (!domain) {
          entry.domain = await recordDomainResult(db, site, { domain: null, error: 'no registrable domain' }, { now });
        } else {
          const found = await lookupDomainExpiry(domain, { fetchFn, bootstrapUrl: config.rdapBootstrapUrl, now: now.getTime() });
          entry.domain = await recordDomainResult(db, site, found, { now });
        }
      } catch (err) {
        const code = err.code || 'RDAP_ERROR';
        try {
          entry.domain = await recordDomainResult(db, site, { domain, error: code }, { now });
        } catch (inner) {
          if (logger) logger.warn({ err: inner, siteId: site.id }, 'domain expiry record failed');
        }
      }
    }
    if (site.want_seo) {
      try {
        const result = await runSeoCheck(site.url, { fetchFn });
        entry.seo = await recordSeoResult(db, site, result, { now });
      } catch (err) {
        try {
          entry.seo = await recordSeoResult(db, site, { error: err.code || 'fetch_failed' }, { now });
        } catch (inner) {
          if (logger) logger.warn({ err: inner, siteId: site.id }, 'seo record failed');
        }
      }
    }
    out.push(entry);
  }
  return { picked: sites.length, results: out };
}
