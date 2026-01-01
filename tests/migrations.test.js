import { describe, expect, it } from 'vitest';
import { migrate } from '../src/db.js';
import { getDb } from './helpers.js';

describe('migration runner aliases', () => {
  it('records both the new status migration name and the old 003_status.sql alias on a fresh database', async () => {
    const db = await getDb();
    await migrate(db);
    const { rows } = await db.query(
      `SELECT id FROM schema_migrations WHERE id IN ('003a_status.sql', '003_status.sql') ORDER BY id`
    );
    expect(rows.map((r) => r.id)).toEqual(['003_status.sql', '003a_status.sql']);
    const tables = await db.query(`SELECT to_regclass('public.status_pages') AS name`);
    expect(tables.rows[0].name).toBe('status_pages');
  });

  it('is a no-op SQL re-run when only the old 003_status.sql name is recorded', async () => {
    const db = await getDb();
    await db.query(`DELETE FROM schema_migrations WHERE id = '003a_status.sql'`);
    const onlyOld = await db.query(`SELECT 1 FROM schema_migrations WHERE id = '003_status.sql'`);
    expect(onlyOld.rowCount).toBe(1);
    await migrate(db);
    const { rows } = await db.query(
      `SELECT id FROM schema_migrations WHERE id IN ('003a_status.sql', '003_status.sql') ORDER BY id`
    );
    expect(rows.map((r) => r.id)).toEqual(['003_status.sql', '003a_status.sql']);
    const tables = await db.query(`SELECT to_regclass('public.status_pages') AS name`);
    expect(tables.rows[0].name).toBe('status_pages');
  });
});

describe('007 stripe billing', () => {
  it('adds stripe_events, billing hold columns, and allows past_due', async () => {
    const db = await getDb();
    await migrate(db);
    const recorded = await db.query(`SELECT 1 FROM schema_migrations WHERE id = '007_stripe_billing.sql'`);
    expect(recorded.rowCount).toBe(1);
    const table = await db.query(`SELECT to_regclass('public.stripe_events') AS name`);
    expect(table.rows[0].name).toBe('stripe_events');
    const cols = await db.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'subscriptions'
          AND column_name IN ('stripe_customer_id', 'stripe_subscription_id', 'grace_ends_at', 'last_stripe_event_at')
        ORDER BY column_name`
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual([
      'grace_ends_at',
      'last_stripe_event_at',
      'stripe_customer_id',
      'stripe_subscription_id',
    ]);
    const holds = await db.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE column_name = 'billing_hold' AND table_name IN ('sites', 'heartbeat_checks')
        ORDER BY table_name`
    );
    expect(holds.rows.map((r) => r.table_name)).toEqual(['heartbeat_checks', 'sites']);
    const uniq = await db.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'subscriptions_stripe_subscription_id_uidx'`
    );
    expect(uniq.rowCount).toBe(1);
  });
});
