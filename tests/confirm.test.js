import { describe, expect, it } from 'vitest';
import { checkSite } from '../src/check-site.js';
import { createMailer } from '../src/alerts/email.js';
import { createUser, getDb, resetData, testConfig } from './helpers.js';

function fakeProbe(up, extra = {}) {
  return async () => ({
    up,
    httpStatus: up ? 200 : 500,
    latencyMs: 5,
    error: up ? null : 'status 500',
    ...extra,
  });
}

async function seedSite(db, { status = 'unknown' } = {}) {
  const user = await createUser(db, { email: 'ops@example.com', tier: 'selfhosted' });
  const { rows } = await db.query(
    `INSERT INTO sites (user_id, name, url, interval_seconds, current_status)
     VALUES ($1, 'Web', 'https://example.com', 300, $2)
     RETURNING *`,
    [user.id, status]
  );
  return { user, site: { ...rows[0], user_email: user.email } };
}

describe('two-probe confirmation', () => {
  it('records unconfirmed and does not alert when A fails and B succeeds', async () => {
    const db = await getDb();
    await resetData(db);
    const { site } = await seedSite(db);
    const mailer = createMailer(testConfig());
    const out = await checkSite(site, {
      db,
      mailer,
      config: testConfig(),
      probeA: fakeProbe(false),
      callB: fakeProbe(true),
    });
    expect(out.status).toBe('unconfirmed');
    expect(mailer.inbox).toHaveLength(0);
    const siteRow = await db.query('SELECT current_status FROM sites WHERE id = $1', [site.id]);
    expect(siteRow.rows[0].current_status).toBe('unconfirmed');
    const incidents = await db.query('SELECT * FROM incidents WHERE site_id = $1', [site.id]);
    expect(incidents.rowCount).toBe(0);
  });

  it('marks DOWN and sends an alert when both probes fail', async () => {
    const db = await getDb();
    await resetData(db);
    const { site } = await seedSite(db);
    const mailer = createMailer(testConfig());
    const out = await checkSite(site, {
      db,
      mailer,
      config: testConfig(),
      probeA: fakeProbe(false),
      callB: fakeProbe(false),
    });
    expect(out.status).toBe('down');
    expect(mailer.inbox).toHaveLength(1);
    expect(mailer.inbox[0].subject).toMatch(/DOWN/);
    expect(mailer.inbox[0].to).toBe('ops@example.com');
    const incidents = await db.query(
      `SELECT * FROM incidents WHERE site_id = $1 AND status = 'open'`,
      [site.id]
    );
    expect(incidents.rowCount).toBe(1);
  });

  it('sends a recovery alert when a down site comes back up', async () => {
    const db = await getDb();
    await resetData(db);
    const { site } = await seedSite(db, { status: 'unknown' });
    const mailer = createMailer(testConfig());
    const deps = {
      db,
      mailer,
      config: testConfig(),
    };
    await checkSite(site, { ...deps, probeA: fakeProbe(false), callB: fakeProbe(false) });
    expect(mailer.inbox).toHaveLength(1);

    const after = await db.query('SELECT * FROM sites WHERE id = $1', [site.id]);
    const recovered = await checkSite(
      { ...after.rows[0], user_email: site.user_email },
      { ...deps, probeA: fakeProbe(true), callB: fakeProbe(false) }
    );
    expect(recovered.status).toBe('up');
    expect(mailer.inbox).toHaveLength(2);
    expect(mailer.inbox[1].subject).toMatch(/RECOVERY/);
    const open = await db.query(
      `SELECT * FROM incidents WHERE site_id = $1 AND status = 'open'`,
      [site.id]
    );
    expect(open.rowCount).toBe(0);
    const resolved = await db.query(
      `SELECT * FROM incidents WHERE site_id = $1 AND status = 'resolved'`,
      [site.id]
    );
    expect(resolved.rowCount).toBe(1);
  });

  it('treats an unreachable probe B as unconfirmed, not down', async () => {
    const db = await getDb();
    await resetData(db);
    const { site } = await seedSite(db);
    const mailer = createMailer(testConfig());
    const out = await checkSite(site, {
      db,
      mailer,
      config: testConfig(),
      probeA: fakeProbe(false),
      callB: async () => ({
        up: null,
        unavailable: true,
        error: 'probe_b_unreachable',
        httpStatus: null,
        latencyMs: null,
      }),
    });
    expect(out.status).toBe('unconfirmed');
    expect(mailer.inbox).toHaveLength(0);
  });
});

  it('sends recovery and closes the incident for down -> unconfirmed -> up', async () => {
    const db = await getDb();
    await resetData(db);
    const { site } = await seedSite(db);
    const mailer = createMailer(testConfig());
    const deps = { db, mailer, config: testConfig() };
    await checkSite(site, { ...deps, probeA: fakeProbe(false), callB: fakeProbe(false) });
    expect(mailer.inbox).toHaveLength(1);

    const afterDown = (await db.query('SELECT * FROM sites WHERE id = $1', [site.id])).rows[0];
    const mid = await checkSite(
      { ...afterDown, user_email: site.user_email },
      { ...deps, probeA: fakeProbe(false), callB: fakeProbe(true) }
    );
    expect(mid.status).toBe('unconfirmed');
    expect(mailer.inbox).toHaveLength(1);
    const openMid = await db.query(`SELECT * FROM incidents WHERE site_id = $1 AND status = 'open'`, [site.id]);
    expect(openMid.rowCount).toBe(1);

    const afterUnc = (await db.query('SELECT * FROM sites WHERE id = $1', [site.id])).rows[0];
    const recovered = await checkSite(
      { ...afterUnc, user_email: site.user_email },
      { ...deps, probeA: fakeProbe(true), callB: fakeProbe(false) }
    );
    expect(recovered.status).toBe('up');
    expect(mailer.inbox).toHaveLength(2);
    expect(mailer.inbox[1].subject).toMatch(/RECOVERY/);
    const open = await db.query(`SELECT * FROM incidents WHERE site_id = $1 AND status = 'open'`, [site.id]);
    expect(open.rowCount).toBe(0);
  });

  it('does not re-alert for down -> unconfirmed -> down', async () => {
    const db = await getDb();
    await resetData(db);
    const { site } = await seedSite(db);
    const mailer = createMailer(testConfig());
    const deps = { db, mailer, config: testConfig() };
    await checkSite(site, { ...deps, probeA: fakeProbe(false), callB: fakeProbe(false) });
    const afterDown = (await db.query('SELECT * FROM sites WHERE id = $1', [site.id])).rows[0];
    await checkSite(
      { ...afterDown, user_email: site.user_email },
      { ...deps, probeA: fakeProbe(false), callB: fakeProbe(true) }
    );
    const afterUnc = (await db.query('SELECT * FROM sites WHERE id = $1', [site.id])).rows[0];
    const again = await checkSite(
      { ...afterUnc, user_email: site.user_email },
      { ...deps, probeA: fakeProbe(false), callB: fakeProbe(false) }
    );
    expect(again.status).toBe('down');
    expect(mailer.inbox).toHaveLength(1);
    const open = await db.query(`SELECT * FROM incidents WHERE site_id = $1 AND status = 'open'`, [site.id]);
    expect(open.rowCount).toBe(1);
  });
