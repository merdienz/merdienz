import { insertOutbox } from '../alerts/outbox.js';

// Basic on-page SEO checks. HTML is untrusted input: it is only scanned with bounded
// regular expressions over a capped body, never executed, rendered, or stored whole.
export const SEO_ISSUES = Object.freeze({
  title_missing: 'Page has no <title>',
  description_missing: 'Page has no meta description',
  h1_missing: 'Page has no <h1>',
  noindex: 'Page asks search engines not to index it (noindex)',
  robots_blocks_all: 'robots.txt blocks all crawlers from the whole site',
});
const MAX_SCAN = 512 * 1024;

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/(?<![-a-zA-Z0-9_:.])([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

// The page is attacker-controlled, so every scan below is linear in the input: plain indexOf
// walks, no backtracking patterns over the whole body (a 512 KB page of unclosed tags used to
// stall the event loop for tens of seconds).
function isTagBoundary(code) {
  return code === 62 || code === 47 || code === 32 || (code >= 9 && code <= 13);
}

// Drops comments and script/style/noscript/template bodies. An unterminated one drops the rest.
function stripHidden(src) {
  const low = src.toLowerCase();
  const open = /<!--|<(script|style|noscript|template)(?=[\s/>])/g;
  let out = '';
  let i = 0;
  while (i < src.length) {
    open.lastIndex = i;
    const m = open.exec(low);
    if (!m) {
      out += src.slice(i);
      break;
    }
    out += `${src.slice(i, m.index)} `;
    let end = -1;
    if (m[0] === '<!--') {
      const e = low.indexOf('-->', m.index + 4);
      if (e >= 0) end = e + 3;
    } else {
      const e = low.indexOf(`</${m[1]}`, m.index + m[0].length);
      if (e >= 0) {
        const gt = low.indexOf('>', e);
        if (gt >= 0) end = gt + 1;
      }
    }
    if (end < 0) break;
    i = end;
  }
  return out;
}

// Inner text of <tag ...>...</tag> elements whose inner part is at most maxInner characters.
function elementInners(src, low, tag, maxInner, max = Infinity) {
  const out = [];
  const open = `<${tag}`;
  const close = `</${tag}`;
  let i = 0;
  while (out.length < max) {
    const s = low.indexOf(open, i);
    if (s < 0) break;
    i = s + open.length;
    if (!isTagBoundary(low.charCodeAt(i))) continue;
    const gt = low.indexOf('>', i);
    if (gt < 0) break;
    const c = low.indexOf(close, gt + 1);
    if (c < 0) break;
    if (c - (gt + 1) <= maxInner) out.push(src.slice(gt + 1, c));
    i = c + close.length;
  }
  return out;
}

// Opening <meta ...> tags of at most maxLen characters, at most maxTags of them. The scan always
// resumes after the '>' that closed the previous opener, so no part of the page is read twice.
export const MAX_META_TAGS = 256;
function metaTags(low, src, maxLen = 2000, maxTags = MAX_META_TAGS) {
  const out = [];
  let i = 0;
  while (out.length < maxTags) {
    const s = low.indexOf('<meta', i);
    if (s < 0) break;
    i = s + 5;
    if (!isTagBoundary(low.charCodeAt(i))) continue;
    const gt = low.indexOf('>', i);
    if (gt < 0) break;
    if (gt - s <= maxLen) out.push(src.slice(s, gt + 1));
    i = gt + 1;
  }
  return out;
}

export function analyzeHtml(html, headers = {}) {
  const src = stripHidden(String(html || '').slice(0, MAX_SCAN));
  const low = src.toLowerCase();
  const titleInner = elementInners(src, low, 'title', 2000, 1)[0];
  const title = titleInner !== undefined ? decodeEntities(titleInner.replace(/<[^<>]*>/g, '')) : '';
  let description = '';
  let robotsMeta = '';
  for (const tag of metaTags(low, src)) {
    const a = attrs(tag);
    const name = String(a.name || '').toLowerCase();
    if (name === 'description' && !description) description = decodeEntities(a.content || '');
    if (name === 'robots' || name === 'googlebot') robotsMeta += ` ${String(a.content || '').toLowerCase()}`;
  }
  let h1Count = 0;
  for (const inner of elementInners(src, low, 'h1', 5000)) {
    if (decodeEntities(inner.replace(/<[^<>]*>/g, ''))) h1Count += 1;
  }
  const headerRobots = [].concat(headers['x-robots-tag'] || []).join(',').toLowerCase();
  const noindex = /\b(noindex|none)\b/.test(robotsMeta) || /\b(noindex|none)\b/.test(headerRobots);
  const issues = [];
  if (!title) issues.push('title_missing');
  if (!description) issues.push('description_missing');
  if (!h1Count) issues.push('h1_missing');
  if (noindex) issues.push('noindex');
  return {
    title: title.slice(0, 200),
    description_length: description.length,
    h1_count: h1Count,
    noindex,
    issues,
  };
}

// True when the group that applies to all crawlers (User-agent: *) disallows "/" and does not
// allow anything back.
export function robotsBlocksAll(text) {
  const lines = String(text || '').slice(0, MAX_SCAN).split(/\r?\n/);
  let agents = [];
  let inRules = false;
  let starDisallowAll = false;
  let starAllows = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'user-agent') {
      if (inRules) {
        agents = [];
        inRules = false;
      }
      agents.push(value.toLowerCase());
      continue;
    }
    if (field !== 'allow' && field !== 'disallow') continue;
    inRules = true;
    if (!agents.includes('*')) continue;
    if (field === 'disallow' && value === '/') starDisallowAll = true;
    if (field === 'allow' && value !== '') starAllows = true;
  }
  return starDisallowAll && !starAllows;
}

async function get(fetchFn, url, timeoutMs, accept) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetchFn(url, { method: 'GET', redirect: 'follow', maxRedirects: 3, signal: ac.signal, headers: { accept } });
  } finally {
    clearTimeout(timer);
  }
}

export async function runSeoCheck(url, { fetchFn, timeoutMs = 10000 } = {}) {
  const page = await get(fetchFn, url, timeoutMs, 'text/html,application/xhtml+xml');
  if (page.status < 200 || page.status >= 300) return { error: `status ${page.status}` };
  const type = String([].concat(page.headers?.['content-type'] || '')[0]).toLowerCase();
  if (type && !type.includes('html')) return { error: 'not_html' };
  const html = Buffer.isBuffer(page.body) ? page.body.toString('utf8') : String(page.body || '');
  const result = analyzeHtml(html, page.headers || {});
  let robots = { checked: false, blocks_all: false };
  try {
    const res = await get(fetchFn, new URL('/robots.txt', url).toString(), timeoutMs, 'text/plain');
    if (res.status >= 200 && res.status < 300) {
      const text = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body || '');
      robots = { checked: true, blocks_all: robotsBlocksAll(text) };
    } else {
      robots = { checked: true, blocks_all: false };
    }
  } catch {
    robots = { checked: false, blocks_all: false };
  }
  if (robots.blocks_all) result.issues.push('robots_blocks_all');
  return { ...result, robots };
}

// Stores the result. An alert is queued only for a regression: an issue that was not present on
// the previous successful check. The first check is a silent baseline. Failed fetches keep the
// previous issue set so a flaky page does not re-alert.
export async function recordSeoResult(db, site, result, { now = new Date() } = {}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const prev = await client.query(
      `SELECT seo_issues, seo_result FROM site_insights WHERE site_id = $1 FOR UPDATE`,
      [site.id]
    );
    const before = prev.rows[0];
    const last = before && before.seo_result;
    const hadBaseline = Boolean(last && (!last.error || last.had_baseline === true));
    const prevIssues = before ? before.seo_issues || [] : [];
    const issues = result.error ? prevIssues : result.issues;
    await client.query(
      `INSERT INTO site_insights (site_id, seo_checked_at, seo_result, seo_issues, updated_at)
       VALUES ($1, $2, $3, $4, $2)
       ON CONFLICT (site_id) DO UPDATE SET
         seo_checked_at = excluded.seo_checked_at,
         seo_result = excluded.seo_result,
         seo_issues = excluded.seo_issues,
         updated_at = excluded.updated_at`,
      [site.id, now, JSON.stringify(result.error ? { ...result, had_baseline: hadBaseline } : result), issues]
    );
    const added = result.error ? [] : issues.filter((i) => !prevIssues.includes(i));
    let outbox = null;
    if (hadBaseline && added.length && site.user_email) {
      outbox = await insertOutbox(client, {
        kind: 'seo_regression',
        to: site.user_email,
        subject: `SEO: ${site.name} has ${added.length} new issue${added.length === 1 ? '' : 's'}`,
        text: `New SEO issues on ${site.name} (${site.url}):\n${added.map((i) => `- ${SEO_ISSUES[i] || i}`).join('\n')}`,
      });
    }
    await client.query('COMMIT');
    return { added, outbox };
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
