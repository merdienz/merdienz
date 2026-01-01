import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

export function connectionString({ user, password, port, database }) {
  const auth = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
  return `postgres://${auth}@127.0.0.1:${port}/${database}`;
}

export async function startEmbeddedPostgres({
  port = 4842,
  database = 'merdienz',
  user = 'merdienz',
  password = 'merdienz',
  persistent = false,
} = {}) {
  const databaseDir = await mkdtemp(join(tmpdir(), 'merdienz-pg-'));
  const pg = new EmbeddedPostgres({
    databaseDir,
    user,
    password,
    port,
    persistent,
    autoRehydrateSymlinks: true,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {},
    onError: (message) => {
      const text = typeof message === 'string' ? message : String(message?.message || message);
      if (text.trim()) process.stderr.write(`[embedded-postgres] ${text}\n`);
    },
  });
  await pg.initialise();
  await pg.start();
  if (database && database !== 'postgres') {
    await pg.createDatabase(database);
  }
  const url = connectionString({ user, password, port, database });
  return {
    url,
    port,
    databaseDir,
    async stop() {
      await pg.stop();
    },
  };
}
