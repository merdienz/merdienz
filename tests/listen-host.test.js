import { describe, expect, it } from 'vitest';
import { createProbeApp } from '../src/probes/app.js';
import { assertExplicitListenHost, isUnspecifiedListenHost } from '../src/probes/listen-host.js';
import { assertProbeBServerConfig } from '../src/probes/server-config.js';
import { tp } from './ports.js';

const unspecifiedHosts = [
  '0.0.0.0',
  '::',
  '[::]',
  '::0',
  '[::0]',
  '0',
  '0:0:0:0:0:0:0:0',
  '0000:0000:0000:0000:0000:0000:0000:0000',
  '::ffff:0.0.0.0',
  '000.0.0.0',
  '0x0',
  '0.0',
  '0.0.0',
  '0x00000000',
  '[::ffff:0.0.0.0]',
  '::ffff:0:0',
  '*',
  '',
];

describe('explicit listen HOST', () => {
  it('treats every all-zero v4 or v6 form as unspecified', () => {
    for (const host of unspecifiedHosts) {
      expect(isUnspecifiedListenHost(host), host).toBe(true);
    }
    expect(isUnspecifiedListenHost('127.0.0.1')).toBe(false);
    expect(isUnspecifiedListenHost('::1')).toBe(false);
    expect(isUnspecifiedListenHost('[::1]')).toBe(false);
  });

  it('refuses an unspecified HOST for probe B in every mode', () => {
    for (const host of unspecifiedHosts.filter(Boolean)) {
      expect(() =>
        assertExplicitListenHost(host, { role: 'probe-b', mode: 'cloud' })
      ).toThrow(/HOST is required for probe B/);
      expect(() =>
        assertExplicitListenHost(host, { role: 'probe-b', mode: 'selfhosted' })
      ).toThrow(/HOST is required for probe B/);
    }
    expect(() =>
      assertExplicitListenHost('', { role: 'probe-b', mode: 'selfhosted' })
    ).toThrow(/HOST is required for probe B/);
    expect(assertExplicitListenHost('127.0.0.1', { role: 'probe-b', mode: 'cloud' })).toBe(
      '127.0.0.1'
    );
  });

  it('refuses a wildcard for the Cloud app when normalizeMode is cloud', () => {
    for (const host of ['0.0.0.0', '::', '::0', '[::0]', '0', '0:0:0:0:0:0:0:0', '000.0.0.0', '0x0', '0.0', '0.0.0', '0x00000000']) {
      expect(() =>
        assertExplicitListenHost(host, { role: 'cloud', mode: 'cloud' })
      ).toThrow(/HOST is required for the Cloud app/);
      expect(() =>
        assertExplicitListenHost(host, { role: 'cloud', mode: 'production' })
      ).toThrow(/HOST is required for the Cloud app/);
      expect(() =>
        assertExplicitListenHost(host, { role: 'cloud', mode: 'cloud ' })
      ).toThrow(/HOST is required for the Cloud app/);
    }
    expect(() =>
      assertExplicitListenHost('', { role: 'cloud', mode: 'cloud' })
    ).toThrow(/HOST is required for the Cloud app/);
    expect(assertExplicitListenHost('127.0.0.1', { role: 'cloud', mode: 'cloud' })).toBe(
      '127.0.0.1'
    );
    expect(assertExplicitListenHost('0.0.0.0', { role: 'cloud', mode: 'selfhosted' })).toBe(
      '0.0.0.0'
    );
  });

  it('assertProbeBServerConfig refuses 0.0.0.0, :: and selfhosted wildcards', () => {
    const base = {
      host: '0.0.0.0',
      probeBSecret: 's'.repeat(32),
      merdienzMode: 'cloud',
      probeBTlsCert: '/tmp/cert.pem',
      probeBTlsKey: '/tmp/key.pem',
    };
    expect(() => assertProbeBServerConfig(base)).toThrow(/HOST is required for probe B/);
    expect(() => assertProbeBServerConfig({ ...base, host: '::' })).toThrow(
      /HOST is required for probe B/
    );
    expect(() =>
      assertProbeBServerConfig({ ...base, host: '::0', merdienzMode: 'selfhosted' })
    ).toThrow(/HOST is required for probe B/);
    expect(() =>
      assertProbeBServerConfig({ ...base, host: '127.0.0.1' })
    ).not.toThrow();
  });

  it('starts probe B on an explicit HOST and refuses 0.0.0.0, including a simulated errno 97 listen path', async () => {
    expect(() =>
      assertExplicitListenHost('0.0.0.0', { role: 'probe-b', mode: 'cloud' })
    ).toThrow(/HOST is required/);

    // Simulate Fastify's unspecified-bind path: uv_interface_addresses
    // fails with errno 97 when AF_NETLINK is blocked.
    async function listenSimulated({ host }) {
      assertExplicitListenHost(host, { role: 'probe-b', mode: 'cloud' });
      return 'ok';
    }
    await expect(listenSimulated({ host: '0.0.0.0' })).rejects.toThrow(/HOST is required/);
    const blocked = async (host) => {
      if (isUnspecifiedListenHost(host)) {
        const err = new Error('uv_interface_addresses returned Unknown system error 97');
        err.errno = 97;
        err.code = 'Unknown system error 97';
        throw err;
      }
      return 'started';
    };
    await expect(blocked('0.0.0.0')).rejects.toMatchObject({ errno: 97 });
    await expect(blocked('::0')).rejects.toMatchObject({ errno: 97 });
    await expect(blocked('127.0.0.1')).resolves.toBe('started');

    const app = await createProbeApp({
      config: {
        merdienzMode: 'selfhosted',
        host: '127.0.0.1',
        port: tp(4857),
        probeBSecret: 's'.repeat(32),
        probeBMaxSkewSec: 60,
        disableRateLimit: true,
        allowPrivateTargets: true,
        defaultTimeoutMs: 1000,
      },
    });
    await app.listen({ port: tp(4857), host: '127.0.0.1' });
    try {
      const res = await fetch(`http://127.0.0.1:${tp(4857)}/health`);
      expect(res.status).toBe(200);
    } finally {
      await app.close();
    }
  });
});
