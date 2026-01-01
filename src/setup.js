import { randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, fchmodSync, openSync, writeSync, constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newApiKey } from './auth.js';
import { bad } from './errors.js';
import { defaultUserTier } from './guard.js';
import { apiKeyPrefix, hashSecret } from './keys.js';
import { hashPassword } from './password.js';
import { isSingleEmailAddress } from './email-address.js';

function hashesEqual(a, b) {
  try {
    const left = Buffer.from(a, 'hex');
    const right = Buffer.from(b, 'hex');
    if (left.length === 0 || left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

export function defaultSetupTokenFile() {
  const suffix = randomBytes(8).toString('hex');
  if (process.env.MERDIENZ_SETUP_TOKEN_FILE) {
    return `${process.env.MERDIENZ_SETUP_TOKEN_FILE}-${suffix}`;
  }
  return join(tmpdir(), `merdienz-setup-token-${suffix}`);
}

export function writeSetupTokenFile(token, filePath) {
  const flags =
    fsConstants.O_WRONLY
    | fsConstants.O_CREAT
    | fsConstants.O_EXCL
    | (fsConstants.O_NOFOLLOW || 0);
  const fd = openSync(filePath, flags, 0o600);
  try {
    writeSync(fd, Buffer.from(`${token}\n`, 'utf8'));
    try {
      fchmodSync(fd, 0o600);
    } catch {
      // Some platforms ignore fchmod on this descriptor.
    }
  } finally {
    closeSync(fd);
  }
  return filePath;
}

export async function issueSetupTokenIfNeeded(db, { print = console.log, tokenFile } = {}) {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM users');
  if (rows[0].n > 0) return null;
  const existing = await db.query('SELECT 1 FROM setup_tokens WHERE used_at IS NULL LIMIT 1');
  if (existing.rowCount) {
    print('First-run setup is pending; the setup token was already issued and will not be printed again.');
    return { alreadyIssued: true };
  }
  const token = `mrzsetup_${randomBytes(24).toString('hex')}`;
  await db.query('INSERT INTO setup_tokens (token_hash) VALUES ($1)', [hashSecret(token)]);
  const path = tokenFile || defaultSetupTokenFile();
  writeSetupTokenFile(token, path);
  print(`First-run setup token written to ${path} (shown once; the token is not printed).`);
  print('Create the first user with POST /setup { token, email, password }. Auth is required after that.');
  return { token, tokenFile: path };
}

/** First-run setup is complete once any user exists (the /setup rule). */
export async function setupComplete(db) {
  const users = await db.query('SELECT count(*)::int AS n FROM users');
  return users.rows[0].n > 0;
}

export async function consumeSetupToken(db, { token, email, password, mode }) {
  if (await setupComplete(db)) {
    throw bad(403, 'setup is not available', 'SETUP_DONE');
  }
  if (!token || !email || !password) {
    throw bad(400, 'token, email and password are required', 'BAD_SETUP');
  }
  if (!isSingleEmailAddress(String(email).trim().toLowerCase())) {
    throw bad(400, 'email is not a valid single email address', 'BAD_EMAIL');
  }
  if (String(password).length < 8) {
    throw bad(400, 'password must be at least 8 characters', 'BAD_PASSWORD');
  }
  const tokenHash = hashSecret(String(token));
  const found = await db.query(
    'SELECT token_hash FROM setup_tokens WHERE used_at IS NULL'
  );
  const match = found.rows.find((row) => hashesEqual(row.token_hash, tokenHash));
  if (!match) {
    // Spend the same work as a hash compare even when nothing is pending.
    hashesEqual(tokenHash, tokenHash);
    throw bad(401, 'invalid setup token', 'INVALID_SETUP');
  }
  const apiKey = newApiKey();
  const passwordHash = await hashPassword(password);
  const tier = defaultUserTier(mode);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const used = await client.query(
      `UPDATE setup_tokens SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL
        RETURNING token_hash`,
      [match.token_hash]
    );
    if (!used.rowCount) {
      await client.query('ROLLBACK');
      throw bad(401, 'invalid setup token', 'INVALID_SETUP');
    }
    const { rows } = await client.query(
      `INSERT INTO users (email, password_hash, api_key_prefix, api_key_hash, tier)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, tier, created_at`,
      [String(email).trim().toLowerCase(), passwordHash, apiKeyPrefix(apiKey), hashSecret(apiKey), tier]
    );
    await client.query('COMMIT');
    return { user: rows[0], api_key: apiKey };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    if (err.code === '23505') throw bad(409, 'email already exists', 'EMAIL_TAKEN');
    throw err;
  } finally {
    client.release();
  }
}
