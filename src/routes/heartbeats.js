import { assertCloudPlan, assertCronMinInterval, assertHeartbeatQuota, rejectClientTier, resolveInterval } from '../gates.js';
import { bad } from '../errors.js';
import { computeNextWindow } from '../cron.js';
import { presentHeartbeat, validateSchedule } from '../heartbeat-checks.js';
import { heartbeatCreateSchema, heartbeatPatchSchema, idParams } from '../schemas.js';

export async function heartbeatRoutes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);

  fastify.get('/heartbeats', { schema: {} }, async (request) => {
    const { rows } = await fastify.db.query(
      `SELECT * FROM heartbeat_checks WHERE user_id = $1 ORDER BY created_at ASC`,
      [request.user.id]
    );
    return { heartbeats: rows.map((row) => presentHeartbeat(row, fastify.config)) };
  });

  fastify.get('/heartbeats/:id', { schema: { params: idParams } }, async (request, reply) => {
    const { rows } = await fastify.db.query(
      `SELECT * FROM heartbeat_checks WHERE id = $1 AND user_id = $2`,
      [request.params.id, request.user.id]
    );
    if (!rows[0]) return reply.code(404).send({ error: 'not found', code: 'NOT_FOUND' });
    const pings = await fastify.db.query(
      `SELECT id, kind, received_at, source_ip, user_agent, body_excerpt, exit_code
         FROM heartbeat_pings
        WHERE check_id = $1
        ORDER BY received_at DESC
        LIMIT 50`,
      [rows[0].id]
    );
    return presentHeartbeat(rows[0], fastify.config, { pings: pings.rows });
  });

  fastify.post('/heartbeats', { schema: heartbeatCreateSchema }, async (request) => {
    rejectClientTier(request.body || {}, request.headers);
    assertCloudPlan(fastify.config, request.gate);
    const name = request.body?.name;
    if (!name || typeof name !== 'string' || !name.trim()) {
      throw bad(400, 'name is required', 'BAD_NAME');
    }
    const schedule = validateSchedule(request.body || {});
    if (schedule.period_seconds != null) {
      resolveInterval(request.gate, schedule.period_seconds, schedule.period_seconds);
    }
    if (schedule.cron_expr) {
      assertCronMinInterval(request.gate, schedule.cron_expr, schedule.timezone);
    }
    const countRes = await fastify.db.query(
      'SELECT count(*)::int AS n FROM heartbeat_checks WHERE user_id = $1',
      [request.user.id]
    );
    assertHeartbeatQuota(request.gate, countRes.rows[0].n);
    const publicOn = request.body?.public_on_status === true;
    const { rows } = await fastify.db.query(
      `INSERT INTO heartbeat_checks (
          user_id, name, period_seconds, cron_expr, timezone, grace_seconds, public_on_status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)
        RETURNING *`,
      [
        request.user.id,
        name.trim(),
        schedule.period_seconds,
        schedule.cron_expr,
        schedule.timezone,
        schedule.grace_seconds,
        publicOn,
      ]
    );
    return presentHeartbeat(rows[0], fastify.config);
  });


  function rejectEmptyCron(request) {
    const cron = request.body?.cron_expr;
    if (typeof cron === 'string' && cron.trim() === '') {
      throw bad(400, 'cron_expr is invalid', 'BAD_CRON');
    }
  }

  fastify.patch(
    '/heartbeats/:id',
    { schema: heartbeatPatchSchema, preValidation: async (request) => rejectEmptyCron(request) },
    async (request, reply) => {
    rejectClientTier(request.body || {}, request.headers);
    rejectEmptyCron(request);
    if (request.body && Object.prototype.hasOwnProperty.call(request.body, 'public_on_status')) {
      if (typeof request.body.public_on_status !== 'boolean') {
        throw bad(400, 'public_on_status must be a boolean', 'BAD_PUBLIC');
      }
    }
    const scheduleFields = ['period_seconds', 'cron_expr', 'timezone', 'grace_seconds'];
    const changingSchedule = scheduleFields.some((key) =>
      request.body && Object.prototype.hasOwnProperty.call(request.body, key)
    );

    if (!changingSchedule) {
      const existing = await fastify.db.query(
        `SELECT * FROM heartbeat_checks WHERE id = $1 AND user_id = $2`,
        [request.params.id, request.user.id]
      );
      if (!existing.rows[0]) return reply.code(404).send({ error: 'not found', code: 'NOT_FOUND' });
      const publicOn =
        request.body?.public_on_status === undefined
          ? existing.rows[0].public_on_status
          : request.body.public_on_status;
      const { rows } = await fastify.db.query(
        `UPDATE heartbeat_checks SET public_on_status = $3 WHERE id = $1 AND user_id = $2 RETURNING *`,
        [request.params.id, request.user.id, publicOn]
      );
      return presentHeartbeat(rows[0], fastify.config);
    }

    assertCloudPlan(fastify.config, request.gate);
    const client = await fastify.db.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        `SELECT * FROM heartbeat_checks WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [request.params.id, request.user.id]
      );
      if (!existing.rows[0]) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'not found', code: 'NOT_FOUND' });
      }
      const current = existing.rows[0];
      const publicOn =
        request.body?.public_on_status === undefined
          ? current.public_on_status
          : request.body.public_on_status;
      const schedule = validateSchedule({
        period_seconds: request.body.period_seconds !== undefined ? request.body.period_seconds : current.period_seconds,
        cron_expr: request.body.cron_expr !== undefined ? request.body.cron_expr : current.cron_expr,
        timezone: request.body.timezone !== undefined ? request.body.timezone : current.timezone,
        grace_seconds: request.body.grace_seconds !== undefined ? request.body.grace_seconds : current.grace_seconds,
      });
      if (schedule.period_seconds != null) {
        resolveInterval(request.gate, schedule.period_seconds, schedule.period_seconds);
      }
      if (schedule.cron_expr) {
        assertCronMinInterval(request.gate, schedule.cron_expr, schedule.timezone);
      }
      const now = new Date();
      const lastPing = current.last_ping_at ? new Date(current.last_ping_at) : now;
      const from = lastPing > now ? lastPing : now;
      const window = computeNextWindow(
        {
          period_seconds: schedule.period_seconds,
          cron_expr: schedule.cron_expr,
          timezone: schedule.timezone,
          grace_seconds: schedule.grace_seconds,
        },
        from
      );
      let status = current.status;
      if (status === 'late' && window.expected_at && new Date(window.expected_at) > now) {
        status = 'up';
      }
      const { rows } = await client.query(
        `UPDATE heartbeat_checks
            SET public_on_status = $3,
                period_seconds = $4,
                cron_expr = $5,
                timezone = $6,
                grace_seconds = $7,
                expected_at = $8,
                grace_until = $9,
                status = $10
          WHERE id = $1 AND user_id = $2
          RETURNING *`,
        [
          request.params.id,
          request.user.id,
          publicOn,
          schedule.period_seconds,
          schedule.cron_expr,
          schedule.timezone,
          schedule.grace_seconds,
          window.expected_at,
          window.grace_until,
          status,
        ]
      );
      await client.query('COMMIT');
      return presentHeartbeat(rows[0], fastify.config);
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
  });

  fastify.post('/heartbeats/:id/pause', { schema: { params: idParams } }, async (request, reply) => {
    const { rows } = await fastify.db.query(
      `UPDATE heartbeat_checks SET status = 'paused'
        WHERE id = $1 AND user_id = $2
        RETURNING *`,
      [request.params.id, request.user.id]
    );
    if (!rows[0]) return reply.code(404).send({ error: 'not found', code: 'NOT_FOUND' });
    return presentHeartbeat(rows[0], fastify.config);
  });

  fastify.post('/heartbeats/:id/resume', { schema: { params: idParams } }, async (request, reply) => {
    const client = await fastify.db.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        `SELECT * FROM heartbeat_checks WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [request.params.id, request.user.id]
      );
      if (!existing.rows[0]) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'not found', code: 'NOT_FOUND' });
      }
      const current = existing.rows[0];
      const openIncident = (
        await client.query(
          `SELECT id FROM heartbeat_incidents WHERE check_id = $1 AND status = 'open' LIMIT 1`,
          [current.id]
        )
      ).rows[0];
      // Keep a down check (or a paused check with an open incident) down until a success ping.
      // Resume unpauses monitoring; it must not invent a recovery.
      const nextStatus =
        current.status === 'down' || openIncident ? 'down' : current.last_ping_at ? 'up' : 'new';
      const from = new Date();
      let expected = current.expected_at;
      let graceUntil = current.grace_until;
      if (current.last_ping_at) {
        const window = computeNextWindow(current, from);
        expected = window.expected_at;
        graceUntil = window.grace_until;
      }
      const { rows } = await client.query(
        `UPDATE heartbeat_checks
            SET status = $3, expected_at = $4, grace_until = $5
          WHERE id = $1 AND user_id = $2
          RETURNING *`,
        [request.params.id, request.user.id, nextStatus, expected, graceUntil]
      );
      await client.query('COMMIT');
      return presentHeartbeat(rows[0], fastify.config);
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
  });

  fastify.delete('/heartbeats/:id', { schema: { params: idParams } }, async (request, reply) => {
    const { rowCount } = await fastify.db.query(
      `DELETE FROM heartbeat_checks WHERE id = $1 AND user_id = $2`,
      [request.params.id, request.user.id]
    );
    if (!rowCount) return reply.code(404).send({ error: 'not found', code: 'NOT_FOUND' });
    return { ok: true };
  });
}
