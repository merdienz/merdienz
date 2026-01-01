import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withApp } from './helpers.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const web = join(root, 'web');
// Hosting-provider names are checked by hash with the maintainers' optional extension, which is
// not part of the public source; without it this check is skipped.
const extraPath = join(root, 'scripts', 'public-refs-extra.js');
const extra = existsSync(extraPath) ? await import(pathToFileURL(extraPath).href) : null;
const providerHashes = extra ? extra.loadProviderHashes() : new Set();
const hasProvider = (text) => (extra ? extra.providerHits(text, providerHashes).length > 0 : false);
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;
// URL strings that may appear in the bundle without loading anything:
// XML namespaces, React's error-text link, and the URL field placeholder.
const ALLOWED_URLS = new Set([
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/1999/xlink',
  'http://www.w3.org/1998/Math/MathML',
  'http://www.w3.org/XML/1998/namespace',
  'https://react.dev/errors/',
  'https://example.com',
]);
const FONTS = ['space-grotesk.woff2', 'instrument-sans.woff2', 'jetbrains-mono.woff2'];
const LICENSES = ['OFL-SpaceGrotesk.txt', 'OFL-InstrumentSans.txt', 'OFL-JetBrainsMono.txt'];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

let out;
let textFiles;
beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), 'mdz-dist-'));
  execFileSync(process.execPath, [join(web, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], {
    cwd: web,
    stdio: 'pipe',
    env: { ...process.env, NODE_ENV: 'production' },
  });
  textFiles = walk(out).filter((f) => /\.(html|js|css)$/.test(f));
}, 120000);
afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

describe('built dashboard', () => {
  test('has the new dashboard marker, keeps sign-up, and ships no prototype-only parts', () => {
    const js = textFiles.filter((f) => f.endsWith('.js')).map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(js).toContain('overview-v2');
    expect(js).toContain('Uptime overview');
    expect(js).toContain('Create your Merdienz account');
    expect(js).toContain('Sign in to Merdienz');
    for (const banned of ['Example data', 'example data', 'Preview state', 'prototype only', 'stateSel']) expect(js).not.toContain(banned);
  });

  test('bundles the three fonts with their OFL licenses and loads them only from this origin', () => {
    for (const f of FONTS) {
      const built = readFileSync(join(out, 'fonts', f));
      expect(built.subarray(0, 4).toString('latin1')).toBe('wOF2');
      expect(built.equals(readFileSync(join(web, 'public/fonts', f)))).toBe(true);
    }
    for (const l of LICENSES) expect(readFileSync(join(out, 'fonts', l), 'utf8')).toContain('SIL OPEN FONT LICENSE');
    const css = textFiles.filter((f) => f.endsWith('.css')).map((f) => readFileSync(f, 'utf8')).join('\n');
    const faces = [...css.matchAll(/@font-face\{[^}]*font-family:\s*["']?([^;"']+)/g)].map((m) => m[1]).sort();
    expect(faces).toEqual(['Instrument Sans', 'JetBrains Mono', 'Space Grotesk']);
    const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)/g)].map((m) => m[1]);
    expect(urls.filter((u) => u.startsWith('/fonts/')).sort()).toEqual(FONTS.map((f) => `/fonts/${f}`).sort());
    for (const u of urls) expect(u.startsWith('/fonts/') || u.startsWith('#') || u.startsWith('data:')).toBe(true);
  });

  test('makes no external requests: every URL in the html, js and css is on the allowlist', () => {
    for (const f of textFiles) {
      const text = readFileSync(f, 'utf8');
      const found = text.match(/https?:\/\/[A-Za-z0-9._~%/-]+/g) || [];
      for (const u of found) expect(ALLOWED_URLS.has(u), `${relative(out, f)}: ${u}`).toBe(true);
      expect(text).not.toMatch(/\/\/fonts\.(googleapis|gstatic)|cdn\.|unpkg|jsdelivr/i);
    }
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/\sstyle=/);
  });

  test('has no hosting provider names or IP addresses in the dist or the web source', () => {
    const files = [...textFiles, ...walk(join(web, 'src')), join(web, 'index.html')];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      expect(hasProvider(text), `${f}: provider name`).toBe(false);
      expect(IPV4.test(text), `${f}: IPv4 literal`).toBe(false);
    }
  });
});

describe('content security policy', () => {
  test('still allows fonts, styles and scripts from this origin only', async () => {
    await withApp(async ({ app }) => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      const csp = res.headers['content-security-policy'] || '';
      expect(csp).toMatch(/font-src 'self'(;|$)/);
      expect(csp).toMatch(/style-src 'self'(;|$)/);
      expect(csp).toMatch(/script-src 'self'(;|$)/);
      expect(csp).toMatch(/connect-src 'self'(;|$)/);
      expect(csp).not.toMatch(/unsafe-inline|https?:/);
    });
  });
});
