import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHeader, createUser, withApp } from './helpers.js';

const spaDist = fileURLToPath(new URL('../web/dist', import.meta.url));
const spaIndexHtml =
  '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>Merdienz</title></head><body><div id="root"></div></body></html>\n';
const chromeAccept =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';

function withSpaIndex() {
  beforeEach(() => {
    mkdirSync(spaDist, { recursive: true });
    writeFileSync(join(spaDist, 'index.html'), spaIndexHtml);
  });
  afterEach(() => {
    rmSync(spaDist, { recursive: true, force: true });
  });
}

function expectSpaIndex(res) {
  expect(res.statusCode).toBe(200);
  expect(String(res.headers['content-type'] || '')).toMatch(/text\/html/i);
  const body = res.body || '';
  expect(body).toMatch(/<!DOCTYPE html>/i);
  expect(body).toContain('<div id="root">');
  expect(body.trimStart().startsWith('{')).toBe(false);
}

function expectPublicJson(res, { slug, title, checkName }) {
  expect(res.statusCode).toBe(200);
  expect(String(res.headers['content-type'] || '')).toMatch(/application\/json/i);
  const body = res.json();
  expect(body.slug).toBe(slug);
  expect(body.title).toBe(title);
  expect(body).toHaveProperty('generated_at');
  expect(body).toHaveProperty('overall');
  expect(Array.isArray(body.checks)).toBe(true);
  expect(body.checks).toHaveLength(1);
  expect(body.checks[0].name).toBe(checkName);
  expect(body.checks[0]).not.toHaveProperty('url');
  return body;
}

describe('public status page', () => {
  it('shows only opted-in checks, 404s unknown slugs, and never leaks private data', async () => {
    await withApp(async ({ app, db }) => {
      const owner = await createUser(db, { email: 'owner@example.com', password: 'secret', tier: 'selfhosted' });
      const other = await createUser(db, { email: 'other@example.com', tier: 'selfhosted' });

      const page = await app.inject({
        method: 'PUT',
        url: '/status-page',
        headers: { ...authHeader(owner), 'content-type': 'application/json' },
        payload: { title: 'Acme status', slug: 'acme' },
      });
      expect(page.statusCode).toBe(200);
      expect(page.json().status_page.slug).toBe('acme');

      const publicSite = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: { ...authHeader(owner), 'content-type': 'application/json' },
        payload: { name: 'Public site', url: 'https://example.com/public', public_on_status: true },
      });
      const privateSite = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: { ...authHeader(owner), 'content-type': 'application/json' },
        payload: { name: 'Private staging', url: 'https://example.com/staging' },
      });
      expect(privateSite.statusCode).toBe(200);
      expect(privateSite.json().public_on_status).toBe(false);

      const publicHb = await app.inject({
        method: 'POST',
        url: '/heartbeats',
        headers: { ...authHeader(owner), 'content-type': 'application/json' },
        payload: { name: 'Public backup', period_seconds: 3600, public_on_status: true },
      });
      const privateHb = await app.inject({
        method: 'POST',
        url: '/heartbeats',
        headers: { ...authHeader(owner), 'content-type': 'application/json' },
        payload: { name: 'Secret cron', period_seconds: 60 },
      });

      await app.inject({
        method: 'POST',
        url: '/sites',
        headers: { ...authHeader(other), 'content-type': 'application/json' },
        payload: { name: 'Other team site', url: 'https://example.com/other', public_on_status: true },
      });

      const missing = await app.inject({ method: 'GET', url: '/status/does-not-exist' });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: 'not found', code: 'NOT_FOUND' });

      const res = await app.inject({ method: 'GET', url: '/status/acme' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.title).toBe('Acme status');
      expect(body.slug).toBe('acme');
      expect(body.checks.map((c) => c.name).sort()).toEqual(['Public backup', 'Public site']);
      const httpCheck = body.checks.find((c) => c.type === 'http');
      expect(httpCheck.name).toBe('Public site');
      expect(httpCheck).not.toHaveProperty('url');
      expect(JSON.stringify(body)).not.toContain('example.com');
      expect(body.checks.find((c) => c.type === 'heartbeat').bars).toBeTruthy();

      const payload = JSON.stringify(body);
      expect(payload).not.toContain('Private staging');
      expect(payload).not.toContain('example.com/staging');
      expect(payload).not.toContain('Secret cron');
      expect(payload).not.toContain('Other team site');
      expect(payload).not.toContain(owner.email);
      expect(payload).not.toContain(owner.apiKey);
      expect(payload).not.toContain(owner.id);
      expect(payload).not.toContain(privateHb.json().ping_urls.success);
      expect(payload).not.toContain(publicHb.json().ping_token || 'ping_token');
      expect(payload).not.toMatch(/mrz_/);
      expect(body).not.toHaveProperty('user_id');
      expect(payload).not.toContain(privateSite.json().id);
    });
  });

  it('toggles a site onto the public page with PATCH and still rejects a tier override', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'toggle@example.com' });
      await app.inject({
        method: 'PUT',
        url: '/status-page',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { title: 'Toggles', slug: 'toggles' },
      });
      const created = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { name: 'Later public', url: 'https://example.com/later' },
      });
      const denied = await app.inject({
        method: 'PATCH',
        url: `/sites/${created.json().id}`,
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { public_on_status: true, tier: 'cloud' },
      });
      expect(denied.statusCode).toBe(400);
      const ok = await app.inject({
        method: 'PATCH',
        url: `/sites/${created.json().id}`,
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { public_on_status: true },
      });
      expect(ok.json().public_on_status).toBe(true);
      const page = await app.inject({ method: 'GET', url: '/status/toggles' });
      expect(page.json().checks).toHaveLength(1);
    });
  });
});

function cookieHeader(parts) {
  return parts.filter(Boolean).join('; ');
}

describe('status page hardening', () => {
  it('applies CSP, rejects NUL input, and keeps one user from reaching another user\'s admin page', async () => {
    await withApp(async ({ app, db }) => {
      const owner = await createUser(db, { email: 'owner2@example.com', password: 'secret' });
      const other = await createUser(db, { email: 'other2@example.com' });
      const created = await app.inject({
        method: 'PUT',
        url: '/status-page',
        headers: { ...authHeader(owner), 'content-type': 'application/json' },
        payload: { title: 'Owner', slug: 'owner-page' },
      });
      expect(created.statusCode).toBe(200);
      const pageId = created.json().status_page.id;

      const nul = await app.inject({
        method: 'PUT',
        url: '/status-page',
        headers: { ...authHeader(owner), 'content-type': 'application/json' },
        payload: { title: 'bad\u0000title', slug: 'owner-page' },
      });
      expect(nul.statusCode).toBe(400);

      const otherList = await app.inject({
        method: 'GET',
        url: '/status-page',
        headers: authHeader(other),
      });
      expect(otherList.statusCode).toBe(200);
      expect(otherList.json().status_page).toBeNull();
      expect(otherList.json().status_pages).toEqual([]);

      const stolen = await app.inject({
        method: 'PATCH',
        url: `/status-page/${pageId}`,
        headers: { ...authHeader(other), 'content-type': 'application/json' },
        payload: { title: 'Stolen' },
      });
      expect(stolen.statusCode).toBe(404);

      const clash = await app.inject({
        method: 'PUT',
        url: '/status-page',
        headers: { ...authHeader(other), 'content-type': 'application/json' },
        payload: { title: 'Clash', slug: 'owner-page' },
      });
      expect(clash.statusCode).toBe(409);
      expect(clash.json().code).toBe('SLUG_TAKEN');

      const publicPage = await app.inject({ method: 'GET', url: '/status/owner-page' });
      expect(publicPage.statusCode).toBe(200);
      const csp = publicPage.headers['content-security-policy'] || '';
      expect(csp).toMatch(/default-src 'self'/);
      expect(csp).toMatch(/script-src 'self'/);
      expect(csp).not.toMatch(/unsafe-inline/);
    });
  });

  it('rejects a cookie-only status-page write without a CSRF token', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'csrf-status@example.com', password: 'secret' });
      const login = await app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: { email: user.email, password: 'secret' },
      });
      const session = login.json().token;
      const denied = await app.inject({
        method: 'PUT',
        url: '/status-page',
        headers: {
          cookie: `session=${session}`,
          'content-type': 'application/json',
        },
        payload: { title: 'No token', slug: 'no-token' },
      });
      expect(denied.statusCode).toBe(403);

      const csrfRes = await app.inject({ method: 'GET', url: '/csrf-token' });
      const csrfCookies = (csrfRes.cookies || [])
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');
      const token = csrfRes.json().csrf;
      const ok = await app.inject({
        method: 'PUT',
        url: '/status-page',
        headers: {
          cookie: cookieHeader([`session=${session}`, csrfCookies]),
          'content-type': 'application/json',
          'x-csrf-token': token,
        },
        payload: { title: 'With token', slug: 'with-token' },
      });
      expect(ok.statusCode).toBe(200);
    });
  });
});

describe('public status page URL privacy', () => {
  withSpaIndex();

  it('never publishes the monitored URL, including userinfo and query tokens', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'secret-url@example.com' });
      const secretUrl = 'https://user:pw-SECRET1@example.com/health?token=SECRET2';
      await db.query(
        `INSERT INTO sites (user_id, name, url, public_on_status)
         VALUES ($1, 'Named site only', $2, true)`,
        [user.id, secretUrl]
      );
      await app.inject({
        method: 'PUT',
        url: '/status-page',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { title: 'Public board', slug: 'secret-board' },
      });

      const json = await app.inject({
        method: 'GET',
        url: '/status/secret-board',
        headers: { accept: 'application/json' },
      });
      expect(json.statusCode).toBe(200);
      const body = json.json();
      expect(body.checks).toHaveLength(1);
      expect(body.checks[0].name).toBe('Named site only');
      expect(body.checks[0]).not.toHaveProperty('url');
      const jsonText = JSON.stringify(body);
      expect(jsonText).not.toContain('SECRET1');
      expect(jsonText).not.toContain('SECRET2');
      expect(jsonText).not.toContain('user:pw');
      expect(jsonText).not.toContain('token=');
      expect(jsonText).not.toContain('example.com');
      expect(jsonText).not.toContain(secretUrl);

      const html = await app.inject({
        method: 'GET',
        url: '/status/secret-board',
        headers: { accept: 'text/html' },
      });
      expectSpaIndex(html);
      const htmlText = html.body || '';
      expect(htmlText).not.toContain('SECRET1');
      expect(htmlText).not.toContain('SECRET2');
      expect(htmlText).not.toContain('user:pw');
      expect(htmlText).not.toContain('token=SECRET2');
      expect(htmlText).not.toContain(secretUrl);
    });
  });

  describe('serves the SPA index or JSON by Accept', () => {
    withSpaIndex();

    async function seedPublicBoard({ app, db }) {
      const user = await createUser(db, { email: 'accept-split@example.com' });
      const secretUrl = 'https://user:pw-SECRET1@status-host.example/health?token=SECRET2';
      await db.query(
        `INSERT INTO sites (user_id, name, url, public_on_status)
         VALUES ($1, 'Named site only', $2, true)`,
        [user.id, secretUrl]
      );
      await app.inject({
        method: 'PUT',
        url: '/status-page',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { title: 'Public board', slug: 'secret-board' },
      });
      return secretUrl;
    }

    function expectNoUrlTokens(payload, secretUrl) {
      expect(payload).not.toContain('SECRET1');
      expect(payload).not.toContain('SECRET2');
      expect(payload).not.toContain('user:pw');
      expect(payload).not.toContain('token=');
      expect(payload).not.toContain('status-host.example');
      expect(payload).not.toContain(secretUrl);
    }

    it('returns the SPA index for a Chrome Accept string and for Accept: text/html', async () => {
      await withApp(async ({ app, db }) => {
        const secretUrl = await seedPublicBoard({ app, db });
        for (const accept of [chromeAccept, 'text/html']) {
          const html = await app.inject({
            method: 'GET',
            url: '/status/secret-board',
            headers: { accept },
          });
          expectSpaIndex(html);
          expect(html.body).not.toContain('SECRET1');
          expect(html.body).not.toContain('SECRET2');
          expect(html.body).not.toContain(secretUrl);
        }
      });
    });

    it('returns the public JSON shape for Accept: application/json and when Accept is omitted', async () => {
      await withApp(async ({ app, db }) => {
        const secretUrl = await seedPublicBoard({ app, db });
        for (const headers of [{ accept: 'application/json' }, {}]) {
          const json = await app.inject({
            method: 'GET',
            url: '/status/secret-board',
            headers,
          });
          const body = expectPublicJson(json, {
            slug: 'secret-board',
            title: 'Public board',
            checkName: 'Named site only',
          });
          expectNoUrlTokens(JSON.stringify(body), secretUrl);
        }
      });
    });
  });
});

describe('status page slug updates', () => {
  it('does not rename an existing slug on PUT unless that slug is already the page', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'slug-keep@example.com' });
      const created = await app.inject({
        method: 'PUT',
        url: '/status-page',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { title: 'Original', slug: 'keep-me' },
      });
      expect(created.statusCode).toBe(200);
      expect(created.json().status_page.slug).toBe('keep-me');

      const titleOnly = await app.inject({
        method: 'PUT',
        url: '/status-page',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { title: 'Retitled' },
      });
      expect(titleOnly.statusCode).toBe(200);
      expect(titleOnly.json().status_page.slug).toBe('keep-me');
      expect(titleOnly.json().status_page.title).toBe('Retitled');

      const sameSlug = await app.inject({
        method: 'PUT',
        url: '/status-page',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { title: 'Still mine', slug: 'keep-me' },
      });
      expect(sameSlug.json().status_page.slug).toBe('keep-me');

      const otherSlug = await app.inject({
        method: 'PUT',
        url: '/status-page',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { title: 'Another', slug: 'brand-new' },
      });
      expect(otherSlug.statusCode).toBe(200);
      expect(otherSlug.json().status_page.slug).toBe('brand-new');

      const listed = await app.inject({ method: 'GET', url: '/status-page', headers: authHeader(user) });
      const slugs = listed.json().status_pages.map((p) => p.slug).sort();
      expect(slugs).toEqual(['brand-new', 'keep-me']);
      const old = await app.inject({ method: 'GET', url: '/status/keep-me' });
      expect(old.statusCode).toBe(200);
      expect(old.json().title).toBe('Still mine');
    });
  });
});
