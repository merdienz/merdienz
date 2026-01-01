import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { redactLogText, redactNotFoundUrl, redactReq, redactUrl } from '../src/log.js';
import { authHeader, createUser, withApp } from './helpers.js';

function capture() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return {
    stream,
    text: () => chunks.join(''),
  };
}

describe('log redaction', () => {
  it('rewrites ping URLs and secret headers in the request serializer', () => {
    const token = '11111111-2222-4333-8444-555555555555';
    expect(redactUrl(`/ping/${token}/fail?api_key=secret`)).toBe('/ping/<redacted>/fail?api_key=[Redacted]');
    const serialized = redactReq({
      method: 'GET',
      url: `/ping/${token}`,
      headers: {
        authorization: 'Bearer mrz_supersecret',
        'x-api-key': 'mrz_supersecret',
        'x-session-token': 'sess_secret',
        'x-probe-signature': 'abcd',
        cookie: 'session=secret',
        'user-agent': 'test',
      },
    });
    expect(serialized.url).toBe('/ping/<redacted>');
    expect(serialized.headers.authorization).toBe('[Redacted]');
    expect(serialized.headers['x-api-key']).toBe('[Redacted]');
    expect(serialized.headers['x-session-token']).toBe('[Redacted]');
    expect(serialized.headers['x-probe-signature']).toBe('[Redacted]');
    expect(serialized.headers.cookie).toBe('[Redacted]');
    expect(serialized.headers['user-agent']).toBe('test');
  });

  it('does not write ping tokens or API keys to the log stream', async () => {
    const log = capture();
    await withApp(
      async ({ app, db }) => {
        const user = await createUser(db, { email: 'logs@example.com' });
        const created = await app.inject({
          method: 'POST',
          url: '/heartbeats',
          headers: { ...authHeader(user), 'content-type': 'application/json' },
          payload: { name: 'Logged', period_seconds: 60 },
        });
        const token = new URL(created.json().ping_urls.success).pathname.split('/').pop();
        await app.inject({
          method: 'GET',
          url: `/ping/${token}`,
          headers: { authorization: `Bearer ${user.apiKey}`, 'x-api-key': user.apiKey },
        });
        const text = log.text();
        expect(text).toMatch(/\/ping\/<redacted>/);
        expect(text).not.toContain(token);
        expect(text).not.toContain(user.apiKey);
        expect(text).not.toMatch(/mrz_[A-Za-z0-9]+/);
      },
      { config: { logStream: log.stream, nodeEnv: 'production', merdienzMode: 'selfhosted' } }
    );
  });

  it('redacts ping tokens after decoding, collapsing slashes, and ignoring case', () => {
    const token = '11111111-2222-4333-8444-555555555555';
    expect(redactUrl(`//ping/${token}`)).toBe('/ping/<redacted>');
    expect(redactUrl(`/ping/${token}/x/y`)).toBe('/ping/<redacted>/x/y');
    expect(redactUrl(`/ping/%31${token.slice(1)}`)).toBe('/ping/<redacted>');
    expect(redactUrl(`/PING/${token.toUpperCase()}`)).toBe('/ping/<redacted>');
  });

  it('redacts ping tokens after path normalization and in query values', () => {
    const token = '11111111-2222-4333-8444-555555555555';
    expect(redactUrl(`/ping/./${token}`)).toBe('/ping/<redacted>');
    expect(redactUrl(`/ping;x/${token}`)).toBe('/ping/x/<redacted>');
    expect(redactUrl(`/?next=/ping/${token}`)).toBe('/?next=/ping/<redacted>');
    expect(redactLogText('Merdienz API listening on port 4840')).toBe('Merdienz API listening on port 4840');
    expect(redactLogText('Server listening at http://127.0.0.1:4840')).toBe('Server listening at http://127.0.0.1:4840');
  });

  it('does not log the raw URL on 404 ping paths', async () => {
    const log = capture();
    const token = '11111111-2222-4333-8444-555555555555';
    await withApp(
      async ({ app }) => {
        const notFoundPaths = [
          `//ping/${token}`,
          `/ping/${token}/x/y`,
          `/ping/%31${token.slice(1)}`,
          `/PING/${token}`,
          `/ping/./${token}`,
          `/ping;x/${token}`,
        ];
        for (const url of notFoundPaths) {
          const res = await app.inject({ method: 'POST', url });
          expect(JSON.stringify(res.json())).not.toContain(token);
          expect(JSON.stringify(res.json())).not.toContain(token.toUpperCase());
          if (url !== `//ping/${token}`) {
            expect(res.statusCode).toBe(404);
          }
        }
      },
      { config: { logStream: log.stream, nodeEnv: 'production', merdienzMode: 'selfhosted' } }
    );
    const text = log.text();
    expect(text).not.toContain(token);
    expect(text).not.toContain(token.toUpperCase());
    expect(text).not.toMatch(/\/ping\/a1b2c3d4/i);
    expect(text).not.toMatch(/%311111111-2222/i);
    expect(text).toMatch(/\/ping\/<redacted>/);
  });
it('redacts bare UUID path segments on unmatched routes', () => {
    const token = '11111111-2222-4333-8444-555555555555';
    expect(redactNotFoundUrl(`/x/${token}`)).toBe('/x/<redacted>');
    expect(redactNotFoundUrl(`/x/${token}/y`)).toBe('/x/<redacted>/y');
    expect(redactNotFoundUrl(`/x?u=${token}`)).toBe('/x?u=<redacted>');
    expect(redactUrl(`/x/${token}`)).toBe('/x/<redacted>');
    expect(redactUrl(`/x?u=${token}&next=1`)).toBe('/x?u=<redacted>&next=1');
    expect(redactUrl(`/files/${token}.json`)).toBe('/files/<redacted>.json');
    expect(redactNotFoundUrl(`/?next=/ping/${token}`)).toBe('/?next=/ping/<redacted>');
    expect(redactUrl(`/foo/${token}0`)).toBe('/foo/<redacted>0');
    expect(redactUrl(`/foo/a${token}b`)).toBe('/foo/a<redacted>b');
    const compact = token.replace(/-/g, '');
    expect(redactUrl(`/foo/${compact}0`)).toBe('/foo/<redacted>');
  });

  it('does not log a bare UUID on a 404 path', async () => {
    const log = capture();
    const token = '11111111-2222-4333-8444-555555555555';
    await withApp(
      async ({ app }) => {
        const res = await app.inject({ method: 'POST', url: `/x/${token}` });
        expect(res.statusCode).toBe(404);
        expect(JSON.stringify(res.json())).not.toContain(token);
      },
      { config: { logStream: log.stream, nodeEnv: 'production', merdienzMode: 'selfhosted' } }
    );
    const text = log.text();
    expect(text).not.toContain(token);
    expect(text).toMatch(/\/x\/<redacted>/);
  });
});
