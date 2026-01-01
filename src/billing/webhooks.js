import { STRIPE_WEBHOOK_API_VERSION } from './config.js';
import { planFromPriceId } from './plans.js';
import { applyBillingHolds, clearBillingHold, graceEndsAt, setBillingHold } from './holds.js';

const HANDLED = new Set([
  'checkout.session.completed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
  'invoice.payment_paid',
  'invoice.paid',
]);

function eventCreatedAt(event) {
  const created = Number(event?.created);
  if (!Number.isFinite(created) || created <= 0) return null;
  return new Date(created * 1000);
}

function asId(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value.id) return String(value.id);
  return null;
}

function invoiceSubscriptionId(inv) {
  const parent = inv?.parent;
  if (parent && parent.type === 'subscription_details') {
    return asId(parent.subscription_details?.subscription) ?? null;
  }
  if (parent) return null;
  return asId(inv?.subscription) ?? null;
}

function isOpenSubscription(existing) {
  return existing?.status === 'active' || existing?.status === 'past_due';
}

function claimedUserId(object) {
  return object?.client_reference_id || object?.metadata?.user_id || '';
}

function unknownSubscriptionResult(object) {
  if (!claimedUserId(object)) return { ignored: 'no user' };
  return { retry: true, reason: 'unknown subscription' };
}

function sameAccount(existing, userId) {
  return String(existing.user_id) === String(userId);
}

function subscriptionPriceId(object) {
  return object?.items?.data?.[0]?.price?.id || object?.plan?.id || object?.display_items?.[0]?.price?.id || null;
}

async function findSubscription(client, { userId, stripeSubscriptionId, stripeCustomerId }) {
  if (stripeSubscriptionId) {
    const { rows } = await client.query('SELECT * FROM subscriptions WHERE stripe_subscription_id = $1', [
      stripeSubscriptionId,
    ]);
    if (rows[0]) return rows[0];
  }
  if (userId) {
    const { rows } = await client.query('SELECT * FROM subscriptions WHERE user_id = $1', [userId]);
    if (rows[0]) return rows[0];
  }
  if (stripeCustomerId) {
    const { rows } = await client.query('SELECT * FROM subscriptions WHERE stripe_customer_id = $1', [
      stripeCustomerId,
    ]);
    if (rows[0]) return rows[0];
  }
  return null;
}

function isOtherSubscription(existing, eventSubId) {
  return Boolean(
    eventSubId && existing?.stripe_subscription_id && existing.stripe_subscription_id !== eventSubId
  );
}

async function resolveSubEvent(client, object, eventSubId) {
  const subId = asId(eventSubId);
  if (!subId) return { ignored: 'no subscription' };
  const userId = claimedUserId(object);
  const customerId = asId(object.customer) || object.customer || null;
  const existing = await findSubscription(client, {
    userId,
    stripeSubscriptionId: subId,
    stripeCustomerId: customerId,
  });
  if (isOtherSubscription(existing, subId)) return { ignored: 'other subscription' };
  if (!existing) return unknownSubscriptionResult(object);
  if (userId && !sameAccount(existing, userId)) return { ignored: 'user mismatch' };
  return { existing };
}

async function customerConflicts(client, { userId, existing, customerId }) {
  if (!customerId) return false;
  if (existing?.stripe_customer_id && existing.stripe_customer_id !== customerId) return true;
  const { rows } = await client.query(
    'SELECT 1 FROM subscriptions WHERE stripe_customer_id = $1 AND user_id <> $2 LIMIT 1',
    [customerId, userId]
  );
  return rows.length > 0;
}

// Same-second events are not stale: they apply in arrival order (strictly later stored time only).
// A missing last_stripe_event_at is older, so a dated incoming event may apply.
function isStale(existing, when) {
  if (!existing?.last_stripe_event_at) return false;
  return new Date(existing.last_stripe_event_at).getTime() > new Date(when).getTime();
}

function isIncomingNewer(existing, when) {
  if (!existing?.last_stripe_event_at) return true;
  return new Date(when).getTime() > new Date(existing.last_stripe_event_at).getTime();
}

const NO_PLAN_TIER = 'no_plan';

async function markCanceled(client, userId, when) {
  await client.query(
    `UPDATE subscriptions
        SET status = 'canceled', grace_ends_at = NULL, last_stripe_event_at = $2, updated_at = now()
      WHERE user_id = $1`,
    [userId, when]
  );
  await client.query('UPDATE users SET tier = $2 WHERE id = $1', [userId, NO_PLAN_TIER]);
  await setBillingHold(client, userId, true);
}

async function upsertActive(client, { userId, plan, interval, customerId, subscriptionId, when }) {
  await client.query('UPDATE users SET tier = $2 WHERE id = $1', [userId, plan]);
  const { rows } = await client.query(
    `INSERT INTO subscriptions (
        user_id, plan, billing_interval, status, stripe_customer_id, stripe_subscription_id,
        grace_ends_at, last_stripe_event_at, updated_at
      ) VALUES ($1, $2, $3, 'active', $4, $5, NULL, $6, now())
      ON CONFLICT (user_id) DO UPDATE SET
        plan = excluded.plan,
        billing_interval = excluded.billing_interval,
        status = 'active',
        stripe_customer_id = COALESCE(excluded.stripe_customer_id, subscriptions.stripe_customer_id),
        stripe_subscription_id = COALESCE(excluded.stripe_subscription_id, subscriptions.stripe_subscription_id),
        grace_ends_at = NULL,
        last_stripe_event_at = excluded.last_stripe_event_at,
        updated_at = now()
      RETURNING *`,
    [userId, plan, interval, customerId || null, subscriptionId || null, when]
  );
  return rows[0];
}

async function handleCheckoutCompleted(client, config, object, when, log) {
  const userId = object.client_reference_id || object.metadata?.user_id;
  if (!userId) return { ignored: 'no user' };
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1::text))', [String(userId)]);
  const subscriptionId = asId(object.subscription);
  if (object.mode !== 'subscription' || !subscriptionId) {
    return { ignored: 'not a subscription checkout' };
  }
  let plan = object.metadata?.plan;
  let interval = object.metadata?.interval;
  const priceId = object.metadata?.price_id || subscriptionPriceId(object);
  if ((!plan || !interval) && priceId) {
    const mapped = planFromPriceId(config, priceId);
    if (mapped) {
      plan = plan || mapped.plan;
      interval = interval || mapped.interval;
    }
  }
  if (!plan || !interval) return { ignored: 'no plan' };
  const existing = await findSubscription(client, {
    userId,
    stripeSubscriptionId: subscriptionId,
    stripeCustomerId: asId(object.customer) || object.customer,
  });
  if (existing && !sameAccount(existing, userId)) return { ignored: 'user mismatch' };
  if (
    existing
    && (existing.status === 'active' || existing.status === 'past_due')
    && existing.stripe_subscription_id
    && existing.stripe_subscription_id !== subscriptionId
  ) {
    if (log?.warn) {
      log.warn(
        {
          userId,
          currentSubscription: existing.stripe_subscription_id,
          incomingSubscription: subscriptionId,
        },
        'checkout named a different subscription than the current one'
      );
    }
    return { ignored: 'duplicate subscription' };
  }
  if (existing && isStale(existing, when)) return { stale: true, subscription: existing };
  if (existing && (existing.status === 'canceled' || existing.status === 'expired')) {
    const sameSub = Boolean(
      existing.stripe_subscription_id && existing.stripe_subscription_id === subscriptionId
    );
    // A missing stored event time is older, so a dated checkout with a different sub may apply.
    if (sameSub || !isIncomingNewer(existing, when)) return { stale: true, subscription: existing };
    if (await customerConflicts(client, { userId, existing, customerId: asId(object.customer) || object.customer })) {
      return { ignored: 'customer mismatch' };
    }
  }
  const row = await upsertActive(client, {
    userId,
    plan,
    interval,
    customerId: asId(object.customer) || object.customer,
    subscriptionId,
    when,
  });
  await clearBillingHold(client, userId);
  return { applied: 'checkout', subscription: row };
}

async function handleSubscriptionUpdated(client, config, object, when) {
  const resolved = await resolveSubEvent(client, object, object.id);
  if (resolved.ignored || resolved.retry) return resolved;
  const existing = resolved.existing;
  if (isStale(existing, when)) return { stale: true, subscription: existing };
  const status = String(object.status || '');
  const mapped = planFromPriceId(config, subscriptionPriceId(object));
  const plan = mapped?.plan || existing.plan;
  const interval = mapped?.interval || existing.billing_interval;
  if ((status === 'active' || status === 'trialing' || status === 'past_due' || status === 'incomplete') && !isOpenSubscription(existing)) {
    return { ignored: 'not open' };
  }
  if (status === 'active' || status === 'trialing') {
    const row = await upsertActive(client, {
      userId: existing.user_id,
      plan,
      interval,
      customerId: object.customer,
      subscriptionId: object.id,
      when,
    });
    await clearBillingHold(client, existing.user_id);
    return { applied: 'subscription.active', subscription: row };
  }
  if (status === 'canceled' || status === 'unpaid' || status === 'incomplete_expired') {
    await markCanceled(client, existing.user_id, when);
    return { applied: 'subscription.canceled' };
  }
  if (status === 'past_due' || status === 'incomplete') {
    const grace = existing.grace_ends_at || graceEndsAt(when);
    await client.query(
      `UPDATE subscriptions
          SET status = 'past_due',
              grace_ends_at = COALESCE(grace_ends_at, $2),
              last_stripe_event_at = $3,
              updated_at = now()
        WHERE user_id = $1`,
      [existing.user_id, grace, when]
    );
    return { applied: 'subscription.past_due' };
  }
  await client.query('UPDATE subscriptions SET last_stripe_event_at = $2, updated_at = now() WHERE user_id = $1', [
    existing.user_id,
    when,
  ]);
  return { applied: 'subscription.other' };
}

async function handleSubscriptionDeleted(client, object, when) {
  const resolved = await resolveSubEvent(client, object, object.id);
  if (resolved.ignored || resolved.retry) return resolved;
  const existing = resolved.existing;
  if (isStale(existing, when)) return { stale: true };
  await markCanceled(client, existing.user_id, when);
  return { applied: 'subscription.deleted' };
}

async function handleInvoiceFailed(client, object, when) {
  const resolved = await resolveSubEvent(client, object, invoiceSubscriptionId(object));
  if (resolved.ignored || resolved.retry) return resolved;
  const existing = resolved.existing;
  if (isStale(existing, when)) return { stale: true };
  if (!isOpenSubscription(existing)) return { ignored: 'not open' };
  await client.query(
    `UPDATE subscriptions
        SET status = 'past_due',
            grace_ends_at = COALESCE(grace_ends_at, $2),
            last_stripe_event_at = $3,
            updated_at = now()
      WHERE user_id = $1`,
    [existing.user_id, graceEndsAt(when), when]
  );
  return { applied: 'invoice.payment_failed' };
}

async function handleInvoicePaid(client, object, when) {
  const resolved = await resolveSubEvent(client, object, invoiceSubscriptionId(object));
  if (resolved.ignored || resolved.retry) return resolved;
  const existing = resolved.existing;
  if (isStale(existing, when)) return { stale: true };
  if (!isOpenSubscription(existing)) return { ignored: 'not open' };
  await client.query(
    `UPDATE subscriptions
        SET status = 'active', grace_ends_at = NULL, last_stripe_event_at = $2, updated_at = now()
      WHERE user_id = $1`,
    [existing.user_id, when]
  );
  await clearBillingHold(client, existing.user_id);
  return { applied: 'invoice.payment_paid' };
}

export async function processStripeEvent(db, config, event, { now, log } = {}) {
  const eventId = event?.id;
  const eventType = event?.type;
  if (!eventId || !eventType) {
    const err = new Error('invalid stripe event');
    err.statusCode = 400;
    err.code = 'BAD_EVENT';
    throw err;
  }
  if (event.livemode !== false) {
    const err = new Error('live stripe events are refused');
    err.statusCode = 400;
    err.code = 'STRIPE_LIVEMODE';
    throw err;
  }
  const when = eventCreatedAt(event);
  if (!when) {
    const err = new Error('invalid stripe event');
    err.statusCode = 400;
    err.code = 'STRIPE_EVENT_TIME';
    throw err;
  }
  const logger = log || config.log;
  if (event.api_version !== STRIPE_WEBHOOK_API_VERSION && logger?.warn) {
    logger.warn(
      {
        eventId,
        eventType,
        apiVersion: event.api_version || null,
        expected: STRIPE_WEBHOOK_API_VERSION,
      },
      'untested stripe event api_version'
    );
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO stripe_events (event_id, event_type, created_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [eventId, eventType, when]
    );
    if (!inserted.rowCount) {
      await client.query('COMMIT');
      return { duplicate: true };
    }
    if (!HANDLED.has(eventType)) {
      await client.query('COMMIT');
      return { ignored: eventType };
    }
    const object = event.data?.object || {};
    let result;
    if (eventType === 'checkout.session.completed') {
      result = await handleCheckoutCompleted(client, config, object, when, logger);
    } else if (eventType === 'customer.subscription.updated') {
      result = await handleSubscriptionUpdated(client, config, object, when);
    } else if (eventType === 'customer.subscription.deleted') {
      result = await handleSubscriptionDeleted(client, object, when);
    } else if (eventType === 'invoice.payment_failed') {
      result = await handleInvoiceFailed(client, object, when);
    } else if (eventType === 'invoice.payment_paid' || eventType === 'invoice.paid') {
      result = await handleInvoicePaid(client, object, when);
    } else {
      result = { ignored: eventType };
    }
    if (result?.retry) {
      await client.query('ROLLBACK');
      const err = new Error('subscription not ready');
      err.statusCode = 500;
      err.code = 'STRIPE_EVENT_RETRY';
      throw err;
    }
    await client.query('COMMIT');
    await applyBillingHolds(db, now || when);
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // already rolled back
    }
    throw err;
  } finally {
    client.release();
  }
}
