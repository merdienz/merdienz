import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = resolve(root, 'scripts/check-public-refs.js');

function run(args) {
  try {
    const stdout = execFileSync('node', [script, ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      status: err.status ?? 1,
      stdout: err.stdout || '',
      stderr: err.stderr || err.message || '',
    };
  }
}

describe('check-public-refs', () => {
  it('fails loudly on a missing ref and never prints ok', () => {
    const result = run(['--range', 'definitely-missing-ref-zzzz..HEAD']);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toMatch(/\bok\b/i);
    expect(`${result.stderr}${result.stdout}`).toMatch(/missing or unreadable ref/i);
  });
});
