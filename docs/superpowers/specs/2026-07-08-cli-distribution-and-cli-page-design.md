# Relayium CLI — Distribution + `/cli` Frontend Page (Spec)

Date: 2026-07-08
Status: Design approved, pending implementation plan

## 1. Motivation

The Relayium CLI is code-complete on `main` — three transfer topologies
(`push`/`pull` over SSH, `send`/`receive` cross-network, and daemon-direct
`serve` + `push relayium://…`) — but **users have no way to install it**:

- No GitHub Releases / prebuilt binaries.
- No `install.sh`, goreleaser, or brew tap.
- `go install github.com/relayium/relayium/cmd/relayium@latest` does **not**
  work: the module is `github.com/relayium/relayium` but its `go.mod` lives in
  `server/`, so the module path does not match the repo subdirectory and Go
  cannot resolve it.
- The website (SPA + generated landing pages) does not mention the CLI at all.

This maps to README Roadmap **M3 (Protocol spec + multi-client)** and turns the
already-shipped CLI code into something a user can actually download and run,
discoverable from the site.

## 2. Goals / Non-goals

**Goals**

- `curl -fsSL https://relayium.com/install.sh | sh` installs the right
  prebuilt binary for the user's OS/arch.
- Cross-platform prebuilt binaries published to GitHub Releases on each `v*`
  tag, via goreleaser + GitHub Actions.
- `relayium version` prints the release version (injected at build time).
- A `/cli` page in the SPA (4th nav tab) documenting install + the three
  transfer modes with real example commands.
- First release **v0.1.0** cut as part of this work so the install one-liner is
  live.

**Non-goals (this spec)**

- Fixing the `go install` path (module-path rename) — deferred; the prebuilt
  binaries + install.sh + build-from-source cover users. Mentioned on the page
  only as "build from source".
- Homebrew tap / winget / Linux distro packages — future.
- Full 6-language translation of the `/cli` page body — English body; only the
  nav tab label + one subtitle line are localised.
- Static SEO-optimised generated page (`/compare`-style) — the SPA route is the
  agreed form despite weaker default SEO.
- `authorize`/`revoke` CLI subcommands, concurrent serve, `pull` reverse for
  daemon mode — tracked in the daemon-direct spec, out of scope here.

## 3. Architecture

Two coupled deliverables in one spec, built in order (A gates B):

**A. Distribution infra** (must exist before the page's install command works).
**B. `/cli` frontend page.**

| Location | Change |
|---|---|
| `.goreleaser.yaml` (new, repo root) | Cross-compile `cmd/relayium`; archives + checksums; version via ldflags |
| `.github/workflows/release.yml` (new) | On `v*` tag: checkout → setup-go → goreleaser release |
| `web/public/install.sh` (new) | POSIX-sh installer served at `relayium.com/install.sh` |
| `server/cmd/relayium/version.go` (new) + `run.go` (mod) | `relayium version` / `--version`; `main.version` var |
| `web/src/lib/CliPage.svelte` (new) | The page content |
| `web/src/lib/router.svelte.ts` (mod) | Add `"cli"` route + `CLI_PATH` |
| `web/src/lib/Nav.svelte` (mod) | 4th tab |
| `web/src/lib/App.svelte` (mod) | Render `CliPage` for the `cli` route |
| `web/src/lib/i18n/*.ts` (mod) | `nav.cliTab` label + one subtitle string ×6 langs |

### 3.1 Why the SPA route needs no server change

`server/spa.go` already falls back to `index.html` for extensionless unknown
paths, so `/cli` renders the SPA shell with no backend change. `install.sh` has
a `.sh` extension, so the same handler serves it as a real file once it exists
in `web/dist` (copied there from `web/public/` by the Vite build).

## 4. Distribution infra detail

### 4.1 goreleaser (`.goreleaser.yaml`, v2 schema)

- `builds`: a single build with `dir: server`, `main: ./cmd/relayium`,
  `binary: relayium`, `env: [CGO_ENABLED=0]`,
  `goos: [linux, darwin, windows]`, `goarch: [amd64, arm64]`,
  `ldflags: -s -w -X main.version={{.Version}}`.
- `archives`: `.tar.gz` for unix, `.zip` for windows;
  `name_template: relayium_{{ .Os }}_{{ .Arch }}` (install.sh depends on this
  exact template).
- `checksum`: `checksums.txt` (sha256).
- `release`: GitHub, drafts off.

Local verification: `goreleaser build --snapshot --clean` (no publish).

### 4.2 GitHub Actions (`.github/workflows/release.yml`)

- Trigger: `push: tags: ['v*']`.
- Steps: `actions/checkout@v4` (fetch-depth 0) → `actions/setup-go` (from
  `server/go.mod`) → `goreleaser/goreleaser-action` `release --clean`, with
  `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}`.
- Permissions: `contents: write`.

### 4.3 `install.sh`

POSIX `sh` (no bashisms). Flow:

1. `os=$(uname -s)` → `linux`/`darwin` (reject others with a clear message,
   point Windows users at the Releases zip).
2. `arch=$(uname -m)` → map `x86_64|amd64`→`amd64`, `aarch64|arm64`→`arm64`;
   reject the rest.
3. Asset base = `relayium_${os}_${arch}`; download
   `https://github.com/relayium/relayium/releases/latest/download/${base}.tar.gz`
   and `checksums.txt` to a `mktemp -d` scratch dir.
4. Verify sha256 against `checksums.txt` (`sha256sum` or `shasum -a 256`,
   whichever exists); abort on mismatch.
5. Extract `relayium`; pick install dir: `/usr/local/bin` if writable, else
   `$HOME/.local/bin` (created), and if the chosen dir is not on `PATH`, print a
   one-line hint to add it.
6. `chmod +x`, move into place, print `relayium version`-style confirmation.
7. `set -eu`; clean up the scratch dir on exit (`trap`).

An `-h/--help` and an overridable `RELAYIUM_INSTALL_DIR` env var are the only
knobs. No sudo auto-escalation (if `/usr/local/bin` is unwritable, fall back
rather than prompt for a password).

### 4.4 CLI version

`server/cmd/relayium/version.go`: `var version = "dev"` (package `main`) and a
`runVersion` that prints it. `run.go` dispatches `version` (and treats
`--version`/`-version` as the same). goreleaser overrides `main.version`.

## 5. `/cli` page detail

### 5.1 Routing / nav

- `Route` gains `"cli"`; `export const CLI_PATH = "/cli"`.
- `routeFromLocation`: `if (pathname === CLI_PATH) return "cli"` (before the
  `"lan"` default).
- `navigate`: map `"cli"` → `CLI_PATH`.
- `Nav.svelte`: append `{ id: "cli", label: () => t.nav.cliTab }` to `tabs`;
  the tab `href` is `CLI_PATH`. Navigating to `/cli` still calls `clearRoom()`
  (harmless — it's a docs page, no transfer).
- `App.svelte`: render `<CliPage/>` when `currentRoute() === "cli"`.

### 5.2 Content (English body)

Sections, each a short block reusing existing CSS vars + light/dark theme, with
monospace, horizontally-scrollable code blocks:

1. **Hero** — one line: end-to-end-encrypted file transfer from your terminal,
   self-hostable, no account for LAN/direct.
2. **Install** — the `curl … | sh` one-liner; below it, collapsible/secondary:
   download a prebuilt binary from Releases, or build from source
   (`git clone … && cd server && go build -o relayium ./cmd/relayium`).
3. **Mode 1 — push/pull over your own SSH**:
   `relayium push ./photos user@host:backups/` /
   `relayium pull user@host:backups/ ./restore`. No Relayium account; bytes go
   over your SSH.
4. **Mode 2 — send/receive by pairing code (cross-network)**:
   `relayium send ./file.zip 123456` / `relayium receive 123456 ./downloads`.
   Direct when reachable (free), metered relay fallback.
5. **Mode 3 — daemon direct (server-to-server)**:
   `relayium serve --dir ~/inbox`, then `relayium push ./file relayium://host`;
   trust setup via `relayium id` → peer's `authorized_fingerprints`. No relay,
   no SSH, no code.
6. **Footer** — link to the GitHub repo.

### 5.3 i18n

Only `nav.cliTab` (tab label, e.g. "CLI") and one `cli.subtitle` string are
added to each of the 6 language message files. The page body text lives in
`CliPage.svelte` as English literals (not routed through `messages`).

## 6. First release

After A + B merge to `main`: user pushes `v0.1.0` tag (`git tag v0.1.0 &&
git push origin v0.1.0`), Actions builds and publishes the release. Requires
the repo to allow Actions with `contents: write` (default for the repo owner).
`install.sh` and the `/cli` page deploy with the normal `main` auto-deploy.

## 7. Error handling

- **install.sh, unsupported OS/arch** — print the detected value and point at
  the Releases page; non-zero exit.
- **install.sh, checksum mismatch / download failure** — abort, non-zero exit,
  leave nothing installed; scratch dir cleaned via `trap`.
- **install.sh, no writable bin dir** — fall back to `~/.local/bin`, create it,
  hint about `PATH`; never silently succeed with an un-runnable install.
- **release workflow failure** — the tag exists but no assets publish; re-runs
  are idempotent (goreleaser `--clean`). `install.sh` fails clearly until a
  release exists.
- **SPA `/cli`** — no new failure surface; unknown deeper paths under `/cli/*`
  fall through existing SPA behaviour.

## 8. Testing

- **install.sh**: `shellcheck` clean; a local dry-run test that points the
  download base at a `file://` or local fixture serving a fake
  `relayium_<os>_<arch>.tar.gz` + `checksums.txt`, asserting arch detection,
  checksum verification (tamper → abort), and install-dir fallback.
- **CLI**: `relayium version` prints the value of `main.version` (overridable),
  and `--version` is equivalent; table test in `cmd/relayium`.
- **goreleaser**: `goreleaser build --snapshot --clean` succeeds (cross-compile
  smoke), run locally / optionally in CI on PRs (build only, no publish).
- **Frontend**: `routeFromLocation("/cli","")==="cli"` and `navigate("cli")`
  rewrites to `/cli` (extend `router.test.ts`); a `CliPage` render smoke test;
  Nav shows the 4th tab. Existing vitest suite stays green; `check`/`build`
  clean.

## 9. Rollout / sequencing

1. Land distribution infra (goreleaser, workflow, install.sh, `relayium
   version`) + the `/cli` page on `main` (one or two commits).
2. Deploy `main` (auto-deploy) → `relayium.com/install.sh` and `/cli` live;
   install command still 404s on the asset until step 3.
3. Push `v0.1.0` → Actions publishes the release → install one-liner works
   end-to-end. Verify `curl … | sh` on a clean machine (or container).

## 10. Open questions / future

- `go install` support via a module-path rename to
  `github.com/relayium/relayium/server` — deferred (large import churn).
- Homebrew tap / winget / distro packages, and signing/notarising the macOS
  binary — future once there's demand.
- Localising the `/cli` body into the other 5 languages — deferred.
