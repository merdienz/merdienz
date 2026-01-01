export async function pingDeadMan(url, fetchFn = fetch) {
  if (!url) return { skipped: true };
  const started = Date.now();
  try {
    const res = await fetchFn(url, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
      headers: { 'user-agent': 'MerdienzMonitor/1.0' },
    });
    return { ok: res.ok, status: res.status, latencyMs: Date.now() - started, skipped: false };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: err.message || 'heartbeat failed',
      latencyMs: Date.now() - started,
      skipped: false,
    };
  }
}
