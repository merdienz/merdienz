import nodemailer from 'nodemailer';
import {
  assertMailAddress,
  redactSecret,
  smtpTransportOptions,
} from './smtp-config.js';

export const SMTP_TIMEOUT_MS = 30_000;

export function sanitizeSubject(value) {
  const s = String(value ?? '').replace(/[\r\n\t]+/g, ' ');
  if (!s) throw new Error('subject is required');
  return s;
}


export function createMailer(config, { createTransport } = {}) {
  const inbox = [];
  const mode = String(config.mailTransport || 'dev').trim().toLowerCase() || 'dev';
  if (mode === 'none') return null;
  const factory = createTransport || nodemailer.createTransport.bind(nodemailer);
  let transport;
  if (mode === 'smtp') {
    const options = smtpTransportOptions(config.smtp || {});
    transport = factory({
      ...options,
      connectionTimeout: SMTP_TIMEOUT_MS,
      greetingTimeout: SMTP_TIMEOUT_MS,
      socketTimeout: SMTP_TIMEOUT_MS,
    });
  } else if (mode === 'console') {
    transport = factory({ jsonTransport: true });
  } else {
    transport = factory({
      streamTransport: true,
      buffer: true,
      newline: 'unix',
    });
  }
  return { transport, mode, inbox, from: config.mailFrom || 'alerts@localhost' };
}

export async function sendAlert(mailer, { to, subject, text }) {
  const safeTo = assertMailAddress(to, 'recipient');
  const safeSubject = sanitizeSubject(subject);
  const safeFrom = assertMailAddress(mailer.from, 'from');
  let info;
  try {
    info = await mailer.transport.sendMail({
      from: safeFrom,
      to: safeTo,
      subject: safeSubject,
      text,
    });
  } catch (err) {
    const secret = mailer.transport?.options?.auth?.pass;
    throw new Error(redactSecret(err && err.message, secret));
  }
  const record = {
    to: safeTo,
    subject: safeSubject,
    text,
    at: new Date().toISOString(),
    messageId: info.messageId,
  };
  if (mailer.mode === 'dev') {
    mailer.inbox.push({
      ...record,
      raw: info.message ? info.message.toString() : '',
    });
  }
  if (mailer.mode === 'console') {
    console.log(`[mail] ${safeSubject} -> ${safeTo}`);
  }
  return record;
}

export function clearInbox(mailer) {
  mailer.inbox.length = 0;
}
