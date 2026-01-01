import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { allowsEmbeddedPostgres } from '../src/env-values.js';
import { loadConfig } from '../src/config.js';
import { tp } from './ports.js';

const root = dirname(fileURLToPath(import.meta.url));
const appRoot = join(root, '..');

function withSmtpPasswordFile(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'merdienz-prod-smtp-'));
  const file = join(dir, 'smtp-password');
  writeFileSync(file, 'test-smtp-password\n');
  chmodSync(file, 0o600);
  try {
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}


const NODE_ENVS = [undefined, 'development', 'production'];
const MODES = [undefined, 'cloud', 'selfhosted', 'dev', 'test'];

function shouldAllowEmbedded(nodeEnv, mode) {
  const m = String(mode || '').toLowerCase();
  if (m !== 'dev' && m !== 'test') return false;
  return String(nodeEnv || '').toLowerCase() !== 'production';
}

function spawnEnv({ nodeEnv, mode, databaseUrl } = {}) {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.NODE_ENV;
  delete env.MERDIENZ_MODE;
  env.PROBE_B_SECRET = 's'.repeat(32);
  env.PROBE_B_URL = 'https://probe.example/internal/probe';
  env.PROBE_B_SPKI_SHA256 = 'a'.repeat(64);
  env.PORT = String(tp(4859));
  env.HOST = '127.0.0.1';
  // Production and cloud refuse MAIL_TRANSPORT=dev or console.
  const productionLike = nodeEnv === 'production' || mode === 'cloud' || mode === undefined;
  env.MAIL_TRANSPORT = productionLike ? 'none' : (env.MAIL_TRANSPORT || 'dev');
  env.PGCONNECT_TIMEOUT = '1';
  if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
  if (mode !== undefined) env.MERDIENZ_MODE = mode;
  if (databaseUrl !== undefined) env.DATABASE_URL = databaseUrl;
  return env;
}

function runEntry(env, timeoutMs = 6000) {
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: appRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderrChunks = [];
  const stdoutChunks = [];
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
  child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({
        code: null,
        timedOut: true,
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      });
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        timedOut: false,
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      });
    });
  });
}

describe('production entry', () => {
  it('refuses dev and test modes when NODE_ENV is production', () => {
    expect(() => loadConfig({ nodeEnv: 'production', merdienzMode: 'dev' })).toThrow(
      /MERDIENZ_MODE cannot be dev or test when NODE_ENV is production/
    );
    expect(() => loadConfig({ nodeEnv: 'production', merdienzMode: 'test' })).toThrow(
      /MERDIENZ_MODE cannot be dev or test when NODE_ENV is production/
    );
    expect(() => loadConfig({ nodeEnv: 'production', merdienzMode: 'cloud', mailTransport: 'none' , host: '127.0.0.1' })).not.toThrow();
    expect(() => loadConfig({ nodeEnv: 'development', merdienzMode: 'dev' })).not.toThrow();
    expect(() => loadConfig({ nodeEnv: 'test', merdienzMode: 'test' })).not.toThrow();
  });

  it('refuses dev and console mail transports when NODE_ENV is production', () => {
    expect(() => loadConfig({ nodeEnv: 'production', merdienzMode: 'cloud', mailTransport: 'dev' , host: '127.0.0.1' })).toThrow(
      /MAIL_TRANSPORT cannot be dev or console when NODE_ENV is production/
    );
    expect(() => loadConfig({ nodeEnv: 'production', merdienzMode: 'cloud', mailTransport: 'console' , host: '127.0.0.1' })).toThrow(
      /MAIL_TRANSPORT cannot be dev or console when NODE_ENV is production/
    );
    expect(() => loadConfig({ nodeEnv: 'production', merdienzMode: 'cloud', mailTransport: 'none' , host: '127.0.0.1' })).not.toThrow();
    withSmtpPasswordFile((passwordFile) => {
      expect(() => loadConfig({ nodeEnv: 'production', merdienzMode: 'cloud', mailTransport: 'smtp' , host: '127.0.0.1', smtp: { passwordFile } })).not.toThrow();
    });
    expect(() => loadConfig({ nodeEnv: 'development', merdienzMode: 'dev', mailTransport: 'dev' })).not.toThrow();
    expect(() => loadConfig({ nodeEnv: 'production', merdienzMode: 'cloud', mailTransport: 'DEV ' , host: '127.0.0.1' })).toThrow(
      /MAIL_TRANSPORT cannot be dev or console when NODE_ENV is production/
    );
    expect(() => loadConfig({ nodeEnv: 'production', merdienzMode: 'cloud', mailTransport: 'smtpx' , host: '127.0.0.1' })).toThrow(
      /MAIL_TRANSPORT must be smtp, none, dev, or console/
    );
    expect(() => loadConfig({ nodeEnv: 'development', merdienzMode: 'cloud', mailTransport: 'dev' , host: '127.0.0.1' })).toThrow(
      /MAIL_TRANSPORT must be smtp or none when MERDIENZ_MODE is cloud/
    );
    expect(() => loadConfig({ nodeEnv: 'development', merdienzMode: 'cloud', mailTransport: 'none' , host: '127.0.0.1' })).not.toThrow();
  });


  it('does not statically import the bundled Postgres helper', () => {
    const src = readFileSync(join(root, '../src/index.js'), 'utf8');
    expect(src).not.toMatch(
      /import\s+\{[^}]*startEmbeddedPostgres[^}]*\}\s+from\s+['"]\.\/pg-embedded\.js['"]/
    );
    expect(src).toMatch(/import\(\s*['"]\.\/pg-embedded\.js['"]\s*\)/);
    const cli = readFileSync(join(root, '../src/migrate-cli.js'), 'utf8');
    expect(cli).not.toMatch(
      /import\s+\{[^}]*startEmbeddedPostgres[^}]*\}\s+from\s+['"]\.\/pg-embedded\.js['"]/
    );
    expect(cli).toMatch(/import\(\s*['"]\.\/pg-embedded\.js['"]\s*\)/);
  });

  it('allows bundled Postgres only for explicit dev or test mode when NODE_ENV is not production', () => {
    for (const nodeEnv of NODE_ENVS) {
      for (const mode of MODES) {
        const allowed = shouldAllowEmbedded(nodeEnv, mode);
        expect(allowsEmbeddedPostgres({ nodeEnv, merdienzMode: mode }), `env=${nodeEnv} mode=${mode}`).toBe(
          allowed
        );
      }
    }
  });

  it('exits without starting bundled Postgres when the mode is not an explicit dev or test sandbox', async () => {
    const bare = { PATH: process.env.PATH, HOME: process.env.HOME || '' };
    const bareResult = await runEntry(bare);
    expect(bareResult.timedOut).toBe(false);
    expect(bareResult.code).not.toBe(0);
    expect(`${bareResult.stderr}\n${bareResult.stdout}`).not.toMatch(/Started embedded Postgres/);

    const refuse = [];
    for (const nodeEnv of NODE_ENVS) {
      for (const mode of MODES) {
        if (shouldAllowEmbedded(nodeEnv, mode)) continue;
        refuse.push({ nodeEnv, mode });
      }
    }
    for (const { nodeEnv, mode } of refuse) {
      const result = await runEntry(spawnEnv({ nodeEnv, mode }));
      const label = `NODE_ENV=${nodeEnv} MODE=${mode}`;
      expect(result.timedOut, label).toBe(false);
      expect(result.code, label).not.toBe(0);
      const text = `${result.stderr}\n${result.stdout}`;
      expect(text, label).not.toMatch(/Started embedded Postgres/);
      const productionSandbox =
        String(nodeEnv || '').toLowerCase() === 'production' && (mode === 'dev' || mode === 'test');
      if (productionSandbox) {
        expect(text, label).toMatch(/MERDIENZ_MODE cannot be dev or test when NODE_ENV is production/);
      } else {
        expect(text, label).toMatch(/DATABASE_URL is required/);
      }
    }
  }, 120_000);

  it('does not start bundled Postgres when DATABASE_URL is set', async () => {
    const dummy = 'postgres://merdienz:merdienz@127.0.0.1:1/none?connect_timeout=1';
    for (const nodeEnv of NODE_ENVS) {
      for (const mode of MODES) {
        const result = await runEntry(spawnEnv({ nodeEnv, mode, databaseUrl: dummy }));
        const label = `url set NODE_ENV=${nodeEnv} MODE=${mode}`;
        expect(result.timedOut, label).toBe(false);
        expect(`${result.stderr}\n${result.stdout}`, label).not.toMatch(/Started embedded Postgres/);
      }
    }
  }, 120_000);
});
