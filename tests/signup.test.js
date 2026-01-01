import { describe, expect, it } from 'vitest';
import {
  SIGNUP_GENERIC,
  SIGNUP_PASSWORD_MAX,
  SIGNUP_PASSWORD_MIN,
  createEmailLimiter,
  createSignupUser,
  validateSignup,
} from '../src/signup.js';
import { createUser, withApp as baseWithApp } from './helpers.js';

// Cloud tests start after first-run setup: an operator account already
// exists, as on the live host. Pass noSeed to test the fresh-install case.
async function withApp(fn, overrides = {}) {
  return baseWithApp(async (ctx) => {
    if (overrides.config?.merdienzMode === 'cloud' && !overrides.noSeed) {
      await createUser(ctx.db, { email: 'operator@example.com', password: 'operator-password-1', tier: 'no_plan' });
    }
    return fn(ctx);
  }, overrides);
}

const CLOUD = { config: { merdienzMode: 'cloud' } };
const GOOD_PASSWORD = 'correct-horse-battery';

async function csrfPair(app) {
  const res = await app.inject({ method: 'GET', url: '/csrf-token' });
  expect(res.statusCode).toBe(200);
  const cookie = (res.cookies || []).map((c) => `${c.name}=${c.value}`).join('; ');
  return { csrf: res.json().csrf, cookie };
}

async function signup(app, payload, { csrf = true, remoteAddress, forwardedFor } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (csrf) {
    const pair = await csrfPair(app);
    headers.cookie = pair.cookie;
    headers['x-csrf-token'] = pair.csrf;
  }
  if (forwardedFor) headers['x-forwarded-for'] = forwardedFor;
  return app.inject({ method: 'POST', url: '/auth/signup', headers, payload, remoteAddress });
}

async function userRows(db, email) {
  const { rows } = await db.query('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
  return rows;
}

describe('cloud self-signup', () => {
  it('creates a no_plan account with a normalized email and then lets it sign in', async () => {
    await withApp(async ({ app, db }) => {
      const info = await app.inject({ method: 'GET', url: '/auth/signup' });
      expect(info.statusCode).toBe(200);
      expect(info.json()).toEqual({ enabled: true, password_min: SIGNUP_PASSWORD_MIN });

      const res = await signup(app, { email: '  New.User@Example.COM ', password: GOOD_PASSWORD });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(SIGNUP_GENERIC);
      expect(res.body).not.toMatch(/token|api_key|mrz_/);

      const rows = await userRows(db, 'new.user@example.com');
      expect(rows).toHaveLength(1);
      expect(rows[0].email).toBe('new.user@example.com');
      expect(rows[0].tier).toBe('no_plan');
      expect(rows[0].password_hash).toMatch(/^scrypt\$/);

      const login = await app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: { email: 'new.user@example.com', password: GOOD_PASSWORD },
      });
      expect(login.statusCode).toBe(200);
      expect(login.json().user.tier).toBe('no_plan');
      const me = await app.inject({ method: 'GET', url: '/me', headers: { 'x-session-token': login.json().token } });
      expect(me.statusCode).toBe(200);
      expect(me.json().tier).toBe('no_plan');
    }, CLOUD);
  });

  it('requires the CSRF token', async () => {
    await withApp(async ({ app, db }) => {
      const missing = await signup(app, { email: 'csrf-none@example.com', password: GOOD_PASSWORD }, { csrf: false });
      expect(missing.statusCode).toBe(403);
      const pair = await csrfPair(app);
      const wrong = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        headers: { 'content-type': 'application/json', cookie: pair.cookie, 'x-csrf-token': 'not-the-token' },
        payload: { email: 'csrf-wrong@example.com', password: GOOD_PASSWORD },
      });
      expect(wrong.statusCode).toBe(403);
      const noCookie = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        headers: { 'content-type': 'application/json', 'x-csrf-token': pair.csrf },
        payload: { email: 'csrf-nocookie@example.com', password: GOOD_PASSWORD },
      });
      expect(noCookie.statusCode).toBe(403);
      const { rows } = await db.query("SELECT count(*)::int AS n FROM users WHERE email LIKE 'csrf-%'");
      expect(rows[0].n).toBe(0);
    }, CLOUD);
  });

  it('answers an existing email exactly like a new one and leaves the account alone', async () => {
    await withApp(async ({ app, db }) => {
      const known = await createUser(db, { email: 'known@example.com', password: 'original-password', tier: 'starter' });
      const mixed = await createUser(db, { email: 'Mixed.Case@Example.com', password: 'original-password', tier: 'no_plan' });
      const fresh = await signup(app, { email: 'fresh@example.com', password: GOOD_PASSWORD });
      const taken = await signup(app, { email: 'known@example.com', password: GOOD_PASSWORD });
      const takenCase = await signup(app, { email: ' KNOWN@example.com', password: GOOD_PASSWORD });
      const takenMixed = await signup(app, { email: 'mixed.case@example.com', password: GOOD_PASSWORD });
      for (const res of [taken, takenCase, takenMixed]) {
        expect(res.statusCode).toBe(fresh.statusCode);
        expect(res.body).toBe(fresh.body);
        expect(res.headers['content-type']).toBe(fresh.headers['content-type']);
        expect(res.headers.location).toBe(fresh.headers.location);
      }
      const knownRows = await userRows(db, 'known@example.com');
      expect(knownRows).toHaveLength(1);
      expect(knownRows[0].password_hash).toBe(known.password_hash);
      expect(knownRows[0].tier).toBe('starter');
      const mixedRows = await userRows(db, 'mixed.case@example.com');
      expect(mixedRows).toHaveLength(1);
      expect(mixedRows[0].id).toBe(mixed.id);
    }, CLOUD);
  });

  it('is race-safe on the unique email: concurrent signups give the generic result and one row', async () => {
    await withApp(async ({ app, db }) => {
      const results = await Promise.all(
        Array.from({ length: 4 }, () => signup(app, { email: 'race@example.com', password: GOOD_PASSWORD }))
      );
      for (const res of results) {
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual(SIGNUP_GENERIC);
      }
      expect(await userRows(db, 'race@example.com')).toHaveLength(1);

      const direct = await Promise.all(
        Array.from({ length: 4 }, () => createSignupUser(db, { email: 'race2@example.com', password: GOOD_PASSWORD }))
      );
      expect(direct.filter((r) => r.created)).toHaveLength(1);
      expect(await userRows(db, 'race2@example.com')).toHaveLength(1);
    }, CLOUD);
  });

  it('turns a unique violation from the insert into the generic outcome, not a 500', async () => {
    const fakeDb = {
      query: async () => {
        const err = new Error('duplicate key value violates unique constraint');
        err.code = '23505';
        throw err;
      },
    };
    await expect(createSignupUser(fakeDb, { email: 'dup@example.com', password: GOOD_PASSWORD })).resolves.toEqual({ created: false });
    const otherErr = { query: async () => { throw Object.assign(new Error('boom'), { code: '08006' }); } };
    await expect(createSignupUser(otherErr, { email: 'dup@example.com', password: GOOD_PASSWORD })).rejects.toThrow('boom');
  });

  it('enforces the password length limits', async () => {
    expect(SIGNUP_PASSWORD_MIN).toBe(12);
    expect(SIGNUP_PASSWORD_MAX).toBe(1024);
    expect(() => validateSignup({ email: 'a@example.com', password: 'x'.repeat(11) })).toThrow(/password/);
    expect(() => validateSignup({ email: 'a@example.com', password: 'x'.repeat(1025) })).toThrow(/password/);
    expect(validateSignup({ email: 'a@example.com', password: 'x'.repeat(12) }).password).toHaveLength(12);
    expect(() => validateSignup({ email: 'a@example.com', password: 12345678901234 })).toThrow(/password/);
    await withApp(async ({ app, db }) => {
      const short = await signup(app, { email: 'short@example.com', password: 'x'.repeat(11) });
      expect(short.statusCode).toBe(400);
      expect(short.json().code).toBe('BAD_PASSWORD');
      const long = await signup(app, { email: 'long@example.com', password: 'x'.repeat(1025) });
      expect(long.statusCode).toBe(400);
      const ok = await signup(app, { email: 'exact@example.com', password: 'x'.repeat(12) });
      expect(ok.statusCode).toBe(200);
      expect(await userRows(db, 'short@example.com')).toHaveLength(0);
      expect(await userRows(db, 'long@example.com')).toHaveLength(0);
      expect(await userRows(db, 'exact@example.com')).toHaveLength(1);
    }, CLOUD);
  });

  it('rejects invalid email addresses', async () => {
    for (const email of ['not-an-email', 'a@b@example.com', 'one@example.com,two@example.com', 'x <x@example.com>', `${'a'.repeat(320)}@example.com`, '   ']) {
      expect(() => validateSignup({ email, password: GOOD_PASSWORD })).toThrow(/email/);
    }
    await withApp(async ({ app, db }) => {
      for (const email of ['not-an-email', 'a@example.com\r\nBcc: b@example.com', 'one@example.com,two@example.com']) {
        const res = await signup(app, { email, password: GOOD_PASSWORD });
        expect(res.statusCode).toBe(400);
      }
      const { rows } = await db.query('SELECT count(*)::int AS n FROM users');
      expect(rows[0].n).toBe(1);
    }, CLOUD);
  });

  it('never takes a plan, tier, role or admin flag from the request', async () => {
    const extras = {
      plan: 'pro',
      tier: 'selfhosted',
      is_admin: true,
      admin: true,
      isAdmin: true,
      role: 'admin',
      operator: true,
      owner: true,
      id: '00000000-0000-0000-0000-000000000001',
      api_key_hash: 'deadbeef',
      password_hash: 'scrypt$x$y',
    };
    await withApp(async ({ app, db }) => {
      for (const [key, value] of Object.entries(extras)) {
        const res = await signup(app, { email: `mass-${key.toLowerCase()}@example.com`, password: GOOD_PASSWORD, [key]: value });
        // Unknown fields fail schema validation (an "id" field is reported
        // as 404 by the app's shared validation error mapping).
        expect([key, res.statusCode]).toEqual([key, key === 'id' ? 404 : 400]);
      }
      const { rows: none } = await db.query("SELECT count(*)::int AS n FROM users WHERE email LIKE 'mass-%'");
      expect(none[0].n).toBe(0);

      const result = await createSignupUser(db, { email: 'direct@example.com', password: GOOD_PASSWORD, ...extras });
      expect(result).toEqual({ created: true });
      const rows = await userRows(db, 'direct@example.com');
      expect(rows).toHaveLength(1);
      expect(rows[0].tier).toBe('no_plan');
      expect(rows[0].id).not.toBe(extras.id);
      expect(rows[0].api_key_hash).not.toBe(extras.api_key_hash);
      expect(rows[0].password_hash).not.toBe(extras.password_hash);
      expect(Object.keys(rows[0]).sort()).toEqual(
        ['api_key_hash', 'api_key_prefix', 'created_at', 'email', 'id', 'password_hash', 'tier'].sort()
      );
      const subs = await db.query('SELECT count(*)::int AS n FROM subscriptions');
      expect(subs.rows[0].n).toBe(0);
      for (const tierish of ['selfhosted', 'pro', 'starter', 'cloud']) {
        const r = await createSignupUser(db, { email: `t-${tierish}@example.com`, password: GOOD_PASSWORD, tier: tierish, plan: tierish });
        expect(r.created).toBe(true);
        expect((await userRows(db, `t-${tierish}@example.com`))[0].tier).toBe('no_plan');
      }
    }, CLOUD);
  });

  it('rate-limits one client per normalized email without locking out the victim', async () => {
    let clock = 1_000_000;
    const limiter = createEmailLimiter({ windowMs: 1000, max: 2, now: () => clock });
    expect(limiter('a@example.com')).toBe(false);
    expect(limiter(' A@Example.com ')).toBe(false);
    expect(limiter('a@example.com')).toBe(true);
    expect(limiter('b@example.com')).toBe(false);
    clock += 1001;
    expect(limiter('a@example.com')).toBe(false);

    await withApp(async ({ app }) => {
      // One client: 5 valid attempts for one email (any casing), then 429.
      const statuses = [];
      for (let i = 0; i < 6; i += 1) {
        const email = i % 2 ? 'Limit@Example.com' : ' limit@example.com';
        const res = await signup(app, { email, password: GOOD_PASSWORD }, { remoteAddress: '203.0.113.10' });
        statuses.push(res.statusCode);
      }
      expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
      // That client can still sign up a different email.
      const other = await signup(app, { email: 'other-limit@example.com', password: GOOD_PASSWORD }, { remoteAddress: '203.0.113.10' });
      expect(other.statusCode).toBe(200);
      // The victim, from another IP, is not locked out by that client.
      const victim = await signup(app, { email: 'limit@example.com', password: GOOD_PASSWORD }, { remoteAddress: '203.0.113.99' });
      expect(victim.statusCode).toBe(200);
    }, CLOUD);
  });

  it('caps one email across many IPs, and a capped client adds nothing to that cap', async () => {
    await withApp(async ({ app }) => {
      // One client hammers the email: only its first 5 count toward the email cap.
      for (let i = 0; i < 12; i += 1) {
        await signup(app, { email: 'spread@example.com', password: GOOD_PASSWORD }, { remoteAddress: '198.51.100.200' });
      }
      const statuses = [];
      for (let i = 0; i < 16; i += 1) {
        const res = await signup(app, { email: 'spread@example.com', password: GOOD_PASSWORD }, { remoteAddress: `198.51.100.${i + 1}` });
        statuses.push(res.statusCode);
      }
      // 5 (capped client) + 15 others = 20 = SIGNUP_EMAIL_MAX; the 16th other IP is refused.
      expect(statuses.slice(0, 15).every((c) => c === 200)).toBe(true);
      expect(statuses[15]).toBe(429);
    }, CLOUD);
  });

  it('validates before counting: malformed attempts never use up the limit', async () => {
    await withApp(async ({ app }) => {
      for (let i = 0; i < 10; i += 1) {
        const short = await signup(app, { email: 'victim@example.com', password: 'short' }, { remoteAddress: '203.0.113.50' });
        expect(short.statusCode).toBe(400);
      }
      for (let i = 0; i < 10; i += 1) {
        const bad = await signup(app, { email: 'victim@example.com\r\nBcc: x@example.com', password: GOOD_PASSWORD }, { remoteAddress: '203.0.113.50' });
        expect(bad.statusCode).toBe(400);
      }
      const ok = await signup(app, { email: 'victim@example.com', password: GOOD_PASSWORD }, { remoteAddress: '203.0.113.50' });
      expect(ok.statusCode).toBe(200);
    }, CLOUD);
  });

  it('rate-limits by client IP using the trusted X-Forwarded-For bucket', async () => {
    await withApp(
      async ({ app }) => {
        let seq = 0;
        const attempt = (forwardedFor) => {
          seq += 1;
          return signup(app, { email: `ip${seq}@example.com`, password: GOOD_PASSWORD }, { remoteAddress: '127.0.0.1', forwardedFor });
        };
        for (let i = 0; i < 5; i += 1) {
          expect((await attempt('198.51.100.1')).statusCode).toBe(200);
        }
        expect((await attempt('198.51.100.1')).statusCode).toBe(429);
        expect((await attempt('198.51.100.2')).statusCode).toBe(200);
      },
      {
        config: {
          nodeEnv: 'production',
          merdienzMode: 'cloud',
          mailTransport: 'none',
          trustedProxies: ['127.0.0.1'],
          disableRateLimit: false,
        },
      }
    );
  });
});

describe('signup is absent outside cloud mode', () => {
  for (const merdienzMode of ['selfhosted', 'test', 'dev']) {
    it(`returns 404 for /auth/signup in ${merdienzMode} mode and keeps /setup`, async () => {
      await withApp(async ({ app, db }) => {
        const info = await app.inject({ method: 'GET', url: '/auth/signup' });
        expect(info.statusCode).toBe(404);
        expect((await app.inject({ method: 'GET', url: '/signup' })).statusCode).toBe(404);
        const res = await signup(app, { email: 'nope@example.com', password: GOOD_PASSWORD });
        expect(res.statusCode).toBe(404);
        const { rows } = await db.query('SELECT count(*)::int AS n FROM users');
        expect(rows[0].n).toBe(0);
        const setup = await app.inject({
          method: 'POST',
          url: '/setup',
          headers: { 'content-type': 'application/json' },
          payload: { token: 'mrzsetup_wrong-token', email: 'owner@example.com', password: GOOD_PASSWORD },
        });
        expect(setup.statusCode).not.toBe(404);
        expect(setup.json().code).toBe('INVALID_SETUP');
      }, { config: { merdienzMode } });
    });
  }
});

describe('signup needs MERDIENZ_MODE to be exactly cloud', () => {
  for (const merdienzModeRaw of ['', 'Cloud', 'CLOUD', ' cloud', 'cloud ', 'selfhost', 'clouds']) {
    it(`stays closed when MERDIENZ_MODE is ${JSON.stringify(merdienzModeRaw)}`, async () => {
      await withApp(async ({ app, config }) => {
        expect(config.merdienzMode).toBe('cloud');
        expect((await app.inject({ method: 'GET', url: '/auth/signup' })).statusCode).toBe(404);
        const res = await signup(app, { email: 'raw-mode@example.com', password: GOOD_PASSWORD });
        expect(res.statusCode).toBe(404);
      }, { config: { merdienzMode: 'cloud', merdienzModeRaw } });
    });
  }

  it('reads the raw value from the environment without a default', async () => {
    const { loadConfig } = await import('../src/config.js');
    const saved = process.env.MERDIENZ_MODE;
    try {
      delete process.env.MERDIENZ_MODE;
      const unset = loadConfig({ nodeEnv: 'test', mailTransport: 'none', host: '127.0.0.1' });
      expect(unset.merdienzMode).toBe('cloud');
      expect(unset.merdienzModeRaw).toBe('');
      process.env.MERDIENZ_MODE = 'CLOUD';
      const upper = loadConfig({ nodeEnv: 'test', mailTransport: 'none', host: '127.0.0.1' });
      expect(upper.merdienzMode).toBe('cloud');
      expect(upper.merdienzModeRaw).toBe('CLOUD');
      process.env.MERDIENZ_MODE = 'cloud';
      expect(loadConfig({ nodeEnv: 'test', mailTransport: 'none', host: '127.0.0.1' }).merdienzModeRaw).toBe('cloud');
    } finally {
      if (saved === undefined) delete process.env.MERDIENZ_MODE;
      else process.env.MERDIENZ_MODE = saved;
    }
  });
});

describe('signup before first-run setup', () => {
  it('returns 404 until /setup has created the first account, then opens', async () => {
    await withApp(async ({ app, db }) => {
      expect((await app.inject({ method: 'GET', url: '/auth/signup' })).statusCode).toBe(404);
      const early = await signup(app, { email: 'first@example.com', password: GOOD_PASSWORD }, { csrf: true });
      expect(early.statusCode).toBe(404);
      expect(early.json().code).toBe('NOT_FOUND');
      const { rows } = await db.query('SELECT count(*)::int AS n FROM users');
      expect(rows[0].n).toBe(0);

      const { issueSetupTokenIfNeeded } = await import('../src/setup.js');
      const { mkdtempSync, rmSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');
      const dir = mkdtempSync(join(tmpdir(), 'signup-setup-'));
      try {
        const issued = await issueSetupTokenIfNeeded(db, { print: () => {}, tokenFile: join(dir, 'token') });
        const setup = await app.inject({
          method: 'POST',
          url: '/setup',
          headers: { 'content-type': 'application/json' },
          payload: { token: issued.token, email: 'owner@example.com', password: GOOD_PASSWORD },
        });
        expect(setup.statusCode).toBe(200);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      expect((await app.inject({ method: 'GET', url: '/auth/signup' })).statusCode).toBe(200);
      const later = await signup(app, { email: 'second@example.com', password: GOOD_PASSWORD });
      expect(later.statusCode).toBe(200);
      expect(await userRows(db, 'second@example.com')).toHaveLength(1);
    }, { config: { merdienzMode: 'cloud' }, noSeed: true });
  });
});

describe('signup without a cookie secret', () => {
  it('stays off in cloud mode when COOKIE_SECRET is missing, so the form is never shown broken', async () => {
    await withApp(async ({ app }) => {
      expect((await app.inject({ method: 'GET', url: '/auth/signup' })).statusCode).toBe(404);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        headers: { 'content-type': 'application/json' },
        payload: { email: 'nosecret@example.com', password: GOOD_PASSWORD },
      });
      expect(res.statusCode).toBe(404);
    }, { config: { merdienzMode: 'cloud', cookieSecret: '' } });
  });
});

describe('sign-up page in the dashboard', () => {
  it('only shows the sign-up link when the server says signup is enabled', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../web/src/App.jsx', import.meta.url), 'utf8');
    expect(src).toMatch(/api\('\/auth\/signup'/);
    expect(src).toMatch(/\{signupEnabled && \([\s\S]{0,200}href="\/signup"/);
    expect(src).toMatch(/x-csrf-token|csrf \}\)/);
  });
});
