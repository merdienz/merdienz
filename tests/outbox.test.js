import { describe, expect, it } from 'vitest';
import { createMailer } from '../src/alerts/email.js';
import { deliverNow, enqueueAlert, insertOutbox, MAX_ATTEMPTS, NO_MAILER_SKIP_REASON, pruneSentAlerts, retryPendingAlerts, skipOutbox } from '../src/alerts/outbox.js';
import { getDb, resetData, testConfig } from './helpers.js';

function delayedMailer(sends, ms = 80) {
  return {
    mode: 'dev',
    from: 'alerts@localhost',
    inbox: [],
    transport: {
      sendMail: async (msg) => {
        sends.push(msg);
        await new Promise((resolve) => setTimeout(resolve, ms));
        return { messageId: `id-${sends.length}` };
      },
    },
  };
}

describe('alert outbox', () => {
  it('lets only one worker send a claimed row and applies backoff', async () => {
    const db = await getDb();
    await resetData(db);
    const sends = [];
    const mailer = delayedMailer(sends, 100);
    await db.query(
      `INSERT INTO alert_outbox (kind, to_email, subject, body, next_attempt_at)
       VALUES ('down', 'ops@example.com', 'DOWN', 'body', now())`
    );
    const [a, b] = await Promise.all([
      retryPendingAlerts(db, mailer, { limit: 5 }),
      retryPendingAlerts(db, mailer, { limit: 5 }),
    ]);
    expect(sends).toHaveLength(1);
    expect(a.retried + b.retried).toBe(1);
    const row = (await db.query('SELECT * FROM alert_outbox')).rows[0];
    expect(row.sent_at).not.toBeNull();
    expect(row.attempts).toBe(1);
  });

  it('schedules exponential backoff after a failed send and prunes old sent rows', async () => {
    const db = await getDb();
    await resetData(db);
    const failing = {
      mode: 'dev',
      from: 'alerts@localhost',
      inbox: [],
      transport: {
        sendMail: async () => {
          throw new Error('smtp down');
        },
      },
    };
    await enqueueAlert(db, failing, {
      kind: 'down',
      to: 'ops@example.com',
      subject: 'DOWN',
      text: 'body',
    });
    const row = (await db.query('SELECT * FROM alert_outbox')).rows[0];
    expect(row.sent_at).toBeNull();
    expect(row.attempts).toBe(1);
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now());

    await db.query(`UPDATE alert_outbox SET sent_at = now() - interval '30 days', next_attempt_at = now()`);
    const { pruned } = await pruneSentAlerts(db, { olderThanDays: 14 });
    expect(pruned).toBe(1);
    const left = await db.query('SELECT count(*)::int AS n FROM alert_outbox');
    expect(left.rows[0].n).toBe(0);
  });

  it('prunes exhausted failed rows after the retention window', async () => {
    const db = await getDb();
    await resetData(db);
    await db.query(
      `INSERT INTO alert_outbox (kind, to_email, subject, body, attempts, next_attempt_at, created_at)
       VALUES ('down', 'ops@example.com', 'DOWN', 'body', 8, now() - interval '30 days', now() - interval '30 days')`
    );
    const { pruned } = await pruneSentAlerts(db, { olderThanDays: 14 });
    expect(pruned).toBe(1);
    const left = await db.query('SELECT count(*)::int AS n FROM alert_outbox');
    expect(left.rows[0].n).toBe(0);
  });

  it('does not leak pool clients when deliverNow loses the claim race', async () => {
    const db = await getDb();
    await resetData(db);
    const sends = [];
    const mailer = delayedMailer(sends, 15);
    const rows = [];
    for (let i = 0; i < 20; i += 1) {
      rows.push(
        await insertOutbox(db, {
          kind: 'down',
          to: 'ops@example.com',
          subject: `DOWN ${i}`,
          text: 'body',
        })
      );
    }
    const jobs = [];
    for (const row of rows) {
      jobs.push(deliverNow(db, mailer, row));
      jobs.push(deliverNow(db, mailer, row));
    }
    jobs.push(retryPendingAlerts(db, mailer, { limit: 20 }));
    jobs.push(retryPendingAlerts(db, mailer, { limit: 20 }));
    await Promise.all(jobs);
    expect(sends).toHaveLength(20);
    expect(new Set(sends.map((m) => m.subject)).size).toBe(20);
    expect(db.waitingCount).toBe(0);
    expect(db.idleCount).toBe(db.totalCount);
    expect(db.totalCount).toBeGreaterThan(0);
  });

  it('marks a row sent after a successful send even if the lease has expired', async () => {
    const db = await getDb();
    await resetData(db);
    const sends = [];
    const row = await insertOutbox(db, {
      kind: 'down',
      to: 'ops@example.com',
      subject: 'DOWN lease',
      text: 'body',
    });
    const mailer = {
      mode: 'dev',
      from: 'alerts@localhost',
      inbox: [],
      transport: {
        sendMail: async (msg) => {
          sends.push(msg);
          await db.query(`UPDATE alert_outbox SET locked_until = now() - interval '1 second' WHERE id = $1`, [row.id]);
          return { messageId: `id-${sends.length}` };
        },
      },
    };
    const result = await deliverNow(db, mailer, row);
    expect(result.sent).toBe(true);
    expect(sends).toHaveLength(1);
    const after = (await db.query('SELECT sent_at, attempts FROM alert_outbox WHERE id = $1', [row.id])).rows[0];
    expect(after.sent_at).not.toBeNull();
    expect(after.attempts).toBe(1);
    const retried = await retryPendingAlerts(db, mailer);
    expect(retried.retried).toBe(0);
    expect(sends).toHaveLength(1);
  });

  it('counts a failed send after the lease expires and stops at MAX_ATTEMPTS', async () => {
    const db = await getDb();
    await resetData(db);
    const row = await insertOutbox(db, {
      kind: 'down',
      to: 'ops@example.com',
      subject: 'DOWN lease fail',
      text: 'body',
    });
    let throws = 0;
    const mailer = {
      mode: 'dev',
      from: 'alerts@localhost',
      inbox: [],
      transport: {
        sendMail: async () => {
          throws += 1;
          await db.query(`UPDATE alert_outbox SET locked_until = now() - interval '1 second' WHERE id = $1`, [row.id]);
          throw new Error('smtp down');
        },
      },
    };
    for (let i = 0; i < MAX_ATTEMPTS + 2; i += 1) {
      await db.query(`UPDATE alert_outbox SET next_attempt_at = now(), locked_until = NULL WHERE id = $1`, [row.id]);
      await retryPendingAlerts(db, mailer, { limit: 5 });
    }
    expect(throws).toBe(MAX_ATTEMPTS);
    const after = (await db.query('SELECT sent_at, attempts FROM alert_outbox WHERE id = $1', [row.id])).rows[0];
    expect(after.sent_at).toBeNull();
    expect(after.attempts).toBe(MAX_ATTEMPTS);
  });

  it('marks outbox rows skipped when no mailer is configured', async () => {
    const db = await getDb();
    await resetData(db);
    const row = await insertOutbox(db, {
      kind: 'down',
      to: 'ops@example.com',
      subject: 'DOWN no mailer',
      text: 'body',
    });
    const result = await deliverNow(db, null, row);
    expect(result.skipped).toBe(NO_MAILER_SKIP_REASON);
    const stored = (await db.query('SELECT skipped_at, skip_reason, sent_at FROM alert_outbox WHERE id = $1', [row.id])).rows[0];
    expect(stored.skipped_at).not.toBeNull();
    expect(stored.skip_reason).toBe(NO_MAILER_SKIP_REASON);
    expect(stored.sent_at).toBeNull();

    const leftover = await insertOutbox(db, {
      kind: 'recovery',
      to: 'ops@example.com',
      subject: 'RECOVERY no mailer',
      text: 'body',
    });
    const ignored = await retryPendingAlerts(db, null);
    expect(ignored.retried).toBe(0);
    expect(ignored.skipped).toBe(0);
    const leftoverRow = (await db.query('SELECT skipped_at, skip_reason, sent_at FROM alert_outbox WHERE id = $1', [leftover.id])).rows[0];
    expect(leftoverRow.skipped_at).toBeNull();
    expect(leftoverRow.sent_at).toBeNull();

    const skipped = await retryPendingAlerts(db, null, { mailTransport: 'none' });
    expect(skipped.retried).toBe(0);
    expect(skipped.skipped).toBe(1);
    const skippedRow = (await db.query('SELECT skipped_at, skip_reason FROM alert_outbox WHERE id = $1', [leftover.id])).rows[0];
    expect(skippedRow.skipped_at).not.toBeNull();
    expect(skippedRow.skip_reason).toBe(NO_MAILER_SKIP_REASON);

    const laterSends = [];
    const laterMailer = delayedMailer(laterSends, 1);
    const retried = await retryPendingAlerts(db, laterMailer);
    expect(retried.retried).toBe(0);
    expect(laterSends).toHaveLength(0);

    await db.query(`UPDATE alert_outbox SET skipped_at = now() - interval '2 days'`);
    const { pruned } = await pruneSentAlerts(db, { skippedAfterDays: 1 });
    expect(pruned).toBe(2);
    const left = await db.query('SELECT count(*)::int AS n FROM alert_outbox');
    expect(left.rows[0].n).toBe(0);
  });

  it('does not skip pending rows for a missing mailer unless mail transport is none', async () => {
    const db = await getDb();
    await resetData(db);
    const row = await insertOutbox(db, {
      kind: 'down',
      to: 'ops@example.com',
      subject: 'DOWN pending',
      text: 'body',
    });
    const missing = await retryPendingAlerts(db, null);
    expect(missing.skipped).toBe(0);
    const still = (await db.query('SELECT skipped_at, sent_at FROM alert_outbox WHERE id = $1', [row.id])).rows[0];
    expect(still.skipped_at).toBeNull();
    expect(still.sent_at).toBeNull();

    const none = await retryPendingAlerts(db, null, { mailTransport: 'none' });
    expect(none.skipped).toBe(1);
    const skipped = (await db.query('SELECT skipped_at, skip_reason FROM alert_outbox WHERE id = $1', [row.id])).rows[0];
    expect(skipped.skipped_at).not.toBeNull();
    expect(skipped.skip_reason).toBe(NO_MAILER_SKIP_REASON);
  });

  it('skips a producer alert when production MAIL_TRANSPORT is none', async () => {
    const db = await getDb();
    await resetData(db);
    const config = testConfig({ nodeEnv: 'production', merdienzMode: 'cloud', mailTransport: 'none' });
    expect(config.mailTransport).toBe('none');
    const mailer = createMailer(config);
    expect(mailer).toBeNull();
    const result = await enqueueAlert(db, mailer, {
      kind: 'down',
      to: 'ops@example.com',
      subject: 'DOWN none',
      text: 'body',
    });
    expect(result.skipped).toBe(NO_MAILER_SKIP_REASON);
    expect(result.sent).toBe(false);
    const stored = (await db.query('SELECT skipped_at, skip_reason, sent_at FROM alert_outbox WHERE id = $1', [result.id])).rows[0];
    expect(stored.skipped_at).not.toBeNull();
    expect(stored.skip_reason).toBe(NO_MAILER_SKIP_REASON);
    expect(stored.sent_at).toBeNull();
  });

  it('clears the outbox lock when a row is skipped', async () => {
    const db = await getDb();
    await resetData(db);
    const row = await insertOutbox(db, {
      kind: 'down',
      to: 'ops@example.com',
      subject: 'DOWN skip lock',
      text: 'body',
    });
    await db.query(`UPDATE alert_outbox SET locked_until = now() + interval '2 minutes' WHERE id = $1`, [row.id]);
    const skipped = await skipOutbox(db, row.id, NO_MAILER_SKIP_REASON);
    expect(skipped.skipped).toBe(NO_MAILER_SKIP_REASON);
    const stored = (await db.query('SELECT locked_until, skipped_at FROM alert_outbox WHERE id = $1', [row.id])).rows[0];
    expect(stored.skipped_at).not.toBeNull();
    expect(stored.locked_until).toBeNull();
  });

  it('does not release a fresher claim when a late failure is recorded', async () => {
    const db = await getDb();
    await resetData(db);
    const row = await insertOutbox(db, {
      kind: 'down',
      to: 'ops@example.com',
      subject: 'DOWN late fail',
      text: 'body',
    });

    async function waitUntil(fn) {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        if (fn()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('timed out');
    }

    let releaseLate;
    let releaseHolder;
    const lateStarted = [];
    const holderStarted = [];
    const lateMailer = {
      mode: 'dev',
      from: 'alerts@localhost',
      inbox: [],
      transport: {
        sendMail: async () => {
          lateStarted.push(true);
          await new Promise((resolve) => {
            releaseLate = resolve;
          });
          throw new Error('late smtp failure');
        },
      },
    };
    const holderMailer = {
      mode: 'dev',
      from: 'alerts@localhost',
      inbox: [],
      transport: {
        sendMail: async () => {
          holderStarted.push(true);
          await new Promise((resolve) => {
            releaseHolder = resolve;
          });
          return { messageId: 'held' };
        },
      },
    };

    const late = deliverNow(db, lateMailer, row);
    await waitUntil(() => lateStarted.length === 1);
    await db.query(`UPDATE alert_outbox SET locked_until = now() - interval '1 second' WHERE id = $1`, [row.id]);

    const held = deliverNow(db, holderMailer, row);
    await waitUntil(() => holderStarted.length === 1);
    const claimed = (await db.query('SELECT locked_until FROM alert_outbox WHERE id = $1', [row.id])).rows[0];
    const holderLock = new Date(claimed.locked_until).getTime();
    expect(holderLock).toBeGreaterThan(Date.now());

    releaseLate();
    const lateResult = await late;
    expect(lateResult.sent).toBe(false);

    const afterLate = (await db.query('SELECT locked_until, sent_at, attempts FROM alert_outbox WHERE id = $1', [row.id])).rows[0];
    expect(afterLate.sent_at).toBeNull();
    expect(new Date(afterLate.locked_until).getTime()).toBe(holderLock);
    expect(afterLate.attempts).toBe(1);

    const third = await deliverNow(db, delayedMailer([], 1), row);
    expect(third.skipped).toBe('claimed');

    releaseHolder();
    const heldResult = await held;
    expect(heldResult.sent).toBe(true);
    const finalRow = (await db.query('SELECT sent_at, locked_until, attempts FROM alert_outbox WHERE id = $1', [row.id])).rows[0];
    expect(finalRow.sent_at).not.toBeNull();
    expect(finalRow.locked_until).toBeNull();
    expect(finalRow.attempts).toBe(2);
  });


  it('delivers an alert for a site named a\\nb with a one-line subject', async () => {
    const db = await getDb();
    await resetData(db);
    const sends = [];
    const mailer = delayedMailer(sends, 0);
    const siteName = 'a\nb';
    const result = await enqueueAlert(db, mailer, {
      kind: 'down',
      to: 'ops@example.com',
      subject: `DOWN: ${siteName} is down`,
      text: `${siteName} failed`,
    });
    expect(result.sent).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0].subject).toBe('DOWN: a b is down');
    expect(/[\r\n]/.test(sends[0].subject)).toBe(false);
    const row = (await db.query('SELECT sent_at FROM alert_outbox')).rows[0];
    expect(row.sent_at).not.toBeNull();
  });
});
