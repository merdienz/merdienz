import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'pg-data' || name === '.postgres' || name === 'dist') {
      continue;
    }
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, acc);
    else if (path.endsWith('.js')) acc.push(path);
  }
  return acc;
}

const files = walk('.');
for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
console.log(`checked ${files.length} files`);
