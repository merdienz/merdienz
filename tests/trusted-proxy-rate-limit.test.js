import { describe, expect, it } from 'vitest';
import { withApp } from './helpers.js';

// Use a unique account on every attempt so the email-keyed login cap
// (ACCOUNT_MAX) does not hide the per-IP buckets this test is for.
let seq = 0;
async function loginAttempt(app, { remoteAddress, forwardedFor }) {
  seq += 1;
  return app.inject({
    method: 'POST',
    url: '/auth/login',
    remoteAddress,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': forwardedFor,
    },
    payload: { email: `user${seq}@example.com`, password: 'wrong-password' },
  });
}

describe('trusted proxy rate limits', () => {
  it('buckets trusted X-Forwarded-For separately and ignores a forged header from an untrusted peer', async () => {
    await withApp(
      async ({ app }) => {
        const fromProxy = (forwardedFor) =>
          loginAttempt(app, { remoteAddress: '127.0.0.1', forwardedFor });
        const fromUntrusted = (forwardedFor) =>
          loginAttempt(app, { remoteAddress: '203.0.113.50', forwardedFor });

        for (let i = 0; i < 10; i += 1) {
          const res = await fromProxy('198.51.100.1');
          expect(res.statusCode).toBe(401);
        }
        expect((await fromProxy('198.51.100.1')).statusCode).toBe(429);
        expect((await fromProxy('198.51.100.2')).statusCode).toBe(401);

        for (let i = 0; i < 10; i += 1) {
          const res = await fromUntrusted('198.51.100.8');
          expect(res.statusCode).toBe(401);
        }
        expect((await fromUntrusted('198.51.100.8')).statusCode).toBe(429);
        expect((await fromUntrusted('198.51.100.9')).statusCode).toBe(429);

        const fromPeer = (remoteAddress) => loginAttempt(app, { remoteAddress, forwardedFor: '198.51.100.80' });
        for (let i = 0; i < 10; i += 1) {
          expect((await fromPeer('203.0.113.10')).statusCode).toBe(401);
        }
        expect((await fromPeer('203.0.113.10')).statusCode).toBe(429);
        expect((await fromPeer('203.0.113.20')).statusCode).toBe(401);
      },
      {
        config: {
          nodeEnv: 'production',
          merdienzMode: 'selfhosted',
          mailTransport: 'none',
          trustedProxies: ['127.0.0.1'],
          disableRateLimit: false,
        },
      }
    );
  });
});
