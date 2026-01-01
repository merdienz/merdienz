import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { tp } from './ports.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function waitFor(url, timeoutMs = 4000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(url);
        if (res.ok) {
          resolve(res);
          return;
        }
      } catch {}
      if (Date.now() - start > timeoutMs) {
        reject(new Error('probe B did not become ready'));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

describe('probe B standalone layout', () => {
  const packs = [];
  afterAll(() => {
    for (const dir of packs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('boots from only the probe entry file and src/probes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'merdienz-probe-pack-'));
    packs.push(dir);
    try {
      cpSync(join(root, 'src/probe-b-server.js'), join(dir, 'src/probe-b-server.js'));
      cpSync(join(root, 'src/probes'), join(dir, 'src/probes'), { recursive: true });
      symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
      const child = spawn(process.execPath, ['src/probe-b-server.js'], {
        cwd: dir,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          MERDIENZ_MODE: 'selfhosted',
          PROBE_B_HMAC_SECRET: 's'.repeat(32),
          PORT: String(tp(4854)),
          HOST: '127.0.0.1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      const exited = new Promise((resolve) => child.once('exit', resolve));
      try {
        const res = await waitFor(`http://127.0.0.1:${tp(4854)}/health`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.role).toBe('probe-b');
      } catch (err) {
        const code = child.exitCode;
        throw new Error(`${err.message}${code != null ? ` (exit ${code})` : ''}\n${stderr}`);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1000))]);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1000))]);
      }
      expect(stderr).not.toMatch(/Cannot find module/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
