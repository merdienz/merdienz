const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

import { receivePing } from '../heartbeat-checks.js';
import { bad } from '../errors.js';
import { UUID, pingQuerySchema } from '../schemas.js';

function isUuid(value) {
  return UUID_RE.test(String(value || ''));
}

async function loadCheck(db, token) {
  if (!isUuid(token)) return null;
  const { rows } = await db.query(
    `SELECT h.*, u.email AS user_email
       FROM heartbeat_checks h
       JOIN users u ON u.id = h.user_id
      WHERE h.ping_token = $1`,
    [token]
  );
  return rows[0] || null;
}

function parseExit(raw, { allowString = true } = {}) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || Object.is(raw, -0) || raw < 0 || raw > 255) {
      throw bad(400, 'exit code must be an integer between 0 and 255', 'BAD_EXIT');
    }
    return raw;
  }
  if (!allowString || typeof raw !== 'string' || !/^(0|[1-9]\d{0,2})$/.test(raw)) {
    throw bad(400, 'exit code must be an integer between 0 and 255', 'BAD_EXIT');
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 255) {
    throw bad(400, 'exit code must be an integer between 0 and 255', 'BAD_EXIT');
  }
  return n;
}

function rawQueryExit(request) {
  const rawUrl = String(request.raw?.url || request.url || '');
  const qIndex = rawUrl.indexOf('?');
  if (qIndex === -1) return undefined;
  const params = new URLSearchParams(rawUrl.slice(qIndex + 1));
  if (!params.has('exit')) return undefined;
  return params.get('exit');
}

function rawBodyExit(request) {
  if (request.rawBody) {
    try {
      const parsed = JSON.parse(request.rawBody);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'exit_code' in parsed) {
        return parsed.exit_code;
      }
    } catch {
      // Non-JSON ping bodies do not carry exit_code.
    }
  }
  if (request.body && typeof request.body === 'object' && !Array.isArray(request.body) && request.body.exit_code !== undefined) {
    return request.body.exit_code;
  }
  return undefined;
}

function exitFrom(request) {
  if (request.params.code !== undefined) {
    return parseExit(request.params.code, { allowString: true });
  }
  const queryExit = rawQueryExit(request);
  if (queryExit !== undefined) {
    return parseExit(queryExit, { allowString: true });
  }
  const bodyExit = rawBodyExit(request);
  if (bodyExit !== undefined) {
    return parseExit(bodyExit, { allowString: false });
  }
  return null;
}

function kindFromExit(exitCode, fallback) {
  if (exitCode === null || exitCode === undefined) return fallback;
  return exitCode === 0 ? 'success' : 'fail';
}

export async function pingRoutes(fastify) {
  async function handle(request, reply, kind) {
    const check = await loadCheck(fastify.db, request.params.uuid);
    if (!check) return reply.code(404).send({ error: 'not found', code: 'NOT_FOUND' });
    const exitCode = exitFrom(request);
    const resolvedKind = kind === 'auto' ? kindFromExit(exitCode, 'success') : kind;
    const rawBody = request.rawBody || (typeof request.body === 'string' ? request.body : null);
    const { check: updated } = await receivePing(fastify.db, check, {
      kind: resolvedKind,
      request,
      exitCode,
      body: rawBody || request.body,
      mailer: fastify.mailer,
    });
    return { ok: true, status: updated.status, id: updated.id };
  }

  const pingLimit = fastify.config.nodeEnv === 'test' || fastify.config.disableRateLimit ? 10000 : 60;
  const opts = {
    exposeHeadRoute: false,
    config: {
      rateLimit: {
        max: pingLimit,
        timeWindow: '1 minute',
        keyGenerator: (req) => `ping:${req.ip}:${req.params?.uuid || ''}`,
      },
    },
    schema: {
      params: {
        type: 'object',
        required: ['uuid'],
        additionalProperties: true,
        properties: {
          uuid: { type: 'string', pattern: UUID },
          code: { type: 'string' },
        },
      },
      querystring: pingQuerySchema,
    },
  };

  function both(url, handler) {
    fastify.route({ ...opts, method: ['GET', 'POST'], url, handler });
  }

  both('/ping/:uuid/start', (request, reply) => handle(request, reply, 'start'));
  both('/ping/:uuid/fail', (request, reply) => handle(request, reply, 'fail'));
  both('/ping/:uuid/:code', async (request, reply) => {
    const raw = String(request.params.code ?? '');
    if (!/^(0|[1-9]\d{0,2})$/.test(raw) || Number(raw) > 255) {
      return reply.code(404).send({ error: 'not found', code: 'NOT_FOUND' });
    }
    return handle(request, reply, 'auto');
  });
  both('/ping/:uuid', (request, reply) => handle(request, reply, 'auto'));
}
