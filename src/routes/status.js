import { bad } from '../errors.js';
import { assertCanAddStatusPage, assertCloudPlan, rejectClientTier } from '../gates.js';
import {
  idParams,
  statusPageCreateSchema,
  statusPagePatchSchema,
  statusPageUpsertSchema,
  statusSlugParams,
} from '../schemas.js';
import { assertSlug, getPublicStatus } from '../status.js';
import { sendSpaIndex } from '../static.js';

function wantsHtml(request) {
  const accept = request.headers.accept || '';
  return accept.includes('text/html') && !accept.includes('application/json');
}

function presentPage(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function pagesFor(db, userId) {
  const { rows } = await db.query(
    `SELECT id, slug, title, created_at, updated_at
       FROM status_pages
      WHERE user_id = $1
      ORDER BY created_at ASC`,
    [userId]
  );
  return rows.map(presentPage);
}

async function insertPage(db, userId, slug, title) {
  try {
    const { rows } = await db.query(
      `INSERT INTO status_pages (user_id, slug, title)
       VALUES ($1, $2, $3)
       RETURNING id, slug, title, created_at, updated_at`,
      [userId, slug, title]
    );
    return presentPage(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      throw bad(409, 'slug is already taken', 'SLUG_TAKEN');
    }
    throw err;
  }
}

export async function statusRoutes(fastify) {
  const publicLimit =
    fastify.config.nodeEnv === 'test' || fastify.config.disableRateLimit
      ? 10000
      : 60;

  fastify.get(
    '/status/:slug',
    {
      schema: { params: statusSlugParams },
      config: {
        rateLimit: { max: publicLimit, timeWindow: '1 minute', keyGenerator: (req) => `status:${req.ip}` },
      },
    },
    async (request, reply) => {
      if (wantsHtml(request)) {
        return sendSpaIndex(reply);
      }
      const page = await getPublicStatus(fastify.db, request.params.slug);
      if (!page) return reply.code(404).send({ error: 'not found', code: 'NOT_FOUND' });
      return page;
    }
  );
}

export async function statusPageAdminRoutes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);

  fastify.get('/status-page', { schema: {} }, async (request) => {
    const pages = await pagesFor(fastify.db, request.user.id);
    return { status_page: pages[0] || null, status_pages: pages };
  });

  fastify.post('/status-page', { schema: statusPageCreateSchema }, async (request) => {
    rejectClientTier(request.body || {}, request.headers);
    assertCloudPlan(fastify.config, request.gate);
    const title = request.body?.title;
    if (!title || typeof title !== 'string' || !title.trim()) {
      throw bad(400, 'title is required', 'BAD_TITLE');
    }
    const slug = assertSlug(request.body?.slug);
    const countRes = await fastify.db.query(
      'SELECT count(*)::int AS n FROM status_pages WHERE user_id = $1',
      [request.user.id]
    );
    assertCanAddStatusPage(request.gate, countRes.rows[0].n);
    const page = await insertPage(fastify.db, request.user.id, slug, title.trim());
    return { status_page: page };
  });

  // Dashboard upsert: create when there is no page yet. An existing page is
  // updated in place, but its slug is only changed when the body includes slug
  // and that slug already belongs to this page. A new slug creates a new page
  // (plan cap applying) instead of renaming the current public URL.
  fastify.put('/status-page', { schema: statusPageUpsertSchema }, async (request) => {
    rejectClientTier(request.body || {}, request.headers);
    const title = request.body?.title;
    if (!title || typeof title !== 'string' || !title.trim()) {
      throw bad(400, 'title is required', 'BAD_TITLE');
    }
    const hasSlug = Boolean(request.body && Object.prototype.hasOwnProperty.call(request.body, 'slug'));
    const pages = await pagesFor(fastify.db, request.user.id);

    async function updateTitle(pageId, nextTitle, nextSlug) {
      try {
        const { rows } = await fastify.db.query(
          `UPDATE status_pages
              SET slug = $3, title = $4, updated_at = now()
            WHERE id = $1 AND user_id = $2
            RETURNING id, slug, title, created_at, updated_at`,
          [pageId, request.user.id, nextSlug, nextTitle]
        );
        return { status_page: presentPage(rows[0]) };
      } catch (err) {
        if (err.code === '23505') {
          throw bad(409, 'slug is already taken', 'SLUG_TAKEN');
        }
        throw err;
      }
    }

    if (!pages.length) {
      if (!hasSlug) throw bad(400, 'slug is required', 'BAD_SLUG');
      const slug = assertSlug(request.body.slug);
      assertCloudPlan(fastify.config, request.gate);
      assertCanAddStatusPage(request.gate, 0);
      const page = await insertPage(fastify.db, request.user.id, slug, title.trim());
      return { status_page: page };
    }

    if (!hasSlug) {
      return updateTitle(pages[0].id, title.trim(), pages[0].slug);
    }
    const slug = assertSlug(request.body.slug);
    const sameSlug = pages.find((p) => p.slug === slug);
    if (sameSlug) {
      return updateTitle(sameSlug.id, title.trim(), sameSlug.slug);
    }
    assertCloudPlan(fastify.config, request.gate);
    assertCanAddStatusPage(request.gate, pages.length);
    const page = await insertPage(fastify.db, request.user.id, slug, title.trim());
    return { status_page: page };
  });

  fastify.patch('/status-page/:id', { schema: statusPagePatchSchema }, async (request, reply) => {
    rejectClientTier(request.body || {}, request.headers);
    const existing = await fastify.db.query(
      `SELECT id, slug, title FROM status_pages WHERE id = $1 AND user_id = $2`,
      [request.params.id, request.user.id]
    );
    if (!existing.rows[0]) return reply.code(404).send({ error: 'not found', code: 'NOT_FOUND' });
    const title =
      request.body?.title !== undefined ? String(request.body.title).trim() : existing.rows[0].title;
    if (!title) throw bad(400, 'title is required', 'BAD_TITLE');
    const slug =
      request.body?.slug !== undefined ? assertSlug(request.body.slug) : existing.rows[0].slug;
    try {
      const { rows } = await fastify.db.query(
        `UPDATE status_pages
            SET slug = $3, title = $4, updated_at = now()
          WHERE id = $1 AND user_id = $2
          RETURNING id, slug, title, created_at, updated_at`,
        [request.params.id, request.user.id, slug, title]
      );
      return { status_page: presentPage(rows[0]) };
    } catch (err) {
      if (err.code === '23505') {
        throw bad(409, 'slug is already taken', 'SLUG_TAKEN');
      }
      throw err;
    }
  });

  fastify.delete('/status-page/:id', { schema: { params: idParams } }, async (request, reply) => {
    const { rowCount } = await fastify.db.query(
      `DELETE FROM status_pages WHERE id = $1 AND user_id = $2`,
      [request.params.id, request.user.id]
    );
    if (!rowCount) return reply.code(404).send({ error: 'not found', code: 'NOT_FOUND' });
    return { ok: true };
  });
}
