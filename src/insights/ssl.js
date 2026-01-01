import { insertOutbox } from '../alerts/outbox.js';
import { daysLeft, describeLeft, reminderDue } from './expiry.js';

export { tlsInfoFromSocket } from '../probes/tls-info.js';

// Stores the latest certificate expiry for a site and queues a reminder email at 30/14/7/1/0
// days. The reminder marker and the outbox row are written in one transaction, so a reminder
// is queued at most once per threshold per certificate.
export async function recordSslExpiry(db, site, tls, { now = new Date() } = {}) {
  if (!tls || !tls.validTo) return { stored: false };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO site_insights (site_id, ssl_expires_at, ssl_valid_from, ssl_issuer, ssl_subject, ssl_checked_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (site_id) DO UPDATE SET
         ssl_expires_at = excluded.ssl_expires_at,
         ssl_valid_from = excluded.ssl_valid_from,
         ssl_issuer = excluded.ssl_issuer,
         ssl_subject = excluded.ssl_subject,
         ssl_checked_at = excluded.ssl_checked_at,
         updated_at = excluded.updated_at
       RETURNING ssl_reminded_for, ssl_reminded_days`,
      [site.id, tls.validTo, tls.validFrom, tls.issuer, tls.subject, now]
    );
    const row = rows[0];
    const due = reminderDue({
      expiresAt: tls.validTo,
      now,
      remindedFor: row.ssl_reminded_for,
      remindedDays: row.ssl_reminded_days,
    });
    let outbox = null;
    if (due !== null && site.user_email) {
      const left = daysLeft(tls.validTo, now);
      await client.query(
        `UPDATE site_insights SET ssl_reminded_for = $2, ssl_reminded_days = $3 WHERE site_id = $1`,
        [site.id, tls.validTo, due]
      );
      outbox = await insertOutbox(client, {
        kind: 'ssl_expiry',
        to: site.user_email,
        subject: `SSL: ${site.name} certificate ${describeLeft(left)}`,
        text: `The TLS certificate for ${site.name} (${site.url}) ${describeLeft(left)} (${tls.validTo}).\nIssuer: ${tls.issuer || 'unknown'}.\nRenew it before it expires to avoid browser errors and downtime.`,
      });
    }
    await client.query('COMMIT');
    return { stored: true, reminder: due, outbox };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // keep the original error
    }
    throw err;
  } finally {
    client.release();
  }
}
