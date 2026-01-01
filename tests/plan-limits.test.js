import { describe, expect, it } from 'vitest';
import { assertCanAddSeat } from '../src/gates.js';
import { loadDueSites } from '../src/scheduler.js';
import { authHeader, createUser, grantPlan, withApp } from './helpers.js';

const cloudConfig = { merdienzMode: 'cloud' };

async function insertSites(db, userId, count, start = 0) {
  for (let i = 0; i < count; i += 1) {
    await db.query(
      `INSERT INTO sites (user_id, name, url, interval_seconds) VALUES ($1, $2, $3, 300)`,
      [userId, `S${start + i}`, `https://example.com/s${start + i}`]
    );
  }
}

async function insertHeartbeats(db, userId, count, start = 0) {
  for (let i = 0; i < count; i += 1) {
    await db.query(
      `INSERT INTO heartbeat_checks (user_id, name, period_seconds, grace_seconds)
       VALUES ($1, $2, 60, 10)`,
      [userId, `H${start + i}`]
    );
  }
}

function createSite(app, user, body) {
  return app.inject({
    method: 'POST',
    url: '/sites',
    headers: { ...authHeader(user), 'content-type': 'application/json' },
    payload: { name: 'Site', url: 'https://example.com/new', ...body },
  });
}

describe('cloud plan limits', () => {
  it('refuses creates with PLAN_REQUIRED when a cloud account has no plan, but keeps reads and existing checks running', async () => {
    await withApp(
      async ({ app, db }) => {
        const user = await createUser(db, { email: 'free@example.com', tier: 'no_plan' });
        await db.query(
          `INSERT INTO sites (user_id, name, url, interval_seconds)
           VALUES ($1, 'Existing', 'https://existing.example', 300)`,
          [user.id]
        );
        await db.query(
          `INSERT INTO heartbeat_checks (user_id, name, period_seconds, grace_seconds)
           VALUES ($1, 'Existing cron', 3600, 10)`,
          [user.id]
        );
        await db.query(
          `INSERT INTO status_pages (user_id, slug, title) VALUES ($1, 'existing-status', 'Existing')`,
          [user.id]
        );

        const site = await createSite(app, user);
        expect(site.statusCode).toBe(403);
        expect(site.json()).toEqual({ error: 'plan required', code: 'PLAN_REQUIRED' });

        const hb = await app.inject({
          method: 'POST',
          url: '/heartbeats',
          headers: { ...authHeader(user), 'content-type': 'application/json' },
          payload: { name: 'New cron', period_seconds: 3600 },
        });
        expect(hb.statusCode).toBe(403);
        expect(hb.json().code).toBe('PLAN_REQUIRED');

        const page = await app.inject({
          method: 'POST',
          url: '/status-page',
          headers: { ...authHeader(user), 'content-type': 'application/json' },
          payload: { title: 'New', slug: 'new-status' },
        });
        expect(page.statusCode).toBe(403);
        expect(page.json().code).toBe('PLAN_REQUIRED');

        const listed = await app.inject({ method: 'GET', url: '/sites', headers: authHeader(user) });
        expect(listed.statusCode).toBe(200);
        expect(listed.json().sites).toHaveLength(1);
        expect(listed.json().sites[0].name).toBe('Existing');

        const heartbeats = await app.inject({
          method: 'GET',
          url: '/heartbeats',
          headers: authHeader(user),
        });
        expect(heartbeats.statusCode).toBe(200);
        expect(heartbeats.json().heartbeats).toHaveLength(1);

        const adminPage = await app.inject({
          method: 'GET',
          url: '/status-page',
          headers: authHeader(user),
        });
        expect(adminPage.statusCode).toBe(200);
        expect(adminPage.json().status_page.slug).toBe('existing-status');

        const publicPage = await app.inject({ method: 'GET', url: '/status/existing-status' });
        expect(publicPage.statusCode).toBe(200);
        expect(publicPage.json().title).toBe('Existing');

        const siteId = listed.json().sites[0].id;
        const toggle = await app.inject({
          method: 'PATCH',
          url: `/sites/${siteId}`,
          headers: { ...authHeader(user), 'content-type': 'application/json' },
          payload: { public_on_status: true },
        });
        expect(toggle.statusCode).toBe(200);

        const faster = await app.inject({
          method: 'PATCH',
          url: `/sites/${siteId}`,
          headers: { ...authHeader(user), 'content-type': 'application/json' },
          payload: { interval_seconds: 120 },
        });
        expect(faster.statusCode).toBe(403);
        expect(faster.json().code).toBe('PLAN_REQUIRED');

        // Existing checks keep running: no_plan caps are unlimited for the
        // scheduler so already-created monitors are still due.
        await db.query(`UPDATE sites SET last_checked_at = now() - interval '10 minutes'`);
        const due = await loadDueSites(db);
        expect(due.some((row) => row.id === siteId)).toBe(true);
      },
      { config: cloudConfig }
    );
  });

  it('enforces starter limits at the cap and at cap + 1', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'starter@example.com', tier: 'starter' });
      await grantPlan(db, user.id, 'starter', 'monthly');

      await insertSites(db, user.id, 14);
      const fifteenth = await createSite(app, user, { name: 'S14', url: 'https://example.com/s14' });
      expect(fifteenth.statusCode).toBe(200);
      const sixteenth = await createSite(app, user, { name: 'S15', url: 'https://example.com/s15' });
      expect(sixteenth.statusCode).toBe(403);
      expect(sixteenth.json().code).toBe('SITE_LIMIT');

      const intervalDenied = await app.inject({
        method: 'PATCH',
        url: `/sites/${fifteenth.json().id}`,
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { interval_seconds: 30 },
      });
      expect(intervalDenied.statusCode).toBe(403);
      expect(intervalDenied.json().code).toBe('MIN_INTERVAL');

      await insertHeartbeats(db, user.id, 5);
      const sixthHb = await app.inject({
        method: 'POST',
        url: '/heartbeats',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { name: 'H5', period_seconds: 60 },
      });
      expect(sixthHb.statusCode).toBe(403);
      expect(sixthHb.json().code).toBe('HEARTBEAT_LIMIT');

      const firstPage = await app.inject({
        method: 'POST',
        url: '/status-page',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { title: 'Starter', slug: 'starter-status' },
      });
      expect(firstPage.statusCode).toBe(200);
      const secondPage = await app.inject({
        method: 'POST',
        url: '/status-page',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { title: 'Another', slug: 'starter-status-2' },
      });
      expect(secondPage.statusCode).toBe(403);
      expect(secondPage.json().code).toBe('STATUS_PAGE_LIMIT');

      const { rows: sub } = await db.query('SELECT plan, billing_interval, status FROM subscriptions WHERE user_id = $1', [
        user.id,
      ]);
      expect(sub[0]).toMatchObject({ plan: 'starter', billing_interval: 'monthly', status: 'active' });

      const starterGate = { seat_count: 1 };
      expect(() => assertCanAddSeat(starterGate, 0)).not.toThrow();
      expect(() => assertCanAddSeat(starterGate, 1)).toThrow(/Seat limit reached \(1\)/);
    });
  });

  it('enforces pro limits at the cap and at cap + 1, including a 30s interval', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'pro@example.com', tier: 'pro' });
      await grantPlan(db, user.id, 'pro', 'yearly');

      await insertSites(db, user.id, 59);
      const sixtieth = await createSite(app, user, { name: 'S59', url: 'https://example.com/s59', interval_seconds: 30 });
      expect(sixtieth.statusCode).toBe(200);
      expect(sixtieth.json().interval_seconds).toBe(30);
      const sixtyFirst = await createSite(app, user, { name: 'S60', url: 'https://example.com/s60' });
      expect(sixtyFirst.statusCode).toBe(403);
      expect(sixtyFirst.json().code).toBe('SITE_LIMIT');

      const tooFast = await app.inject({
        method: 'PATCH',
        url: `/sites/${sixtieth.json().id}`,
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { interval_seconds: 15 },
      });
      expect(tooFast.statusCode).toBe(403);
      expect(tooFast.json().code).toBe('MIN_INTERVAL');

      await insertHeartbeats(db, user.id, 25);
      const extraHb = await app.inject({
        method: 'POST',
        url: '/heartbeats',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { name: 'H25', period_seconds: 30 },
      });
      expect(extraHb.statusCode).toBe(403);
      expect(extraHb.json().code).toBe('HEARTBEAT_LIMIT');

      for (let i = 0; i < 5; i += 1) {
        const res = await app.inject({
          method: 'POST',
          url: '/status-page',
          headers: { ...authHeader(user), 'content-type': 'application/json' },
          payload: { title: `P${i}`, slug: `pro-status-${i}` },
        });
        expect(res.statusCode).toBe(200);
      }
      const sixthPage = await app.inject({
        method: 'POST',
        url: '/status-page',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { title: 'P5', slug: 'pro-status-5' },
      });
      expect(sixthPage.statusCode).toBe(403);
      expect(sixthPage.json().code).toBe('STATUS_PAGE_LIMIT');

      const { rows: sub } = await db.query('SELECT plan, billing_interval FROM subscriptions WHERE user_id = $1', [
        user.id,
      ]);
      expect(sub[0]).toMatchObject({ plan: 'pro', billing_interval: 'yearly' });

      const proGate = { seat_count: 3 };
      expect(() => assertCanAddSeat(proGate, 3)).toThrow(/Seat limit reached \(3\)/);
      expect(() => assertCanAddSeat({ seat_count: null }, 100)).not.toThrow();
    });
  });

  it('does not enforce cloud plan requirements in selfhosted mode', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'local@example.com', tier: 'selfhosted' });
      const res = await createSite(app, user, { interval_seconds: 5 });
      expect(res.statusCode).toBe(200);
      expect(res.json().interval_seconds).toBe(5);
    });
  });
});
