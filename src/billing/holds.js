import { GRACE_DAYS } from './plans.js';

export function graceEndsAt(from = new Date(), days = GRACE_DAYS) {
  return new Date(new Date(from).getTime() + Number(days) * 24 * 60 * 60 * 1000);
}

// SQL fragment: true when this account must not be monitored.
// Pass the subscriptions alias and a timestamp parameter (so tests can inject a clock).
export function accountBillingHeldSql(alias = 'sub', nowParam = 'now()') {
  return `(
    ${alias}.status IN ('canceled', 'expired')
    OR (
      ${alias}.status = 'past_due'
      AND ${alias}.grace_ends_at IS NOT NULL
      AND ${alias}.grace_ends_at <= ${nowParam}
    )
  )`;
}

export function accountBillingHeldExistsSql(userIdExpr, nowParam = 'now()') {
  return `EXISTS (
    SELECT 1 FROM subscriptions sub
     WHERE sub.user_id = ${userIdExpr}
       AND ${accountBillingHeldSql('sub', nowParam)}
  )`;
}

export async function setBillingHold(db, userId, held) {
  await db.query('UPDATE sites SET billing_hold = $2 WHERE user_id = $1', [userId, held]);
  await db.query('UPDATE heartbeat_checks SET billing_hold = $2 WHERE user_id = $1', [userId, held]);
}

export async function applyBillingHolds(db, now = new Date()) {
  const { rows } = await db.query(
    `SELECT user_id FROM subscriptions
      WHERE status IN ('canceled', 'expired')
         OR (status = 'past_due' AND grace_ends_at IS NOT NULL AND grace_ends_at <= $1)`,
    [now]
  );
  for (const row of rows) {
    await setBillingHold(db, row.user_id, true);
  }
  return { paused: rows.length };
}

export async function clearBillingHold(db, userId) {
  await setBillingHold(db, userId, false);
}
