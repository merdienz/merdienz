import { minCronGapSeconds } from './cron.js';
import { bad } from './errors.js';

export const PAID_CLOUD_PLANS = new Set(['starter', 'pro']);

export function isUnlimited(value) {
  return value === null || value === undefined;
}

export function requiresCloudPlan(config) {
  return String(config?.merdienzMode || '').toLowerCase() === 'cloud';
}

export function hasActiveCloudPlan(gate) {
  return Boolean(gate && PAID_CLOUD_PLANS.has(gate.tier));
}

export function assertCloudPlan(config, gate) {
  if (!requiresCloudPlan(config)) return;
  if (!hasActiveCloudPlan(gate)) {
    throw bad(403, 'plan required', 'PLAN_REQUIRED');
  }
}

export function rejectClientTier(body, headers = {}) {
  if (body && Object.prototype.hasOwnProperty.call(body, 'tier')) {
    throw bad(400, 'tier cannot be set by the client', 'TIER_OVERRIDE');
  }
  if (body && Object.prototype.hasOwnProperty.call(body, 'plan')) {
    throw bad(400, 'plan cannot be set by the client', 'TIER_OVERRIDE');
  }
  const headerTier = headers['x-tier'] ?? headers['x-plan'];
  if (headerTier !== undefined) {
    throw bad(400, 'tier cannot be set by the client', 'TIER_OVERRIDE');
  }
}

export function assertCanAddSite(gate, currentCount) {
  if (!isUnlimited(gate.site_count) && currentCount >= gate.site_count) {
    throw bad(403, `Site limit reached (${gate.site_count})`, 'SITE_LIMIT');
  }
}

export function resolveInterval(gate, requested, defaultIntervalSec = 300) {
  const interval = requested == null ? defaultIntervalSec : Number(requested);
  if (!Number.isInteger(interval) || interval < 1) {
    throw bad(400, 'interval_seconds must be a positive integer', 'BAD_INTERVAL');
  }
  if (!isUnlimited(gate.min_interval_seconds) && interval < gate.min_interval_seconds) {
    throw bad(
      403,
      `Interval must be at least ${gate.min_interval_seconds}s for this plan`,
      'MIN_INTERVAL'
    );
  }
  return interval;
}

export function assertCronMinInterval(gate, cronExpr, timeZone) {
  if (isUnlimited(gate.min_interval_seconds)) return;
  let gap;
  try {
    gap = minCronGapSeconds(cronExpr, timeZone || 'UTC');
  } catch (err) {
    if (err && (err.statusCode === 400 || err.code === 'BAD_CRON')) {
      throw bad(400, err.message || 'invalid cron schedule', 'BAD_CRON');
    }
    throw err;
  }
  if (gap < gate.min_interval_seconds) {
    throw bad(
      403,
      `Interval must be at least ${gate.min_interval_seconds}s for this plan`,
      'MIN_INTERVAL'
    );
  }
}

export function assertHeartbeatQuota(gate, currentCount) {
  if (!isUnlimited(gate.heartbeat_check_count) && currentCount >= gate.heartbeat_check_count) {
    throw bad(
      403,
      `Heartbeat check limit reached (${gate.heartbeat_check_count})`,
      'HEARTBEAT_LIMIT'
    );
  }
}

export function assertCanAddStatusPage(gate, currentCount) {
  if (!isUnlimited(gate.status_page_count) && currentCount >= gate.status_page_count) {
    throw bad(
      403,
      `Status page limit reached (${gate.status_page_count})`,
      'STATUS_PAGE_LIMIT'
    );
  }
}

export function assertCanAddSeat(gate, currentCount) {
  if (!isUnlimited(gate.seat_count) && currentCount >= gate.seat_count) {
    throw bad(403, `Seat limit reached (${gate.seat_count})`, 'SEAT_LIMIT');
  }
}
