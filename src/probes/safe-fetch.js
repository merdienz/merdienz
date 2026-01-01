import http from 'node:http';
import https from 'node:https';
import { isBlockedAddress, parseIPv4Loose, resolvePublicAddresses } from './ssrf.js';
import { tlsInfoFromSocket } from './tls-info.js';

export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

function familyOf(address) {
  return address.includes(':') ? 6 : 4;
}

function headerValue(headers, name) {
  const raw = headers[name] || headers[name.toLowerCase()];
  return Array.isArray(raw) ? raw[0] : raw;
}

export function createSafeFetch({
  allowPrivate = false,
  lookup,
  maxResponseBytes = MAX_RESPONSE_BYTES,
  maxRedirects = 0,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
} = {}) {
  return async function safeFetch(url, init = {}) {
    const redirectMode = init.redirect || (maxRedirects > 0 ? 'follow' : 'manual');
    const limit = Number.isFinite(Number(init.maxRedirects)) ? Number(init.maxRedirects) : maxRedirects;
    return requestOnce(url, init, 0, { allowPrivate, lookup, maxResponseBytes, maxRedirects: limit, connectTimeoutMs, redirectMode });
  };
}

async function requestOnce(url, init, depth, options) {
  const { hostname, addresses, parsed } = await assertUrl(url, options);
  const picked = addresses[0];
  const ip = picked.address;
  const family = picked.family || familyOf(ip);
  const isHttps = parsed.protocol === 'https:';
  const port = Number(parsed.port) || (isHttps ? 443 : 80);
  const lib = isHttps ? https : http;
  const headers = { ...(init.headers || {}), host: parsed.host };
  if (!headers['user-agent'] && !headers['User-Agent']) {
    headers['user-agent'] = 'MerdienzProbe/1.0';
  }
  const method = init.method || 'GET';
  const signal = init.signal;
  const connectTimeoutMs = init.connectTimeoutMs || options.connectTimeoutMs;
  const maxBytes = options.maxResponseBytes;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (connectTimer) clearTimeout(connectTimer);
      if (err) reject(err);
      else resolve(value);
    };

    const req = lib.request(
      {
        host: ip,
        family,
        port,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers,
        servername: hostname,
        lookup: (_host, _opts, cb) => cb(null, ip, family),
      },
      (res) => {
        if (connectTimer) clearTimeout(connectTimer);
        const location = headerValue(res.headers, 'location');
        const isRedirect = res.statusCode >= 300 && res.statusCode < 400 && location;
        const canFollow =
          options.redirectMode === 'follow' &&
          isRedirect &&
          depth < options.maxRedirects;
        if (canFollow) {
          res.resume();
          let nextUrl;
          try {
            nextUrl = new URL(location, parsed).toString();
          } catch {
            finish(new Error('invalid redirect location'));
            return;
          }
          requestOnce(nextUrl, { ...init, body: undefined, method: 'GET' }, depth + 1, options).then(
            (value) => finish(null, value),
            (err) => finish(err)
          );
          return;
        }

        const tls = isHttps ? tlsInfoFromSocket(res.socket) : null;
        const declared = Number(headerValue(res.headers, 'content-length'));
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.destroy();
          finish(Object.assign(new Error('response too large'), { code: 'RESPONSE_TOO_LARGE' }));
          return;
        }

        const chunks = [];
        let received = 0;
        res.on('data', (chunk) => {
          received += chunk.length;
          if (received > maxBytes) {
            res.destroy();
            finish(Object.assign(new Error('response too large'), { code: 'RESPONSE_TOO_LARGE' }));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          finish(null, {
            ok: res.statusCode >= 200 && res.statusCode < 400,
            status: res.statusCode,
            headers: res.headers,
            body,
            tls,
          });
        });
        res.on('error', (err) => finish(err));
      }
    );

    let connectTimer = setTimeout(() => {
      req.destroy(Object.assign(new Error('connect timeout'), { code: 'CONNECT_TIMEOUT' }));
    }, connectTimeoutMs);
    req.once('socket', (socket) => {
      const clear = () => {
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
      };
      if (socket.connecting) {
        socket.once('connect', clear);
        socket.once('secureConnect', clear);
      } else {
        clear();
      }
    });

    req.on('error', (err) => finish(err));
    if (init.timeout) req.setTimeout(init.timeout, () => req.destroy(new Error('timeout')));
    if (signal) {
      if (signal.aborted) {
        req.destroy(signal.reason || new Error('aborted'));
        return;
      }
      signal.addEventListener('abort', () => req.destroy(signal.reason || new Error('aborted')), { once: true });
    }
    if (init.body) req.write(init.body);
    req.end();
  });
}

async function assertUrl(url, options) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('invalid url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('url must be http or https');
  }
  const addresses = await resolvePublicAddresses(parsed.hostname, options);
  if (!options.allowPrivate) {
    for (const row of addresses) {
      if (isBlockedAddress(row.address) || isBlockedAddress(parseIPv4Loose(row.address)?.text || row.address)) {
        throw new Error('blocked address');
      }
    }
  }
  return { hostname: parsed.hostname, addresses, parsed };
}

export const defaultSafeFetch = createSafeFetch();
