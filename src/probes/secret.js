// Prefer PROBE_B_SECRET. PROBE_B_HMAC_SECRET is accepted as a fallback so
// existing probe-B env files keep working. If both are set they must match.
export function resolveProbeBSecret(env = process.env) {
  const primary = String(env.PROBE_B_SECRET || '').trim();
  const fallback = String(env.PROBE_B_HMAC_SECRET || '').trim();
  if (primary && fallback && primary !== fallback) {
    const err = new Error(
      'PROBE_B_SECRET and PROBE_B_HMAC_SECRET are both set and do not match'
    );
    err.code = 'PROBE_B_SECRET_CONFLICT';
    throw err;
  }
  return primary || fallback;
}
