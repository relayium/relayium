# CLI Distribution + `/cli` Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the already-shipped Relayium CLI installable via `curl … | sh` from GitHub Releases, and surface it as a 4th SPA nav tab (`/cli`).

**Architecture:** Two coupled deliverables, built in order. (A) Distribution: goreleaser cross-compiles `cmd/relayium` and GitHub Actions publishes a Release on each `v*` tag; a POSIX `install.sh` served at `relayium.com/install.sh` downloads the right asset. (B) Frontend: a new `/cli` route + `CliPage.svelte` documenting install and the three transfer modes, reachable from a new nav tab.

**Tech Stack:** Go 1.26.3 (CLI, module rooted at `server/`), goreleaser v2, GitHub Actions, POSIX `sh`, Svelte 5 (runes) + Vite + vitest.

## Global Constraints

- Go module path is `github.com/relayium/relayium` with `go.mod` in `server/`; the CLI main is `./cmd/relayium` **relative to `server/`**.
- goreleaser archive `name_template` MUST be exactly `relayium_{{ .Os }}_{{ .Arch }}` (no version/project prefix) so `install.sh` can use a stable `latest/download/` URL. `install.sh` and goreleaser must agree on this verbatim.
- `install.sh` is strict POSIX `sh` (no bashisms); it must `shellcheck` clean.
- CLI version is injected via `-ldflags "-X main.version={{.Version}}"`; the default in-source value is `"dev"`.
- Frontend `/cli` page body is **English literals**; only the nav tab label (`nav.cliTab`) and one subtitle (`cli.subtitle`) are added to all 6 language files.
- Model policy: never use haiku, including for subagents.
- CSS uses only existing tokens: font `--fs-display|--fs-h2|--fs-h3|--fs-body|--fs-sm|--fs-xs`, spacing `--space-1..9`, `--radius-sm`, colours `--accent|--accent-bg|--accent-border|--border|--danger|--social-bg|--text|--text-h`.
- TDD, DRY, YAGNI, frequent commits. All Go commands run from `server/`; all web commands run from `web/`.

---

### Task 1: `relayium version` command

**Files:**
- Create: `server/cmd/relayium/version.go`
- Modify: `server/cmd/relayium/run.go` (dispatch switch + usage)
- Test: `server/cmd/relayium/version_test.go`

**Interfaces:**
- Produces: package-level `var version = "dev"` (overridable via ldflags `-X main.version=…`); `func runVersion(stdout io.Writer) int`.

- [ ] **Step 1: Write the failing test**

Create `server/cmd/relayium/version_test.go`:

```go
package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestVersionCommand(t *testing.T) {
	for _, arg := range []string{"version", "--version", "-version"} {
		var o, e bytes.Buffer
		if rc := Run([]string{arg}, &o, &e); rc != 0 {
			t.Fatalf("%s: rc=%d stderr=%s", arg, rc, e.String())
		}
		if got := strings.TrimSpace(o.String()); got != version {
			t.Fatalf("%s: printed %q, want %q", arg, got, version)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./cmd/relayium/ -run TestVersionCommand`
Expected: FAIL (unknown command / `runVersion` undefined).

- [ ] **Step 3: Create version.go**

Create `server/cmd/relayium/version.go`:

```go
package main

import (
	"fmt"
	"io"
)

// version is the CLI release version. goreleaser overrides it at build time via
// -ldflags "-X main.version=<tag>"; source builds report "dev".
var version = "dev"

func runVersion(stdout io.Writer) int {
	fmt.Fprintln(stdout, version)
	return 0
}
```

- [ ] **Step 4: Wire the dispatch**

In `server/cmd/relayium/run.go`, add cases to the `switch args[0]` block (next to `case "id":`):

```go
	case "version", "--version", "-version":
		return runVersion(stdout)
```

And add a line to the `usage` string, after the `relayium id` line:

```
  relayium version                          print the CLI version
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && go test ./cmd/relayium/ -run TestVersionCommand`
Expected: PASS.

- [ ] **Step 6: Verify ldflags override works**

Run: `cd server && go run -ldflags "-X main.version=v9.9.9" ./cmd/relayium version`
Expected output: `v9.9.9`

- [ ] **Step 7: Commit**

```bash
git add server/cmd/relayium/version.go server/cmd/relayium/version_test.go server/cmd/relayium/run.go
git commit -m "feat(cli): relayium version command (ldflags-injected)"
```

---

### Task 2: goreleaser config

**Files:**
- Create: `.goreleaser.yaml` (repo root)

**Interfaces:**
- Produces: release archives named `relayium_<os>_<arch>.tar.gz` (`.zip` on windows) with the `relayium` binary at the archive root, plus `checksums.txt`. Task 3 (workflow) and Task 4 (install.sh) consume these names.

- [ ] **Step 1: Create the config**

Create `.goreleaser.yaml`:

```yaml
version: 2
project_name: relayium

builds:
  - id: relayium
    dir: server
    main: ./cmd/relayium
    binary: relayium
    env:
      - CGO_ENABLED=0
    goos: [linux, darwin, windows]
    goarch: [amd64, arm64]
    ldflags:
      - -s -w -X main.version={{ .Version }}

archives:
  - id: relayium
    name_template: "relayium_{{ .Os }}_{{ .Arch }}"
    formats: [tar.gz]
    format_overrides:
      - goos: windows
        formats: [zip]

checksum:
  name_template: "checksums.txt"

release:
  github:
    owner: relayium
    name: relayium
  draft: false
```

- [ ] **Step 2: Verify goreleaser is installed**

Run: `goreleaser --version`
Expected: prints a v2.x version. If missing: `brew install goreleaser` (macOS).

- [ ] **Step 3: Cross-compile snapshot (no publish)**

Run: `goreleaser build --snapshot --clean`
Expected: builds all 6 os/arch combos with no error; artifacts appear under `dist/`.
If goreleaser errors about not finding `go.mod` at root, re-run from `server/`: `cd server && goreleaser build --snapshot --clean -f ../.goreleaser.yaml` and add `-f`/`dir` note; the `dir: server` build setting is the intended fix, prefer keeping the config at repo root.

- [ ] **Step 4: Confirm the archive name + contents**

Run: `goreleaser release --snapshot --clean` then `ls dist/*.tar.gz`
Expected: files like `dist/relayium_linux_amd64.tar.gz`; `tar -tzf dist/relayium_linux_amd64.tar.gz` lists `relayium` at the root. Also confirm `dist/checksums.txt` exists.

- [ ] **Step 5: Commit**

```bash
git add .goreleaser.yaml
git commit -m "build(cli): goreleaser cross-compile + checksummed archives"
```

---

### Task 3: GitHub Actions release workflow

**Files:**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: `.goreleaser.yaml` from Task 2.
- Produces: a published GitHub Release with the Task 2 assets whenever a `v*` tag is pushed. Task 9 triggers it.

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/release.yml`:

```yaml
name: release
on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write

jobs:
  goreleaser:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-go@v5
        with:
          go-version-file: server/go.mod
      - uses: goreleaser/goreleaser-action@v6
        with:
          version: '~> v2'
          args: release --clean
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 2: Lint the YAML**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml'))" && echo OK`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(cli): publish goreleaser artifacts on v* tags"
```

---

### Task 4: `install.sh` + dry-run test

**Files:**
- Create: `web/public/install.sh` (served at `relayium.com/install.sh`)
- Create: `web/scripts/install-dryrun-test.sh` (repeatable local test with a `file://` fixture)

**Interfaces:**
- Consumes: asset names from Task 2 (`relayium_<os>_<arch>.tar.gz`, `checksums.txt`).
- Behaviour hooks (for testing): `RELAYIUM_BASE_URL` overrides the download base; `RELAYIUM_INSTALL_DIR` overrides the install directory.

- [ ] **Step 1: Write the installer**

Create `web/public/install.sh`:

```sh
#!/bin/sh
# Relayium CLI installer.
#   curl -fsSL https://relayium.com/install.sh | sh
# Env overrides: RELAYIUM_INSTALL_DIR (target dir), RELAYIUM_BASE_URL (download base).
set -eu

REPO="relayium/relayium"
BASE_URL="${RELAYIUM_BASE_URL:-https://github.com/${REPO}/releases/latest/download}"
INSTALL_DIR="${RELAYIUM_INSTALL_DIR:-}"

err() { echo "relayium-install: $*" >&2; exit 1; }

case "${1:-}" in
  -h|--help)
    echo "Installs the Relayium CLI from the latest GitHub release."
    echo "Env: RELAYIUM_INSTALL_DIR overrides the install directory."
    exit 0
    ;;
esac

os=$(uname -s)
case "$os" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) err "unsupported OS '$os'. Windows: download the .zip from https://github.com/${REPO}/releases/latest" ;;
esac

arch=$(uname -m)
case "$arch" in
  x86_64|amd64) arch=amd64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) err "unsupported architecture '$arch'" ;;
esac

asset="relayium_${os}_${arch}.tar.gz"

if command -v curl >/dev/null 2>&1; then
  dl() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  dl() { wget -qO "$2" "$1"; }
else
  err "need curl or wget"
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  sha() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  err "need sha256sum or shasum"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

echo "Downloading ${asset}..."
dl "${BASE_URL}/${asset}" "${tmp}/${asset}" || err "download failed (has a release been published yet?)"
dl "${BASE_URL}/checksums.txt" "${tmp}/checksums.txt" || err "checksum list download failed"

want=$(grep " ${asset}$" "${tmp}/checksums.txt" | awk '{print $1}')
[ -n "$want" ] || err "no checksum listed for ${asset}"
got=$(sha "${tmp}/${asset}")
[ "$want" = "$got" ] || err "checksum mismatch (expected ${want}, got ${got})"

tar -xzf "${tmp}/${asset}" -C "$tmp" relayium || err "extract failed"

if [ -n "$INSTALL_DIR" ]; then
  dir="$INSTALL_DIR"
elif [ -w /usr/local/bin ]; then
  dir=/usr/local/bin
else
  dir="${HOME}/.local/bin"
fi
mkdir -p "$dir" || err "cannot create ${dir}"
cp "${tmp}/relayium" "${dir}/relayium" || err "cannot write ${dir}/relayium"
chmod 0755 "${dir}/relayium"

echo "Installed relayium to ${dir}/relayium"
case ":${PATH}:" in
  *":${dir}:"*) : ;;
  *) echo "Note: ${dir} is not on your PATH. Add: export PATH=\"${dir}:\$PATH\"" ;;
esac
echo "Run: relayium --help"
```

- [ ] **Step 2: shellcheck the installer**

Run: `shellcheck web/public/install.sh`
Expected: no findings. If `shellcheck` is missing: `brew install shellcheck`.

- [ ] **Step 3: Write the dry-run test**

Create `web/scripts/install-dryrun-test.sh`:

```sh
#!/bin/sh
# Exercises install.sh against a local file:// fixture: builds a fake release
# asset + checksums, runs the installer, asserts the binary lands, and asserts a
# tampered checksum aborts. Requires curl (for file:// support).
set -eu

here=$(cd "$(dirname "$0")" && pwd)
installer="${here}/../public/install.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

os=$(uname -s); case "$os" in Linux) os=linux;; Darwin) os=darwin;; *) echo "SKIP: unsupported test OS"; exit 0;; esac
arch=$(uname -m); case "$arch" in x86_64|amd64) arch=amd64;; arm64|aarch64) arch=arm64;; *) echo "SKIP"; exit 0;; esac
asset="relayium_${os}_${arch}.tar.gz"

# Fake release dir
rel="${work}/rel"; mkdir -p "$rel"
printf '#!/bin/sh\necho fake-relayium\n' > "${work}/relayium"; chmod +x "${work}/relayium"
tar -czf "${rel}/${asset}" -C "$work" relayium
if command -v sha256sum >/dev/null 2>&1; then s=$(sha256sum "${rel}/${asset}" | awk '{print $1}');
else s=$(shasum -a 256 "${rel}/${asset}" | awk '{print $1}'); fi
printf '%s  %s\n' "$s" "$asset" > "${rel}/checksums.txt"

dest="${work}/bin"
# Happy path
RELAYIUM_BASE_URL="file://${rel}" RELAYIUM_INSTALL_DIR="$dest" sh "$installer" >/dev/null
[ -x "${dest}/relayium" ] || { echo "FAIL: binary not installed"; exit 1; }
[ "$("${dest}/relayium")" = "fake-relayium" ] || { echo "FAIL: wrong binary"; exit 1; }

# Tamper: corrupt the checksum, expect abort and no install
rm -f "${dest}/relayium"
printf '%s  %s\n' "deadbeef" "$asset" > "${rel}/checksums.txt"
if RELAYIUM_BASE_URL="file://${rel}" RELAYIUM_INSTALL_DIR="$dest" sh "$installer" >/dev/null 2>&1; then
  echo "FAIL: installer accepted a bad checksum"; exit 1
fi
[ ! -e "${dest}/relayium" ] || { echo "FAIL: binary installed despite bad checksum"; exit 1; }

echo "PASS: install.sh dry-run"
```

- [ ] **Step 4: Run the dry-run test**

Run: `sh web/scripts/install-dryrun-test.sh`
Expected: `PASS: install.sh dry-run`

- [ ] **Step 5: Commit**

```bash
git add web/public/install.sh web/scripts/install-dryrun-test.sh
git commit -m "feat(cli): install.sh (curl|sh) + file:// dry-run test"
```

---

### Task 5: `/cli` SPA route

**Files:**
- Modify: `web/src/lib/router.svelte.ts`
- Test: `web/src/lib/router.test.ts`

**Interfaces:**
- Produces: `Route` union gains `"cli"`; `export const CLI_PATH = "/cli"`. Tasks 7 and 8 consume `CLI_PATH` and the `"cli"` route.

- [ ] **Step 1: Write the failing test**

In `web/src/lib/router.test.ts`, add `CLI_PATH` to the import from `./router.svelte`, then add inside the top `describe("routeFromLocation", …)` block:

```ts
  it("is cli on the /cli path", () => {
    expect(rfl(CLI_PATH, "")).toBe("cli");
  });
  it("a pairing code still wins over /cli", () => {
    expect(rfl("/cli", "#c=424242")).toBe("cross");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/router.test.ts`
Expected: FAIL (`CLI_PATH` undefined / route not `"cli"`).

- [ ] **Step 3: Implement the route**

In `web/src/lib/router.svelte.ts`:

Add `"cli"` to the `Route` type:

```ts
export type Route = "lan" | "cross" | "offline" | "download" | "me" | "cli";
```

Add the path constant near `ME_PATH`:

```ts
/** CLI docs page (static content; not a transfer flow). */
export const CLI_PATH = "/cli";
```

In `routeFromLocation`, add before the final `return "lan";`:

```ts
  if (pathname === CLI_PATH) return "cli";
```

In `navigate`, extend the pathname mapping to include cli:

```ts
  const pathname =
    r === "cross" ? CROSS_PATH
    : r === "offline" ? OFFLINE_PATH
    : r === "me" ? ME_PATH
    : r === "cli" ? CLI_PATH
    : "/";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/router.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/router.svelte.ts web/src/lib/router.test.ts
git commit -m "feat(web): /cli SPA route"
```

---

### Task 6: i18n — CLI tab label + subtitle (6 languages)

**Files:**
- Modify: `web/src/lib/i18n/types.ts`
- Modify: `web/src/lib/i18n/{en,zh,ja,ko,de,fr}.ts`

**Interfaces:**
- Produces: `Messages.nav.cliTab: string` and `Messages.cli.subtitle: string`, present in all 6 language files. Tasks 7 (nav) and 8 (page) consume them.

- [ ] **Step 1: Extend the type**

In `web/src/lib/i18n/types.ts`, change the `nav` field to add `cliTab`:

```ts
  nav: { lanTab: string; crossTab: string; offlineTab: string; cliTab: string };
```

Add a new field to the `Messages` interface (place it right after the `nav` line):

```ts
  cli: { subtitle: string };
```

- [ ] **Step 2: Run the type check to verify it fails**

Run: `cd web && npm run check`
Expected: FAIL — each language file is missing `nav.cliTab` and `cli`.

- [ ] **Step 3: Fill in all 6 languages**

For each file, add `cliTab` to the `nav` object and a top-level `cli` object. Exact edits:

`en.ts` — `nav: { lanTab: "LAN transfer", crossTab: "Realtime direct", offlineTab: "Async transfer", cliTab: "CLI" },` and add `cli: { subtitle: "Transfer files from your terminal — end-to-end encrypted, self-hostable." },`

`zh.ts` — `nav: { lanTab: "局域网传输", crossTab: "实时直传", offlineTab: "异步传输", cliTab: "CLI" },` and `cli: { subtitle: "在终端里传文件 —— 端到端加密，可自托管。" },`

`ja.ts` — append `, cliTab: "CLI"` to its `nav`, and add `cli: { subtitle: "ターミナルからファイルを転送 — エンドツーエンド暗号化、セルフホスト可能。" },`

`ko.ts` — append `, cliTab: "CLI"` to its `nav`, and add `cli: { subtitle: "터미널에서 파일 전송 — 종단간 암호화, 자체 호스팅 가능." },`

`de.ts` — append `, cliTab: "CLI"` to its `nav`, and add `cli: { subtitle: "Dateien vom Terminal übertragen — Ende-zu-Ende-verschlüsselt, selbst hostbar." },`

`fr.ts` — append `, cliTab: "CLI"` to its `nav`, and add `cli: { subtitle: "Transférez des fichiers depuis votre terminal — chiffré de bout en bout, auto-hébergeable." },`

Place the `cli:` object consistently (e.g. right after the `nav:` line) in each file.

- [ ] **Step 4: Run the type check + i18n test to verify they pass**

Run: `cd web && npm run check && npx vitest run src/lib/i18n.test.ts`
Expected: PASS (all locales structurally complete).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/i18n/
git commit -m "i18n(web): CLI nav tab label + subtitle across 6 locales"
```

---

### Task 7: `CliPage.svelte` + render in App

**Files:**
- Create: `web/src/lib/CliPage.svelte`
- Modify: `web/src/App.svelte` (import, `surfaceShown`, route render)

**Interfaces:**
- Consumes: `Messages.cli.subtitle` (Task 6), `lang`/`messages` from `./i18n.svelte`.
- Produces: `<CliPage/>` rendered when `currentRoute() === "cli"`.

**Testing note:** This repo has no component-render test tooling (`@testing-library/svelte` is absent; every `*.test.ts` is a pure-logic test) and CliPage's i18n is lazy-loaded, so a jsdom mount is fragile. Do NOT add a render-test dependency. This task is verified by `npm run check` + `npm run build` (type/compile correctness) and the real-app smoke in Task 8 Step 3 (a stronger, real-browser check). This matches the codebase convention.

- [ ] **Step 1: Write the component**

Create `web/src/lib/CliPage.svelte`:

```svelte
<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
  const t = $derived<Messages>(messages[lang()]);
  const repo = "https://github.com/relayium/relayium";
  const installCmd = "curl -fsSL https://relayium.com/install.sh | sh";
</script>

<section class="cli">
  <header>
    <h1>Relayium CLI</h1>
    <p class="sub">{t.cli.subtitle}</p>
  </header>

  <div class="block">
    <h2>Install</h2>
    <pre><code>{installCmd}</code></pre>
    <p class="alt">
      Or download a prebuilt binary from
      <a href={`${repo}/releases/latest`}>Releases</a>, or build from source:
    </p>
    <pre><code>{`git clone ${repo}.git
cd relayium/server
go build -o relayium ./cmd/relayium`}</code></pre>
  </div>

  <div class="block">
    <h2>push / pull — over your own SSH</h2>
    <p>Bytes travel over SSH to a host you already control. No Relayium account.</p>
    <pre><code>{`relayium push ./photos user@host:backups/
relayium pull user@host:backups/ ./restore`}</code></pre>
  </div>

  <div class="block">
    <h2>send / receive — by pairing code</h2>
    <p>Cross-network transfer between two people. Direct when reachable (free), metered relay as a fallback.</p>
    <pre><code>{`# sender
relayium send ./file.zip 123456
# receiver
relayium receive 123456 ./downloads`}</code></pre>
  </div>

  <div class="block">
    <h2>serve / push relayium:// — daemon direct</h2>
    <p>Two servers you control: one listens, the other pushes straight over pinned TLS. No relay, no SSH, no code.</p>
    <pre><code>{`# on the listener
relayium serve --dir ~/inbox
relayium id                 # prints this host's fingerprint

# authorize the pusher: add its \`relayium id\` output to
# ~/.config/relayium/authorized_fingerprints on the listener

# on the pusher
relayium push ./file.zip relayium://host.example.com`}</code></pre>
  </div>

  <footer><a href={repo}>Source on GitHub ↗</a></footer>
</section>

<style>
  .cli { max-width: 760px; margin: 0 auto; padding: var(--space-4) 0 var(--space-9); }
  header h1 { font-size: var(--fs-h2); color: var(--text-h); letter-spacing: -0.5px; }
  .sub { color: var(--text); margin-top: var(--space-1); }
  .block { margin-top: var(--space-7); }
  .block h2 { font-size: var(--fs-h3); color: var(--text-h); margin-bottom: var(--space-2); }
  .block p { color: var(--text); margin-bottom: var(--space-2); }
  .alt { font-size: var(--fs-sm); }
  pre {
    background: var(--social-bg); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: var(--space-3);
    overflow-x: auto; margin-bottom: var(--space-2);
  }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: var(--fs-sm); color: var(--text-h); white-space: pre;
  }
  footer { margin-top: var(--space-7); }
  a { color: var(--accent); }
</style>
```

- [ ] **Step 2: Type-check the new component compiles**

Run: `cd web && npm run check`
Expected: no errors (the component references only `t.cli.subtitle`, which exists after Task 6).

- [ ] **Step 3: Wire into App.svelte**

In `web/src/App.svelte`:

Add the import near the other page imports (~line 46):

```ts
  import CliPage from "./lib/CliPage.svelte";
```

Extend `surfaceShown` (~line 192) so the CLI docs page shows no transfer surface:

```ts
    currentRoute() === "download" || currentRoute() === "offline" || currentRoute() === "me" || currentRoute() === "cli"
```

Add the render branch in the route block (~line 1259–1261), before the final `{:else}`:

```svelte
  {:else if currentRoute() === "me"}
    <MePage />
  {:else if currentRoute() === "cli"}
    <CliPage />
  {:else}
```

- [ ] **Step 4: Type-check + full web tests**

Run: `cd web && npm run check && npx vitest run`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/CliPage.svelte web/src/App.svelte
git commit -m "feat(web): /cli docs page (install + three transfer modes)"
```

---

### Task 8: Nav 4th tab

**Files:**
- Modify: `web/src/lib/Nav.svelte`

**Interfaces:**
- Consumes: `CLI_PATH` (Task 5), `t.nav.cliTab` (Task 6), and the `cli` render branch (Task 7).

- [ ] **Step 1: Add the tab**

In `web/src/lib/Nav.svelte`:

Import `CLI_PATH`:

```ts
  import { currentRoute, navigate, CROSS_PATH, OFFLINE_PATH, CLI_PATH, type Route } from "./router.svelte";
```

Append to the `tabs` array:

```ts
    { id: "offline", label: () => t.nav.offlineTab },
    { id: "cli", label: () => t.nav.cliTab },
```

Extend the `href` ternary in the `{#each}` so `cli` points at `CLI_PATH`:

```svelte
        href={tab.id === "cross" ? CROSS_PATH : tab.id === "offline" ? OFFLINE_PATH : tab.id === "cli" ? CLI_PATH : "/"}
```

- [ ] **Step 2: Type-check + build**

Run: `cd web && npm run check && npm run build`
Expected: no errors; build succeeds.

- [ ] **Step 3: Manual smoke (real app)**

Run: `cd web && npm run dev`, open the app, click the **CLI** tab.
Expected: URL becomes `/cli`, the page shows the install one-liner and the three modes; other tabs still work; right-click "open in new tab" on the CLI tab opens `/cli` directly.

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/Nav.svelte
git commit -m "feat(web): CLI nav tab"
```

---

### Task 9: First release v0.1.0 (gated on user authorization)

**Files:** none (operational).

**Interfaces:**
- Consumes: Tasks 2 + 3 (goreleaser + workflow) must be merged to `main` and the repo must allow Actions with `contents: write`.

- [ ] **Step 1: Pre-flight — everything merged and green**

Run: `cd server && go test ./... && cd ../web && npm run check && npx vitest run && npm run build`
Expected: all pass. Confirm `.goreleaser.yaml` and `.github/workflows/release.yml` are on `main`.

- [ ] **Step 2: Deploy `main` first**

Ensure `main` is pushed and auto-deploy has run so `https://relayium.com/install.sh` and `https://relayium.com/cli` are live (the install command will 404 on the asset until Step 3).

Verify: `curl -fsSL https://relayium.com/install.sh | head -1`
Expected: the `#!/bin/sh` shebang line.

- [ ] **Step 3: Cut the tag (ask the user to confirm before pushing)**

```bash
git tag v0.1.0
git push origin v0.1.0
```

- [ ] **Step 4: Watch the release build**

Run: `gh run watch` (or check the Actions tab).
Expected: the `release` workflow succeeds and a `v0.1.0` Release appears with `relayium_<os>_<arch>.{tar.gz,zip}` + `checksums.txt`.

- [ ] **Step 5: End-to-end install verification (clean environment)**

On a clean machine or container (e.g. `docker run --rm -it alpine sh`, `apk add curl tar` first):

```sh
curl -fsSL https://relayium.com/install.sh | sh
relayium version
```

Expected: prints `v0.1.0` (or the installed path hint + version).

- [ ] **Step 6: Done** — the `/cli` page's install command now works end-to-end.

---

## Notes for the executor

- Tasks 1–4 (distribution) and Tasks 5–8 (frontend) are independent and can be built in either order; Task 9 requires all prior tasks merged and `main` deployed.
- All Go commands run from `server/`; all web commands from `web/`.
- Do not fix the `go install` module path (explicit non-goal); "build from source" on the page covers Go users.
- Keep goreleaser's `name_template` and `install.sh`'s `asset=` string byte-for-byte consistent — a divergence silently breaks the one-liner.
