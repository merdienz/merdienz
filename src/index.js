import { createMailer } from './alerts/email.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { allowsEmbeddedPostgres } from './env-values.js';
import { assertProbeConfig } from './guard.js';
import { createPool, migrate } from './db.js';
import { startScheduler } from './scheduler.js';
import { issueSetupTokenIfNeeded } from './setup.js';

const config = loadConfig();
assertProbeConfig(config);
let embedded = null;

if (!config.databaseUrl) {
  if (!allowsEmbeddedPostgres(config)) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const { startEmbeddedPostgres } = await import('./pg-embedded.js');
  embedded = await startEmbeddedPostgres({ port: config.pgPort, database: 'merdienz' });
  config.databaseUrl = embedded.url;
  console.log(`Started embedded Postgres on 127.0.0.1:${embedded.port}`);
}

const db = createPool(config.databaseUrl);
const skipMigrations = /^(1|true)$/i.test(process.env.MERDIENZ_SKIP_MIGRATIONS || '');
if (!skipMigrations) {
  await migrate(db);
}
await issueSetupTokenIfNeeded(db);

const mailer = createMailer(config);
const app = await createApp({ db, config, mailer });
await app.listen({ port: config.port, host: config.host });
console.log(`Merdienz API listening on port ${config.port}`);

const scheduler = startScheduler({
  db,
  mailer,
  config,
  logger: app.log,
});

async function shutdown() {
  scheduler.stop();
  await app.close();
  await db.end();
  if (embedded) await embedded.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
