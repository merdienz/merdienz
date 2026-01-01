import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import csrfProtection from '@fastify/csrf-protection';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { createMailer } from './alerts/email.js';
import { attachUser, authenticate, rateLimitKey } from './auth.js';
import { enforceCsrf, isMutating } from './csrf.js';
import { bad } from './errors.js';
import { loggerOptions, redactNotFoundUrl } from './log.js';
import { healthSchema } from './schemas.js';
import { authRoutes } from './routes/auth.js';
import { heartbeatRoutes } from './routes/heartbeats.js';
import { pingRoutes } from './routes/ping.js';
import { setupRoutes } from './routes/setup.js';
import { signupRoutes } from './routes/signup.js';
import { siteRoutes } from './routes/sites.js';
import { statusPageAdminRoutes, statusRoutes } from './routes/status.js';
import { spaNotFoundHandler, spaRoutes } from './static.js';
import { billingRoutes } from './routes/billing.js';

function isUuidParamError(err, request) {
  if (!err || err.code !== 'FST_ERR_VALIDATION') return false;
  const context = String(err.validationContext || '');
  const details = JSON.stringify(err.validation || []);
  const blob = `${err.message || ''} ${context} ${details}`;
  if (/params/i.test(blob) && /(id|uuid)/i.test(blob)) return true;
  if (context === 'params' && request?.params && ('id' in request.params || 'uuid' in request.params)) return true;
  return false;
}

function rateLimitMax(config, fallback) {
  if (config.nodeEnv === 'test' || config.disableRateLimit) return 10000;
  return fallback;
}


function containsNul(value) {
  if (typeof value === 'string') return value.includes('\u0000');
  if (Array.isArray(value)) return value.some(containsNul);
  if (value && typeof value === 'object') return Object.values(value).some(containsNul);
  return false;
}


export async function createApp({ db, config, mailer, fetchFn } = {}) {
  const httpsOpts = config.https || undefined;
  const logger = config.logStream
    ? loggerOptions(config, config.logStream)
    : config.nodeEnv === 'test'
      ? false
      : loggerOptions(config);

  const app = Fastify({
    logger,
    https: httpsOpts,
    trustProxy: config.trustedProxies,
    bodyLimit: 16 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: true } },
  });

  app.decorate('db', db);
  app.decorate('config', config);
  app.decorate('mailer', mailer === undefined ? createMailer(config) : mailer);
  app.decorate('fetchFn', fetchFn || fetch);
  app.decorate('authenticate', authenticate);
  app.decorate('enforceCsrf', (request, reply) => enforceCsrf(app, request, reply));
  app.decorate('isMutating', isMutating);

  const secureCookie = config.nodeEnv === 'production' || config.merdienzMode === 'cloud';
  const cookieOpts = {
    httpOnly: true,
    secure: secureCookie,
    sameSite: 'lax',
    path: '/',
  };

  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: [],
      },
    },
    frameguard: { action: 'deny' },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'no-referrer' },
    xssFilter: true,
    noSniff: true,
  });

  if (config.cookieSecret) {
    await app.register(cookie, { secret: config.cookieSecret, hook: 'onRequest' });
    await app.register(csrfProtection, {
      cookieKey: '_csrf',
      cookieOpts: { ...cookieOpts, signed: true },
      sessionPlugin: '@fastify/cookie',
    });
  } else {
    await app.register(cookie, { hook: 'onRequest' });
  }
  app.decorate('cookieFlags', cookieOpts);

  app.addHook('preValidation', async (request, reply) => {
    if (containsNul(request.params) || containsNul(request.query) || containsNul(request.body)) {
      return reply.code(400).send({ error: 'invalid request', code: 'BAD_REQUEST' });
    }
  });



  app.addHook('onRequest', async (request) => {
    try {
      await attachUser(request);
    } catch {
      // Leave the request unauthenticated; route hooks still return 401.
    }
  });

  await app.register(rateLimit, {
    global: true,
    max: rateLimitMax(config, 120),
    timeWindow: '1 minute',
    hook: 'onRequest',
    keyGenerator: rateLimitKey,
    skip: (req) => req.url === '/health' || req.url === '/billing/webhook' || (req.url || '').split('?')[0] === '/billing/webhook',
  });

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const raw = body == null ? '' : String(body);
    req.rawBody = raw;
    if (!raw) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(raw));
    } catch (err) {
      const path = String(req.url || req.raw?.url || '').split('?')[0];
      if (path === '/billing/webhook') {
        const generic = new Error('invalid JSON');
        generic.statusCode = 400;
        generic.code = 'INVALID_JSON';
        done(generic, undefined);
        return;
      }
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  app.setErrorHandler((err, request, reply) => {
    if (err.code === 'FST_ERR_VALIDATION') {
      if (isUuidParamError(err, request)) {
        return reply.code(404).send({ error: 'not found', code: 'NOT_FOUND' });
      }
      return reply.code(400).send({ error: 'invalid request', code: 'BAD_REQUEST' });
    }
    if (typeof err.code === 'string' && /^22\d{3}$/.test(err.code)) {
      return reply.code(400).send({ error: 'invalid request', code: 'BAD_REQUEST' });
    }
    const status = err.statusCode || 500;
    if (status >= 500 && request.log) request.log.error(err);
    const message =
      status >= 500 && config.nodeEnv === 'production' ? 'internal error' : err.message;
    reply.code(status).send({ error: message, code: err.code });
  });



  app.get('/health', { schema: healthSchema }, async () => ({ ok: true }));

  await app.register(setupRoutes);
  await app.register(authRoutes);
  await app.register(signupRoutes);
  await app.register(siteRoutes);
  await app.register(heartbeatRoutes);
  await app.register(statusPageAdminRoutes);
  await app.register(async function pingContext(fastify) {
    await fastify.register(pingRoutes);
  }, { bodyLimit: 16 * 1024 });
  await app.register(statusRoutes);
  await app.register(async function billingContext(fastify) {
    fastify.addHook('onRequest', async (request, reply) => {
      const path = String(request.url || '').split('?')[0];
      if (request.method === 'POST' && path === '/billing/webhook' && !request.headers['stripe-signature']) {
        return reply.code(400).send({ error: 'missing stripe signature', code: 'STRIPE_SIGNATURE' });
      }
    });
    await fastify.register(billingRoutes);
  }, { bodyLimit: 64 * 1024 });
  await app.register(spaRoutes);
  app.setNotFoundHandler(spaNotFoundHandler);

  return app;
}
