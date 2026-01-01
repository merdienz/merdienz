import { describe, expect, it } from 'vitest';
import { isUpStatus } from '../src/probes/http.js';
import { authHeader, createUser, withApp } from './helpers.js';

describe('plan gates', () => {
  it('defaults interval to 300s and reads the tier from the database', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'self@example.com', tier: 'selfhosted' });
      const res = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { name: 'Example', url: 'https://example.com' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.interval_seconds).toBe(300);
      expect(body.url).toBe('https://example.com/');
    });
  });

  it('rejects a client-supplied tier in the body or X-Tier header (no bypass)', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'cloud@example.com', tier: 'starter' });
      const bodyAttempt = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: {
          name: 'Fast',
          url: 'https://example.com',
          interval_seconds: 10,
          tier: 'selfhosted',
        },
      });
      expect(bodyAttempt.statusCode).toBe(400);
      expect(bodyAttempt.json().code).toBe('TIER_OVERRIDE');

      const headerAttempt = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: {
          ...authHeader(user),
          'content-type': 'application/json',
          'x-tier': 'selfhosted',
        },
        payload: { name: 'Fast', url: 'https://example.com', interval_seconds: 10 },
      });
      expect(headerAttempt.statusCode).toBe(400);
      expect(headerAttempt.json().code).toBe('TIER_OVERRIDE');

      const list = await app.inject({ method: 'GET', url: '/sites', headers: authHeader(user) });
      expect(list.json().sites).toHaveLength(0);
    });
  });

  it('enforces the starter min interval of 60s', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'cloud2@example.com', tier: 'starter' });
      const tooFast = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { name: 'Fast', url: 'https://example.com', interval_seconds: 30 },
      });
      expect(tooFast.statusCode).toBe(403);
      expect(tooFast.json().code).toBe('MIN_INTERVAL');

      const ok = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { name: 'Ok', url: 'https://example.com', interval_seconds: 60 },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().interval_seconds).toBe(60);
    });
  });

  it('enforces the starter site count and ignores a later body override attempt', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'capped@example.com', tier: 'starter' });
      for (let i = 0; i < 15; i += 1) {
        await db.query(
          `INSERT INTO sites (user_id, name, url, interval_seconds) VALUES ($1, $2, $3, 300)`,
          [user.id, `S${i}`, `https://example.com/s${i}`]
        );
      }
      const blocked = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { name: 'S3', url: 'https://example.com/s3', tier: 'selfhosted' },
      });
      expect(blocked.statusCode).toBe(400);
      expect(blocked.json().code).toBe('TIER_OVERRIDE');

      const stillBlocked = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { name: 'S3', url: 'https://example.com/s3' },
      });
      expect(stillBlocked.statusCode).toBe(403);
      expect(stillBlocked.json().code).toBe('SITE_LIMIT');
    });
  });

  it('applies a new tier on the next request after the database row changes', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'switch@example.com', tier: 'selfhosted' });
      const fine = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { name: 'Fast', url: 'https://example.com', interval_seconds: 10 },
      });
      expect(fine.statusCode).toBe(200);

      await db.query(`UPDATE users SET tier = 'starter' WHERE id = $1`, [user.id]);

      const denied = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { name: 'Faster', url: 'https://example.com/2', interval_seconds: 10 },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().code).toBe('MIN_INTERVAL');
    });
  });

  it('rejects unauthenticated requests and allows session auth', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, {
        email: 'sess@example.com',
        password: 'letmein',
        tier: 'selfhosted',
      });
      const noAuth = await app.inject({ method: 'GET', url: '/sites' });
      expect(noAuth.statusCode).toBe(401);

      const login = await app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: { email: user.email, password: 'letmein' },
      });
      expect(login.statusCode).toBe(200);
      const token = login.json().token;
      const listed = await app.inject({
        method: 'GET',
        url: '/sites',
        headers: { 'x-session-token': token },
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().sites).toEqual([]);

      const created = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: { 'x-session-token': token, 'content-type': 'application/json' },
        payload: { name: 'A', url: 'http://127.0.0.1:4840/health' },
      });
      const id = created.json().id;
      const deleted = await app.inject({
        method: 'DELETE',
        url: `/sites/${id}`,
        headers: { 'x-session-token': token },
      });
      expect(deleted.statusCode).toBe(200);
    });
  });

  it('lets the selfhosted tier add a short interval (unlimited)', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'open@example.com', tier: 'selfhosted' });
      const res = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { name: 'Fast', url: 'https://example.com', interval_seconds: 5 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().interval_seconds).toBe(5);
    });
  });

  it('parses configurable up-status codes', () => {
    expect(isUpStatus(200, '2xx,3xx')).toBe(true);
    expect(isUpStatus(301, '2xx,3xx')).toBe(true);
    expect(isUpStatus(404, '2xx,3xx')).toBe(false);
    expect(isUpStatus(204, '200,204')).toBe(true);
    expect(isUpStatus(201, '200,204')).toBe(false);
    expect(isUpStatus(404, '400-499')).toBe(true);
  });
});
