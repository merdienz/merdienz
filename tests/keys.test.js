import { describe, expect, it } from 'vitest';
import { hashSecret } from '../src/keys.js';
import { authHeader, createUser, getDb, withApp } from './helpers.js';

describe('hashed API keys and session tokens', () => {
  it('stores only the hash and still authenticates, and shows the key only from the generated value', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'key@example.com', password: 'secret' });
      const row = (await db.query('SELECT * FROM users WHERE id = $1', [user.id])).rows[0];
      expect(row.api_key).toBeUndefined();
      expect(row.api_key_hash).toBe(hashSecret(user.apiKey));
      expect(row.api_key_prefix).toBe(user.apiKey.slice(0, 8));
      expect(JSON.stringify(row)).not.toContain(user.apiKey);

      const me = await app.inject({ method: 'GET', url: '/me', headers: authHeader(user) });
      expect(me.statusCode).toBe(200);
      expect(me.json().email).toBe(user.email);

      const login = await app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: { email: user.email, password: 'secret' },
      });
      const token = login.json().token;
      const sessions = (await db.query('SELECT * FROM sessions')).rows;
      expect(sessions[0].token).toBeUndefined();
      expect(sessions[0].token_hash).toBe(hashSecret(token));
      const listed = await app.inject({
        method: 'GET',
        url: '/sites',
        headers: { 'x-session-token': token },
      });
      expect(listed.statusCode).toBe(200);
    });
  });
});
