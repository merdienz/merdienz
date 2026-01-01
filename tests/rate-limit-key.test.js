import { describe, expect, it } from 'vitest';
import { rateLimitKey } from '../src/auth.js';

describe('rate limit key', () => {
  it('uses the verified user id, never the raw unverified API key', () => {
    const apiKey = 'mrz_this-is-a-raw-key';
    const withKeyOnly = {
      ip: '203.0.113.10',
      headers: { 'x-api-key': apiKey },
    };
    expect(rateLimitKey(withKeyOnly)).toBe('ip:203.0.113.10');
    expect(rateLimitKey(withKeyOnly)).not.toContain(apiKey);
    expect(rateLimitKey(withKeyOnly)).not.toContain('mrz_');

    const userId = '11111111-2222-4333-8444-555555555555';
    const verified = {
      ip: '203.0.113.10',
      headers: { 'x-api-key': apiKey },
      user: { id: userId },
    };
    expect(rateLimitKey(verified)).toBe(`user:${userId}`);
    expect(rateLimitKey(verified)).not.toContain(apiKey);
  });
});
