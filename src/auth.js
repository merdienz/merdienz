import { loadGate, loadUserByApiKey, loadUserBySession } from './db.js';
import { hashSecret, newApiKey, newSessionToken } from './keys.js';
import { verifyPassword } from './password.js';
import { enforceCsrf, isMutating } from './csrf.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function bearerToken(request) {
  const header = request.headers.authorization;
  if (!header || typeof header !== 'string') return null;
  const [scheme, token] = header.split(/\s+/);
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== 'bearer') return null;
  return token;
}

export function extractCredentials(request) {
  const bearer = bearerToken(request);
  const headerApiKey = request.headers['x-api-key']
    ? String(request.headers['x-api-key'])
    : null;
  const bearerApiKey = bearer && String(bearer).startsWith('mrz_') ? bearer : null;
  const apiKey = headerApiKey || bearerApiKey || null;
  const headerSession =
    request.headers['x-session-token']
    || (!apiKey && bearer && !String(bearer).startsWith('mrz_') ? bearer : null)
    || null;
  const cookieSession = request.cookies?.session || null;
  const sessionToken = headerSession || cookieSession || null;
  return {
    apiKey,
    sessionToken,
    headerApiKey,
    bearerApiKey,
    headerSession,
    cookieSession,
  };
}

export function rateLimitKey(req) {
  if (req.user?.id) return `user:${req.user.id}`;
  return `ip:${req.ip}`;
}

export async function attachUser(request) {
  if (request.user) return;
  const creds = extractCredentials(request);
  let user = null;
  let authVia = null;
  if (creds.apiKey) {
    user = await loadUserByApiKey(request.server.db, creds.apiKey);
    if (user) authVia = 'api-key';
  }
  if (!user && creds.headerSession) {
    user = await loadUserBySession(request.server.db, creds.headerSession);
    if (user) authVia = 'session';
  }
  if (!user && creds.cookieSession) {
    user = await loadUserBySession(request.server.db, creds.cookieSession);
    if (user) authVia = 'cookie';
  }
  if (!user) return;
  const gate = await loadGate(request.server.db, user.tier);
  if (!gate) return;
  request.user = user;
  request.gate = gate;
  request.authVia = authVia;
}

export async function authenticate(request, reply) {
  if (!request.user) {
    await attachUser(request);
  }
  if (!request.user) {
    return reply.code(401).send({ error: 'unauthorized', code: 'UNAUTHORIZED' });
  }
  if (!request.gate) {
    return reply.code(403).send({ error: 'unknown tier', code: 'UNKNOWN_TIER' });
  }
  if (isMutating(request.method) && request.authVia === 'cookie') {
    await enforceCsrf(request.server, request, reply);
  }
}

export function publicUser(user) {
  return { id: user.id, email: user.email, tier: user.tier, created_at: user.created_at };
}

export function normalizeLoginEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

// Sign-up and /setup store emails lowercased, but operator-created accounts
// (scripts/create-user.js) keep whatever casing was typed. So the lookup is
// case-insensitive. If two accounts differ only by case, the one whose stored
// email matches the typed one exactly wins; if none does, the login fails
// rather than guessing.
export function pickLoginUser(rows, rawEmail, normalized) {
  if (!rows.length) return undefined;
  if (rows.length === 1) return rows[0];
  const typed = typeof rawEmail === 'string' ? rawEmail.trim() : '';
  return rows.find((row) => row.email === typed)
    || rows.find((row) => row.email === normalized)
    || undefined;
}

export async function login(pool, { email, password }) {
  const normalized = normalizeLoginEmail(email);
  const { rows } = normalized
    ? await pool.query('SELECT * FROM users WHERE lower(email) = $1 LIMIT 10', [normalized])
    : { rows: [] };
  const user = pickLoginUser(rows, email, normalized);
  // Always compare against a hash (a dummy one when the account is unknown)
  // so login timing does not reveal whether the email exists.
  const ok = await verifyPassword(password, user?.password_hash);
  if (!user || !ok) {
    return null;
  }
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
    hashSecret(token),
    user.id,
    expiresAt,
  ]);
  return { token, expires_at: expiresAt.toISOString(), user: publicUser(user) };
}

export async function logout(pool, token) {
  if (!token) return;
  await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashSecret(token)]);
}

export { newApiKey };
