const SECRET_HEADERS = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-session-token',
  'x-probe-signature',
  'x-probe-nonce',
  'x-setup-token',
];

const REDACTED = '[Redacted]';
const UUID_SHAPE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32}';

export function safeDecodeUrl(url) {
  let cur = String(url || '');
  for (let i = 0; i < 8; i += 1) {
    try {
      const next = decodeURIComponent(cur.replace(/\+/g, '%20'));
      if (next === cur) break;
      cur = next;
    } catch {
      cur = cur.replace(/%[0-9a-fA-F]{2}/g, (m) => {
        try {
          return decodeURIComponent(m);
        } catch {
          return m;
        }
      });
      break;
    }
  }
  return cur;
}

export function normalizePathname(pathname) {
  const raw = String(pathname || '').replace(/;/g, '/');
  const leading = raw.startsWith('/') ? '/' : '';
  const trailing = raw.length > 1 && raw.endsWith('/') ? '/' : '';
  const parts = raw.split('/');
  const out = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  const joined = out.join('/');
  if (!joined) return leading || '';
  return `${leading}${joined}${leading && trailing ? '/' : ''}`;
}

function redactUuidsAfterPing(text) {
  const re = new RegExp(`(ping)(.*?)(${UUID_SHAPE})`, 'gi');
  return String(text || '').replace(re, (_m, _p, mid) => `ping${mid}<redacted>`);
}

function redactSecretQuery(query) {
  return String(query || '').replace(
    /([?&](?:token|api[_-]?key|secret|password|setup[_-]?token)=)[^&]*/gi,
    `$1${REDACTED}`
  );
}

export function redactBareUuidSegments(text) {
  const re = new RegExp(`(^|/)(${UUID_SHAPE})(?=/|\\?|#|$)`, 'gi');
  return String(text || '').replace(re, (_m, pre) => `${pre}<redacted>`);
}

/** Redact any UUID-shaped run bounded by non-hex characters, in path or query. */
export function redactUuidRuns(text) {
  const hyphenated = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const hexRun = /[0-9a-f]{32,}/gi;
  return String(text || '').replace(hyphenated, '<redacted>').replace(hexRun, '<redacted>');
}

export function redactUrl(url) {
  const decoded = safeDecodeUrl(url);
  const scheme = decoded.match(/^([a-z][a-z0-9+.-]*:)\/\//i);
  if (scheme) {
    try {
      const u = new URL(decoded);
      const path = redactUuidsAfterPing(normalizePathname(u.pathname));
      const search = redactUuidsAfterPing(redactSecretQuery(u.search));
      return redactUuidRuns(redactBareUuidSegments(`${u.protocol}//${u.host}${path}${search}${u.hash}`));
    } catch {
      // Fall through and treat as a request path.
    }
  }
  const qIndex = decoded.indexOf('?');
  const rawPath = qIndex === -1 ? decoded : decoded.slice(0, qIndex);
  const query = qIndex === -1 ? '' : decoded.slice(qIndex);
  const path = redactUuidsAfterPing(normalizePathname(rawPath));
  const redactedQuery = redactUuidsAfterPing(redactSecretQuery(query));
  return redactUuidRuns(redactBareUuidSegments(`${path}${redactedQuery}`));
}

export function redactNotFoundUrl(url) {
  return redactUuidRuns(redactBareUuidSegments(redactUrl(url)));
}

export function mentionsPingPath(text) {
  return /(?:^|[/?#&;=]|%2f)ping(?:[/?#;]|%2f|$)/i.test(String(text || ''));
}

export function redactLogText(text) {
  if (typeof text !== 'string' || !mentionsPingPath(text)) return text;
  return redactUrl(text);
}

export function redactHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SECRET_HEADERS.includes(String(key).toLowerCase()) ? REDACTED : value;
  }
  return out;
}

export function redactReq(req) {
  return {
    method: req.method,
    url: redactUrl(req.url || req.raw?.url || ''),
    host: req.host,
    remoteAddress: req.ip || req.socket?.remoteAddress,
    headers: redactHeaders(req.headers || {}),
  };
}

export function loggerOptions(config = {}, stream) {
  const opts = {
    level: config.logLevel || 'info',
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'req.headers["x-session-token"]',
        'req.headers["x-probe-signature"]',
        'req.headers["x-probe-nonce"]',
        'req.headers["x-setup-token"]',
        '*.password',
        '*.api_key',
        '*.apiKey',
        '*.token',
        '*.probeBSecret',
        '*.PROBE_B_SECRET',
        '*.PROBE_B_HMAC_SECRET',
        'err.config.probeBSecret',
      ],
      censor: REDACTED,
    },
    serializers: {
      req: redactReq,
    },
    hooks: {
      logMethod(args, method) {
        const out = args.map((arg) => {
          if (typeof arg === 'string') return redactLogText(arg);
          if (arg && typeof arg === 'object') {
            const next = { ...arg };
            if (typeof next.msg === 'string') next.msg = redactLogText(next.msg);
            if (next.url != null) next.url = redactUrl(next.url);
            return next;
          }
          return arg;
        });
        return method.apply(this, out);
      },
    },
  };
  if (stream) opts.stream = stream;
  return opts;
}
