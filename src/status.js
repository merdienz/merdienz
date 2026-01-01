const BAR_DAYS = 90;

export function dayKeys(days, now = new Date()) {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const keys = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    keys.push(new Date(end - i * 86400000).toISOString().slice(0, 10));
  }
  return keys;
}

function overallFrom(checks) {
  if (!checks.length) return 'unknown';
  if (checks.some((c) => c.status === 'down')) return 'down';
  if (checks.some((c) => c.status === 'late' || c.status === 'unconfirmed' || c.status === 'degraded')) {
    return 'degraded';
  }
  if (checks.every((c) => c.status === 'unknown' || c.status === 'new' || c.status === 'paused')) {
    return 'unknown';
  }
  return 'up';
}

function averageUptime(bars) {
  const numbered = bars.filter((b) => typeof b.uptime === 'number');
  if (!numbered.length) return null;
  const sum = numbered.reduce((acc, b) => acc + b.uptime, 0);
  return Math.round((sum / numbered.length) * 10000) / 10000;
}

function presentIncident(row) {
  return {
    started_at: row.started_at,
    ended_at: row.ended_at,
    status: row.status,
  };
}

async function siteBars(db, site, days, now) {
  const keys = dayKeys(days, now);
  const since = new Date(keys[0] + 'T00:00:00.000Z');
  const { rows } = await db.query(
    `SELECT (checked_at AT TIME ZONE 'UTC')::date::text AS day,
            count(*) FILTER (WHERE status IN ('up', 'unconfirmed'))::int AS up_n,
            count(*)::int AS n
       FROM check_results
      WHERE site_id = $1 AND checked_at >= $2
      GROUP BY 1`,
    [site.id, since]
  );
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return keys.map((date) => {
    const row = byDay.get(date);
    if (!row || row.n === 0) return { date, uptime: null };
    return { date, uptime: Math.round((row.up_n / row.n) * 10000) / 10000 };
  });
}

function heartbeatBars(check, incidents, days, now) {
  const keys = dayKeys(days, now);
  const created = new Date(check.created_at);
  const trackingStart = check.last_ping_at ? new Date(check.created_at) : null;
  return keys.map((date) => {
    const start = new Date(`${date}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 86400000);
    if (!trackingStart || end <= created) return { date, uptime: null };
    const windowStart = new Date(Math.max(start.getTime(), created.getTime()));
    const windowEnd = new Date(Math.min(end.getTime(), now.getTime()));
    const windowMs = windowEnd - windowStart;
    if (windowMs <= 0) return { date, uptime: null };
    let downMs = 0;
    for (const inc of incidents) {
      const a = new Date(inc.started_at);
      const b = inc.ended_at ? new Date(inc.ended_at) : now;
      const overlap = Math.min(windowEnd.getTime(), b.getTime()) - Math.max(windowStart.getTime(), a.getTime());
      if (overlap > 0) downMs += overlap;
    }
    const uptime = Math.max(0, Math.min(1, 1 - downMs / windowMs));
    return { date, uptime: Math.round(uptime * 10000) / 10000 };
  });
}

export async function getPublicStatus(db, slug, { days = BAR_DAYS, now = new Date() } = {}) {
  const normalized = String(slug || '').trim().toLowerCase();
  const pageRes = await db.query('SELECT slug, title, user_id FROM status_pages WHERE slug = $1', [normalized]);
  const page = pageRes.rows[0];
  if (!page) return null;

  const sites = await db.query(
    `SELECT id, name, current_status, created_at
       FROM sites
      WHERE user_id = $1 AND public_on_status = true
      ORDER BY created_at ASC`,
    [page.user_id]
  );
  const heartbeats = await db.query(
    `SELECT id, name, status, created_at, last_ping_at
       FROM heartbeat_checks
      WHERE user_id = $1 AND public_on_status = true
      ORDER BY created_at ASC`,
    [page.user_id]
  );

  const checks = [];
  for (const site of sites.rows) {
    const bars = await siteBars(db, site, days, now);
    const incidents = await db.query(
      `SELECT started_at, ended_at, status
         FROM incidents
        WHERE site_id = $1
        ORDER BY started_at DESC
        LIMIT 20`,
      [site.id]
    );
    checks.push({
      name: site.name,
      type: 'http',
      status: site.current_status,
      uptime_90d: averageUptime(bars),
      bars,
      incidents: incidents.rows.map(presentIncident),
    });
  }

  for (const check of heartbeats.rows) {
    const incidents = await db.query(
      `SELECT started_at, ended_at, status
         FROM heartbeat_incidents
        WHERE check_id = $1
        ORDER BY started_at DESC
        LIMIT 20`,
      [check.id]
    );
    const bars = heartbeatBars(check, incidents.rows, days, now);
    checks.push({
      name: check.name,
      type: 'heartbeat',
      status: check.status,
      uptime_90d: averageUptime(bars),
      bars,
      incidents: incidents.rows.map(presentIncident),
    });
  }

  return {
    slug: page.slug,
    title: page.title,
    generated_at: now.toISOString(),
    overall: overallFrom(checks),
    checks,
  };
}

export function assertSlug(slug) {
  const value = String(slug || '').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/.test(value)) {
    const err = new Error('slug must be 3-64 lowercase letters, numbers, or hyphens');
    err.statusCode = 400;
    err.code = 'BAD_SLUG';
    throw err;
  }
  const reserved = new Set([
    'health', 'sites', 'auth', 'me', 'internal', 'ping', 'heartbeats',
    'status', 'status-page', 'api', 'login', 'assets',
  ]);
  if (reserved.has(value)) {
    const err = new Error('slug is reserved');
    err.statusCode = 400;
    err.code = 'BAD_SLUG';
    throw err;
  }
  return value;
}

