import { pruneSentAlerts, retryPendingAlerts } from './alerts/outbox.js';
import { checkSite } from './check-site.js';
import { evaluateHeartbeats } from './heartbeat-checks.js';
import { pingDeadMan } from './heartbeat.js';
import { pruneRetention } from './prune.js';
import { accountBillingHeldExistsSql, applyBillingHolds } from './billing/holds.js';
import { runInsightsTick } from './insights/run.js';

const DUE_LIMIT = 50;

export async function loadDueSites(db, limit = DUE_LIMIT, now = new Date()) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `WITH ranked AS (
         SELECT s.*,
                u.email AS user_email,
                u.tier AS user_tier,
                g.min_interval_seconds,
                g.site_count,
                g.ssl_check AS gate_ssl_check,
                ROW_NUMBER() OVER (PARTITION BY s.user_id ORDER BY s.created_at ASC) AS site_rn
           FROM sites s
           JOIN users u ON u.id = s.user_id
           JOIN plan_gates g ON g.tier = u.tier
          WHERE s.enabled = true
            AND s.billing_hold = false
            AND NOT (${accountBillingHeldExistsSql('s.user_id', '$2')})
       ),
       due AS (
         SELECT *
           FROM ranked
          WHERE (site_count IS NULL OR site_rn <= site_count)
            AND (
              last_checked_at IS NULL
              OR last_checked_at + (GREATEST(interval_seconds, COALESCE(min_interval_seconds, 0)) * INTERVAL '1 second') <= now()
            )
          ORDER BY last_checked_at NULLS FIRST
          LIMIT $1
       )
       UPDATE sites AS s
          SET last_checked_at = now()
         FROM due
        WHERE s.id = due.id
          AND s.id IN (SELECT id FROM due FOR UPDATE SKIP LOCKED)
        RETURNING due.*, s.last_checked_at AS claimed_at`,
      [limit, now]
    );
    await client.query('COMMIT');
    return rows;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function runSchedulerTick(deps) {
  const { db, config, fetchFn = fetch, logger } = deps;
  const now = config.now ? new Date(config.now()) : new Date();
  try {
    await applyBillingHolds(db, now);
  } catch (err) {
    if (logger) logger.error({ err }, 'billing hold apply failed');
  }
  const heartbeat = await pingDeadMan(config.heartbeatUrl, fetchFn);
  if (heartbeat.skipped !== true && heartbeat.ok === false && logger) {
    logger.warn({ heartbeat }, 'dead-man heartbeat failed');
  }
  let heartbeats = [];
  try {
    heartbeats = await evaluateHeartbeats(deps);
  } catch (err) {
    if (logger) logger.error({ err }, 'heartbeat evaluation failed');
  }
  let pruned = null;
  try {
    pruned = await pruneRetention(db);
  } catch (err) {
    if (logger) logger.error({ err }, 'retention prune failed');
  }
  const due = await loadDueSites(db, DUE_LIMIT, now);
  const results = [];
  for (const site of due) {
    try {
      results.push(await checkSite(site, deps));
    } catch (err) {
      if (logger) logger.error({ err, siteId: site.id }, 'check failed');
      results.push({ status: 'error', error: err.message, siteId: site.id });
    }
  }
  return { heartbeat, checked: results.length, results, heartbeats, pruned };
}

export async function runAlertDeliveryTick(deps) {
  const { db, config, logger, mailer } = deps;
  let retried = null;
  let pruned = null;
  try {
    retried = await retryPendingAlerts(db, mailer, { mailTransport: config.mailTransport });
  } catch (err) {
    if (logger) logger.error({ err }, 'alert retry failed');
  }
  try {
    pruned = await pruneSentAlerts(db);
  } catch (err) {
    if (logger) logger.error({ err }, 'alert prune failed');
  }
  return { retried, pruned };
}

function startLoop(intervalMs, run, onError) {
  let running = false;
  const handle = setInterval(() => {
    if (running) return;
    running = true;
    Promise.resolve()
      .then(run)
      .catch(onError)
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  if (typeof handle.unref === 'function') handle.unref();
  return handle;
}

export function startScheduler(deps) {
  const interval = deps.config.schedulerIntervalMs || 5000;
  const alertInterval = deps.config.alertDeliveryIntervalMs || interval;
  const checkHandle = startLoop(interval, () => runSchedulerTick(deps), (err) => {
    if (deps.logger) deps.logger.error({ err }, 'scheduler tick failed');
  });
  const alertHandle = startLoop(alertInterval, () => runAlertDeliveryTick(deps), (err) => {
    if (deps.logger) deps.logger.error({ err }, 'alert delivery tick failed');
  });
  // SSL/domain/SEO insights fetch user-controlled pages and RDAP servers. They run in their own
  // loop so a slow target can never delay uptime checks or down alerts.
  const insightsHandle = startLoop(interval, () => runInsightsTick(deps), (err) => {
    if (deps.logger) deps.logger.error({ err }, 'insights tick failed');
  });
  return {
    tick: () => runSchedulerTick(deps),
    deliverAlerts: () => runAlertDeliveryTick(deps),
    insights: () => runInsightsTick(deps),
    stop() {
      clearInterval(checkHandle);
      clearInterval(alertHandle);
      clearInterval(insightsHandle);
    },
  };
}
