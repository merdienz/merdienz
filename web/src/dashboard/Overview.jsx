import { useCallback, useEffect, useRef, useState } from 'react';
import { api, setToken } from '../api.js';
import { RANGE_KEYS, fmtDate, fmtFull, fmtHM, pad, prefersReducedMotion, readUrlState, spinnerMs, writeUrlState } from './derive.js';
import { loadDashboard } from './load.js';
import { STATUS_LABEL, buildView } from './view.js';
import Manage from './Manage.jsx';
import logoSvg from './logo.svg?raw';
import './dashboard.css';

const THEME_KEY = 'merdienz.theme';
const REFRESH_MS = 60000;
const RETRY_MS = 30000;

export function Glyph({ kind }) {
  if (kind === 'up') {
    return <svg className="g" viewBox="0 0 10 10" aria-hidden="true"><circle className="f-up" cx="5" cy="5" r="4.2" /></svg>;
  }
  if (kind === 'degraded') {
    return <svg className="g" viewBox="0 0 10 10" aria-hidden="true"><path className="f-degraded" d="M5 .6 9.6 9.2H.4z" /></svg>;
  }
  if (kind === 'down') {
    return (
      <svg className="g" viewBox="0 0 10 10" aria-hidden="true">
        <rect className="f-down" x=".8" y=".8" width="8.4" height="8.4" rx="1" />
        <path className="x" d="M3 3l4 4M7 3 3 7" />
      </svg>
    );
  }
  return <svg className="g" viewBox="0 0 10 10" aria-hidden="true"><circle className="f-info" cx="5" cy="5" r="3.6" /></svg>;
}

function StatusBadge({ status }) {
  return (
    <span className={`st ${status}`}>
      <Glyph kind={status} />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Kpis({ view }) {
  if (view.state === 'loading') {
    return (
      <section className="kpis" aria-label="Key figures" aria-busy="true">
        {[0, 1, 2, 3, 4].map((i) => <div key={i} className="kpi sk" aria-hidden="true" />)}
      </section>
    );
  }
  return (
    <section className="kpis" aria-label="Key figures">
      {view.tiles.map((t, i) => (
        <article
          key={t.key}
          className={`kpi k${i + 1}${t.blank ? ' blank' : ''}${t.hot ? ' hot' : ''}`}
          aria-label={`${t.title} (${t.win}): ${t.aria}`}
          title={t.tip || undefined}
          data-tile={t.key}
        >
          <h3 aria-hidden="true">
            {t.title}
            <span className="win">{t.win}</span>
          </h3>
          <div className="val" aria-hidden="true">
            {t.val}
            {t.unit ? <small>{t.unit}</small> : null}
          </div>
          <div className="sub" aria-hidden="true">
            {t.badges ? (
              <>
                <span className="badge"><Glyph kind="down" /> {t.badges.down} down</span>
                <span className="badge"><Glyph kind="degraded" /> {t.badges.degraded} degraded</span>
              </>
            ) : (
              t.sub || ''
            )}
          </div>
        </article>
      ))}
    </section>
  );
}

function PanelState({ title, text, children }) {
  return (
    <div className="state">
      <div>
        <h4>{title}</h4>
        {text ? <p>{text}</p> : null}
        {children ? <div className="actions">{children}</div> : null}
      </div>
    </div>
  );
}

export function ChartPanel({ view, onRetry }) {
  let body;
  if (view.chart.state === 'loading') body = <div className="sk sk-fill" aria-hidden="true" />;
  else if (view.chart.state === 'error') {
    body = (
      <PanelState title="Couldn't load this panel" text="We'll retry in 30 seconds.">
        <button className="btn ghost" type="button" onClick={onRetry}>Retry now</button>
      </PanelState>
    );
  } else {
    body = (
      <PanelState
        title="Response times aren't shown yet"
        text="This version shows uptime, incidents and events from your checks. Response-time history is not part of it."
      />
    );
  }
  return (
    <section className="panel col-8" aria-labelledby="rt-h">
      <div className="panel-h">
        <h2 id="rt-h">Response time</h2>
        <span className="meta">{view.rangeLabel}</span>
      </div>
      <div className="panel-b">
        <div className="chart" data-chart-state={view.chart.state} aria-busy={view.chart.state === 'loading' ? 'true' : undefined}>
          {body}
        </div>
      </div>
    </section>
  );
}

export function EventsPanel({ view, onClear, onRetry }) {
  const ev = view.events;
  const short = view.range === '1h' || view.range === '6h' || view.range === '24h';
  let items;
  if (ev.state === 'loading') {
    items = [0, 1, 2, 3, 4].map((i) => (
      <li key={i} className="full" aria-hidden="true"><div className="sk sk-log" /></li>
    ));
  } else if (ev.state === 'empty') {
    items = <li className="full"><PanelState title="Nothing yet" text="Outages and recoveries will appear here." /></li>;
  } else if (ev.state === 'error') {
    items = (
      <li className="full">
        <PanelState title="Couldn't load events" text="Retrying in 30 seconds.">
          <button className="btn ghost" type="button" onClick={onRetry}>Retry now</button>
        </PanelState>
      </li>
    );
  } else if (!ev.list.length) {
    items = <li className="full"><PanelState title="No events" text={ev.emptyText} /></li>;
  } else {
    items = ev.list.map((e) => (
      <li key={`${e.checkId}-${e.kind}-${e.at}`}>
        <time dateTime={new Date(e.at).toISOString()} title={fmtFull(e.at)}>{short ? fmtHM(e.at) : fmtDate(e.at)}</time>
        <Glyph kind={e.kind} />
        <span className="what">
          <span className="sr-only">{STATUS_LABEL[e.kind]}: </span>
          <b>{e.title}</b> <span className="chk">{e.name}</span>
          <p>{e.detail} · {e.ago}</p>
        </span>
      </li>
    ));
  }
  return (
    <section className="panel col-4" aria-labelledby="log-h">
      <div className="panel-h">
        <h2 id="log-h">Recent events</h2>
        <span className="meta">{ev.state === 'ok' ? ev.meta : ''}</span>
        <div className="right">
          <span className={`filter${view.checkName ? ' on' : ''}`}>
            <span>{view.checkName}</span>
            <button type="button" aria-label="Clear check filter" onClick={onClear}>
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.6" /></svg>
            </button>
          </span>
        </div>
      </div>
      <div className="panel-b">
        <ul className="log" aria-live="polite" aria-label="Recent events" aria-busy={ev.state === 'loading' ? 'true' : undefined}>
          {items}
        </ul>
      </div>
    </section>
  );
}

function Bar({ buckets }) {
  const n = buckets.length;
  const w = 100 / n;
  const gap = n > 70 ? 0.6 : 1;
  return (
    <svg className="tl-bar" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
      {buckets.map((b, k) => {
        const tall = b.status === 'down' || b.status === 'degraded';
        return (
          <rect key={k} className={`b-${b.status}`} x={(k * w).toFixed(3)} y={tall ? 0 : 5} width={(w - (gap * w) / 3).toFixed(3)} height={tall ? 28 : 18} rx=".6">
            <title>{`${fmtFull(b.t0)} · ${b.status === 'none' ? 'no data' : STATUS_LABEL[b.status]}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

export function Timeline({ view, onToggle, onAdd, onRetry }) {
  const tl = view.timeline;
  let body;
  if (tl.state === 'loading') {
    body = <div aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="sk sk-row" aria-hidden="true" />)}</div>;
  } else if (tl.state === 'empty') {
    body = view.noPlan ? (
      <PanelState title="No checks yet" text="Adding checks needs an active plan, and this account doesn't have one yet." />
    ) : (
      <PanelState title="No checks yet" text="Add a website or heartbeat check to start monitoring.">
        <button className="btn" type="button" onClick={onAdd}>Add your first check</button>
      </PanelState>
    );
  } else if (tl.state === 'error' && !tl.rows.length) {
    body = (
      <PanelState title="Couldn't load checks" text="Your checks are still running; only this view failed to load.">
        <button className="btn ghost" type="button" onClick={onRetry}>Retry now</button>
      </PanelState>
    );
  } else {
    body = (
      <>
        <ul className="tl">
          {tl.rows.map((r) => {
            const inner = (
              <>
                <span className="tl-name"><b>{r.name}</b><span>{r.kind}</span></span>
                <StatusBadge status={r.status} />
                {r.history && r.buckets.length ? (
                  <Bar buckets={r.buckets} />
                ) : (
                  <span className="tl-nohist">{r.selectable ? 'History unavailable' : 'No history for heartbeat checks'}</span>
                )}
                <span className="tl-up">{r.uptime}</span>
              </>
            );
            return (
              <li key={r.id}>
                {r.selectable ? (
                  <button type="button" className="tl-row" data-check={r.id} aria-pressed={r.pressed ? 'true' : 'false'} aria-label={`${r.aria} Activate to filter events.`} onClick={() => onToggle(r.id)}>
                    {inner}
                  </button>
                ) : (
                  <div className="tl-row static" role="group" aria-label={r.aria}>{inner}</div>
                )}
              </li>
            );
          })}
        </ul>
        {tl.state === 'error' ? <p className="note">History couldn't be loaded; showing current status only. Retrying in 30 seconds.</p> : null}
        <div className="tl-axis" aria-hidden="true">
          <span />
          <span />
          <span className="ends"><span>{tl.from ? fmtFull(tl.from) : ''}</span><span>now</span></span>
          <span className="tl-up">uptime</span>
        </div>
      </>
    );
  }
  return (
    <section className="panel col-12" aria-labelledby="tl-h">
      <div className="panel-h">
        <h2 id="tl-h">Checks</h2>
        <span className="meta">select a check to filter events</span>
        <div className="right tl-legend" aria-hidden="true">
          <span><Glyph kind="up" />up</span>
          <span><Glyph kind="degraded" />degraded</span>
          <span><Glyph kind="down" />down</span>
        </div>
      </div>
      <div className="panel-b">{body}</div>
    </section>
  );
}

export function refreshClass(busy, reduced) {
  return busy && !reduced ? 'iconbtn spin' : 'iconbtn';
}

const SUN = <><circle cx="8" cy="8" r="3" /><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1" /></>;
const MOON = <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z" />;

function systemDark() {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

function initialTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : null;
  } catch {
    return null;
  }
}

export default function Overview() {
  const initial = readUrlState(window.location.search);
  const [range, setRange] = useState(initial.range);
  const [check, setCheck] = useState(initial.check);
  const [data, setData] = useState({ loaded: false });
  const [coreError, setCoreError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [updated, setUpdated] = useState('');
  const [theme, setTheme] = useState(initialTheme);
  const timer = useRef(null);
  const reduced = prefersReducedMotion();

  useEffect(() => {
    const root = document.documentElement;
    if (theme) root.dataset.theme = theme;
    else delete root.dataset.theme;
  }, [theme]);

  const refresh = useCallback(async () => {
    clearTimeout(timer.current);
    setBusy(true);
    const started = Date.now();
    try {
      const next = await loadDashboard(api, Date.now());
      setData(next);
      setCoreError(false);
      const d = new Date();
      setUpdated(`updated ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`);
      timer.current = setTimeout(() => {
        if (document.visibilityState === 'visible') refresh();
      }, REFRESH_MS);
      if (next.historyError) {
        clearTimeout(timer.current);
        timer.current = setTimeout(refresh, RETRY_MS);
      }
    } catch (err) {
      if (err.status === 401) {
        setToken('');
        window.location.reload();
        return;
      }
      setCoreError(true);
      timer.current = setTimeout(refresh, RETRY_MS);
    } finally {
      const left = spinnerMs(reduced) - (Date.now() - started);
      if (left > 0) setTimeout(() => setBusy(false), left);
      else setBusy(false);
    }
  }, [reduced]);

  useEffect(() => {
    refresh();
    const onVis = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [refresh]);

  useEffect(() => {
    const next = writeUrlState(window.location.search, { range, check });
    if (next !== window.location.search) {
      window.history.replaceState(null, '', `${window.location.pathname}${next}${window.location.hash}`);
    }
  }, [range, check]);

  const now = data.fetchedAt || Date.now();
  const view = buildView({ ...data, coreError: coreError && !data.loaded }, range, check, now);
  const bannerError = coreError;

  function toggleTheme() {
    const cur = theme || (systemDark() ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* private mode: keep it for this page only */
    }
  }
  const dark = (theme || (systemDark() ? 'dark' : 'light')) === 'dark';

  function signOut() {
    setToken('');
    window.location.assign('/');
  }

  function focusAdd() {
    const el = document.getElementById('site-name');
    if (el) {
      el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
      el.focus({ preventScroll: true });
    }
  }

  return (
    <div className="mdz" data-dashboard="overview-v2">
      <a className="skip" href="#main">Skip to dashboard</a>
      <header className="topbar">
        <div className="topbar-in">
          <div className="crumb">
            <a href="/" aria-label="Merdienz home" dangerouslySetInnerHTML={{ __html: logoSvg }} />
            <span className="sep" aria-hidden="true" />
            <h1>Uptime overview</h1>
          </div>
          <div className="tools">
            <span className="who">{data.me?.email || ''}</span>
            <span className="updated" aria-live="polite">{updated}</span>
            <div className="seg" role="group" aria-label="Time range">
              {RANGE_KEYS.map((r) => (
                <button key={r} type="button" aria-pressed={range === r ? 'true' : 'false'} onClick={() => setRange(r)}>
                  {r}
                </button>
              ))}
            </div>
            <button type="button" className={refreshClass(busy, reduced)} aria-label="Refresh data" title="Refresh" onClick={refresh} disabled={busy}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
                <path d="M13.5 2.5v3h-3" />
              </svg>
            </button>
            <button type="button" className="iconbtn" aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'} title="Toggle theme" onClick={toggleTheme}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                {dark ? SUN : MOON}
              </svg>
            </button>
            <button type="button" className="btn ghost small" onClick={signOut}>Sign out</button>
          </div>
        </div>
      </header>

      <main id="main" className="dash-main" tabIndex={-1}>
        <div className="dash-grid">
          {bannerError ? (
            <div className="alert" role="alert">
              <Glyph kind="down" />
              <span><b>Couldn't reach the Merdienz API.</b> {data.loaded ? 'Showing the last data we had.' : 'Showing no data.'} Monitoring itself is not affected.</span>
              <button className="btn ghost" type="button" onClick={refresh}>Retry now</button>
            </div>
          ) : null}
          <div className="row-title">
            <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
            Status
          </div>
          <Kpis view={view} />
          <ChartPanel view={view} onRetry={refresh} />
          <EventsPanel view={view} onClear={() => setCheck(null)} onRetry={refresh} />
          <Timeline view={view} onToggle={(id) => setCheck((c) => (c === id ? null : id))} onAdd={focusAdd} onRetry={refresh} />
          {data.loaded ? <Manage data={data} noPlan={view.noPlan} reload={refresh} /> : null}
        </div>
      </main>
      <footer className="dash-foot">
        <span>Merdienz{data.me?.email ? ` · signed in as ${data.me.email}` : ''}</span>
      </footer>

      <svg className="mdz-defs" aria-hidden="true" focusable="false">
        <defs>
          <pattern id="mdz-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect className="hp-down-soft" width="5" height="5" />
            <rect className="hp-down" width="2" height="5" />
          </pattern>
        </defs>
      </svg>
    </div>
  );
}
