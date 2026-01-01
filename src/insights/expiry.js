// Expiry reminders shared by SSL certificates and domain registrations.
export const REMINDER_THRESHOLDS = Object.freeze([30, 14, 7, 1, 0]);
const DAY_MS = 86400000;

export function daysLeft(expiresAt, now = new Date()) {
  const t = new Date(expiresAt).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((t - new Date(now).getTime()) / DAY_MS);
}

// Returns the threshold to remind for now, or null. A threshold is sent once per expiry date.
// If several thresholds were skipped (for example the check was paused), only the most urgent
// one is sent. A new expiry date (renewal) resets the series.
export function reminderDue({ expiresAt, now = new Date(), remindedFor = null, remindedDays = null, thresholds = REMINDER_THRESHOLDS }) {
  const left = daysLeft(expiresAt, now);
  if (left === null) return null;
  const sorted = [...thresholds].sort((a, b) => b - a);
  if (left > sorted[0]) return null;
  let bucket = sorted[sorted.length - 1];
  for (const t of sorted) if (left <= t) bucket = t;
  const sameExpiry = remindedFor && new Date(remindedFor).getTime() === new Date(expiresAt).getTime();
  if (sameExpiry && remindedDays !== null && remindedDays !== undefined && Number(remindedDays) <= bucket) return null;
  return bucket;
}

export function describeLeft(left) {
  if (left < 0) return `expired ${-left} day${left === -1 ? '' : 's'} ago`;
  if (left === 0) return 'expires within a day';
  return `expires in ${left} day${left === 1 ? '' : 's'}`;
}
