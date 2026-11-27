import { describe, expect, it } from 'vitest';
import { isLegacyEmailAddress, isSingleEmailAddress, LOCAL_PART_MAX_LENGTH } from '../src/email-address.js';

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
    const ipv4 = [1, 2, 3, 4].join('.');
    const loopback = [127, 0, 0, 1].join('.');
    const allOnes = [255, 255, 255, 255].join('.');
    expect(isSingleEmailAddress(`a@${ipv4}`)).toBe(false);
    expect(isSingleEmailAddress(`a@${loopback}`)).toBe(false);
    expect(isSingleEmailAddress(`a@${allOnes}`)).toBe(false);
    expect(isSingleEmailAddress(`a@${ipv4}.example.com`)).toBe(true);
  });
});

describe('isLegacyEmailAddress', () => {
  it('accepts a saved address that the strict check now rejects', () => {
    const ipv4 = [1, 2, 3, 4].join('.');
    const longLocal = `${'a'.repeat(LOCAL_PART_MAX_LENGTH + 1)}@example.com`;
    for (const email of [
      '.a@example.com',
      'a.@example.com',
      'a..b@example.com',
      longLocal,
      '=?utf-8?q?foo?=@example.com',
      `a@${ipv4}`,
    ]) {
      expect(isSingleEmailAddress(email), email).toBe(false);
      expect(isLegacyEmailAddress(email), email).toBe(true);
    }
  });

  it('still rejects a display name, a second address, and CR or LF', () => {
    expect(isLegacyEmailAddress('Alerts <alerts@example.com>')).toBe(false);
    expect(isLegacyEmailAddress('alerts@example.com,ops@example.com')).toBe(false);
    expect(isLegacyEmailAddress('alerts@example.com\r\nBcc:evil@example.com')).toBe(false);
  });
});
