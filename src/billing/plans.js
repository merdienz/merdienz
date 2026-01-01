export const BILLING_CATALOG = {
  starter: {
    monthly: { amount: '4.99', label: 'Starter monthly' },
    yearly: { amount: '49.90', label: 'Starter yearly' },
  },
  pro: {
    monthly: { amount: '19.99', label: 'Pro monthly' },
    yearly: { amount: '199', label: 'Pro yearly' },
  },
};

export const BILLING_PLANS = new Set(['starter', 'pro']);
export const BILLING_INTERVALS = new Set(['monthly', 'yearly']);
// 14 days from the first failed payment. Later failures in the same unpaid period do not extend it.
export const GRACE_DAYS = 14;

export function assertPlanAndInterval(plan, interval) {
  const p = String(plan || '').toLowerCase();
  const i = String(interval || '').toLowerCase();
  if (!BILLING_PLANS.has(p) || !BILLING_INTERVALS.has(i)) {
    const err = new Error('plan must be starter or pro, and interval must be monthly or yearly');
    err.statusCode = 400;
    err.code = 'BAD_PLAN';
    throw err;
  }
  return { plan: p, interval: i };
}

export function priceIdFor(config, plan, interval) {
  const { plan: p, interval: i } = assertPlanAndInterval(plan, interval);
  const key = `${p}_${i}`;
  const id = config?.stripe?.prices?.[key];
  if (!id) {
    const err = new Error('billing is not configured');
    err.statusCode = 503;
    err.code = 'BILLING_DISABLED';
    throw err;
  }
  return id;
}

export function planFromPriceId(config, priceId) {
  const prices = config?.stripe?.prices || {};
  for (const [key, id] of Object.entries(prices)) {
    if (id && id === priceId) {
      const [plan, interval] = key.split('_');
      if (BILLING_PLANS.has(plan) && BILLING_INTERVALS.has(interval)) {
        return { plan, interval };
      }
    }
  }
  return null;
}
