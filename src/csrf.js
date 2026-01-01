import { bad } from './errors.js';

export function isMutating(method) {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method || '').toUpperCase());
}

export function enforceCsrf(app, request, reply) {
  if (typeof app.csrfProtection !== 'function') {
    throw bad(403, 'csrf required', 'CSRF');
  }
  return new Promise((resolve, reject) => {
    let finished = false;
    let originalSend;
    const finish = (err) => {
      if (finished) return;
      finished = true;
      // Put the real send back as soon as the check is done. Leaving the
      // wrapper in place would swallow an error the route handler throws later
      // and the request would never get a response.
      if (originalSend) reply.send = originalSend;
      if (err) reject(err);
      else resolve();
    };
    originalSend = reply.send;
    const boundSend = originalSend.bind(reply);
    reply.send = (payload) => {
      reply.send = originalSend;
      if (payload instanceof Error) {
        finish(payload);
        return reply;
      }
      return boundSend(payload);
    };
    try {
      app.csrfProtection(request, reply, finish);
    } catch (err) {
      reply.send = originalSend;
      finish(err);
    }
  });
}
