// Pure helpers for the uptime overview. Everything here is derived from the
// existing API (/me, /sites, /sites/:id/incidents, /heartbeats). No new data
// sources: response times are not exposed by the API, so they are not shown.

export const MIN = 60e3;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

// The API returns at most this many incidents per site (newest first).
export const INCIDENT_LIMIT = 50;

export const RANGES = {
  '1h': { span: HOUR, n: 60, label: 'last 1 hour', words: '1 hour', tick: 15 * MIN },
  '6h': { span: 6 * HOUR, n: 72, label: 'last 6 hours', words: '6 hours', tick: HOUR },
  '24h': { span: DAY, n: 96, label: 'last 24 hours', words: '24 hours', tick: 6 * HOUR },
  '7d': { span: 7 * DAY, n: 84, label: 'last 7 days', words: '7 days', tick: DAY },
  '30d': { span: 30 * DAY, n: 90, label: 'last 30 days', words: '30 days', tick: 7 * DAY },
};
export const RANGE_KEYS = Object.keys(RANGES);
export const DEFAULT_RANGE = '24h';

export function isRange(value) {
  return Object.prototype.hasOwnProperty.call(RANGES, value);
}

// current = [now - span, now); previous = [now - 2*span, now - span)
export function rangeWindow(range, now) {
  const R = RANGES[range] || RANGES[DEFAULT_RANGE];
  const to = now;
  const from = now - R.span;
  return { from, to, prevFrom: from - R.span, prevTo: from, step: R.span / R.n, n: R.n };
}

function ms(value) {
  if (value == null || value === '') return null;
  const t = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

export function normalizeIncidents(rows) {
  return (rows || [])
    .map((r) => ({ start: ms(r.started_at), end: ms(r.ended_at), id: r.id }))
    .filter((r) => r.start != null)
    .sort((a, b) => b.start - a.start);
}

// Overlap in ms between [a, b) and [lo, hi).
function overlap(a, b, lo, hi) {
  return Math.max(0, Math.min(b, hi) - Math.max(a, lo));
}

// Seconds of the window the site was observable: from its creation (or the
// window start) to the window end. A site that was never checked has none.
export function observedStart(site, from) {
  const created = ms(site.created_at);
  return Math.max(from, created == null ? from : created);
}

export function downtimeMs(incidents, lo, hi, now) {
  let down = 0;
  for (const inc of incidents) {
    const end = inc.end == null ? now : inc.end;
    down += overlap(inc.start, end, lo, hi);
  }
  return down;
}

// True when the incident list was cut at the API limit and may not reach
// back to the window start, so older downtime could be missing.
export function isPartial(incidents, from) {
  if (incidents.length < INCIDENT_LIMIT) return false;
  const oldest = incidents[incidents.length - 1];
  return oldest.start > from;
}

export function siteUptime(site, incidents, from, to, now) {
  if (!site.last_checked_at) return null;
  const lo = observedStart(site, from);
  if (lo >= to) return null;
  const down = downtimeMs(incidents, lo, to, now);
  const pct = 100 * (1 - down / (to - lo));
  return { pct: Math.max(0, Math.min(100, pct)), downMs: down, partial: isPartial(incidents, from) };
}

// Mean uptime across sites with data in the window; degraded counts as up
// because incidents are only opened for confirmed downtime.
export function aggregateUptime(sites, incidentsBySite, from, to, now) {
  const per = [];
  for (const site of sites) {
    const u = siteUptime(site, incidentsBySite[site.id] || [], from, to, now);
    if (u) per.push(u);
  }
  if (!per.length) return null;
  return {
    pct: per.reduce((a, u) => a + u.pct, 0) / per.length,
    downMs: per.reduce((a, u) => a + u.downMs, 0),
    partial: per.some((u) => u.partial),
    count: per.length,
  };
}

// Worst status per bucket: 'none' before the site existed or before its
// first check, 'down' when any incident overlaps, otherwise 'up'.
export function siteBuckets(site, incidents, range, now) {
  const w = rangeWindow(range, now);
  const created = ms(site.created_at);
  const out = [];
  for (let k = 0; k < w.n; k += 1) {
    const t0 = w.from + k * w.step;
    const t1 = t0 + w.step;
    let status = 'up';
    if (!site.last_checked_at || (created != null && t1 <= created)) status = 'none';
    else if (downtimeMs(incidents, t0, t1, now) > 0) status = 'down';
    out.push({ t0, t1, status });
  }
  return out;
}

export function statusKind(raw) {
  if (raw === 'up') return 'up';
  if (raw === 'down') return 'down';
  if (raw === 'unconfirmed' || raw === 'late' || raw === 'degraded') return 'degraded';
  if (raw === 'paused') return 'paused';
  return 'pending';
}

export function currentCounts(sites, heartbeats) {
  const all = [...sites.map((s) => statusKind(s.current_status)), ...heartbeats.map((h) => statusKind(h.status))];
  return {
    total: all.length,
    up: all.filter((s) => s === 'up').length,
    down: all.filter((s) => s === 'down').length,
    degraded: all.filter((s) => s === 'degraded').length,
  };
}

export function openIncidents(sites, incidentsBySite, heartbeats, now) {
  const open = [];
  for (const site of sites) {
    for (const inc of incidentsBySite[site.id] || []) {
      if (inc.end == null) open.push({ checkId: site.id, name: site.name, start: inc.start, durMs: now - inc.start });
    }
  }
  open.sort((a, b) => a.start - b.start);
  for (const hb of heartbeats) {
    if (statusKind(hb.status) === 'down') open.push({ checkId: hb.id, name: hb.name, start: null, durMs: null });
  }
  return open;
}

export function buildEvents(sites, incidentsBySite, range, now, checkId = null) {
  const { from } = rangeWindow(range, now);
  const ev = [];
  for (const site of sites) {
    if (checkId && site.id !== checkId) continue;
    for (const inc of incidentsBySite[site.id] || []) {
      if (inc.start >= from && inc.start <= now) {
        ev.push({
          at: inc.start, checkId: site.id, name: site.name, kind: 'down', title: 'Check went down',
          detail: inc.end == null ? `Down for ${fmtDur(now - inc.start)} · ongoing` : 'Confirmed down',
        });
      }
      if (inc.end != null && inc.end >= from && inc.end <= now) {
        ev.push({
          at: inc.end, checkId: site.id, name: site.name, kind: 'up', title: 'Recovered',
          detail: `Down for ${fmtDur(inc.end - inc.start)}`,
        });
      }
    }
  }
  return ev.sort((a, b) => b.at - a.at);
}

/* ---------- formatting ---------- */

export const pad = (n) => String(n).padStart(2, '0');
export const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtHM(t) {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fmtDate(t) {
  const d = new Date(t);
  return `${d.getDate()} ${MON[d.getMonth()]}`;
}
export function fmtFull(t) {
  return `${fmtDate(t)} ${fmtHM(t)}`;
}
export function fmtAxis(t, range) {
  return range === '7d' || range === '30d' ? fmtDate(t) : fmtHM(t);
}
// End of the previous window: HH:MM for 1h/6h, date+time for 24h, date for 7d/30d.
export function fmtPrevEnd(t, range) {
  if (range === '1h' || range === '6h') return fmtHM(t);
  if (range === '24h') return fmtFull(t);
  return fmtDate(t);
}

export function fmtDur(d) {
  const m = Math.round(d / MIN);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h < 48) return `${h} h${r ? ` ${r} min` : ''}`;
  const days = Math.floor(h / 24);
  const hr = h % 24;
  return `${days} d${hr ? ` ${hr} h` : ''}`;
}
export function fmtShort(d) {
  const m = Math.round(d / MIN);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
}
export function fmtAgo(t, now) {
  const m = Math.round((now - t) / MIN);
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

// 2–3 decimals, trailing zeros trimmed; 100 only when it rounds to 100.
export function fmtPct(p) {
  if (p >= 99.9995) return '100';
  return p.toFixed(p >= 99.9 ? 3 : 2).replace(/0+$/, '').replace(/\.$/, '');
}

// Change in points worked out from the rounded values shown on screen.
export function deltaPts(cur, prev) {
  const d = parseFloat(fmtPct(cur)) - parseFloat(fmtPct(prev));
  const abs = Math.abs(d);
  if (abs < 0.0005) return { dir: 0, text: '= previous', words: 'same as the previous period' };
  const n = abs.toFixed(abs < 0.1 ? 3 : 2).replace(/0+$/, '').replace(/\.$/, '');
  return {
    dir: d > 0 ? 1 : -1,
    text: `${d > 0 ? '↑' : '↓'} ${n} pts`,
    words: `${d > 0 ? 'up' : 'down'} ${n} points on the previous period`,
  };
}

/* ---------- URL state ---------- */

export function readUrlState(search) {
  const q = new URLSearchParams(search || '');
  const range = isRange(q.get('range')) ? q.get('range') : DEFAULT_RANGE;
  const check = q.get('check') || null;
  return { range, check };
}

export function writeUrlState(search, { range, check }) {
  const q = new URLSearchParams(search || '');
  if (range && range !== DEFAULT_RANGE) q.set('range', range);
  else q.delete('range');
  if (check) q.set('check', check);
  else q.delete('check');
  const s = q.toString();
  return s ? `?${s}` : '';
}

/* ---------- motion ---------- */

export function prefersReducedMotion(win = typeof window !== 'undefined' ? window : undefined) {
  try {
    return Boolean(win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

// How long the refresh spinner shows. Zero under reduced motion: no spin.
export function spinnerMs(reduced) {
  return reduced ? 0 : 600;
}
