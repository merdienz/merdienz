function livePrefix(kind) {
  return `${kind}_live_`;
}

function testPrefix(kind) {
  return `${kind}_test_`;
}

const LIVE_PREFIXES = ['sk', 'rk', 'pk'].map(livePrefix);
const SECRET_TEST_PREFIXES = ['sk', 'rk'].map(testPrefix);

export function isLiveStripeKey(value) {
  const s = String(value || '');
  return LIVE_PREFIXES.some((p) => s.startsWith(p));
}

export function isAllowedStripeSecretKey(value) {
  const s = String(value || '');
  return SECRET_TEST_PREFIXES.some((p) => s.startsWith(p));
}

export function assertStripeSecretKeyAllowed(value, label) {
  if (!value) return;
  if (!isAllowedStripeSecretKey(value)) {
    throw new Error(`${label} must be a Stripe TEST secret key`);
  }
}

export function assertNotLiveStripeKey(value, label) {
  if (!value) return;
  if (isLiveStripeKey(value)) {
    throw new Error(`${label} looks like a live Stripe key`);
  }
}
