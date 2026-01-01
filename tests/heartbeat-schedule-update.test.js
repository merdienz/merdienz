import { describe, expect, it } from 'vitest';
import { evaluateHeartbeats } from '../src/heartbeat-checks.js';
import { authHeader, createUser, withApp } from './helpers.js';

function pathFrom(url) {
  return new URL(url).pathname;
}

async function createHb(app, user, payload) {
  const res = await app.inject({
    method: 'POST',
    url: '/heartbeats',
    headers: { ...authHeader(user), 'content-type': 'application/json' },
    payload,
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function patchHb(app, user, id, payload) {
  return app.inject({
    method: 'PATCH',
    url: `/heartbeats/${id}`,
    headers: { ...authHeader(user), 'content-type': 'application/json' },
    payload,
  });
}

describe('heartbeat schedule updates recompute the next window', () => {
  it('recomputes expected_at when switching cron to cron after a ping', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'cron-to-cron@example.com' });
      const hb = await createHb(app, user, {
        name: 'Hourly',
        cron_expr: '0 * * * *',
        timezone: 'UTC',
        grace_seconds: 60,
      });
      const ping = await app.inject({ method: 'POST', url: pathFrom(hb.ping_urls.success) });
      expect(ping.statusCode).toBe(200);
      const before = (await db.query('SELECT * FROM heartbeat_checks WHERE id = $1', [hb.id])).rows[0];
      const updated = await patchHb(app, user, hb.id, { cron_expr: '0 0 * * *', timezone: 'UTC' });
      expect(updated.statusCode).toBe(200);
      const after = updated.json();
      expect(new Date(after.expected_at).getTime()).not.toBe(new Date(before.expected_at).getTime());
      expect(new Date(after.grace_until) - new Date(after.expected_at)).toBe(60_000);
    });
  });

  it('recomputes expected_at when switching a period interval to a cron', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'interval-to-cron@example.com' });
      const hb = await createHb(app, user, {
        name: 'Period first',
        period_seconds: 3600,
        grace_seconds: 60,
      });
      const ping = await app.inject({ method: 'POST', url: pathFrom(hb.ping_urls.success) });
      expect(ping.statusCode).toBe(200);
      const before = (await db.query('SELECT * FROM heartbeat_checks WHERE id = $1', [hb.id])).rows[0];
      const updated = await patchHb(app, user, hb.id, {
        period_seconds: null,
        cron_expr: '0 0 * * *',
        timezone: 'UTC',
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().period_seconds).toBeNull();
      expect(updated.json().cron_expr).toBe('0 0 * * *');
      expect(new Date(updated.json().expected_at).getTime()).not.toBe(new Date(before.expected_at).getTime());
    });
  });

  it('recomputes expected_at when only the timezone changes', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'tz-change@example.com' });
      const hb = await createHb(app, user, {
        name: 'Noon job',
        cron_expr: '0 12 * * *',
        timezone: 'UTC',
        grace_seconds: 60,
      });
      const ping = await app.inject({ method: 'POST', url: pathFrom(hb.ping_urls.success) });
      expect(ping.statusCode).toBe(200);
      const before = (await db.query('SELECT * FROM heartbeat_checks WHERE id = $1', [hb.id])).rows[0];
      const updated = await patchHb(app, user, hb.id, { timezone: 'America/New_York' });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().timezone).toBe('America/New_York');
      expect(new Date(updated.json().expected_at).getTime()).not.toBe(new Date(before.expected_at).getTime());
    });
  });

  it('computes a window from now for a never-pinged check', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'never-pinged@example.com' });
      const hb = await createHb(app, user, {
        name: 'New check',
        period_seconds: 3600,
        grace_seconds: 60,
      });
      expect(hb.expected_at).toBeFalsy();
      const before = Date.now();
      const updated = await patchHb(app, user, hb.id, { period_seconds: 1800, grace_seconds: 60 });
      expect(updated.statusCode).toBe(200);
      const expectedMs = new Date(updated.json().expected_at).getTime();
      expect(expectedMs).toBeGreaterThanOrEqual(before + 1700_000);
      expect(expectedMs).toBeLessThanOrEqual(Date.now() + 1900_000);
      expect(updated.json().status).toBe('new');
      const row = (await db.query('SELECT last_ping_at, status FROM heartbeat_checks WHERE id = $1', [hb.id])).rows[0];
      expect(row.last_ping_at).toBeNull();
      expect(row.status).toBe('new');
    });
  });

  it('tightening a 1 hour period to */5 pulls the deadline in', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'tighten@example.com' });
      const hb = await createHb(app, user, {
        name: 'Hourly then tight',
        period_seconds: 3600,
        grace_seconds: 60,
      });
      const ping = await app.inject({ method: 'POST', url: pathFrom(hb.ping_urls.success) });
      expect(ping.statusCode).toBe(200);
      const before = (await db.query('SELECT expected_at FROM heartbeat_checks WHERE id = $1', [hb.id])).rows[0];
      const oldExpected = new Date(before.expected_at).getTime();
      const updated = await patchHb(app, user, hb.id, {
        period_seconds: null,
        cron_expr: '*/5 * * * *',
        timezone: 'UTC',
      });
      expect(updated.statusCode).toBe(200);
      const newExpected = new Date(updated.json().expected_at).getTime();
      expect(newExpected).toBeLessThan(oldExpected);
      expect(newExpected - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000 + 1000);
    });
  });

  it('loosening the schedule never goes falsely LATE', async () => {
    await withApp(async ({ app, db, mailer }) => {
      const user = await createUser(db, { email: 'loosen@example.com' });
      const hb = await createHb(app, user, {
        name: 'Tight then loose',
        period_seconds: 60,
        grace_seconds: 30,
      });
      const ping = await app.inject({ method: 'POST', url: pathFrom(hb.ping_urls.success) });
      expect(ping.statusCode).toBe(200);
      const loosened = await patchHb(app, user, hb.id, { period_seconds: 3600, grace_seconds: 30 });
      expect(loosened.statusCode).toBe(200);
      const later = new Date(Date.now() + 90_000);
      const changes = await evaluateHeartbeats({ db, mailer, now: later });
      expect(changes.filter((c) => c.id === hb.id)).toEqual([]);
      const after = (await db.query('SELECT status FROM heartbeat_checks WHERE id = $1', [hb.id])).rows[0];
      expect(after.status).toBe('up');
    });
  });

  it('rejects PATCH {cron_expr:""} with 400 BAD_CRON', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'empty-cron@example.com' });
      const hb = await createHb(app, user, { name: 'Keep period', period_seconds: 300, grace_seconds: 60 });
      const updated = await patchHb(app, user, hb.id, { cron_expr: '' });
      expect(updated.statusCode).toBe(400);
      expect(updated.json().code).toBe('BAD_CRON');
      const row = (await db.query('SELECT period_seconds, cron_expr FROM heartbeat_checks WHERE id = $1', [hb.id])).rows[0];
      expect(row.period_seconds).toBe(300);
      expect(row.cron_expr).toBeNull();
    });
  });

  it('switches a cron heartbeat to a period with cron_expr null', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'cron-to-period@example.com' });
      const hb = await createHb(app, user, {
        name: 'Daily cron',
        cron_expr: '0 0 * * *',
        timezone: 'UTC',
        grace_seconds: 60,
      });
      const updated = await patchHb(app, user, hb.id, { cron_expr: null, period_seconds: 86400 });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().code).not.toBe('BAD_CRON');
      expect(updated.json().period_seconds).toBe(86400);
      expect(updated.json().cron_expr).toBeNull();
      expect(new Date(updated.json().expected_at).getTime()).toBeGreaterThan(Date.now());
    });
  });

  it('does not restore stale deadlines when a ping races a non-schedule PATCH', async () => {
    await withApp(async ({ app, db, mailer }) => {
      const user = await createUser(db, { email: 'race-patch@example.com' });
      const hb = await createHb(app, user, {
        name: 'Racy',
        period_seconds: 3600,
        grace_seconds: 60,
      });
      const staleExpected = new Date(Date.now() - 7 * 60 * 1000);
      const staleGrace = new Date(Date.now() - 6 * 60 * 1000);
      await db.query(
        `UPDATE heartbeat_checks
            SET status = 'late',
                last_ping_at = now() - interval '10 minutes',
                expected_at = $2,
                grace_until = $3
          WHERE id = $1`,
        [hb.id, staleExpected, staleGrace]
      );

      const orig = app.db.query.bind(app.db);
      let injected = false;
      app.db.query = async (sql, params) => {
        const result = await orig(sql, params);
        const text = typeof sql === 'string' ? sql : '';
        if (
          !injected &&
          /SELECT \* FROM heartbeat_checks WHERE id = \$1 AND user_id = \$2/i.test(text) &&
          !/FOR UPDATE/i.test(text)
        ) {
          injected = true;
          const ping = await app.inject({ method: 'POST', url: pathFrom(hb.ping_urls.success) });
          expect(ping.statusCode).toBe(200);
          expect(ping.json().status).toBe('up');
        }
        return result;
      };

      try {
        const patched = await patchHb(app, user, hb.id, { public_on_status: true });
        expect(patched.statusCode).toBe(200);
        expect(injected).toBe(true);
        const row = (
          await orig('SELECT status, last_ping_at, expected_at, grace_until, public_on_status FROM heartbeat_checks WHERE id = $1', [
            hb.id,
          ])
        ).rows[0];
        expect(row.public_on_status).toBe(true);
        expect(row.status).toBe('up');
        expect(new Date(row.expected_at).getTime()).toBeGreaterThan(Date.now());
        expect(new Date(row.expected_at).getTime()).toBeGreaterThan(staleExpected.getTime() + 60 * 60 * 1000 - 5000);
        const changes = await evaluateHeartbeats({ db, mailer, now: new Date() });
        expect(changes.filter((c) => c.id === hb.id)).toEqual([]);
        const after = (await orig('SELECT status FROM heartbeat_checks WHERE id = $1', [hb.id])).rows[0];
        expect(after.status).toBe('up');
      } finally {
        app.db.query = orig;
      }
    });
  });

  it('keeps the new deadline in the future when tightening a monthly check pinged 10 days ago to */5', async () => {
    await withApp(async ({ app, db, mailer }) => {
      const user = await createUser(db, { email: 'tighten-old@example.com' });
      const hb = await createHb(app, user, {
        name: 'Monthly then tight',
        period_seconds: 30 * 24 * 3600,
        grace_seconds: 60,
      });
      await db.query(
        `UPDATE heartbeat_checks
            SET last_ping_at = now() - interval '10 days',
                expected_at = now() + interval '20 days',
                grace_until = now() + interval '20 days' + interval '60 seconds',
                status = 'up'
          WHERE id = $1`,
        [hb.id]
      );
      const updated = await patchHb(app, user, hb.id, {
        period_seconds: null,
        cron_expr: '*/5 * * * *',
        timezone: 'UTC',
      });
      expect(updated.statusCode).toBe(200);
      const expectedMs = new Date(updated.json().expected_at).getTime();
      expect(expectedMs).toBeGreaterThan(Date.now());
      expect(expectedMs - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000 + 1000);
      const changes = await evaluateHeartbeats({ db, mailer, now: new Date() });
      expect(changes.filter((c) => c.id === hb.id)).toEqual([]);
      const after = (await db.query('SELECT status FROM heartbeat_checks WHERE id = $1', [hb.id])).rows[0];
      expect(after.status).toBe('up');
    });
  });

  it('sets late to up in the same UPDATE when loosening moves the deadline into the future', async () => {
    await withApp(async ({ app, db, mailer }) => {
      const user = await createUser(db, { email: 'late-to-up@example.com' });
      const hb = await createHb(app, user, {
        name: 'Late then loose',
        period_seconds: 60,
        grace_seconds: 30,
      });
      await db.query(
        `UPDATE heartbeat_checks
            SET status = 'late',
                last_ping_at = now() - interval '2 minutes',
                expected_at = now() - interval '60 seconds',
                grace_until = now() + interval '30 seconds'
          WHERE id = $1`,
        [hb.id]
      );
      const updated = await patchHb(app, user, hb.id, { period_seconds: 3600, grace_seconds: 30 });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().status).toBe('up');
      expect(new Date(updated.json().expected_at).getTime()).toBeGreaterThan(Date.now());
      const changes = await evaluateHeartbeats({ db, mailer, now: new Date() });
      expect(changes.filter((c) => c.id === hb.id)).toEqual([]);
      const after = (await db.query('SELECT status FROM heartbeat_checks WHERE id = $1', [hb.id])).rows[0];
      expect(after.status).toBe('up');
    });
  });
});
