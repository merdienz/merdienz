export async function pruneRetention(db, now = new Date()) {
  const { rows: users } = await db.query(
    `SELECT u.id, g.retention_days
       FROM users u
       JOIN plan_gates g ON g.tier = u.tier
      WHERE g.retention_days IS NOT NULL`
  );
  const summary = {
    users: users.length,
    check_results: 0,
    heartbeat_pings: 0,
    incidents: 0,
    heartbeat_incidents: 0,
  };
  for (const user of users) {
    const cutoff = new Date(now.getTime() - user.retention_days * 24 * 60 * 60 * 1000);
    const results = await db.query(
      `DELETE FROM check_results
        WHERE checked_at < $2
          AND site_id IN (SELECT id FROM sites WHERE user_id = $1)`,
      [user.id, cutoff]
    );
    const pings = await db.query(
      `DELETE FROM heartbeat_pings
        WHERE received_at < $2
          AND check_id IN (SELECT id FROM heartbeat_checks WHERE user_id = $1)`,
      [user.id, cutoff]
    );
    const incidents = await db.query(
      `DELETE FROM incidents
        WHERE status = 'resolved'
          AND coalesce(ended_at, started_at) < $2
          AND site_id IN (SELECT id FROM sites WHERE user_id = $1)`,
      [user.id, cutoff]
    );
    const hbIncidents = await db.query(
      `DELETE FROM heartbeat_incidents
        WHERE status = 'resolved'
          AND coalesce(ended_at, started_at) < $2
          AND check_id IN (SELECT id FROM heartbeat_checks WHERE user_id = $1)`,
      [user.id, cutoff]
    );
    summary.check_results += results.rowCount;
    summary.heartbeat_pings += pings.rowCount;
    summary.incidents += incidents.rowCount;
    summary.heartbeat_incidents += hbIncidents.rowCount;
  }
  return summary;
}
