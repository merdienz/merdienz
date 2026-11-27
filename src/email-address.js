/** Shared single-address check used at signup and for alert From/To. */
export const EMAIL_MAX_LENGTH = 320;
export const LOCAL_PART_MAX_LENGTH = 64;

// No whitespace, angle brackets, commas, or a second @. The domain may be a
// single label (for example user@localhost), matching signup. The local part
// is one or more dot-separated atoms, with no leading, trailing, or doubled
// dots. Unbracketed IP-address domains are rejected in isSingleEmailAddress.
export const SINGLE_EMAIL_RE =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

function isUnbracketedIpDomain(domain) {
  const labels = domain.split('.');
  if (labels.length !== 4) return false;
  return labels.every((label) => /^(?:0|[1-9]\d{0,2})$/.test(label) && Number(label) <= 255);
}

export function isSingleEmailAddress(value) {
  if (typeof value !== 'string') return false;
  if (!value || value !== value.trim()) return false;
  if (/[\r\n]/.test(value)) return false;
  if (value.length > EMAIL_MAX_LENGTH) return false;
  if (!SINGLE_EMAIL_RE.test(value)) return false;
  const at = value.lastIndexOf('@');
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > LOCAL_PART_MAX_LENGTH) return false;
  if (local.includes('=?')) return false;
  if (isUnbracketedIpDomain(domain)) return false;
  return true;
}
