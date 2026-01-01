import { newApiKey } from './auth.js';
import { bad } from './errors.js';
import { EMAIL_MAX_LENGTH, isSingleEmailAddress } from './email-address.js';
import { apiKeyPrefix, hashSecret } from './keys.js';
import { hashPassword } from './password.js';

// Cloud self-signup. Accounts made here always start on no_plan; a paid tier
// only ever comes from a verified billing webhook.
export const SIGNUP_TIER = 'no_plan';
export const SIGNUP_PASSWORD_MIN = 12;
export const SIGNUP_PASSWORD_MAX = 1024;
// Valid signup attempts per 15 minutes: per client IP + email, and per email.
export const SIGNUP_PAIR_MAX = 5;
export const SIGNUP_EMAIL_MAX = 20;

// The response is the same whether the email was new or already taken, so the
// endpoint cannot be used to find out which emails have accounts.
export const SIGNUP_GENERIC = Object.freeze({
  ok: true,
  message: 'If this email is new, your account is ready. Sign in to continue.',
  next: '/',
});

// Exactly 'cloud', as configured. An unset, unknown, padded or differently
// cased MERDIENZ_MODE keeps signup closed even though the rest of the app
// treats it as cloud.
export function signupEnabled(config) {
  return config?.merdienzModeRaw === 'cloud' && config?.merdienzMode === 'cloud';
}

// The form needs the signed CSRF cookie, which only exists with COOKIE_SECRET.
export function signupReady(config) {
  return signupEnabled(config) && Boolean(config?.cookieSecret);
}

export function normalizeSignupEmail(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

export function validateSignup(input) {
  const email = normalizeSignupEmail(input?.email);
  const password = input?.password;
  if (!email || email.length > EMAIL_MAX_LENGTH || !isSingleEmailAddress(email)) {
    throw bad(400, 'enter a valid email address', 'BAD_EMAIL');
  }
  if (
    typeof password !== 'string'
    || password.length < SIGNUP_PASSWORD_MIN
    || password.length > SIGNUP_PASSWORD_MAX
  ) {
    throw bad(
      400,
      `password must be ${SIGNUP_PASSWORD_MIN} to ${SIGNUP_PASSWORD_MAX} characters`,
      'BAD_PASSWORD'
    );
  }
  return { email, password };
}

/**
 * Create a cloud account. Only email and password are read from the input;
 * every other field (plan, tier, role, admin flags and so on) is ignored.
 * Returns { created } for callers and tests; the HTTP route never exposes it.
 */
export async function createSignupUser(db, input) {
  const { email, password } = validateSignup(input);
  // Hash before touching the database so a taken email costs the same work.
  const passwordHash = await hashPassword(password);
  const apiKey = newApiKey();
  try {
    const { rows } = await db.query(
      `INSERT INTO users (email, password_hash, api_key_prefix, api_key_hash, tier)
       SELECT $1, $2, $3, $4, $5
        WHERE NOT EXISTS (SELECT 1 FROM users WHERE lower(email) = $1)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [email, passwordHash, apiKeyPrefix(apiKey), hashSecret(apiKey), SIGNUP_TIER]
    );
    return { created: rows.length === 1 };
  } catch (err) {
    // A racing insert of the same email is the same generic outcome.
    if (err && err.code === '23505') return { created: false };
    throw err;
  }
}

/** Per-email attempt counter, one per app instance. */
export function createEmailLimiter({ windowMs = 15 * 60_000, max = 5, now = () => Date.now() } = {}) {
  const hits = new Map();
  return function tooMany(email) {
    const key = normalizeSignupEmail(email);
    const t = now();
    const row = hits.get(key) || { count: 0, reset: t + windowMs };
    if (t > row.reset) {
      row.count = 0;
      row.reset = t + windowMs;
    }
    row.count += 1;
    hits.set(key, row);
    if (hits.size > 10_000) {
      for (const [k, v] of hits) {
        if (t > v.reset) hits.delete(k);
      }
    }
    return row.count > max;
  };
}
