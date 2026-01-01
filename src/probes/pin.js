import { Buffer } from 'node:buffer';
import { X509Certificate, createHash, timingSafeEqual } from 'node:crypto';
import https from 'node:https';
import tls from 'node:tls';
import { isIP } from 'node:net';

export function parseSpkiPin(value) {
  if (!value || typeof value !== 'string') return null;
  const s = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex');
  try {
    const buf = Buffer.from(s, 'base64');
    if (buf.length === 32) return buf;
  } catch {
    return null;
  }
  return null;
}

export function formatSpkiPin(buf, encoding = 'base64') {
  return Buffer.from(buf).toString(encoding);
}

export function spkiSha256FromCert(certLike) {
  const input = certLike?.raw || certLike;
  const cert = input instanceof X509Certificate ? input : new X509Certificate(input);
  const der = cert.publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest();
}

export function pinsMatch(actual, expected) {
  if (!actual || !expected || actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function fetchPinned(url, { method = 'POST', headers = {}, body, timeoutMs = 12000, pin } = {}) {
  const expected = Buffer.isBuffer(pin) ? pin : parseSpkiPin(pin);
  if (!expected) {
    return Promise.reject(Object.assign(new Error('PROBE_B_SPKI_SHA256 is missing or invalid'), { code: 'PROBE_B_PIN' }));
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.reject(Object.assign(new Error('PROBE_B_URL is invalid'), { code: 'PROBE_B_URL' }));
  }
  if (parsed.protocol !== 'https:') {
    return Promise.reject(Object.assign(new Error('PROBE_B_URL must be https'), { code: 'PROBE_B_TLS' }));
  }
  const servername = isIP(parsed.hostname) ? undefined : parsed.hostname;

  return new Promise((resolve, reject) => {
    let settled = false;
    let pinError = null;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(pinError || err);
      else resolve(value);
    };

    const req = https.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port) || 443,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers,
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        rejectUnauthorized: false,
        ...(servername ? { servername } : {}),
        createConnection: (opts, cb) => {
          const socket = tls.connect(
            {
              host: opts.host || parsed.hostname,
              port: opts.port || Number(parsed.port) || 443,
              minVersion: 'TLSv1.3',
              maxVersion: 'TLSv1.3',
              rejectUnauthorized: false,
              ...(servername ? { servername } : {}),
            },
            () => {
              try {
                const peer = socket.getPeerCertificate();
                if (!peer || !peer.raw) {
                  throw Object.assign(new Error('probe B presented no certificate'), { code: 'PROBE_B_PIN' });
                }
                const actual = spkiSha256FromCert(peer);
                if (!pinsMatch(actual, expected)) {
                  pinError = Object.assign(new Error('probe B certificate pin mismatch'), { code: 'PROBE_B_PIN' });
                  throw pinError;
                }
                cb(null, socket);
              } catch (err) {
                pinError = pinError || Object.assign(err, { code: err.code || 'PROBE_B_PIN' });
                socket.destroy();
                cb(pinError);
              }
            }
          );
          socket.on('error', (err) => cb(err));
          return socket;
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 1024 * 1024) {
            res.destroy();
            done(Object.assign(new Error('response too large'), { code: 'RESPONSE_TOO_LARGE' }));
          } else {
            chunks.push(chunk);
          }
        });
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const text = raw.toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          done(null, {
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            headers: res.headers,
            json: async () => (json != null ? json : JSON.parse(text)),
            text: async () => text,
          });
        });
        res.on('error', (err) => done(err));
      }
    );

    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    req.on('error', (err) => done(err));
    if (body) req.write(body);
    req.end();
  });
}
