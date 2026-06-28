# Contributing to Relayium

Thanks for your interest in Relayium! It's an early-stage, open-source project building toward a
serious next-generation file transfer protocol, and contributions of all kinds are welcome.

## Ways to contribute

- **Security review** — the crypto and transfer layers are the heart of the project. Careful eyes here
  are the most valuable contribution of all. (For *vulnerabilities*, please follow [SECURITY.md](SECURITY.md)
  rather than opening a public issue.)
- **Bug reports** — open an issue with steps to reproduce, your browser/OS, and what you expected.
- **Features and fixes** — see the roadmap in the [README](README.md#roadmap) and the design docs in
  [`docs/`](docs/) before starting larger work.
- **Translations** — UI strings live in [`web/src/lib/i18n.svelte.ts`](web/src/lib/i18n.svelte.ts); adding or
  improving a language is a self-contained, friendly first contribution.
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
```

- **Match the surrounding code** — naming, comment density, and idioms. Keep changes focused.
- **Add tests** for new transfer/crypto behavior where practical (`web/src/lib/*.test.ts`).
- **Commit messages** follow a conventional style used in the history, e.g.
  `feat(web): ...`, `fix(server): ...`, `docs: ...`.
- For changes that touch the wire protocol or crypto, describe the security reasoning in the PR.

## Manual acceptance

WebRTC transfers can't be fully verified headlessly. [`docs/TESTING.md`](docs/TESTING.md) is the manual
acceptance procedure (two devices on a LAN) — please run the relevant parts for transfer-affecting changes.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
