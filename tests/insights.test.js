import { afterEach, describe, expect, it } from 'vitest';
import { checkSite } from '../src/check-site.js';
import { loadConfig } from '../src/config.js';
import {
  clearRdapBootstrapCache,
  expirationFromRdap,
  lookupDomainExpiry,
  rdapBaseFor,
  registrableDomain,
} from '../src/insights/domain.js';
import { daysLeft, reminderDue } from '../src/insights/expiry.js';
import { runInsightsTick } from '../src/insights/run.js';
import { analyzeHtml, robotsBlocksAll } from '../src/insights/seo.js';
import { recordSslExpiry, tlsInfoFromSocket } from '../src/insights/ssl.js';
import { authHeader, closeServer, createUser, getDb, grantPlan, resetData, startLocalServer, testConfig, withApp } from './helpers.js';
import { tp } from './ports.js';

const DAY = 86400000;
const NOW = new Date('2027-02-01T00:00:00Z');
const at = (days) => new Date(NOW.getTime() + days * DAY + 3600000).toISOString();

const GOOD_HTML =
  '<!doctype html><html><head><title>Example &amp; Co</title><meta name="description" content="A page"></head><body><h1>Hello</h1></body></html>';

function rdapFetch({ expiration, notFound = false, calls = [] } = {}) {
  return async (url) => {
    calls.push(url);
    if (url.endsWith('/dns.json')) {
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ services: [[['com'], ['http://insecure.example/', 'https://rdap.example/com/v1/']]] })) };
    }
    if (notFound) return { status: 404, headers: {}, body: Buffer.from('{}') };
    return {
      status: 200,
      headers: {},
      body: Buffer.from(JSON.stringify({ events: [{ eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' }, { eventAction: 'expiration', eventDate: expiration }] })),
    };
  };
}

async function insertSite(db, user, url, extra = {}) {
  const { rows } = await db.query(
    `INSERT INTO sites (user_id, name, url, interval_seconds, last_checked_at) VALUES ($1, $2, $3, 300, now()) RETURNING *`,
    [user.id, extra.name || 'Site', url]
  );
  return { ...rows[0], user_email: user.email, gate_ssl_check: extra.gateSsl ?? true };
}

async function outbox(db, kind) {
  const { rows } = await db.query('SELECT * FROM alert_outbox WHERE kind = $1 ORDER BY created_at', [kind]);
  return rows;
}

afterEach(() => clearRdapBootstrapCache());

describe('expiry reminders', () => {
  it('sends each 30/14/7/1/0 threshold once per expiry date and restarts after renewal', () => {
    const exp = new Date(NOW.getTime() + 40 * DAY).toISOString();
    const when = (d) => new Date(NOW.getTime() + (40 - d) * DAY);
    expect(reminderDue({ expiresAt: exp, now: when(31) })).toBe(null);
    expect(reminderDue({ expiresAt: exp, now: when(30) })).toBe(30);
    expect(reminderDue({ expiresAt: exp, now: when(20), remindedFor: exp, remindedDays: 30 })).toBe(null);
    expect(reminderDue({ expiresAt: exp, now: when(14), remindedFor: exp, remindedDays: 30 })).toBe(14);
    // Paused for a while: only the most urgent missed threshold is sent.
    expect(reminderDue({ expiresAt: exp, now: when(5), remindedFor: exp, remindedDays: 30 })).toBe(7);
    expect(reminderDue({ expiresAt: exp, now: when(1), remindedFor: exp, remindedDays: 7 })).toBe(1);
    expect(reminderDue({ expiresAt: exp, now: when(-2), remindedFor: exp, remindedDays: 1 })).toBe(0);
    expect(reminderDue({ expiresAt: exp, now: when(-3), remindedFor: exp, remindedDays: 0 })).toBe(null);
    const renewed = new Date(NOW.getTime() + 60 * DAY).toISOString();
    expect(reminderDue({ expiresAt: renewed, now: when(-3), remindedFor: exp, remindedDays: 0 })).toBe(30);
    expect(reminderDue({ expiresAt: renewed, now: when(-3), remindedFor: renewed, remindedDays: 30 })).toBe(null);
    expect(reminderDue({ expiresAt: 'not a date', now: NOW })).toBe(null);
    expect(daysLeft(at(10), NOW)).toBe(10);
  });
});

describe('SEO parsing', () => {
  it('passes a complete page and flags missing title, description, h1, and noindex', () => {
    expect(analyzeHtml(GOOD_HTML).issues).toEqual([]);
    expect(analyzeHtml(GOOD_HTML).title).toBe('Example & Co');
    const bare = analyzeHtml('<html><head></head><body><p>x</p><h1>  </h1></body></html>');
    expect(bare.issues).toEqual(['title_missing', 'description_missing', 'h1_missing']);
    expect(analyzeHtml(GOOD_HTML.replace('<head>', '<head><meta content="noindex, nofollow" name="robots">')).issues).toEqual(['noindex']);
    expect(analyzeHtml(GOOD_HTML, { 'x-robots-tag': 'noindex' }).issues).toEqual(['noindex']);
  });

  it('ignores markup inside scripts, styles, and comments', () => {
    const tricky =
      '<html><head><script>var s = "<title>fake</title><h1>x</h1>";</script><!-- <meta name="description" content="hidden"> --><style>h1{}</style></head><body></body></html>';
    expect(analyzeHtml(tricky).issues).toEqual(['title_missing', 'description_missing', 'h1_missing']);
    expect(analyzeHtml('<title>' + 'a'.repeat(5000)).issues).toContain('title_missing');
  });

  it('detects robots.txt that blocks every crawler from the whole site', () => {
    expect(robotsBlocksAll('User-agent: *\nDisallow: /\n')).toBe(true);
    expect(robotsBlocksAll('User-agent: bad-bot\nUser-agent: *\nDisallow: / # all\n')).toBe(true);
    expect(robotsBlocksAll('User-agent: *\nDisallow: /\nAllow: /public\n')).toBe(false);
    expect(robotsBlocksAll('User-agent: *\nDisallow:\n')).toBe(false);
    expect(robotsBlocksAll('User-agent: bad-bot\nDisallow: /\n\nUser-agent: *\nDisallow: /admin\n')).toBe(false);
    expect(robotsBlocksAll('')).toBe(false);
  });
});

describe('domain expiry lookup', () => {
  it('finds the registrable domain', () => {
    expect(registrableDomain('www.shop.example.com')).toBe('example.com');
    expect(registrableDomain('status.example.co.id')).toBe('example.co.id');
    expect(registrableDomain('co.uk')).toBe(null);
    expect(registrableDomain('127.0.0.1')).toBe(null);
    expect(registrableDomain('localhost')).toBe(null);
  });

  it('uses only https RDAP services and reads the expiration event', async () => {
    const boot = { services: [[['com'], ['http://insecure.example/']], [['net'], ['https://rdap.example/net']]] };
    expect(rdapBaseFor(boot, 'example.com')).toBe(null);
    expect(rdapBaseFor(boot, 'example.net')).toBe('https://rdap.example/net/');
    expect(expirationFromRdap({ events: [{ eventAction: 'expiration', eventDate: 'garbage' }] })).toBe(null);
    const calls = [];
    const found = await lookupDomainExpiry('example.com', { fetchFn: rdapFetch({ expiration: '2027-03-01T00:00:00Z', calls }) });
    expect(found).toEqual({ domain: 'example.com', expiresAt: '2027-03-01T00:00:00.000Z' });
    expect(calls).toEqual(['https://data.iana.org/rdap/dns.json', 'https://rdap.example/com/v1/domain/example.com']);
    await expect(lookupDomainExpiry('example.com', { fetchFn: rdapFetch({ notFound: true }) })).rejects.toMatchObject({ code: 'RDAP_NOT_FOUND' });
  });

  it('validates the lookup settings', () => {
    expect(() => loadConfig({ nodeEnv: 'test', merdienzMode: 'test', domainExpiryLookup: 'whois' })).toThrow(/DOMAIN_EXPIRY_LOOKUP/);
    expect(() => loadConfig({ nodeEnv: 'test', merdienzMode: 'test', rdapBootstrapUrl: 'http://x.example/' })).toThrow(/https/);
    expect(() => loadConfig({ nodeEnv: 'test', merdienzMode: 'test', insightsPerTick: '0' })).toThrow(/INSIGHTS_PER_TICK/);
    expect(loadConfig({ nodeEnv: 'test', merdienzMode: 'test' }).domainExpiryLookup).toBe('off');
  });
});

describe('SSL expiry', () => {
  it('reads certificate dates from the check connection', () => {
    const socket = {
      authorized: true,
      getPeerCertificate: () => ({ valid_to: 'Mar  1 00:00:00 2027 GMT', valid_from: 'Dec  1 00:00:00 2026 GMT', issuer: { O: 'Example CA' }, subject: { CN: 'example.com' } }),
    };
    expect(tlsInfoFromSocket(socket)).toEqual({
      validTo: '2027-03-01T00:00:00.000Z',
      validFrom: '2026-12-01T00:00:00.000Z',
      issuer: 'Example CA',
      subject: 'example.com',
      authorized: true,
    });
    expect(tlsInfoFromSocket({ getPeerCertificate: () => ({}) })).toBe(null);
    expect(tlsInfoFromSocket(null)).toBe(null);
  });

  it('queues one reminder per threshold from a check and only when the plan includes SSL checks', async () => {
    const db = await getDb();
    await resetData(db);
    const user = await createUser(db, { email: 'ssl@example.com' });
    const site = await insertSite(db, user, 'https://example.com/');
    const tls = { validTo: at(10), validFrom: null, issuer: 'Example CA', subject: 'example.com' };
    const config = testConfig({ now: () => NOW.getTime() });
    const probeA = async () => ({ up: true, httpStatus: 200, latencyMs: 5, error: null, tls });
    await (await checkSite(site, { db, mailer: null, config, probeA })).sslWrite;
    await (await checkSite(site, { db, mailer: null, config, probeA })).sslWrite;
    let rows = await outbox(db, 'ssl_expiry');
    expect(rows).toHaveLength(1);
    expect(rows[0].subject).toMatch(/expires in 10 days/);
    const later = new Date(NOW.getTime() + 4 * DAY);
    expect((await recordSslExpiry(db, site, tls, { now: later })).reminder).toBe(7);
    rows = await outbox(db, 'ssl_expiry');
    expect(rows).toHaveLength(2);
    const stored = await db.query('SELECT ssl_expires_at, ssl_issuer FROM site_insights WHERE site_id = $1', [site.id]);
    expect(stored.rows[0].ssl_issuer).toBe('Example CA');

    const other = await insertSite(db, user, 'https://example.org/', { gateSsl: false });
    expect((await checkSite(other, { db, mailer: null, config, probeA })).sslWrite).toBe(null);
    const none = await db.query('SELECT 1 FROM site_insights WHERE site_id = $1', [other.id]);
    expect(none.rows).toHaveLength(0);
  });
});

describe('insights tick', () => {
  it('records an SEO baseline silently, alerts on a later regression, and rechecks only after a day', async () => {
    const db = await getDb();
    await resetData(db);
    const user = await createUser(db, { email: 'seo@example.com' });
    let html = GOOD_HTML;
    let robots = 'User-agent: *\nDisallow: /admin\n';
    const server = await startLocalServer((req, res) => {
      if (req.url === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(robots);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    }, tp(4846));
    try {
      const site = await insertSite(db, user, `${server.url}/`);
      let now = NOW.getTime();
      const config = testConfig({ seoChecks: 'on', now: () => now });
      const first = await runInsightsTick({ db, config });
      expect(first.picked).toBe(1);
      expect(first.results[0].seo.added).toEqual([]);
      expect(await outbox(db, 'seo_regression')).toHaveLength(0);

      html = GOOD_HTML.replace('<h1>Hello</h1>', '').replace('<head>', '<head><meta name="robots" content="noindex">');
      robots = 'User-agent: *\nDisallow: /\n';
      expect((await runInsightsTick({ db, config })).picked).toBe(0);
      now += 25 * 3600000;
      const second = await runInsightsTick({ db, config });
      expect(second.results[0].seo.added).toEqual(['h1_missing', 'noindex', 'robots_blocks_all']);
      const rows = await outbox(db, 'seo_regression');
      expect(rows).toHaveLength(1);
      expect(rows[0].body).toMatch(/noindex/);

      const api = await db.query('SELECT seo_issues FROM site_insights WHERE site_id = $1', [site.id]);
      expect(api.rows[0].seo_issues).toEqual(['h1_missing', 'noindex', 'robots_blocks_all']);
    } finally {
      await closeServer(server);
    }
  });

  it('refuses private targets through the SSRF guard unless the operator allows them', async () => {
    const db = await getDb();
    await resetData(db);
    const user = await createUser(db, { email: 'ssrf@example.com' });
    let hits = 0;
    const server = await startLocalServer((req, res) => {
      hits += 1;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(GOOD_HTML);
    }, tp(4847));
    try {
      const site = await insertSite(db, user, `${server.url}/`);
      const config = testConfig({ seoChecks: 'on', allowPrivateTargets: false, now: () => NOW.getTime() });
      const out = await runInsightsTick({ db, config });
      expect(out.picked).toBe(1);
      expect(hits).toBe(0);
      const row = await db.query('SELECT seo_result FROM site_insights WHERE site_id = $1', [site.id]);
      expect(row.rows[0].seo_result.error).toBeTruthy();
    } finally {
      await closeServer(server);
    }
  });

  it('serves one site per account per tick, skips plans without the feature, and queues domain reminders', async () => {
    const db = await getDb();
    await resetData(db);
    const a = await createUser(db, { email: 'a@example.com' });
    const b = await createUser(db, { email: 'b@example.com' });
    const nop = await createUser(db, { email: 'nop@example.com', tier: 'no_plan' });
    for (let i = 0; i < 3; i += 1) await insertSite(db, a, `https://a${i}.example.com/`);
    await insertSite(db, b, 'https://www.b.example.com/');
    await insertSite(db, nop, 'https://nop.example.com/');
    const config = testConfig({ seoChecks: 'off', domainExpiryLookup: 'rdap', now: () => NOW.getTime() });
    const calls = [];
    const out = await runInsightsTick({ db, config, insightsFetchFn: rdapFetch({ expiration: at(10), calls }) });
    expect(out.picked).toBe(2);
    const users = await db.query(
      `SELECT DISTINCT s.user_id FROM site_insights i JOIN sites s ON s.id = i.site_id WHERE i.domain_checked_at IS NOT NULL`
    );
    expect(users.rows.map((r) => r.user_id).sort()).toEqual([a.id, b.id].sort());
    const rows = await outbox(db, 'domain_expiry');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.to_email).sort()).toEqual(['a@example.com', 'b@example.com']);
    expect(rows[0].subject).toMatch(/example\.com registration expires in 10 days/);
    // Next ticks drain account a's other sites; the no-plan account is never picked.
    expect((await runInsightsTick({ db, config, insightsFetchFn: rdapFetch({ expiration: at(10) }) })).picked).toBe(1);
    expect((await runInsightsTick({ db, config, insightsFetchFn: rdapFetch({ expiration: at(10) }) })).picked).toBe(1);
    expect((await runInsightsTick({ db, config, insightsFetchFn: rdapFetch({ expiration: at(10) }) })).picked).toBe(0);
  });
});

describe('GET /sites/:id/insights', () => {
  it('returns gated sections for the owner and 404 for anyone else', async () => {
    await withApp(async ({ app, db }) => {
      const owner = await createUser(db, { email: 'owner@example.com' });
      const other = await createUser(db, { email: 'other@example.com' });
      const site = await insertSite(db, owner, 'https://example.com/');
      await recordSslExpiry(db, site, { validTo: at(20), validFrom: null, issuer: 'Example CA', subject: 'example.com' }, { now: NOW });
      const res = await app.inject({ method: 'GET', url: `/sites/${site.id}/insights`, headers: authHeader(owner) });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ssl.enabled).toBe(true);
      expect(body.ssl.issuer).toBe('Example CA');
      expect(body.domain).toEqual({ enabled: false });
      expect(body.seo).toEqual({ enabled: false });
      const denied = await app.inject({ method: 'GET', url: `/sites/${site.id}/insights`, headers: authHeader(other) });
      expect(denied.statusCode).toBe(404);

      await db.query(`UPDATE users SET tier = 'no_plan' WHERE id = $1`, [owner.id]);
      const gated = await app.inject({ method: 'GET', url: `/sites/${site.id}/insights`, headers: authHeader(owner) });
      expect(gated.json().ssl).toEqual({ enabled: false });
    });
  });
});

describe('migration 011 upgrade', () => {
  it('applies on a database that already has sites and alerts, and the app boots on it', async () => {
    const db = await getDb();
    await resetData(db);
    const user = await createUser(db, { email: 'upgrade@example.com' });
    const site = await insertSite(db, user, 'https://example.com/');
    await db.query(
      `INSERT INTO alert_outbox (kind, to_email, subject, body, next_attempt_at) VALUES ('down', $1, 's', 'b', now())`,
      [user.email]
    );
    // Roll the schema back to its pre-011 shape, keep the data, then migrate forward.
    await db.query('DROP TABLE site_insights');
    await db.query(`DELETE FROM schema_migrations WHERE id = '011_site_insights.sql'`);
    const { migrate } = await import('../src/db.js');
    await migrate(db);
    await migrate(db);
    const idx = await db.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'site_insights' ORDER BY indexname`);
    expect(idx.rows.map((r) => r.indexname)).toEqual([
      'site_insights_domain_checked_idx',
      'site_insights_pkey',
      'site_insights_seo_checked_idx',
    ]);
    const kept = await db.query('SELECT id FROM sites WHERE id = $1', [site.id]);
    expect(kept.rows).toHaveLength(1);
    await withApp(async ({ app }) => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
    });
  });
});

describe('plan defaults', () => {
  it('keeps basic SEO checks on Pro only, and SSL and domain expiry on Starter and Pro', async () => {
    const db = await getDb();
    await resetData(db);
    const { rows } = await db.query(
      `SELECT tier, ssl_check, domain_expiry, seo_check, seo_enabled FROM plan_gates WHERE tier IN ('starter', 'pro', 'selfhosted') ORDER BY tier`
    );
    expect(rows).toEqual([
      { tier: 'pro', ssl_check: true, domain_expiry: true, seo_check: true, seo_enabled: true },
      { tier: 'selfhosted', ssl_check: true, domain_expiry: true, seo_check: true, seo_enabled: true },
      { tier: 'starter', ssl_check: true, domain_expiry: true, seo_check: false, seo_enabled: false },
    ]);
    const starter = await createUser(db, { email: 'starter@example.com' });
    await grantPlan(db, starter.id, 'starter');
    await insertSite(db, starter, 'https://starter.example.com/');
    const out = await runInsightsTick({ db, config: testConfig({ seoChecks: 'on', now: () => NOW.getTime() }) });
    expect(out.picked).toBe(0);
  });
});

describe('SSL write and the uptime check', () => {
  it('a slow or failing SSL write does not delay the check result or the down alert', async () => {
    const db = await getDb();
    await resetData(db);
    const user = await createUser(db, { email: 'ssl-slow@example.com' });
    const site = await insertSite(db, user, 'https://slow-ssl.example.com/');
    const tls = { validTo: at(3), validFrom: null, issuer: 'Example CA', subject: 'example.com' };
    const config = testConfig({ now: () => NOW.getTime() });
    const probeA = async () => ({ up: false, httpStatus: 503, latencyMs: 5, error: 'status 503', tls });
    const callB = async () => ({ up: false, error: 'status 503' });
    const warnings = [];
    const logger = { warn: (o, m) => warnings.push(m), error() {}, info() {} };
    let release;
    const hung = new Promise((resolve) => {
      release = resolve;
    });
    let started = Date.now();
    const down = await checkSite(site, { db, mailer: null, config, probeA, callB, logger, recordSsl: () => hung });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(down.status).toBe('down');
    expect(await outbox(db, 'down')).toHaveLength(1);
    // A second check while the first write is still pending does not queue another write.
    const again = await checkSite(site, { db, mailer: null, config, probeA, callB, logger, recordSsl: () => hung });
    expect(again.sslWrite).toBe(null);
    release();
    await down.sslWrite;

    started = Date.now();
    const failing = await checkSite(site, {
      db, mailer: null, config, probeA, callB, logger,
      recordSsl: async () => {
        throw new Error('db unavailable');
      },
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(failing.status).toBe('down');
    expect(await failing.sslWrite).toBe(null);
    expect(warnings).toContain('ssl expiry record failed');
  });
});

describe('SEO parsing of hostile pages', () => {
  it('stays linear on pages of unclosed or nested tags', () => {
    const N = 512 * 1024;
    const pages = [
      '<script>'.repeat(N / 8),
      '<!--'.repeat(N / 4),
      '<h1>'.repeat(N / 4),
      '<title'.repeat(Math.floor(N / 6)),
      '<meta '.repeat(Math.floor(N / 6)),
      `<meta ${'a'.repeat(1990)}>`.repeat(260),
      `<h1>${'<'.repeat(4990)}</h1>`.repeat(100),
    ];
    const started = Date.now();
    for (const html of pages) analyzeHtml(html);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('reads each part of the page once in the meta scan, even with overlapping openers', () => {
    const N = 512 * 1024;
    const worst = [
      `${'<meta '.repeat(Math.floor((N - 1) / 6))}>`,
      `${'<meta a=b '.repeat(Math.floor((N - 1) / 10))}>`,
      `<meta ${'a'.repeat(1990)}>`.repeat(Math.floor(N / 2000)),
      '<meta name=x>'.repeat(Math.floor(N / 13)),
    ];
    for (const html of worst) {
      const started = Date.now();
      analyzeHtml(html);
      expect(Date.now() - started).toBeLessThan(150);
    }
    // Only the first 256 meta tags are read.
    const many = `${'<meta name=x content=y>'.repeat(300)}<meta name="description" content="late">`;
    expect(analyzeHtml(many).description_length).toBe(0);
    expect(analyzeHtml(`<meta name="description" content="early">${many}`).description_length).toBe(5);
  });

  it('still ignores hidden markup and reads the visible tags', () => {
    const html =
      '<!-- <title>hidden</title> --><script>var t = "<h1>no</h1>";</script><title>Shown</title>' +
      '<meta name=description content="Desc"><h1 class="x"><b>Head</b></h1><h10>not h1</h10>';
    const r = analyzeHtml(html);
    expect(r.title).toBe('Shown');
    expect(r.description_length).toBe(4);
    expect(r.h1_count).toBe(1);
    expect(r.issues).toEqual([]);
    expect(analyzeHtml('<title>a</title><script>never closed <h1>x</h1>').issues).toContain('h1_missing');
  });
});

describe('scheduler', () => {
  it('runs insights outside the uptime check tick', async () => {
    const db = await getDb();
    await resetData(db);
    const user = await createUser(db, { email: 'slow-seo@example.com' });
    await insertSite(db, user, 'https://slow.example.com/', { enabled: true });
    let fetched = 0;
    const config = testConfig({ seoChecks: 'on', now: () => NOW.getTime() });
    const { runSchedulerTick } = await import('../src/scheduler.js');
    const out = await runSchedulerTick({
      db,
      config,
      fetchFn: async () => ({ ok: true, status: 200, headers: {}, body: Buffer.from('') }),
      insightsFetchFn: () => {
        fetched += 1;
        return new Promise(() => {});
      },
    });
    expect(out).not.toHaveProperty('insights');
    expect(fetched).toBe(0);
  });
});
