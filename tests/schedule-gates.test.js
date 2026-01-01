import { describe, expect, it } from 'vitest';
import { evaluateHeartbeats } from '../src/heartbeat-checks.js';
import { loadDueSites } from '../src/scheduler.js';
import { createUser, getDb, resetData } from './helpers.js';

describe('quota enforcement at schedule time', () => {
  it('applies a min-interval downgrade on the next tick and restores it after an upgrade', async () => {
    const db = await getDb();
    await resetData(db);
    const user = await createUser(db, { email: 'down@example.com', tier: 'selfhosted' });
    const site = await db.query(
      `INSERT INTO sites (user_id, name, url, interval_seconds, last_checked_at)
       VALUES ($1, 'Fast', 'https://example.com', 5, now() - interval '30 seconds')
       RETURNING *`,
      [user.id]
    );
    const due = await loadDueSites(db);
    expect(due.some((s) => s.id === site.rows[0].id)).toBe(true);

    await db.query(`UPDATE users SET tier = 'starter' WHERE id = $1`, [user.id]);
    await db.query(`UPDATE sites SET last_checked_at = now() - interval '30 seconds' WHERE id = $1`, [site.rows[0].id]);
    const blocked = await loadDueSites(db);
    expect(blocked.some((s) => s.id === site.rows[0].id)).toBe(false);

    await db.query(`UPDATE users SET tier = 'selfhosted' WHERE id = $1`, [user.id]);
    await db.query(`UPDATE sites SET last_checked_at = now() - interval '30 seconds' WHERE id = $1`, [site.rows[0].id]);
    const allowed = await loadDueSites(db);
    expect(allowed.some((s) => s.id === site.rows[0].id)).toBe(true);
  });

  it('skips sites and heartbeats beyond the plan cap after a downgrade, keeping earlier ones', async () => {
    const db = await getDb();
    await resetData(db);
    const user = await createUser(db, { email: 'cap@example.com', tier: 'selfhosted' });
    const ids = [];
    for (let i = 0; i < 16; i += 1) {
      const row = await db.query(
        `INSERT INTO sites (user_id, name, url, interval_seconds, last_checked_at)
         VALUES ($1, $2, $3, 300, now() - interval '10 minutes')
         RETURNING id`,
        [user.id, `S${i}`, `https://example.com/s${i}`]
      );
      ids.push(row.rows[0].id);
    }
    const hb = [];
    for (let i = 0; i < 6; i += 1) {
      const row = await db.query(
        `INSERT INTO heartbeat_checks (user_id, name, period_seconds, grace_seconds, status, expected_at, grace_until)
         VALUES ($1, $2, 60, 5, 'up', now() - interval '1 minute', now() - interval '1 minute')
         RETURNING id`,
        [user.id, `H${i}`]
      );
      hb.push(row.rows[0].id);
    }

    await db.query(`UPDATE users SET tier = 'starter' WHERE id = $1`, [user.id]);
    const due = await loadDueSites(db);
    expect(due.map((s) => s.id).sort()).toEqual(ids.slice(0, 15).sort());

    const changes = await evaluateHeartbeats({ db, mailer: null, now: new Date() });
    const changed = changes.map((c) => c.id);
    expect(changed.every((id) => hb.slice(0, 5).includes(id))).toBe(true);
    expect(changed.some((id) => hb.slice(5).includes(id))).toBe(false);
  });
});
