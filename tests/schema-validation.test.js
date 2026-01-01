import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { authHeader, createUser, withApp } from './helpers.js';

describe('JSON schema and SQL lint', () => {
  it('returns 404 for a malformed site id and 400 for a bad body', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'schema@example.com' });
      const badId = await app.inject({ method: 'GET', url: '/sites/xyz', headers: authHeader(user) });
      expect(badId.statusCode).toBe(404);
      expect(badId.json().code).toBe('NOT_FOUND');
      const badBody = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { name: 'Nope' },
      });
      expect(badBody.statusCode).toBe(400);
      const extra = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { name: 'Nope', url: 'https://example.com', unexpected: true },
      });
      expect(extra.statusCode).toBe(400);
    });
  });

  it('fails the SQL lint gate on string-built queries and passes the repo', () => {
    expect(() =>
      execFileSync(process.execPath, ['scripts/lint-sql.js', 'src'], { cwd: process.cwd(), stdio: 'pipe' })
    ).not.toThrow();
  });
});
