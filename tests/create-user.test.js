import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'create-user.js');

describe('create-user', () => {
  it('rejects an address that fails the strict check without needing a database', () => {
    const result = spawnSync(process.execPath, [script, '--email', '.a@example.com', '--password', 'secret'], {
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: '' },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not a valid single email address/);
  });
});
