import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isStrongProbeSecret, normalizeMode } from './mode.js';
import { parsePort, parseSkewSec } from './env-values.js';
import { resolveProbeBSecret } from './secret.js';
import { assertExplicitListenHost } from './listen-host.js';

function loadDotEnv() {
  const path = resolve(process.cwd(), '.env');
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function loadProbeBConfig(overrides = {}) {
  loadDotEnv();
  const secret = resolveProbeBSecret(process.env);
  const config = {
    nodeEnv: process.env.NODE_ENV || 'production',
    merdienzMode: (process.env.MERDIENZ_MODE || 'cloud').toLowerCase(),
    port: process.env.PROBE_B_PORT || process.env.PORT || 7801,
    host: process.env.HOST || '',
    probeBHmacSecret: secret,
    probeBSecret: secret,
    probeBMaxSkewSec: process.env.PROBE_B_MAX_SKEW_SEC || 60,
    probeBTlsCert: process.env.PROBE_B_TLS_CERT || '',
    probeBTlsKey: process.env.PROBE_B_TLS_KEY || '',
    allowPrivateTargets: process.env.ALLOW_PRIVATE_TARGETS === 'true',
    defaultTimeoutMs: Number(process.env.DEFAULT_TIMEOUT_MS || 10000),
    disableRateLimit: process.env.NODE_ENV === 'test',
    ...overrides,
  };
  config.port = parsePort(config.port, 7801);
  config.probeBMaxSkewSec = parseSkewSec(config.probeBMaxSkewSec, 60);
  // HOST is validated in assertProbeBServerConfig so missing/unspecified
  // values still load for tests that only check other fields, then fail closed.
  return config;
}

export function assertProbeBServerConfig(config) {
  assertExplicitListenHost(config.host, { role: 'probe-b', mode: config.merdienzMode });
  const secret = config.probeBSecret || config.probeBHmacSecret || '';
  if (!isStrongProbeSecret(secret)) {
    const err = new Error('PROBE_B_SECRET is required (at least 32 bytes, not a default value); PROBE_B_HMAC_SECRET is accepted as a fallback');
    err.code = 'PROBE_B_SECRET';
    throw err;
  }
  const mode = normalizeMode(config.merdienzMode);
  if (mode === 'cloud') {
    if (!config.probeBTlsCert || !config.probeBTlsKey) {
      const err = new Error('PROBE_B_TLS_CERT and PROBE_B_TLS_KEY are required when MERDIENZ_MODE=cloud');
      err.code = 'PROBE_B_TLS';
      throw err;
    }
  }
}
