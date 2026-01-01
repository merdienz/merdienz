import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { allowsInProcessProbe } from './mode.js';
import { fetchPinned } from './pin.js';
import { defaultReplayCache } from './replay.js';
import { probeHttp } from './http.js';

export function signProbe(secret, timestamp, nonce, body, method = 'POST', path = '/internal/probe') {
  return createHmac('sha256', secret)
    .update(`${method}.${path}.${timestamp}.${nonce}.${body}`)
    .digest('hex');
}

export function newProbeNonce() {
  return randomBytes(16).toString('hex');
}

export function verifyProbeSignature(
  secret,
  timestamp,
  nonce,
  body,
  signature,
  {
    maxSkewSec = 60,
    replayCache = defaultReplayCache,
    method = 'POST',
    path = '/internal/probe',
  } = {}
) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || !signature || !nonce) return false;
  if (typeof nonce !== 'string' || nonce.length < 8 || nonce.length > 128) return false;
  const now = Math.floor(Date.now() / 1000);
  const skew = Number(maxSkewSec);
  if (!Number.isFinite(skew) || !Number.isInteger(skew) || skew < 1 || skew > 300) return false;
  if (!Number.isFinite(ts) || Math.abs(now - ts) > skew) return false;
  const expected = signProbe(secret, String(timestamp), nonce, body, method, path);
  const sig = String(signature);
  let matches = false;
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(sig, 'hex');
    if (a.length === 0 || a.length !== b.length) return false;
    matches = timingSafeEqual(a, b);
  } catch {
    return false;
  }
  if (!matches) return false;
  const replayKey = `${timestamp}.${nonce}.${sig}`;
  if (replayCache.seen(replayKey)) return false;
  return true;
}

export async function callProbeB(site, config, fetchFn = fetch) {
  const payload = {
    url: site.url,
    timeout_ms: site.timeoutMs || site.timeout_ms,
    up_status_codes: site.upStatusCodes || site.up_status_codes,
  };

  if (!config.probeBUrl) {
    if (!allowsInProcessProbe(config)) {
      return {
        up: null,
        httpStatus: null,
        latencyMs: null,
        error: 'probe_b_unconfigured',
        via: 'none',
        unavailable: true,
      };
    }
    const result = await probeHttp(
      {
        url: payload.url,
        timeoutMs: payload.timeout_ms,
        upStatusCodes: payload.up_status_codes,
        allowPrivate: config.allowPrivateTargets,
      },
      fetchFn
    );
    return { ...result, via: 'in-process' };
  }

  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = newProbeNonce();
  const signature = signProbe(config.probeBSecret, timestamp, nonce, body);
  const requestInit = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-probe-timestamp': timestamp,
      'x-probe-nonce': nonce,
      'x-probe-signature': signature,
    },
    body,
    timeoutMs: (payload.timeout_ms || 10000) + 2000,
    pin: config.probeBSpkiSha256,
  };
  try {
    let res;
    const probeUrl = config.probeBUrl;
    if (String(probeUrl).startsWith('https:')) {
      res = await fetchPinned(probeUrl, requestInit);
    } else {
      res = await fetchFn(probeUrl, {
        method: requestInit.method,
        headers: requestInit.headers,
        body,
        signal: AbortSignal.timeout(requestInit.timeoutMs),
      });
    }
    if (!res.ok) {
      return {
        up: null,
        httpStatus: null,
        latencyMs: null,
        error: `probe_b_http_${res.status}`,
        via: 'probe-b',
        unavailable: true,
      };
    }
    const data = await res.json();
    return {
      up: Boolean(data.up),
      httpStatus: data.httpStatus ?? data.http_status ?? null,
      latencyMs: data.latencyMs ?? data.latency_ms ?? null,
      error: data.error ?? null,
      via: 'probe-b',
    };
  } catch (err) {
    return {
      up: null,
      httpStatus: null,
      latencyMs: null,
      error: err.message || 'probe_b_unreachable',
      via: 'probe-b',
      unavailable: true,
    };
  }
}
