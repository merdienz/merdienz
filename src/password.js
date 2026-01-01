import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scryptAsync(password, salt, 32);
  return `scrypt$${salt}$${key.toString('hex')}`;
}

const dummyHashPromise = hashPassword('merdienz-unknown-user-dummy');

async function verifyAgainst(password, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, salt, hex] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hex) return false;
  const key = await scryptAsync(password, salt, 32);
  const expected = Buffer.from(hex, 'hex');
  if (expected.length !== key.length) return false;
  return timingSafeEqual(expected, key);
}

export async function verifyPassword(password, stored) {
  const hash = stored || (await dummyHashPromise);
  const ok = await verifyAgainst(password, hash);
  return Boolean(stored) && ok;
}
