import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearInbox, createMailer, sendAlert, SMTP_TIMEOUT_MS } from '../src/alerts/email.js';
import { testConfig } from './helpers.js';

const smtpDirs = [];
afterEach(() => {
  while (smtpDirs.length) rmSync(smtpDirs.pop(), { recursive: true, force: true });
});

function smtpPasswordFile() {
  const dir = mkdtempSync(join(tmpdir(), 'merdienz-email-smtp-'));
  smtpDirs.push(dir);
  const file = join(dir, 'smtp-password');
  writeFileSync(file, 'test-smtp-password\n');
  chmodSync(file, 0o600);
  return file;
}

describe('email adapter', () => {
  it('captures messages on the dev transport without sending SMTP', async () => {
    const mailer = createMailer(testConfig({ mailTransport: 'dev' }));
    expect(mailer.mode).toBe('dev');
    const record = await sendAlert(mailer, {
      to: 'owner@example.com',
      subject: 'DOWN: example',
      text: 'both probes failed',
    });
    expect(record.to).toBe('owner@example.com');
    expect(mailer.inbox).toHaveLength(1);
    expect(mailer.inbox[0].subject).toBe('DOWN: example');
    expect(mailer.inbox[0].text).toContain('both probes failed');
    expect(mailer.inbox[0].raw).toContain('DOWN: example');
    clearInbox(mailer);
    expect(mailer.inbox).toHaveLength(0);
  });

  it('sets SMTP connection, greeting and socket timeouts well under the claim lease', () => {
    const mailer = createMailer(
      testConfig({
        mailTransport: 'smtp',
        mailFrom: 'alerts@example.com',
        smtp: {
          host: 'example.com',
          port: 465,
          secure: true,
          user: 'alerts',
          passwordFile: smtpPasswordFile(),
        },
      })
    );
    expect(SMTP_TIMEOUT_MS).toBe(30_000);
    expect(SMTP_TIMEOUT_MS).toBeLessThan(2 * 60 * 1000);
    expect(mailer.transport.options.connectionTimeout).toBe(SMTP_TIMEOUT_MS);
    expect(mailer.transport.options.greetingTimeout).toBe(SMTP_TIMEOUT_MS);
    expect(mailer.transport.options.socketTimeout).toBe(SMTP_TIMEOUT_MS);
    expect(mailer.transport.options.secure).toBe(true);
    expect(mailer.transport.options.tls).toEqual({ minVersion: 'TLSv1.2', rejectUnauthorized: true });
  });
});
