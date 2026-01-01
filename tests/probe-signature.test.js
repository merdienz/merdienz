import { describe, expect, it } from 'vitest';
import { createProbeApp } from '../src/probe-app.js';
import { newProbeNonce, signProbe } from '../src/probes/confirm.js';
import { createReplayCache } from '../src/replay.js';
import { closeServer, startLocalServer, testConfig } from './helpers.js';
import { tp } from './ports.js';

async function withProbe(fn, overrides = {}) {
  const config = testConfig({ merdienzMode: 'dev', allowPrivateTargets: true, ...overrides });
  const replayCache = createReplayCache({ maxSkewSec: config.probeBMaxSkewSec });
  const app = await createProbeApp({ config, replayCache });
  await app.ready();
  try {
    return await fn({ app, config, replayCache });
  } finally {
    await app.close();
  }
}

describe('probe B signatures', () => {
  it('accepts a valid HMAC signature and returns the target check result', async () => {
    const target = await startLocalServer((req, res) => {
      res.writeHead(204);
      res.end();
    }, tp(4852));
    try {
      await withProbe(async ({ app, config }) => {
        const body = JSON.stringify({
          url: target.url,
          timeout_ms: 2000,
          up_status_codes: '2xx,3xx',
        });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const nonce = newProbeNonce();
        const signature = signProbe(config.probeBSecret, timestamp, nonce, body);
        const res = await app.inject({
          method: 'POST',
          url: '/internal/probe',
          headers: {
            'content-type': 'application/json',
            'x-probe-timestamp': timestamp,
            'x-probe-nonce': nonce,
            'x-probe-signature': signature,
          },
          payload: body,
        });
        expect(res.statusCode).toBe(200);
        const json = res.json();
        expect(json.up).toBe(true);
        expect(json.httpStatus).toBe(204);
      });
    } finally {
      await closeServer(target);
    }
  });

  it('rejects a missing, wrong, expired, or replayed signature', async () => {
    await withProbe(async ({ app, config }) => {
      const body = JSON.stringify({ url: `http://127.0.0.1:${tp(4852)}/`, timeout_ms: 1000 });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = newProbeNonce();

      const missing = await app.inject({
        method: 'POST',
        url: '/internal/probe',
        headers: { 'content-type': 'application/json', 'x-probe-timestamp': timestamp },
        payload: body,
      });
      expect(missing.statusCode).toBe(401);

      const bad = await app.inject({
        method: 'POST',
        url: '/internal/probe',
        headers: {
          'content-type': 'application/json',
          'x-probe-timestamp': timestamp,
          'x-probe-nonce': nonce,
          'x-probe-signature': 'ab'.repeat(32),
        },
        payload: body,
      });
      expect(bad.statusCode).toBe(401);

      const staleTs = String(Math.floor(Date.now() / 1000) - 120);
      const staleNonce = newProbeNonce();
      const staleSig = signProbe(config.probeBSecret, staleTs, staleNonce, body);
      const stale = await app.inject({
        method: 'POST',
        url: '/internal/probe',
        headers: {
          'content-type': 'application/json',
          'x-probe-timestamp': staleTs,
          'x-probe-nonce': staleNonce,
          'x-probe-signature': staleSig,
        },
        payload: body,
      });
      expect(stale.statusCode).toBe(401);

      const goodTs = String(Math.floor(Date.now() / 1000));
      const goodNonce = newProbeNonce();
      const goodSig = signProbe(config.probeBSecret, goodTs, goodNonce, body);
      const headers = {
        'content-type': 'application/json',
        'x-probe-timestamp': goodTs,
        'x-probe-nonce': goodNonce,
        'x-probe-signature': goodSig,
      };
      const first = await app.inject({ method: 'POST', url: '/internal/probe', headers, payload: body });
      expect(first.statusCode).not.toBe(401);
      const replay = await app.inject({ method: 'POST', url: '/internal/probe', headers, payload: body });
      expect(replay.statusCode).toBe(401);
    });
  });

  it('does not mount the rest of the API and only exposes probe + health', async () => {
    await withProbe(async ({ app }) => {
      expect((await app.inject({ method: 'GET', url: '/health' })).json().role).toBe('probe-b');
      expect((await app.inject({ method: 'GET', url: '/sites' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/auth/login' })).statusCode).toBe(404);
    });
  });
});
