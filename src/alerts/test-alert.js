import { createMailer } from './email.js';
import {
  DEFAULT_MAIL_FROM,
  assertMailAddress,
  applySmtpConfig,
  redactSecret,
  sendMailBounded,
  smtpBackoffMs,
  smtpTransportOptions,
} from './smtp-config.js';

const TEST_SUBJECT = 'Merdienz test alert';
const TEST_TEXT = 'This is a single test alert from the Merdienz Cloud mail check.';

/** Build a smtp-mode config snapshot without changing the process MAIL_TRANSPORT default. */
export function smtpConfigForTest(base) {
  const config = {
    ...base,
    mailTransport: 'smtp',
    mailFrom: base.mailFrom && base.mailFrom !== 'alerts@localhost' ? base.mailFrom : DEFAULT_MAIL_FROM,
    smtp: { ...(base.smtp || {}) },
  };
  applySmtpConfig(config);
  return config;
}

export function describeSmtpDryRun(config, { to } = {}) {
  const options = smtpTransportOptions(config.smtp);
  const lines = [
    'dry-run: SMTP config is valid; no connection was made',
    `host=${options.host}`,
    `port=${options.port}`,
    `secure=${options.secure}`,
    `tlsMin=${options.tls.minVersion}`,
    `rejectUnauthorized=${options.tls.rejectUnauthorized}`,
    `user=${options.auth?.user || ''}`,
    `from=${config.mailFrom}`,
  ];
  if (to) {
    lines.push(`to=${assertMailAddress(to, 'recipient')}`);
  }
  return lines.join('\n');
}

export async function sendTestAlert(config, { to, sendMail } = {}) {
  const recipient = assertMailAddress(to, 'recipient');
  const mailer = createMailer(config);
  if (!mailer || mailer.mode !== 'smtp') {
    throw new Error('test alert requires SMTP');
  }
  const mail = {
    from: config.mailFrom,
    to: recipient,
    subject: TEST_SUBJECT,
    text: TEST_TEXT,
  };
  const sender =
    sendMail ||
    ((payload) => sendMailBounded(mailer.transport, payload, { attempts: 3, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }));
  try {
    const info = await sender(mail);
    return { messageId: info?.messageId || info?.response || '' };
  } catch (err) {
    throw new Error(redactSecret(err && err.message, config.smtp?.pass));
  }
}

export { smtpBackoffMs, TEST_SUBJECT, TEST_TEXT };
