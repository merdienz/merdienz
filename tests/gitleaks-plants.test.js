import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertAllowComments, runPlantCheck } from '../scripts/check-gitleaks-plants.js';

function findGitleaks() {
  if (process.env.GITLEAKS && existsSync(process.env.GITLEAKS)) return process.env.GITLEAKS;
  for (const bin of ['gitleaks', '/tmp/gitleaks']) {
    try {
      execFileSync(bin, ['version'], { stdio: 'ignore' });
      return bin;
    } catch {
      // try next
    }
  }
  return null;
}

describe('gitleaks plant check', () => {
  it('reports planted GitHub, AWS and Stripe keys in tests/ and .env.example', () => {
    const bin = findGitleaks();
    if (!bin) {
      // CI runs this check in the gitleaks job with GITLEAKS=/tmp/gitleaks.
      return;
    }
    expect(runPlantCheck(bin).ok).toBe(true);
  });
  it('rejects an allow marker that is not an empty placeholder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'merdienz-allow-'));
    const mark = ['gitleaks', 'allow'].join(':');
    try {
      writeFileSync(join(dir, 'notes.txt'), `# API_KEY=not-empty # ${mark}\n`);
      expect(() => assertAllowComments(dir)).toThrow(/empty placeholders/);
      writeFileSync(join(dir, 'notes.txt'), `# API_KEY= # ${mark}\n`);
      expect(assertAllowComments(dir).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
