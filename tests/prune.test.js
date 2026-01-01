import { describe, expect, it } from 'vitest';
import { pruneRetention } from '../src/prune.js';
import { createUser, getDb, resetData } from './helpers.js';

describe('retention pruning', () => {
  it('deletes old results and resolved incidents, keeps recent rows and open incidents', async () => {
    const db = await getDb();
    await resetData(db);
    const capped = await createUser(db, { email: 'capped@example.com', tier: 'starter' });
    const uncapped = await createUser(db, { email: 'open@example.com', tier: 'selfhosted' });

    const cappedSite = await db.query(
      `INSERT INTO sites (user_id, name, url) VALUES ($1, 'A', 'https://a.example') RETURNING id`,
      [capped.id]
    );
    const freeSite = await db.query(
      `INSERT INTO sites (user_id, name, url) VALUES ($1, 'B', 'https://b.example') RETURNING id`,
      [uncapped.id]
    );
    const hb = await db.query(
      `INSERT INTO heartbeat_checks (user_id, name, period_seconds, grace_seconds)
       VALUES ($1, 'Job', 60, 10) RETURNING id`,
      [capped.id]
    );

    // starter retains 365 days; pick cutoffs around that window.
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    const recent = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

    await db.query(
      `INSERT INTO check_results (site_id, status, checked_at) VALUES
        ($1, 'up', $3), ($1, 'down', $4), ($2, 'up', $3)`,
      [cappedSite.rows[0].id, freeSite.rows[0].id, old, recent]
    );
    await db.query(
      `INSERT INTO heartbeat_pings (check_id, kind, received_at) VALUES ($1, 'success', $2), ($1, 'success', $3)`,
      [hb.rows[0].id, old, recent]
    );
    const openInc = await db.query(
      `INSERT INTO incidents (site_id, status, started_at) VALUES ($1, 'open', $2) RETURNING id`,
      [cappedSite.rows[0].id, old]
    );
    const resolvedInc = await db.query(
      `INSERT INTO incidents (site_id, status, started_at, ended_at)
       VALUES ($1, 'resolved', $2, $2) RETURNING id`,
      [cappedSite.rows[0].id, old]
    );
    await db.query(
      `INSERT INTO heartbeat_incidents (check_id, status, started_at, ended_at)
       VALUES ($1, 'resolved', $2, $2), ($1, 'open', $2, NULL)`,
      [hb.rows[0].id, old]
    );

    const summary = await pruneRetention(db);
    expect(summary.check_results).toBe(1);
    expect(summary.heartbeat_pings).toBe(1);
    expect(summary.incidents).toBe(1);
    expect(summary.heartbeat_incidents).toBe(1);

    const results = await db.query('SELECT site_id, checked_at FROM check_results ORDER BY checked_at');
    expect(results.rowCount).toBe(2);
    expect(results.rows.some((r) => r.site_id === freeSite.rows[0].id)).toBe(true);
    expect(results.rows.some((r) => r.site_id === cappedSite.rows[0].id)).toBe(true);

    const pings = await db.query('SELECT received_at FROM heartbeat_pings');
    expect(pings.rowCount).toBe(1);

    const incidents = await db.query('SELECT id, status FROM incidents');
    expect(incidents.rows.map((r) => r.id).sort()).toEqual([openInc.rows[0].id]);
    expect(incidents.rows.some((r) => r.id === resolvedInc.rows[0].id)).toBe(false);

    const hbInc = await db.query('SELECT status FROM heartbeat_incidents');
    expect(hbInc.rows).toEqual([{ status: 'open' }]);
  });
});
