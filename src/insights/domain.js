import { isIP } from 'node:net';
import { insertOutbox } from '../alerts/outbox.js';
import { daysLeft, describeLeft, reminderDue } from './expiry.js';

export const DEFAULT_RDAP_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const BOOTSTRAP_TTL_MS = 24 * 3600 * 1000;

// Common multi-label public suffixes. Not a full public suffix list: a host under a suffix
// that is missing here is looked up one level too high, and the RDAP server answers "not found".
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.id', 'or.id', 'ac.id', 'go.id', 'web.id', 'my.id', 'biz.id', 'sch.id', 'net.id',
  'co.nz', 'org.nz', 'net.nz', 'co.jp', 'ne.jp', 'or.jp', 'ac.jp',
  'com.br', 'com.mx', 'com.ar', 'com.sg', 'com.my', 'com.ph', 'com.hk', 'com.tw', 'com.cn',
  'co.in', 'co.za', 'co.kr', 'co.th', 'com.tr', 'com.vn',
]);

export function registrableDomain(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host || isIP(host) || host.startsWith('[')) return null;
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.has(lastTwo)) {
    return labels.length >= 3 ? labels.slice(-3).join('.') : null;
  }
  return lastTwo;
}

function parseJson(res) {
  const text = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body ?? '');
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('invalid json'), { code: 'RDAP_BAD_JSON' });
  }
}

export function rdapBaseFor(bootstrap, domain) {
  const tld = domain.split('.').pop();
  const services = Array.isArray(bootstrap?.services) ? bootstrap.services : [];
  for (const entry of services) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [tlds, urls] = entry;
    if (!Array.isArray(tlds) || !tlds.map((t) => String(t).toLowerCase()).includes(tld)) continue;
    const https = (Array.isArray(urls) ? urls : []).find((u) => typeof u === 'string' && /^https:\/\//i.test(u));
    if (https) return https.endsWith('/') ? https : `${https}/`;
  }
  return null;
}

export function expirationFromRdap(doc) {
  const events = Array.isArray(doc?.events) ? doc.events : [];
  for (const ev of events) {
    if (ev && String(ev.eventAction).toLowerCase() === 'expiration' && typeof ev.eventDate === 'string') {
      const d = new Date(ev.eventDate);
      if (Number.isFinite(d.getTime())) return d.toISOString();
    }
  }
  return null;
}

const bootstrapCache = { value: null, fetchedAt: 0 };

export function clearRdapBootstrapCache() {
  bootstrapCache.value = null;
  bootstrapCache.fetchedAt = 0;
}

async function getJson(fetchFn, url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: 'GET',
      redirect: 'follow',
      maxRedirects: 3,
      signal: ac.signal,
      headers: { accept: 'application/rdap+json, application/json' },
    });
    if (res.status === 404) throw Object.assign(new Error('not found'), { code: 'RDAP_NOT_FOUND' });
    if (res.status < 200 || res.status >= 300) throw Object.assign(new Error(`status ${res.status}`), { code: 'RDAP_STATUS' });
    return parseJson(res);
  } finally {
    clearTimeout(timer);
  }
}

// Looks up a registration expiry date over RDAP. Every request goes through the caller's
// SSRF-guarded fetch (pinned lookup, per-hop redirect checks, size cap, timeouts).
export async function lookupDomainExpiry(domain, { fetchFn, bootstrapUrl = DEFAULT_RDAP_BOOTSTRAP_URL, timeoutMs = 10000, now = Date.now() } = {}) {
  if (!fetchFn) throw new Error('fetchFn is required');
  if (!bootstrapCache.value || now - bootstrapCache.fetchedAt > BOOTSTRAP_TTL_MS) {
    bootstrapCache.value = await getJson(fetchFn, bootstrapUrl, timeoutMs);
    bootstrapCache.fetchedAt = now;
  }
  const base = rdapBaseFor(bootstrapCache.value, domain);
  if (!base) throw Object.assign(new Error('no RDAP service for this TLD'), { code: 'RDAP_NO_SERVICE' });
  const doc = await getJson(fetchFn, `${base}domain/${encodeURIComponent(domain)}`, timeoutMs);
  const expiresAt = expirationFromRdap(doc);
  if (!expiresAt) throw Object.assign(new Error('no expiration date published'), { code: 'RDAP_NO_EXPIRY' });
  return { domain, expiresAt };
}

export async function recordDomainResult(db, site, { domain, expiresAt = null, error = null }, { now = new Date() } = {}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO site_insights (site_id, domain_name, domain_expires_at, domain_error, domain_checked_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (site_id) DO UPDATE SET
         domain_name = excluded.domain_name,
         domain_expires_at = COALESCE(excluded.domain_expires_at, CASE WHEN site_insights.domain_name = excluded.domain_name THEN site_insights.domain_expires_at END),
         domain_error = excluded.domain_error,
         domain_checked_at = excluded.domain_checked_at,
         updated_at = excluded.updated_at
       RETURNING domain_expires_at, domain_reminded_for, domain_reminded_days`,
      [site.id, domain, expiresAt, error ? String(error).slice(0, 200) : null, now]
    );
    const row = rows[0];
    let due = null;
    let outbox = null;
    if (expiresAt) {
      due = reminderDue({ expiresAt, now, remindedFor: row.domain_reminded_for, remindedDays: row.domain_reminded_days });
    }
    if (due !== null && site.user_email) {
      const left = daysLeft(expiresAt, now);
      await client.query(
        `UPDATE site_insights SET domain_reminded_for = $2, domain_reminded_days = $3 WHERE site_id = $1`,
        [site.id, expiresAt, due]
      );
      outbox = await insertOutbox(client, {
        kind: 'domain_expiry',
        to: site.user_email,
        subject: `DOMAIN: ${domain} registration ${describeLeft(left)}`,
        text: `The registration for ${domain} (used by ${site.name}, ${site.url}) ${describeLeft(left)} (${expiresAt}).\nRenew it with your registrar to keep the site and its email reachable.`,
      });
    }
    await client.query('COMMIT');
    return { reminder: due, outbox };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // keep the original error
    }
    throw err;
  } finally {
    client.release();
  }
}
