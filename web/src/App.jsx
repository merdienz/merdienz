import { useEffect, useState } from 'react';
import { api, getToken, setToken } from './api.js';
import Overview from './dashboard/Overview.jsx';

function statusColor(status) {
  if (status === 'up') return 'bg-emerald-500';
  if (status === 'down') return 'bg-rose-500';
  if (status === 'late' || status === 'unconfirmed' || status === 'degraded') return 'bg-amber-400';
  return 'bg-slate-300';
}

function UptimeBars({ bars }) {
  const slice = (bars || []).slice(-90);
  return (
    <div className="flex h-8 gap-px" title="Daily uptime, last 90 days">
      {slice.map((bar) => {
        const color =
          bar.uptime == null ? 'bg-slate-200' : bar.uptime >= 0.99 ? 'bg-emerald-500' : bar.uptime >= 0.9 ? 'bg-amber-400' : 'bg-rose-500';
        return <div key={bar.date} className={`flex-1 rounded-sm ${color}`} title={`${bar.date}: ${bar.uptime == null ? 'no data' : `${Math.round(bar.uptime * 1000) / 10}%`}`} />;
      })}
    </div>
  );
}

function PublicStatus({ slug }) {
  const [page, setPage] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api(`/status/${encodeURIComponent(slug)}`, { auth: false, accept: 'application/json' })
      .then(setPage)
      .catch((err) => setError(err.status === 404 ? 'This status page was not found.' : err.message));
  }, [slug]);

  if (error) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <h1 className="text-2xl font-semibold">Status</h1>
        <p className="mt-3 text-slate-600">{error}</p>
      </div>
    );
  }
  if (!page) return <div className="p-8 text-slate-500">Loading…</div>;

  return (
    <div className="mx-auto max-w-3xl p-8">
      <p className="text-sm text-slate-500">Merdienz</p>
      <h1 className="mt-1 text-3xl font-semibold">{page.title}</h1>
      <p className="mt-2 flex items-center gap-2 text-sm">
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${statusColor(page.overall)}`} />
        <span className="capitalize">{page.overall}</span>
      </p>
      <div className="mt-8 space-y-4">
        {page.checks.map((check) => (
          <section key={`${check.type}-${check.name}`} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="font-medium">{check.name}</h2>
                <p className="text-xs text-slate-500">
                  {check.type}
                  {check.uptime_90d != null ? ` · ${Math.round(check.uptime_90d * 1000) / 10}% over 90 days` : ''}
                </p>
              </div>
              <span className="flex items-center gap-2 text-sm capitalize">
                <span className={`inline-block h-2.5 w-2.5 rounded-full ${statusColor(check.status)}`} />
                {check.status}
              </span>
            </div>
            <div className="mt-3">
              <UptimeBars bars={check.bars} />
            </div>
            {check.incidents?.length ? (
              <ul className="mt-3 space-y-1 text-xs text-slate-600">
                {check.incidents.slice(0, 5).map((inc, i) => (
                  <li key={i}>
                    {inc.status === 'open' ? 'Open' : 'Resolved'} incident from {new Date(inc.started_at).toLocaleString()}
                    {inc.ended_at ? ` to ${new Date(inc.ended_at).toLocaleString()}` : ''}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-xs text-slate-400">No recent incidents.</p>
            )}
          </section>
        ))}
        {!page.checks.length && <p className="text-slate-500">No public checks yet.</p>}
      </div>
    </div>
  );
}

function useSignupEnabled() {
  const [enabled, setEnabled] = useState(null);
  useEffect(() => {
    api('/auth/signup', { auth: false })
      .then((res) => setEnabled(Boolean(res?.enabled)))
      .catch(() => setEnabled(false));
  }, []);
  return enabled;
}

function Login({ onSignedIn }) {
  const signupEnabled = useSignupEnabled();
  const [email, setEmail] = useState(() => new URLSearchParams(window.location.search).get('email') || '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const signedUp = new URLSearchParams(window.location.search).get('signed_up') === '1';

  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      const result = await api('/auth/login', { method: 'POST', body: { email, password }, auth: false });
      setToken(result.token);
      onSignedIn();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="mx-auto mt-16 max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="text-xl font-semibold">Sign in to Merdienz</h1>
      <form onSubmit={submit} className="mt-4 space-y-3">
        <input className="w-full rounded-lg border border-slate-300 px-3 py-2" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input className="w-full rounded-lg border border-slate-300 px-3 py-2" type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {signedUp && !error && <p className="text-sm text-emerald-700">If this email is new, your account is ready. Sign in to continue.</p>}
        {error && <p className="text-sm text-rose-600">{error}</p>}
        <button className="w-full rounded-lg bg-slate-900 px-3 py-2 text-white" type="submit">
          Sign in
        </button>
      </form>
      {signupEnabled && (
        <p className="mt-4 text-sm text-slate-600">
          New to Merdienz?{' '}
          <a className="text-sky-700 underline" href="/signup">
            Create an account
          </a>
        </p>
      )}
    </div>
  );
}

function Signup() {
  const signupEnabled = useSignupEnabled();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const minLength = 12;

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (password.length < minLength) {
      setError(`Password must be at least ${minLength} characters.`);
      return;
    }
    setBusy(true);
    try {
      const { csrf } = await api('/csrf-token', { auth: false });
      await api('/auth/signup', { method: 'POST', body: { email, password }, auth: false, csrf });
      const normalized = email.trim().toLowerCase();
      window.location.assign(`/?signed_up=1&email=${encodeURIComponent(normalized)}`);
    } catch (err) {
      setError(err.status === 429 ? 'Too many attempts. Please wait a few minutes and try again.' : err.message);
      setBusy(false);
    }
  }

  if (signupEnabled === null) return <div className="p-8 text-slate-500">Loading…</div>;
  if (!signupEnabled) {
    return (
      <div className="mx-auto mt-16 max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold">Sign-up is not available</h1>
        <p className="mt-3 text-sm text-slate-600">
          <a className="text-sky-700 underline" href="/">
            Sign in
          </a>
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto mt-16 max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="text-xl font-semibold">Create your Merdienz account</h1>
      <form onSubmit={submit} className="mt-4 space-y-3">
        <input className="w-full rounded-lg border border-slate-300 px-3 py-2" type="email" placeholder="Email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input className="w-full rounded-lg border border-slate-300 px-3 py-2" type="password" placeholder={`Password (at least ${minLength} characters)`} autoComplete="new-password" minLength={minLength} maxLength={1024} value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <p className="text-sm text-rose-600">{error}</p>}
        <button className="w-full rounded-lg bg-slate-900 px-3 py-2 text-white disabled:opacity-60" type="submit" disabled={busy}>
          Create account
        </button>
      </form>
      <p className="mt-4 text-sm text-slate-600">
        Already have an account?{' '}
        <a className="text-sky-700 underline" href="/">
          Sign in
        </a>
      </p>
    </div>
  );
}

export default function App() {
  const path = window.location.pathname;
  const statusMatch = path.match(/^\/status\/([^/]+)\/?$/);
  if (statusMatch) return <PublicStatus slug={decodeURIComponent(statusMatch[1])} />;
  if (/^\/signup\/?$/.test(path)) {
    if (getToken()) {
      window.location.replace('/');
      return null;
    }
    return <Signup />;
  }
  if (!getToken()) return <Login onSignedIn={() => window.location.assign('/')} />;
  return <Overview />;
}
