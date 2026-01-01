import { probeHttp } from './http.js';
import { verifyProbeSignature } from './confirm.js';
import { allowsPrivateTargets } from './mode.js';
import { defaultReplayCache } from './replay.js';
import { probeSchema } from './schema.js';

export async function probeRoutes(fastify) {
  const replayCache = fastify.replayCache || defaultReplayCache;
  const probeLimit = fastify.config?.nodeEnv === 'test' || fastify.config?.disableRateLimit ? 10000 : 60;
  fastify.post(
    '/internal/probe',
    {
      schema: probeSchema,
      config: {
        rateLimit: {
          max: probeLimit,
          timeWindow: '1 minute',
          keyGenerator: (req) => `probe:${req.ip}`,
        },
      },
    },
    async (request, reply) => {
      const rawBody = request.rawBody ?? JSON.stringify(request.body ?? {});
      const ok = verifyProbeSignature(
        fastify.config.probeBHmacSecret || fastify.config.probeBSecret,
        request.headers['x-probe-timestamp'],
        request.headers['x-probe-nonce'],
        rawBody,
        request.headers['x-probe-signature'],
        {
          maxSkewSec: fastify.config.probeBMaxSkewSec,
          replayCache,
          method: 'POST',
          path: '/internal/probe',
        }
      );
      if (!ok) {
        return reply.code(401).send({ error: 'invalid probe signature', code: 'PROBE_SIG' });
      }
      const url = request.body?.url;
      if (!url) {
        return reply.code(400).send({ error: 'url is required', code: 'BAD_URL' });
      }
      try {
        const result = await probeHttp(
          {
            url,
            timeoutMs: request.body?.timeout_ms || fastify.config.defaultTimeoutMs,
            upStatusCodes: request.body?.up_status_codes || '2xx,3xx',
            allowPrivate: allowsPrivateTargets(fastify.config),
          },
          fastify.fetchFn
        );
        return result;
      } catch (err) {
        if (err.code === 'BLOCKED_HOST' || err.message === 'blocked address' || err.statusCode === 400) {
          return reply.code(400).send({ error: 'URL host is not allowed', code: 'BLOCKED_HOST' });
        }
        throw err;
      }
    }
  );
}
