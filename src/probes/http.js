import { createSafeFetch } from './safe-fetch.js';
import { resolvePublicAddresses } from './ssrf.js';

export function isUpStatus(status, spec = '2xx,3xx') {
  if (!Number.isInteger(status)) return false;
  const parts = String(spec || '2xx,3xx')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.some((part) => {
    if (/^\dxx$/i.test(part)) {
      const hundreds = Number(part[0]);
      return status >= hundreds * 100 && status < hundreds * 100 + 100;
    }
    if (part.includes('-')) {
      const [from, to] = part.split('-').map(Number);
      return status >= from && status <= to;
    }
    return status === Number(part);
  });
}

export async function probeHttp({ url, timeoutMs, upStatusCodes, allowPrivate = false, lookup }, fetchFn) {
  const started = Date.now();
  const timeout = timeoutMs || 10000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    await resolvePublicAddresses(new URL(url).hostname, { allowPrivate, lookup });
    const runner = allowPrivate ? fetchFn || fetch : createSafeFetch({ allowPrivate: false, lookup });
    const res = await runner(url, {
      method: 'GET',
      redirect: 'manual',
      signal: ac.signal,
      headers: { 'user-agent': 'MerdienzProbe/1.0' },
    });
    const latencyMs = Date.now() - started;
    const up = isUpStatus(res.status, upStatusCodes);
    return {
      up,
      httpStatus: res.status,
      latencyMs,
      error: up ? null : `status ${res.status}`,
      tls: res.tls || null,
    };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const name = err && err.name;
    const timedOut = name === 'AbortError' || name === 'TimeoutError';
    const blocked = err.code === 'BLOCKED_HOST' || err.message === 'blocked address';
    return {
      up: false,
      httpStatus: null,
      latencyMs,
      error: timedOut ? 'timeout' : blocked ? 'blocked_address' : err.message || 'request failed',
    };
  } finally {
    clearTimeout(timer);
  }
}
