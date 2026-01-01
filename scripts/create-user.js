import { newApiKey } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { createPool, migrate } from '../src/db.js';
import { defaultUserTier } from '../src/guard.js';
import { apiKeyPrefix, hashSecret } from '../src/keys.js';
import { hashPassword } from '../src/password.js';

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const email = arg('email');
const password = arg('password');
const configEarly = { merdienzMode: process.env.MERDIENZ_MODE || 'cloud' };
const tier = arg('tier', defaultUserTier(configEarly.merdienzMode));

if (!email || !password) {
  console.error('Usage: node scripts/create-user.js --email you@example.com --password secret [--tier selfhosted]');
  process.exit(1);
}

const config = loadConfig();
if (!config.databaseUrl) {
  console.error('DATABASE_URL is required (start the app first, or point at your Postgres).');
  process.exit(1);
}

const db = createPool(config.databaseUrl);
await migrate(db);
const apiKey = newApiKey();
const passwordHash = await hashPassword(password);
try {
  const { rows } = await db.query(
    `INSERT INTO users (email, password_hash, api_key_prefix, api_key_hash, tier)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, email, tier, api_key_prefix`,
    [email, passwordHash, apiKeyPrefix(apiKey), hashSecret(apiKey), tier]
  );
  const user = rows[0];
  console.log('User created:');
  console.log(`  id:      ${user.id}`);
  console.log(`  email:   ${user.email}`);
  console.log(`  tier:    ${user.tier}`);
  console.log(`  prefix:  ${user.api_key_prefix}`);
  console.log(`  api_key: ${apiKey}`);
  console.log('Store the api_key now; it cannot be read back from the database.');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
