import { describe, expect, it } from 'vitest';
import { createMailer } from '../src/alerts/email.js';
import { retryPendingAlerts } from '../src/alerts/outbox.js';
import { checkSite } from '../src/check-site.js';
import { evaluateHeartbeats, receivePing } from '../src/heartbeat-checks.js';
import { authHeader, createUser, getDb, resetData, testConfig, withApp } from './helpers.js';

function pathFrom(url) {
  return new URL(url).pathname;
}

function fakeProbe(up, extra = {}) {
  return async () => ({
    up,
    httpStatus: up ? 200 : 500,
    latencyMs: 5,
    error: up ? null : 'status 500',
    ...extra,
  });
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

async function unsentOutbox(db, { kind, to } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM alert_outbox
      WHERE sent_at IS NULL
        AND skipped_at IS NULL
        AND ($1::text IS NULL OR kind = $1)
        AND ($2::text IS NULL OR to_email = $2)
      ORDER BY created_at ASC`,
    [kind || null, to || null]
  );
  return rows;
}

async function seedSite(db) {
  const user = await createUser(db, { email: 'site-ops@example.com', tier: 'selfhosted' });
  const { rows } = await db.query(
    `INSERT INTO sites (user_id, name, url, interval_seconds, current_status)
     VALUES ($1, 'Web', 'https://example.com', 300, 'unknown')
     RETURNING *`,
    [user.id]
  );
  return { user, site: { ...rows[0], user_email: user.email } };
}

describe('alert outbox rows survive a crash after the status change commits', () => {
  it('keeps a fail-ping DOWN row so the worker can deliver it', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'fail-outbox@example.com' });
      const hb = await createHb(app, user, { name: 'Job', period_seconds: 120, grace_seconds: 15 });
      const check = (await db.query('SELECT h.*, u.email AS user_email FROM heartbeat_checks h JOIN users u ON u.id = h.user_id WHERE h.id = $1', [hb.id])).rows[0];
      const out = await receivePing(db, check, { kind: 'fail', exitCode: 1, mailer: null });
      expect(out.check.status).toBe('down');
      const rows = await unsentOutbox(db, { kind: 'down', to: user.email });
      expect(rows).toHaveLength(1);
      expect(rows[0].subject).toMatch(/DOWN/);
      const mailer = createMailer(testConfig());
      const retried = await retryPendingAlerts(db, mailer);
      expect(retried.retried).toBe(1);
      expect(mailer.inbox).toHaveLength(1);
      expect(mailer.inbox[0].subject).toMatch(/DOWN/);
      const sent = (await db.query('SELECT sent_at FROM alert_outbox WHERE id = $1', [rows[0].id])).rows[0];
      expect(sent.sent_at).not.toBeNull();
    });
  });

  it('keeps a recovery-ping row so the worker can deliver it', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'recovery-outbox@example.com' });
      const hb = await createHb(app, user, { name: 'Job', period_seconds: 120, grace_seconds: 15 });
      const check = (await db.query('SELECT h.*, u.email AS user_email FROM heartbeat_checks h JOIN users u ON u.id = h.user_id WHERE h.id = $1', [hb.id])).rows[0];
      await receivePing(db, check, { kind: 'fail', exitCode: 1, mailer: null });
      const afterFail = (await db.query('SELECT h.*, u.email AS user_email FROM heartbeat_checks h JOIN users u ON u.id = h.user_id WHERE h.id = $1', [hb.id])).rows[0];
      const recovered = await receivePing(db, afterFail, { kind: 'success', exitCode: 0, mailer: null });
      expect(recovered.check.status).toBe('up');
      const rows = await unsentOutbox(db, { kind: 'recovery', to: user.email });
      expect(rows).toHaveLength(1);
      const mailer = createMailer(testConfig());
      const retried = await retryPendingAlerts(db, mailer);
      expect(retried.retried).toBeGreaterThanOrEqual(1);
      expect(mailer.inbox.some((m) => /RECOVERY/.test(m.subject))).toBe(true);
      const sent = (await db.query('SELECT sent_at FROM alert_outbox WHERE id = $1', [rows[0].id])).rows[0];
      expect(sent.sent_at).not.toBeNull();
    });
  });

  it('keeps an evaluator missed-DOWN row so the worker can deliver it', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'eval-outbox@example.com' });
      const hb = await createHb(app, user, { name: 'Hourly', period_seconds: 3600, grace_seconds: 60 });
      await app.inject({ method: 'GET', url: pathFrom(hb.ping_urls.success) });
      const now = Date.now();
      await db.query(
        `UPDATE heartbeat_checks SET expected_at = $2, grace_until = $3 WHERE id = $1`,
        [hb.id, new Date(now - 90_000), new Date(now - 30_000)]
      );
      const changes = await evaluateHeartbeats({ db, mailer: null, now: new Date(now) });
      expect(changes).toEqual([expect.objectContaining({ id: hb.id, status: 'down' })]);
      const status = (await db.query('SELECT status FROM heartbeat_checks WHERE id = $1', [hb.id])).rows[0];
      expect(status.status).toBe('down');
      const rows = await unsentOutbox(db, { kind: 'down', to: user.email });
      expect(rows).toHaveLength(1);
      expect(rows[0].subject).toMatch(/DOWN/);
      const mailer = createMailer(testConfig());
      const retried = await retryPendingAlerts(db, mailer);
      expect(retried.retried).toBe(1);
      expect(mailer.inbox).toHaveLength(1);
      const sent = (await db.query('SELECT sent_at FROM alert_outbox WHERE id = $1', [rows[0].id])).rows[0];
      expect(sent.sent_at).not.toBeNull();
    });
  });

  it('keeps a site DOWN row so the worker can deliver it', async () => {
    const db = await getDb();
    await resetData(db);
    const { site } = await seedSite(db);
    const out = await checkSite(site, {
      db,
      mailer: null,
      config: testConfig(),
      probeA: fakeProbe(false),
      callB: fakeProbe(false),
    });
    expect(out.status).toBe('down');
    const open = await db.query(`SELECT * FROM incidents WHERE site_id = $1 AND status = 'open'`, [site.id]);
    expect(open.rowCount).toBe(1);
    const rows = await unsentOutbox(db, { kind: 'down', to: site.user_email });
    expect(rows).toHaveLength(1);
    const mailer = createMailer(testConfig());
    const retried = await retryPendingAlerts(db, mailer);
    expect(retried.retried).toBe(1);
    expect(mailer.inbox[0].subject).toMatch(/DOWN/);
    const sent = (await db.query('SELECT sent_at FROM alert_outbox WHERE id = $1', [rows[0].id])).rows[0];
    expect(sent.sent_at).not.toBeNull();
  });

  it('keeps a site recovery row so the worker can deliver it', async () => {
    const db = await getDb();
    await resetData(db);
    const { site } = await seedSite(db);
    const deps = { db, mailer: null, config: testConfig() };
    await checkSite(site, { ...deps, probeA: fakeProbe(false), callB: fakeProbe(false) });
    const after = (await db.query('SELECT * FROM sites WHERE id = $1', [site.id])).rows[0];
    const recovered = await checkSite(
      { ...after, user_email: site.user_email },
      { ...deps, probeA: fakeProbe(true), callB: fakeProbe(false) }
    );
    expect(recovered.status).toBe('up');
    const rows = await unsentOutbox(db, { kind: 'recovery', to: site.user_email });
    expect(rows).toHaveLength(1);
    const mailer = createMailer(testConfig());
    const retried = await retryPendingAlerts(db, mailer);
    expect(retried.retried).toBeGreaterThanOrEqual(1);
    expect(mailer.inbox.some((m) => /RECOVERY/.test(m.subject))).toBe(true);
    const sent = (await db.query('SELECT sent_at FROM alert_outbox WHERE id = $1', [rows[0].id])).rows[0];
    expect(sent.sent_at).not.toBeNull();
  });
});
