import { describe, expect, it } from 'vitest';
import { nextCronOccurrence, parseCronExpr } from '../src/cron.js';
import { authHeader, createUser, withApp } from './helpers.js';

describe('cron scheduling', () => {
  it('rejects expressions with no run in 5 years and finishes quickly', async () => {
    const start = Date.now();
    expect(() => nextCronOccurrence('0 0 31 2 *', 'UTC', new Date('2026-11-23T00:00:00Z'))).toThrow(
      /no cron occurrence in the next 5 years/
    );
    expect(Date.now() - start).toBeLessThan(1000);
    await withApp(async ({ app, db }) => {
      const user = await createUser(db, { email: 'cron@example.com' });
      const res = await app.inject({
        method: 'POST',
        url: '/heartbeats',
        headers: { ...authHeader(user), 'content-type': 'application/json' },
        payload: { name: 'Never', cron_expr: '0 0 31 2 *', timezone: 'UTC', grace_seconds: 60 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('BAD_CRON');
    });
  });

  it('fires a repeated fall-back wall time only once and skips a spring-forward gap', () => {
    const nyFirst = new Date('2026-11-01T05:30:00Z');
    const nextNy = nextCronOccurrence('30 1 * * *', 'America/New_York', nyFirst);
    expect(nextNy.toISOString()).toBe('2026-11-02T06:30:00.000Z');

    const londonFirst = new Date('2026-10-25T00:30:00Z');
    const nextLondon = nextCronOccurrence('30 1 * * *', 'Europe/London', londonFirst);
    expect(nextLondon.toISOString()).toBe('2026-10-26T01:30:00.000Z');

    const beforeSpring = new Date('2026-03-08T06:30:00Z');
    const afterSpring = nextCronOccurrence('30 2 * * *', 'America/New_York', beforeSpring);
    expect(afterSpring.toISOString()).toBe('2026-03-09T06:30:00.000Z');
  });

  it('uses Vixie OR semantics when both day-of-month and day-of-week are restricted', () => {
    const from = new Date('2026-11-23T10:00:00Z');
    const next = nextCronOccurrence('0 0 1 * 1', 'UTC', from);
    expect(next.toISOString()).toBe('2026-11-30T00:00:00.000Z');
    parseCronExpr('0 0 1 * 1');
  });
});
