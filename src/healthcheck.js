import http from 'node:http';
import https from 'node:https';

const target = process.argv[2];
if (!target) process.exit(1);

let url;
try {
  url = new URL(target);
} catch {
  process.exit(1);
}

const lib = url.protocol === 'https:' ? https : http;
const req = lib.get(
  {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: `${url.pathname}${url.search}`,
    rejectUnauthorized: false,
    timeout: 3000,
  },
  (res) => {
    res.resume();
    process.exit(res.statusCode >= 200 && res.statusCode < 300 ? 0 : 1);
  }
);
req.on('error', () => process.exit(1));
req.on('timeout', () => {
  req.destroy();
  process.exit(1);
});
