import { signupSchema } from '../schemas.js';
import { setupComplete } from '../setup.js';
import {
  SIGNUP_EMAIL_MAX,
  SIGNUP_GENERIC,
  SIGNUP_PAIR_MAX,
  SIGNUP_PASSWORD_MIN,
  createEmailLimiter,
  createSignupUser,
  signupEnabled,
  signupReady,
  validateSignup,
} from '../signup.js';

export async function signupRoutes(fastify) {
  // Self-hosted (and dev/test) installs keep /setup as the only way to make
  // the first account, so the signup routes are not registered there at all.
  if (!signupEnabled(fastify.config)) return;
  if (!signupReady(fastify.config)) {
    fastify.log?.warn?.('cloud sign-up is off because COOKIE_SECRET is not set');
    return;
  }

  // Until /setup has created the first account, signup does not exist: an
  // anonymous visitor must never take the first slot on a fresh install.
  fastify.addHook('onRequest', async (request, reply) => {
    if (!(await setupComplete(fastify.db))) {
      return reply.code(404).send({ error: 'not found', code: 'NOT_FOUND' });
    }
  });

  const ipLimit = fastify.config.nodeEnv === 'test' || fastify.config.disableRateLimit ? 10000 : 5;
  // Two buckets, both counted only for valid requests:
  // - one client IP + one email: SIGNUP_PAIR_MAX per 15 minutes;
  // - one email from all IPs: SIGNUP_EMAIL_MAX per 15 minutes.
  // A request over its pair limit never counts toward the email bucket, so a
  // single client cannot lock a victim's email out for everyone else.
  const tooManyForPair = createEmailLimiter({ max: SIGNUP_PAIR_MAX });
  const tooManyForEmail = createEmailLimiter({ max: SIGNUP_EMAIL_MAX });

  fastify.get('/auth/signup', async () => ({ enabled: true, password_min: SIGNUP_PASSWORD_MIN }));

  fastify.post(
    '/auth/signup',
    {
      schema: signupSchema,
      config: { rateLimit: { max: ipLimit, timeWindow: '1 minute', keyGenerator: (req) => `signup:${req.ip}` } },
      preHandler: async (request, reply) => {
        await request.server.enforceCsrf(request, reply);
      },
    },
    async (request, reply) => {
      // Validate first: malformed attempts never count toward any bucket.
      const input = validateSignup(request.body);
      if (tooManyForPair(`${request.ip}|${input.email}`) || tooManyForEmail(input.email)) {
        return reply.code(429).send({ error: 'too many requests', code: 'RATE_LIMIT' });
      }
      await createSignupUser(fastify.db, input);
      return reply.code(200).send(SIGNUP_GENERIC);
    }
  );
}
