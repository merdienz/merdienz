# Merdienz

Uptime monitoring with two-probe confirmation and plan gates from the first commit.

Free use is the self-hosted package, which is unlimited. There is no free cloud tier: a cloud account needs an active starter or pro plan to create monitors, heartbeats, or status pages. Existing data stays readable.

## Requirements

- Node.js 22 or newer (`engines` is `>=22`; `.nvmrc` pins 22). Tests on this tree have also been run on Node 24.
- PostgreSQL 16+ *or* the bundled embedded Postgres used for local dev and tests. Docker is not required for development.

Local development servers and tests bind to ports **4840–4859**. Set `MERDIENZ_TEST_PORT_OFFSET` (for example `220` for 5060–5079) to move every port the test suite binds. A second probe process defaults to port **7801** in production-style configuration.

Install dependencies with `npm ci` when a lockfile is present (`npm install` only when you intend to change it).

## Self-hosted deploy (~5 minutes)

This is the supported way to run Merdienz on your own machine or VPS. The bundled Compose file starts the app and a private Postgres instance, sized for about 1 vCPU and 1 GB of RAM. Put TLS on a reverse proxy in front of the published app port. Do not terminate public HTTPS inside the Node process.

**Safe defaults (do not weaken these unless you understand the risk):**

- There is no default administrator and no default password. The first account is created at `/setup` with a one-time token. The process writes that token to a mode `0600` file and logs only the file path (the token itself is not printed).
- If `MERDIENZ_MODE` is unset, the app defaults to `cloud`, which is stricter (closed sign-up until setup, plan gates). The Compose file sets `MERDIENZ_MODE=selfhosted` explicitly.
- `ALLOW_PRIVATE_TARGETS` is off unless you set it to the exact string `true`.
- Mail transport in Compose defaults to `none` until you configure a transport.
- Compose publishes the app port on loopback only (`127.0.0.1:4840`). Postgres stays on an internal Docker network and is not published. Do not commit your `.env`.

**1. Copy and edit the environment file**

```bash
cp .env.example .env
```

Set a strong `POSTGRES_PASSWORD`. Compose also requires `PROBE_B_SECRET` (32 bytes or more), even if you do not start the optional second probe. Optionally set `PUBLIC_URL` to the `https://` origin people will type. Leave `HOST` unset on the host itself; Compose sets `HOST=0.0.0.0` only inside the app container so the proxy can reach it on the Docker network.

**2. Start the stack**

```bash
docker compose up --build -d
```

**3. Create the first account**

When the app is healthy, a start-up log line names the setup-token file. Read that file on the server and submit the token with the first account email and password at `/setup` (or with the `curl` example in [Dev quickstart](#dev-quickstart)). There is no default operator account.

**4. Put TLS in front**

Point a reverse proxy at `http://127.0.0.1:4840` and terminate TLS there. A minimal sketch is in [TLS and reverse proxy](#tls-and-reverse-proxy). Set `PUBLIC_URL` to that `https://` origin. If you need the proxy to run on another host, change the published port bind in Compose deliberately; the loopback bind is the safe default.

The optional `probe-b` Compose profile expects `./tls/cert.pem` and `./tls/key.pem` (or `PROBE_B_TLS_DIR`) and a matching secret and certificate pin. Nothing in this repository is a live deploy.


## Dev quickstart

```bash
cp .env.example .env
npm ci
npm run dev
```

With `DATABASE_URL` unset, `npm run dev` starts an embedded Postgres on `127.0.0.1:4842` and the API on `http://127.0.0.1:4840` only when `MERDIENZ_MODE` is explicitly `dev` or `test` and `NODE_ENV` is not `production`. The default mode is `cloud` (fail-closed) and always requires `DATABASE_URL`. `selfhosted` and `cloud` never start the bundled database. For a local sandbox set `MERDIENZ_MODE=dev` in `.env`; do not leave a copied dev override on a real deployment.

There is no default administrator. On a first run with an empty users table the process writes a **setup token once** to a mode-0600 file and logs only the path (the token itself is not printed). The file name always gets a random 16-hex suffix: `$MERDIENZ_SETUP_TOKEN_FILE-<suffix>` if that variable is set, otherwise a `merdienz-setup-token-<suffix>` file in the process temporary directory. The process logs the final path. Read the file and use the token immediately:

```bash
curl -s -H 'content-type: application/json' \
  -d '{"token":"<setup-token>","email":"you@example.com","password":"choose-a-password"}' \
  http://127.0.0.1:4840/setup
```

The response includes an API key, shown once. If the setup token was already issued and you lost the file, clear the unused `setup_tokens` row, remove the token file, and restart to mint a new one. You can also create later users with `npm run create-user` once `DATABASE_URL` points at Postgres.

Add, list, and delete a site:

```bash
export KEY=mrz_...
curl -s -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -d '{"name":"Example","url":"https://example.com"}' \
  http://127.0.0.1:4840/sites

curl -s -H "X-API-Key: $KEY" http://127.0.0.1:4840/sites

curl -s -X DELETE -H "X-API-Key: $KEY" http://127.0.0.1:4840/sites/<id>
```

You can also log in for a session token:

```bash
curl -s -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"choose-a-password"}' \
  http://127.0.0.1:4840/auth/login
# then send X-Session-Token: <token> or Authorization: Bearer <token>
```

```bash
npm test
npm run lint
```

`CREATE EXTENSION pgcrypto` (used when hashing existing rows during migrate) needs a role that can create extensions on managed Postgres.

### Cloud sign-up

With `MERDIENZ_MODE` set to exactly `cloud` (no other spelling or casing, and not left unset) and `COOKIE_SECRET` set, and once first-run `/setup` has created the first account (sign-up returns 404 until then), anyone can create an account at `/signup` (linked from the sign-in page) or with `POST /auth/signup { email, password }`. The request needs the CSRF token from `GET /csrf-token` (sent as `x-csrf-token`, with the `_csrf` cookie). New accounts always start on `no_plan`; a paid tier only comes from a verified billing webhook, and fields such as `tier`, `plan` or `role` in the body are rejected. Passwords must be 12 to 1024 characters. The email is trimmed and lowercased. The response is the same whether or not the email already had an account, so sign in afterwards. Attempts are limited per client IP (5 a minute, using the trusted-proxy address), per client IP and email (5 per 15 minutes) and per email from all clients (20 per 15 minutes). Only well-formed requests count, and a client over its own limit adds nothing to the per-email count, so one client cannot lock someone else's email out. In `selfhosted`, `dev` and `test` modes the sign-up routes do not exist and `/setup` stays the only way to create the first account.

## TLS and reverse proxy

Terminate TLS in front of the API. A minimal reverse-proxy sketch:

```nginx
server {
  listen 443 ssl http2;
  ssl_certificate     /etc/tls/fullchain.pem;
  ssl_certificate_key /etc/tls/privkey.pem;
  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
  location / {
    proxy_pass http://127.0.0.1:4840;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
  }
}
```

Set `PUBLIC_URL` to the public `https://` origin and, if the proxy is trusted to set forwarding headers, list it in `TRUSTED_PROXIES`. For a proxy on the same host, for example:

```
TRUSTED_PROXIES=127.0.0.1
PUBLIC_URL=https://status.example.com
```

The app sets `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`, and `frame-ancestors 'none'`. Cookies use `HttpOnly`, `SameSite=Lax`, and `Secure` in production or cloud mode. Cookie-authenticated state-changing requests require a CSRF token from `GET /csrf-token` (when `COOKIE_SECRET` is set). API-key and `x-session-token` / bearer session auth do not.

The self-hosted Compose package, including the optional `probe-b` profile, is described in [Self-hosted deploy (~5 minutes)](#self-hosted-deploy-5-minutes). Static compose checks live in `scripts/check-compose.js`. A longer self-hosting guide is in [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

## How checks work

1. The scheduler is a database-backed loop. Each cycle it loads sites whose interval has elapsed, retries pending alerts, and prunes old sent and exhausted failed alert rows.
2. **Probe A** does an HTTP/HTTPS GET (connect timeout, total timeout, latency, status, 1 MB response cap). Redirects are off by default; if following is enabled, each hop is re-checked. Up means `2xx,3xx` by default; override per site with `up_status_codes` (for example `200,204` or `200-299`).
3. If A fails, the primary asks **probe B** to re-check over an HMAC-signed request (`X-Probe-Timestamp`, `X-Probe-Nonce`, `X-Probe-Signature`). The default replay window is 60 seconds.
4. The site is marked **DOWN** and an alert is sent only when both probes fail. If B succeeds or cannot be reached, the result is recorded as **unconfirmed** and no down alert is sent.
5. A **recovery** email is sent when a site that was down is up again.
6. After every cycle the monitor pings a configurable dead-man URL (`HEARTBEAT_URL`) so a watcher can notice if Merdienz itself goes silent.

`MERDIENZ_MODE` is `cloud` (the default), `selfhosted`, or `dev`. Cloud mode refuses to start without an `https` `PROBE_B_URL`, a strong `PROBE_B_SECRET` (at least 32 bytes, not a placeholder), and `PROBE_B_SPKI_SHA256`. The `/internal/probe` route is not mounted on the primary API.

## Dashboard and public status page

The dashboard is a small React + Tailwind app in `web/`, built with Vite.

```bash
npm run dev          # API on :4840 (embedded Postgres if DATABASE_URL is unset)
npm run dev:web      # Vite dev server on :4843, proxied to the API
```

Sign in with the user you created. The overview shows checks up and open incidents now, uptime for the selected range (1h, 6h, 24h, 7d or 30d) next to the previous period of the same length, a per-check status timeline, and recent down and recovery events. Everything is worked out in the browser from `/sites`, `/sites/:id/incidents` and `/heartbeats`; response times are not shown because the API does not expose them. The range and the selected check are kept in the URL (`?range=7d&check=<id>`). Fonts (Space Grotesk, Instrument Sans, JetBrains Mono) are bundled in `web/public/fonts` with their OFL licenses, so the page makes no outside requests. Below the overview you can add sites and heartbeat checks and copy curl or cron snippets; accounts without an active plan see a note instead of those forms. Each check can be opted in to a public status page (`public_on_status`). Set a title and shareable slug under "Public status page". Private checks never appear on that page.

```bash
npm run build:web
```

`npm run dev` (and the Docker image) serves the built files from `web/dist`. The public page is `/status/<slug>`. Browsers get the HTML app; `GET /status/<slug>` with `Accept: application/json` returns the payload (current status, 90-day uptime bars, recent incidents).

### Second probe process

The probe process starts from `src/probe-b-server.js` and `src/probes/*` plus production dependencies. Both the Cloud app and probe B prefer **`PROBE_B_SECRET`**. `PROBE_B_HMAC_SECRET` is still accepted as a fallback so existing env files keep working. If both are set, they must be the same value; a mismatch is an error. The secret must be at least 32 bytes and not a placeholder.

Both roles require an explicit `HOST`; behind a same-host reverse proxy use `HOST=127.0.0.1`. Probe B reads `HOST` from its env file and refuses `0.0.0.0` and `::`.

```bash
# on the second probe host
export PROBE_B_SECRET=the-shared-secret
# PROBE_B_HMAC_SECRET is accepted as a fallback if PROBE_B_SECRET is unset
export HOST=127.0.0.1
export PROBE_B_PORT=7801
# cloud (and recommended everywhere): TLS 1.3
export MERDIENZ_MODE=cloud
export PROBE_B_TLS_CERT=/etc/merdienz-probe/tls/cert.pem
export PROBE_B_TLS_KEY=/etc/merdienz-probe/tls/key.pem
npm run probe-b
```

On the primary, set `PROBE_B_URL=https://<probe-host>:7801/internal/probe`, the same secret in `PROBE_B_SECRET`, and the certificate pin:

```bash
# SPKI SHA-256, base64 (hex is also accepted)
openssl x509 -in cert.pem -noout -pubkey \
  | openssl pkey -pubin -outform der \
  | openssl dgst -sha256 -binary \
  | openssl base64
export PROBE_B_SPKI_SHA256=...
```

The primary does not trust public certificate authorities for this hop; it only accepts the pinned SPKI. Optional TLS can be enabled in self-hosted mode the same way; cloud mode will not start the probe process without it.

Set `ALLOW_PRIVATE_TARGETS=true` only on self-hosted or dev if you really need to monitor loopback or private URLs (off by default, ignored in cloud mode).

## Plan gates

Every authenticated request loads `users.tier` and the matching `plan_gates` row from the database. Client-supplied `tier` fields or `X-Tier` headers are rejected. There is no in-memory override path.

| Tier | HTTP monitors | Heartbeats | Min interval | Status pages | History | Seats |
|---|---|---|---|---|---|---|
| `selfhosted` | unlimited | unlimited | none | unlimited | unlimited | unlimited |
| `starter` | 15 | 5 | 60s | 1 | 12 months | 1 |
| `pro` | 60 | 25 | 30s | 5 | 24 months | 3 |
| `no_plan` | none (create refused) | none (create refused) | — | none (create refused) | existing data kept | — |

New cloud users start with `no_plan`. The legacy `cloud` row is kept only so older user rows still load; it grants no entitlements. Alert channels on starter and pro are email, Slack, Discord, and webhook. Feature flags `ssl_check`, `domain_expiry`, and `seo_check` are stored on the plan and are not prices. They switch on the checks in [SSL, domain, and SEO checks](#ssl-domain-and-seo-checks): `starter` has SSL and domain expiry, and basic SEO checks are on `pro` (and `selfhosted`). The dashboard does not show these checks yet; they are available through the API.

Default check interval is 300 seconds, then the gate is applied. The `selfhosted` tier is not honor-capped.

## SSL, domain, and SEO checks

These run only for sites on a plan whose flag is on (`ssl_check`, `domain_expiry`, `seo_check`; the `selfhosted` tier has all three).

- **SSL certificate expiry.** Every HTTPS check reads the certificate from the connection it already made (no second connection). Merdienz stores the expiry date and issuer, and emails the site owner when the certificate has 30, 14, 7, and 1 days left, and again on its final day. An expired or otherwise invalid certificate fails the check itself and raises the normal down alert. Each reminder is sent once per certificate; a renewed certificate starts a new series.
- **Domain registration expiry.** Off by default. Set `DOMAIN_EXPIRY_LOOKUP=rdap` to look up the registrable domain's expiry date over RDAP, the free registry protocol that replaced WHOIS (no API key). The RDAP service for each TLD comes from the IANA bootstrap file (`RDAP_BOOTSTRAP_URL`, https only, cached for a day). Lookups run at most once a day per site, and the same 30, 14, 7, 1, and final-day reminders are sent (plus one after expiry). Multi-label suffixes are matched against a short built-in list, not the full public suffix list.
- **Basic SEO checks.** Once a day per site (`SEO_CHECKS=on`, the default), Merdienz fetches the page and `/robots.txt` and checks for a `<title>`, a meta description, an `<h1>`, a `noindex` robots meta tag or `X-Robots-Tag` header, and a robots.txt that blocks all crawlers from the whole site. The first result is a silent baseline. After that, an email is sent only when a new issue appears (a regression).

Every request for these checks goes through the same SSRF guard as monitor checks: pinned DNS, every redirect hop re-checked (at most 3), a 1 MB response cap, and connect and overall timeouts. Private targets are refused unless a self-hosted operator sets `ALLOW_PRIVATE_TARGETS=true`. Page HTML is treated as untrusted text: it is scanned with bounded patterns and never executed, rendered, or stored in full. Each tick picks at most one site per account (`INSIGHTS_PER_TICK`, default 5, caps the total), so one large account cannot hold back others.

`GET /sites/:id/insights` returns the stored SSL, domain, and SEO results for a site you own. Sections the plan does not include return `{ "enabled": false }`.

## Heartbeat checks

Heartbeat checks are for cron jobs, backups, and scripts: the job pings Merdienz, and Merdienz alerts when a ping is late or missing. They are gated by `plan_gates.heartbeat_check_count` (`selfhosted` is unlimited).

```bash
curl -s -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -d '{"name":"Nightly backup","period_seconds":3600,"grace_seconds":300}' \
  http://127.0.0.1:4840/heartbeats
```

Or a cron expression with a timezone:

```bash
curl -s -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -d '{"name":"Midnight job","cron_expr":"0 0 * * *","timezone":"Asia/Jakarta","grace_seconds":600}' \
  http://127.0.0.1:4840/heartbeats
```

The response includes `ping_urls` and copy-paste snippets for curl, cron, systemd, and GitHub Actions.

| Path | Meaning |
|---|---|
| `GET` or `POST` `/ping/<uuid>` | Success ping |
| `/ping/<uuid>/start` | Job started; the completion window resets |
| `/ping/<uuid>/fail` | Job failed; the check goes **down** and an alert is sent |
| `/ping/<uuid>/<exit>` | Exit code `0` is success; `1`–`255` is failure |

States: `new` (no ping yet, no alerts), `up`, `late` (inside the grace period), `down` (after grace, or an explicit fail), `paused`. A recovery email is sent when a down check is pinged successfully. Each ping is logged with time, source IP, user agent, a short body excerpt, and an optional exit code.

`POST /heartbeats/:id/pause` and `POST /heartbeats/:id/resume` change the paused state. Resume starts a fresh window.

## Email

`MAIL_TRANSPORT` is one of:

- `dev` — in-memory capture (used by tests; nothing is sent)
- `console` — log only
- `smtp` — Nodemailer SMTP to `SMTP_HOST` (default `localhost`; there is no built-in relay) on `SMTP_PORT` (default 465) with implicit TLS (TLS 1.2+, `rejectUnauthorized: true`). When `SMTP_USER` is set, the password is read from `MERDIENZ_SMTP_PASSWORD_FILE` (default `/etc/merdienz-cloud/smtp-password`, expected `root:merdienz` mode 0640 or mode 0600/0400). The file must exist, be readable, non-empty, and not world-readable; a trailing newline is trimmed and the value is never logged. Production refuses plain-text SMTP. Set `SMTP_REQUIRED_HOST` to make production refuse any other relay. `MAIL_FROM` defaults to `alert@merdienz.com` and must be a single merdienz.com address.
- `none` — do not send; outbox rows are marked skipped. This is the Cloud default until SMTP is switched on.

Production (`NODE_ENV=production`) and `MERDIENZ_MODE=cloud` refuse `dev` and `console`. Leave `MAIL_TRANSPORT` at `none` until a test alert has been sent and received, then set it to `smtp` and restart.

A single test alert (no app restart required, and it works while transport is still `none`):

```
npm run mail:test -- --dry-run --to <addr>
npm run mail:test -- --send --to <addr>
```

Without `--send` the command is a dry-run and does not connect. A live send requires `--send` and `--to`, and prints only the SMTP response id.

## Billing

Cloud billing is Stripe Checkout in subscription mode (TEST keys only). Plans are Starter at $4.99/month or $49.90/year, and Pro at $19.99/month or $199/year. Price IDs come from env (`STRIPE_PRICE_STARTER_MONTHLY`, `STRIPE_PRICE_STARTER_YEARLY`, `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_PRO_YEARLY`) and are never hardcoded. Seats are not billed yet.

The secret key is read from `MERDIENZ_STRIPE_SECRET_KEY_FILE` (default `/etc/merdienz-cloud/stripe-secret`) and the webhook signing secret from `MERDIENZ_STRIPE_WEBHOOK_SECRET_FILE` (default `/etc/merdienz-cloud/stripe-webhook-secret`). The same secret-file rules as SMTP apply (`root:merdienz` mode 0640, or mode 0600/0400). Missing default files leave billing disabled and the app still starts. An explicit file path that is missing, unreadable, empty, or has bad permissions refuses start. The secret key must be a Stripe TEST key (`sk` or `rk` plus `_test_`). Any other prefix, including live keys (`sk` / `rk` / `pk` plus `_live_`), is refused in every environment. There is no live-key override. Webhook events must have `livemode: false`; a missing or non-false `livemode` is rejected and not stored. The webhook endpoint is pinned to Stripe API version `2025-08-27.basil` (the latest Basil monthly release). The handler logs a warning when `event.api_version` is missing or is not that version. Keys are never logged. Live mode will be a separate, reviewed change later.

A signed-in account owner starts checkout with `POST /billing/checkout` (`{ "plan": "starter"|"pro", "interval": "monthly"|"yearly" }`). That request returns 409 while the account is already `active` or `past_due`. Success and cancel URLs are `{PUBLIC_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}` and `{PUBLIC_URL}/billing/cancel`. Stripe sends events to `POST /billing/webhook`. The handler verifies the raw-body signature (300s tolerance), stores each event id uniquely, ignores older out-of-order events, and updates the account's plan. Events with the same timestamp apply in arrival order. A late `checkout.session.completed` does not resurrect a canceled subscription. Only a `checkout.session.completed` event with `mode` set to `subscription` and a subscription id can activate an account; `invoice.paid` never reactivates a canceled or expired row. Checkout sessions expire after 30 minutes. A second completed checkout that names a different subscription is ignored while the account is already `active` or `past_due`, and a warning is logged for the operator. Invoice subscription ids are read from `invoice.parent.subscription_details.subscription`, then from `invoice.subscription`, as a string or an expanded object. Events with no subscription id, or that name a subscription other than the account's current one, are ignored. Events without a `created` timestamp are refused. A reactivation whose Stripe customer belongs to another account is ignored. Canceling moves the account to the `no_plan` tier; checks stay paused for new sites and heartbeats as well as existing ones, derived from the subscription state at scheduling time. After the first `invoice.payment_failed`, the account has a 14-day grace period counted from that failure; later failed-payment events in the same unpaid period do not extend it. Monitors keep running during grace. On day 15 (`failed_at` + 14 days) that account's site checks and heartbeat evaluations pause (`billing_hold`). Paying resumes them immediately. No data is deleted. Deleting the subscription pauses checks immediately. User pause (`enabled` / heartbeat `paused`) is left alone.

Register the webhook endpoint `{PUBLIC_URL}/billing/webhook` in your Stripe dashboard and install the signing secret into the secret file above. Use test-mode keys while you evaluate. Never commit Stripe keys, other API keys, or secret file contents to the repository.

## API (minimal)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/health` | no |
| `POST` | `/setup` | first-run setup token |
| `POST` | `/auth/login` | no |
| `GET` | `/auth/signup` | no (cloud mode only; 404 elsewhere) |
| `POST` | `/auth/signup` | CSRF token (cloud mode only; 404 elsewhere) |
| `POST` | `/auth/logout` | session |
| `GET` | `/me` | API key or session |
| `GET` | `/sites` | API key or session |
| `GET` | `/sites/:id` | API key or session |
| `POST` | `/sites` | API key or session |
| `DELETE` | `/sites/:id` | API key or session |
| `GET` | `/sites/:id/incidents` | API key or session |
| `GET` | `/sites/:id/insights` | API key or session |
| `GET` | `/heartbeats` | API key or session |
| `GET` | `/heartbeats/:id` | API key or session |
| `POST` | `/heartbeats` | API key or session |
| `POST` | `/heartbeats/:id/pause` | API key or session |
| `POST` | `/heartbeats/:id/resume` | API key or session |
| `DELETE` | `/heartbeats/:id` | API key or session |
| `GET`/`POST` | `/ping/:uuid` and `/start`, `/fail`, `/:code` | ping token |
| `GET` | `/status-page` | API key or session |
| `PUT` | `/status-page` | API key or session |
| `PATCH` | `/sites/:id` | API key or session |
| `PATCH` | `/heartbeats/:id` | API key or session |
| `GET` | `/status/:slug` | public |
| `GET` | `/billing/plans` | no |
| `GET` | `/billing/status` | API key or session |
| `POST` | `/billing/checkout` | API key or session |
| `POST` | `/billing/webhook` | Stripe signature |
| `POST` | `/internal/probe` | HMAC probe signature (probe process only) |

Auth: `X-API-Key`, `Authorization: Bearer mrz_...`, or `X-Session-Token` / `Authorization: Bearer <session>`. Login is constant-time (no user enumeration). Rate limits apply to login, the API, ping URLs, and the probe process.

Ping request bodies are capped at 16 KB. The stored body excerpt may include secrets that a job prints; treat ping logs as sensitive.

See `THREAT_MODEL.md` and `SECURITY.md` for the threat model and how to report vulnerabilities.

## License

Merdienz is licensed under the GNU Affero General Public License, version 3. See [LICENSE](LICENSE), [CONTRIBUTING.md](CONTRIBUTING.md), and [CLA.md](CLA.md).
