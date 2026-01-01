# Release checklist

Use this list before publishing a public source tree of Merdienz. The project is not released by pushing existing private history. Publish only from a fresh squashed history of a reviewed tree, after the project owner has approved the publication.

## Licence and policy files

- [ ] `LICENSE` contains the full GNU Affero General Public License, version 3.
- [ ] `package.json` and `web/package.json` set `"license": "AGPL-3.0-only"`.
- [ ] `CLA.md` (light agreement, no copyright assignment) and `CONTRIBUTING.md` are present and say AGPL-3.0-only, matching `package.json`.
- [x] `SECURITY.md` describes private disclosure. The contact mailbox is `security@merdienz.com` (alias confirmed live 2026-11-27 17:39 WIB).
- [ ] `THREAT_MODEL.md` covers assets, trust boundaries, auth, billing webhooks, tenant isolation, outbound requests and SSRF, secrets handling, and known gaps. It is generic and does not record specific findings or internal review notes.
- [ ] The CLA signing method in `CONTRIBUTING.md` (statement on the first pull request) is still the one the maintainers want, or a CLA bot is configured on the public repository.

## README and self-host defaults

- [ ] README has a short self-hosted deploy path (Compose, first-run setup, reverse proxy plus TLS, safe defaults).
- [ ] No default administrator or default password. The setup token is written to a mode `0600` file; the process logs the path, not the token.
- [ ] `MERDIENZ_MODE` still defaults to `cloud` when unset. Compose sets `selfhosted` explicitly.
- [ ] `ALLOW_PRIVATE_TARGETS` is off unless set to the exact string `true`.
- [ ] The Compose app port is published only on loopback by default. Postgres is not published.
- [ ] `.env.example` has no live secrets.

## Scrub and supply chain

- [ ] `scripts/check-public-refs.js` (and `npm run lint`) is clean on the tree being published.
- [ ] The maintainers' private scrub scan is clean on the source tree and on the squashed export (hosting-provider names, IP literals, internal paths, automation or personal names including names rebuilt from joined string literals, secret patterns, personal email addresses, and the export's commit message and author). That tooling and its pattern lists are not part of the public source.
- [ ] The same public-reference check, plus a gitleaks scan with redaction, is clean over the *entire published history*, not only the tip tree. Do not publish history that still contains a hosting-provider name, unexpected IPv4 address, internal path, or secret.
- [ ] Dependency licence audit of both lockfiles: no unexpected copyleft or unknown licences. Record any weak-copyleft or attribution-licensed build tools that are kept.
- [ ] `npm ci` from the published lockfiles; CI runs tests, `npm audit --audit-level=high`, a vulnerability scan, and gitleaks. Actions stay pinned to commit SHAs with minimal token permissions.
- [ ] Enable Dependabot (alerts, security updates, and weekly version updates) and secret scanning / push protection on the public repository after it is created.

## Publication mechanics

- [ ] The project owner has approved the exact tree and the publish date.
- [ ] Create a new public repository. Do not push any existing private branch or tag.
- [ ] Export a fresh squashed history of the approved tree only (a new `git init`, a single commit, no remote). The export leaves out the operator deploy package for the hosted service and the maintainer release tooling. Confirm the export installs, tests, lints, and builds from a fresh clone. Re-run the scrub and secret scans on that export before the first push.
- [ ] Do not include operator environment files, setup-token files, backups, or machine-specific configuration in the export.
- [ ] Tag the published revision and attach the source tarball if you cut a release.

## After the first public push

- [ ] Confirm the security reporting channel (source-host private reports and the mailbox in `SECURITY.md`) is monitored.
- [ ] Watch CI, Dependabot, and secret-scanning alerts on the public repository.
