import { deliverNow, insertOutbox } from './alerts/outbox.js';
import { assertValidTimeZone, computeNextWindow, nextCronOccurrence, parseCronExpr } from './cron.js';
import { accountBillingHeldExistsSql } from './billing/holds.js';
import { bad } from './errors.js';

const BODY_EXCERPT_LIMIT = 256;
const VALID_PERIOD_OR_CRON = 'provide exactly one of period_seconds or cron_expr';

export function validateSchedule({ period_seconds, cron_expr, timezone, grace_seconds }) {
  if (typeof cron_expr === 'string' && cron_expr.trim() === '') {
    throw bad(400, 'cron_expr is invalid', 'BAD_CRON');
  }
  const hasPeriod = period_seconds != null && period_seconds !== '';
  const hasCron = cron_expr != null && String(cron_expr).trim() !== '';
  if (hasPeriod === hasCron) {
    throw bad(400, VALID_PERIOD_OR_CRON, 'BAD_SCHEDULE');
  }
  let period = null;
  let cron = null;
  if (hasPeriod) {
    period = Number(period_seconds);
    if (!Number.isInteger(period) || period < 1) {
      throw bad(400, 'period_seconds must be a positive integer', 'BAD_PERIOD');
    }
  } else {
    cron = String(cron_expr).trim();
  }
  const tz = timezone || 'UTC';
  try {
    assertValidTimeZone(tz);
  } catch (err) {
    throw bad(400, err.message, 'BAD_TIMEZONE');
  }
  if (cron) {
    try {
      nextCronOccurrence(cron, tz, new Date());
    } catch (err) {
      throw bad(400, err.message, 'BAD_CRON');
    }
  }
  const grace = grace_seconds == null ? 300 : Number(grace_seconds);
  if (!Number.isInteger(grace) || grace < 0) {
    throw bad(400, 'grace_seconds must be an integer >= 0', 'BAD_GRACE');
  }
  return { period_seconds: period, cron_expr: cron, timezone: tz, grace_seconds: grace };
}

export function publicBaseUrl(config) {
  return (config.publicUrl || `http://127.0.0.1:${config.port}`).replace(/\/$/, '');
}

export function pingUrls(config, token) {
  const base = `${publicBaseUrl(config)}/ping/${token}`;
  return {
    success: base,
    start: `${base}/start`,
    fail: `${base}/fail`,
  };
}

export function snippetsFor(config, token) {
  const urls = pingUrls(config, token);
  const curl = `curl -fsS -m 10 --retry 5 -o /dev/null ${urls.success}`;
  return {
    curl,
    cron: `* * * * * ${curl}`,
    systemd: [
      '[Unit]',
      'Description=Merdienz heartbeat ping',
      'After=network.target',
      '',
      '[Service]',
      'Type=oneshot',
      `ExecStart=/usr/bin/curl -fsS -m 10 --retry 5 -o /dev/null ${urls.success}`,
      '',
      '[Install]',
      'WantedBy=multi-user.target',
    ].join('\n'),
    github_actions: [
      '- name: Ping Merdienz',
      `  run: curl -fsS -m 10 --retry 5 -o /dev/null ${urls.success}`,
    ].join('\n'),
  };
}

export function presentHeartbeat(row, config, extras = {}) {
  const token = row.ping_token;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    period_seconds: row.period_seconds,
    cron_expr: row.cron_expr,
    timezone: row.timezone,
    grace_seconds: row.grace_seconds,
    last_ping_at: row.last_ping_at,
    last_start_at: row.last_start_at,
    last_exit_code: row.last_exit_code,
    expected_at: row.expected_at,
    grace_until: row.grace_until,
    public_on_status: row.public_on_status,
    created_at: row.created_at,
    ping_urls: pingUrls(config, token),
    snippets: snippetsFor(config, token),
    ...extras,
  };
}

export function excerptBody(body) {
  if (body == null) return null;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  if (!text) return null;
  return text.length <= BODY_EXCERPT_LIMIT ? text : text.slice(0, BODY_EXCERPT_LIMIT);
}

export function clientIp(request, trustedProxies) {
  const remote = request.socket?.remoteAddress || request.raw?.socket?.remoteAddress || request.ip || null;
  const normalized = remote ? String(remote).replace(/^::ffff:/, '') : null;
  const proxies = trustedProxies ?? request.server?.config?.trustedProxies ?? [];
  if (normalized && proxies.includes(normalized)) {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      return forwarded.split(',')[0].trim();
    }
  }
  return normalized;
}

function safeNextWindow(check, now, logger) {
  try {
    return computeNextWindow(check, now);
  } catch (err) {
    if (logger && typeof logger.error === 'function') {
      logger.error({ err }, 'failed to compute next heartbeat window');
    } else {
      console.error('failed to compute next heartbeat window:', err.message);
    }
    return {
      expected_at: check.expected_at,
      grace_until: check.grace_until,
      error: err.message,
    };
  }
}


async function openHeartbeatIncident(db, checkId, reason) {
  const existing = await db.query(
    `SELECT * FROM heartbeat_incidents WHERE check_id = $1 AND status = 'open' LIMIT 1`,
    [checkId]
  );
  if (existing.rows[0]) return existing.rows[0];
  const { rows } = await db.query(
    `INSERT INTO heartbeat_incidents (check_id, status, reason) VALUES ($1, 'open', $2) RETURNING *`,
    [checkId, reason]
  );
  return rows[0];
}

async function resolveHeartbeatIncident(db, checkId) {
  const { rows } = await db.query(
    `UPDATE heartbeat_incidents
        SET status = 'resolved', ended_at = now()
      WHERE check_id = $1 AND status = 'open'
      RETURNING *`,
    [checkId]
  );
  return rows[0] || null;
}

async function recordPing(db, check, { kind, request, exitCode, body }) {
  const { rows } = await db.query(
    `INSERT INTO heartbeat_pings (
        check_id, kind, source_ip, user_agent, body_excerpt, exit_code
      ) VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *`,
    [
      check.id,
      kind,
      request ? clientIp(request) : null,
      request ? request.headers['user-agent'] || null : null,
      excerptBody(body),
      exitCode ?? null,
    ]
  );
  return rows[0];
}

async function applyWindow(db, check, from) {
  const window = safeNextWindow(check, from);
  const { rows } = await db.query(
    `UPDATE heartbeat_checks
        SET last_ping_at = $2,
            last_exit_code = $3,
            expected_at = $4,
            grace_until = $5,
            status = $6
      WHERE id = $1
      RETURNING *`,
    [
      check.id,
      from,
      check.last_exit_code,
      window.expected_at,
      window.grace_until,
      'up',
    ]
  );
  return rows[0];
}

async function withLockedHeartbeat(db, checkId, fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT h.*, u.email AS user_email
         FROM heartbeat_checks h
         JOIN users u ON u.id = h.user_id
        WHERE h.id = $1
        FOR UPDATE OF h`,
      [checkId]
    );
    if (!rows[0]) {
      throw bad(404, 'not found', 'NOT_FOUND');
    }
    const result = await fn(client, rows[0]);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The rollback error would hide the original failure.
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function receivePing(db, check, { kind, request, exitCode, body, mailer, now = new Date() }) {
  const outcome = await withLockedHeartbeat(db, check.id, async (client, current) => {
    const previous = current.status;
    const ping = await recordPing(client, current, { kind, request, exitCode, body });
    if (previous === 'paused') {
      return { check: current, ping, outbox: null };
    }

    if (kind === 'start') {
      const window = safeNextWindow(current, now);
      const nextStatus = previous === 'down' || previous === 'paused' ? previous : 'up';
      const status = previous === 'new' ? 'up' : nextStatus;
      const { rows } = await client.query(
        `UPDATE heartbeat_checks
            SET last_start_at = $2,
                last_ping_at = $2,
                last_exit_code = $3,
                expected_at = $4,
                grace_until = $5,
                status = $6
          WHERE id = $1
          RETURNING *`,
        [current.id, now, exitCode ?? current.last_exit_code, window.expected_at, window.grace_until, status]
      );
      return { check: rows[0], ping, outbox: null };
    }

    if (kind === 'fail') {
      const window = safeNextWindow(current, now);
      const { rows } = await client.query(
        `UPDATE heartbeat_checks
            SET last_ping_at = $2,
                last_exit_code = $3,
                expected_at = $4,
                grace_until = $5,
                status = 'down'
          WHERE id = $1
          RETURNING *`,
        [current.id, now, exitCode ?? 1, window.expected_at, window.grace_until]
      );
      await openHeartbeatIncident(client, current.id, 'fail');
      const alert =
        previous !== 'down' && previous !== 'paused' && current.user_email
          ? {
              kind: 'down',
              to: current.user_email,
              subject: `DOWN: heartbeat ${current.name} failed`,
              text: `${current.name} reported a failure (exit ${exitCode ?? 1}).`,
            }
          : null;
      const outbox = alert ? await insertOutbox(client, alert) : null;
      return { check: rows[0], ping, outbox };
    }

    const updated = { ...current, last_exit_code: exitCode ?? 0 };
    const row = await applyWindow(client, updated, now);
    if (previous === 'down') {
      await resolveHeartbeatIncident(client, current.id);
    }
    const alert =
      previous === 'down' && current.user_email
        ? {
            kind: 'recovery',
            to: current.user_email,
            subject: `RECOVERY: heartbeat ${current.name} is up`,
            text: `${current.name} received a successful ping and is up again.`,
          }
        : null;
    const outbox = alert ? await insertOutbox(client, alert) : null;
    return { check: row, ping, outbox };
  });

  const alerted = outcome.outbox && mailer ? await deliverNow(db, mailer, outcome.outbox) : null;
  return { check: outcome.check, alerted, ping: outcome.ping };
}

export async function evaluateHeartbeats({ db, mailer, now = new Date() }) {
  const { rows } = await db.query(
    `WITH ranked AS (
       SELECT h.*, u.email AS user_email, g.heartbeat_check_count,
              ROW_NUMBER() OVER (PARTITION BY h.user_id ORDER BY h.created_at ASC) AS hb_rn
         FROM heartbeat_checks h
         JOIN users u ON u.id = h.user_id
         JOIN plan_gates g ON g.tier = u.tier
        WHERE h.status NOT IN ('paused', 'new')
          AND h.billing_hold = false
          AND NOT (${accountBillingHeldExistsSql('h.user_id', '$1')})
          AND (
            (h.grace_until IS NOT NULL AND h.grace_until < $1)
            OR (h.expected_at IS NOT NULL AND h.expected_at < $1)
          )
     )
     SELECT * FROM ranked
      WHERE heartbeat_check_count IS NULL OR hb_rn <= heartbeat_check_count`,
    [now]
  );
  const changes = [];
  for (const check of rows) {
    if (check.status === 'down') continue;
    if (check.grace_until && now > new Date(check.grace_until)) {
      const client = await db.connect();
      let outbox = null;
      try {
        await client.query('BEGIN');
        const updated = await client.query(
          `UPDATE heartbeat_checks
              SET status = 'down'
            WHERE id = $1 AND status IN ('up', 'late') AND grace_until < $2
            RETURNING *`,
          [check.id, now]
        );
        if (!updated.rows[0]) {
          await client.query('ROLLBACK');
          continue;
        }
        await openHeartbeatIncident(client, check.id, 'missed');
        if (check.user_email) {
          outbox = await insertOutbox(client, {
            kind: 'down',
            to: check.user_email,
            subject: `DOWN: heartbeat ${check.name} missed`,
            text: `${check.name} did not ping before the grace period ended (expected ${check.expected_at}).`,
          });
        }
        await client.query('COMMIT');
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // The rollback error would hide the original failure.
        }
        throw err;
      } finally {
        client.release();
      }
      const alerted = outbox && mailer ? await deliverNow(db, mailer, outbox) : null;
      changes.push({ id: check.id, status: 'down', alerted });
    } else if (check.expected_at && now > new Date(check.expected_at) && check.status === 'up') {
      const updated = await db.query(
        `UPDATE heartbeat_checks
            SET status = 'late'
          WHERE id = $1 AND status = 'up' AND expected_at < $2
            AND (grace_until IS NULL OR grace_until >= $2)
          RETURNING *`,
        [check.id, now]
      );
      if (updated.rows[0]) changes.push({ id: check.id, status: 'late', alerted: null });
    }
  }
  return changes;
}
