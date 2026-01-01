import { describe, expect, it } from 'vitest';
import { isBlockedAddress, isBlockedHostname, parseIPv4Loose } from '../src/ssrf.js';
import { authHeader, createUser, withApp } from './helpers.js';

const BLOCKED = [
  'http://169.254.169.254/latest/meta-data/',
  'http://127.0.0.1:4924/',
  'http://[::1]/',
  'http://[::ffff:127.0.0.1]/',
  'http://2130706433/',
  'http://0x7f000001/',
  'http://0177.0.0.1/',
  'http://10.0.0.1/',
  'http://localhost/',
  'http://192.168.1.1/',
  'http://172.16.0.8/',
  'http://100.64.0.1/',
  'http://[fe80::1]/',
  'http://[fc00::1]/',
  'http://127.1/',
  'http://0.0.0.0/',
  'http://[::]/',
  'http://224.0.0.1/',
  'http://[64:ff9b::a9fe:a9fe]/',
  'http://[2002:7f00:1::]/',
  'http://198.18.0.1/',
  'http://192.0.0.1/',
  'http://192.0.2.1/',
  'http://198.51.100.1/',
  'http://203.0.113.1/',
  'http://[2001::1]/',
  'http://[2001:db8::1]/',
  'http://[fec0::1]/',
  'http://[febf::1]/',
  'http://[::ffff:8.8.8.8]/',
];

describe('SSRF protection', () => {
  it('parses decimal, octal, hex, and short IPv4 forms', () => {
    expect(parseIPv4Loose('2130706433').text).toBe('127.0.0.1');
    expect(parseIPv4Loose('0x7f000001').text).toBe('127.0.0.1');
    expect(parseIPv4Loose('0177.0.0.1').text).toBe('127.0.0.1');
    expect(parseIPv4Loose('127.1').text).toBe('127.0.0.1');
    expect(isBlockedAddress('2130706433')).toBe(true);
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedHostname('localhost')).toBe(true);
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedAddress('64:ff9b::a9fe:a9fe')).toBe(true);
    expect(isBlockedAddress('2002:7f00:1::')).toBe(true);
    expect(isBlockedAddress('198.18.0.1')).toBe(true);
    expect(isBlockedAddress('192.0.0.1')).toBe(true);
    expect(isBlockedAddress('192.0.2.1')).toBe(true);
    expect(isBlockedAddress('198.51.100.1')).toBe(true);
    expect(isBlockedAddress('203.0.113.1')).toBe(true);
    expect(isBlockedAddress('2001::1')).toBe(true);
    expect(isBlockedAddress('2001:db8::1')).toBe(true);
    expect(isBlockedAddress('fec0::1')).toBe(true);
    expect(isBlockedAddress('febf::1')).toBe(true);
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(true);
    expect(isBlockedAddress('255.255.255.255')).toBe(true);
  });

  it('rejects blocked hosts at add time when private targets are not allowed', async () => {
    await withApp(
      async ({ app, db }) => {
        const user = await createUser(db, { email: 'ssrf@example.com', tier: 'starter' });
        for (const url of BLOCKED) {
          const res = await app.inject({
            method: 'POST',
            url: '/sites',
            headers: { ...authHeader(user), 'content-type': 'application/json' },
            payload: { name: url, url, interval_seconds: 300 },
          });
          expect(res.statusCode, url).toBe(400);
          expect(['BLOCKED_HOST', 'BAD_URL', 'UNRESOLVED_HOST']).toContain(res.json().code);
        }
        const listed = await app.inject({ method: 'GET', url: '/sites', headers: authHeader(user) });
        expect(listed.json().sites).toHaveLength(0);
      },
      { config: { merdienzMode: 'cloud', allowPrivateTargets: false, probeBUrl: 'http://probe.example/internal/probe', probeBSecret: 's'.repeat(32) } }
    );
  });

  it('allows a hostname that resolves to a public address', async () => {
    const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
    const { assertSafeHttpUrl } = await import('../src/ssrf.js');
    const ok = await assertSafeHttpUrl('https://public.example', { allowPrivate: false, lookup });
    expect(ok.hostname).toBe('public.example');
  });

  it('blocks a public hostname that rebinds to a private IP at resolve time', async () => {
    const lookup = async () => [{ address: '127.0.0.1', family: 4 }];
    const { assertSafeHttpUrl } = await import('../src/ssrf.js');
    await expect(
      assertSafeHttpUrl('http://evil.example', { allowPrivate: false, lookup })
    ).rejects.toMatchObject({ code: 'BLOCKED_HOST' });
  });

  it('skips DNS for IP literals including bracketed IPv6', async () => {
    let lookedUp = false;
    const lookup = async () => {
      lookedUp = true;
      throw new Error('should not look up an IP literal');
    };
    const { assertSafeHttpUrl } = await import('../src/ssrf.js');
    const allowed = await assertSafeHttpUrl('http://[fe80::1]/', { allowPrivate: true, lookup });
    expect(lookedUp).toBe(false);
    expect(allowed.hostname).toBe('[fe80::1]');
    expect(allowed.addresses[0].address).toBe('fe80::1');
  });

  it('returns 400 rather than 500 when a host cannot be resolved', async () => {
    const lookup = async () => {
      const err = new Error('getaddrinfo ENOTFOUND no-such-host.invalid');
      err.code = 'ENOTFOUND';
      throw err;
    };
    const { assertSafeHttpUrl } = await import('../src/ssrf.js');
    await expect(
      assertSafeHttpUrl('http://no-such-host.invalid/', { allowPrivate: true, lookup })
    ).rejects.toMatchObject({ statusCode: 400, code: 'UNRESOLVED_HOST' });
    await expect(
      assertSafeHttpUrl('http://no-such-host.invalid/', { allowPrivate: false, lookup })
    ).rejects.toMatchObject({ statusCode: 400, code: 'UNRESOLVED_HOST' });
  });

  it('allows private targets only with explicit ALLOW_PRIVATE_TARGETS outside cloud', async () => {
    await withApp(
      async ({ app, db }) => {
        const user = await createUser(db, { email: 'lab@example.com', tier: 'selfhosted' });
        const res = await app.inject({
          method: 'POST',
          url: '/sites',
          headers: { ...authHeader(user), 'content-type': 'application/json' },
          payload: { name: 'Local', url: 'http://127.0.0.1:4840/health' },
        });
        expect(res.statusCode).toBe(200);
      },
      { config: { merdienzMode: 'selfhosted', allowPrivateTargets: true } }
    );
  });
});
