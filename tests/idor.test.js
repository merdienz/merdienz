import { describe, expect, it } from 'vitest';
import { authHeader, createUser, withApp } from './helpers.js';

describe('IDOR: users cannot reach each other\'s data', () => {
  it('keeps sites, incidents, heartbeats and ping logs scoped to the owner', async () => {
    await withApp(async ({ app, db }) => {
      const alice = await createUser(db, { email: 'alice@example.com' });
      const bob = await createUser(db, { email: 'bob@example.com' });

      const site = await app.inject({
        method: 'POST',
        url: '/sites',
        headers: { ...authHeader(alice), 'content-type': 'application/json' },
        payload: { name: 'Alice site', url: 'https://example.com' },
      });
      expect(site.statusCode).toBe(200);
      const siteId = site.json().id;
      await db.query(
        `INSERT INTO incidents (site_id, status, alerted) VALUES ($1, 'open', true)`,
        [siteId]
      );

      const hb = await app.inject({
        method: 'POST',
        url: '/heartbeats',
        headers: { ...authHeader(alice), 'content-type': 'application/json' },
        payload: { name: 'Alice job', period_seconds: 60 },
      });
      expect(hb.statusCode).toBe(200);
      const hbId = hb.json().id;
      const pingPath = new URL(hb.json().ping_urls.success).pathname;
      await app.inject({ method: 'POST', url: pingPath });

      const denied = [
        { method: 'GET', url: `/sites/${siteId}` },
        { method: 'DELETE', url: `/sites/${siteId}` },
        { method: 'GET', url: `/sites/${siteId}/incidents` },
        { method: 'GET', url: `/heartbeats/${hbId}` },
        { method: 'POST', url: `/heartbeats/${hbId}/pause` },
        { method: 'POST', url: `/heartbeats/${hbId}/resume` },
        { method: 'DELETE', url: `/heartbeats/${hbId}` },
      ];
      for (const req of denied) {
        const res = await app.inject({ ...req, headers: authHeader(bob) });
        expect(res.statusCode, `${req.method} ${req.url}`).toBe(404);
        expect(res.json().code).toBe('NOT_FOUND');
      }

      const listSites = await app.inject({ method: 'GET', url: '/sites', headers: authHeader(bob) });
      expect(listSites.json().sites).toEqual([]);
      const listHb = await app.inject({ method: 'GET', url: '/heartbeats', headers: authHeader(bob) });
      expect(listHb.json().heartbeats).toEqual([]);

      const ownerIncidents = await app.inject({
        method: 'GET',
        url: `/sites/${siteId}/incidents`,
        headers: authHeader(alice),
      });
      expect(ownerIncidents.statusCode).toBe(200);
      expect(ownerIncidents.json().incidents).toHaveLength(1);

      const ownerHb = await app.inject({
        method: 'GET',
        url: `/heartbeats/${hbId}`,
        headers: authHeader(alice),
      });
      expect(ownerHb.statusCode).toBe(200);
      expect(ownerHb.json().pings.length).toBeGreaterThan(0);
    });
  });
});
