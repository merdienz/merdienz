import { describe, expect, it } from 'vitest';
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

async function resumeHb(app, user, id) {
  return app.inject({
    method: 'POST',
    url: `/heartbeats/${id}/resume`,
    headers: authHeader(user),
  });
}

describe('resume uses a locked row and does not recover an open incident', () => {
  it('recomputes the deadline from the locked schedule after a pause and a schedule change', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'resume-schedule@example.com' });
      const hb = await createHb(app, user, { name: 'Job', period_seconds: 3600, grace_seconds: 60 });
      const ping = await app.inject({ method: 'POST', url: pathFrom(hb.ping_urls.success) });
      expect(ping.statusCode).toBe(200);
      const paused = await app.inject({
        method: 'POST',
        url: `/heartbeats/${hb.id}/pause`,
        headers: authHeader(user),
      });
      expect(paused.json().status).toBe('paused');
      const patched = await app.inject({
        method: 'PATCH',
        url: `/heartbeats/${hb.id}`,
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { period_seconds: 900, grace_seconds: 60 },
      });
      expect(patched.statusCode).toBe(200);
      const before = Date.now();
      const resumed = await resumeHb(app, user, hb.id);
      expect(resumed.statusCode).toBe(200);
      expect(resumed.json().status).toBe('up');
      const expectedMs = new Date(resumed.json().expected_at).getTime();
      expect(expectedMs).toBeGreaterThan(before);
      expect(expectedMs - before).toBeLessThanOrEqual(900 * 1000 + 2000);
      expect(expectedMs - before).toBeGreaterThan(800 * 1000);
    });
  });

  it('keeps a paused down check down with its incident open until a success ping', async () => {
    await withApp(async ({ app, db, mailer }) => {
      const user = await createUser(db, { email: 'resume-down@example.com' });
      const hb = await createHb(app, user, { name: 'Job', period_seconds: 120, grace_seconds: 15 });
      const failed = await app.inject({ method: 'POST', url: pathFrom(hb.ping_urls.fail) });
      expect(failed.json().status).toBe('down');
      expect(mailer.inbox).toHaveLength(1);
      await app.inject({
        method: 'POST',
        url: `/heartbeats/${hb.id}/pause`,
        headers: authHeader(user),
      });
      const resumed = await resumeHb(app, user, hb.id);
      expect(resumed.statusCode).toBe(200);
      expect(resumed.json().status).toBe('down');
      const open = await db.query(
        `SELECT * FROM heartbeat_incidents WHERE check_id = $1 AND status = 'open'`,
        [hb.id]
      );
      expect(open.rowCount).toBe(1);
      const recovery = await db.query(
        `SELECT * FROM alert_outbox WHERE kind = 'recovery' AND to_email = $1`,
        [user.email]
      );
      expect(recovery.rowCount).toBe(0);
      expect(mailer.inbox).toHaveLength(1);
      const ping = await app.inject({ method: 'POST', url: pathFrom(hb.ping_urls.success) });
      expect(ping.json().status).toBe('up');
      const closed = await db.query(
        `SELECT * FROM heartbeat_incidents WHERE check_id = $1 AND status = 'open'`,
        [hb.id]
      );
      expect(closed.rowCount).toBe(0);
      expect(mailer.inbox.some((m) => /RECOVERY/.test(m.subject))).toBe(true);
    });
  });

  it('leaves a down check down when resume is called without pausing first', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'resume-still-down@example.com' });
      const hb = await createHb(app, user, { name: 'Job', period_seconds: 120, grace_seconds: 15 });
      await app.inject({ method: 'POST', url: pathFrom(hb.ping_urls.fail) });
      const resumed = await resumeHb(app, user, hb.id);
      expect(resumed.statusCode).toBe(200);
      expect(resumed.json().status).toBe('down');
      const open = await db.query(
        `SELECT * FROM heartbeat_incidents WHERE check_id = $1 AND status = 'open'`,
        [hb.id]
      );
      expect(open.rowCount).toBe(1);
    });
  });
});
