import { consumeSetupToken } from '../setup.js';
import { publicUser } from '../auth.js';
import { setupSchema } from '../schemas.js';

export async function setupRoutes(fastify) {
  const loginLimit = fastify.config.nodeEnv === 'test' || fastify.config.disableRateLimit ? 10000 : 5;
  fastify.post(
    '/setup',
    {
      schema: setupSchema,
      config: { rateLimit: { max: loginLimit, timeWindow: '1 minute' } },
    },
    async (request) => {
      const result = await consumeSetupToken(fastify.db, {
        token: request.body?.token,
        email: request.body?.email,
        password: request.body?.password,
        mode: fastify.config.merdienzMode,
      });
      return {
        user: publicUser(result.user),
        api_key: result.api_key,
      };
    }
  );
}
