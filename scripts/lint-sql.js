import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const roots = process.argv.slice(2);
const start = roots.length ? roots : ['.'];

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'web' || name === 'pg-data' || name === '.postgres') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, acc);
    else if (path.endsWith('.js')) acc.push(path);
  }
  return acc;
}

const files = start.flatMap((dir) => walk(dir));
const interpolation = /\.(?:query|execute)\s*\(\s*`[^`]*\$\{/;
const concat = /\.(?:query|execute)\s*\(\s*(?:[A-Za-z0-9_."']+)\s*\+/;

const errors = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (interpolation.test(line) || concat.test(line)) {
      errors.push(`${file}:${i + 1}: string-built SQL is not allowed`);
    }
  });
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`sql lint ok (${files.length} files)`);
