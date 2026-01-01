export function parsePort(raw, fallback = 4840) {
  const s = raw === undefined || raw === null || raw === '' ? String(fallback) : String(raw);
  if (!/^[1-9]\d{0,4}$/.test(s)) {
    const err = new Error('PORT must be an integer from 1 to 65535');
    err.code = 'BAD_PORT';
    throw err;
  }
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    const err = new Error('PORT must be an integer from 1 to 65535');
    err.code = 'BAD_PORT';
    throw err;
  }
  return n;
}

export function parseSkewSec(raw, fallback = 60) {
  const s = raw === undefined || raw === null || raw === '' ? String(fallback) : String(raw);
  if (!/^[1-9]\d{0,2}$/.test(s)) {
    const err = new Error('PROBE_B_MAX_SKEW_SEC must be an integer from 1 to 300');
    err.code = 'BAD_SKEW';
    throw err;
  }
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > 300) {
    const err = new Error('PROBE_B_MAX_SKEW_SEC must be an integer from 1 to 300');
    err.code = 'BAD_SKEW';
    throw err;
  }
  return n;
}

export function allowsEmbeddedPostgres({ nodeEnv, merdienzMode } = {}) {
  const mode = String(merdienzMode || '').toLowerCase();
  if (mode !== 'dev' && mode !== 'test') return false;
  const env = String(nodeEnv ?? '').toLowerCase();
  if (env === 'production') return false;
  return true;
}
