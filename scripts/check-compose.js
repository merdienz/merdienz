import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = resolve(process.cwd(), 'docker-compose.yml');
const raw = readFileSync(file, 'utf8');
const errors = [];
function must(cond, message) {
  if (!cond) errors.push(message);
}

must(/image:\s*postgres:17-alpine@sha256:[0-9a-f]{64}/.test(raw), 'postgres image must be pinned by digest');
must(raw.includes('read_only: true'), 'services must set read_only');
must(/cap_drop:/.test(raw) && /ALL/.test(raw), 'services must drop all capabilities');
must(raw.includes('no-new-privileges:true'), 'services must set no-new-privileges');
must(/internal:\s*true/.test(raw), 'postgres must sit on an internal network');
must(!/postgres:[\s\S]{0,400}ports:/.test(raw.split('app:')[0]), 'postgres must not publish a port');
must(/mem_limit:\s*256m/.test(raw) && /mem_limit:\s*384m/.test(raw) && /mem_limit:\s*192m/.test(raw), 'memory limits 256/384/192 are required');
must(raw.includes('cpus: 0.35') || raw.includes('cpus: "0.35"'), 'postgres cpus must be 0.35');
must(/cpus:\s*"?0\.20"?/.test(raw) || /cpus:\s*"?0\.2"?/.test(raw), 'probe-b cpus must be 0.20');
must(raw.includes('127.0.0.1:4840:4840'), 'app must publish port 4840 on loopback only');
must(!/POSTGRES_PASSWORD:-\w+/.test(raw), 'compose must not ship a default database password');
must(!/\b(?:sk_live_|re_[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16})\b/.test(raw), 'compose file must not contain live secrets');
must(raw.includes('PROBE_B_HMAC_SECRET'), 'probe-b must read PROBE_B_HMAC_SECRET');
must(/HOST:\s*0\.0\.0\.0/.test(raw), 'compose app must set an explicit HOST');

must(/ipam:[\s\S]*?subnet:\s*\d+\.\d+\.\d+\.\d+\/\d+/.test(raw), 'internal network must define an ipam subnet for the probe-b static address');
const probeIp = raw.match(/probe-b:[\s\S]*?ipv4_address:\s*([0-9.]+)/);
must(!!probeIp, 'compose probe-b must have a static ipv4_address on the internal network');
const probeHost = raw.match(/probe-b:[\s\S]*?\n\s+HOST:\s*(\S+)/);
must(!!probeHost, 'compose probe-b must set HOST');
if (probeIp && probeHost) {
  must(probeHost[1] === probeIp[1], 'compose probe-b HOST must be its static ipv4_address');
}
if (probeIp) {
  const ip = probeIp[1];
  const loopbackOrWildcard = ip === '0.0.0.0' || ip === '127.0.0.1' || ip === '::' || ip === '::1';
  must(!loopbackOrWildcard, 'compose probe-b must not bind loopback or a wildcard');
}


must(/cap_add:[\s\S]*CHOWN[\s\S]*SETUID[\s\S]*SETGID[\s\S]*DAC_OVERRIDE[\s\S]*FOWNER/.test(raw), 'postgres must cap_add CHOWN, SETUID, SETGID, DAC_OVERRIDE, FOWNER');
must(/healthcheck:[\s\S]*src\/healthcheck\.js[\s\S]*4840\/health/.test(raw), 'app must have a /health healthcheck');
must(/healthcheck:[\s\S]*src\/healthcheck\.js[\s\S]*7801\/health/.test(raw), 'probe-b must have a /health healthcheck');
must(/PROBE_B_TLS_DIR/.test(raw) && /\/certs/.test(raw), 'probe-b profile must mount TLS material');

if (errors.length) {
  console.error('docker-compose.yml failed checks:');
  for (const err of errors) console.error(` - ${err}`);
  process.exit(1);
}
console.log('docker-compose.yml ok (hardening, digest pins, internal Postgres, and 1 GB sizing checks passed)');
