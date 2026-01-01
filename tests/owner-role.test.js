import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createPool, migrate } from '../src/db.js';
import { startEmbeddedPostgres } from '../src/pg-embedded.js';
import { tp } from './ports.js';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// The role grants live in the operator deploy package, which is not part of every checkout.
const hasDeployPackage = existsSync(join(appRoot, 'deploy/cloud/postgres/create-app-role.sql'));
const PG_PORT = tp(4857);
const APP_PORT = tp(4856);

function runApp(env, timeoutMs = 15000) {
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: appRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderrChunks = [];
  const stdoutChunks = [];
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
  child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
  const output = () => `${Buffer.concat(stdoutChunks).toString('utf8')}\n${Buffer.concat(stderrChunks).toString('utf8')}`;
  const exit = new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, timedOut: true, output: output() });
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut: false, output: output() });
    });
  });
  return { child, exit, output };
}

async function waitFor(fn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch (err) {
      last = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw last || new Error('timed out');
}

describe.skipIf(!hasDeployPackage)('owner and app database roles', () => {
  let embedded;
  const tokenDir = mkdtempSync(join(tmpdir(), 'merdienz-setup-token-'));

  afterAll(async () => {
    rmSync(tokenDir, { recursive: true, force: true });
    if (embedded) await embedded.stop();
  });

  it('migrates as merdienz_owner and boots the app as merdienz_app without migrate', async () => {
    embedded = await startEmbeddedPostgres({
      port: PG_PORT,
      database: 'merdienz_owned',
      user: 'merdienz',
      password: 'merdienz',
    });
    const admin = createPool(embedded.url);
    await admin.query(`
      CREATE ROLE merdienz_owner LOGIN PASSWORD 'owner-pass'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
    `);
    await admin.query(`
      CREATE ROLE merdienz_app LOGIN PASSWORD 'app-pass'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
    `);
    await admin.query('GRANT merdienz_owner TO merdienz');
    await admin.query('ALTER DATABASE merdienz_owned OWNER TO merdienz_owner');
    await admin.query('GRANT CONNECT ON DATABASE merdienz_owned TO merdienz_owner, merdienz_app');
    await admin.query('REVOKE ALL ON DATABASE merdienz_owned FROM PUBLIC');
    await admin.end();

    const ownerUrl = `postgres://merdienz_owner:owner-pass@127.0.0.1:${PG_PORT}/merdienz_owned`;
    const appUrl = `postgres://merdienz_app:app-pass@127.0.0.1:${PG_PORT}/merdienz_owned`;
    const owner = createPool(ownerUrl);
    await owner.query('ALTER SCHEMA public OWNER TO merdienz_owner');
    await owner.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await owner.query('GRANT USAGE, CREATE ON SCHEMA public TO merdienz_owner');
    await owner.query('GRANT USAGE ON SCHEMA public TO merdienz_app');
    await migrate(owner);
    const grantSql = await import('node:fs').then((fs) =>
      fs.readFileSync(join(appRoot, 'deploy/cloud/postgres/create-app-role.sql'), 'utf8')
    );
    // The snippet mentions merdienz database only in comments now; grants are on the current db.
    await owner.query(grantSql);
    await owner.end();

    const appPool = createPool(appUrl);
    await expect(appPool.query('CREATE TABLE merdienz_should_fail (id int)')).rejects.toThrow(/permission denied/i);
    await appPool.query('SELECT count(*) FROM schema_migrations');
    await appPool.end();

    const env = {
      ...process.env,
      DATABASE_URL: appUrl,
      MERDIENZ_SKIP_MIGRATIONS: '1',
      MERDIENZ_SETUP_TOKEN_FILE: join(tokenDir, 'setup-token'),
      NODE_ENV: 'test',
      MERDIENZ_MODE: 'test',
      PORT: String(APP_PORT),
      HOST: '127.0.0.1',
      MAIL_TRANSPORT: 'dev',
      PROBE_B_SECRET: 'x'.repeat(32),
      PROBE_B_URL: '',
      COOKIE_SECRET: 'test-cookie-secret-32-bytes-long!!',
    };
    const { child, exit } = runApp(env);
    try {
      await waitFor(async () => {
        const res = await fetch(`http://127.0.0.1:${APP_PORT}/health`);
        return res.ok;
      });
      const health = await fetch(`http://127.0.0.1:${APP_PORT}/health`);
      expect(health.ok).toBe(true);
      expect(await health.json()).toEqual({ ok: true });
    } finally {
      child.kill('SIGTERM');
      await exit;
    }
  }, 30_000);
});
