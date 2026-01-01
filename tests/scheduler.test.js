import { describe, expect, it } from 'vitest';
import { createMailer } from '../src/alerts/email.js';
import { insertOutbox } from '../src/alerts/outbox.js';
import { runAlertDeliveryTick, runSchedulerTick } from '../src/scheduler.js';
import {
  closeServer,
  createUser,
  getDb,
  resetData,
  startLocalServer,
  testConfig,
} from './helpers.js';
import { tp } from './ports.js';

describe('scheduler', () => {
  it('checks due sites, skips sites that are not due, and pings the dead-man URL', async () => {
    const db = await getDb();
    await resetData(db);
    const user = await createUser(db, { email: 'sched@example.com' });

    const target = await startLocalServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    }, tp(4851));

    const beats = [];
    const heartbeat = await startLocalServer((req, res) => {
      beats.push({ url: req.url, at: Date.now() });
      res.writeHead(200);
      res.end('pong');
    }, tp(4850));

    try {
      const due = await db.query(
        `INSERT INTO sites (user_id, name, url, interval_seconds, last_checked_at)
         VALUES ($1, 'Due', $2, 300, now() - interval '10 minutes')
         RETURNING *`,
        [user.id, target.url]
      );
      const notDue = await db.query(
        `INSERT INTO sites (user_id, name, url, interval_seconds, last_checked_at)
         VALUES ($1, 'Fresh', $2, 300, now())
         RETURNING *`,
        [user.id, target.url]
      );

      const mailer = createMailer(testConfig());
      const out = await runSchedulerTick({
        db,
        mailer,
        config: testConfig({ heartbeatUrl: heartbeat.url }),
      });

      expect(out.checked).toBe(1);
      expect(out.results[0].status).toBe('up');
      expect(out.heartbeat.ok).toBe(true);
      expect(beats.length).toBe(1);

      const dueRow = await db.query('SELECT current_status FROM sites WHERE id = $1', [
        due.rows[0].id,
      ]);
      const freshRow = await db.query('SELECT current_status, last_checked_at FROM sites WHERE id = $1', [
        notDue.rows[0].id,
      ]);
      expect(dueRow.rows[0].current_status).toBe('up');
      expect(freshRow.rows[0].current_status).toBe('unknown');
    } finally {
      await closeServer(target);
      await closeServer(heartbeat);
    }
  });

  it('skips the dead-man ping when no heartbeat URL is configured', async () => {
    const db = await getDb();
    await resetData(db);
    const out = await runSchedulerTick({
      db,
      mailer: createMailer(testConfig()),
      config: testConfig({ heartbeatUrl: '' }),
    });
    expect(out.heartbeat.skipped).toBe(true);
    expect(out.checked).toBe(0);
  });

  it('does not wait on outbound mail when checking sites and heartbeats', async () => {
    const db = await getDb();
    await resetData(db);
    const user = await createUser(db, { email: 'alert-loop@example.com' });
    const target = await startLocalServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    }, tp(4852));
    try {
      await db.query(
        `INSERT INTO sites (user_id, name, url, interval_seconds, last_checked_at)
         VALUES ($1, 'Due', $2, 300, now() - interval '10 minutes')`,
        [user.id, target.url]
      );
      await insertOutbox(db, {
        kind: 'down',
        to: 'ops@example.com',
        subject: 'DOWN pending',
        text: 'body',
      });

      let sendStarted = 0;
      const hangingMailer = {
        mode: 'dev',
        from: 'alerts@localhost',
        inbox: [],
        transport: {
          sendMail: async () => {
            sendStarted += 1;
            await new Promise(() => {});
          },
        },
      };
      const sendingMailer = createMailer(testConfig());
      const config = testConfig({ heartbeatUrl: '' });

      const started = Date.now();
      const out = await runSchedulerTick({ db, mailer: hangingMailer, config });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(out.checked).toBe(1);
      expect(out.results[0].status).toBe('up');
      expect(sendStarted).toBe(0);
      const pending = (await db.query('SELECT sent_at FROM alert_outbox')).rows[0];
      expect(pending.sent_at).toBeNull();

      const delivered = await runAlertDeliveryTick({ db, mailer: sendingMailer, config });
      expect(delivered.retried.retried).toBe(1);
      const sent = (await db.query('SELECT sent_at FROM alert_outbox')).rows[0];
      expect(sent.sent_at).not.toBeNull();
    } finally {
      await closeServer(target);
    }
  });
});
