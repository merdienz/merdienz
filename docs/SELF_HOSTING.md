# Self-hosting Merdienz

This guide runs Merdienz on a machine you control with Docker Compose. It is the supported self-hosted path. The `selfhosted` tier has no plan limits.

## What you need

- A Linux host with Docker Engine and the Compose plugin. About 1 vCPU and 1 GB of RAM is enough for small installs.
- A domain name pointing at the host, if people will reach the dashboard over the internet.
- A reverse proxy that terminates TLS (for example nginx, Caddy, or Traefik) on the same host.

## 1. Get the code and create `.env`

```bash
git clone <repository-url> merdienz
cd merdienz
cp .env.example .env
chmod 600 .env
```

Edit `.env`. A minimal self-hosted file looks like this (generate your own values; never reuse these placeholders):

```bash
POSTGRES_PASSWORD=change-me-to-a-long-random-value
# Required by Compose even if you do not run the optional second probe (32 bytes or more).
PROBE_B_SECRET=change-me-to-a-different-long-random-value
COOKIE_SECRET=change-me-to-a-third-long-random-value
# The https:// origin people will type, once TLS is in front.
PUBLIC_URL=https://status.example.com
# Mail stays off until you configure a transport.
MAIL_TRANSPORT=none
```

One way to make random values: `openssl rand -hex 32`.

Compose sets `MERDIENZ_MODE=selfhosted` for you. Do not commit `.env`.

## 2. Start the stack

```bash
docker compose up --build -d
docker compose ps
curl -fsS http://127.0.0.1:4840/health
```

The app port is published on loopback only (`127.0.0.1:4840`). Postgres stays on an internal Compose network and is not published.

## 3. Create the first account

There is no default administrator and no default password. On first start the app writes a one-time setup token to a mode `0600` file inside the container and logs only the file path:

```bash
docker compose logs app | grep -i setup
docker compose exec app cat <path-from-the-log>
```

Submit the token with your email and a password (12 characters or more) at `https://<your-domain>/setup`, or:

```bash
curl -s -H 'content-type: application/json' \
  -d '{"token":"<setup-token>","email":"you@example.com","password":"choose-a-long-password"}' \
  http://127.0.0.1:4840/setup
```

The response includes an API key, shown once.

## 4. Put TLS in front

Point the reverse proxy at `http://127.0.0.1:4840` and terminate TLS there. A minimal nginx server block:

```nginx
server {
  listen 443 ssl http2;
  server_name status.example.com;
  ssl_certificate     /etc/ssl/status.example.com/fullchain.pem;
  ssl_certificate_key /etc/ssl/status.example.com/privkey.pem;
  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
  location / {
    proxy_pass http://127.0.0.1:4840;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
  }
}
```

Set `PUBLIC_URL` to that origin and restart with `docker compose up -d`. If the proxy must run on another host, change the published port in `docker-compose.yml` deliberately and restrict who can reach it.

## Optional settings

| Variable | Default | Purpose |
|---|---|---|
| `ALLOW_PRIVATE_TARGETS` | off | Set to exactly `true` to monitor loopback or private-network URLs. |
| `MAIL_TRANSPORT` | `none` | `smtp` sends alert email; see the README for SMTP settings. |
| `DOMAIN_EXPIRY_LOOKUP` | `off` | `rdap` turns on domain registration expiry checks. |
| `SEO_CHECKS` | `on` | `off` turns off the daily basic SEO checks. |
| `HEARTBEAT_URL` | unset | A URL Merdienz pings after each cycle, so an outside watcher notices if it stops. |

The optional `probe-b` Compose profile runs a second probe for two-location confirmation. It needs `./tls/cert.pem`, `./tls/key.pem`, the same `PROBE_B_SECRET`, and a certificate pin; see the README.

## Upgrades and backups

- Upgrade: `git pull`, then `docker compose up --build -d`. Migrations run at start.
- Back up the Postgres volume regularly, for example with `docker compose exec postgres pg_dump -U merdienz merdienz > backup.sql`, and keep backups somewhere other than the host. Treat backups and `.env` as secrets.

## Security notes

- Keep the host patched and the Compose images up to date.
- Do not expose port 4840 or Postgres directly to the internet.
- Report vulnerabilities privately; see [SECURITY.md](../SECURITY.md).
