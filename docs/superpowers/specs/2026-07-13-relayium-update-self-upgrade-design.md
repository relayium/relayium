# `relayium update` — self-upgrade command

Date: 2026-07-13

## Goal

Add a `relayium update` subcommand that upgrades the CLI in place to the
latest GitHub release — the native equivalent of re-running `install.sh`,
so users don't have to remember the curl-pipe-to-shell line.

## Decisions

- **Pure Go, native.** No shelling out to `install.sh`/curl. The command
  queries the GitHub releases API, downloads the platform archive, verifies
  it, and atomically replaces the running binary.
- **Unix native; Windows prints manual instructions.** darwin/linux can
  rename over a running binary; Windows cannot overwrite a locked `.exe`, so
  `update` there prints "download the .zip from the releases page" and exits
  non-zero (parity with how `install.sh` treats Windows).

## Architecture

Isolated so the logic is testable without touching the real filesystem
binary or network:

- `server/internal/selfupdate/` — the logic. HTTP client, release repo, and
  target executable path are all injectable. No dependency on `main`.
- `server/cmd/relayium/update.go` — `runUpdate`: parse flags, wire
  `runtime.GOOS/GOARCH`, `os.Executable()` (symlink-resolved), the current
  `main.version`, and the Windows branch; delegate to `selfupdate`.
- `server/cmd/relayium/run.go` — add `case "update"` and one usage line.

### `internal/selfupdate` surface

```go
type Options struct {
    Repo           string       // "relayium/relayium"
    CurrentVersion string       // main.version, e.g. "v0.3.1" or "dev"
    GOOS, GOARCH   string
    TargetPath     string       // absolute path of the binary to replace
    HTTP           *http.Client
    APIBase        string       // default https://api.github.com; overridable in tests
    DownloadBase   string       // default https://github.com; overridable in tests
    Force          bool
}

// LatestTag returns the newest release tag (tag_name from releases/latest).
func LatestTag(ctx, opts) (string, error)

// Update performs the full flow; returns (from, to, changed, error).
// changed=false means "already latest" (and Force was not set).
func Update(ctx, opts, progress io.Writer) (from, to string, changed bool, err error)
```

## Flow (`Update`)

1. `LatestTag` → GET `{APIBase}/repos/{repo}/releases/latest`, parse
   `tag_name`.
2. If `CurrentVersion == tag` and not `Force` → return changed=false (caller
   prints "already up to date"). `dev` never equals a tag, so a source build
   proceeds (with a note printed by the caller).
3. Asset name `relayium_{os}_{arch}.tar.gz`. Download it and `checksums.txt`
   from `{DownloadBase}/{repo}/releases/download/{tag}/` into a temp dir.
4. **sha256**: compute the archive's digest, compare to its line in
   `checksums.txt`. Mismatch → error, target untouched.
5. **cosign (optional)**: only when `exec.LookPath("cosign")` succeeds *and*
   `checksums.txt.sig`/`.pem` download. Run `cosign verify-blob` with the
   same identity-regexp and OIDC issuer as `install.sh`. Failure → error.
   Absent → progress note "checksum-only".
6. Extract the `relayium` entry from the tar.gz to a temp file in the **same
   directory** as `TargetPath` (same filesystem → atomic rename), chmod
   0755.
7. `os.Rename(tmp, TargetPath)`. On Unix this succeeds even while the old
   binary runs. EACCES/EPERM → wrapped error telling the user to re-run with
   sudo or use the installer.
8. Return (CurrentVersion, tag, true, nil).

## HTTP client

Downloads use a client with **no blanket `Client.Timeout`** — only
transport-phase bounds (dial, TLS, `ResponseHeaderTimeout`) — so a multi-MB
archive over a slow link doesn't die mid-stream. (Same lesson as the
cloud-download timeout fix, commit 0a7511e.) The small API call rides a
context deadline.

## Flags

- `--check` — print current vs latest and whether an update is available;
  install nothing. Exit 0.
- `--force` — reinstall even when already on the latest tag.

`--version <tag>` is out of scope (YAGNI).

## Errors

- Target dir not writable → clear "permission denied; re-run with sudo, or
  `curl -fsSL https://relayium.com/install.sh | sh`".
- Verify failure / missing asset / network error → surfaced verbatim; the
  live binary is never touched (replace happens only after verify passes).
- Windows → manual-upgrade message, exit 1.

## Testing (`selfupdate_test.go`)

`httptest.Server` serving a fake `releases/latest` JSON, a real gzip+tar
archive containing a `relayium` file, and a matching `checksums.txt`:

- happy path: `TargetPath`'s bytes become the new archive's `relayium`
  payload; returns from→to, changed=true.
- already latest: changed=false, target untouched; `Force` makes it install.
- checksum mismatch: error, target untouched.
- asset 404: clear error.

cosign is absent under test → the checksum-only branch runs.

## Rollout

Ships in the next CLI tag (e.g. `v0.3.2`). Older installs still upgrade via
`install.sh`; from the first release that contains it, `relayium update`
self-upgrades thereafter.
