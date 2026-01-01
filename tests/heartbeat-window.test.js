import { describe, expect, it } from 'vitest';
import { evaluateHeartbeats } from '../src/heartbeat-checks.js';
import { authHeader, createUser, withApp } from './helpers.js';

function pathFrom(url) {
  return new URL(url).pathname;
}

describe('heartbeat next window after a real ping', () => {
  it('arms a period window and stays up when evaluated 5s later', async () => {
    await withApp(async ({ app, db, mailer }) => {
      const user = await createUser(db, { email: 'window-period@example.com', tier: 'selfhosted' });
      const created = await app.inject({
        method: 'POST',
        url: '/heartbeats',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { name: 'Period job', period_seconds: 60, grace_seconds: 300 },
      });
      expect(created.statusCode).toBe(200);
      const hb = created.json();
      const before = Date.now();
      const ping = await app.inject({ method: 'POST', url: pathFrom(hb.ping_urls.success) });
      expect(ping.statusCode).toBe(200);
      expect(ping.json().status).toBe('up');
      const row = (await db.query('SELECT * FROM heartbeat_checks WHERE id = $1', [hb.id])).rows[0];
      const expectedMs = new Date(row.expected_at).getTime();
      const graceMs = new Date(row.grace_until).getTime();
      expect(expectedMs).toBeGreaterThanOrEqual(before + 58_000);
      expect(expectedMs).toBeLessThanOrEqual(Date.now() + 62_000);
      expect(graceMs - expectedMs).toBeGreaterThanOrEqual(299_000);
      expect(graceMs - expectedMs).toBeLessThanOrEqual(301_000);
      const changes = await evaluateHeartbeats({ db, mailer, now: new Date(Date.now() + 5000) });
      expect(changes.filter((c) => c.id === hb.id)).toEqual([]);
      const after = (await db.query('SELECT status FROM heartbeat_checks WHERE id = $1', [hb.id])).rows[0];
      expect(after.status).toBe('up');
    });
  });

  it('arms a cron window and stays up when evaluated 5s later', async () => {
    await withApp(async ({ app, db, mailer }) => {
      const user = await createUser(db, { email: 'window-cron@example.com', tier: 'selfhosted' });
      const created = await app.inject({
        method: 'POST',
        url: '/heartbeats',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: {
          name: 'Cron job',
          cron_expr: '0 0 1 1 *',
          timezone: 'UTC',
          grace_seconds: 600,
        },
      });
      expect(created.statusCode).toBe(200);
      const hb = created.json();
      const before = Date.now();
      const ping = await app.inject({ method: 'POST', url: pathFrom(hb.ping_urls.success) });
      expect(ping.statusCode).toBe(200);
      expect(ping.json().status).toBe('up');
      const row = (await db.query('SELECT * FROM heartbeat_checks WHERE id = $1', [hb.id])).rows[0];
      const expectedMs = new Date(row.expected_at).getTime();
      // 1 Jan 00:00 UTC is always at least hours away except right at that instant, and
      // never only 5 seconds away.
      expect(expectedMs).toBeGreaterThan(before + 60_000);
      const graceMs = new Date(row.grace_until).getTime();
      expect(graceMs - expectedMs).toBe(600_000);
      const changes = await evaluateHeartbeats({ db, mailer, now: new Date(Date.now() + 5000) });
      expect(changes.filter((c) => c.id === hb.id)).toEqual([]);
      const after = (await db.query('SELECT status FROM heartbeat_checks WHERE id = $1', [hb.id])).rows[0];
      expect(after.status).toBe('up');
    });
  });
});
