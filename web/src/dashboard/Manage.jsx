import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

// Check and status-page management, kept from the earlier dashboard. Accounts
// without an active plan get an honest note instead of forms that would be
// refused, and there are no plan or purchase buttons here.
export default function Manage({ data, noPlan, reload }) {
  const [error, setError] = useState('');
  const [siteForm, setSiteForm] = useState({ name: '', url: '', interval_seconds: 300 });
  const [hbForm, setHbForm] = useState({ name: '', period_seconds: 3600, grace_seconds: 300 });
  const [pageForm, setPageForm] = useState({ title: '', slug: '' });
  const statusPage = data.statusPage;
  const sites = data.sites || [];
  const heartbeats = data.heartbeats || [];

  useEffect(() => {
    if (statusPage) setPageForm({ title: statusPage.title, slug: statusPage.slug });
  }, [statusPage?.id, statusPage?.title, statusPage?.slug]);

  async function run(fn) {
    setError('');
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(err.message);
    }
  }

  function addSite(e) {
    e.preventDefault();
    run(async () => {
      await api('/sites', { method: 'POST', body: { ...siteForm, interval_seconds: Number(siteForm.interval_seconds) } });
      setSiteForm({ name: '', url: '', interval_seconds: 300 });
    });
  }

  function addHeartbeat(e) {
    e.preventDefault();
    run(async () => {
      await api('/heartbeats', {
        method: 'POST',
        body: { name: hbForm.name, period_seconds: Number(hbForm.period_seconds), grace_seconds: Number(hbForm.grace_seconds) },
      });
      setHbForm({ name: '', period_seconds: 3600, grace_seconds: 300 });
    });
  }

  function savePage(e) {
    e.preventDefault();
    run(() => api('/status-page', { method: 'PUT', body: pageForm }));
  }

  function togglePublish(kind, id, value) {
    run(() => api(`/${kind}/${id}`, { method: 'PATCH', body: { public_on_status: value } }));
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setError('Copy failed; select the text and copy it by hand.');
    }
  }

  const publicUrl = useMemo(() => (statusPage ? `${window.location.origin}/status/${statusPage.slug}` : ''), [statusPage]);

  return (
    <>
      <section className="panel col-12 manage" id="manage" aria-labelledby="manage-h">
        <div className="panel-h">
          <h2 id="manage-h">Manage checks</h2>
        </div>
        <div className="panel-b">
          {error ? <p className="err" role="alert">{error}</p> : null}
          {noPlan ? (
            <p className="note" data-no-plan="true">Adding checks and status pages needs an active plan. This account doesn't have one yet.</p>
          ) : (
            <form onSubmit={addSite} className="form-row" aria-label="Add a website check">
              <input id="site-name" className="inp" placeholder="Name" aria-label="Check name" value={siteForm.name} onChange={(e) => setSiteForm({ ...siteForm, name: e.target.value })} required />
              <input className="inp wide" placeholder="https://example.com" aria-label="URL to check" value={siteForm.url} onChange={(e) => setSiteForm({ ...siteForm, url: e.target.value })} required />
              <button className="btn" type="submit">Add site</button>
            </form>
          )}
          <ul className="mlist">
            {sites.map((site) => (
              <li key={site.id}>
                <div>
                  <div className="nm">{site.name}</div>
                  <div className="sub">{site.url} · every {site.interval_seconds}s · {site.current_status}</div>
                </div>
                <div className="acts">
                  <label>
                    <input type="checkbox" checked={!!site.public_on_status} onChange={(e) => togglePublish('sites', site.id, e.target.checked)} />
                    Public
                  </label>
                </div>
              </li>
            ))}
            {!sites.length && <li className="sub">No website checks yet.</li>}
          </ul>

          {noPlan ? null : (
            <form onSubmit={addHeartbeat} className="form-row" aria-label="Add a heartbeat check">
              <input className="inp" placeholder="Heartbeat name" aria-label="Heartbeat name" value={hbForm.name} onChange={(e) => setHbForm({ ...hbForm, name: e.target.value })} required />
              <input className="inp" type="number" min="1" aria-label="Period in seconds" value={hbForm.period_seconds} onChange={(e) => setHbForm({ ...hbForm, period_seconds: e.target.value })} />
              <input className="inp" type="number" min="0" aria-label="Grace in seconds" value={hbForm.grace_seconds} onChange={(e) => setHbForm({ ...hbForm, grace_seconds: e.target.value })} />
              <button className="btn" type="submit">Add heartbeat</button>
            </form>
          )}
          <ul className="mlist">
            {heartbeats.map((hb) => (
              <li key={hb.id}>
                <div>
                  <div className="nm">{hb.name}</div>
                  <div className="sub">{hb.period_seconds ? `every ${hb.period_seconds}s` : hb.cron_expr} · {hb.status}</div>
                </div>
                <div className="acts">
                  <button className="linkbtn" type="button" onClick={() => copy(hb.snippets.curl)}>Copy curl</button>
                  <button className="linkbtn" type="button" onClick={() => copy(hb.snippets.cron)}>Copy cron</button>
                  <label>
                    <input type="checkbox" checked={!!hb.public_on_status} onChange={(e) => togglePublish('heartbeats', hb.id, e.target.checked)} />
                    Public
                  </label>
                </div>
              </li>
            ))}
            {!heartbeats.length && <li className="sub">No heartbeat checks yet.</li>}
          </ul>
        </div>
      </section>

      <section className="panel col-12 manage" aria-labelledby="page-h">
        <div className="panel-h">
          <h2 id="page-h">Public status page</h2>
        </div>
        <div className="panel-b">
          {noPlan && !statusPage ? (
            <p className="note">A public status page needs an active plan.</p>
          ) : (
            <form onSubmit={savePage} className="form-row three" aria-label="Status page">
              <input className="inp" placeholder="Title" aria-label="Status page title" value={pageForm.title} onChange={(e) => setPageForm({ ...pageForm, title: e.target.value })} required />
              <input className="inp" placeholder="share-slug" aria-label="Status page address" value={pageForm.slug} onChange={(e) => setPageForm({ ...pageForm, slug: e.target.value })} required />
              <button className="btn" type="submit">Save</button>
            </form>
          )}
          {publicUrl ? (
            <p className="note share">Share: <a href={publicUrl}>{publicUrl}</a></p>
          ) : null}
        </div>
      </section>
    </>
  );
}
