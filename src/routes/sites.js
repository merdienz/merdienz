import { bad } from '../errors.js';
import { assertCanAddSite, assertCloudPlan, rejectClientTier, resolveInterval } from '../gates.js';
import { allowsPrivateTargets } from '../guard.js';
import { assertSafeHttpUrl } from '../ssrf.js';
import { idParams, siteCreateSchema, sitePatchSchema } from '../schemas.js';

function presentSite(row) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    interval_seconds: row.interval_seconds,
    timeout_ms: row.timeout_ms,
    up_status_codes: row.up_status_codes,
    enabled: row.enabled,
    current_status: row.current_status,
    last_checked_at: row.last_checked_at,
    public_on_status: row.public_on_status,
    created_at: row.created_at,
  };
}

export async function siteRoutes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);

  fastify.get('/sites', { schema: {} }, async (request) => {
    const { rows } = await fastify.db.query(
      `SELECT * FROM sites WHERE user_id = $1 ORDER BY created_at ASC`,
      [request.user.id]
    );
    return { sites: rows.map(presentSite) };
  });

  fastify.get('/sites/:id', { schema: { params: idParams } }, async (request, reply) => {
    const { rows } = await fastify.db.query(
      `SELECT * FROM sites WHERE id = $1 AND user_id = $2`,
      [request.params.id, request.user.id]
    );
    if (!rows[0]) return reply.code(404).send({ error: 'not found', code: 'NOT_FOUND' });
    return presentSite(rows[0]);
  });

  // SSL, domain, and SEO details for one owned site. Sections the plan does not include are
  // reported as disabled with no data.
  fastify.get('/sites/:id/insights', { schema: { params: idParams } }, async (request, reply) => {
    const { rows } = await fastify.db.query(
      `SELECT s.id, i.*
         FROM sites s
         LEFT JOIN site_insights i ON i.site_id = s.id
        WHERE s.id = $1 AND s.user_id = $2`,
      [request.params.id, request.user.id]
    );
    if (!rows[0]) return reply.code(404).send({ error: 'not found', code: 'NOT_FOUND' });
    const r = rows[0];
    const gate = request.gate || {};
    const days = (at) => (at ? Math.floor((new Date(at).getTime() - Date.now()) / 86400000) : null);
    return {
      site_id: r.id,
      ssl: gate.ssl_check
        ? { enabled: true, expires_at: r.ssl_expires_at, days_left: days(r.ssl_expires_at), issuer: r.ssl_issuer, subject: r.ssl_subject, checked_at: r.ssl_checked_at }
        : { enabled: false },
      domain: gate.domain_expiry && fastify.config.domainExpiryLookup === 'rdap'
        ? { enabled: true, name: r.domain_name, expires_at: r.domain_expires_at, days_left: days(r.domain_expires_at), checked_at: r.domain_checked_at, error: r.domain_error }
        : { enabled: false },
      seo: gate.seo_check && fastify.config.seoChecks !== 'off'
        ? { enabled: true, checked_at: r.seo_checked_at, issues: r.seo_issues || [], result: r.seo_result }
        : { enabled: false },
    };
  });

  fastify.post('/sites', { schema: siteCreateSchema }, async (request) => {
    rejectClientTier(request.body || {}, request.headers);
    assertCloudPlan(fastify.config, request.gate);
    const name = request.body?.name;
    const url = request.body?.url;
    if (!name || typeof name !== 'string' || !name.trim()) {
      throw bad(400, 'name is required', 'BAD_NAME');
    }
    if (!url) throw bad(400, 'url is required', 'BAD_URL');
    const safe = await assertSafeHttpUrl(url, {
      allowPrivate: allowsPrivateTargets(fastify.config),
    });
    const cleanUrl = safe.url;
    const interval = resolveInterval(
      request.gate,
      request.body?.interval_seconds,
      fastify.config.defaultIntervalSec
    );
    let timeoutMs = request.body?.timeout_ms ?? fastify.config.defaultTimeoutMs;
    timeoutMs = Number(timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) {
      throw bad(400, 'timeout_ms must be an integer between 100 and 60000', 'BAD_TIMEOUT');
    }
    const upStatusCodes = request.body?.up_status_codes || '2xx,3xx';
    if (typeof upStatusCodes !== 'string' || !upStatusCodes.trim()) {
      throw bad(400, 'up_status_codes must be a string', 'BAD_STATUS_CODES');
    }

    const countRes = await fastify.db.query('SELECT count(*)::int AS n FROM sites WHERE user_id = $1', [
      request.user.id,
    ]);
    assertCanAddSite(request.gate, countRes.rows[0].n);

    const publicOn = request.body?.public_on_status === true;
    const { rows } = await fastify.db.query(
      `INSERT INTO sites (
          user_id, name, url, interval_seconds, timeout_ms, up_status_codes, public_on_status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)
        RETURNING *`,
      [request.user.id, name.trim(), cleanUrl, interval, timeoutMs, upStatusCodes.trim(), publicOn]
    );
    return presentSite(rows[0]);
  });

  fastify.patch('/sites/:id', { schema: sitePatchSchema }, async (request, reply) => {
    rejectClientTier(request.body || {}, request.headers);
    const existing = await fastify.db.query(
      `SELECT * FROM sites WHERE id = $1 AND user_id = $2`,
      [request.params.id, request.user.id]
    );
    if (!existing.rows[0]) return reply.code(404).send({ error: 'not found', code: 'NOT_FOUND' });
    if (request.body && Object.prototype.hasOwnProperty.call(request.body, 'public_on_status')) {
      if (typeof request.body.public_on_status !== 'boolean') {
        throw bad(400, 'public_on_status must be a boolean', 'BAD_PUBLIC');
      }
    }
    const publicOn =
      request.body?.public_on_status === undefined
        ? existing.rows[0].public_on_status
        : request.body.public_on_status;
    let interval = existing.rows[0].interval_seconds;
    if (request.body && Object.prototype.hasOwnProperty.call(request.body, 'interval_seconds')) {
      assertCloudPlan(fastify.config, request.gate);
      interval = resolveInterval(request.gate, request.body.interval_seconds, interval);
    }
    const { rows } = await fastify.db.query(
      `UPDATE sites SET public_on_status = $3, interval_seconds = $4 WHERE id = $1 AND user_id = $2 RETURNING *`,
      [request.params.id, request.user.id, publicOn, interval]
    );
    return presentSite(rows[0]);
  });

  fastify.delete('/sites/:id', { schema: { params: idParams } }, async (request, reply) => {
    const { rowCount } = await fastify.db.query(
      `DELETE FROM sites WHERE id = $1 AND user_id = $2`,
      [request.params.id, request.user.id]
    );
    if (!rowCount) return reply.code(404).send({ error: 'not found', code: 'NOT_FOUND' });
    return { ok: true };
  });

  fastify.get('/sites/:id/incidents', { schema: { params: idParams } }, async (request, reply) => {
    const owned = await fastify.db.query(
      `SELECT 1 FROM sites WHERE id = $1 AND user_id = $2`,
      [request.params.id, request.user.id]
    );
    if (!owned.rowCount) return reply.code(404).send({ error: 'not found', code: 'NOT_FOUND' });
    const { rows } = await fastify.db.query(
      `SELECT i.id, i.site_id, i.status, i.alerted, i.started_at, i.ended_at
         FROM incidents i
         JOIN sites s ON s.id = i.site_id
        WHERE i.site_id = $1 AND s.user_id = $2
        ORDER BY i.started_at DESC
        LIMIT 50`,
      [request.params.id, request.user.id]
    );
    return { incidents: rows };
  });

}
