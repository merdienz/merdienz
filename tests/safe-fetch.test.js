import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createSafeFetch, MAX_RESPONSE_BYTES } from '../src/safe-fetch.js';

function listen(handler) {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.url = `http://127.0.0.1:${port}`;
      resolve(server);
    });
    server.on('error', reject);
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

describe('safe-fetch response cap, redirects, and connect timeout', () => {
  it('caps the response body at 1 MB', async () => {
    const server = await listen((req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.write(Buffer.alloc(MAX_RESPONSE_BYTES + 16, 0x61));
      res.end();
    });
    try {
      const fetchFn = createSafeFetch({ allowPrivate: true });
      await expect(fetchFn(server.url)).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    } finally {
      await close(server);
    }
  });

  it('does not follow redirects by default and re-checks each hop when enabled', async () => {
    let hits = 0;
    const server = await listen((req, res) => {
      hits += 1;
      if (req.url === '/start') {
        res.writeHead(302, { location: '/private-hop' });
        res.end('redirect');
        return;
      }
      res.writeHead(200);
      res.end('ok');
    });
    try {
      const fetchFn = createSafeFetch({ allowPrivate: true });
      const manual = await fetchFn(`${server.url}/start`);
      expect(manual.status).toBe(302);
      expect(hits).toBe(1);

      const followed = createSafeFetch({ allowPrivate: true, maxRedirects: 3 });
      const ok = await followed(`${server.url}/start`, { redirect: 'follow' });
      expect(ok.status).toBe(200);
      expect(hits).toBe(3);
    } finally {
      await close(server);
    }
  });

  it('re-checks a redirect hop with the SSRF guard', async () => {
    const server = await listen((req, res) => {
      res.writeHead(302, { location: 'http://127.0.0.1:4840/health' });
      res.end();
    });
    try {
      const fetchFn = createSafeFetch({ allowPrivate: false, maxRedirects: 3 });
      await expect(fetchFn(`${server.url}/start`, { redirect: 'follow' })).rejects.toThrow();
    } finally {
      await close(server);
    }
  });

  it('times out a connect that never completes', async () => {
    // Use a non-local private address that will not accept a handshake.
    const fetchFn = createSafeFetch({ allowPrivate: true, connectTimeoutMs: 250 });
    const started = Date.now();
    await expect(fetchFn('http://10.255.255.254:4849/')).rejects.toMatchObject({ code: 'CONNECT_TIMEOUT' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
