import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactNotFoundUrl } from './log.js';
import { signupReady } from './signup.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const API_PREFIX = /^(?:\/sites|\/heartbeats|\/auth|\/me|\/health|\/internal|\/ping|\/status-page|\/setup|\/csrf-token)(?:\/|$)/;

function distDir() {
  return resolve(fileURLToPath(new URL('../web/dist', import.meta.url)));
}

function safeFile(root, urlPath) {
  const cleaned = decodeURIComponent((urlPath || '/').split('?')[0]);
  const target = resolve(root, `.${cleaned}`);
  const rel = relative(root, target);
  if (rel.startsWith('..') || normalize(rel).startsWith('..')) return null;
  return target;
}

function sendFile(reply, file) {
  const type = MIME[extname(file)] || 'application/octet-stream';
  const stream = createReadStream(file);
  return reply.type(type).send(stream);
}

export function sendSpaIndex(reply, root = distDir()) {
  const index = join(root, 'index.html');
  if (!existsSync(index)) {
    return reply.code(404).send({ error: 'dashboard not built', code: 'NO_UI' });
  }
  return sendFile(reply, index);
}

export function spaNotFoundHandler(request, reply, root = distDir()) {
  const safeUrl = redactNotFoundUrl(request.raw?.url || request.url || '');
  const hasUi = existsSync(join(root, 'index.html'));
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    if (request.log) request.log.info({ url: safeUrl }, 'route not found');
    return reply.code(404).send({ error: 'not found', code: 'NOT_FOUND' });
  }
  const path = (request.url || '').split('?')[0];
  if (API_PREFIX.test(path) || path.startsWith('/status/') || (/^\/signup\/?$/.test(path) && !signupReady(request.server?.config))) {
    if (request.log) request.log.info({ url: safeUrl }, 'route not found');
    return reply.code(404).send({ error: 'not found', code: 'NOT_FOUND' });
  }
  if (hasUi) {
    const file = safeFile(root, path);
    if (file && existsSync(file) && statSync(file).isFile()) {
      return sendFile(reply, file);
    }
    return sendSpaIndex(reply, root);
  }
  if (request.log) request.log.info({ url: safeUrl }, 'route not found');
  return reply.code(404).send({ error: 'not found', code: 'NOT_FOUND' });
}

export async function spaRoutes(fastify) {
  const root = distDir();
  fastify.decorate('sendSpaIndex', (reply) => sendSpaIndex(reply, root));
}
