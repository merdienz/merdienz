const WEAK_SECRETS = new Set([
  '',
  'dev-probe-secret-change-me',
  'change-me-to-a-long-random-string',
  'test-probe-secret',
]);

const INPROCESS_MODES = new Set(['dev', 'test', 'selfhosted']);
const VALID_MODES = new Set(['cloud', 'selfhosted', 'dev', 'test']);

export function normalizeMode(mode) {
  const value = String(mode || 'cloud').toLowerCase();
  return VALID_MODES.has(value) ? value : 'cloud';
}

export function allowsInProcessProbe(config) {
  return INPROCESS_MODES.has(normalizeMode(config.merdienzMode));
}

export function isStrongProbeSecret(secret) {
  if (typeof secret !== 'string') return false;
  if (Buffer.byteLength(secret, 'utf8') < 32) return false;
  if (WEAK_SECRETS.has(secret) || WEAK_SECRETS.has(secret.trim())) return false;
  return true;
}

export function allowsPrivateTargets(config) {
  if (normalizeMode(config.merdienzMode) === 'cloud') return false;
  return Boolean(config.allowPrivateTargets);
}

export function defaultUserTier(mode) {
  // Cloud accounts start with no plan. Dev, test, and self-hosted stay
  // unlimited so local work does not need a paid cloud tier.
  return normalizeMode(mode) === 'cloud' ? 'no_plan' : 'selfhosted';
}
