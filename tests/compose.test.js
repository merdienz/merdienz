import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('docker compose package', () => {
  it('parses and passes the static structure and sizing checks', () => {
    const out = execFileSync(process.execPath, ['scripts/check-compose.js'], { encoding: 'utf8' });
    expect(out).toMatch(/docker-compose.yml ok/);
  });
});
