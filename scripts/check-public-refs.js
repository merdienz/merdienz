import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allowPath = join(root, 'scripts', 'ipv4-allowlist.txt');
const allow = new Set(
  readFileSync(allowPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
);

// An optional maintainer extension (hashed hosting-provider list, private name and path
// patterns) is not part of the public source. When it is present, its checks also run here.
const scrubModule = join(root, 'scripts', 'public-refs-extra.js');
const scrub = existsSync(scrubModule) ? await import(pathToFileURL(scrubModule).href) : null;
const providerHashes = scrub ? scrub.loadProviderHashes() : new Set();
const allowlist = scrub ? scrub.loadAllowlist() : [];
const privatePatterns = scrub ? scrub.loadPrivatePatterns() : null;
const internalPatterns = privatePatterns ? privatePatterns.internal : [];
const hashCache = new Map();
const providerIn = (file, line) =>
  scrub
    ? scrub.providerHits(line, providerHashes, hashCache).filter((id) => !scrub.isAllowed(allowlist, 'provider', file, id)).length > 0
    : false;
const internalIn = (line) => internalPatterns.some((re) => re.test(line));
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;
const BINARY = /\.(?:woff2?|png|jpe?g|gif|ico|webp|bmp|pdf|zip|gz|tgz|woff)$/i;

function fail(message, status = 1) {
  console.error(message);
  process.exit(status);
}

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function gitFiles() {
  try {
    const out = git(['ls-files', '-z']);
    return out.split('\0').filter(Boolean);
  } catch (err) {
    fail(`public-refs check failed: could not list files (${err.message || err})`);
  }
}

function isTestOrFixture(file) {
  const rel = file.replace(/\\/g, '/');
  return (
    rel.startsWith('tests/') ||
    rel.includes('/fixtures/') ||
    rel.startsWith('fixtures/') ||
    rel === 'scripts/ipv4-allowlist.txt'
  );
}

function commitLogForRange(range) {
  try {
    git(['rev-parse', '--verify', range.split('..')[0] || range]);
  } catch (err) {
    fail(`public-refs check failed: missing or unreadable ref ${range}`);
  }
  try {
    return git(['log', '--format=%s%n%b', range]);
  } catch (err) {
    fail(`public-refs check failed: could not read commit messages for ${range} (${err.message || err})`);
  }
}

function commitLog() {
  const rangeFlag = process.argv.indexOf('--range');
  if (rangeFlag !== -1) {
    const range = process.argv[rangeFlag + 1];
    if (!range) fail('public-refs check failed: --range requires a git revision range');
    return commitLogForRange(range);
  }

  try {
    const mergeBase = git(['merge-base', 'origin/main', 'HEAD']).trim();
    return git(['log', '--format=%s%n%b', `${mergeBase}..HEAD`]);
  } catch {
    try {
      return git(['log', '--format=%s%n%b']);
    } catch (err) {
      fail(`public-refs check failed: could not scan commit history (${err.message || err})`);
    }
  }
}

const skip = new Set(['package-lock.json', 'web/package-lock.json']);
const errors = [];
for (const file of gitFiles()) {
  if (skip.has(file) || file.startsWith('node_modules/') || file.startsWith('web/dist/')) continue;
  if (BINARY.test(file)) continue;
  const full = join(root, file);
  if (!existsSync(full)) continue;
  let text;
  try {
    text = readFileSync(full, 'utf8');
  } catch {
    continue;
  }
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (providerIn(file, line)) {
      errors.push(`${file}:${i + 1}: hosting-provider name is not allowed`);
    }
    if (internalIn(line)) {
      errors.push(`${file}:${i + 1}: internal path or workspace name is not allowed`);
    }
    if (!isTestOrFixture(file)) {
      const matches = line.match(new RegExp(IPV4, 'g')) || [];
      for (const ip of matches) {
        if (!allow.has(ip)) {
          errors.push(`${file}:${i + 1}: unexpected IPv4 literal ${ip}`);
        }
      }
    }
  });
}

let log;
try {
  log = commitLog();
} catch (err) {
  // commitLog already exits on failure; this is a last-resort guard
  fail(`public-refs check failed: ${err.message || err}`);
}

if (log.split('\n').some((line) => providerIn('commit message', line))) {
  errors.push('commit message: hosting-provider name is not allowed');
}
if (log.split('\n').some(internalIn)) {
  errors.push('commit message: internal path or workspace name is not allowed');
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('public-refs check ok');
