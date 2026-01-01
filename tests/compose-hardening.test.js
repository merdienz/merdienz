import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('container hardening', () => {
  it('validates compose hardening statically', () => {
    const out = execFileSync(process.execPath, ['scripts/check-compose.js'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(out).toMatch(/ok/);
  });

  it('pins the Dockerfile base image by digest and runs as non-root', () => {
    const file = readFileSync('Dockerfile', 'utf8');
    expect(file).toMatch(/node:22-alpine@sha256:[0-9a-f]{64}/);
    expect(file).toMatch(/npm ci --omit=dev/);
    expect(file).toMatch(/USER node/);
  });
});
