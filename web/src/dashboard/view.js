// Turns API data plus the selected range and check into what the overview
// shows. Pure, so the range and state rules are unit tested.
import {
  RANGES,
  aggregateUptime,
  buildEvents,
  currentCounts,
  deltaPts,
  fmtAgo,
  fmtDur,
  fmtFull,
  fmtPct,
  fmtPrevEnd,
  fmtShort,
  openIncidents,
  rangeWindow,
  siteBuckets,
  siteUptime,
  statusKind,
} from './derive.js';

export const NO_PLAN_TIER = 'no_plan';

export const STATUS_LABEL = {
  up: 'Up', degraded: 'Degraded', down: 'Down', pending: 'Pending', paused: 'Paused', info: 'Info',
};

function intervalText(seconds) {
  if (!seconds) return '';
  if (seconds % 3600 === 0) return `every ${seconds / 3600}h`;
  if (seconds % 60 === 0) return `every ${seconds / 60}m`;
  return `every ${seconds}s`;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

const DASH = '—';

function blankTiles(range, why) {
  const R = RANGES[range];
  return [
    { key: 'up', title: 'Checks up', win: 'now', val: DASH, aria: `Checks up, now: ${why}` },
    { key: 'cur', title: 'Uptime', win: range, val: DASH, aria: `Uptime over the ${R.label}: ${why}` },
    { key: 'prev', title: 'Uptime', win: `prev ${range}`, val: DASH, aria: `Uptime in the previous ${R.words}: ${why}` },
    { key: 'rt', title: 'Avg response', win: range, val: DASH, sub: 'not shown yet', aria: 'Average response time: not shown yet' },
    { key: 'inc', title: 'Open incidents', win: 'now', val: DASH, aria: `Open incidents, now: ${why}` },
  ].map((t) => ({ ...t, blank: true }));
}

export function buildView(data, range, check, now) {
  const R = RANGES[range];
  const w = rangeWindow(range, now);
  const me = data.me || null;
  const noPlan = me?.tier === NO_PLAN_TIER;
  const canAdd = Boolean(me) && !noPlan;
  const base = { range, rangeLabel: R.label, noPlan, canAdd, window: w };

  if (data.coreError) {
    return {
      ...base,
      state: 'error',
      tiles: blankTiles(range, 'no data'),
      events: { state: 'error', list: [] },
      timeline: { state: 'error', rows: [] },
      chart: { state: 'error' },
    };
  }
  if (!data.loaded) {
    return {
      ...base,
      state: 'loading',
      tiles: [],
      events: { state: 'loading', list: [] },
      timeline: { state: 'loading', rows: [] },
      chart: { state: 'loading' },
    };
  }

  const sites = data.sites || [];
  const heartbeats = data.heartbeats || [];
  const inc = data.incidentsBySite || {};
  const total = sites.length + heartbeats.length;

  if (!total) {
    return {
      ...base,
      state: noPlan ? 'noplan' : 'empty',
      tiles: blankTiles(range, 'no checks yet'),
      events: { state: 'empty', list: [] },
      timeline: { state: 'empty', rows: [] },
      chart: { state: 'unavailable' },
    };
  }

  const checkId = check && sites.some((s) => s.id === check) ? check : null;
  const histOk = !data.historyError;
  const tiles = [];

  const counts = currentCounts(sites, heartbeats);
  tiles.push({
    key: 'up', title: 'Checks up', win: 'now', val: String(counts.up), unit: `/${counts.total}`,
    badges: { down: counts.down, degraded: counts.degraded },
    aria: `Checks up, now: ${counts.up} of ${counts.total} checks up, ${counts.down} down, ${counts.degraded} degraded`,
  });

  const cur = histOk ? aggregateUptime(sites, inc, w.from, w.to, now) : null;
  const prev = histOk ? aggregateUptime(sites, inc, w.prevFrom, w.prevTo, now) : null;
  const why = histOk ? 'no website check data in this window' : 'history could not be loaded';
  const downWords = (d) => (d ? `${fmtDur(d)} down` : 'no downtime');
  const downShort = (d) => (d ? `${fmtShort(d)} down` : 'no downtime');

  if (cur) {
    const delta = prev ? deltaPts(cur.pct, prev.pct) : { text: 'no previous data', words: 'no data for the previous period' };
    const part = cur.partial ? ' · partial' : '';
    tiles.push({
      key: 'cur', title: 'Uptime', win: range, val: fmtPct(cur.pct), unit: '%',
      sub: `${delta.text} · ${downShort(cur.downMs)}${part}`,
      tip: cur.partial ? 'Based on the latest 50 incidents per check; older downtime may be missing.' : delta.words,
      aria: `Uptime over the ${R.label}: ${fmtPct(cur.pct)} percent, ${delta.words}, ${downWords(cur.downMs)} in total${cur.partial ? ', based on the latest 50 incidents per check' : ''}`,
    });
  } else {
    tiles.push({ key: 'cur', title: 'Uptime', win: range, val: DASH, blank: true, sub: histOk ? 'no data yet' : 'history unavailable', aria: `Uptime over the ${R.label}: ${why}` });
  }

  const prevWin = `${fmtFull(w.prevFrom)} to ${fmtFull(w.prevTo)}`;
  if (prev) {
    tiles.push({
      key: 'prev', title: 'Uptime', win: `prev ${range}`, val: fmtPct(prev.pct), unit: '%',
      sub: `to ${fmtPrevEnd(w.prevTo, range)} · ${downShort(prev.downMs)}${prev.partial ? ' · partial' : ''}`,
      tip: prevWin,
      aria: `Uptime in the previous ${R.words}, ${prevWin}: ${fmtPct(prev.pct)} percent, ${downWords(prev.downMs)}`,
    });
  } else {
    tiles.push({ key: 'prev', title: 'Uptime', win: `prev ${range}`, val: DASH, blank: true, sub: histOk ? 'no data for this window' : 'history unavailable', tip: prevWin, aria: `Uptime in the previous ${R.words}, ${prevWin}: ${why}` });
  }

  tiles.push({ key: 'rt', title: 'Avg response', win: range, val: DASH, blank: true, sub: 'not shown yet', aria: 'Average response time: not shown yet' });

  if (histOk) {
    const open = openIncidents(sites, inc, heartbeats, now);
    const first = open[0];
    tiles.push({
      key: 'inc', title: 'Open incidents', win: 'now', val: String(open.length), hot: open.length > 0,
      sub: first ? `${first.name}${first.durMs != null ? ` · ${fmtDur(first.durMs)}` : ' · down now'}` : 'all clear',
      aria: `Open incidents, now: ${open.length}${first ? `, longest ${first.name}${first.durMs != null ? ` for ${fmtDur(first.durMs)}` : ''}` : ''}`,
    });
  } else {
    tiles.push({ key: 'inc', title: 'Open incidents', win: 'now', val: DASH, blank: true, sub: 'history unavailable', aria: 'Open incidents, now: history could not be loaded' });
  }

  const rows = [];
  for (const site of sites) {
    const list = inc[site.id] || [];
    const now1 = statusKind(site.current_status);
    const buckets = histOk ? siteBuckets(site, list, range, now) : [];
    const u = histOk ? siteUptime(site, list, w.from, w.to, now) : null;
    const bad = buckets.filter((b) => b.status === 'down').length;
    const kind = `${hostOf(site.url) || 'Website'} · ${intervalText(site.interval_seconds)}`;
    const upTxt = u ? `${fmtPct(u.pct)}%` : DASH;
    rows.push({
      id: site.id, name: site.name, host: hostOf(site.url), kind, status: now1, buckets, uptime: upTxt,
      selectable: true, pressed: checkId === site.id, history: histOk,
      aria: `${site.name}, website check ${intervalText(site.interval_seconds)}. Currently ${STATUS_LABEL[now1].toLowerCase()}. ${u ? `${fmtPct(u.pct)} percent uptime over the ${R.label}. ${bad} of ${buckets.length} intervals not fully up.` : histOk ? 'No data in this window yet.' : 'History could not be loaded.'}`,
    });
  }
  for (const hb of heartbeats) {
    const now1 = statusKind(hb.status);
    const every = hb.period_seconds ? intervalText(hb.period_seconds) : hb.cron_expr || '';
    rows.push({
      id: hb.id, name: hb.name, host: '', kind: `Heartbeat · ${every}`, status: now1, buckets: [], uptime: DASH,
      selectable: false, pressed: false, history: false,
      aria: `${hb.name}, heartbeat check ${every}. Currently ${STATUS_LABEL[now1].toLowerCase()}. History is not shown for heartbeat checks.`,
    });
  }

  const selected = checkId ? sites.find((s) => s.id === checkId) : null;
  const events = histOk ? buildEvents(sites, inc, range, now, checkId) : [];
  return {
    ...base,
    state: 'ok',
    check: checkId,
    checkName: selected ? selected.name : '',
    tiles,
    timeline: { state: histOk ? 'ok' : 'error', rows, from: w.from },
    events: histOk
      ? {
          state: 'ok',
          list: events.slice(0, 200).map((e) => ({ ...e, ago: fmtAgo(e.at, now) })),
          meta: `${events.length} in ${R.words}`,
          emptyText: `${selected ? `${selected.name} was` : 'All checks were'} up the whole time in the ${R.label}.`,
        }
      : { state: 'error', list: [] },
    chart: { state: 'unavailable' },
  };
}
