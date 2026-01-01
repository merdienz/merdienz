import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parsePort, parseSkewSec } from './env-values.js';
import { resolveProbeBSecret } from './probes/secret.js';
import { assertExplicitListenHost } from './probes/listen-host.js';
import { applySmtpConfig, DEFAULT_SMTP_HOST, DEFAULT_SMTP_PORT, DEFAULT_SMTP_USER } from './alerts/smtp-config.js';
import { applyStripeConfig, DEFAULT_STRIPE_SECRET_FILE, DEFAULT_STRIPE_WEBHOOK_SECRET_FILE, DEFAULT_STRIPE_API_BASE } from './billing/config.js';
import { DEFAULT_SMTP_PASSWORD_FILE } from './secret-file.js';
import { DEFAULT_RDAP_BOOTSTRAP_URL } from './insights/domain.js';

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

export function loadConfig(overrides = {}) {
  loadDotEnv();
  const config = {
    nodeEnv: process.env.NODE_ENV || 'development',
    merdienzMode: (process.env.MERDIENZ_MODE || 'cloud').toLowerCase(),
    // The value exactly as set (no default, trimming or case folding). Cloud
    // self-signup only opens when this is exactly 'cloud'.
    merdienzModeRaw: process.env.MERDIENZ_MODE ?? '',
    port: process.env.PORT || 4840,
    host: process.env.HOST || '',
    pgPort: process.env.PG_PORT || 4842,
    databaseUrl: process.env.DATABASE_URL || '',
    probeBUrl: process.env.PROBE_B_URL || '',
    probeBSecret: resolveProbeBSecret(process.env),
    probeBHmacSecret: resolveProbeBSecret(process.env),
    probeBMaxSkewSec: process.env.PROBE_B_MAX_SKEW_SEC || 60,
    probeBPort: process.env.PROBE_B_PORT || 7801,
    probeBSpkiSha256: process.env.PROBE_B_SPKI_SHA256 || '',
    probeBTlsCert: process.env.PROBE_B_TLS_CERT || '',
    probeBTlsKey: process.env.PROBE_B_TLS_KEY || '',
    cookieSecret: process.env.COOKIE_SECRET || '',
    allowPrivateTargets: process.env.ALLOW_PRIVATE_TARGETS === 'true',
    trustedProxies: (process.env.TRUSTED_PROXIES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    heartbeatUrl: process.env.HEARTBEAT_URL || '',
    domainExpiryLookup: process.env.DOMAIN_EXPIRY_LOOKUP || 'off',
    rdapBootstrapUrl: process.env.RDAP_BOOTSTRAP_URL || DEFAULT_RDAP_BOOTSTRAP_URL,
    seoChecks: process.env.SEO_CHECKS || 'on',
    insightsPerTick: process.env.INSIGHTS_PER_TICK || 5,
    mailTransport: process.env.MAIL_TRANSPORT || 'dev',
    mailFrom: process.env.MAIL_FROM || '',
    smtp: {
      host: process.env.SMTP_HOST || DEFAULT_SMTP_HOST,
      port: Number(process.env.SMTP_PORT || DEFAULT_SMTP_PORT),
      secure: process.env.SMTP_SECURE == null || process.env.SMTP_SECURE === ''
        ? true
        : process.env.SMTP_SECURE === 'true',
      user: process.env.SMTP_USER || DEFAULT_SMTP_USER,
      requiredHost: process.env.SMTP_REQUIRED_HOST || '',
      passwordFile: process.env.MERDIENZ_SMTP_PASSWORD_FILE || DEFAULT_SMTP_PASSWORD_FILE,
      pass: '',
    },
    publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
    schedulerIntervalMs: Number(process.env.SCHEDULER_INTERVAL_MS || 5000),
    alertDeliveryIntervalMs: Number(
      process.env.ALERT_DELIVERY_INTERVAL_MS || process.env.SCHEDULER_INTERVAL_MS || 5000
    ),
    defaultIntervalSec: 300,
    defaultTimeoutMs: Number(process.env.DEFAULT_TIMEOUT_MS || 10000),
    stripe: {
      secretKeyFile: process.env.MERDIENZ_STRIPE_SECRET_KEY_FILE || DEFAULT_STRIPE_SECRET_FILE,
      webhookSecretFile: process.env.MERDIENZ_STRIPE_WEBHOOK_SECRET_FILE || DEFAULT_STRIPE_WEBHOOK_SECRET_FILE,
      apiBase: process.env.STRIPE_API_BASE || DEFAULT_STRIPE_API_BASE,
      prices: {
        starter_monthly: process.env.STRIPE_PRICE_STARTER_MONTHLY || '',
        starter_yearly: process.env.STRIPE_PRICE_STARTER_YEARLY || '',
        pro_monthly: process.env.STRIPE_PRICE_PRO_MONTHLY || '',
        pro_yearly: process.env.STRIPE_PRICE_PRO_YEARLY || '',
      },
    },
    ...overrides,
  };
  if (overrides.merdienzMode !== undefined && overrides.merdienzModeRaw === undefined) {
    config.merdienzModeRaw = overrides.merdienzMode;
  }
  config.port = parsePort(config.port, 4840);
  config.pgPort = parsePort(config.pgPort, 4842);
  config.probeBPort = parsePort(config.probeBPort, 7801);
  config.probeBMaxSkewSec = parseSkewSec(config.probeBMaxSkewSec, 60);
  config.mailTransport = String(config.mailTransport ?? 'dev').trim().toLowerCase() || 'dev';
  assertProductionMode(config);
  const mode = String(config.merdienzMode || '').toLowerCase();
  const nodeEnv = String(config.nodeEnv || '').toLowerCase();
  const sandbox = (mode === 'dev' || mode === 'test') && nodeEnv !== 'production';
  if (!config.host && sandbox) {
    config.host = '127.0.0.1';
  } else {
    config.host = assertExplicitListenHost(config.host, { role: 'cloud', mode });
  }
  applySmtpConfig(config);
  applyStripeConfig(config);
  applyInsightsConfig(config);
  return config;
}

const MAIL_TRANSPORTS = new Set(['smtp', 'none', 'dev', 'console']);

export function assertProductionMode(config = {}) {
  const mode = String(config.merdienzMode || '').toLowerCase();
  const nodeEnv = String(config.nodeEnv || '').toLowerCase();
  if (nodeEnv === 'production' && (mode === 'dev' || mode === 'test')) {
    throw new Error('MERDIENZ_MODE cannot be dev or test when NODE_ENV is production');
  }
  const mail = String(config.mailTransport || '').trim().toLowerCase();
  if (mail && !MAIL_TRANSPORTS.has(mail)) {
    throw new Error('MAIL_TRANSPORT must be smtp, none, dev, or console');
  }
  const productionMail = nodeEnv === 'production' || mode === 'cloud';
  if (productionMail && mail !== 'smtp' && mail !== 'none') {
    throw new Error(
      nodeEnv === 'production'
        ? 'MAIL_TRANSPORT cannot be dev or console when NODE_ENV is production'
        : 'MAIL_TRANSPORT must be smtp or none when MERDIENZ_MODE is cloud'
    );
  }
}

export const LOCAL_PORT_MIN = 4840;
export const LOCAL_PORT_MAX = 4859;

export function applyInsightsConfig(config) {
  const lookup = String(config.domainExpiryLookup ?? 'off').trim().toLowerCase() || 'off';
  if (lookup !== 'off' && lookup !== 'rdap') throw new Error('DOMAIN_EXPIRY_LOOKUP must be off or rdap');
  config.domainExpiryLookup = lookup;
  const seo = String(config.seoChecks ?? 'on').trim().toLowerCase() || 'on';
  if (seo !== 'on' && seo !== 'off') throw new Error('SEO_CHECKS must be on or off');
  config.seoChecks = seo;
  let bootstrap;
  try {
    bootstrap = new URL(String(config.rdapBootstrapUrl || DEFAULT_RDAP_BOOTSTRAP_URL));
  } catch {
    throw new Error('RDAP_BOOTSTRAP_URL must be an https URL');
  }
  if (bootstrap.protocol !== 'https:') throw new Error('RDAP_BOOTSTRAP_URL must be an https URL');
  config.rdapBootstrapUrl = bootstrap.toString();
  const perTick = Number(config.insightsPerTick);
  if (!Number.isInteger(perTick) || perTick < 1 || perTick > 50) throw new Error('INSIGHTS_PER_TICK must be an integer from 1 to 50');
  config.insightsPerTick = perTick;
}
