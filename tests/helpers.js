import { createServer } from 'node:http';
import { createMailer } from '../src/alerts/email.js';
import { createApp } from '../src/app.js';
import { newApiKey } from '../src/auth.js';
import { apiKeyPrefix, hashSecret } from '../src/keys.js';
import { loadConfig } from '../src/config.js';
import { createPool, migrate } from '../src/db.js';
import { hashPassword } from '../src/password.js';
import { startEmbeddedPostgres } from '../src/pg-embedded.js';
import { tp } from './ports.js';

let embedded;
let pool;

export async function getDb() {
  if (pool) return pool;
  embedded = await startEmbeddedPostgres({
    port: tp(4858),
    database: 'merdienz_test',
    user: 'merdienz',
    password: 'merdienz',
  });
  process.env.DATABASE_URL = embedded.url;
  pool = createPool(embedded.url);
  await migrate(pool);
  return pool;
}

export async function resetData(db) {
  await db.query(
    'TRUNCATE site_insights, alert_outbox, heartbeat_pings, heartbeat_incidents, heartbeat_checks, incidents, check_results, sites, status_pages, stripe_events, subscriptions, sessions, setup_tokens, users RESTART IDENTITY CASCADE'
  );
}

export async function createUser(db, { email, password = 'secret', tier = 'selfhosted' }) {
  const apiKey = newApiKey();
  const passwordHash = await hashPassword(password);
  const { rows } = await db.query(
    `INSERT INTO users (email, password_hash, api_key_prefix, api_key_hash, tier)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [email, passwordHash, apiKeyPrefix(apiKey), hashSecret(apiKey), tier]
  );
  return { ...rows[0], password, apiKey };
}

export function testConfig(overrides = {}) {
  return loadConfig({
    nodeEnv: 'test',
    merdienzMode: 'test',
    host: '127.0.0.1',
    port: 4840,
    mailTransport: 'dev',
    probeBSecret: 'x'.repeat(32),
    probeBUrl: '',
    heartbeatUrl: '',
    schedulerIntervalMs: 60000,
    allowPrivateTargets: true,
    trustedProxies: [],
    probeBMaxSkewSec: 30,
    cookieSecret: 'test-cookie-secret-32-bytes-long!!',
    seoChecks: 'off',
    ...overrides,
    mailTransport:
      overrides.mailTransport ??
      ((overrides.nodeEnv ?? 'test') === 'production' || (overrides.merdienzMode ?? 'test') === 'cloud'
        ? 'none'
        : 'dev'),
  });
}

export async function withApp(fn, overrides = {}) {
  const db = await getDb();
  await resetData(db);
  const config = testConfig(overrides.config || {});
  const mailer = createMailer(config);
  const app = await createApp({
    db,
    config,
    mailer,
    fetchFn: overrides.fetchFn,
  });
  await app.ready();
  try {
    return await fn({ app, db, mailer, config });
  } finally {
    await app.close();
  }
}

export function authHeader(user) {
  return { 'x-api-key': user.apiKey };
}

export async function grantPlan(db, userId, plan, billingInterval = 'monthly') {
  if (!['starter', 'pro'].includes(plan)) {
    throw new Error('plan must be starter or pro');
  }
  if (!['monthly', 'yearly'].includes(billingInterval)) {
    throw new Error('billing_interval must be monthly or yearly');
  }
  await db.query('UPDATE users SET tier = $2 WHERE id = $1', [userId, plan]);
  await db.query(
    `INSERT INTO subscriptions (user_id, plan, billing_interval, status)
     VALUES ($1, $2, $3, 'active')
     ON CONFLICT (user_id) DO UPDATE
       SET plan = excluded.plan,
           billing_interval = excluded.billing_interval,
           status = 'active',
           updated_at = now()`,
    [userId, plan, billingInterval]
  );
}

export function startLocalServer(handler, port) {
  const server = createServer((req, res) => handler(req, res, server));
  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      server.url = `http://127.0.0.1:${address.port}`;
      resolve(server);
    });
    server.on('error', reject);
  });
}

export async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}
