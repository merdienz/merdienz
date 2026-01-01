import { createHmac, timingSafeEqual } from 'node:crypto';

export const STRIPE_SIGNATURE_TOLERANCE_SEC = 300;

export function verifyStripeSignature(rawBody, header, secret, { now = Date.now(), toleranceSec = STRIPE_SIGNATURE_TOLERANCE_SEC } = {}) {
  if (!secret) {
    const err = new Error('billing is not configured');
    err.statusCode = 503;
    err.code = 'BILLING_DISABLED';
    throw err;
  }
  if (!header) {
    const err = new Error('missing stripe signature');
    err.statusCode = 400;
    err.code = 'STRIPE_SIGNATURE';
    throw err;
  }
  let timestamp = '';
  const signatures = [];
  for (const part of String(header).split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't') timestamp = v;
    if (k === 'v1') signatures.push(v);
  }
  if (!timestamp || signatures.length === 0) {
    const err = new Error('invalid stripe signature');
    err.statusCode = 400;
    err.code = 'STRIPE_SIGNATURE';
    throw err;
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    const err = new Error('invalid stripe signature');
    err.statusCode = 400;
    err.code = 'STRIPE_SIGNATURE';
    throw err;
  }
  const ageSec = Math.abs(Number(now) / 1000 - ts);
  if (ageSec > toleranceSec) {
    const err = new Error('stale stripe signature');
    err.statusCode = 400;
    err.code = 'STRIPE_SIGNATURE_STALE';
    throw err;
  }
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  let match = false;
  for (const sig of signatures) {
    try {
      const got = Buffer.from(sig, 'hex');
      if (got.length === expectedBuf.length && timingSafeEqual(got, expectedBuf)) {
        match = true;
      }
    } catch {
      // skip a malformed signature item
    }
  }
  if (!match) {
    const err = new Error('invalid stripe signature');
    err.statusCode = 400;
    err.code = 'STRIPE_SIGNATURE';
    throw err;
  }
  return { timestamp: ts };
}
