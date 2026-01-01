# Security

If you believe you have found a vulnerability in Merdienz, please report it privately.

- Contact the maintainers through the private security reporting channel on the project's source-code host (preferred), or email `security@merdienz.com`.
- Include a description, the affected version or commit, and steps to reproduce.
- Do not open a public issue or discussion for security reports until we have had a chance to fix the issue and publish a release.
- We aim to acknowledge reports within 5 working days and keep you informed as we investigate and ship a fix.
- Please give us a reasonable window (normally 90 days) before public disclosure. We are happy to credit reporters who want to be named.

## Scope

In scope: this repository's server, second probe, dashboard, Compose files, and documented default configuration. Out of scope: denial of service by volume, social engineering, findings that require an already-compromised host or operator secrets, and third-party services.

## Supported versions

This project is under active development. Security fixes land on the latest published release line.

## Hardening notes

- Run the primary API and the second probe process behind TLS, typically terminated at a reverse proxy.
- Keep `MERDIENZ_MODE=cloud` unless you are operating a self-hosted instance you control.
- Use long, unique secrets (32 bytes or more). There are no default passwords or default admin accounts.
- When a second probe process is used, authenticate it with the shared HMAC secret and, in cloud mode, pin the probe certificate's SPKI hash. Do not rely on public certificate authorities for that hop.
- Treat logs as sensitive. The application redacts credentials and ping tokens, but raw request bodies and job output can still contain secrets.
- Self-hosted deployments should keep the database on a private network, drop container capabilities, and run the process as a non-root user. See the compose file and the README for a reverse-proxy example.

If a dependency advisory cannot be upgraded immediately, a short waiver may be recorded here with the package name, the identifier, the reason, and the planned upgrade path. There are no active waivers at this time.
