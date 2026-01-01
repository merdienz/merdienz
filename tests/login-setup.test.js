import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { consumeSetupToken, defaultSetupTokenFile, issueSetupTokenIfNeeded, writeSetupTokenFile } from '../src/setup.js';
import { createUser, getDb, resetData, withApp } from './helpers.js';

describe('login and first-run setup', () => {
  it('returns the same error for an unknown user and a wrong password', async () => {
    await withApp(async ({ app, db }) => {
      await createUser(db, { email: 'known@example.com', password: 'correct-horse' });
      const unknown = await app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: { email: 'missing@example.com', password: 'correct-horse' },
      });
      const wrong = await app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: { email: 'known@example.com', password: 'definitely-wrong' },
      });
      expect(unknown.statusCode).toBe(401);
      expect(wrong.statusCode).toBe(401);
      expect(unknown.json()).toEqual(wrong.json());
      expect(unknown.json().code).toBe('INVALID_CREDENTIALS');
    });
  });

  it('writes a setup token once to a 0600 file and creates the first user', async () => {
    const db = await getDb();
    await resetData(db);
    const dir = mkdtempSync(join(tmpdir(), 'merdienz-setup-'));
    const tokenFile = join(dir, 'setup-token');
    const printed = [];
    try {
    const first = await issueSetupTokenIfNeeded(db, { print: (line) => printed.push(String(line)), tokenFile });
    expect(first.token).toMatch(/^mrzsetup_/);
    expect(printed.join('\n')).not.toContain(first.token);
    expect(printed.join('\n')).toContain(tokenFile);
    expect(readFileSync(tokenFile, 'utf8').trim()).toBe(first.token);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    const second = await issueSetupTokenIfNeeded(db, { print: (line) => printed.push(String(line)), tokenFile });
    expect(second.alreadyIssued).toBe(true);
    expect(printed.filter((line) => line.includes(first.token))).toHaveLength(0);
    const result = await consumeSetupToken(db, {
      token: first.token,
      email: 'owner@example.com',
      password: 'a-long-password',
      mode: 'cloud',
    });
    expect(result.user.email).toBe('owner@example.com');
    expect(result.user.tier).toBe('no_plan');
    expect(result.api_key).toMatch(/^mrz_/);
    await expect(
      consumeSetupToken(db, {
        token: first.token,
        email: 'other@example.com',
        password: 'a-long-password',
        mode: 'cloud',
      })
    ).rejects.toMatchObject({ code: 'SETUP_DONE' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes the setup token with O_EXCL and a random suffix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'merdienz-setup-flags-'));
    try {
      const first = defaultSetupTokenFile();
      const second = defaultSetupTokenFile();
      expect(first).not.toBe(second);
      expect(first).toMatch(/merdienz-setup-token-[0-9a-f]{16}$/);
      const path = join(dir, 'setup-token');
      writeSetupTokenFile('mrzsetup_test-token', path);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(() => writeSetupTokenFile('mrzsetup_other', path)).toThrow();
      const link = join(dir, 'link');
      const target = join(dir, 'target');
      writeFileSync(target, 'nope\n');
      symlinkSync(target, link);
      expect(() => writeSetupTokenFile('mrzsetup_link', link)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('login email normalization', () => {
  const login = (app, email, password) =>
    app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email, password },
    });

  it('accepts any casing and surrounding spaces for a lowercase account', async () => {
    await withApp(async ({ app, db }) => {
      await createUser(db, { email: 'casey@example.com', password: 'correct-horse-battery' });
      for (const email of ['casey@example.com', 'Casey@Example.COM', '  casey@example.com  ', '\tCASEY@EXAMPLE.COM ']) {
        const res = await login(app, email, 'correct-horse-battery');
        expect([email, res.statusCode]).toEqual([email, 200]);
        expect(res.json().user.email).toBe('casey@example.com');
      }
    });
  });

  it('keeps working for an operator-created mixed-case account', async () => {
    await withApp(async ({ app, db }) => {
      await createUser(db, { email: 'Operator.Made@Example.com', password: 'correct-horse-battery' });
      for (const email of ['Operator.Made@Example.com', 'operator.made@example.com', ' OPERATOR.MADE@EXAMPLE.COM']) {
        const res = await login(app, email, 'correct-horse-battery');
        expect([email, res.statusCode]).toEqual([email, 200]);
      }
    });
  });

  it('picks the exact match when two accounts differ only by case, and refuses to guess otherwise', async () => {
    await withApp(async ({ app, db }) => {
      await createUser(db, { email: 'Twin@Example.com', password: 'upper-password-1' });
      await createUser(db, { email: 'twin@example.com', password: 'lower-password-1' });
      expect((await login(app, 'Twin@Example.com', 'upper-password-1')).statusCode).toBe(200);
      expect((await login(app, 'twin@example.com', 'lower-password-1')).statusCode).toBe(200);
      expect((await login(app, 'TWIN@example.com', 'lower-password-1')).statusCode).toBe(200);
      expect((await login(app, 'TWIN@example.com', 'upper-password-1')).statusCode).toBe(401);
    });
  });

  it('still fails a wrong password with the same generic error as an unknown email', async () => {
    await withApp(async ({ app, db }) => {
      await createUser(db, { email: 'generic@example.com', password: 'correct-horse-battery' });
      const wrong = await login(app, ' Generic@Example.com ', 'wrong-password-123');
      const unknown = await login(app, 'Nobody@Example.com', 'wrong-password-123');
      const blank = await login(app, '   ', 'wrong-password-123');
      expect(wrong.statusCode).toBe(401);
      expect(unknown.statusCode).toBe(401);
      expect(blank.statusCode).toBe(401);
      expect(wrong.json()).toEqual(unknown.json());
      expect(blank.json()).toEqual(unknown.json());
      expect(wrong.json().code).toBe('INVALID_CREDENTIALS');
    });
  });

  it('lets a cloud sign-up log in with mixed case', async () => {
    await withApp(async ({ app, db }) => {
      await createUser(db, { email: 'operator@example.com', password: 'operator-password-1', tier: 'no_plan' });
      const csrfRes = await app.inject({ method: 'GET', url: '/csrf-token' });
      const cookie = (csrfRes.cookies || []).map((c) => `${c.name}=${c.value}`).join('; ');
      const signup = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrfRes.json().csrf },
        payload: { email: 'new.signup@example.com', password: 'correct-horse-battery' },
      });
      expect(signup.statusCode).toBe(200);
      const res = await login(app, '  New.Signup@EXAMPLE.com ', 'correct-horse-battery');
      expect(res.statusCode).toBe(200);
      expect(res.json().user.tier).toBe('no_plan');
    }, { config: { merdienzMode: 'cloud' } });
  });
});
