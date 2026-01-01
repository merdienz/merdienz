import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('public reference gate', () => {
  it('finds no hosting-provider names or unexpected IPv4 literals', () => {
    const out = execFileSync(process.execPath, ['scripts/check-public-refs.js'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(out).toMatch(/ok/);
  });
});
