import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { hashSecret, matchLookupHash } from './keys.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export function createPool(databaseUrl) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  pool.on('error', (err) => {
    if (err && /terminat/i.test(err.message || '')) return;
    console.error('pg pool error:', err.message);
  });
  return pool;
}

// Old filenames that were applied before a safe rename. If any alias is
// already in schema_migrations, skip the SQL and record the new name.
const MIGRATION_ALIASES = {
  '003a_status.sql': ['003_status.sql'],
};

export async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const applied = await pool.query('SELECT 1 FROM schema_migrations WHERE id = $1', [file]);
    if (applied.rowCount) {
      continue;
    }
    const aliases = MIGRATION_ALIASES[file] || [];
    const aliasApplied =
      aliases.length === 0
        ? { rowCount: 0 }
        : await pool.query('SELECT 1 FROM schema_migrations WHERE id = ANY($1::text[])', [aliases]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (aliasApplied.rowCount) {
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [
          file,
        ]);
      } else {
        const sql = readFileSync(join(migrationsDir, file), 'utf8');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
        for (const alias of aliases) {
          await client.query('INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [
            alias,
          ]);
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

export async function loadUserByApiKey(pool, apiKey) {
  if (!apiKey) return null;
  const hash = hashSecret(apiKey);
  const { rows } = await pool.query('SELECT * FROM users WHERE api_key_hash = $1', [hash]);
  const user = rows[0] || null;
  if (!matchLookupHash(apiKey, user?.api_key_hash)) return null;
  return user;
}

export async function loadUserBySession(pool, token) {
  if (!token) return null;
  const hash = hashSecret(token);
  const { rows } = await pool.query(
    `SELECT u.*
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hash]
  );
  const user = rows[0] || null;
  if (!user) {
    matchLookupHash(token, null);
    return null;
  }
  return user;
}

export async function loadGate(pool, tier) {
  const { rows } = await pool.query('SELECT * FROM plan_gates WHERE tier = $1', [tier]);
  return rows[0] || null;
}

export async function loadUserWithGate(pool, user) {
  const gate = await loadGate(pool, user.tier);
  return { user, gate };
}
