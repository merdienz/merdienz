const DEFAULT_SKEW_SEC = 60;

export function createReplayCache({ maxSkewSec = DEFAULT_SKEW_SEC } = {}) {
  const seen = new Map();

  function sweep(now) {
    const cutoff = now - (maxSkewSec * 2 + 5) * 1000;
    for (const [key, ts] of seen) {
      if (ts < cutoff) seen.delete(key);
    }
  }

  return {
    maxSkewSec,
    seen(key, now = Date.now()) {
      sweep(now);
      if (seen.has(key)) return true;
      seen.set(key, now);
      return false;
    },
    has(key) {
      return seen.has(key);
    },
    size() {
      return seen.size;
    },
  };
}

export const defaultReplayCache = createReplayCache();
