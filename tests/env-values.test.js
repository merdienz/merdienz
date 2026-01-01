import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { parsePort, parseSkewSec } from '../src/env-values.js';
import { verifyProbeSignature } from '../src/probes/confirm.js';
import { loadProbeBConfig } from '../src/probes/server-config.js';

describe('boot env validation', () => {
  it('parses ports and replay windows strictly', () => {
    expect(parsePort(4840)).toBe(4840);
    expect(parsePort('7801')).toBe(7801);
    expect(parseSkewSec(60)).toBe(60);
    expect(parseSkewSec('30')).toBe(30);
    for (const bad of ['1e2', ' 1', '01', '01x', '+1', '0x1', '0', '65536', 'abc', '']) {
      expect(() => parsePort(bad, null)).toThrow(/PORT must be an integer/);
    }
    for (const bad of ['1e2', ' 1', '01', '01x', '+1', '0x1', '0', '301', 'abc', 'NaN']) {
      expect(() => parseSkewSec(bad, null)).toThrow(/PROBE_B_MAX_SKEW_SEC/);
    }
  });

  it('honors HOST and rejects a bad replay window at config load', () => {
    const previous = process.env.HOST;
    process.env.HOST = '127.0.0.1';
    try {
      expect(loadConfig({ databaseUrl: 'postgres://x', merdienzMode: 'test', mailTransport: 'dev' }).host).toBe('127.0.0.1');
    } finally {
      if (previous === undefined) delete process.env.HOST;
      else process.env.HOST = previous;
    }
    expect(() => loadConfig({ probeBMaxSkewSec: 'abc' })).toThrow(/PROBE_B_MAX_SKEW_SEC/);
    expect(() => loadProbeBConfig({ probeBMaxSkewSec: 'not-a-number' })).toThrow(/PROBE_B_MAX_SKEW_SEC/);
    expect(() => loadProbeBConfig({ port: '0' })).toThrow(/PORT must be an integer/);
  });

  it('never skips the timestamp check when the replay window is not a number', () => {
    const secret = 's'.repeat(32);
    const ts = String(Math.floor(Date.now() / 1000));
    expect(
      verifyProbeSignature(secret, ts, 'nonce-value-ok', '{}', 'ab'.repeat(32), { maxSkewSec: 'abc' })
    ).toBe(false);
    expect(
      verifyProbeSignature(secret, ts, 'nonce-value-ok', '{}', 'ab'.repeat(32), { maxSkewSec: Number.NaN })
    ).toBe(false);
  });
});
