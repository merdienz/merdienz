import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { assertProbeBServerConfig, loadProbeBConfig } from '../src/probes/server-config.js';
import { resolveProbeBSecret } from '../src/probes/secret.js';

const KEYS = ['PROBE_B_SECRET', 'PROBE_B_HMAC_SECRET', 'HOST', 'MERDIENZ_MODE', 'NODE_ENV'];
const saved = {};

function setEnv(map) {
  for (const key of KEYS) {
    if (!(key in saved)) saved[key] = process.env[key];
    if (map[key] === undefined) delete process.env[key];
    else process.env[key] = map[key];
  }
}

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const strong = 's'.repeat(32);
const other = 't'.repeat(32);

describe('probe secret name unification', () => {
  it('prefers PROBE_B_SECRET and accepts PROBE_B_HMAC_SECRET as a fallback', () => {
    setEnv({ PROBE_B_SECRET: strong });
    expect(resolveProbeBSecret(process.env)).toBe(strong);

    setEnv({ PROBE_B_HMAC_SECRET: strong });
    expect(resolveProbeBSecret(process.env)).toBe(strong);

    setEnv({ PROBE_B_SECRET: strong, PROBE_B_HMAC_SECRET: strong });
    expect(resolveProbeBSecret(process.env)).toBe(strong);
  });

  it('throws when both names are set and do not match', () => {
    setEnv({ PROBE_B_SECRET: strong, PROBE_B_HMAC_SECRET: other });
    expect(() => resolveProbeBSecret(process.env)).toThrow(/do not match/);
    try {
      resolveProbeBSecret(process.env);
    } catch (err) {
      expect(err.code).toBe('PROBE_B_SECRET_CONFLICT');
    }
  });

  it('loads the Cloud app config from either name', () => {
    setEnv({ HOST: '127.0.0.1', PROBE_B_SECRET: strong, MERDIENZ_MODE: 'test', NODE_ENV: 'test' });
    expect(loadConfig({ merdienzMode: 'test', mailTransport: 'dev' }).probeBSecret).toBe(strong);

    setEnv({ HOST: '127.0.0.1', PROBE_B_HMAC_SECRET: strong, MERDIENZ_MODE: 'test', NODE_ENV: 'test' });
    expect(loadConfig({ merdienzMode: 'test', mailTransport: 'dev' }).probeBSecret).toBe(strong);

    setEnv({
      HOST: '127.0.0.1',
      PROBE_B_SECRET: strong,
      PROBE_B_HMAC_SECRET: other,
      MERDIENZ_MODE: 'test',
      NODE_ENV: 'test',
    });
    expect(() => loadConfig({ merdienzMode: 'test', mailTransport: 'dev' })).toThrow(/do not match/);
  });

  it('loads the probe-B server config from either name', () => {
    setEnv({ HOST: '127.0.0.1', PROBE_B_SECRET: strong, MERDIENZ_MODE: 'selfhosted' });
    let config = loadProbeBConfig({ merdienzMode: 'selfhosted' });
    expect(config.probeBSecret).toBe(strong);
    expect(() => assertProbeBServerConfig(config)).not.toThrow();

    setEnv({ HOST: '127.0.0.1', PROBE_B_HMAC_SECRET: strong, MERDIENZ_MODE: 'selfhosted' });
    config = loadProbeBConfig({ merdienzMode: 'selfhosted' });
    expect(config.probeBSecret).toBe(strong);
    expect(() => assertProbeBServerConfig(config)).not.toThrow();

    setEnv({
      HOST: '127.0.0.1',
      PROBE_B_SECRET: strong,
      PROBE_B_HMAC_SECRET: other,
      MERDIENZ_MODE: 'selfhosted',
    });
    expect(() => loadProbeBConfig({ merdienzMode: 'selfhosted' })).toThrow(/do not match/);
  });
});
