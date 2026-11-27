import { describe, expect, it } from 'vitest';
import { isSingleEmailAddress, LOCAL_PART_MAX_LENGTH } from '../src/email-address.js';

describe('isSingleEmailAddress', () => {
  it('accepts ordinary single addresses, including localhost and an internal local-part dot', () => {
    for (const email of [
      'alerts@localhost',
      'owner@localhost',
      'ops@example.com',
      'user.name+tag@example.com',
      'a@b',
    ]) {
      expect(isSingleEmailAddress(email), email).toBe(true);
    }
  });

  it('rejects leading, trailing, or doubled dots in the local part', () => {
    expect(isSingleEmailAddress('.a@example.com')).toBe(false);
    expect(isSingleEmailAddress('a.@example.com')).toBe(false);
    expect(isSingleEmailAddress('a..b@example.com')).toBe(false);
  });

  it('rejects a local part longer than 64 characters and an encoded-word local part', () => {
    expect(isSingleEmailAddress(`${'a'.repeat(LOCAL_PART_MAX_LENGTH)}@example.com`)).toBe(true);
    expect(isSingleEmailAddress(`${'a'.repeat(LOCAL_PART_MAX_LENGTH + 1)}@example.com`)).toBe(false);
    expect(isSingleEmailAddress('=?utf-8?q?foo?=@example.com')).toBe(false);
  });

  it('rejects an unbracketed IP-address domain', () => {
    expect(isSingleEmailAddress('a@1.2.3.4')).toBe(false);
    expect(isSingleEmailAddress('a@127.0.0.1')).toBe(false);
    expect(isSingleEmailAddress('a@255.255.255.255')).toBe(false);
    expect(isSingleEmailAddress('a@1.2.3.4.example.com')).toBe(true);
  });
});
