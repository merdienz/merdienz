import { assertPlanAndInterval, BILLING_CATALOG } from '../billing/plans.js';
import { createCheckoutSession } from '../billing/stripe-client.js';
import { processStripeEvent } from '../billing/webhooks.js';
import { verifyStripeSignature } from '../billing/signature.js';

function billingDisabled() {
  const err = new Error('billing is not configured');
  err.statusCode = 503;
  err.code = 'BILLING_DISABLED';
  throw err;
}

export async function billingRoutes(fastify) {
  const config = fastify.config;

  fastify.get('/billing/plans', async () => ({
    plans: BILLING_CATALOG,
    enabled: Boolean(config.stripe?.enabled),
  }));

  fastify.get('/billing/status', { preHandler: fastify.authenticate }, async (request) => {
    const { rows } = await fastify.db.query(
      `SELECT plan, billing_interval, status, grace_ends_at, updated_at
         FROM subscriptions WHERE user_id = $1`,
      [request.user.id]
    );
    const { rows: holds } = await fastify.db.query(
      `SELECT
          EXISTS (SELECT 1 FROM sites WHERE user_id = $1 AND billing_hold) OR
          EXISTS (SELECT 1 FROM heartbeat_checks WHERE user_id = $1 AND billing_hold)
          AS held`,
      [request.user.id]
    );
    return {
      subscription: rows[0] || null,
      billing_hold: Boolean(holds[0]?.held),
      enabled: Boolean(config.stripe?.enabled),
    };
  });

  fastify.post('/billing/checkout', { preHandler: fastify.authenticate }, async (request) => {
    if (!config.stripe?.enabled) billingDisabled();
    const { plan, interval } = assertPlanAndInterval(request.body?.plan, request.body?.interval);
    const { rows } = await fastify.db.query(
      'SELECT stripe_customer_id, status FROM subscriptions WHERE user_id = $1',
      [request.user.id]
    );
    if (rows[0] && (rows[0].status === 'active' || rows[0].status === 'past_due')) {
      const err = new Error('a subscription is already active');
      err.statusCode = 409;
      err.code = 'SUBSCRIPTION_EXISTS';
      throw err;
    }
    const session = await createCheckoutSession(config, {
      userId: request.user.id,
      email: request.user.email,
      plan,
      interval,
      customerId: rows[0]?.stripe_customer_id || '',
      fetchFn: fastify.fetchFn,
    });
    return { id: session.id, url: session.url };
  });

  fastify.post('/billing/webhook', async (request, reply) => {
    if (!config.stripe?.webhookSecret) billingDisabled();
    const raw = request.rawBody ?? (typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? {}));
    verifyStripeSignature(raw, request.headers['stripe-signature'], config.stripe.webhookSecret, {
      now: config.now ? config.now() : Date.now(),
      toleranceSec: config.stripe.signatureToleranceSec,
    });
    const event = typeof request.body === 'object' && request.body ? request.body : JSON.parse(raw);
    if (event && event.livemode !== false && request.log) {
      request.log.warn({ eventId: event.id, eventType: event.type }, 'refused live stripe event');
    }
    const result = await processStripeEvent(fastify.db, config, event, {
      now: config.now ? new Date(config.now()) : new Date(),
      log: config.log || request.log,
    });
    return reply.code(200).send({ received: true, ...result });
  });
}
