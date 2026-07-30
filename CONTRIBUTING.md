# Contributing to Relayium

Thanks for your interest in Relayium! It's an early-stage, open-source project building toward a
serious next-generation file transfer protocol — files, plus ephemeral encrypted text between two
peers that are both online — and contributions of all kinds are welcome.

## Ways to contribute

- **Security review** — the crypto and transfer layers are the heart of the project. Careful eyes here
  are the most valuable contribution of all. (For *vulnerabilities*, please follow [SECURITY.md](SECURITY.md)
  rather than opening a public issue.)
- **Bug reports** — open an issue with steps to reproduce, your browser/OS, and what you expected.
- **Features and fixes** — see the roadmap in the [README](README.md#roadmap) and the design docs in
  [`docs/`](docs/) before starting larger work.
- **Translations** — one table per language in [`web/src/lib/i18n/`](web/src/lib/i18n), loaded by
  [`web/src/lib/i18n.svelte.ts`](web/src/lib/i18n.svelte.ts); adding or improving a language is a
  self-contained, friendly first contribution.
- **Docs** — clarifications to the README, design spec, or test procedure.

## Development setup

Prerequisites: **Go 1.22+** and **Node 20+**. See the [Quick start](README.md#quick-start-run-it-locally)
in the README to build and run locally.

```bash
# Web client
cd web
npm install
npm run dev      # UI work (Vite dev server)
npm run build    # production build into web/dist/

# Signaling server (also serves web/dist)
cd ../server
go build -o relayium-server .
./relayium-server -addr :8080 -static ../web/dist
```

A real two-device transfer needs the built `dist/` served by the Go server over a **secure context**
(HTTPS, or `localhost`) — the Web Crypto API and streaming-to-disk require it.

## Before you open a PR

Please make sure the checks pass:

```bash
# Web: unit tests + type-check
cd web && npx vitest run && npm run check

# Server: tests
cd server && go test ./...

# Repo hygiene: no production IPs/paths/hostnames leaking into the public repo
scripts/check-production-identifiers.sh
```

- **Match the surrounding code** — naming, comment density, and idioms. Keep changes focused.
- **Add tests** for new transfer/crypto behavior where practical (`web/src/lib/*.test.ts`).
- **Commit messages** follow a conventional style used in the history, e.g.
  `feat(web): ...`, `fix(server): ...`, `docs: ...`.
- For changes that touch the wire protocol or crypto, describe the security reasoning in the PR.
- **Sign off every commit** with `git commit -s` — see [License](#license) below.

## Manual acceptance

WebRTC transfers can't be fully verified headlessly. [`docs/TESTING.md`](docs/TESTING.md) is the manual
acceptance procedure (two devices on a LAN) — please run the relevant parts for transfer-affecting changes.

## License

Relayium is [open core](LICENSE): `server/` and `web/` are AGPL-3.0, `apps/` is
Apache-2.0, and `docs/protocol/` is CC BY 4.0. By contributing, you agree that
your contribution is licensed under whichever of those licenses covers the
directory it lands in — see the root [`LICENSE`](LICENSE) for the full
breakdown.

We use the **[Developer Certificate of Origin](DCO)** (DCO) instead of a CLA.
It's lighter weight: it just asserts you wrote the contribution (or otherwise
have the right to submit it), and it's already trusted by very large projects
(Linux kernel, Git, and most CNCF projects). No paperwork, no signing up
anywhere — sign off each commit instead:

```bash
git commit -s -m "feat(web): ..."
```

`-s` appends a `Signed-off-by: Your Name <you@example.com>` trailer using your
git `user.name` / `user.email`. If you forgot on the last commit, fix it with
`git commit --amend -s` (or `git rebase --exec 'git commit --amend --no-edit -s' -i <base>`
for a range). PRs with unsigned commits will be asked to add sign-off before
merge.
