import { describe, expect, it } from 'vitest';
import { normalizeMode } from '../src/probes/mode.js';

describe('normalizeMode', () => {
  it('accepts only string modes and treats non-strings as cloud', () => {
    expect(normalizeMode('selfhosted')).toBe('selfhosted');
    expect(normalizeMode('SELFHOSTED')).toBe('selfhosted');
    expect(normalizeMode('dev')).toBe('dev');
    expect(normalizeMode('test')).toBe('test');
    expect(normalizeMode('cloud')).toBe('cloud');
    expect(normalizeMode('')).toBe('cloud');
    expect(normalizeMode('garbage')).toBe('cloud');
    expect(normalizeMode(['selfhosted'])).toBe('cloud');
    expect(normalizeMode({ toString: () => 'selfhosted' })).toBe('cloud');
    expect(normalizeMode(null)).toBe('cloud');
    expect(normalizeMode(undefined)).toBe('cloud');
    expect(normalizeMode(0)).toBe('cloud');
  });
});
