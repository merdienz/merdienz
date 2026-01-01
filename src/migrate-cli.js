import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { allowsEmbeddedPostgres } from './env-values.js';

const config = loadConfig();
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
  console.log('Set DATABASE_URL to reuse this instance; it will stop when this process exits.');
}
const db = createPool(config.databaseUrl);
await migrate(db);
console.log('Migrations applied.');
await db.end();
if (embedded) await embedded.stop();
