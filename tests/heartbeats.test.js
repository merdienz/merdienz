import { describe, expect, it } from 'vitest';
import { nextCronOccurrence } from '../src/cron.js';
import { evaluateHeartbeats } from '../src/heartbeat-checks.js';
import { authHeader, createUser, withApp } from './helpers.js';

async function createHeartbeat(app, user, payload) {
  return app.inject({
    method: 'POST',
    url: '/heartbeats',
    headers: { ...authHeader(user), 'content-type': 'application/json' },
    payload,
  });
}

describe('heartbeat checks', () => {
  it('creates, lists, and deletes a period-based check with snippets, gated by plan', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'hb@example.com', tier: 'selfhosted' });
      const created = await createHeartbeat(app, user, {
        name: 'Nightly backup',
        period_seconds: 3600,
        grace_seconds: 300,
      });
      expect(created.statusCode).toBe(200);
      const body = created.json();
      expect(body.status).toBe('new');
      expect(body.ping_urls.success).toMatch(/\/ping\/[0-9a-f-]{36}$/);
      expect(body.snippets.curl).toContain(body.ping_urls.success);
      expect(body.snippets.cron).toContain('curl');
      expect(body.snippets.systemd).toContain('ExecStart');
      expect(body.snippets.github_actions).toContain('Ping Merdienz');

      const listed = await app.inject({ method: 'GET', url: '/heartbeats', headers: authHeader(user) });
      expect(listed.json().heartbeats).toHaveLength(1);

      const deleted = await app.inject({
        method: 'DELETE',
        url: `/heartbeats/${body.id}`,
        headers: authHeader(user),
      });
      expect(deleted.statusCode).toBe(200);
    });
  });

  it('rejects a client-supplied tier and enforces the cloud heartbeat quota', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'cap@example.com', tier: 'starter' });
      const bypass = await createHeartbeat(app, user, {
        name: 'Nope',
        period_seconds: 60,
        tier: 'selfhosted',
      });
      expect(bypass.statusCode).toBe(400);
      expect(bypass.json().code).toBe('TIER_OVERRIDE');

      for (let i = 0; i < 5; i += 1) {
        await db.query(
          `INSERT INTO heartbeat_checks (user_id, name, period_seconds, grace_seconds)
           VALUES ($1, $2, 60, 10)`,
          [user.id, `H${i}`]
        );
      }
      const blocked = await createHeartbeat(app, user, { name: 'H3', period_seconds: 60 });
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json().code).toBe('HEARTBEAT_LIMIT');
    });
  });

  it('logs a success ping (time, IP, UA, excerpt) and moves new -> up', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'ping@example.com' });
      const created = await createHeartbeat(app, user, { name: 'Job', period_seconds: 60, grace_seconds: 10 });
      const token = created.json().ping_urls.success.split('/ping/')[1];
      const ping = await app.inject({
        method: 'POST',
        url: `/ping/${token}`,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'cron/1.0',
          'x-forwarded-for': '203.0.113.9, 10.0.0.1',
        },
        payload: { note: 'finished ok', exit_code: 0 },
      });
      expect(ping.statusCode).toBe(200);
      expect(ping.json().status).toBe('up');

      const detail = await app.inject({
        method: 'GET',
        url: `/heartbeats/${created.json().id}`,
        headers: authHeader(user),
      });
      const page = detail.json();
      expect(page.status).toBe('up');
      expect(page.last_exit_code).toBe(0);
      expect(page.pings).toHaveLength(1);
      expect(page.pings[0].kind).toBe('success');
      expect(page.pings[0].source_ip).toMatch(/127\.0\.0\.1|::1/);
      expect(page.pings[0].source_ip).not.toBe('203.0.113.9');
      expect(page.pings[0].user_agent).toBe('cron/1.0');
      expect(page.pings[0].body_excerpt).toContain('finished ok');
      expect(page.pings[0].received_at).toBeTruthy();
    });
  });

  it('marks late inside grace and down after grace, then recovers with an alert', async () => {
    await withApp(async ({ app, db, mailer }) => {
      const user = await createUser(db, { email: 'late@example.com' });
      const created = await createHeartbeat(app, user, {
        name: 'Hourly',
        period_seconds: 3600,
        grace_seconds: 60,
      });
      const id = created.json().id;
      const token = created.json().ping_urls.success.split('/ping/')[1];
      await app.inject({ method: 'GET', url: `/ping/${token}` });

      const now = Date.now();
      await db.query(
        `UPDATE heartbeat_checks
            SET expected_at = $2, grace_until = $3
          WHERE id = $1`,
        [id, new Date(now - 30_000), new Date(now + 30_000)]
      );

      const late = await evaluateHeartbeats({ db, mailer, now: new Date(now) });
      expect(late).toEqual([expect.objectContaining({ id, status: 'late' })]);
      expect(mailer.inbox).toHaveLength(0);

      const down = await evaluateHeartbeats({ db, mailer, now: new Date(now + 31_000) });
      expect(down[0].status).toBe('down');
      expect(mailer.inbox).toHaveLength(1);
      expect(mailer.inbox[0].subject).toMatch(/DOWN/);

      const recovered = await app.inject({ method: 'GET', url: `/ping/${token}` });
      expect(recovered.json().status).toBe('up');
      expect(mailer.inbox).toHaveLength(2);
      expect(mailer.inbox[1].subject).toMatch(/RECOVERY/);
    });
  });

  it('treats /fail and a non-zero exit code as down, and /start as a new window', async () => {
    await withApp(async ({ app, db, mailer }) => {
      const user = await createUser(db, { email: 'fail@example.com' });
      const created = await createHeartbeat(app, user, { name: 'Task', period_seconds: 120, grace_seconds: 15 });
      const urls = created.json().ping_urls;
      const token = urls.success.split('/ping/')[1];

      const started = await app.inject({ method: 'GET', url: `/ping/${token}/start` });
      expect(started.json().status).toBe('up');

      const failed = await app.inject({ method: 'POST', url: `/ping/${token}/fail` });
      expect(failed.json().status).toBe('down');
      expect(mailer.inbox).toHaveLength(1);

      const byExit = await app.inject({ method: 'GET', url: `/ping/${token}/0` });
      expect(byExit.json().status).toBe('up');
      expect(mailer.inbox).toHaveLength(2);

      const failExit = await app.inject({ method: 'GET', url: `/ping/${token}/12` });
      expect(failExit.json().status).toBe('down');
      expect(mailer.inbox).toHaveLength(3);
    });
  });

  it('does not alert a paused check that is overdue', async () => {
    await withApp(async ({ app, db, mailer }) => {
      const user = await createUser(db, { email: 'pause@example.com' });
      const created = await createHeartbeat(app, user, { name: 'Paused', period_seconds: 60, grace_seconds: 5 });
      const id = created.json().id;
      const token = created.json().ping_urls.success.split('/ping/')[1];
      await app.inject({ method: 'GET', url: `/ping/${token}` });
      const paused = await app.inject({
        method: 'POST',
        url: `/heartbeats/${id}/pause`,
        headers: authHeader(user),
      });
      expect(paused.json().status).toBe('paused');

      await db.query(
        `UPDATE heartbeat_checks SET expected_at = now() - interval '1 hour', grace_until = now() - interval '1 hour' WHERE id = $1`,
        [id]
      );
      const changes = await evaluateHeartbeats({ db, mailer, now: new Date() });
      expect(changes).toHaveLength(0);
      expect(mailer.inbox).toHaveLength(0);
      const still = await app.inject({
        method: 'GET',
        url: `/heartbeats/${id}`,
        headers: authHeader(user),
      });
      expect(still.json().status).toBe('paused');

      const resumed = await app.inject({
        method: 'POST',
        url: `/heartbeats/${id}/resume`,
        headers: authHeader(user),
      });
      expect(resumed.json().status).toBe('up');
    });
  });

  it('accepts a cron schedule with a timezone and computes the next fire', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'cron@example.com' });
      const created = await createHeartbeat(app, user, {
        name: 'Midnight',
        cron_expr: '0 0 * * *',
        timezone: 'Asia/Jakarta',
        grace_seconds: 600,
      });
      expect(created.statusCode).toBe(200);
      expect(created.json().cron_expr).toBe('0 0 * * *');
      expect(created.json().timezone).toBe('Asia/Jakarta');

      const from = new Date('2026-11-23T10:00:00Z');
      const next = nextCronOccurrence('0 0 * * *', 'Asia/Jakarta', from);
      // 00:00 Asia/Jakarta is 17:00 UTC the previous day; after 10:00 UTC that's 17:00 UTC Nov 23.
      expect(next.toISOString()).toBe('2026-11-23T17:00:00.000Z');
    });
  });
});
