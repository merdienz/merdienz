# Threat model

This document describes what Merdienz protects, where the trust boundaries are, and which controls are expected to hold. It is generic: it does not record specific findings, deployments, or review notes. Report suspected weaknesses privately as described in [SECURITY.md](SECURITY.md).

## Assets

- Monitor configuration (site URLs, heartbeat schedules, status-page settings) and the availability and incident history derived from it.
- Account credentials: password hashes, session tokens, API keys, the first-run setup token, and heartbeat ping URLs (the ping token is a bearer secret).
- Billing state: the account's plan, subscription and customer identifiers, and payment-failure timestamps that drive grace and pause behaviour.
- Server-side secrets: the database password, the cookie secret, the shared HMAC secret and certificate pin used between the primary process and a second probe, SMTP credentials, and (cloud only) the payment provider secret key and webhook signing secret.
- Outbound alert content, which may include monitor names, URLs, and incident times.
- Ping request bodies, which may contain whatever a job prints, including secrets.

## Actors

- Unauthenticated internet clients, including scanners, credential-stuffing bots, and sign-up abuse.
- Authenticated users of *other* accounts on a shared (cloud) deployment.
- An attacker who controls a monitored target, or the DNS for it, and tries to turn checks into requests against internal services.
- A spoofed or compromised second probe, or an attacker on the network path to it.
- A forged or replayed payment-provider webhook.
- A compromised job that pings a heartbeat URL.
- Operators of a self-hosted instance. They are trusted to protect their own host, reverse proxy, TLS keys, `.env`, and backups.

## Trust boundaries

1. **Public HTTP surface.** Login, sign-up (cloud mode only), `/setup`, `/ping/*`, `/status/<slug>`, `/billing/plans`, and `/billing/webhook` accept untrusted input. Everything else requires an API key or a session.
2. **Reverse proxy to app.** TLS ends at the operator's proxy. Forwarding headers are honoured only from addresses listed in `TRUSTED_PROXIES`; otherwise the peer address is used for rate limits and logs.
3. **App to database.** The database is trusted only as far as its host and network. In the reference layouts it is not published outside a private network or loopback, and the runtime role is DML-only where the operator follows the hardened setup.
4. **Primary to second probe.** A separate trust domain. Requests carry an HMAC over method, path, timestamp, nonce, and body, inside a short replay window with nonce tracking. In cloud mode the hop must be HTTPS and the primary accepts only the pinned SPKI hash, not public certificate authorities.
5. **App to monitored targets (outbound).** Target URLs are attacker-controlled. Every check goes through the SSRF guard (see below).
6. **App to alert destinations (outbound).** Alert email goes to a configured SMTP relay. Any future outbound hook destination (chat or webhook channels) is attacker-controlled and must be treated like a monitored target.
7. **Payment provider to app (inbound webhooks, cloud only).** Authenticity comes only from the provider's signature over the raw request body, never from the peer address or a parsed body.
8. **Host secrets.** The operator's `.env`, secret files, the setup-token file, and backups are host secrets. Anyone who can read them can impersonate the instance or complete first-run setup.

## Authentication and sessions

- No default administrator or password. The first account is created at `/setup` with a one-time token written to a mode `0600` file; only the file path is logged.
- Passwords are hashed with scrypt and a per-user salt. Login is constant-time with respect to user existence and is rate limited per client address.
- API keys and session tokens are stored hashed. API keys are shown once.
- Client-supplied `tier`, `plan`, or `role` fields and tier headers are rejected. Entitlements are loaded from the database on every authenticated request.
- Cookie sessions use `HttpOnly`, `SameSite=Lax`, and `Secure` in production or cloud mode. Cookie-authenticated state-changing requests require a CSRF token.
- Sign-up exists only in cloud mode, only after first-run setup, with per-IP, per-IP-and-email, and per-email limits. New accounts start without a paid plan.

## Billing and payment webhooks

- The webhook handler verifies the signature over the *raw* body with a fixed tolerance window, and refuses parsed-body or re-serialised input.
- Each event id is stored once (idempotent). Out-of-order and stale events cannot downgrade newer state or resurrect a cancelled subscription.
- Only a completed subscription checkout with a subscription id can activate an account. Events naming another subscription, or a customer that belongs to a different account, are ignored.
- Prices come from configuration, not from client input. Checkout is refused while an account already has an active or past-due subscription.
- Plan lapse never deletes data: a grace period, then checks pause until payment resumes.
- Provider secret keys and webhook secrets are read from permission-checked files and are never logged.

## Tenant isolation

- Every record-access path (sites, incidents, heartbeats, pings, status pages, billing) is scoped to the authenticated owner in the query itself, not by filtering afterwards. Access to another account's id returns not-found rather than forbidden.
- Public status pages expose only the fields the owner chose to publish, addressed by slug.
- Plan gates (monitor counts, minimum interval, heartbeat counts, status pages, seats, feature flags) are enforced server-side from the database row for the account's tier.
- Scheduler and alert work is keyed by owner so one account's volume or failures should not block another's (see known gaps).

## Outbound requests and SSRF

- Target URLs are validated when added and again at connect time.
- DNS is resolved once and the connection is pinned to the checked address, so a rebinding answer cannot swap in an internal address between check and connect.
- Loopback, private, link-local, unique-local, CGNAT, multicast, metadata, and unspecified ranges are refused unless a self-hosted operator sets `ALLOW_PRIVATE_TARGETS=true` (ignored in cloud mode).
- Redirects are off by default. When following is enabled, every hop is re-validated.
- Responses are capped (1 MB), with connect and overall timeouts. Response bodies are parsed as untrusted data and never executed or rendered as HTML.
- Certificate details read during HTTPS checks come from the pinned connection only; no second unguarded connection is opened.

## Secrets handling

- Secrets come from environment variables or from files with strict ownership and mode checks. The app refuses to start in a mode that needs a secret if the file is missing, empty, or too permissive.
- Placeholder and short secrets are refused in cloud mode (shared probe secret: 32 bytes or more).
- Logs redact credentials, session and API tokens, ping tokens in paths, and sensitive headers.
- The repository contains no live secrets. CI runs secret scanning and a public-reference check, and `.env`, token files, TLS material, and backups are git-ignored.

## Alert email

- In cloud mode, smtp `MAIL_FROM` must be a merdienz.com address. The check is keyed off `MERDIENZ_MODE` (default `cloud`), not off `NODE_ENV`. Self-hosted, dev, and test operators set `MAIL_FROM` to an address on a domain they have authorized with their SMTP provider (SPF, DKIM, and DMARC are outside the app). A self-hosted process will not default to `alert@merdienz.com`.

## Known gaps and non-goals

- A full multi-tenant isolation review of hosted dashboards and status pages has not been completed.
- Rate limits are per process. Several app instances behind one proxy do not share counters.
- There is no second factor for login and no email verification on cloud sign-up yet.
- Ping bodies and job output can contain secrets that the app stores as excerpts. Treat ping logs as sensitive.
- Per-account fairness for outbound alert hooks (slow or hanging destinations) is a design requirement for any non-email channel and must be re-checked when such channels ship.
- Physical access to a self-hosted host, compromise of the operator's reverse proxy or TLS keys, and availability of third-party mail or payment providers are out of scope.
