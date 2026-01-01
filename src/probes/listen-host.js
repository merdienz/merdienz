// Listen addresses must be set explicitly. Binding an unspecified address
// (any all-zero IPv4 or IPv6 form) makes Fastify enumerate network
// interfaces (uv_interface_addresses), which needs AF_NETLINK. The systemd
// units do not grant AF_NETLINK, so those binds crash with
// "Unknown system error 97". Probe B always refuses a wildcard, in every
// mode. The Cloud app refuses a wildcard when normalizeMode is cloud.
// Compose's self-hosted app may still set an explicit 0.0.0.0.
import { isIP } from 'node:net';
import { normalizeMode } from './mode.js';

function stripBrackets(host) {
  return String(host ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1');
}

// Canonicalize through the WHATWG URL parser so inet_aton spellings
// (hex forms like 0x0, short dotted forms, or leading-zero octets) become
// the unspecified IPv4 address before the wildcard check.
// IPv6 is bracketed so the authority is parsed as a host, not host:port.
function canonicalizeListenHost(host) {
  const h = stripBrackets(host);
  if (!h) return '';
  if (h === '*') return '*';
  const authority = h.includes(':') ? `[${h}]` : h;
  return stripBrackets(new URL(`http://${authority}`).hostname);
}

function ipv4OctetsAreZero(addr) {
  const parts = addr.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^(0|0x0+)$/i.test(part) || Number(part) === 0);
}

function expandIpv6Hextets(addr) {
  const [left, right] = addr.split('::');
  const head = left ? left.split(':').filter(Boolean) : [];
  const tail = right !== undefined && right !== '' ? right.split(':').filter(Boolean) : [];
  // IPv4-mapped tail (e.g. ::ffff:0.0.0.0)
  if (tail.length && tail[tail.length - 1].includes('.')) {
    const v4 = tail.pop();
    const oct = v4.split('.').map((n) => Number(n));
    if (oct.length !== 4 || oct.some((n) => !Number.isInteger(n))) return null;
    tail.push(((oct[0] << 8) | oct[1]).toString(16), ((oct[2] << 8) | oct[3]).toString(16));
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const hextets = [...head, ...Array(missing).fill('0'), ...tail];
  if (hextets.length !== 8) return null;
  return hextets.map((h) => parseInt(h, 16));
}

export function isUnspecifiedListenHost(host) {
  let h;
  try {
    h = canonicalizeListenHost(host);
  } catch {
    // Unparseable hosts are treated as unspecified so callers refuse them.
    return true;
  }
  if (!h || h === '*') return true;
  // A bare "0" (and all-zero decimal) binds as IPv4 0.0.0.0.
  if (/^0+$/.test(h)) return true;
  const kind = isIP(h);
  if (kind === 4) return ipv4OctetsAreZero(h);
  if (kind === 6) {
    const hextets = expandIpv6Hextets(h);
    if (!hextets) return false;
    if (hextets.every((n) => n === 0)) return true;
    // IPv4-mapped unspecified: ::ffff:0.0.0.0
    const mapped =
      hextets[0] === 0 &&
      hextets[1] === 0 &&
      hextets[2] === 0 &&
      hextets[3] === 0 &&
      hextets[4] === 0 &&
      hextets[5] === 0xffff &&
      hextets[6] === 0 &&
      hextets[7] === 0;
    return mapped;
  }
  return false;
}

export function assertExplicitListenHost(host, { role, mode } = {}) {
  const raw = String(host ?? '').trim();
  if (!raw) {
    const where = role === 'probe-b' ? 'probe B' : 'the Cloud app';
    const err = new Error(
      `HOST is required for ${where} and must be an explicit address`
    );
    err.code = 'HOST_REQUIRED';
    throw err;
  }
  try {
    canonicalizeListenHost(raw);
  } catch {
    const where = role === 'probe-b' ? 'probe B' : 'the Cloud app';
    const err = new Error(
      `HOST is required for ${where} and must be an explicit address, not 0.0.0.0 or ::`
    );
    err.code = 'HOST_REQUIRED';
    throw err;
  }
  const cloud = normalizeMode(mode) === 'cloud';
  const mustRefuse = role === 'probe-b' || cloud;
  if (mustRefuse && isUnspecifiedListenHost(raw)) {
    const where = role === 'probe-b' ? 'probe B' : 'the Cloud app';
    const err = new Error(
      `HOST is required for ${where} and must be an explicit address, not 0.0.0.0 or ::`
    );
    err.code = 'HOST_REQUIRED';
    throw err;
  }
  return raw;
}
