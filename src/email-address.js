/** Shared single-address check used at signup and for alert From/To. */
export const EMAIL_MAX_LENGTH = 320;

// No whitespace, angle brackets, commas, or a second @. The domain may be a
// single label (for example user@localhost), matching signup.
export const SINGLE_EMAIL_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

export function isSingleEmailAddress(value) {
  if (typeof value !== 'string') return false;
  if (!value || value !== value.trim()) return false;
  if (/[\r\n]/.test(value)) return false;
  if (value.length > EMAIL_MAX_LENGTH) return false;
  return SINGLE_EMAIL_RE.test(value);
}
