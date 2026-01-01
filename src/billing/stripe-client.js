import { randomUUID } from 'node:crypto';
import { redactSecret } from '../alerts/smtp-config.js';
import { priceIdFor } from './plans.js';
import { CHECKOUT_SESSION_TTL_SEC, STRIPE_FETCH_TIMEOUT_MS } from './config.js';

const DEFAULT_API_BASE = 'https://api.stripe.com';

function encodeForm(fields, prefix = '') {
  const params = new URLSearchParams();
  function walk(value, key) {
    if (value == null) return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${key}[${i}]`));
      return;
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, key ? `${key}[${k}]` : k);
      return;
    }
    params.append(key, String(value));
  }
  walk(fields, prefix);
  return params;
}

export async function stripeFormRequest({
  secretKey,
  method = 'POST',
  path,
  form,
  headers = {},
  fetchFn = fetch,
  apiBase = DEFAULT_API_BASE,
  timeoutMs = STRIPE_FETCH_TIMEOUT_MS,
}) {
  if (!secretKey) {
    const err = new Error('billing is not configured');
    err.statusCode = 503;
    err.code = 'BILLING_DISABLED';
    throw err;
  }
  const url = `${String(apiBase).replace(/\/$/, '')}${path}`;
  const body = form ? encodeForm(form).toString() : undefined;
  const reqHeaders = {
    authorization: `Bearer ${secretKey}`,
    'content-type': 'application/x-www-form-urlencoded',
    ...headers,
  };
  let res;
  try {
    const opts = { method, headers: reqHeaders, body };
    if (timeoutMs > 0 && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      opts.signal = AbortSignal.timeout(timeoutMs);
    }
    res = await fetchFn(url, opts);
  } catch (err) {
    const wrapped = new Error(redactSecret(err && err.message, secretKey) || 'stripe request failed');
    wrapped.statusCode = 502;
    wrapped.code = 'STRIPE_REQUEST';
    throw wrapped;
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: { message: 'invalid stripe response' } };
  }
  if (!res.ok) {
    const msg = redactSecret(json?.error?.message || `stripe http ${res.status}`, secretKey);
    const err = new Error(msg);
    err.statusCode = 502;
    err.code = 'STRIPE_REQUEST';
    throw err;
  }
  return json;
}

export async function createCheckoutSession(config, { userId, email, plan, interval, customerId, fetchFn, idempotencyKey }) {
  const price = priceIdFor(config, plan, interval);
  const publicUrl = String(config.publicUrl || '').replace(/\/$/, '');
  if (!publicUrl) {
    const err = new Error('PUBLIC_URL is required for checkout');
    err.statusCode = 503;
    err.code = 'BILLING_DISABLED';
    throw err;
  }
  const nowMs = typeof config.now === 'function' ? Number(config.now()) : Date.now();
  const form = {
    mode: 'subscription',
    client_reference_id: userId,
    success_url: `${publicUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${publicUrl}/billing/cancel`,
    line_items: [{ price, quantity: 1 }],
    metadata: { user_id: userId, plan, interval },
    subscription_data: { metadata: { user_id: userId, plan, interval } },
    expires_at: Math.floor(nowMs / 1000) + CHECKOUT_SESSION_TTL_SEC,
  };
  if (customerId) form.customer = customerId;
  else if (email) form.customer_email = email;
  return stripeFormRequest({
    secretKey: config.stripe.secretKey,
    path: '/v1/checkout/sessions',
    form,
    headers: { 'Idempotency-Key': idempotencyKey || `checkout:${userId}:${plan}:${interval}:${randomUUID()}` },
    fetchFn: fetchFn || config.fetchFn || fetch,
    apiBase: config.stripe.apiBase,
    timeoutMs: config.stripe.fetchTimeoutMs || STRIPE_FETCH_TIMEOUT_MS,
  });
}
