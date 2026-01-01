import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { probeRoutes } from './routes.js';
import { healthSchema } from './schema.js';
import { createReplayCache } from './replay.js';

export async function createProbeApp({ config, fetchFn, replayCache, https } = {}) {
  const app = Fastify({
    logger: config.nodeEnv === 'test' ? false : true,
    https,
    bodyLimit: 16 * 1024,
  });
  app.decorate('config', config);
  app.decorate('fetchFn', fetchFn || fetch);
  app.decorate('replayCache', replayCache || createReplayCache({ maxSkewSec: config.probeBMaxSkewSec }));

  const probeLimit = config.nodeEnv === 'test' || config.disableRateLimit ? 10000 : 60;
  await app.register(rateLimit, {
    global: true,
    max: probeLimit,
    timeWindow: '1 minute',
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
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  app.get('/health', { schema: healthSchema }, async () => ({ ok: true, role: 'probe-b' }));
  await app.register(probeRoutes);
  return app;
}
