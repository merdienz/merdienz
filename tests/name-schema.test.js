import { describe, expect, it } from 'vitest';
import { authHeader, createUser, withApp } from './helpers.js';

describe('site and heartbeat name schemas', () => {
  it('refuses control characters in a site or heartbeat name', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'names@example.com', tier: 'selfhosted' });
      const headers = { ...authHeader(user), 'content-type': 'application/json' };
      const site = await app.inject({
        method: 'POST',
        url: '/sites',
        headers,
        payload: { name: 'a\nb', url: 'https://example.com' },
      });
      expect(site.statusCode).toBe(400);

      const tab = await app.inject({
        method: 'POST',
        url: '/sites',
        headers,
        payload: { name: 'a\tsite', url: 'https://example.com' },
      });
      expect(tab.statusCode).toBe(400);

      const heartbeat = await app.inject({
        method: 'POST',
        url: '/heartbeats',
        headers,
        payload: { name: 'job\rname', period_seconds: 60 },
      });
      expect(heartbeat.statusCode).toBe(400);

      const ok = await app.inject({
        method: 'POST',
        url: '/sites',
        headers,
        payload: { name: 'plain site', url: 'https://example.com' },
      });
      expect(ok.statusCode).toBe(200);
    });
  });
});
