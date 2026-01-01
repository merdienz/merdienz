import { deliverNow, insertOutbox } from './alerts/outbox.js';
import { allowsPrivateTargets } from './guard.js';
import { callProbeB } from './probes/confirm.js';
import { probeHttp } from './probes/http.js';
import { recordSslExpiry } from './insights/ssl.js';

function probeFields(prefix, result) {
  if (!result) {
    return {
      [`${prefix}_ok`]: null,
      [`${prefix}_http_status`]: null,
      [`${prefix}_latency_ms`]: null,
      [`${prefix}_error`]: null,
    };
  }
  return {
    [`${prefix}_ok`]: result.up,
    [`${prefix}_http_status`]: result.httpStatus ?? null,
    [`${prefix}_latency_ms`]: result.latencyMs ?? null,
    [`${prefix}_error`]: result.error ?? null,
  };
}

async function insertResult(db, siteId, status, a, b) {
  const aFields = probeFields('probe_a', a);
  const bFields = probeFields('probe_b', b);
  const via = b?.via || null;
  const { rows } = await db.query(
    `INSERT INTO check_results (
        site_id, status,
        probe_a_ok, probe_a_http_status, probe_a_latency_ms, probe_a_error,
        probe_b_ok, probe_b_http_status, probe_b_latency_ms, probe_b_error,
        probe_b_via
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *`,
    [
      siteId,
      status,
      aFields.probe_a_ok,
      aFields.probe_a_http_status,
      aFields.probe_a_latency_ms,
      aFields.probe_a_error,
      bFields.probe_b_ok,
      bFields.probe_b_http_status,
      bFields.probe_b_latency_ms,
      bFields.probe_b_error,
      via,
    ]
  );
  return rows[0];
}

async function openIncident(db, siteId) {
  const { rows } = await db.query(
    `INSERT INTO incidents (site_id, status, alerted)
     VALUES ($1, 'open', true)
     ON CONFLICT (site_id) WHERE status = 'open' DO NOTHING
     RETURNING *`,
    [siteId]
  );
  return rows[0] || null;
}

async function resolveOpenIncident(db, siteId) {
  const { rows } = await db.query(
    `UPDATE incidents
        SET status = 'resolved', ended_at = now()
      WHERE site_id = $1 AND status = 'open'
      RETURNING *`,
    [siteId]
  );
  return rows[0] || null;
}

async function commitCheck(db, { siteId, status, a, b, onIncident, alert }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await insertResult(client, siteId, status, a, b);
    await client.query(`UPDATE sites SET current_status = $2 WHERE id = $1`, [siteId, status]);
    let incidentRow = null;
    if (onIncident === 'resolve') incidentRow = await resolveOpenIncident(client, siteId);
    if (onIncident === 'open') incidentRow = await openIncident(client, siteId);
    let outbox = null;
    if (alert && incidentRow) {
      outbox = await insertOutbox(client, alert);
    }
    await client.query('COMMIT');
    return { result, outbox };
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

// The SSL insight write never holds up the check result or a down alert: it runs in the
// background with its own error handling, at most one in flight per site.
const sslWritesInFlight = new Set();
function startSslWrite(site, tls, deps) {
  if (sslWritesInFlight.has(site.id)) return null;
  sslWritesInFlight.add(site.id);
  const record = deps.recordSsl || recordSslExpiry;
  const now = deps.config && deps.config.now ? new Date(deps.config.now()) : new Date();
  return Promise.resolve()
    .then(() => record(deps.db, site, tls, { now }))
    .catch((err) => {
      if (deps.logger) deps.logger.warn({ err, siteId: site.id }, 'ssl expiry record failed');
      return null;
    })
    .finally(() => {
      sslWritesInFlight.delete(site.id);
    });
}

export async function checkSite(site, deps) {
  const {
    db,
    mailer,
    config,
    probeA = probeHttp,
    callB = callProbeB,
    fetchFn = fetch,
  } = deps;

  await db.query('UPDATE sites SET last_checked_at = now() WHERE id = $1', [site.id]);

  const allowPrivate = allowsPrivateTargets(config);
  const target = {
    url: site.url,
    timeoutMs: site.timeout_ms,
    upStatusCodes: site.up_status_codes,
    timeout_ms: site.timeout_ms,
    up_status_codes: site.up_status_codes,
    allowPrivate,
  };

  const a = await probeA(target, fetchFn);
  const sslWrite = a && a.tls && site.gate_ssl_check ? startSslWrite(site, a.tls, deps) : null;
  let status;
  let b = null;
  let alerted = null;

  if (a.up) {
    status = 'up';
    const committed = await commitCheck(db, {
      siteId: site.id,
      status,
      a,
      b: null,
      onIncident: 'resolve',
      alert: site.user_email
        ? {
            kind: 'recovery',
            to: site.user_email,
            subject: `RECOVERY: ${site.name} is up`,
            text: `${site.name} (${site.url}) is up again.\nProbe A status: ${a.httpStatus} in ${a.latencyMs}ms.`,
          }
        : null,
    });
    alerted = committed.outbox && mailer ? await deliverNow(db, mailer, committed.outbox) : null;
    return { status, result: committed.result, alerted, a, b: null, sslWrite };
  }

  b = await callB(target, { ...config, allowPrivateTargets: allowPrivate }, fetchFn);
  if (b.unavailable || b.up) {
    status = 'unconfirmed';
    const committed = await commitCheck(db, { siteId: site.id, status, a, b });
    return { status, result: committed.result, alerted: null, a, b, sslWrite };
  }

  status = 'down';
  const committed = await commitCheck(db, {
    siteId: site.id,
    status,
    a,
    b,
    onIncident: 'open',
    alert: site.user_email
      ? {
          kind: 'down',
          to: site.user_email,
          subject: `DOWN: ${site.name} is down`,
          text: `${site.name} (${site.url}) failed from both probes.\nA: ${a.error}\nB: ${b.error}`,
        }
      : null,
  });
  alerted = committed.outbox && mailer ? await deliverNow(db, mailer, committed.outbox) : null;
  return { status, result: committed.result, alerted, a, b, sslWrite };
}
