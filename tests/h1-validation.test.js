import { describe, expect, it } from 'vitest';
import { authHeader, createUser, withApp } from './helpers.js';

describe('H1 request validation', () => {
  it('rejects a NUL in a site name with 400, not 500', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'nul@example.com' });
      const res = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: JSON.stringify({ name: '\u0000x', url: 'https://example.com' }),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('BAD_REQUEST');
    });
  });

  it('rejects an out-of-range ping exit code with 400, not 500', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'exit@example.com' });
      const created = await app.inject({
        method: 'POST',
        url: '/heartbeats',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { name: 'Exit', period_seconds: 60 },
      });
      expect(created.statusCode).toBe(200);
      const token = new URL(created.json().ping_urls.success).pathname.split('/').pop();
      const huge = await app.inject({
        method: 'GET',
        url: `/ping/${token}?exit=99999999999999999999`,
      });
      expect(huge.statusCode).toBe(400);
      const body = await app.inject({
        method: 'POST',
        url: `/ping/${token}`,
        headers: { 'content-type': 'application/json' },
        payload: { exit_code: 999999 },
      });
      expect(body.statusCode).toBe(400);
    });
  });

  it('rejects loose exit values with 400 and keeps invalid path codes as 404', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'exit-strict@example.com' });
      const created = await app.inject({
        method: 'POST',
        url: '/heartbeats',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { name: 'Strict exit', period_seconds: 60 },
      });
      const token = new URL(created.json().ping_urls.success).pathname.split('/').pop();
      for (const exit of ['1e2', ' 1', '01', '01x', '+1', '0x1']) {
        const res = await app.inject({ method: 'GET', url: `/ping/${token}?exit=${encodeURIComponent(exit)}` });
        expect(res.statusCode, exit).toBe(400);
        expect(res.statusCode).not.toBe(500);
      }
      const bodies = [
        { exit_code: true },
        { exit_code: [1] },
        { exit_code: '7' },
        { exit_code: '1e2' },
      ];
      for (const payload of bodies) {
        const res = await app.inject({
          method: 'POST',
          url: `/ping/${token}`,
          headers: { 'content-type': 'application/json' },
          payload,
        });
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
        expect(res.statusCode).not.toBe(500);
      }
      const ok = await app.inject({
        method: 'POST',
        url: `/ping/${token}`,
        headers: { 'content-type': 'application/json' },
        payload: { exit_code: 7 },
      });
      expect(ok.statusCode).toBe(200);
      const pathBad = await app.inject({ method: 'GET', url: `/ping/${token}/1e2` });
      expect(pathBad.statusCode).toBe(404);
      const pathPad = await app.inject({ method: 'GET', url: `/ping/${token}/01` });
      expect(pathPad.statusCode).toBe(404);
    });
  });
});
