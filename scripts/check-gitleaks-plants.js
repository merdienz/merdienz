import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function findGitleaks() {
  if (process.env.GITLEAKS && existsSync(process.env.GITLEAKS)) return process.env.GITLEAKS;
  const candidates = ['gitleaks', '/tmp/gitleaks'];
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['version'], { stdio: 'ignore' });
      return bin;
    } catch {
      // try next
    }
  }
  return null;
}

function plantKeys() {
  const hex = (n) => randomBytes(n).toString('hex');
  // aws-access-token is AKIA/ASIA plus 16 chars from A-Z and 2-7 (no 0, 1, 8, 9).
  const aws = ['AKI', 'A', 'J2K7', 'MPQR', 'SWXY', 'Z234'].join('');
  const github = ['ghp', '_', hex(20)].join('');
  const stripe = ['sk', 'live', hex(12)].join('_');
  return { github, aws, stripe };
}


const ALLOW_MARK = ['gitleaks', 'allow'].join(':');
const ALLOW_PLACEHOLDER_RE = new RegExp(`^# [A-Z_]+= # ${ALLOW_MARK}$`);

export function assertAllowComments(rootDir = root) {
  const skip = new Set(['node_modules', '.git', 'web', 'coverage', 'dist', 'build']);
  const offenders = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (skip.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!st.isFile() || st.size > 1024 * 1024) continue;
      let text;
      try {
        text = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      for (const [i, line] of text.split('\n').entries()) {
        if (line.includes(ALLOW_MARK) && !ALLOW_PLACEHOLDER_RE.test(line)) {
          offenders.push(`${full}:${i + 1}`);
        }
      }
    }
  };
  walk(rootDir);
  if (offenders.length) {
    throw new Error(`${ALLOW_MARK} is only allowed on empty placeholders\n${offenders.join('\n')}`);
  }
  return { ok: true };
}

export function runPlantCheck(gitleaksBin) {
  assertAllowComments();
  const keys = plantKeys();
  const dir = mkdtempSync(join(tmpdir(), 'merdienz-gitleaks-plants-'));
  try {
    mkdirSync(join(dir, 'tests'));
    const exampleSrc = readFileSync(join(root, '.env.example'), 'utf8');
    const testSrc = 'export const sample = true;\n';
    const blob = `\nplanted=${keys.github}\nplanted=${keys.aws}\nplanted=${keys.stripe}\n`;
    writeFileSync(join(dir, '.env.example'), exampleSrc + blob);
    writeFileSync(join(dir, 'tests/planted.test.js'), testSrc + blob);
    writeFileSync(join(dir, '.gitleaks.toml'), readFileSync(join(root, '.gitleaks.toml')));
    let out = '';
    let status = 0;
    try {
      out = execFileSync(
        gitleaksBin,
        ['detect', '--no-git', '--source', dir, '--config', join(dir, '.gitleaks.toml'), '--verbose', '--no-banner', '--redact'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
    } catch (err) {
      status = err.status ?? 1;
      out = `${err.stdout || ''}\n${err.stderr || ''}`;
    }
    if (status === 0) {
      throw new Error('gitleaks reported no findings for planted keys');
    }
    const lower = out.toLowerCase();
    const missing = [];
    if (!/github-pat|github/i.test(out)) missing.push('GitHub');
    if (!/aws-access-token|yandex-aws-access-token/i.test(out)) missing.push('AWS');
    if (!/stripe-access-token|stripe/i.test(out)) missing.push('Stripe');
    const inExample = /env\.example/i.test(out);
    const inTests = /tests\//i.test(out);
    if (missing.length || !inExample || !inTests) {
      throw new Error(
        `gitleaks plant check incomplete (missing=${missing.join(',') || 'none'} example=${inExample} tests=${inTests})\n${out}`
      );
    }
    return { ok: true, status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check-gitleaks-plants.js')) {
  const bin = findGitleaks();
  if (!bin) {
    console.error('gitleaks binary not found');
    process.exit(2);
  }
  try {
    runPlantCheck(bin);
    console.log('gitleaks plant check ok');
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}
