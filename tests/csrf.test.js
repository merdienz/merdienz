import { describe, expect, it } from 'vitest';
import { createUser, withApp } from './helpers.js';

function cookieHeader(parts) {
  return parts.filter(Boolean).join('; ');
}

describe('CSRF on cookie-authenticated writes', () => {
  it('rejects a cookie-only POST /sites without a CSRF token with 403', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'csrf@example.com', password: 'a-long-password' });
      const login = await app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: { email: user.email, password: user.password },
      });
      expect(login.statusCode).toBe(200);
      const session = login.json().token;
      const denied = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: {
          cookie: `session=${session}`,
          'content-type': 'application/json',
        },
        payload: { name: 'Cookie site', url: 'https://example.com' },
      });
      expect(denied.statusCode).toBe(403);

      const csrfRes = await app.inject({ method: 'GET', url: '/csrf-token' });
      expect(csrfRes.statusCode).toBe(200);
      const csrf = csrfRes.json().csrf;
      expect(csrf).toBeTruthy();
      const csrfCookies = (csrfRes.cookies || [])
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');
      const allowed = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: {
          cookie: cookieHeader([`session=${session}`, csrfCookies]),
          'content-type': 'application/json',
          'x-csrf-token': csrf,
        },
        payload: { name: 'Cookie site', url: 'https://example.com' },
      });
      expect(allowed.statusCode).toBe(200);
    });
  });

  it('still requires CSRF when a cookie is the auth used and junk headers are present', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'csrf-junk@example.com', password: 'a-long-password' });
      const login = await app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: { email: user.email, password: user.password },
      });
      expect(login.statusCode).toBe(200);
      const session = login.json().token;
      const denied = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: {
          cookie: `session=${session}`,
          'content-type': 'application/json',
          authorization: 'Bearer not-a-real-token',
          'x-api-key': 'mrz_not-a-real-key',
        },
        payload: { name: 'Junk header site', url: 'https://example.com' },
      });
      expect(denied.statusCode).toBe(403);

      const csrfRes = await app.inject({ method: 'GET', url: '/csrf-token' });
      const csrf = csrfRes.json().csrf;
      const csrfCookies = (csrfRes.cookies || [])
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');
      const allowed = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: {
          cookie: cookieHeader([`session=${session}`, csrfCookies]),
          'content-type': 'application/json',
          'x-csrf-token': csrf,
          authorization: 'Bearer not-a-real-token',
          'x-api-key': 'mrz_not-a-real-key',
        },
        payload: { name: 'Junk header site', url: 'https://example.com' },
      });
      expect(allowed.statusCode).toBe(200);
    });
  });

  it('still answers when the handler throws after a passed CSRF check on a cookie write', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'csrf-throw@example.com', password: 'a-long-password' });
      const login = await app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: { email: user.email, password: user.password },
      });
      const session = login.json().token;
      const csrfRes = await app.inject({ method: 'GET', url: '/csrf-token' });
      const csrf = csrfRes.json().csrf;
      const csrfCookies = (csrfRes.cookies || []).map((c) => `${c.name}=${c.value}`).join('; ');
      const res = await Promise.race([
        app.inject({
          method: 'POST',
          url: '/sites',
          headers: {
            cookie: cookieHeader([`session=${session}`, csrfCookies]),
            'content-type': 'application/json',
            'x-csrf-token': csrf,
          },
          payload: { name: '   ', url: 'https://example.com' },
        }),
        new Promise((resolve) => setTimeout(() => resolve({ statusCode: 'no response' }), 5000)),
      ]);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('BAD_NAME');
    });
  });
});
