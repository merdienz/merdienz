// Certificate details of the TLS connection a check already used. No second connection is made.
const MAX_TEXT = 200;
const clip = (v) => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : null);

function nameOf(entity) {
  if (!entity || typeof entity !== 'object') return null;
  const v = entity.O || entity.CN;
  return clip(Array.isArray(v) ? v[0] : v);
}

export function tlsInfoFromSocket(socket) {
  if (!socket || typeof socket.getPeerCertificate !== 'function') return null;
  let cert;
  try {
    cert = socket.getPeerCertificate();
  } catch {
    return null;
  }
  if (!cert || !cert.valid_to) return null;
  const validTo = new Date(cert.valid_to);
  if (!Number.isFinite(validTo.getTime())) return null;
  const validFrom = new Date(cert.valid_from);
  return {
    validTo: validTo.toISOString(),
    validFrom: Number.isFinite(validFrom.getTime()) ? validFrom.toISOString() : null,
    issuer: nameOf(cert.issuer),
    subject: nameOf(cert.subject),
    authorized: socket.authorized === true,
  };
}
