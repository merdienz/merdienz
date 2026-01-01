import { extractCredentials, login, logout, publicUser } from '../auth.js';
import { bad } from '../errors.js';
import { loginSchema } from '../schemas.js';

const accountHits = new Map();
const ACCOUNT_WINDOW_MS = 60_000;
const ACCOUNT_MAX = 10;

function tooManyForAccount(email) {
  const key = String(email || '').trim().toLowerCase();
  const now = Date.now();
  const row = accountHits.get(key) || { count: 0, reset: now + ACCOUNT_WINDOW_MS };
  if (now > row.reset) {
    row.count = 0;
    row.reset = now + ACCOUNT_WINDOW_MS;
  }
  row.count += 1;
  accountHits.set(key, row);
  if (accountHits.size > 10_000) {
    for (const [k, v] of accountHits) {
      if (now > v.reset) accountHits.delete(k);
    }
  }
  return row.count > ACCOUNT_MAX;
}

export async function authRoutes(fastify) {
  const loginLimit = fastify.config.nodeEnv === 'test' || fastify.config.disableRateLimit ? 10000 : 10;
  fastify.post(
    '/auth/login',
    {
      schema: loginSchema,
      config: { rateLimit: { max: loginLimit, timeWindow: '1 minute', keyGenerator: (req) => `login:${req.ip}` } },
    },
    async (request, reply) => {
      const email = request.body?.email;
      const password = request.body?.password;
      if (!email || !password) {
        throw bad(400, 'email and password are required', 'BAD_LOGIN');
      }
      if (tooManyForAccount(email)) {
        return reply.code(429).send({ error: 'too many requests', code: 'RATE_LIMIT' });
      }
      const result = await login(fastify.db, { email, password });
      if (!result) {
        throw bad(401, 'invalid credentials', 'INVALID_CREDENTIALS');
      }
      return result;
    }
  );

  fastify.post('/auth/logout', {
    preHandler: async (request, reply) => {
      const creds = extractCredentials(request);
      if (!creds.cookieSession) return;
      let otherAuth = false;
      if (creds.apiKey) {
        const { loadUserByApiKey } = await import('../db.js');
        otherAuth = Boolean(await loadUserByApiKey(fastify.db, creds.apiKey));
      }
      if (!otherAuth && creds.headerSession) {
        const { loadUserBySession } = await import('../db.js');
        otherAuth = Boolean(await loadUserBySession(fastify.db, creds.headerSession));
      }
      if (!otherAuth) await request.server.enforceCsrf(request, reply);
    },
  }, async (request) => {
    const { sessionToken } = extractCredentials(request);
    await logout(fastify.db, sessionToken);
    if (request.cookies?.session) {
      request.raw.res?.clearCookie?.('session');
    }
    return { ok: true };
  });

  fastify.get('/me', { preHandler: fastify.authenticate }, async (request) => {
    return publicUser(request.user);
  });

  fastify.get('/csrf-token', async (request, reply) => {
    if (typeof reply.generateCsrf !== 'function') {
      return { csrf: null, ready: false };
    }
    const token = await reply.generateCsrf();
    return { csrf: token, ready: true };
  });
}
