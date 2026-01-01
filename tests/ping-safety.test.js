import { describe, expect, it } from 'vitest';
import { clientIp } from '../src/heartbeat-checks.js';
import { authHeader, createUser, withApp } from './helpers.js';

describe('ping safety', () => {
  it('returns 404 for a malformed UUID', async () => {
    await withApp(async ({ app }) => {
      const res = await app.inject({ method: 'GET', url: '/ping/not-a-uuid' });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    });
  });

  it('rejects ping bodies larger than 16 KB', async () => {
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'body@example.com' });
      const created = await app.inject({
        method: 'POST',
        url: '/heartbeats',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { name: 'Job', period_seconds: 60, grace_seconds: 10 },
      });
      const token = created.json().ping_urls.success.split('/ping/')[1];
      const res = await app.inject({
        method: 'POST',
        url: `/ping/${token}`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ note: 'x'.repeat(20_000) }),
      });
      expect(res.statusCode).toBe(413);
    });
  });

  it('ignores X-Forwarded-For unless the peer is in TRUSTED_PROXIES', () => {
    const forged = {
      headers: { 'x-forwarded-for': '6.6.6.6' },
      socket: { remoteAddress: '198.51.100.10' },
      ip: '198.51.100.10',
    };
    expect(clientIp(forged, [])).toBe('198.51.100.10');
    expect(clientIp(forged, ['198.51.100.10'])).toBe('6.6.6.6');
  });

  it('does not mount /internal/probe on the primary API', async () => {
    await withApp(async ({ app }) => {
      const res = await app.inject({ method: 'POST', url: '/internal/probe', payload: {} });
      expect(res.statusCode).toBe(404);
    });
  });
});
