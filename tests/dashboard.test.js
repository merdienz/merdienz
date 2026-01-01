import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from '../web/node_modules/react/index.js';
import { renderToStaticMarkup } from '../web/node_modules/react-dom/server.node.js';
import {
  DAY,
  HOUR,
  INCIDENT_LIMIT,
  MIN,
  RANGES,
  aggregateUptime,
  buildEvents,
  currentCounts,
  deltaPts,
  fmtPct,
  fmtPrevEnd,
  isPartial,
  normalizeIncidents,
  prefersReducedMotion,
  rangeWindow,
  readUrlState,
  siteBuckets,
  siteUptime,
  spinnerMs,
  writeUrlState,
} from '../web/src/dashboard/derive.js';
import { buildView } from '../web/src/dashboard/view.js';
import { loadDashboard } from '../web/src/dashboard/load.js';
import { ChartPanel, EventsPanel, Kpis, Timeline, refreshClass } from '../web/src/dashboard/Overview.jsx';
import Manage from '../web/src/dashboard/Manage.jsx';

const NOW = Date.UTC(2026, 10, 25, 10, 0, 0);
const iso = (t) => new Date(t).toISOString();

function fixture(tier = 'starter') {
  const sites = [
    { id: 'a', name: 'shop', url: 'https://shop.example.com/', interval_seconds: 60, current_status: 'down', last_checked_at: iso(NOW - MIN), created_at: iso(NOW - 40 * DAY), public_on_status: false },
    { id: 'b', name: 'www', url: 'https://www.example.com/', interval_seconds: 300, current_status: 'up', last_checked_at: iso(NOW - MIN), created_at: iso(NOW - 10 * HOUR), public_on_status: true },
    { id: 'c', name: 'new', url: 'https://new.example.com/', interval_seconds: 300, current_status: 'unknown', last_checked_at: null, created_at: iso(NOW - 5 * MIN), public_on_status: false },
  ];
  const heartbeats = [
    { id: 'h1', name: 'backup', status: 'late', period_seconds: 3600, snippets: { curl: 'x', cron: 'y' } },
    { id: 'h2', name: 'report', status: 'down', period_seconds: 86400, snippets: { curl: 'x', cron: 'y' } },
  ];
  const incidentsBySite = {
    a: normalizeIncidents([
      { id: 'i1', started_at: iso(NOW - 38 * MIN), ended_at: null, status: 'open' },
      { id: 'i2', started_at: iso(NOW - 20 * HOUR), ended_at: iso(NOW - 20 * HOUR + 30 * MIN), status: 'resolved' },
      { id: 'i3', started_at: iso(NOW - 3 * DAY), ended_at: iso(NOW - 3 * DAY + 60 * MIN), status: 'resolved' },
    ]),
    b: normalizeIncidents([
      { id: 'i4', started_at: iso(NOW - 2 * HOUR), ended_at: iso(NOW - 2 * HOUR + 10 * MIN), status: 'resolved' },
    ]),
    c: [],
  };
  return {
    loaded: true,
    fetchedAt: NOW,
    me: { id: 'u', email: 'owner@example.com', tier },
    sites,
    heartbeats,
    statusPage: null,
    incidentsBySite,
    historyError: false,
  };
}

const tile = (view, key) => view.tiles.find((t) => t.key === key);

describe('dashboard range windows', () => {
  test('every range has the spec bucket count and an adjacent previous window of the same length', () => {
    const want = { '1h': 60, '6h': 72, '24h': 96, '7d': 84, '30d': 90 };
    for (const [range, n] of Object.entries(want)) {
      const w = rangeWindow(range, NOW);
      expect(w.n).toBe(n);
      expect(w.to).toBe(NOW);
      expect(w.to - w.from).toBe(RANGES[range].span);
      expect(w.prevTo).toBe(w.from);
      expect(w.prevTo - w.prevFrom).toBe(RANGES[range].span);
      expect(w.step * n).toBe(RANGES[range].span);
    }
  });
});

describe('dashboard uptime derivation', () => {
  test('downtime is clipped to the window, open incidents run to now, and a site counts only from its creation', () => {
    const d = fixture();
    const w = rangeWindow('24h', NOW);
    const a = siteUptime(d.sites[0], d.incidentsBySite.a, w.from, w.to, NOW);
    expect(a.downMs).toBe(68 * MIN);
    expect(a.pct).toBeCloseTo(100 * (1 - 68 / 1440), 9);
    const b = siteUptime(d.sites[1], d.incidentsBySite.b, w.from, w.to, NOW);
    expect(b.downMs).toBe(10 * MIN);
    expect(b.pct).toBeCloseTo(100 * (1 - 10 / 600), 9);
    expect(siteUptime(d.sites[2], [], w.from, w.to, NOW)).toBeNull();
    const clipped = siteUptime(d.sites[0], normalizeIncidents([{ started_at: iso(NOW - 25 * HOUR), ended_at: iso(NOW - 23 * HOUR) }]), w.from, w.to, NOW);
    expect(clipped.downMs).toBe(HOUR);
  });

  test('the uptime tile is the mean across checks with data and the previous tile uses the previous window', () => {
    const d = fixture();
    const v = buildView(d, '24h', null, NOW);
    const mean = (100 * (1 - 68 / 1440) + 100 * (1 - 10 / 600)) / 2;
    expect(tile(v, 'cur').val).toBe(fmtPct(mean));
    expect(tile(v, 'cur').sub).toContain('1h 18m down');
    expect(tile(v, 'prev').val).toBe('100');
    expect(tile(v, 'prev').sub).toContain('no downtime');
    const agg = aggregateUptime(d.sites, d.incidentsBySite, NOW - 2 * DAY, NOW - DAY, NOW);
    expect(agg.count).toBe(1);
  });

  test('the range picker drives both uptime tiles, their pills, the timeline and the events', () => {
    const d = fixture();
    const v24 = buildView(d, '24h', null, NOW);
    const v7 = buildView(d, '7d', null, NOW);
    const v1 = buildView(d, '1h', null, NOW);
    expect(tile(v24, 'cur').win).toBe('24h');
    expect(tile(v24, 'prev').win).toBe('prev 24h');
    expect(tile(v7, 'cur').win).toBe('7d');
    expect(tile(v7, 'prev').win).toBe('prev 7d');
    expect(tile(v7, 'rt').win).toBe('7d');
    expect(tile(v7, 'cur').val).toBe(fmtPct((100 * (1 - 128 / 10080) + 100 * (1 - 10 / 600)) / 2));
    expect(tile(v7, 'cur').val).not.toBe(tile(v24, 'cur').val);
    expect(tile(v1, 'cur').val).toBe(fmtPct((100 * (1 - 38 / 60) + 100) / 2));
    const rowA = (v) => v.timeline.rows.find((r) => r.id === 'a');
    expect(rowA(v24).buckets).toHaveLength(96);
    expect(rowA(v7).buckets).toHaveLength(84);
    expect(rowA(v1).buckets).toHaveLength(60);
    expect(rowA(v24).uptime).toBe(`${fmtPct(100 * (1 - 68 / 1440))}%`);
    expect(rowA(v7).uptime).toBe(`${fmtPct(100 * (1 - 128 / 10080))}%`);
    expect(v1.events.list).toHaveLength(1);
    expect(v24.events.list).toHaveLength(5);
    expect(v7.events.list).toHaveLength(7);
    expect(v24.events.meta).toBe('5 in 24 hours');
    // "now" tiles ignore the picker
    expect(tile(v7, 'up').val).toBe(tile(v1, 'up').val);
    expect(tile(v7, 'inc').val).toBe(tile(v1, 'inc').val);
    expect(tile(v7, 'up').win).toBe('now');
  });

  test('buckets are down where an incident overlaps and none before the site existed', () => {
    const d = fixture();
    const a = siteBuckets(d.sites[0], d.incidentsBySite.a, '24h', NOW);
    expect(a.at(-1).status).toBe('down');
    expect(a.filter((b) => b.status === 'down')).toHaveLength(3 + 2);
    const b = siteBuckets(d.sites[1], d.incidentsBySite.b, '24h', NOW);
    expect(b.filter((x) => x.status === 'none')).toHaveLength(56);
    expect(b.filter((x) => x.status === 'down')).toHaveLength(1);
    const blip = siteBuckets(d.sites[0], normalizeIncidents([{ started_at: iso(NOW - 5 * HOUR), ended_at: iso(NOW - 5 * HOUR + 2 * MIN) }]), '24h', NOW);
    expect(blip.filter((x) => x.status === 'down')).toHaveLength(1);
    const c = siteBuckets(d.sites[2], [], '24h', NOW);
    expect(c.every((x) => x.status === 'none')).toBe(true);
  });

  test('a cut-off incident list is flagged as partial for windows it may not cover', () => {
    const many = normalizeIncidents(Array.from({ length: INCIDENT_LIMIT }, (_, i) => ({ started_at: iso(NOW - (i + 1) * MIN), ended_at: iso(NOW - (i + 1) * MIN + 1000) })));
    expect(isPartial(many, NOW - DAY)).toBe(true);
    expect(isPartial(many, NOW - 30 * MIN)).toBe(false);
    expect(isPartial(many.slice(1), NOW - DAY)).toBe(false);
    const d = fixture();
    d.incidentsBySite.b = many;
    const v = buildView(d, '24h', null, NOW);
    expect(tile(v, 'cur').sub).toContain('partial');
    expect(tile(v, 'cur').aria).toContain('latest 50 incidents');
  });
});

describe('dashboard tiles and formatting', () => {
  test('the change is worked out from the rounded values shown', () => {
    expect(deltaPts(99.274, 99.784).text).toBe('↓ 0.51 pts');
    // 99.27 and 99.79 are shown, so the change reads 0.52, not the raw 0.5102
    expect(deltaPts(99.2749, 99.7851).text).toBe('↓ 0.52 pts');
    expect(deltaPts(99.9991, 99.9989).text).toBe('= previous');
    expect(deltaPts(99.95, 99.9).text).toBe('↑ 0.05 pts');
    expect(fmtPct(99.27)).toBe('99.27');
    expect(fmtPct(99.9501)).toBe('99.95');
    expect(fmtPct(99.99999)).toBe('100');
  });

  test('the previous window end is formatted per range', () => {
    const t = new Date(2026, 10, 24, 17, 29).getTime();
    expect(fmtPrevEnd(t, '1h')).toBe('17:29');
    expect(fmtPrevEnd(t, '6h')).toBe('17:29');
    expect(fmtPrevEnd(t, '24h')).toBe('24 Nov 17:29');
    expect(fmtPrevEnd(t, '7d')).toBe('24 Nov');
    expect(fmtPrevEnd(t, '30d')).toBe('24 Nov');
  });

  test('checks up and open incidents are "now" values from current status', () => {
    const d = fixture();
    expect(currentCounts(d.sites, d.heartbeats)).toEqual({ total: 5, up: 1, down: 2, degraded: 1 });
    const v = buildView(d, '24h', null, NOW);
    expect(tile(v, 'up').val).toBe('1');
    expect(tile(v, 'up').unit).toBe('/5');
    expect(tile(v, 'inc').val).toBe('2');
    expect(tile(v, 'inc').hot).toBe(true);
    expect(tile(v, 'inc').sub).toBe('shop · 38 min');
  });

  test('average response is never invented: the API has no response times', () => {
    for (const range of Object.keys(RANGES)) {
      const v = buildView(fixture(), range, null, NOW);
      expect(tile(v, 'rt').val).toBe('—');
      expect(tile(v, 'rt').blank).toBe(true);
      expect(v.chart.state).toBe('unavailable');
    }
  });
});

describe('dashboard events', () => {
  test('events are newest first, limited to the window, and follow the check filter', () => {
    const d = fixture();
    const all = buildEvents(d.sites, d.incidentsBySite, '24h', NOW);
    expect(all.map((e) => e.at)).toEqual([...all.map((e) => e.at)].sort((x, y) => y - x));
    expect(all[0]).toMatchObject({ checkId: 'a', kind: 'down', title: 'Check went down' });
    expect(all[0].detail).toContain('ongoing');
    const onlyB = buildEvents(d.sites, d.incidentsBySite, '24h', NOW, 'b');
    expect(onlyB.map((e) => e.kind)).toEqual(['up', 'down']);
    expect(onlyB[0].detail).toBe('Down for 10 min');
    const v = buildView(d, '24h', 'b', NOW);
    expect(v.checkName).toBe('www');
    expect(v.events.list).toHaveLength(2);
    expect(v.timeline.rows.find((r) => r.id === 'b').pressed).toBe(true);
    expect(buildView(d, '24h', 'nope', NOW).check).toBeNull();
    const quiet = buildView(d, '1h', 'b', NOW);
    expect(quiet.events.list).toHaveLength(0);
    expect(quiet.events.emptyText).toBe('www was up the whole time in the last 1 hour.');
  });
});

describe('dashboard states', () => {
  test('an account with no checks gets neutral tiles and an add button', () => {
    const d = { ...fixture(), sites: [], heartbeats: [], incidentsBySite: {} };
    const v = buildView(d, '24h', null, NOW);
    expect(v.state).toBe('empty');
    expect(v.canAdd).toBe(true);
    expect(v.tiles.every((t) => t.val === '—' && t.blank)).toBe(true);
    const html = renderToStaticMarkup(createElement(Timeline, { view: v, onToggle() {}, onAdd() {}, onRetry() {} }));
    expect(html).toContain('No checks yet');
    expect(html).toContain('Add your first check');
  });

  test('a no_plan account sees an honest empty state with no data and no plan or buy buttons', () => {
    const d = { ...fixture('no_plan'), sites: [], heartbeats: [], incidentsBySite: {} };
    const v = buildView(d, '24h', null, NOW);
    expect(v.state).toBe('noplan');
    expect(v.noPlan).toBe(true);
    expect(v.canAdd).toBe(false);
    const html = [
      renderToStaticMarkup(createElement(Kpis, { view: v })),
      renderToStaticMarkup(createElement(ChartPanel, { view: v, onRetry() {} })),
      renderToStaticMarkup(createElement(EventsPanel, { view: v, onClear() {}, onRetry() {} })),
      renderToStaticMarkup(createElement(Timeline, { view: v, onToggle() {}, onAdd() {}, onRetry() {} })),
      renderToStaticMarkup(createElement(Manage, { data: d, noPlan: true, reload() {} })),
    ].join('\n');
    expect(html).toContain('active plan');
    expect(html).not.toContain('Add your first check');
    expect(html).not.toMatch(/<form/);
    expect(html).not.toMatch(/<a [^>]*href="[^"]*(pricing|checkout|billing|plan)/i);
    expect(html).not.toMatch(/<button[^>]*>[^<]*(buy|upgrade|choose|plan|subscribe|checkout)/i);
    const tilesHtml = renderToStaticMarkup(createElement(Kpis, { view: v }));
    const values = [...tilesHtml.matchAll(/class="val"[^>]*>(.*?)<\/div>/g)].map((m) => m[1]);
    expect(values).toHaveLength(5);
    expect(values.every((x) => x === '—')).toBe(true);
    expect(tilesHtml).not.toContain('class="badge"');
  });

  test('a no_plan account that still has checks sees them but cannot add more', () => {
    const d = fixture('no_plan');
    const v = buildView(d, '24h', null, NOW);
    expect(v.state).toBe('ok');
    expect(v.canAdd).toBe(false);
    const html = renderToStaticMarkup(createElement(Manage, { data: d, noPlan: true, reload() {} }));
    expect(html).not.toMatch(/<form/);
    expect(html).toContain('shop');
    const paid = renderToStaticMarkup(createElement(Manage, { data: fixture('starter'), noPlan: false, reload() {} }));
    expect(paid).toMatch(/<form/);
    expect(paid).toContain('Add site');
  });

  test('a failed history read keeps current status and marks history panels unavailable', () => {
    const d = { ...fixture(), historyError: true };
    const v = buildView(d, '24h', null, NOW);
    expect(tile(v, 'up').val).toBe('1');
    expect(tile(v, 'cur').val).toBe('—');
    expect(tile(v, 'prev').val).toBe('—');
    expect(tile(v, 'inc').val).toBe('—');
    expect(v.events.state).toBe('error');
    expect(v.timeline.state).toBe('error');
    expect(v.timeline.rows).toHaveLength(5);
  });

  test('first load shows skeletons and a core failure shows the error state', () => {
    expect(buildView({ loaded: false }, '24h', null, NOW).state).toBe('loading');
    const html = renderToStaticMarkup(createElement(Kpis, { view: buildView({ loaded: false }, '24h', null, NOW) }));
    expect(html).toContain('aria-busy="true"');
    const err = buildView({ loaded: false, coreError: true }, '24h', null, NOW);
    expect(err.state).toBe('error');
    expect(err.tiles.every((t) => t.val === '—')).toBe(true);
  });
});

describe('dashboard data loading', () => {
  test('reads only existing endpoints and flags history errors per site', async () => {
    const d = fixture();
    const seen = [];
    const api = async (path) => {
      seen.push(path);
      if (path === '/me') return d.me;
      if (path === '/sites') return { sites: d.sites };
      if (path === '/heartbeats') return { heartbeats: d.heartbeats };
      if (path === '/status-page') return { status_page: null };
      if (path === '/sites/b/incidents') throw Object.assign(new Error('boom'), { status: 500 });
      if (path.startsWith('/sites/')) return { incidents: [{ started_at: iso(NOW - MIN), ended_at: null }] };
      throw new Error(`unexpected ${path}`);
    };
    const out = await loadDashboard(api, NOW);
    expect(seen.sort()).toEqual(['/heartbeats', '/me', '/sites', '/sites/a/incidents', '/sites/b/incidents', '/sites/c/incidents', '/status-page']);
    expect(out.historyError).toBe(true);
    expect(out.incidentsBySite.a).toHaveLength(1);
    const unauth = async (path) => {
      if (path.endsWith('/incidents')) throw Object.assign(new Error('no'), { status: 401 });
      return api(path);
    };
    await expect(loadDashboard(unauth, NOW)).rejects.toMatchObject({ status: 401 });
  });
});

describe('dashboard url state and motion', () => {
  test('range and check filter live in the URL and bad values are ignored', () => {
    expect(readUrlState('?range=7d&check=a')).toEqual({ range: '7d', check: 'a' });
    expect(readUrlState('?range=2y')).toEqual({ range: '24h', check: null });
    expect(writeUrlState('', { range: '7d', check: 'a' })).toBe('?range=7d&check=a');
    expect(writeUrlState('?range=7d&check=a', { range: '24h', check: null })).toBe('');
  });

  test('reduced motion turns off the refresh spinner, shimmer and transitions', () => {
    expect(prefersReducedMotion({ matchMedia: () => ({ matches: true }) })).toBe(true);
    expect(prefersReducedMotion({ matchMedia: () => ({ matches: false }) })).toBe(false);
    expect(prefersReducedMotion({})).toBe(false);
    expect(spinnerMs(true)).toBe(0);
    expect(spinnerMs(false)).toBeGreaterThan(0);
    expect(refreshClass(true, true)).toBe('iconbtn');
    expect(refreshClass(true, false)).toBe('iconbtn spin');
    expect(refreshClass(false, false)).toBe('iconbtn');
    const css = readFileSync(new URL('../web/src/dashboard/dashboard.css', import.meta.url), 'utf8');
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion:reduce)'));
    expect(block).toMatch(/animation:none!important/);
    expect(block).toMatch(/transition:none!important/);
  });
});
