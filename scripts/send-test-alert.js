#!/usr/bin/env node
import { loadConfig } from '../src/config.js';
import { describeSmtpDryRun, sendTestAlert, smtpConfigForTest } from '../src/alerts/test-alert.js';
import { redactSecret } from '../src/alerts/smtp-config.js';

function usage(code = 0) {
  const out = code === 0 ? process.stdout : process.stderr;
  out.write(`Usage: node scripts/send-test-alert.js [--dry-run] [--to <addr>]
       node scripts/send-test-alert.js --send --to <addr>
       npm run mail:test -- --dry-run --to <addr>
       npm run mail:test -- --send --to <addr>

Validates the SMTP password file and settings. --dry-run (the default)
makes no connection. A live send requires both --send and --to, and
prints only the SMTP response id.
`);
  process.exit(code);
}

function parseArgs(argv) {
  let to = '';
  let dryRun = false;
  let send = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') usage(0);
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--send') {
      send = true;
      continue;
    }
    if (arg === '--to') {
      to = argv[i + 1] || '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--to=')) {
      to = arg.slice('--to='.length);
      continue;
    }
    usage(2);
  }
  return { to, dryRun, send };
}

let smtpPass = '';
try {
  const { to, dryRun, send } = parseArgs(process.argv.slice(2));
  if (send && dryRun) {
    process.stderr.write('error: --send and --dry-run cannot be used together\n');
    usage(2);
  }
  const base = loadConfig();
  const config = smtpConfigForTest(base);
  smtpPass = config.smtp?.pass || '';
  if (!send) {
    process.stdout.write(`${describeSmtpDryRun(config, { to: to || undefined })}\n`);
    process.exit(0);
  }
  if (!to) {
    process.stderr.write('error: --to <addr> is required with --send\n');
    usage(2);
  }
  const result = await sendTestAlert(config, { to });
  const id = String(result.messageId || '').trim();
  process.stdout.write(id ? `${id}\n` : 'sent\n');
} catch (err) {
  process.stderr.write(`${redactSecret(err && err.message, smtpPass) || 'test alert failed'}\n`);
  process.exit(1);
}
