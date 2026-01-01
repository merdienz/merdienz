import { assertProbeBServerConfig } from './probes/server-config.js';
import { isStrongProbeSecret, normalizeMode, allowsInProcessProbe, allowsPrivateTargets, defaultUserTier } from './probes/mode.js';
import { parseSpkiPin } from './probes/pin.js';

export { isStrongProbeSecret, normalizeMode, allowsInProcessProbe, allowsPrivateTargets, defaultUserTier, assertProbeBServerConfig };

function requireHttpsProbeUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    const err = new Error('PROBE_B_URL must be a valid https URL when MERDIENZ_MODE=cloud');
    err.code = 'PROBE_B_URL';
    throw err;
  }
  if (parsed.protocol !== 'https:') {
    const err = new Error('PROBE_B_URL must be https when MERDIENZ_MODE=cloud');
    err.code = 'PROBE_B_TLS';
    throw err;
  }
}

export function assertProbeConfig(config) {
  const mode = normalizeMode(config.merdienzMode);
  if (mode === 'cloud') {
    if (!config.probeBUrl) {
      const err = new Error('PROBE_B_URL is required when MERDIENZ_MODE=cloud');
      err.code = 'PROBE_B_REQUIRED';
      throw err;
    }
    requireHttpsProbeUrl(config.probeBUrl);
    if (!isStrongProbeSecret(config.probeBSecret)) {
      const err = new Error(
        'PROBE_B_SECRET is required when MERDIENZ_MODE=cloud (at least 32 bytes, not a default value)'
      );
      err.code = 'PROBE_B_SECRET';
      throw err;
    }
    if (!parseSpkiPin(config.probeBSpkiSha256)) {
      const err = new Error(
        'PROBE_B_SPKI_SHA256 is required when MERDIENZ_MODE=cloud (SHA-256 of the probe certificate SPKI, hex or base64)'
      );
      err.code = 'PROBE_B_PIN';
      throw err;
    }
    return;
  }
  if (mode === 'selfhosted' && config.probeBUrl && !isStrongProbeSecret(config.probeBSecret)) {
    const err = new Error(
      'PROBE_B_SECRET must be at least 32 bytes and not a default value when PROBE_B_URL is set'
    );
    err.code = 'PROBE_B_SECRET';
    throw err;
  }
  if (mode === 'selfhosted' && !config.probeBUrl && !isStrongProbeSecret(config.probeBSecret || '')) {
    const err = new Error(
      'PROBE_B_SECRET is required when MERDIENZ_MODE=selfhosted (at least 32 bytes, not a default value)'
    );
    err.code = 'PROBE_B_SECRET';
    throw err;
  }
}
