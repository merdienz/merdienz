# Contributing

Thanks for considering a contribution to Merdienz.

## License and CLA

This project is licensed under the GNU Affero General Public License, version 3 only (AGPL-3.0-only). See [LICENSE](LICENSE). First-time contributors must agree to the light contributor license agreement in [CLA.md](CLA.md) (you keep your copyright; your contribution is licensed under AGPL-3.0-only).

How to sign:

1. Read [CLA.md](CLA.md).
2. In the description of your first pull request, add this line, using your real name or the name you want on record:

   ```
   I have read CLA.md and I agree to it. — Your Name
   ```

3. Sign off each commit with `git commit -s`, which adds `Signed-off-by: Your Name <you@example.com>`.

If you contribute on behalf of an employer, say so in the same pull request and confirm you are authorised to agree for them. A maintainer records the agreement before merging. You only need to sign once.

## Security reports

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).

## Development setup

- Node.js 22 or newer (see `.nvmrc`).
- Clone the repository, then install with `npm ci` (use `npm install` only when you intend to change a lockfile).
- Copy `.env.example` to `.env` and set `MERDIENZ_MODE=dev` for a local sandbox.
- `npm run dev` starts the API on `http://127.0.0.1:4840` when mode is `dev` or `test`.
- Run `npm test` and `npm run lint` before you send a change. `npm run build:web` builds the dashboard.

There is no default administrator. On a first run with an empty users table the process writes a one-time setup token to a mode `0600` file and logs only the path.

## Pull requests

- Keep changes focused. Describe what changed and how you tested it.
- Do not commit `.env` files, credentials, machine hostnames, or private addresses.
- Do not add hosting-provider names or unexpected IPv4 literals; `npm run lint` includes a public-reference check.
- Keep `package-lock.json` and `web/package-lock.json` in sync with any dependency change.
- New behaviour needs tests. Do not weaken SSRF, auth, or self-host default checks to make a test pass.

## Code of conduct

Be respectful and assume good faith. Harassment or hostile behaviour is not welcome.
