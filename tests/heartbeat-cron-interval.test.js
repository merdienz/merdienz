import { describe, expect, it } from 'vitest';
import { minCronGapSeconds } from '../src/cron.js';
import { authHeader, createUser, withApp } from './helpers.js';

async function withMinIntervalTier(db, seconds, fn) {
  const tier = `cronmin${seconds}`;
  await db.query(
    `INSERT INTO plan_gates (
       tier, site_count, min_interval_seconds, retention_days,
       alert_channels, seo_enabled, heartbeat_check_count,
       status_page_count, seat_count, ssl_check, domain_expiry, seo_check
     ) VALUES (
       $1, NULL, $2, NULL,
       ARRAY['email']::TEXT[], false, NULL,
       NULL, NULL, false, false, false
     )
     ON CONFLICT (tier) DO UPDATE SET min_interval_seconds = excluded.min_interval_seconds`,
    [tier, seconds]
  );
  try {
    return await fn(tier);
  } finally {
    await db.query(
      `DELETE FROM heartbeat_checks WHERE user_id IN (SELECT id FROM users WHERE tier = $1)`,
      [tier]
    );
    await db.query('DELETE FROM users WHERE tier = $1', [tier]);
    await db.query('DELETE FROM plan_gates WHERE tier = $1', [tier]);
  }
}

describe('cron heartbeat min interval', () => {
  it('measures a 60s gap for * * * * *', () => {
    expect(minCronGapSeconds('* * * * *', 'UTC')).toBe(60);
  });

  it('refuses a one-minute cron against a 300s plan minimum on create and update', async () => {
    await withApp(async ({ app, db }) => {
      await withMinIntervalTier(db, 300, async (tier) => {
        const user = await createUser(db, { email: 'cron-min@example.com', tier });
        const created = await app.inject({
          method: 'POST',
          url: '/heartbeats',
          headers: { ...authHeader(user), 'content-type': 'application/json' },
          payload: { name: 'Too often', cron_expr: '* * * * *', timezone: 'UTC' },
        });
        expect(created.statusCode).toBe(403);
        expect(created.json()).toEqual({
          error: 'Interval must be at least 300s for this plan',
          code: 'MIN_INTERVAL',
        });

        const hourly = await app.inject({
          method: 'POST',
          url: '/heartbeats',
          headers: { ...authHeader(user), 'content-type': 'application/json' },
          payload: { name: 'Hourly', cron_expr: '0 * * * *', timezone: 'UTC' },
        });
        expect(hourly.statusCode).toBe(200);
        const id = hourly.json().id;

        const updated = await app.inject({
          method: 'PATCH',
          url: `/heartbeats/${id}`,
          headers: { ...authHeader(user), 'content-type': 'application/json' },
          payload: { cron_expr: '* * * * *', timezone: 'UTC' },
        });
        expect(updated.statusCode).toBe(403);
        expect(updated.json()).toEqual({
          error: 'Interval must be at least 300s for this plan',
          code: 'MIN_INTERVAL',
        });

        const still = await app.inject({
          method: 'GET',
          url: `/heartbeats/${id}`,
          headers: authHeader(user),
        });
        expect(still.json().cron_expr).toBe('0 * * * *');
      });
    });
  });

  it('does not 500 when a 29 Feb cron walk crosses 2100, on create and update, including a non-UTC timezone', async () => {
    const gap = minCronGapSeconds('0 0 29 2 *', 'America/New_York');
    expect(gap).toBeGreaterThan(300);
    expect(() =>
      minCronGapSeconds('0 0 29 2 *', 'UTC', new Date('2096-03-01T00:00:00.000Z'))
    ).toThrow(/often enough to measure an interval/);
    try {
      minCronGapSeconds('0 0 29 2 *', 'UTC', new Date('2096-03-01T00:00:00.000Z'));
      throw new Error('expected BAD_CRON');
    } catch (err) {
      if (err.message === 'expected BAD_CRON') throw err;
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe('BAD_CRON');
    }

    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'leap-cron@example.com', tier: 'starter' });
      const created = await app.inject({
        method: 'POST',
        url: '/heartbeats',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { name: 'Leap day', cron_expr: '0 0 29 2 *', timezone: 'America/New_York' },
      });
      expect(created.statusCode).toBe(200);
      expect(created.json().cron_expr).toBe('0 0 29 2 *');

      const hourly = await app.inject({
        method: 'POST',
        url: '/heartbeats',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { name: 'Hourly then leap', cron_expr: '0 * * * *', timezone: 'Australia/Sydney' },
      });
      expect(hourly.statusCode).toBe(200);
      const updated = await app.inject({
        method: 'PATCH',
        url: `/heartbeats/${hourly.json().id}`,
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { cron_expr: '0 0 29 2 *', timezone: 'Australia/Sydney' },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().cron_expr).toBe('0 0 29 2 *');
      expect(updated.statusCode).not.toBe(500);
    });
  });

  it('allows switching a heartbeat from a period to a cron on update', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'switch-sched@example.com', tier: 'starter' });
      const created = await app.inject({
        method: 'POST',
        url: '/heartbeats',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { name: 'Period first', period_seconds: 300 },
      });
      expect(created.statusCode).toBe(200);
      const switched = await app.inject({
        method: 'PATCH',
        url: `/heartbeats/${created.json().id}`,
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { period_seconds: null, cron_expr: '0 * * * *', timezone: 'UTC' },
      });
      expect(switched.statusCode).toBe(200);
      expect(switched.json().period_seconds).toBeNull();
      expect(switched.json().cron_expr).toBe('0 * * * *');
    });
  });
});
