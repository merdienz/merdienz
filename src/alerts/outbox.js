import { sendAlert } from './email.js';

export const MAX_ATTEMPTS = 8;
const PRUNE_AFTER_DAYS = 14;
export const SKIPPED_PRUNE_DAYS = 1;
export const NO_MAILER_SKIP_REASON = 'no_mailer';

function backoffMs(attempts) {
  const exp = Math.min(10, Math.max(0, Number(attempts) || 0));
  return Math.min(60 * 60 * 1000, 1000 * 2 ** exp);
}

async function claimRow(client, id) {
  const { rows } = await client.query(
    `UPDATE alert_outbox
        SET locked_until = now() + interval '2 minutes'
      WHERE id = $1
        AND sent_at IS NULL
        AND skipped_at IS NULL
        AND attempts < $2
        AND (locked_until IS NULL OR locked_until < now())
      RETURNING *`,
    [id, MAX_ATTEMPTS]
  );
  return rows[0] || null;
}

async function markSent(client, id) {
  const { rows } = await client.query(
    `UPDATE alert_outbox
        SET sent_at = now(), attempts = attempts + 1, last_error = NULL, locked_until = NULL
      WHERE id = $1
        AND sent_at IS NULL
        AND skipped_at IS NULL
      RETURNING *`,
    [id]
  );
  return rows[0] || null;
}

async function markFailed(client, row, err) {
  await client.query(
    `UPDATE alert_outbox
        SET attempts = attempts + 1,
            last_error = $2,
            next_attempt_at = now() + ($3 * interval '1 millisecond'),
            locked_until = CASE
              WHEN locked_until IS NULL OR locked_until <= now() OR locked_until = $5::timestamptz THEN NULL
              ELSE locked_until
            END
      WHERE id = $1
        AND sent_at IS NULL
        AND skipped_at IS NULL
        AND attempts < $4`,
    [row.id, err.message, backoffMs((row.attempts || 0) + 1), MAX_ATTEMPTS, row.locked_until]
  );
}

export async function skipOutbox(db, id, reason) {
  const { rows } = await db.query(
    `UPDATE alert_outbox
        SET skipped_at = COALESCE(skipped_at, now()),
            skip_reason = COALESCE(skip_reason, $2),
            locked_until = NULL
      WHERE id = $1
        AND sent_at IS NULL
        AND skipped_at IS NULL
      RETURNING *`,
    [id, reason]
  );
  return rows[0] ? { ...rows[0], sent: false, skipped: reason } : null;
}

export async function insertOutbox(db, { kind, to, subject, text }) {
  if (!to) return null;
  const { rows } = await db.query(
    `INSERT INTO alert_outbox (kind, to_email, subject, body, next_attempt_at)
     VALUES ($1, $2, $3, $4, now())
     RETURNING *`,
    [kind, to, subject, text]
  );
  return rows[0] || null;
}

export async function enqueueAlert(db, mailer, { kind, to, subject, text }) {
  const row = await insertOutbox(db, { kind, to, subject, text });
  if (!row) return null;
  return deliverNow(db, mailer, row);
}

export async function deliverNow(db, mailer, row) {
  if (!row) return null;
  if (!mailer) {
    return skipOutbox(db, row.id, NO_MAILER_SKIP_REASON);
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const claimed = await claimRow(client, row.id);
    if (!claimed) {
      await client.query('COMMIT');
      return { ...row, sent: false, skipped: 'claimed' };
    }
    await client.query('COMMIT');

    try {
      const sent = await sendAlert(mailer, { to: row.to_email, subject: row.subject, text: row.body });
      const marked = await markSent(client, row.id);
      return { ...row, sent: true, record: sent, already: !marked };
    } catch (err) {
      await markFailed(client, claimed, err);
      return { ...row, sent: false, error: err.message };
    }
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The rollback error would hide the original failure.
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function retryPendingAlerts(db, mailer, { limit = 20, mailTransport } = {}) {
  if (!mailer) {
    if (mailTransport !== 'none') {
      return { retried: 0, skipped: 0 };
    }
    const { rowCount } = await db.query(
      `UPDATE alert_outbox
          SET skipped_at = now(),
              skip_reason = $1,
              locked_until = NULL
        WHERE sent_at IS NULL
          AND skipped_at IS NULL`,
      [NO_MAILER_SKIP_REASON]
    );
    return { retried: 0, skipped: rowCount || 0 };
  }

  const client = await db.connect();
  try {
    const result = await client.query(
      `SELECT id FROM alert_outbox
        WHERE sent_at IS NULL
          AND skipped_at IS NULL
          AND attempts < $2
          AND next_attempt_at <= now()
          AND (locked_until IS NULL OR locked_until < now())
        ORDER BY created_at ASC
        LIMIT $1`,
      [limit, MAX_ATTEMPTS]
    );
    const candidates = result.rows;
    let retried = 0;
    for (const candidate of candidates) {
      const claimed = await claimRow(client, candidate.id);
      if (!claimed) continue;
      try {
        await sendAlert(mailer, { to: claimed.to_email, subject: claimed.subject, text: claimed.body });
        const marked = await markSent(client, claimed.id);
        if (marked) retried += 1;
      } catch (err) {
        await markFailed(client, claimed, err);
      }
    }
    return { retried, pending: candidates.length };
  } finally {
    client.release();
  }
}

export async function pruneSentAlerts(db, { olderThanDays = PRUNE_AFTER_DAYS, skippedAfterDays = SKIPPED_PRUNE_DAYS } = {}) {
  const { rowCount } = await db.query(
    `DELETE FROM alert_outbox
      WHERE (
              sent_at IS NOT NULL
              AND sent_at < now() - ($1 * interval '1 day')
            )
         OR (
              sent_at IS NULL
              AND attempts >= $2
              AND COALESCE(next_attempt_at, created_at) < now() - ($1 * interval '1 day')
            )
         OR (
              skipped_at IS NOT NULL
              AND skipped_at < now() - ($3 * interval '1 day')
            )`,
    [olderThanDays, MAX_ATTEMPTS, skippedAfterDays]
  );
  return { pruned: rowCount || 0 };
}
