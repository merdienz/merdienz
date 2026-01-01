import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { bad } from './errors.js';

const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback']);

function parseNumericPart(part) {
  const s = String(part).trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith('0x')) {
    if (!/^0x[0-9a-f]+$/.test(s)) return null;
    const n = Number.parseInt(s.slice(2), 16);
    return Number.isFinite(n) ? n : null;
  }
  if (s.length > 1 && s.startsWith('0') && /^0[0-7]+$/.test(s)) {
    const n = Number.parseInt(s, 8);
    return Number.isFinite(n) ? n : null;
  }
  if (s.length > 1 && s.startsWith('0') && /^0[0-9]+$/.test(s)) {
    return null;
  }
  if (!/^[0-9]+$/.test(s)) return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

export function parseIPv4Loose(host) {
  if (!host || typeof host !== 'string') return null;
  const raw = host.trim().toLowerCase().replace(/\.$/, '');
  if (!/^[0-9a-fx.]+$/.test(raw)) return null;
  const parts = raw.split('.');
  if (parts.length === 0 || parts.length > 4) return null;
  const nums = parts.map(parseNumericPart);
  if (nums.some((n) => n == null || n < 0)) return null;
  let addr;
  if (nums.length === 1) {
    if (nums[0] > 0xffffffff) return null;
    addr = nums[0];
  } else if (nums.length === 2) {
    if (nums[0] > 0xff || nums[1] > 0xffffff) return null;
    addr = (nums[0] << 24) + nums[1];
  } else if (nums.length === 3) {
    if (nums[0] > 0xff || nums[1] > 0xff || nums[2] > 0xffff) return null;
    addr = (nums[0] << 24) + (nums[1] << 16) + nums[2];
  } else {
    if (nums.some((n) => n > 0xff)) return null;
    addr = (nums[0] << 24) + (nums[1] << 16) + (nums[2] << 8) + nums[3];
  }
  addr >>>= 0;
  return ipv4FromInt(addr);
}

function ipv4FromInt(addr) {
  const text = `${(addr >>> 24) & 255}.${(addr >>> 16) & 255}.${(addr >>> 8) & 255}.${addr & 255}`;
  return { text, int: addr, family: 4 };
}

export function expandIPv6(address) {
  let raw = address.trim().toLowerCase();
  if (raw.startsWith('[') && raw.endsWith(']')) raw = raw.slice(1, -1);
  const zone = raw.indexOf('%');
  if (zone >= 0) raw = raw.slice(0, zone);
  if (raw.includes('.')) {
    const last = raw.lastIndexOf(':');
    const v4 = parseIPv4Loose(raw.slice(last + 1));
    if (!v4) return null;
    const v4hex = `${((v4.int >>> 16) & 0xffff).toString(16)}:${(v4.int & 0xffff).toString(16)}`;
    raw = `${raw.slice(0, last + 1)}${v4hex}`;
  }
  const halves = raw.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 && missing < 0) return null;
  const parts = halves.length === 2 ? [...left, ...Array(missing).fill('0'), ...right] : left;
  if (parts.length !== 8) return null;
  const words = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{0,4}$/.test(part)) return null;
    words.push(Number.parseInt(part || '0', 16));
  }
  return words;
}

function ipv4FromMappedWords(words) {
  if (!words || words.length !== 8) return null;
  const mapped = words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 && words[4] === 0 && words[5] === 0xffff;
  const compat = words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 && words[4] === 0 && words[5] === 0;
  if (mapped || (compat && !(words[6] === 0 && words[7] === 1) && !(words[6] === 0 && words[7] === 0))) {
    const int = ((words[6] << 16) + words[7]) >>> 0;
    return ipv4FromInt(int);
  }
  if (compat && words[6] === 0 && words[7] === 1) return { loopback6: true };
  if (compat && words[6] === 0 && words[7] === 0) return { unspecified6: true };
  return null;
}

export function isBlockedIPv4(int) {
  const a = int >>> 0;
  if (a <= 0x00ffffff) return true; // reserved-range
  if ((a >>> 24) === 10) return true; // reserved-range
  if ((a >>> 24) === 127) return true; // reserved-range
  if ((a >>> 16) === 0xa9fe) return true; // reserved-range
  if ((a >>> 20) === 0xac1) return true; // reserved-range
  if ((a >>> 16) === 0xc0a8) return true; // reserved-range
  if ((a >>> 22) === 0x191) return true; // reserved-range
  if ((a >>> 8) === 0xc00000) return true; // reserved-range
  if ((a >>> 8) === 0xc00002) return true; // reserved-range
  if ((a >>> 8) === 0xc01fc4) return true; // reserved-range
  if ((a >>> 8) === 0xc034c1) return true; // reserved-range
  if ((a >>> 8) === 0xc05863) return true; // reserved-range
  if ((a >>> 8) === 0xc0af30) return true; // reserved-range
  if (((a & 0xfffe0000) >>> 0) === 0xc6120000) return true; // reserved-range
  if ((a >>> 8) === 0xc63364) return true; // reserved-range
  if ((a >>> 8) === 0xcb0071) return true; // reserved-range
  if ((a >>> 28) >= 0xe) return true; // reserved-range and reserved-range
  return false;
}

function embeddedIPv4FromIPv6(words) {
  if (!words || words.length !== 8) return null;
  // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052)
  if (
    words[0] === 0x64 &&
    words[1] === 0xff9b &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0
  ) {
    return ipv4FromInt(((words[6] << 16) + words[7]) >>> 0);
  }
  // NAT64 local-use prefix 64:ff9b:1::/48 (RFC 8215, IPv4 at bits 48-79)
  if (words[0] === 0x64 && words[1] === 0xff9b && words[2] === 0x1) {
    return ipv4FromInt(((words[3] << 16) + words[4]) >>> 0);
  }
  // 6to4 2002::/16
  if (words[0] === 0x2002) {
    return ipv4FromInt(((words[1] << 16) + words[2]) >>> 0);
  }
  return null;
}

export function isBlockedIPv6(words) {
  if (!words) return true;
  const mapped = ipv4FromMappedWords(words);
  if (mapped?.loopback6 || mapped?.unspecified6) return true;
  // IPv4-mapped ::ffff:0:0/96 is never accepted as a target (use the IPv4 form).
  if (
    words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 &&
    words[4] === 0 && words[5] === 0xffff
  ) {
    return true;
  }
  // IPv4-translated ::ffff:0:0:0/96: check the embedded IPv4.
  if (words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 && words[4] === 0xffff && words[5] === 0) {
    const translated = ipv4FromInt(((words[6] << 16) + words[7]) >>> 0);
    if (isBlockedIPv4(translated.int)) return true;
  }
  if (mapped?.int != null) return isBlockedIPv4(mapped.int);
  const embedded = embeddedIPv4FromIPv6(words);
  if (embedded?.int != null && isBlockedIPv4(embedded.int)) return true;
  const allZero = words.every((w) => w === 0);
  if (allZero) return true;
  if (words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 && words[4] === 0 && words[5] === 0 && words[6] === 0 && words[7] === 1) {
    return true;
  }
  if ((words[0] & 0xffc0) === 0xfe80) return true; // link-local
  if ((words[0] & 0xffc0) === 0xfec0) return true; // site-local fec0::/10
  if ((words[0] & 0xfe00) === 0xfc00) return true; // unique local
  if ((words[0] & 0xff00) === 0xff00) return true; // multicast
  if (words[0] === 0x2001 && words[1] === 0) return true; // Teredo 2001::/32
  if (words[0] === 0x2001 && words[1] === 0xdb8) return true; // documentation
  if (words[0] === 0x2001 && (words[1] & 0xfff0) === 0x0010) return true; // ORCHID
  if (words[0] === 0x2001 && (words[1] & 0xfff0) === 0x0020) return true; // ORCHIDv2
  if (words[0] === 0x2001 && words[1] === 0x2) return true; // benchmarking 2001:2::/48
  if (words[0] === 0x0100 && words[1] === 0 && words[2] === 0 && words[3] === 0) return true; // discard 100::/64
  return false;
}

export function isBlockedAddress(address) {
  if (!address) return true;
  let host = String(address).trim();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const zone = host.indexOf('%');
  if (zone >= 0) host = host.slice(0, zone);

  if (isIP(host) === 4) {
    const parsed = parseIPv4Loose(host);
    return !parsed || isBlockedIPv4(parsed.int);
  }
  if (isIP(host) === 6) {
    return isBlockedIPv6(expandIPv6(host));
  }
  const asV4 = parseIPv4Loose(host);
  if (asV4) return isBlockedIPv4(asV4.int);
  const asV6 = expandIPv6(host);
  if (asV6) return isBlockedIPv6(asV6);
  return false;
}

export function isBlockedHostname(hostname) {
  const host = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  if (!host) return true;
  if (BLOCKED_HOSTS.has(host)) return true;
  return isBlockedAddress(host);
}


function bareHost(hostname) {
  let host = String(hostname || '').trim();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const zone = host.indexOf('%');
  if (zone >= 0) host = host.slice(0, zone);
  return host;
}

export async function resolvePublicAddresses(hostname, { lookup = dnsLookup, allowPrivate = false } = {}) {
  const host = bareHost(hostname);
  if (allowPrivate) {
    if (isIP(host)) return [{ address: host, family: isIP(host) }];
    const asV4 = parseIPv4Loose(host);
    if (asV4) return [{ address: asV4.text, family: 4 }];
    const asV6 = expandIPv6(host);
    if (asV6) return [{ address: host, family: 6 }];
    try {
      const all = await lookup(host, { all: true, verbatim: true });
      return Array.isArray(all) ? all : [all];
    } catch (err) {
      throw bad(400, `Could not resolve host: ${err.message}`, 'UNRESOLVED_HOST');
    }
  }
  if (isBlockedHostname(host) || isBlockedHostname(hostname)) {
    throw bad(400, 'URL host is not allowed', 'BLOCKED_HOST');
  }
  if (isIP(host) || parseIPv4Loose(host) || expandIPv6(host)) {
    const ip = parseIPv4Loose(host)?.text || host;
    return [{ address: ip, family: isIP(ip) || (parseIPv4Loose(ip) ? 4 : 6) }];
  }
  let records;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw bad(400, `Could not resolve host: ${err.message}`, 'UNRESOLVED_HOST');
  }
  const list = Array.isArray(records) ? records : [records];
  if (!list.length) throw bad(400, 'Could not resolve host', 'UNRESOLVED_HOST');
  if (list.some((row) => isBlockedAddress(row.address))) {
    throw bad(400, 'URL host resolves to a private or reserved address', 'BLOCKED_HOST');
  }
  return list;
}

export async function assertSafeHttpUrl(url, options = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw bad(400, 'url must be a valid HTTP(S) URL', 'BAD_URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw bad(400, 'url must be http or https', 'BAD_URL');
  }
  const hostname = parsed.hostname;
  if (!hostname) throw bad(400, 'url must be a valid HTTP(S) URL', 'BAD_URL');
  const addresses = await resolvePublicAddresses(hostname, options);
  return { url: parsed.toString(), hostname, addresses, parsed };
}
