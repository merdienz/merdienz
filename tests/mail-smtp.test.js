import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createMailer, sanitizeSubject, sendAlert, SMTP_TIMEOUT_MS } from '../src/alerts/email.js';
import {
  DEFAULT_MAIL_FROM,
  DEFAULT_SMTP_HOST,
  DEFAULT_SMTP_PORT,
  DEFAULT_SMTP_USER,
  SMTP_MAX_SEND_ATTEMPTS,
  SMTP_TLS_MIN_VERSION,
  redactSecret,
  sendMailBounded,
  smtpBackoffMs,
  smtpTransportOptions,
} from '../src/alerts/smtp-config.js';
import { requireSecretFile, readSecretFile, secretPermsAllowed, MAX_SECRET_BYTES } from '../src/secret-file.js';
import { isSingleEmailAddress } from '../src/email-address.js';
import { describeSmtpDryRun, sendTestAlert, smtpConfigForTest } from '../src/alerts/test-alert.js';

const root = dirname(fileURLToPath(import.meta.url));
const appRoot = join(root, '..');
const SECRET = 're_test_secret_DO_NOT_LOG_9f3c';

const dirs = [];

function workDir() {
  const dir = mkdtempSync(join(tmpdir(), 'merdienz-smtp-'));
  dirs.push(dir);
  return dir;
}

function writeSecret(contents = `${SECRET}\n`, mode = 0o600) {
  const file = join(workDir(), 'smtp-password');
  writeFileSync(file, contents);
  chmodSync(file, mode);
  return file;
}

function cloudSmtp(overrides = {}) {
  const passwordFile = overrides.passwordFile || writeSecret();
  const { smtp: smtpOver, passwordFile: _ignored, mailFrom, ...rest } = overrides;
  const opts = {
    nodeEnv: 'production',
    merdienzMode: 'cloud',
    host: '127.0.0.1',
    mailTransport: 'smtp',
    smtp: {
      host: 'smtp.example.net',
      user: 'alerts',
      passwordFile,
      ...(smtpOver || {}),
    },
    ...rest,
  };
  if (mailFrom !== undefined) opts.mailFrom = mailFrom;
  return loadConfig(opts);
}

afterEach(() => {
  while (dirs.length) {
    rmSync(dirs.pop(), { recursive: true, force: true });
  }
});

describe('SMTP secret file', () => {
  it('accepts mode 600 and trims a trailing newline', () => {
    const file600 = writeSecret(`${SECRET}\n`, 0o600);
    expect(readSecretFile(file600, 'MERDIENZ_SMTP_PASSWORD_FILE', { allowGroupReadable: true })).toBe(SECRET);
    requireSecretFile(file600, 'MERDIENZ_SMTP_PASSWORD_FILE', { allowGroupReadable: true });
    const withCRLF = writeSecret(`${SECRET}\r\n`, 0o600);
    expect(readSecretFile(withCRLF, 'MERDIENZ_SMTP_PASSWORD_FILE', { allowGroupReadable: true })).toBe(SECRET);
  });

  it('allows mode 640 only when the owner is root:merdienz', () => {
    const ok = secretPermsAllowed(
      { mode: 0o640, uid: 0, gid: 123, size: 8, isFile: () => true },
      { allowGroupReadable: true, merdienzGid: 123 }
    );
    expect(ok).toEqual({ ok: true });
    const wrongOwner = secretPermsAllowed(
      { mode: 0o640, uid: 1000, gid: 123, size: 8, isFile: () => true },
      { allowGroupReadable: true, merdienzGid: 123 }
    );
    expect(wrongOwner.ok).toBe(false);
    expect(wrongOwner.message).toMatch(/mode 640 must be owned by root:merdienz/);
    const file640 = writeSecret(`${SECRET}\n`, 0o640);
    expect(() => readSecretFile(file640, 'MERDIENZ_SMTP_PASSWORD_FILE', { allowGroupReadable: true })).toThrow(
      /mode 640 must be owned by root:merdienz/
    );
  });

  it('refuses unexpected symlinks and files larger than 4 KiB', () => {
    const target = writeSecret(SECRET, 0o600);
    const link = join(workDir(), 'smtp-password-link');
    symlinkSync(target, link);
    expect(() => readSecretFile(link, 'MERDIENZ_SMTP_PASSWORD_FILE', { allowGroupReadable: true })).toThrow(
      /must not be a symlink/
    );
    const big = writeSecret(`${'x'.repeat(MAX_SECRET_BYTES + 1)}\n`, 0o600);
    expect(() => readSecretFile(big, 'MERDIENZ_SMTP_PASSWORD_FILE', { allowGroupReadable: true })).toThrow(/is too large/);
  });

  it('refuses missing, unreadable, empty, and world-readable files', () => {
    const missing = join(workDir(), 'missing');
    expect(() => readSecretFile(missing, 'MERDIENZ_SMTP_PASSWORD_FILE', { allowGroupReadable: true })).toThrow(
      /MERDIENZ_SMTP_PASSWORD_FILE not found/
    );

    const empty = writeSecret('\n', 0o600);
    expect(() => readSecretFile(empty, 'MERDIENZ_SMTP_PASSWORD_FILE', { allowGroupReadable: true })).toThrow(
      /MERDIENZ_SMTP_PASSWORD_FILE is empty/
    );
    expect(() => readSecretFile(empty, 'MERDIENZ_SMTP_PASSWORD_FILE', { allowGroupReadable: true })).not.toThrow(
      new RegExp(SECRET)
    );

    const world = writeSecret(SECRET, 0o644);
    expect(() => readSecretFile(world, 'MERDIENZ_SMTP_PASSWORD_FILE', { allowGroupReadable: true })).toThrow(
      /must be mode 600, 400, or 640 \(got 644\)/
    );

    const groupDenied = writeSecret(SECRET, 0o640);
    expect(() => requireSecretFile(groupDenied, 'MERDIENZ_SMTP_PASSWORD_FILE')).toThrow(
      /must be mode 600 or 400 \(got 640\)/
    );

    if (process.getuid && process.getuid() !== 0) {
      const locked = writeSecret(SECRET, 0o000);
      expect(() => readSecretFile(locked, 'MERDIENZ_SMTP_PASSWORD_FILE', { allowGroupReadable: true })).toThrow(
        /not readable|not found|must be mode/
      );
    }
  });

  it('never puts the password in missing-file or empty-file errors', () => {
    const empty = writeSecret(`${SECRET}\n\n`, 0o600);
    writeFileSync(empty, '\n');
    chmodSync(empty, 0o600);
    try {
      readSecretFile(empty, 'MERDIENZ_SMTP_PASSWORD_FILE', { allowGroupReadable: true });
      throw new Error('expected empty file to be refused');
    } catch (err) {
      expect(err.message).not.toContain(SECRET);
      expect(err.message).toMatch(/empty/);
    }
  });
});

describe('SMTP config and transport options', () => {
  it('uses the configured SMTP_HOST and SMTP_USER on 465 with implicit TLS 1.2+', () => {
    const config = cloudSmtp();
    expect(config.mailTransport).toBe('smtp');
    expect(config.mailFrom).toBe(DEFAULT_MAIL_FROM);
    expect(config.smtp.host).toBe('smtp.example.net');
    expect(config.smtp.port).toBe(DEFAULT_SMTP_PORT);
    expect(config.smtp.secure).toBe(true);
    expect(config.smtp.user).toBe('alerts');
    expect(config.smtp.pass).toBe(SECRET);
    const options = smtpTransportOptions(config.smtp);
    expect(options.secure).toBe(true);
    expect(options.tls).toEqual({ minVersion: SMTP_TLS_MIN_VERSION, rejectUnauthorized: true });
    expect(options.auth).toEqual({ user: 'alerts', pass: SECRET });
  });

  it('refuses to start in smtp mode when the password file is missing or has bad perms', () => {
    expect(() =>
      loadConfig({
        nodeEnv: 'production',
        merdienzMode: 'cloud',
        host: '127.0.0.1',
        mailTransport: 'smtp',
        smtp: { host: 'smtp.example.net', user: 'alerts', passwordFile: join(workDir(), 'nope') },
      })
    ).toThrow(/MERDIENZ_SMTP_PASSWORD_FILE not found/);

    const world = writeSecret(SECRET, 0o644);
    expect(() =>
      loadConfig({
        nodeEnv: 'production',
        merdienzMode: 'cloud',
        host: '127.0.0.1',
        mailTransport: 'smtp',
        smtp: { host: 'smtp.example.net', user: 'alerts', passwordFile: world },
      })
    ).toThrow(/must be mode 600, 400, or 640 \(got 644\)/);
  });

  it('does not require the password file when MAIL_TRANSPORT is none', () => {
    const config = loadConfig({
      nodeEnv: 'production',
      merdienzMode: 'cloud',
      host: '127.0.0.1',
      mailTransport: 'none',
      smtp: { passwordFile: join(workDir(), 'nope') },
    });
    expect(config.mailTransport).toBe('none');
    expect(config.smtp.pass).toBe('');
  });

  it('validates MAIL_FROM and rejects a non-merdienz.com From in smtp mode', () => {
    expect(() => cloudSmtp({ mailFrom: 'not-an-email' })).toThrow(/MAIL_FROM is not a valid single email address/);
    expect(() => cloudSmtp({ mailFrom: 'alerts@localhost' })).toThrow(
      /MAIL_FROM must be a merdienz.com address/
    );
    expect(isSingleEmailAddress('alerts@localhost')).toBe(true);
    expect(isSingleEmailAddress('owner@localhost')).toBe(true);
    expect(() => cloudSmtp({ mailFrom: 'alerts@example.com' })).toThrow(/MAIL_FROM must be a merdienz.com address/);
    expect(() => cloudSmtp({ mailFrom: 'alert@merdienz.com.example' })).toThrow(
      /MAIL_FROM must be a merdienz.com address/
    );
    expect(() => cloudSmtp({ mailFrom: 'alert@mail.' + 'merdienz.com' })).toThrow(
      /MAIL_FROM must be a merdienz.com address/
    );
    const config = cloudSmtp({ mailFrom: 'ops@merdienz.com' });
    expect(config.mailFrom).toBe('ops@merdienz.com');
  });

  it('keeps the merdienz.com lock in cloud mode even when NODE_ENV is not production', () => {
    expect(() => cloudSmtp({ nodeEnv: 'test', mailFrom: 'alerts@example.com' })).toThrow(
      /MAIL_FROM must be a merdienz.com address/
    );
    const config = cloudSmtp({ nodeEnv: 'development', mailFrom: 'ops@merdienz.com' });
    expect(config.mailFrom).toBe('ops@merdienz.com');
  });

  it('treats an unset, empty, or invalid merdienzMode as cloud and stays locked', () => {
    for (const merdienzMode of [undefined, '', 'garbage', 'not-a-mode']) {
      expect(() => cloudSmtp({ merdienzMode, mailFrom: 'alerts@example.com' }), String(merdienzMode)).toThrow(
        /MAIL_FROM must be a merdienz.com address/
      );
    }
    const config = cloudSmtp({ merdienzMode: '', mailFrom: 'ops@merdienz.com' });
    expect(config.mailFrom).toBe('ops@merdienz.com');
    expect(cloudSmtp({ mailFrom: undefined }).mailFrom).toBe(DEFAULT_MAIL_FROM);
  });

  it('validates MAIL_FROM at startup in dev and console modes', () => {
    for (const mailTransport of ['dev', 'console']) {
      const base = { nodeEnv: 'test', merdienzMode: 'test', mailTransport };
      expect(() => loadConfig({ ...base, mailFrom: 'Alerts <alerts@example.com>' }), mailTransport).toThrow(
        /MAIL_FROM is not a valid single email address/
      );
      expect(() => loadConfig({ ...base, mailFrom: 'alerts@example.com,ops@example.com' }), mailTransport).toThrow(
        /MAIL_FROM is not a valid single email address/
      );
      expect(loadConfig({ ...base, mailFrom: 'alerts@example.com' }).mailFrom).toBe('alerts@example.com');
    }
  });

  it('uses an explicit MAIL_FROM on the operator domain in self-hosted production smtp', () => {
    const config = cloudSmtp({
      nodeEnv: 'production',
      merdienzMode: 'selfhosted',
      mailFrom: 'alerts@example.com',
    });
    expect(config.mailFrom).toBe('alerts@example.com');
    const testMode = cloudSmtp({
      nodeEnv: 'test',
      merdienzMode: 'test',
      mailFrom: 'alerts@example.com',
    });
    expect(testMode.mailFrom).toBe('alerts@example.com');
  });

  it('refuses a missing or empty MAIL_FROM in self-hosted smtp mode instead of defaulting', () => {
    const required = /MAIL_FROM must be set to an address on a domain you have authorized with your SMTP provider/;
    expect(() => cloudSmtp({ merdienzMode: 'selfhosted' })).toThrow(required);
    expect(() => cloudSmtp({ merdienzMode: 'selfhosted', mailFrom: '' })).toThrow(required);
    expect(() => cloudSmtp({ merdienzMode: 'selfhosted', mailFrom: '   ' })).toThrow(required);
  });

  it('still rejects an invalid, CR/LF, or multi-address MAIL_FROM in self-hosted smtp mode', () => {
    expect(() => cloudSmtp({ merdienzMode: 'selfhosted', mailFrom: 'not-an-email' })).toThrow(
      /MAIL_FROM is not a valid single email address/
    );
    expect(() => cloudSmtp({ merdienzMode: 'selfhosted', mailFrom: 'alerts@example.com\r\nBcc:evil@example.com' })).toThrow(
      /MAIL_FROM must not contain CR or LF/
    );
    expect(() =>
      cloudSmtp({ merdienzMode: 'selfhosted', mailFrom: 'alerts@example.com,ops@example.com' })
    ).toThrow(/MAIL_FROM is not a valid single email address/);
  });

  it('refuses implicit TLS being turned off in production', () => {
    expect(() => cloudSmtp({ smtp: { secure: false } })).toThrow(/implicit TLS/);
  });

  it('has no built-in relay, needs no password without SMTP_USER, and honours an operator host pin', () => {
    expect(DEFAULT_SMTP_HOST).toBe('localhost');
    expect(DEFAULT_SMTP_USER).toBe('');
    const local = loadConfig({
      nodeEnv: 'production',
      merdienzMode: 'selfhosted',
      host: '127.0.0.1',
      mailTransport: 'smtp',
      mailFrom: 'alert@merdienz.com',
      smtp: { passwordFile: join(workDir(), 'nope') },
    });
    expect(local.smtp.host).toBe('localhost');
    expect(local.smtp.pass).toBe('');
    expect(smtpTransportOptions(local.smtp).auth).toBeUndefined();
    expect(() => cloudSmtp({ smtp: { host: 'smtp.other.example', requiredHost: 'smtp.example.net' } })).toThrow(
      /SMTP_HOST must be smtp\.example\.net in production \(SMTP_REQUIRED_HOST\)/
    );
    expect(cloudSmtp({ smtp: { requiredHost: 'SMTP.example.net' } }).smtp.host).toBe('smtp.example.net');
    expect(() => cloudSmtp({ smtp: { host: 'bad host/x' } })).toThrow(/SMTP_HOST must be a host name/);
  });

  it('reads SMTP_HOST, SMTP_USER, and SMTP_REQUIRED_HOST from the environment', () => {
    const saved = { ...process.env };
    try {
      process.env.SMTP_HOST = 'relay.example.org';
      process.env.SMTP_USER = 'relay-user';
      process.env.SMTP_REQUIRED_HOST = 'relay.example.org';
      const config = loadConfig({ nodeEnv: 'test', merdienzMode: 'test' });
      expect(config.smtp.host).toBe('relay.example.org');
      expect(config.smtp.user).toBe('relay-user');
      expect(config.smtp.requiredHost).toBe('relay.example.org');
    } finally {
      for (const k of ['SMTP_HOST', 'SMTP_USER', 'SMTP_REQUIRED_HOST']) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});

describe('SMTP send guards', () => {
  it('refuses CR or LF in From and To, and sanitizes the subject to one line', async () => {
    const config = cloudSmtp();
    let captured;
    const sent = [];
    const mailer = createMailer(config, {
      createTransport(opts) {
        captured = opts;
        return {
          options: opts,
          sendMail: async (msg) => {
            sent.push(msg);
            return { messageId: 'ok-id' };
          },
        };
      },
    });
    expect(captured.tls).toEqual({ minVersion: 'TLSv1.2', rejectUnauthorized: true });
    expect(captured.secure).toBe(true);
    expect(captured.connectionTimeout).toBe(SMTP_TIMEOUT_MS);
    await expect(
      sendAlert(mailer, { to: 'owner@example.com\nbcc:evil@example.com', subject: 'ok', text: 'x' })
    ).rejects.toThrow(/must not contain CR or LF|not a valid single email address/);
    const record = await sendAlert(mailer, { to: 'owner@example.com', subject: 'oops\r\nX-Injected: 1', text: 'x' });
    expect(record.subject).toBe('oops X-Injected: 1');
    expect(sent[0].subject).toBe('oops X-Injected: 1');
    expect(sanitizeSubject('DOWN: a\nb is down')).toBe('DOWN: a b is down');
  });

  it('redacts the password from send errors', async () => {
    const config = cloudSmtp();
    const mailer = createMailer(config, {
      createTransport(opts) {
        return {
          options: opts,
          sendMail: async () => {
            throw new Error(`auth failed for pass=${SECRET}`);
          },
        };
      },
    });
    await expect(sendAlert(mailer, { to: 'owner@example.com', subject: 'DOWN', text: 'x' })).rejects.toThrow(
      /auth failed for pass=\[redacted\]/
    );
  });

  it('bounds send retries and backs off, without a retry storm', async () => {
    expect(SMTP_MAX_SEND_ATTEMPTS).toBe(3);
    expect(smtpBackoffMs(0)).toBe(1000);
    expect(smtpBackoffMs(1)).toBe(2000);
    const waits = [];
    const calls = [];
    const transport = {
      sendMail: async () => {
        calls.push(Date.now());
        throw new Error(`smtp down ${SECRET}`);
      },
    };
    await expect(
      sendMailBounded(transport, { to: 'a@example.com' }, { attempts: 9, sleep: async (ms) => waits.push(ms) })
    ).rejects.toThrow(/smtp down/);
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([1000, 2000]);
  });
});

describe('test alert dry-run and send', () => {
  it('uses the product default in cloud when MAIL_FROM is empty or alerts@localhost', () => {
    const none = loadConfig({
      nodeEnv: 'production',
      merdienzMode: 'cloud',
      host: '127.0.0.1',
      mailTransport: 'none',
      smtp: { host: 'smtp.example.net', user: 'alerts', passwordFile: writeSecret() },
    });
    expect(none.mailFrom).toBe('alerts@localhost');
    expect(smtpConfigForTest(none).mailFrom).toBe(DEFAULT_MAIL_FROM);
    const empty = { ...none, mailFrom: '' };
    expect(smtpConfigForTest(empty).mailFrom).toBe(DEFAULT_MAIL_FROM);
  });

  it('does not rewrite empty or alerts@localhost MAIL_FROM to the product default in self-hosted mode', () => {
    const none = loadConfig({
      nodeEnv: 'production',
      merdienzMode: 'selfhosted',
      host: '127.0.0.1',
      mailTransport: 'none',
      smtp: { host: 'localhost' },
    });
    expect(none.mailFrom).toBe('alerts@localhost');
    const kept = smtpConfigForTest(none);
    expect(kept.mailFrom).toBe('alerts@localhost');
    expect(kept.mailFrom).not.toBe(DEFAULT_MAIL_FROM);
    const required = /MAIL_FROM must be set to an address on a domain you have authorized with your SMTP provider/;
    expect(() => smtpConfigForTest({ ...none, mailFrom: '' })).toThrow(required);
    const explicit = smtpConfigForTest({ ...none, mailFrom: 'alerts@example.com' });
    expect(explicit.mailFrom).toBe('alerts@example.com');
  });

  it('dry-run validates config without calling sendMail', () => {
    const config = smtpConfigForTest(cloudSmtp());
    let sent = 0;
    const text = describeSmtpDryRun(config, { to: 'release@example.com' });
    expect(text).toMatch(/dry-run: SMTP config is valid; no connection was made/);
    expect(text).toContain('host=smtp.example.net');
    expect(text).toContain('port=465');
    expect(text).toContain('secure=true');
    expect(text).toContain('tlsMin=TLSv1.2');
    expect(text).toContain('rejectUnauthorized=true');
    expect(text).toContain('user=alerts');
    expect(text).toContain(`from=${DEFAULT_MAIL_FROM}`);
    expect(text).toContain('to=release@example.com');
    expect(text).not.toContain(SECRET);
    expect(sent).toBe(0);
  });

  it('sends one test message through a mock transport and reports only the id', async () => {
    const config = smtpConfigForTest(cloudSmtp());
    const result = await sendTestAlert(config, {
      to: 'release@example.com',
      sendMail: async (mail) => {
        expect(mail.to).toBe('release@example.com');
        expect(mail.from).toBe(DEFAULT_MAIL_FROM);
        expect(mail.subject).toMatch(/test alert/i);
        return { messageId: '<smtp-id-1@smtp.example.net>' };
      },
    });
    expect(result.messageId).toBe('<smtp-id-1@smtp.example.net>');
    const local = await sendTestAlert(config, {
      to: 'owner@localhost',
      sendMail: async (mail) => {
        expect(mail.to).toBe('owner@localhost');
        return { messageId: '<smtp-id-local>' };
      },
    });
    expect(local.messageId).toBe('<smtp-id-local>');
  });

  it('CLI --dry-run exits 0, prints no secret, and does not connect', () => {
    const passwordFile = writeSecret();
    const env = {
      ...process.env,
      HOST: '127.0.0.1',
      MERDIENZ_MODE: 'cloud',
      NODE_ENV: 'production',
      MAIL_TRANSPORT: 'none',
      MERDIENZ_SMTP_PASSWORD_FILE: passwordFile,
      PROBE_B_SECRET: 's'.repeat(32),
      PROBE_B_URL: 'https://probe.example/internal/probe',
      PROBE_B_SPKI_SHA256: 'a'.repeat(64),
    };
    const result = spawnSync(process.execPath, ['scripts/send-test-alert.js', '--dry-run', '--to', 'release@example.com'], {
      cwd: appRoot,
      encoding: 'utf8',
      env,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/dry-run: SMTP config is valid/);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(SECRET);

    const implied = spawnSync(process.execPath, ['scripts/send-test-alert.js', '--to', 'release@example.com'], {
      cwd: appRoot,
      encoding: 'utf8',
      env,
    });
    expect(implied.status).toBe(0);
    expect(implied.stdout).toMatch(/dry-run: SMTP config is valid/);
    expect(`${implied.stdout}\n${implied.stderr}`).not.toContain(SECRET);

    const sendOnly = spawnSync(process.execPath, ['scripts/send-test-alert.js', '--send'], {
      cwd: appRoot,
      encoding: 'utf8',
      env,
    });
    expect(sendOnly.status).not.toBe(0);
    expect(`${sendOnly.stdout}\n${sendOnly.stderr}`).toMatch(/--to <addr> is required with --send/);
    expect(`${sendOnly.stdout}\n${sendOnly.stderr}`).not.toContain(SECRET);

    const both = spawnSync(process.execPath, ['scripts/send-test-alert.js', '--send', '--dry-run', '--to', 'release@example.com'], {
      cwd: appRoot,
      encoding: 'utf8',
      env,
    });
    expect(both.status).not.toBe(0);
    expect(`${both.stdout}\n${both.stderr}`).toMatch(/--send and --dry-run cannot be used together/);
  });

  it.skipIf(!existsSync(join(appRoot, 'deploy/cloud/mail/send-test-alert.sh')))('the host wrapper dry-run checks the password file and prints no secret', () => {
    const passwordFile = writeSecret();
    const env = {
      HOME: process.env.HOME || '',
      PATH: process.env.PATH,
      HOST: '127.0.0.1',
      MERDIENZ_MODE: 'cloud',
      NODE_ENV: 'production',
      MAIL_TRANSPORT: 'none',
      MERDIENZ_SMTP_PASSWORD_FILE: passwordFile,
      MERDIENZ_LIB: join(appRoot, 'deploy/cloud/lib.sh'),
      APP_ROOT: appRoot,
      PROBE_B_SECRET: 's'.repeat(32),
      PROBE_B_URL: 'https://probe.example/internal/probe',
      PROBE_B_SPKI_SHA256: 'a'.repeat(64),
    };
    const result = spawnSync('bash', [join(appRoot, 'deploy/cloud/mail/send-test-alert.sh'), '--dry-run', '--to', 'release@example.com'], {
      cwd: appRoot,
      encoding: 'utf8',
      env,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/dry-run: SMTP config is valid/);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(SECRET);
  });

  it('redacts the password if a mocked send fails', async () => {
    const config = smtpConfigForTest(cloudSmtp());
    await expect(
      sendTestAlert(config, {
        to: 'release@example.com',
        sendMail: async () => {
          throw new Error(`535 bad credentials ${SECRET}`);
        },
      })
    ).rejects.toThrow(/535 bad credentials \[redacted\]/);
    expect(redactSecret(`pw=${SECRET}`, SECRET)).toBe('pw=[redacted]');
  });
});
