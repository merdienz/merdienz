import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assertProbeBServerConfig, assertProbeConfig } from '../src/guard.js';
import { createProbeApp } from '../src/probes/app.js';
import { newProbeNonce, signProbe } from '../src/probes/confirm.js';
import { fetchPinned, parseSpkiPin, spkiSha256FromCert } from '../src/probes/pin.js';
import { tp } from './ports.js';

const SECRET = 's'.repeat(32);
const dir = mkdtempSync(join(tmpdir(), 'merdienz-tls-'));

function makeCert() {
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-keyout',
    key,
    '-out',
    cert,
    '-days',
    '1',
    '-nodes',
    '-subj',
    '/CN=localhost',
  ], { stdio: 'pipe' });
  const pin = spkiSha256FromCert(readFileSync(cert));
  return { key, cert, pin, pinHex: pin.toString('hex'), pinB64: pin.toString('base64') };
}

const material = makeCert();

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('probe B TLS and certificate pinning', () => {
  it('requires TLS and a pin in cloud mode, including on the probe process', () => {
    expect(() =>
      assertProbeConfig({
        merdienzMode: 'cloud',
        probeBUrl: 'http://127.0.0.1:4841/internal/probe',
        probeBSecret: SECRET,
        probeBSpkiSha256: material.pinHex,
      })
    ).toThrow(/https/);
    expect(() =>
      assertProbeBServerConfig({ merdienzMode: 'cloud', probeBHmacSecret: SECRET, host: '127.0.0.1' })
    ).toThrow(/TLS/);
    expect(() =>
      assertProbeBServerConfig({ merdienzMode: 'dev', probeBHmacSecret: '', host: '127.0.0.1' })
    ).toThrow(/HMAC_SECRET/);
  });

  it('accepts the right pin and refuses a wrong pin over TLS 1.3', async () => {
    const app = await createProbeApp({
      fetchFn: async () => ({ status: 200, ok: true, headers: {} }),
      config: {
        nodeEnv: 'test',
        merdienzMode: 'selfhosted',
        probeBHmacSecret: SECRET,
        probeBSecret: SECRET,
        probeBMaxSkewSec: 30,
        defaultTimeoutMs: 1000,
        disableRateLimit: true,
        allowPrivateTargets: true,
      },
      https: {
        cert: readFileSync(material.cert),
        key: readFileSync(material.key),
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
      },
    });
    await app.listen({ port: tp(4853), host: '127.0.0.1' });
    const url = `https://127.0.0.1:${tp(4853)}/internal/probe`;
    const body = JSON.stringify({ url: 'https://example.com', timeout_ms: 500, up_status_codes: '2xx' });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = newProbeNonce();
    const signature = signProbe(SECRET, timestamp, nonce, body);
    const headers = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'x-probe-timestamp': timestamp,
      'x-probe-nonce': nonce,
      'x-probe-signature': signature,
    };
    try {
      const ok = await fetchPinned(url, { headers, body, pin: material.pinHex, timeoutMs: 4000 });
      expect(ok.status).toBe(200);
      const wrong = parseSpkiPin('b'.repeat(64));
      await expect(fetchPinned(url, { headers, body, pin: wrong, timeoutMs: 4000 })).rejects.toMatchObject({
        code: 'PROBE_B_PIN',
      });
    } finally {
      await app.close();
    }
  });
});
