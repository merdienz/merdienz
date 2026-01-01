import { afterEach, describe, expect, it } from 'vitest';
import { loadProbeBConfig } from '../src/probes/server-config.js';

describe('probe B listen port', () => {
  const keys = ['PORT', 'PROBE_B_PORT', 'PROBE_B_HMAC_SECRET', 'MERDIENZ_MODE'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));

  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('prefers PROBE_B_PORT over a PORT inherited from the shared image', () => {
    process.env.MERDIENZ_MODE = 'selfhosted';
    process.env.PROBE_B_HMAC_SECRET = 'x'.repeat(32);
    process.env.PORT = '4840';
    process.env.PROBE_B_PORT = '7801';
    const config = loadProbeBConfig();
    expect(config.port).toBe(7801);
  });
});
