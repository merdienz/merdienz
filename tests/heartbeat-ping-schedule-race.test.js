import { describe, expect, it } from 'vitest';
import { computeNextWindow } from '../src/cron.js';
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

function windowMatches(row, from, slackMs = 2000) {
  const window = computeNextWindow(
    {
      period_seconds: row.period_seconds,
      cron_expr: row.cron_expr,
      timezone: row.timezone,
      grace_seconds: row.grace_seconds,
    },
    from
  );
  return (
    Math.abs(new Date(window.expected_at).getTime() - new Date(row.expected_at).getTime()) <= slackMs &&
    Math.abs(new Date(window.grace_until).getTime() - new Date(row.grace_until).getTime()) <= slackMs
  );
}

async function withPatchAfterPingLoad(app, user, checkId, patchBody, fn) {
  const orig = app.db.query.bind(app.db);
  let injected = false;
  app.db.query = async (sql, params) => {
    const result = await orig(sql, params);
    const text = typeof sql === 'string' ? sql : '';
    if (!injected && /ping_token = \$1/i.test(text)) {
      injected = true;
      const patched = await patchHb(app, user, checkId, patchBody);
      expect(patched.statusCode).toBe(200);
    }
    return result;
  };
  try {
    const value = await fn();
    expect(injected).toBe(true);
    return value;
  } finally {
    app.db.query = orig;
  }
}

describe('heartbeat pings use the locked schedule when writing a window', () => {
  const tighten = { period_seconds: null, cron_expr: '*/5 * * * *', timezone: 'UTC' };

  async function monthlyCheck(app, db, email) {
    const user = await createUser(db, { email });
    const hb = await createHb(app, user, {
      name: 'Monthly job',
      period_seconds: 30 * 24 * 3600,
      grace_seconds: 60,
    });
    return { user, hb };
  }

  function expectTightWindow(row) {
    expect(row.cron_expr).toBe('*/5 * * * *');
    expect(row.period_seconds).toBeNull();
    const expectedMs = new Date(row.expected_at).getTime();
    expect(expectedMs).toBeGreaterThan(Date.now() - 2000);
    expect(expectedMs - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000 + 2000);
    expect(expectedMs - Date.now()).toBeLessThan(24 * 60 * 60 * 1000);
  }

  it('uses the new schedule when a PATCH commits between a success ping read and write', async () => {
    await withApp(async ({ app, db, mailer }) => {
      const { user, hb } = await monthlyCheck(app, db, 'ping-success-race@example.com');
      const ping = await withPatchAfterPingLoad(app, user, hb.id, tighten, () =>
        app.inject({ method: 'POST', url: pathFrom(hb.ping_urls.success) })
      );
      expect(ping.statusCode).toBe(200);
      expect(ping.json().status).toBe('up');
      const row = (await db.query('SELECT * FROM heartbeat_checks WHERE id = $1', [hb.id])).rows[0];
      expectTightWindow(row);
      const later = new Date(Date.now() + 60 * 60 * 1000);
      const changes = await evaluateHeartbeats({ db, mailer, now: later });
      expect(changes.some((c) => c.id === hb.id && c.status === 'down')).toBe(true);
    });
  });

  it('uses the new schedule when a PATCH commits between a start ping read and write', async () => {
    await withApp(async ({ app, db }) => {
      const { user, hb } = await monthlyCheck(app, db, 'ping-start-race@example.com');
      const ping = await withPatchAfterPingLoad(app, user, hb.id, tighten, () =>
        app.inject({ method: 'POST', url: pathFrom(hb.ping_urls.start) })
      );
      expect(ping.statusCode).toBe(200);
      expect(ping.json().status).toBe('up');
      const row = (await db.query('SELECT * FROM heartbeat_checks WHERE id = $1', [hb.id])).rows[0];
      expect(row.last_start_at).toBeTruthy();
      expectTightWindow(row);
    });
  });

  it('uses the new schedule when a PATCH commits between a fail ping read and write', async () => {
    await withApp(async ({ app, db }) => {
      const { user, hb } = await monthlyCheck(app, db, 'ping-fail-race@example.com');
      const ping = await withPatchAfterPingLoad(app, user, hb.id, tighten, () =>
        app.inject({ method: 'POST', url: pathFrom(hb.ping_urls.fail) })
      );
      expect(ping.statusCode).toBe(200);
      expect(ping.json().status).toBe('down');
      const row = (await db.query('SELECT * FROM heartbeat_checks WHERE id = $1', [hb.id])).rows[0];
      expect(row.status).toBe('down');
      expectTightWindow(row);
    });
  });

  it('runs pings and schedule PATCHes concurrently without deadlocks or a stale deadline', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'ping-patch-concurrency@example.com' });
      const hb = await createHb(app, user, {
        name: 'Concurrent job',
        period_seconds: 3600,
        grace_seconds: 60,
      });
      const schedules = [
        { period_seconds: 3600, cron_expr: null },
        { period_seconds: 900, cron_expr: null },
        { period_seconds: null, cron_expr: '*/5 * * * *', timezone: 'UTC' },
        { period_seconds: 1800, cron_expr: null },
      ];
      const pingUrl = pathFrom(hb.ping_urls.success);
      const jobs = [];
      for (let i = 0; i < 20; i += 1) {
        jobs.push(app.inject({ method: 'POST', url: pingUrl }));
        jobs.push(patchHb(app, user, hb.id, schedules[i % schedules.length]));
      }
      const results = await Promise.all(jobs);
      for (const res of results) {
        expect(res.statusCode).toBeLessThan(500);
        expect(res.json().code).not.toBe('40P01');
        const msg = String(res.json().error || res.json().message || '');
        expect(msg.toLowerCase()).not.toContain('deadlock');
      }
      const pings = results.filter((_, i) => i % 2 === 0);
      const patches = results.filter((_, i) => i % 2 === 1);
      expect(pings.every((r) => r.statusCode === 200)).toBe(true);
      expect(patches.every((r) => r.statusCode === 200)).toBe(true);

      const row = (await db.query('SELECT * FROM heartbeat_checks WHERE id = $1', [hb.id])).rows[0];
      const pingCount = (await db.query('SELECT count(*)::int AS n FROM heartbeat_pings WHERE check_id = $1', [hb.id]))
        .rows[0].n;
      expect(pingCount).toBe(20);
      expect(row.last_ping_at).toBeTruthy();
      const now = new Date();
      const lastPing = new Date(row.last_ping_at);
      const patchFrom = lastPing > now ? lastPing : now;
      expect(windowMatches(row, lastPing) || windowMatches(row, patchFrom)).toBe(true);
    });
  });
});
