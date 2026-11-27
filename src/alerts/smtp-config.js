import { isSingleEmailAddress } from '../email-address.js';
import { normalizeMode } from '../probes/mode.js';
import { DEFAULT_SMTP_PASSWORD_FILE, readSecretFile } from '../secret-file.js';

// No relay is built in. Operators set SMTP_HOST (and SMTP_USER when the relay needs auth).
export const DEFAULT_SMTP_HOST = 'localhost';
export const DEFAULT_SMTP_PORT = 465;
export const DEFAULT_SMTP_USER = '';
export const DEFAULT_MAIL_FROM = 'alert@merdienz.com';
export const SMTP_TLS_MIN_VERSION = 'TLSv1.2';
export const SMTP_MAX_SEND_ATTEMPTS = 3;

export function redactSecret(text, secret) {
  const raw = String(text ?? '');
  if (!secret) return raw;
  return raw.split(String(secret)).join('[redacted]');
}

export function smtpBackoffMs(attempt) {
  const n = Math.min(10, Math.max(0, Number(attempt) || 0));
  return Math.min(8_000, 1000 * 2 ** n);
}

export async function sendMailBounded(transport, mail, { attempts = SMTP_MAX_SEND_ATTEMPTS, sleep } = {}) {
  const max = Math.max(1, Math.min(SMTP_MAX_SEND_ATTEMPTS, Number(attempts) || SMTP_MAX_SEND_ATTEMPTS));
  const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let last;
  for (let i = 0; i < max; i += 1) {
    try {
      return await transport.sendMail(mail);
    } catch (err) {
      last = err;
      if (i + 1 >= max) break;
      await wait(smtpBackoffMs(i));
    }
  }
  throw last;
}

export function assertHeaderValue(value, label) {
  const s = String(value ?? '');
  if (!s) throw new Error(`${label} is required`);
  if (/[\r\n]/.test(s)) throw new Error(`${label} must not contain CR or LF`);
  return s;
}

export function assertMailAddress(value, label) {
  const s = assertHeaderValue(value, label);
  if (!isSingleEmailAddress(s)) {
    throw new Error(`${label} is not a valid single email address`);
  }
  return s;
}

function isBlankMailFrom(value) {
  return !String(value ?? '').trim();
}

export function assertSmtpFrom(value, configOrMode) {
  const from = assertMailAddress(value, 'MAIL_FROM');
  const rawMode = configOrMode && typeof configOrMode === 'object' ? configOrMode.merdienzMode : configOrMode;
  if (normalizeMode(rawMode) === 'cloud') {
    const domain = from.slice(from.lastIndexOf('@') + 1).toLowerCase();
    if (domain !== 'merdienz.com') {
      throw new Error('MAIL_FROM must be a merdienz.com address');
    }
  }
  return from;
}

export function smtpDefaults(smtp = {}) {
  const port = Number(smtp.port || DEFAULT_SMTP_PORT);
  return {
    host: smtp.host || DEFAULT_SMTP_HOST,
    port: Number.isFinite(port) && port > 0 ? port : DEFAULT_SMTP_PORT,
    secure: smtp.secure === undefined || smtp.secure === '' ? true : Boolean(smtp.secure),
    user: smtp.user || DEFAULT_SMTP_USER,
    requiredHost: String(smtp.requiredHost || '').trim().toLowerCase(),
    passwordFile: smtp.passwordFile || DEFAULT_SMTP_PASSWORD_FILE,
    pass: smtp.pass || '',
  };
}

export function smtpTransportOptions(smtp) {
  const cfg = smtpDefaults(smtp);
  return {
    host: cfg.host,
    port: cfg.port,
    secure: Boolean(cfg.secure),
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    tls: {
      minVersion: SMTP_TLS_MIN_VERSION,
      rejectUnauthorized: true,
    },
  };
}

function isProductionMail(config) {
  const mode = String(config.merdienzMode || '').toLowerCase();
  const nodeEnv = String(config.nodeEnv || '').toLowerCase();
  return nodeEnv === 'production' || mode === 'cloud';
}

export function readSmtpPassword(config) {
  const smtp = smtpDefaults(config.smtp || {});
  const label = 'MERDIENZ_SMTP_PASSWORD_FILE';
  return readSecretFile(smtp.passwordFile, label, { allowGroupReadable: true });
}

/**
 * Apply SMTP defaults. When MAIL_TRANSPORT is smtp, require a valid From and, when SMTP_USER is set,
 * a usable password file. SMTP_REQUIRED_HOST lets an operator pin the relay in production.
 * Cloud mode locks MAIL_FROM to merdienz.com and defaults to alert@merdienz.com. Other modes
 * require an explicit MAIL_FROM and do not apply that default.
 */
export function applySmtpConfig(config) {
  config.smtp = smtpDefaults(config.smtp || {});
  if (String(config.mailTransport || '').toLowerCase() !== 'smtp') {
    config.smtp.pass = '';
    if (!config.mailFrom) config.mailFrom = 'alerts@localhost';
    return config;
  }
  if (isProductionMail(config) && !config.smtp.secure) {
    throw new Error('SMTP must use implicit TLS (port 465, secure true)');
  }
  const host = String(config.smtp.host || '').trim().toLowerCase();
  if (!host || /[\s/]/.test(host)) {
    throw new Error('SMTP_HOST must be a host name');
  }
  if (isProductionMail(config) && config.smtp.requiredHost && host !== config.smtp.requiredHost) {
    throw new Error(`SMTP_HOST must be ${config.smtp.requiredHost} in production (SMTP_REQUIRED_HOST)`);
  }
  if (isBlankMailFrom(config.mailFrom)) {
    if (normalizeMode(config.merdienzMode) === 'cloud') {
      config.mailFrom = DEFAULT_MAIL_FROM;
    } else {
      throw new Error(
        'MAIL_FROM must be set to an address on a domain you have authorized with your SMTP provider'
      );
    }
  }
  config.mailFrom = assertSmtpFrom(config.mailFrom, config);
  config.smtp.pass = config.smtp.user ? readSmtpPassword(config) : '';
  return config;
}
