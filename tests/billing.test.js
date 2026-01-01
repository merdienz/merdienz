import { createHmac } from 'node:crypto';
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { CHECKOUT_SESSION_TTL_SEC, STRIPE_WEBHOOK_API_VERSION } from '../src/billing/config.js';
import { applyBillingHolds } from '../src/billing/holds.js';
import { isAllowedStripeSecretKey, isLiveStripeKey } from '../src/billing/keys.js';
import { evaluateHeartbeats } from '../src/heartbeat-checks.js';
import { loadDueSites, runSchedulerTick } from '../src/scheduler.js';
import { createMailer } from '../src/alerts/email.js';
import {
  authHeader,
  createUser,
  getDb,
  resetData,
  testConfig,
  withApp,
} from './helpers.js';

function testSecretKey() {
  return ['sk', 'test', 'billingunit123456'].join('_');
}

function liveSecretKey() {
  return ['sk', 'live', 'billingunit123456'].join('_');
}

function liveRestrictedKey() {
  return ['rk', 'live', 'billingunit123456'].join('_');
}

function livePublishableKey() {
  return ['pk', 'live', 'billingunit123456'].join('_');
}

function testRestrictedKey() {
  return ['rk', 'test', 'billingunit123456'].join('_');
}

function unknownPrefixKey() {
  return ['sk', 'prod', 'billingunit123456'].join('_');
}

function billingLoad(overrides = {}) {
  return loadConfig({
    nodeEnv: 'test',
    merdienzMode: 'test',
    host: '127.0.0.1',
    mailTransport: 'dev',
    probeBSecret: 'x'.repeat(32),
    cookieSecret: 'test-cookie-secret-32-bytes-long!!',
    ...overrides,
  });
}

const WEBHOOK_SECRET = 'whsec-test-billing-unit';
const PRICES = {
  starter_monthly: 'price_starter_monthly_test',
  starter_yearly: 'price_starter_yearly_test',
  pro_monthly: 'price_pro_monthly_test',
  pro_yearly: 'price_pro_yearly_test',
};

function billingOverrides(extra = {}) {
  return {
    publicUrl: 'https://app.merdienz.com',
    stripe: {
      secretKey: testSecretKey(),
      webhookSecret: WEBHOOK_SECRET,
      prices: PRICES,
      apiBase: 'https://stripe.test.invalid',
      ...extra,
    },
  };
}

function sign(body, { secret = WEBHOOK_SECRET, now = Date.now(), ts } = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const timestamp = ts != null ? ts : Math.floor(Number(now) / 1000);
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return { payload, header: `t=${timestamp},v1=${v1}`, timestamp };
}

const envKeys = [
  'MERDIENZ_STRIPE_SECRET_KEY_FILE',
  'MERDIENZ_STRIPE_WEBHOOK_SECRET_FILE',
  'MERDIENZ_STRIPE_LIVE_OK',
  'STRIPE_API_BASE',
  'STRIPE_PRICE_STARTER_MONTHLY',
  'STRIPE_PRICE_STARTER_YEARLY',
  'STRIPE_PRICE_PRO_MONTHLY',
  'STRIPE_PRICE_PRO_YEARLY',
];
const envBackup = {};
for (const k of envKeys) envBackup[k] = process.env[k];

afterEach(() => {
  for (const k of envKeys) {
    if (envBackup[k] == null) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
});

async function postWebhook(app, event, { header, signedAt, omitLivemode = false, omitApiVersion = false } = {}) {
  let body = event;
  if (typeof event === 'object' && event != null) {
    body = { ...event };
    if (!omitLivemode && event.livemode === undefined) body.livemode = false;
    if (!omitApiVersion && event.api_version === undefined) body.api_version = STRIPE_WEBHOOK_API_VERSION;
    if (event.type === 'checkout.session.completed' && event.data?.object && event.data.object.mode === undefined) {
      body = {
        ...body,
        data: { ...event.data, object: { mode: 'subscription', ...event.data.object } },
      };
    }
  }
  const { payload, header: signed } = sign(body, { now: signedAt ?? Date.now() });
  return app.inject({
    method: 'POST',
    url: '/billing/webhook',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': header || signed,
    },
    payload,
  });
}

describe('Stripe key refusal', () => {
  it('allow-lists only TEST secret keys and refuses live keys even when an override is set', () => {
    expect(isLiveStripeKey(liveSecretKey())).toBe(true);
    expect(isLiveStripeKey(liveRestrictedKey())).toBe(true);
    expect(isLiveStripeKey(livePublishableKey())).toBe(true);
    expect(isLiveStripeKey(testSecretKey())).toBe(false);
    expect(isAllowedStripeSecretKey(testSecretKey())).toBe(true);
    expect(isAllowedStripeSecretKey(testRestrictedKey())).toBe(true);
    expect(isAllowedStripeSecretKey(unknownPrefixKey())).toBe(false);
    expect(isAllowedStripeSecretKey(liveSecretKey())).toBe(false);
    const stripe = { webhookSecret: WEBHOOK_SECRET, prices: PRICES };
    expect(() => billingLoad({ stripe: { ...stripe, secretKey: liveSecretKey() } })).toThrow(/TEST secret key/);
    expect(() => billingLoad({ stripe: { ...stripe, secretKey: liveRestrictedKey() } })).toThrow(/TEST secret key/);
    expect(() => billingLoad({ stripe: { ...stripe, secretKey: testSecretKey(), webhookSecret: livePublishableKey() } })).toThrow(/live Stripe key/);
    expect(() => billingLoad({ stripe: { ...stripe, secretKey: unknownPrefixKey() } })).toThrow(/TEST secret key/);
    process.env.MERDIENZ_STRIPE_LIVE_OK = '1';
    expect(() => billingLoad({ stripe: { ...stripe, secretKey: liveSecretKey() } })).toThrow(/TEST secret key/);
    expect(() =>
      billingLoad({ stripe: { ...stripe, secretKey: liveSecretKey(), liveOk: true } })
    ).toThrow(/TEST secret key/);
    const cfg = billingLoad({ stripe: { ...stripe, secretKey: testRestrictedKey() } });
    expect(cfg.stripe.enabled).toBe(true);
    expect(cfg.stripe.liveOk).toBeUndefined();
    expect(() =>
      loadConfig({
        nodeEnv: 'production',
        merdienzMode: 'cloud',
        host: '127.0.0.1',
        mailTransport: 'none',
        stripe: { secretKey: testSecretKey(), webhookSecret: WEBHOOK_SECRET, prices: PRICES, apiBase: 'http://127.0.0.1:4922' },
      })
    ).toThrow(/STRIPE_API_BASE/);
  });

  it('leaves billing disabled when no keys are set', () => {
    const cfg = testConfig();
    expect(cfg.stripe.enabled).toBe(false);
    expect(cfg.stripe.secretKey).toBe('');
  });

  it('reads TEST keys from secret files and refuses a missing explicit file', () => {
    const dir = join(tmpdir(), `merdienz-stripe-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const secretFile = join(dir, 'stripe-secret');
    const webhookFile = join(dir, 'stripe-webhook-secret');
    writeFileSync(secretFile, `${testSecretKey()}\n`, { mode: 0o600 });
    writeFileSync(webhookFile, `${WEBHOOK_SECRET}\n`, { mode: 0o600 });
    chmodSync(secretFile, 0o600);
    chmodSync(webhookFile, 0o600);
    process.env.MERDIENZ_STRIPE_SECRET_KEY_FILE = secretFile;
    process.env.MERDIENZ_STRIPE_WEBHOOK_SECRET_FILE = webhookFile;
    process.env.STRIPE_PRICE_STARTER_MONTHLY = PRICES.starter_monthly;
    process.env.STRIPE_PRICE_STARTER_YEARLY = PRICES.starter_yearly;
    process.env.STRIPE_PRICE_PRO_MONTHLY = PRICES.pro_monthly;
    process.env.STRIPE_PRICE_PRO_YEARLY = PRICES.pro_yearly;
    const cfg = testConfig();
    expect(cfg.stripe.enabled).toBe(true);
    expect(cfg.stripe.secretKey).toBe(testSecretKey());
    expect(cfg.stripe.webhookSecret).toBe(WEBHOOK_SECRET);
    process.env.MERDIENZ_STRIPE_SECRET_KEY_FILE = join(dir, 'missing-secret');
    expect(() => testConfig()).toThrow(/not found/);
    unlinkSync(secretFile);
    unlinkSync(webhookFile);
  });
});

describe('billing checkout', () => {
  it('requires a signed-in account and posts a mocked checkout session', async () => {
    const calls = [];
    const fetchFn = async (url, opts) => {
      calls.push({ url, body: opts.body, headers: opts.headers, signal: opts.signal });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 'cs_123', url: 'https://checkout.example.invalid/c/cs_123' }),
      };
    };
    await withApp(
      async ({ app, db }) => {
        const user = await createUser(db, { email: 'owner@example.com' });
        const unauth = await app.inject({
          method: 'POST',
          url: '/billing/checkout',
          payload: { plan: 'starter', interval: 'monthly' },
        });
        expect(unauth.statusCode).toBe(401);

        const badPlan = await app.inject({
          method: 'POST',
          url: '/billing/checkout',
          headers: authHeader(user),
          payload: { plan: 'enterprise', interval: 'monthly' },
        });
        expect(badPlan.statusCode).toBe(400);

        const ok = await app.inject({
          method: 'POST',
          url: '/billing/checkout',
          headers: authHeader(user),
          payload: { plan: 'starter', interval: 'monthly' },
        });
        expect(ok.statusCode).toBe(200);
        expect(ok.json()).toEqual({ id: 'cs_123', url: 'https://checkout.example.invalid/c/cs_123' });
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://stripe.test.invalid/v1/checkout/sessions');
        const form = decodeURIComponent(calls[0].body);
        expect(form).toContain(`line_items[0][price]=${PRICES.starter_monthly}`);
        expect(form).toContain('mode=subscription');
        const expiresAt = Number((form.match(/expires_at=(\d+)/) || [])[1]);
        const nowSec = Math.floor(Date.now() / 1000);
        expect(expiresAt).toBeGreaterThanOrEqual(nowSec + CHECKOUT_SESSION_TTL_SEC - 5);
        expect(expiresAt).toBeLessThanOrEqual(nowSec + CHECKOUT_SESSION_TTL_SEC + 5);
        expect(decodeURIComponent(calls[0].body)).toContain(
          'success_url=https://app.merdienz.com/billing/success?session_id={CHECKOUT_SESSION_ID}'
        );
        expect(decodeURIComponent(calls[0].body)).toContain('cancel_url=https://app.merdienz.com/billing/cancel');
        expect(calls[0].headers.authorization).toBe(`Bearer ${testSecretKey()}`);
        const keyRe = new RegExp(`^checkout:${user.id}:starter:monthly:[0-9a-f-]{36}$`, 'i');
        expect(calls[0].headers['Idempotency-Key']).toMatch(keyRe);
        expect(calls[0].signal).toBeDefined();

        const again = await app.inject({
          method: 'POST',
          url: '/billing/checkout',
          headers: authHeader(user),
          payload: { plan: 'starter', interval: 'monthly' },
        });
        expect(again.statusCode).toBe(200);
        expect(calls).toHaveLength(2);
        expect(calls[1].headers['Idempotency-Key']).toMatch(keyRe);
        expect(calls[1].headers['Idempotency-Key']).not.toBe(calls[0].headers['Idempotency-Key']);
      },
      { config: billingOverrides(), fetchFn }
    );
  });

  it('returns 503 when billing is not configured', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'none@example.com' });
      const res = await app.inject({
        method: 'POST',
        url: '/billing/checkout',
        headers: authHeader(user),
        payload: { plan: 'starter', interval: 'monthly' },
      });
      expect(res.statusCode).toBe(503);
      const plans = await app.inject({ method: 'GET', url: '/billing/plans' });
      expect(plans.statusCode).toBe(200);
      expect(plans.json().enabled).toBe(false);
      expect(plans.json().plans.starter.monthly.amount).toBe('4.99');
      expect(plans.json().plans.starter.yearly.amount).toBe('49.90');
      expect(plans.json().plans.pro.monthly.amount).toBe('19.99');
      expect(plans.json().plans.pro.yearly.amount).toBe('199');
    });
  });
});

describe('billing webhooks', () => {
  it('accepts a valid signature and rejects invalid or stale ones', async () => {
    await withApp(
      async ({ app, db }) => {
        const user = await createUser(db, { email: 'hook@example.com' });
        const event = {
          id: 'evt_valid_1',
          type: 'checkout.session.completed',
          created: Math.floor(Date.now() / 1000),
          data: {
            object: {
              client_reference_id: user.id,
              customer: 'cus_1',
              subscription: 'sub_1',
              metadata: { user_id: user.id, plan: 'starter', interval: 'monthly' },
            },
          },
        };
        const ok = await postWebhook(app, event);
        expect(ok.statusCode).toBe(200);
        expect(ok.json().duplicate).toBeUndefined();
        const sub = await db.query('SELECT plan, status, stripe_subscription_id FROM subscriptions WHERE user_id = $1', [
          user.id,
        ]);
        expect(sub.rows[0]).toMatchObject({ plan: 'starter', status: 'active', stripe_subscription_id: 'sub_1' });
        const tier = await db.query('SELECT tier FROM users WHERE id = $1', [user.id]);
        expect(tier.rows[0].tier).toBe('starter');

        const invalid = await postWebhook(app, { ...event, id: 'evt_invalid' }, { header: 't=1,v1=deadbeef' });
        expect(invalid.statusCode).toBe(400);

        const staleTs = Math.floor(Date.now() / 1000) - 301;
        const stale = await postWebhook(
          app,
          { ...event, id: 'evt_stale' },
          { header: sign({ ...event, id: 'evt_stale' }, { ts: staleTs }).header }
        );
        expect(stale.statusCode).toBe(400);
        expect(stale.json().error || stale.body).toMatch(/stale|signature/i);
      },
      { config: billingOverrides() }
    );
  });

  it('is idempotent on a duplicate event id', async () => {
    await withApp(
      async ({ app, db }) => {
        const user = await createUser(db, { email: 'dup@example.com' });
        const event = {
          id: 'evt_dup_1',
          type: 'checkout.session.completed',
          created: 1_700_000_000,
          data: {
            object: {
              client_reference_id: user.id,
              customer: 'cus_dup',
              subscription: 'sub_dup',
              metadata: { plan: 'pro', interval: 'yearly' },
            },
          },
        };
        const first = await postWebhook(app, event);
        const second = await postWebhook(app, event);
        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(200);
        expect(second.json().duplicate).toBe(true);
        const rows = await db.query('SELECT count(*)::int AS n FROM stripe_events WHERE event_id = $1', ['evt_dup_1']);
        expect(rows.rows[0].n).toBe(1);
      },
      { config: billingOverrides() }
    );
  });

  it('ignores an older out-of-order event', async () => {
    await withApp(
      async ({ app, db }) => {
        const user = await createUser(db, { email: 'ooo@example.com' });
        const checkout = {
          id: 'evt_ooo_new',
          type: 'checkout.session.completed',
          created: 2_000,
          data: {
            object: {
              client_reference_id: user.id,
              customer: 'cus_ooo',
              subscription: 'sub_ooo',
              metadata: { plan: 'starter', interval: 'monthly' },
            },
          },
        };
        const failed = {
          id: 'evt_ooo_old',
          type: 'invoice.payment_failed',
          created: 1_000,
          data: { object: { subscription: 'sub_ooo', customer: 'cus_ooo' } },
        };
        expect((await postWebhook(app, checkout)).statusCode).toBe(200);
        const late = await postWebhook(app, failed);
        expect(late.statusCode).toBe(200);
        expect(late.json().stale).toBe(true);
        const sub = await db.query('SELECT status, grace_ends_at FROM subscriptions WHERE user_id = $1', [user.id]);
        expect(sub.rows[0].status).toBe('active');
        expect(sub.rows[0].grace_ends_at).toBeNull();
      },
      { config: billingOverrides() }
    );
  });

  it('starts a 14-day grace from the first failed payment, pauses checks after grace, and resumes when paid', async () => {
    const start = new Date('2026-01-01T00:00:00.000Z');
    let nowMs = start.getTime();
    const hour = 60 * 60 * 1000;
    const day = 24 * hour;
    const config = billingOverrides();
    config.now = () => nowMs;
    await withApp(
      async ({ app, db }) => {
        const user = await createUser(db, { email: 'grace@example.com' });
        await db.query(
          `INSERT INTO sites (user_id, name, url, interval_seconds, last_checked_at)
           VALUES ($1, 'Held', 'http://192.0.2.10/', 300, now() - interval '10 minutes')`,
          [user.id]
        );
        await db.query(
          `INSERT INTO heartbeat_checks (user_id, name, period_seconds, grace_seconds, status, expected_at, grace_until)
           VALUES ($1, 'HB', 60, 1, 'up', $2, $2)`,
          [user.id, new Date(nowMs - 60_000)]
        );
        const checkout = {
          id: 'evt_grace_start',
          type: 'checkout.session.completed',
          created: Math.floor(nowMs / 1000),
          data: {
            object: {
              client_reference_id: user.id,
              customer: 'cus_grace',
              subscription: 'sub_grace',
              metadata: { plan: 'starter', interval: 'monthly' },
            },
          },
        };
        expect((await postWebhook(app, checkout, { signedAt: nowMs })).statusCode).toBe(200);

        const failedAt = start.getTime() + 1000;
        const failed = {
          id: 'evt_grace_fail',
          type: 'invoice.payment_failed',
          created: Math.floor(failedAt / 1000),
          data: { object: { subscription: 'sub_grace', customer: 'cus_grace' } },
        };
        nowMs = failedAt;
        expect((await postWebhook(app, failed, { signedAt: nowMs })).statusCode).toBe(200);
        const mid = await db.query('SELECT status, grace_ends_at FROM subscriptions WHERE user_id = $1', [user.id]);
        expect(mid.rows[0].status).toBe('past_due');
        const graceEnd = new Date(mid.rows[0].grace_ends_at);
        expect(graceEnd.toISOString()).toBe('2026-01-15T00:00:01.000Z');
        expect(graceEnd.getTime()).toBe(failedAt + 14 * day);

        nowMs = failedAt + 3 * day;
        const laterFail = {
          id: 'evt_grace_fail_2',
          type: 'invoice.payment_failed',
          created: Math.floor(nowMs / 1000),
          data: { object: { subscription: 'sub_grace', customer: 'cus_grace' } },
        };
        expect((await postWebhook(app, laterFail, { signedAt: nowMs })).statusCode).toBe(200);
        const still = await db.query('SELECT grace_ends_at FROM subscriptions WHERE user_id = $1', [user.id]);
        expect(new Date(still.rows[0].grace_ends_at).toISOString()).toBe('2026-01-15T00:00:01.000Z');

        nowMs = failedAt + 13 * day + 23 * hour;
        await applyBillingHolds(db, new Date(nowMs));
        const before = await db.query('SELECT billing_hold FROM sites WHERE user_id = $1', [user.id]);
        expect(before.rows[0].billing_hold).toBe(false);
        await db.query(`UPDATE sites SET last_checked_at = now() - interval '10 minutes' WHERE user_id = $1`, [user.id]);
        const dueDuring = await loadDueSites(db, 50, new Date(nowMs));
        expect(dueDuring.some((s) => s.user_id === user.id)).toBe(true);

        nowMs = graceEnd.getTime();
        await applyBillingHolds(db, new Date(nowMs));
        const held = await db.query(
          'SELECT billing_hold FROM sites WHERE user_id = $1 UNION ALL SELECT billing_hold FROM heartbeat_checks WHERE user_id = $1',
          [user.id]
        );
        expect(held.rows.every((r) => r.billing_hold === true)).toBe(true);
        await db.query(`UPDATE sites SET last_checked_at = now() - interval '10 minutes' WHERE user_id = $1`, [user.id]);
        const dueAfter = await loadDueSites(db, 50, new Date(nowMs));
        expect(dueAfter.some((s) => s.user_id === user.id)).toBe(false);
        const hb = await evaluateHeartbeats({ db, mailer: createMailer(testConfig()), now: new Date(nowMs + 1) });
        expect(hb).toEqual([]);

        const paid = {
          id: 'evt_grace_paid',
          type: 'invoice.paid',
          created: Math.floor(nowMs / 1000) + 10,
          data: { object: { subscription: 'sub_grace', customer: 'cus_grace' } },
        };
        expect((await postWebhook(app, paid, { signedAt: nowMs + 10_000 })).statusCode).toBe(200);
        const after = await db.query('SELECT status, grace_ends_at FROM subscriptions WHERE user_id = $1', [user.id]);
        expect(after.rows[0].status).toBe('active');
        expect(after.rows[0].grace_ends_at).toBeNull();
        const released = await db.query('SELECT billing_hold FROM sites WHERE user_id = $1', [user.id]);
        expect(released.rows[0].billing_hold).toBe(false);
        await db.query(`UPDATE sites SET last_checked_at = now() - interval '10 minutes' WHERE user_id = $1`, [user.id]);
        const dueAgain = await loadDueSites(db, 50, new Date(nowMs));
        expect(dueAgain.some((s) => s.user_id === user.id)).toBe(true);
      },
      { config }
    );
  });

  it('pauses checks immediately when the subscription is deleted', async () => {
    await withApp(
      async ({ app, db }) => {
        const user = await createUser(db, { email: 'del@example.com' });
        await db.query(
          `INSERT INTO sites (user_id, name, url, interval_seconds, last_checked_at)
           VALUES ($1, 'Gone', 'http://192.0.2.11/', 300, now() - interval '10 minutes')`,
          [user.id]
        );
        const checkout = {
          id: 'evt_del_start',
          type: 'checkout.session.completed',
          created: 3_000,
          data: {
            object: {
              client_reference_id: user.id,
              customer: 'cus_del',
              subscription: 'sub_del',
              metadata: { plan: 'pro', interval: 'monthly' },
            },
          },
        };
        await postWebhook(app, checkout);
        const deleted = {
          id: 'evt_del_done',
          type: 'customer.subscription.deleted',
          created: 3_001,
          data: { object: { id: 'sub_del', customer: 'cus_del', metadata: { user_id: user.id } } },
        };
        expect((await postWebhook(app, deleted)).statusCode).toBe(200);
        const sub = await db.query('SELECT status FROM subscriptions WHERE user_id = $1', [user.id]);
        expect(sub.rows[0].status).toBe('canceled');
        const tier = await db.query('SELECT tier FROM users WHERE id = $1', [user.id]);
        expect(tier.rows[0].tier).toBe('no_plan');
        const hold = await db.query('SELECT billing_hold FROM sites WHERE user_id = $1', [user.id]);
        expect(hold.rows[0].billing_hold).toBe(true);
        const due = await loadDueSites(db);
        expect(due.some((s) => s.user_id === user.id)).toBe(false);

        const lateCheckout = {
          id: 'evt_del_late_checkout',
          type: 'checkout.session.completed',
          created: 3_000 + 60,
          data: {
            object: {
              client_reference_id: user.id,
              customer: 'cus_del',
              subscription: 'sub_del',
              metadata: { plan: 'pro', interval: 'monthly' },
            },
          },
        };
        const late = await postWebhook(app, lateCheckout);
        expect(late.statusCode).toBe(200);
        expect(late.json().stale).toBe(true);
        const afterLate = await db.query('SELECT status FROM subscriptions WHERE user_id = $1', [user.id]);
        expect(afterLate.rows[0].status).toBe('canceled');
        const tierLate = await db.query('SELECT tier FROM users WHERE id = $1', [user.id]);
        expect(tierLate.rows[0].tier).toBe('no_plan');

        const created = await app.inject({
          method: 'POST',
          url: '/sites',
          headers: authHeader(user),
          payload: { name: 'after', url: 'http://192.0.2.21/', interval_seconds: 300 },
        });
        expect(created.statusCode).toBe(200);
        const later = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        await applyBillingHolds(db, later);
        const dueLater = await loadDueSites(db, 50, later);
        expect(dueLater.some((s) => s.user_id === user.id)).toBe(false);
      },
      { config: billingOverrides() }
    );
  });

  it('rejects livemode events, bad JSON, and a missing signature before the body is parsed', async () => {
    await withApp(
      async ({ app, db }) => {
        const user = await createUser(db, { email: 'livemode@example.com' });
        const liveEvent = {
          id: 'evt_live_1',
          type: 'checkout.session.completed',
          livemode: true,
          created: Math.floor(Date.now() / 1000),
          data: {
            object: {
              client_reference_id: user.id,
              customer: 'cus_live',
              subscription: 'sub_live',
              metadata: { plan: 'starter', interval: 'monthly' },
            },
          },
        };
        const live = await postWebhook(app, liveEvent);
        expect(live.statusCode).toBe(400);
        expect(live.json().code).toBe('STRIPE_LIVEMODE');
        const stored = await db.query('SELECT count(*)::int AS n FROM stripe_events WHERE event_id = $1', [
          'evt_live_1',
        ]);
        expect(stored.rows[0].n).toBe(0);

        const missingMode = {
          id: 'evt_live_missing',
          type: 'checkout.session.completed',
          created: Math.floor(Date.now() / 1000),
          data: { object: { client_reference_id: user.id, metadata: { plan: 'starter', interval: 'monthly' } } },
        };
        const missingModeRes = await postWebhook(app, missingMode, { omitLivemode: true });
        expect(missingModeRes.statusCode).toBe(400);
        expect(missingModeRes.json().code).toBe('STRIPE_LIVEMODE');
        const storedMissing = await db.query('SELECT count(*)::int AS n FROM stripe_events WHERE event_id = $1', [
          'evt_live_missing',
        ]);
        expect(storedMissing.rows[0].n).toBe(0);

        const missing = await app.inject({
          method: 'POST',
          url: '/billing/webhook',
          headers: { 'content-type': 'application/json' },
          payload: '{not json',
        });
        expect(missing.statusCode).toBe(400);
        expect(missing.json().code).toBe('STRIPE_SIGNATURE');
        expect(missing.json().error).toBe('missing stripe signature');

        const badPayload = '{not json';
        const signedBad = sign(badPayload);
        const badJson = await app.inject({
          method: 'POST',
          url: '/billing/webhook',
          headers: { 'content-type': 'application/json', 'stripe-signature': signedBad.header },
          payload: badPayload,
        });
        expect(badJson.statusCode).toBe(400);
        expect(badJson.json()).toEqual({ error: 'invalid JSON', code: 'INVALID_JSON' });
      },
      { config: billingOverrides() }
    );
  });

  it('returns 500 so Stripe retries when subscription.updated arrives before checkout', async () => {
    await withApp(
      async ({ app, db }) => {
        const user = await createUser(db, { email: 'early@example.com' });
        const updated = {
          id: 'evt_updated_early',
          type: 'customer.subscription.updated',
          created: 4_000,
          data: {
            object: {
              id: 'sub_early',
              customer: 'cus_early',
              status: 'active',
              metadata: { plan: 'starter', interval: 'monthly', user_id: user.id },
            },
          },
        };
        const early = await postWebhook(app, updated);
        expect(early.statusCode).toBe(500);
        expect(early.json().code).toBe('STRIPE_EVENT_RETRY');
        const stored = await db.query('SELECT count(*)::int AS n FROM stripe_events WHERE event_id = $1', [
          'evt_updated_early',
        ]);
        expect(stored.rows[0].n).toBe(0);

        const checkout = {
          id: 'evt_early_checkout',
          type: 'checkout.session.completed',
          created: 4_001,
          data: {
            object: {
              client_reference_id: user.id,
              customer: 'cus_early',
              subscription: 'sub_early',
              metadata: { plan: 'starter', interval: 'monthly' },
            },
          },
        };
        expect((await postWebhook(app, checkout)).statusCode).toBe(200);
        const retry = await postWebhook(app, updated);
        expect(retry.statusCode).toBe(200);
      },
      { config: billingOverrides() }
    );
  });

  it('activates a legacy canceled row with no last event time, and refuses events with no created field', async () => {
    await withApp(
      async ({ app, db }) => {
        const user = await createUser(db, { email: 'legacy@example.com' });
        await db.query(
          `INSERT INTO subscriptions (user_id, plan, billing_interval, status, stripe_subscription_id, last_stripe_event_at)
           VALUES ($1, 'starter', 'monthly', 'canceled', 'sub_legacy', NULL)`,
          [user.id]
        );
        const dated = {
          id: 'evt_legacy_resub',
          type: 'checkout.session.completed',
          created: 5_000,
          data: {
            object: {
              client_reference_id: user.id,
              customer: 'cus_legacy',
              subscription: 'sub_legacy_new',
              metadata: { plan: 'starter', interval: 'monthly' },
            },
          },
        };
        expect((await postWebhook(app, dated)).statusCode).toBe(200);
        const after = await db.query('SELECT status, last_stripe_event_at FROM subscriptions WHERE user_id = $1', [
          user.id,
        ]);
        expect(after.rows[0].status).toBe('active');
        expect(new Date(after.rows[0].last_stripe_event_at).toISOString()).toBe('1970-01-01T01:23:20.000Z');

        const noTime = {
          id: 'evt_legacy_notime',
          type: 'invoice.payment_failed',
          data: { object: { subscription: 'sub_legacy_new', customer: 'cus_legacy' } },
        };
        const skipped = await postWebhook(app, noTime);
        expect(skipped.statusCode).toBe(400);
        expect(skipped.json().code).toBe('STRIPE_EVENT_TIME');
        const stored = await db.query('SELECT count(*)::int AS n FROM stripe_events WHERE event_id = $1', [
          'evt_legacy_notime',
        ]);
        expect(stored.rows[0].n).toBe(0);
        const still = await db.query('SELECT status, last_stripe_event_at FROM subscriptions WHERE user_id = $1', [
          user.id,
        ]);
        expect(still.rows[0].status).toBe('active');
        expect(new Date(still.rows[0].last_stripe_event_at).toISOString()).toBe('1970-01-01T01:23:20.000Z');
      },
      { config: billingOverrides() }
    );
  });

  it('ignores a checkout whose claimed user does not match the subscription account', async () => {
    await withApp(
      async ({ app, db }) => {
        const alice = await createUser(db, { email: 'alice@example.com' });
        const bob = await createUser(db, { email: 'bob@example.com' });
        const checkoutA = {
          id: 'evt_alice_co',
          type: 'checkout.session.completed',
          created: 6_000,
          data: {
            object: {
              client_reference_id: alice.id,
              customer: 'cus_alice',
              subscription: 'sub_alice',
              metadata: { plan: 'starter', interval: 'monthly' },
            },
          },
        };
        const checkoutB = {
          id: 'evt_bob_co',
          type: 'checkout.session.completed',
          created: 6_001,
          data: {
            object: {
              client_reference_id: bob.id,
              customer: 'cus_bob',
              subscription: 'sub_bob',
              metadata: { plan: 'pro', interval: 'monthly' },
            },
          },
        };
        expect((await postWebhook(app, checkoutA)).statusCode).toBe(200);
        expect((await postWebhook(app, checkoutB)).statusCode).toBe(200);
        const mismatch = {
          id: 'evt_mismatch',
          type: 'checkout.session.completed',
          created: 6_100,
          data: {
            object: {
              client_reference_id: alice.id,
              customer: 'cus_bob',
              subscription: 'sub_bob',
              metadata: { plan: 'starter', interval: 'monthly', user_id: alice.id },
            },
          },
        };
        const res = await postWebhook(app, mismatch);
        expect(res.statusCode).toBe(200);
        expect(res.json().ignored).toBe('user mismatch');
        const a = await db.query('SELECT plan, status FROM subscriptions WHERE user_id = $1', [alice.id]);
        const b = await db.query('SELECT plan, status FROM subscriptions WHERE user_id = $1', [bob.id]);
        expect(a.rows[0]).toMatchObject({ plan: 'starter', status: 'active' });
        expect(b.rows[0]).toMatchObject({ plan: 'pro', status: 'active' });
      },
      { config: billingOverrides() }
    );
  });

  it('ignores an unknown subscription event that has no user_id', async () => {
    await withApp(
      async ({ app, db }) => {
        const updated = {
          id: 'evt_no_user',
          type: 'customer.subscription.updated',
          created: 7_000,
          data: {
            object: {
              id: 'sub_dashboard',
              customer: 'cus_dashboard',
              status: 'active',
              metadata: { plan: 'starter' },
            },
          },
        };
        const res = await postWebhook(app, updated);
        expect(res.statusCode).toBe(200);
        expect(res.json().ignored).toBe('no user');
        const stored = await db.query('SELECT count(*)::int AS n FROM stripe_events WHERE event_id = $1', [
          'evt_no_user',
        ]);
        expect(stored.rows[0].n).toBe(1);
        const subs = await db.query('SELECT count(*)::int AS n FROM subscriptions');
        expect(subs.rows[0].n).toBe(0);
      },
      { config: billingOverrides() }
    );
  });
});

describe('billing hold on new sites', () => {
  it('does not schedule a site created after a past_due hold has started', async () => {
    const start = new Date('2026-02-01T00:00:00.000Z');
    let nowMs = start.getTime();
    const config = billingOverrides();
    config.now = () => nowMs;
    await withApp(
      async ({ app, db }) => {
        const user = await createUser(db, { email: 'holdcreate@example.com' });
        const checkout = {
          id: 'evt_hold_start',
          type: 'checkout.session.completed',
          created: Math.floor(nowMs / 1000),
          data: {
            object: {
              client_reference_id: user.id,
              customer: 'cus_hold',
              subscription: 'sub_hold',
              metadata: { plan: 'starter', interval: 'monthly' },
            },
          },
        };
        expect((await postWebhook(app, checkout, { signedAt: nowMs })).statusCode).toBe(200);
        const failed = {
          id: 'evt_hold_fail',
          type: 'invoice.payment_failed',
          created: Math.floor(nowMs / 1000) + 1,
          data: { object: { subscription: 'sub_hold', customer: 'cus_hold' } },
        };
        nowMs = start.getTime() + 1000;
        expect((await postWebhook(app, failed, { signedAt: nowMs })).statusCode).toBe(200);
        nowMs = start.getTime() + 1000 + 14 * 24 * 60 * 60 * 1000;
        await applyBillingHolds(db, new Date(nowMs));
        const created = await app.inject({
          method: 'POST',
          url: '/sites',
          headers: authHeader(user),
          payload: { name: 'during-hold', url: 'http://192.0.2.22/', interval_seconds: 300 },
        });
        expect(created.statusCode).toBe(200);
        nowMs = nowMs + 30 * 24 * 60 * 60 * 1000;
        await applyBillingHolds(db, new Date(nowMs));
        const due = await loadDueSites(db, 50, new Date(nowMs));
        expect(due.some((s) => s.user_id === user.id)).toBe(false);
      },
      { config }
    );
  });
});

describe('billing customer mismatch', () => {
  it('ignores a reactivation whose customer belongs to another account', async () => {
    await withApp(
      async ({ app, db }) => {
        const owner = await createUser(db, { email: 'cus-owner@example.com' });
        const legacy = await createUser(db, { email: 'cus-legacy@example.com' });
        const ownerCheckout = {
          id: 'evt_cus_owner',
          type: 'checkout.session.completed',
          created: 8_000,
          data: {
            object: {
              client_reference_id: owner.id,
              customer: 'cus_V',
              subscription: 'sub_owner_v',
              metadata: { plan: 'starter', interval: 'monthly' },
            },
          },
        };
        expect((await postWebhook(app, ownerCheckout)).statusCode).toBe(200);
        await db.query(
          `INSERT INTO subscriptions (user_id, plan, billing_interval, status, stripe_customer_id, stripe_subscription_id, last_stripe_event_at)
           VALUES ($1, 'starter', 'monthly', 'canceled', 'cus_legacy_self', 'sub_legacy_l2', NULL)`,
          [legacy.id]
        );
        const hijack = {
          id: 'evt_cus_hijack',
          type: 'checkout.session.completed',
          created: 8_100,
          data: {
            object: {
              client_reference_id: legacy.id,
              customer: 'cus_V',
              subscription: 'sub_legacy_new_v',
              metadata: { plan: 'starter', interval: 'monthly' },
            },
          },
        };
        const res = await postWebhook(app, hijack);
        expect(res.statusCode).toBe(200);
        expect(res.json().ignored).toBe('customer mismatch');
        const l2 = await db.query(
          'SELECT status, stripe_customer_id, stripe_subscription_id FROM subscriptions WHERE user_id = $1',
          [legacy.id]
        );
        expect(l2.rows[0]).toMatchObject({
          status: 'canceled',
          stripe_customer_id: 'cus_legacy_self',
          stripe_subscription_id: 'sub_legacy_l2',
        });
        const ownerRow = await db.query(
          'SELECT status, stripe_customer_id FROM subscriptions WHERE user_id = $1',
          [owner.id]
        );
        expect(ownerRow.rows[0]).toMatchObject({ status: 'active', stripe_customer_id: 'cus_V' });
      },
      { config: billingOverrides() }
    );
  });

  it('ignores a reactivation whose customer differs from the row even when it belongs to no other account', async () => {
    await withApp(
      async ({ app, db }) => {
        const user = await createUser(db, { email: 'cus-own@example.com' });
        await db.query(
          `INSERT INTO subscriptions (user_id, plan, billing_interval, status, stripe_customer_id, stripe_subscription_id, last_stripe_event_at)
           VALUES ($1, 'starter', 'monthly', 'canceled', 'cus_self_l3', 'sub_legacy_l3', NULL)`,
          [user.id]
        );
        const hijack = {
          id: 'evt_cus_own_diff',
          type: 'checkout.session.completed',
          created: 8_200,
          data: {
            object: {
              client_reference_id: user.id,
              customer: 'cus_brand_new',
              subscription: 'sub_legacy_new_l3',
              metadata: { plan: 'starter', interval: 'monthly' },
            },
          },
        };
        const res = await postWebhook(app, hijack);
        expect(res.statusCode).toBe(200);
        expect(res.json().ignored).toBe('customer mismatch');
        const row = await db.query(
          'SELECT status, stripe_customer_id, stripe_subscription_id FROM subscriptions WHERE user_id = $1',
          [user.id]
        );
        expect(row.rows[0]).toMatchObject({
          status: 'canceled',
          stripe_customer_id: 'cus_self_l3',
          stripe_subscription_id: 'sub_legacy_l3',
        });
      },
      { config: billingOverrides() }
    );
  });
});

describe('billing subscription attribution', () => {
  async function completeCheckout(app, user, { id, created, customer, subscription, plan = 'starter' }) {
    const event = {
      id,
      type: 'checkout.session.completed',
      created,
      data: {
        object: {
          mode: 'subscription',
          client_reference_id: user.id,
          customer,
          subscription,
          metadata: { plan, interval: 'monthly', user_id: user.id },
        },
      },
    };
    const res = await postWebhook(app, event);
    expect(res.statusCode).toBe(200);
    return res;
  }

  it('returns 409 from checkout when the account is already active or past_due', async () => {
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 'cs_409', url: 'https://checkout.example.invalid/c/cs_409' }),
    });
    await withApp(
      async ({ app, db }) => {
        const user = await createUser(db, { email: 'exists@example.com' });
        const first = await app.inject({
          method: 'POST',
          url: '/billing/checkout',
          headers: authHeader(user),
          payload: { plan: 'starter', interval: 'monthly' },
        });
        expect(first.statusCode).toBe(200);
        await completeCheckout(app, user, {
          id: 'evt_409_start',
          created: 9_000,
          customer: 'cus_409',
          subscription: 'sub_409',
        });
        const again = await app.inject({
          method: 'POST',
          url: '/billing/checkout',
          headers: authHeader(user),
          payload: { plan: 'pro', interval: 'monthly' },
        });
        expect(again.statusCode).toBe(409);
        expect(again.json().code).toBe('SUBSCRIPTION_EXISTS');

        await db.query(`UPDATE subscriptions SET status = 'past_due' WHERE user_id = $1`, [user.id]);
        const pastDue = await app.inject({
          method: 'POST',
          url: '/billing/checkout',
          headers: authHeader(user),
          payload: { plan: 'starter', interval: 'monthly' },
        });
        expect(pastDue.statusCode).toBe(409);
      },
      { config: billingOverrides(), fetchFn }
    );
  });

  it('keeps sub_Y active when a later deleted event arrives for earlier sub_X', async () => {
    await withApp(
      async ({ app, db }) => {
        const user = await createUser(db, { email: 'twosub@example.com' });
        await completeCheckout(app, user, {
          id: 'evt_sub_x',
          created: 10_000,
          customer: 'cus_xy',
          subscription: 'sub_X',
        });
        await db.query(`UPDATE subscriptions SET stripe_subscription_id = 'sub_Y' WHERE user_id = $1`, [user.id]);
        const current = await db.query(
          'SELECT stripe_subscription_id, status FROM subscriptions WHERE user_id = $1',
          [user.id]
        );
        expect(current.rows[0]).toMatchObject({ stripe_subscription_id: 'sub_Y', status: 'active' });

        const deletedX = {
          id: 'evt_del_x',
          type: 'customer.subscription.deleted',
          created: 10_200,
          data: {
            object: {
              id: 'sub_X',
              customer: 'cus_xy',
              metadata: { user_id: user.id },
            },
          },
        };
        const res = await postWebhook(app, deletedX);
        expect(res.statusCode).toBe(200);
        expect(res.json().ignored).toBe('other subscription');
        const after = await db.query(
          'SELECT stripe_subscription_id, status FROM subscriptions WHERE user_id = $1',
          [user.id]
        );
        expect(after.rows[0]).toMatchObject({ stripe_subscription_id: 'sub_Y', status: 'active' });
        const tier = await db.query('SELECT tier FROM users WHERE id = $1', [user.id]);
        expect(tier.rows[0].tier).toBe('starter');
      },
      { config: billingOverrides() }
    );
  });

  it('does not start grace or a hold when a failed invoice arrives for earlier sub_P after sub_Q is current', async () => {
    await withApp(
      async ({ app, db }) => {
        const user = await createUser(db, { email: 'pq@example.com' });
        await completeCheckout(app, user, {
          id: 'evt_sub_p',
          created: 11_000,
          customer: 'cus_pq',
          subscription: 'sub_P',
        });
        await db.query(`UPDATE subscriptions SET stripe_subscription_id = 'sub_Q' WHERE user_id = $1`, [user.id]);
        const failedP = {
          id: 'evt_fail_p',
          type: 'invoice.payment_failed',
          created: 11_200,
          data: {
            object: {
              subscription: 'sub_P',
              customer: 'cus_pq',
              metadata: { user_id: user.id },
            },
          },
        };
        const res = await postWebhook(app, failedP);
        expect(res.statusCode).toBe(200);
        expect(res.json().ignored).toBe('other subscription');
        const row = await db.query(
          'SELECT stripe_subscription_id, status, grace_ends_at FROM subscriptions WHERE user_id = $1',
          [user.id]
        );
        expect(row.rows[0]).toMatchObject({ stripe_subscription_id: 'sub_Q', status: 'active' });
        expect(row.rows[0].grace_ends_at).toBeNull();
      },
      { config: billingOverrides() }
    );
  });

  it('ignores a dashboard subscription event that only shares the account user_id', async () => {
    await withApp(
      async ({ app, db }) => {
        const user = await createUser(db, { email: 'dash3@example.com' });
        await completeCheckout(app, user, {
          id: 'evt_sub_a',
          created: 12_000,
          customer: 'cus_a',
          subscription: 'sub_A',
          plan: 'pro',
        });
        const dash = {
          id: 'evt_dash3',
          type: 'customer.subscription.updated',
          created: 12_100,
          data: {
            object: {
              id: 'sub_dash3',
              customer: 'cus_dash3',
              status: 'canceled',
              metadata: { user_id: user.id },
            },
          },
        };
        const res = await postWebhook(app, dash);
        expect(res.statusCode).toBe(200);
        expect(res.json().ignored).toBe('other subscription');
        const row = await db.query(
          'SELECT stripe_subscription_id, status FROM subscriptions WHERE user_id = $1',
          [user.id]
        );
        expect(row.rows[0]).toMatchObject({ stripe_subscription_id: 'sub_A', status: 'active' });
        const tier = await db.query('SELECT tier FROM users WHERE id = $1', [user.id]);
        expect(tier.rows[0].tier).toBe('pro');
      },
      { config: billingOverrides() }
    );
  });

  it('allows checkout and a new subscription after cancel', async () => {
    const calls = [];
    const fetchFn = async (url, opts) => {
      calls.push(opts.headers);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 'cs_resub', url: 'https://checkout.example.invalid/c/cs_resub' }),
      };
    };
    await withApp(
      async ({ app, db }) => {
        const user = await createUser(db, { email: 'resub@example.com' });
        await completeCheckout(app, user, {
          id: 'evt_resub_first',
          created: 13_000,
          customer: 'cus_resub',
          subscription: 'sub_old',
        });
        const deleted = {
          id: 'evt_resub_del',
          type: 'customer.subscription.deleted',
          created: 13_100,
          data: {
            object: { id: 'sub_old', customer: 'cus_resub', metadata: { user_id: user.id } },
          },
        };
        expect((await postWebhook(app, deleted)).statusCode).toBe(200);
        const canceled = await db.query('SELECT status FROM subscriptions WHERE user_id = $1', [user.id]);
        expect(canceled.rows[0].status).toBe('canceled');

        const checkout = await app.inject({
          method: 'POST',
          url: '/billing/checkout',
          headers: authHeader(user),
          payload: { plan: 'starter', interval: 'monthly' },
        });
        expect(checkout.statusCode).toBe(200);
        expect(calls.length).toBe(1);

        const applied = await completeCheckout(app, user, {
          id: 'evt_resub_new',
          created: 13_200,
          customer: 'cus_resub',
          subscription: 'sub_new',
        });
        expect(applied.json().applied).toBe('checkout');
        const row = await db.query(
          'SELECT stripe_subscription_id, status FROM subscriptions WHERE user_id = $1',
          [user.id]
        );
        expect(row.rows[0]).toMatchObject({ stripe_subscription_id: 'sub_new', status: 'active' });
        const tier = await db.query('SELECT tier FROM users WHERE id = $1', [user.id]);
        expect(tier.rows[0].tier).toBe('starter');
      },
      { config: billingOverrides(), fetchFn }
    );
  });

  function basilInvoiceObject({ subscription, customer, expanded = false, oneOff = false, userId }) {
    const object = { customer };
    if (userId) object.metadata = { user_id: userId };
    if (oneOff) {
      object.parent = { type: 'quote_details' };
      return object;
    }
    const sub = expanded ? { id: subscription, object: 'subscription' } : subscription;
    object.parent = { type: 'subscription_details', subscription_details: { subscription: sub } };
    return object;
  }

  it('ignores a basil-shaped failed invoice for earlier sub_P after sub_Q is current, as a string or an expanded object', async () => {
    await withApp(
      async ({ app, db }) => {
        const user = await createUser(db, { email: 'basil-pq@example.com' });
        await completeCheckout(app, user, {
          id: 'evt_basil_p',
          created: 14_000,
          customer: 'cus_basil_pq',
          subscription: 'sub_P',
        });
        await db.query(`UPDATE subscriptions SET stripe_subscription_id = 'sub_Q' WHERE user_id = $1`, [user.id]);

        const stringShape = {
          id: 'evt_basil_fail_p_str',
          type: 'invoice.payment_failed',
          created: 14_100,
          data: { object: basilInvoiceObject({ subscription: 'sub_P', customer: 'cus_basil_pq', userId: user.id }) },
        };
        const stringRes = await postWebhook(app, stringShape);
        expect(stringRes.statusCode).toBe(200);
        expect(stringRes.json().ignored).toBe('other subscription');

        const expanded = {
          id: 'evt_basil_fail_p_obj',
          type: 'invoice.payment_failed',
          created: 14_200,
          data: {
            object: basilInvoiceObject({
              subscription: 'sub_P',
              customer: 'cus_basil_pq',
              expanded: true,
              userId: user.id,
            }),
          },
        };
        const expRes = await postWebhook(app, expanded);
        expect(expRes.statusCode).toBe(200);
        expect(expRes.json().ignored).toBe('other subscription');
        const row = await db.query(
          'SELECT stripe_subscription_id, status, grace_ends_at FROM subscriptions WHERE user_id = $1',
          [user.id]
        );
        expect(row.rows[0]).toMatchObject({ stripe_subscription_id: 'sub_Q', status: 'active' });
        expect(row.rows[0].grace_ends_at).toBeNull();
      },
      { config: billingOverrides() }
    );
  });

  it('does not let invoice.paid reactivate a canceled account, including basil and one-off invoices', async () => {
    await withApp(
      async ({ app, db }) => {
        const user = await createUser(db, { email: 'inv-cancel@example.com' });
        await completeCheckout(app, user, {
          id: 'evt_invc_start',
          created: 15_000,
          customer: 'cus_invc',
          subscription: 'sub_C',
        });
        const deleted = {
          id: 'evt_invc_del',
          type: 'customer.subscription.deleted',
          created: 15_100,
          data: { object: { id: 'sub_C', customer: 'cus_invc', metadata: { user_id: user.id } } },
        };
        expect((await postWebhook(app, deleted)).statusCode).toBe(200);
        const canceled = await db.query(
          'SELECT status, stripe_subscription_id FROM subscriptions WHERE user_id = $1',
          [user.id]
        );
        expect(canceled.rows[0]).toMatchObject({ status: 'canceled', stripe_subscription_id: 'sub_C' });
        const tierAfterCancel = await db.query('SELECT tier FROM users WHERE id = $1', [user.id]);
        expect(tierAfterCancel.rows[0].tier).toBe('no_plan');

        const paidSame = {
          id: 'evt_invc_paid_c',
          type: 'invoice.paid',
          created: 15_200,
          data: { object: basilInvoiceObject({ subscription: 'sub_C', customer: 'cus_invc', userId: user.id }) },
        };
        const paidRes = await postWebhook(app, paidSame);
        expect(paidRes.statusCode).toBe(200);
        expect(paidRes.json().ignored).toBe('not open');

        const oneOff = {
          id: 'evt_invc_paid_oneoff',
          type: 'invoice.paid',
          created: 15_300,
          data: { object: basilInvoiceObject({ oneOff: true, customer: 'cus_invc', userId: user.id }) },
        };
        const oneOffRes = await postWebhook(app, oneOff);
        expect(oneOffRes.statusCode).toBe(200);
        expect(oneOffRes.json().ignored).toBe('no subscription');

        const row = await db.query(
          'SELECT status, stripe_subscription_id FROM subscriptions WHERE user_id = $1',
          [user.id]
        );
        expect(row.rows[0]).toMatchObject({ status: 'canceled', stripe_subscription_id: 'sub_C' });
        const tier = await db.query('SELECT tier FROM users WHERE id = $1', [user.id]);
        expect(tier.rows[0].tier).toBe('no_plan');
      },
      { config: billingOverrides() }
    );
  });

  it('does not reopen a canceled account via payment_failed then invoice.paid, in basil or legacy shape', async () => {
    await withApp(
      async ({ app, db }) => {
        for (const [label, failedObj, paidObj] of [
          [
            'basil',
            (user, sub, cus) => basilInvoiceObject({ subscription: sub, customer: cus, userId: user.id }),
            (user, sub, cus) => basilInvoiceObject({ subscription: sub, customer: cus, userId: user.id, expanded: true }),
          ],
          [
            'legacy',
            (user, sub, cus) => ({ subscription: sub, customer: cus, metadata: { user_id: user.id } }),
            (user, sub, cus) => ({ subscription: sub, customer: cus, metadata: { user_id: user.id } }),
          ],
        ]) {
          const user = await createUser(db, { email: `reopen-${label}@example.com` });
          const sub = `sub_C_${label}`;
          const cus = `cus_reopen_${label}`;
          await completeCheckout(app, user, {
            id: `evt_reopen_${label}_start`,
            created: 21_000,
            customer: cus,
            subscription: sub,
          });
          const deleted = {
            id: `evt_reopen_${label}_del`,
            type: 'customer.subscription.deleted',
            created: 21_100,
            data: { object: { id: sub, customer: cus, metadata: { user_id: user.id } } },
          };
          expect((await postWebhook(app, deleted)).statusCode).toBe(200);
          const failed = {
            id: `evt_reopen_${label}_fail`,
            type: 'invoice.payment_failed',
            created: 21_200,
            data: { object: failedObj(user, sub, cus) },
          };
          const failedRes = await postWebhook(app, failed);
          expect(failedRes.statusCode).toBe(200);
          expect(failedRes.json().ignored).toBe('not open');
          const paid = {
            id: `evt_reopen_${label}_paid`,
            type: 'invoice.paid',
            created: 21_300,
            data: { object: paidObj(user, sub, cus) },
          };
          const paidRes = await postWebhook(app, paid);
          expect(paidRes.statusCode).toBe(200);
          expect(paidRes.json().ignored).toBe('not open');
          const row = await db.query(
            'SELECT status, grace_ends_at FROM subscriptions WHERE user_id = $1',
            [user.id]
          );
          expect(row.rows[0].status).toBe('canceled');
          expect(row.rows[0].grace_ends_at).toBeNull();
          const tier = await db.query('SELECT tier FROM users WHERE id = $1', [user.id]);
          expect(tier.rows[0].tier).toBe('no_plan');
        }
      },
      { config: billingOverrides() }
    );
  });

  it('does not reopen a canceled account via subscription.updated with status active', async () => {
    await withApp(
      async ({ app, db }) => {
        const user = await createUser(db, { email: 'upd-active@example.com' });
        await completeCheckout(app, user, {
          id: 'evt_updact_start',
          created: 22_000,
          customer: 'cus_updact',
          subscription: 'sub_C',
        });
        const deleted = {
          id: 'evt_updact_del',
          type: 'customer.subscription.deleted',
          created: 22_100,
          data: { object: { id: 'sub_C', customer: 'cus_updact', metadata: { user_id: user.id } } },
        };
        expect((await postWebhook(app, deleted)).statusCode).toBe(200);
        const updated = {
          id: 'evt_updact_active',
          type: 'customer.subscription.updated',
          created: 22_200,
          data: {
            object: {
              id: 'sub_C',
              customer: 'cus_updact',
              status: 'active',
              metadata: { user_id: user.id },
            },
          },
        };
        const res = await postWebhook(app, updated);
        expect(res.statusCode).toBe(200);
        expect(res.json().ignored).toBe('not open');
        const row = await db.query('SELECT status FROM subscriptions WHERE user_id = $1', [user.id]);
        expect(row.rows[0].status).toBe('canceled');
        const tier = await db.query('SELECT tier FROM users WHERE id = $1', [user.id]);
        expect(tier.rows[0].tier).toBe('no_plan');
      },
      { config: billingOverrides() }
    );
  });

  it('ignores an invoice whose parent type is not subscription_details even if subscription details are present', async () => {
    await withApp(
      async ({ app, db }) => {
        const user = await createUser(db, { email: 'quote-parent@example.com' });
        await completeCheckout(app, user, {
          id: 'evt_quote_start',
          created: 23_000,
          customer: 'cus_quote',
          subscription: 'sub_Q',
        });
        const failed = {
          id: 'evt_quote_fail',
          type: 'invoice.payment_failed',
          created: 23_100,
          data: {
            object: {
              customer: 'cus_quote',
              metadata: { user_id: user.id },
              parent: {
                type: 'quote_details',
                subscription_details: { subscription: 'sub_Q' },
              },
            },
          },
        };
        const res = await postWebhook(app, failed);
        expect(res.statusCode).toBe(200);
        expect(res.json().ignored).toBe('no subscription');
        const row = await db.query(
          'SELECT status, grace_ends_at FROM subscriptions WHERE user_id = $1',
          [user.id]
        );
        expect(row.rows[0]).toMatchObject({ status: 'active' });
        expect(row.rows[0].grace_ends_at).toBeNull();
      },
      { config: billingOverrides() }
    );
  });

  it('serialises concurrent checkout completions for the same account so only one subscription is applied', async () => {
    await withApp(
      async ({ app, db }) => {
        const user = await createUser(db, { email: 'lock-co@example.com' });
        const a = {
          id: 'evt_lock_n1',
          type: 'checkout.session.completed',
          created: 24_000,
          data: {
            object: {
              mode: 'subscription',
              client_reference_id: user.id,
              customer: 'cus_lock',
              subscription: 'sub_N1',
              metadata: { plan: 'starter', interval: 'monthly', user_id: user.id },
            },
          },
        };
        const b = {
          id: 'evt_lock_n2',
          type: 'checkout.session.completed',
          created: 24_000,
          data: {
            object: {
              mode: 'subscription',
              client_reference_id: user.id,
              customer: 'cus_lock',
              subscription: 'sub_N2',
              metadata: { plan: 'starter', interval: 'monthly', user_id: user.id },
            },
          },
        };
        const [first, second] = await Promise.all([postWebhook(app, a), postWebhook(app, b)]);
        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(200);
        const outcomes = [first.json(), second.json()];
        const applied = outcomes.filter((r) => r.applied === 'checkout');
        const ignored = outcomes.filter((r) => r.ignored === 'duplicate subscription');
        expect(applied).toHaveLength(1);
        expect(ignored).toHaveLength(1);
        const row = await db.query(
          'SELECT stripe_subscription_id, status FROM subscriptions WHERE user_id = $1',
          [user.id]
        );
        expect(row.rows[0].status).toBe('active');
        expect(['sub_N1', 'sub_N2']).toContain(row.rows[0].stripe_subscription_id);
      },
      { config: billingOverrides() }
    );
  });

  it('ignores a subscription.updated event with a null id', async () => {
    await withApp(
      async ({ app, db }) => {
        const user = await createUser(db, { email: 'null-id@example.com' });
        await completeCheckout(app, user, {
          id: 'evt_nullid_start',
          created: 16_000,
          customer: 'cus_nullid',
          subscription: 'sub_A',
          plan: 'pro',
        });
        const updated = {
          id: 'evt_nullid_updated',
          type: 'customer.subscription.updated',
          created: 16_100,
          data: {
            object: {
              id: null,
              customer: 'cus_nullid',
              status: 'canceled',
              metadata: { user_id: user.id },
            },
          },
        };
        const res = await postWebhook(app, updated);
        expect(res.statusCode).toBe(200);
        expect(res.json().ignored).toBe('no subscription');
        const row = await db.query(
          'SELECT stripe_subscription_id, status FROM subscriptions WHERE user_id = $1',
          [user.id]
        );
        expect(row.rows[0]).toMatchObject({ stripe_subscription_id: 'sub_A', status: 'active' });
        const tier = await db.query('SELECT tier FROM users WHERE id = $1', [user.id]);
        expect(tier.rows[0].tier).toBe('pro');
      },
      { config: billingOverrides() }
    );
  });

  it('ignores a second completed checkout for a different subscription while the account is already active', async () => {
    const warnings = [];
    await withApp(
      async ({ app, db }) => {
        const user = await createUser(db, { email: 'dup-sub@example.com' });
        await completeCheckout(app, user, {
          id: 'evt_dup_n1',
          created: 17_000,
          customer: 'cus_dup',
          subscription: 'sub_N1',
        });
        const second = await completeCheckout(app, user, {
          id: 'evt_dup_n2',
          created: 17_100,
          customer: 'cus_dup',
          subscription: 'sub_N2',
        });
        expect(second.json().ignored).toBe('duplicate subscription');
        expect(warnings.some((w) => w.msg === 'checkout named a different subscription than the current one')).toBe(
          true
        );
        const row = await db.query(
          'SELECT stripe_subscription_id, status FROM subscriptions WHERE user_id = $1',
          [user.id]
        );
        expect(row.rows[0]).toMatchObject({ stripe_subscription_id: 'sub_N1', status: 'active' });
      },
      { config: { ...billingOverrides(), log: { warn: (fields, msg) => warnings.push({ fields, msg }) } } }
    );
  });

  it('ignores checkout.session.completed unless mode is subscription and a subscription id is set', async () => {
    await withApp(
      async ({ app, db }) => {
        const user = await createUser(db, { email: 'mode@example.com' });
        const paymentMode = {
          id: 'evt_mode_payment',
          type: 'checkout.session.completed',
          created: 18_000,
          data: {
            object: {
              mode: 'payment',
              client_reference_id: user.id,
              customer: 'cus_mode',
              subscription: 'sub_mode',
              metadata: { plan: 'starter', interval: 'monthly' },
            },
          },
        };
        const paymentRes = await postWebhook(app, paymentMode);
        expect(paymentRes.statusCode).toBe(200);
        expect(paymentRes.json().ignored).toBe('not a subscription checkout');

        const noSub = {
          id: 'evt_mode_nosub',
          type: 'checkout.session.completed',
          created: 18_100,
          data: {
            object: {
              mode: 'subscription',
              client_reference_id: user.id,
              customer: 'cus_mode',
              metadata: { plan: 'starter', interval: 'monthly' },
            },
          },
        };
        const noSubRes = await postWebhook(app, noSub);
        expect(noSubRes.statusCode).toBe(200);
        expect(noSubRes.json().ignored).toBe('not a subscription checkout');
        const rows = await db.query('SELECT count(*)::int AS n FROM subscriptions WHERE user_id = $1', [user.id]);
        expect(rows.rows[0].n).toBe(0);
      },
      { config: billingOverrides() }
    );
  });

  it('ignores a subscription event whose claimed user does not match the row for that subscription id', async () => {
    await withApp(
      async ({ app, db }) => {
        const alice = await createUser(db, { email: 'alice-sub@example.com' });
        const bob = await createUser(db, { email: 'bob-sub@example.com' });
        await completeCheckout(app, alice, {
          id: 'evt_alice_sub',
          created: 19_000,
          customer: 'cus_alice_sub',
          subscription: 'sub_A',
          plan: 'pro',
        });
        const updated = {
          id: 'evt_bob_claims_a',
          type: 'customer.subscription.updated',
          created: 19_100,
          data: {
            object: {
              id: 'sub_A',
              customer: 'cus_alice_sub',
              status: 'canceled',
              metadata: { user_id: bob.id },
            },
          },
        };
        const res = await postWebhook(app, updated);
        expect(res.statusCode).toBe(200);
        expect(res.json().ignored).toBe('user mismatch');
        const row = await db.query(
          'SELECT stripe_subscription_id, status FROM subscriptions WHERE user_id = $1',
          [alice.id]
        );
        expect(row.rows[0]).toMatchObject({ stripe_subscription_id: 'sub_A', status: 'active' });
        const tier = await db.query('SELECT tier FROM users WHERE id = $1', [alice.id]);
        expect(tier.rows[0].tier).toBe('pro');
        const bobRows = await db.query('SELECT count(*)::int AS n FROM subscriptions WHERE user_id = $1', [bob.id]);
        expect(bobRows.rows[0].n).toBe(0);
      },
      { config: billingOverrides() }
    );
  });

  it('logs a warning when event.api_version is missing or is not the pinned webhook version', async () => {
    const warnings = [];
    await withApp(
      async ({ app, db }) => {
        const user = await createUser(db, { email: 'apiver@example.com' });
        const checkout = {
          id: 'evt_apiver_ok',
          type: 'checkout.session.completed',
          created: 20_000,
          data: {
            object: {
              mode: 'subscription',
              client_reference_id: user.id,
              customer: 'cus_apiver',
              subscription: 'sub_apiver',
              metadata: { plan: 'starter', interval: 'monthly' },
            },
          },
        };
        expect((await postWebhook(app, checkout)).statusCode).toBe(200);
        expect(warnings).toHaveLength(0);

        const otherVersion = {
          id: 'evt_apiver_other',
          type: 'customer.subscription.updated',
          created: 20_100,
          api_version: '2019-09-09',
          data: {
            object: { id: 'sub_apiver', customer: 'cus_apiver', status: 'active', metadata: { user_id: user.id } },
          },
        };
        expect((await postWebhook(app, otherVersion)).statusCode).toBe(200);
        expect(
          warnings.some(
            (w) =>
              w.msg === 'untested stripe event api_version' &&
              w.fields.apiVersion === '2019-09-09' &&
              w.fields.expected === STRIPE_WEBHOOK_API_VERSION
          )
        ).toBe(true);

        const missing = {
          id: 'evt_apiver_missing',
          type: 'customer.subscription.updated',
          created: 20_200,
          data: {
            object: { id: 'sub_apiver', customer: 'cus_apiver', status: 'active', metadata: { user_id: user.id } },
          },
        };
        expect((await postWebhook(app, missing, { omitApiVersion: true })).statusCode).toBe(200);
        expect(
          warnings.some(
            (w) =>
              w.msg === 'untested stripe event api_version' &&
              w.fields.apiVersion == null &&
              w.fields.eventId === 'evt_apiver_missing'
          )
        ).toBe(true);
      },
      { config: { ...billingOverrides(), log: { warn: (fields, msg) => warnings.push({ fields, msg }) } } }
    );
  });
});

describe('billing holds in the scheduler', () => {
  it('does not check a site on billing hold during a scheduler tick', async () => {
    const db = await getDb();
    await resetData(db);
    const user = await createUser(db, { email: 'tick@example.com' });
    await db.query(
      `INSERT INTO sites (user_id, name, url, interval_seconds, last_checked_at, billing_hold)
       VALUES ($1, 'PausedBill', 'http://192.0.2.12/', 300, now() - interval '10 minutes', true)`,
      [user.id]
    );
    const out = await runSchedulerTick({
      db,
      mailer: createMailer(testConfig()),
      config: testConfig({ heartbeatUrl: '' }),
    });
    expect(out.checked).toBe(0);
  });
});
