import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';

export function newApiKey() {
  return `mrz_${randomBytes(24).toString('hex')}`;
}

export function newSessionToken() {
  return randomBytes(24).toString('hex');
}

export function hashSecret(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function apiKeyPrefix(key) {
  return String(key).slice(0, 8);
}

export function hashesEqual(a, b) {
  try {
    const left = Buffer.from(String(a), 'hex');
    const right = Buffer.from(String(b), 'hex');
    if (left.length !== right.length || left.length === 0) return false;
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

const DUMMY_HASH = hashSecret('mrz_' + '00'.repeat(24));

export function matchLookupHash(presented, storedHash) {
  const computed = hashSecret(presented);
  const ok = hashesEqual(computed, storedHash || DUMMY_HASH);
  return ok && Boolean(storedHash);
}
