import { normalizeIncidents } from './derive.js';

// Reads only existing endpoints. Incident history is per site; when any of
// those reads fails the overview shows history panels as unavailable instead
// of guessing, while current status still renders.
export async function loadDashboard(api, now = Date.now()) {
  const [me, sitesRes, hbRes, pageRes] = await Promise.all([
    api('/me'),
    api('/sites'),
    api('/heartbeats'),
    api('/status-page'),
  ]);
  const sites = sitesRes?.sites || [];
  const heartbeats = hbRes?.heartbeats || [];
  const results = await Promise.allSettled(
    sites.map((s) => api(`/sites/${encodeURIComponent(s.id)}/incidents`))
  );
  const incidentsBySite = {};
  let historyError = false;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') incidentsBySite[sites[i].id] = normalizeIncidents(r.value?.incidents);
    else {
      if (r.reason?.status === 401) throw r.reason;
      historyError = true;
    }
  });
  return {
    loaded: true,
    fetchedAt: now,
    me,
    sites,
    heartbeats,
    statusPage: pageRes?.status_page || null,
    incidentsBySite,
    historyError,
  };
}
