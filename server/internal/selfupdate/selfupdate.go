// Package selfupdate upgrades the running relayium binary to the latest
// GitHub release — the native equivalent of re-running install.sh. It resolves
// the newest release tag, downloads the platform archive, verifies it
// (sha256 always, cosign signature when cosign is on PATH), and atomically
// replaces the target binary. The live binary is touched only after the
// download verifies, so any earlier failure leaves it intact.
//
// Windows is out of scope here (a running .exe can't be overwritten); the CLI
// command handles that case before calling in.
package selfupdate

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	defaultAPIBase      = "https://api.github.com"
	defaultDownloadBase = "https://github.com"
	oidcIssuer          = "https://token.actions.githubusercontent.com"
)

// Options configures an update run. Repo/CurrentVersion/GOOS/GOARCH/TargetPath
// describe what to fetch and what to replace; APIBase, DownloadBase and HTTP
// are overridable so tests can point at an httptest server.
type Options struct {
	Repo           string // "relayium/relayium"
	CurrentVersion string // main.version, e.g. "v0.3.1" or "dev"
	GOOS, GOARCH   string
	TargetPath     string // absolute path of the binary to replace
	HTTP           *http.Client
	APIBase        string
	DownloadBase   string
	Force          bool
}

func (o Options) apiBase() string {
	if o.APIBase != "" {
		return strings.TrimRight(o.APIBase, "/")
	}
	return defaultAPIBase
}

func (o Options) downloadBase() string {
	if o.DownloadBase != "" {
		return strings.TrimRight(o.DownloadBase, "/")
	}
	return defaultDownloadBase
}

func (o Options) httpClient() *http.Client {
	if o.HTTP != nil {
		return o.HTTP
	}
	return DefaultHTTPClient()
}

// DefaultHTTPClient returns a client suited to downloading multi-MB release
// archives: it deliberately sets no blanket Client.Timeout — that caps the
// whole request including the body read, so a large or slow download would die
// mid-stream — and bounds only the fast phases (connect, TLS handshake,
// time-to-first-response-byte) via the transport. Same lesson as the
// cloud-download timeout fix.
func DefaultHTTPClient() *http.Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.ResponseHeaderTimeout = 30 * time.Second
	return &http.Client{Transport: tr}
}

// SameVersion reports whether two version strings denote the same release,
// ignoring a leading "v". This reconciles the installed binary's main.version
// (goreleaser's {{.Version}}, e.g. "0.3.1") with the release tag_name
// ("v0.3.1"). A non-release build ("dev") never matches a tag.
func SameVersion(a, b string) bool {
	return strings.TrimPrefix(a, "v") == strings.TrimPrefix(b, "v")
}

// parseVer parses a strict "vMAJOR.MINOR.PATCH" tag (optional leading 'v') into
// its three numeric parts. ok=false for anything else — "dev", a pre-release or
// build suffix, a non-numeric or wrong-arity string — so the caller treats the
// version as incomparable rather than guessing.
func parseVer(s string) ([3]int, bool) {
	s = strings.TrimPrefix(strings.TrimSpace(s), "v")
	if i := strings.IndexAny(s, "-+"); i >= 0 {
		return [3]int{}, false // pre-release / build metadata — not a plain release
	}
	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return [3]int{}, false
	}
	var out [3]int
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return [3]int{}, false
		}
		out[i] = n
	}
	return out, true
}

// compareVersions reports -1/0/1 for a<b / a==b / a>b over two release tags.
// ok=false when either isn't a plain numeric semver, in which case the result
// must not be trusted (a "dev" or unparseable current version never blocks an
// update).
func compareVersions(a, b string) (int, bool) {
	pa, oka := parseVer(a)
	pb, okb := parseVer(b)
	if !oka || !okb {
		return 0, false
	}
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			if pa[i] < pb[i] {
				return -1, true
			}
			return 1, true
		}
	}
	return 0, true
}

// AssetName is the release archive for a Unix os/arch (goreleaser's naming).
func AssetName(goos, goarch string) string {
	return fmt.Sprintf("relayium_%s_%s.tar.gz", goos, goarch)
}

// LatestTag returns the newest release tag (tag_name from releases/latest).
func LatestTag(ctx context.Context, o Options) (string, error) {
	u := o.apiBase() + "/repos/" + o.Repo + "/releases/latest"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := o.httpClient().Do(req)
	if err != nil {
		return "", fmt.Errorf("check latest release: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("check latest release: unexpected status %d", resp.StatusCode)
	}
	var out struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("check latest release: %w", err)
	}
	if out.TagName == "" {
		return "", errors.New("check latest release: response had no tag_name")
	}
	return out.TagName, nil
}

// Update upgrades the binary at o.TargetPath to the latest release. It returns
// the from/to versions and whether anything changed (false = already latest and
// Force unset). On any failure the live binary is left untouched.
func Update(ctx context.Context, o Options, progress io.Writer) (from, to string, changed bool, err error) {
	tag, err := LatestTag(ctx, o)
	if err != nil {
		return o.CurrentVersion, "", false, err
	}
	if SameVersion(tag, o.CurrentVersion) && !o.Force {
		return o.CurrentVersion, tag, false, nil
	}
	// Downgrade protection: refuse to install a release older than the running
	// version. Verification is checksum-only when cosign isn't present, so a
	// compromised or rolled-back release host that served an OLD (pre-cosign or
	// known-vulnerable) tag would otherwise pass — this bounds that to same-or-
	// newer. --force overrides for a deliberate rollback; an unparseable current
	// version ("dev") never blocks.
	if !o.Force {
		if cmp, ok := compareVersions(tag, o.CurrentVersion); ok && cmp < 0 {
			return o.CurrentVersion, tag, false, fmt.Errorf(
				"refusing to downgrade: latest release %s is older than the running %s (use --force to override)",
				tag, o.CurrentVersion)
		}
	}

	asset := AssetName(o.GOOS, o.GOARCH)
	base := o.downloadBase() + "/" + o.Repo + "/releases/download/" + tag

	tmp, err := os.MkdirTemp("", "relayium-update-")
	if err != nil {
		return o.CurrentVersion, tag, false, err
	}
	defer os.RemoveAll(tmp)

	fmt.Fprintf(progress, "Downloading %s (%s)...\n", asset, tag)
	archivePath := filepath.Join(tmp, asset)
	if err := download(ctx, o, base+"/"+asset, archivePath); err != nil {
		return o.CurrentVersion, tag, false, fmt.Errorf("download %s: %w", asset, err)
	}
	sumsPath := filepath.Join(tmp, "checksums.txt")
	if err := download(ctx, o, base+"/checksums.txt", sumsPath); err != nil {
		return o.CurrentVersion, tag, false, fmt.Errorf("download checksums: %w", err)
	}

	if err := verifyChecksum(archivePath, asset, sumsPath); err != nil {
		return o.CurrentVersion, tag, false, err
	}
	if err := verifyCosign(ctx, o, base, tmp, sumsPath, progress); err != nil {
		return o.CurrentVersion, tag, false, err
	}

	if err := replaceFromArchive(archivePath, "relayium", o.TargetPath); err != nil {
		return o.CurrentVersion, tag, false, err
	}
	return o.CurrentVersion, tag, true, nil
}

// download streams url into dest, distinguishing a 404 (missing asset — the
// common "no release published for this platform yet" case) from other errors.
func download(ctx context.Context, o Options, url, dest string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := o.httpClient().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return errors.New("not found (404)")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("unexpected status %d", resp.StatusCode)
	}
	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// verifyChecksum recomputes archivePath's sha256 and compares it to asset's
// line in the checksums file.
func verifyChecksum(archivePath, asset, sumsPath string) error {
	f, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	got := hex.EncodeToString(h.Sum(nil))

	want, err := checksumFor(sumsPath, asset)
	if err != nil {
		return err
	}
	if !strings.EqualFold(want, got) {
		return fmt.Errorf("checksum mismatch for %s (expected %s, got %s) — refusing to install", asset, want, got)
	}
	return nil
}

// checksumFor finds asset's digest in a goreleaser checksums.txt ("<hex>  <name>").
func checksumFor(sumsPath, asset string) (string, error) {
	b, err := os.ReadFile(sumsPath)
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(b), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[1] == asset {
			return fields[0], nil
		}
	}
	return "", fmt.Errorf("no checksum listed for %s", asset)
}

// verifyCosign verifies the checksum file's Sigstore signature. When cosign is
// absent it falls back to checksum-only (cosign is an optional external tool,
// mirroring install.sh). But once cosign IS installed the caller has opted into
// signature verification, so MISSING .sig/.pem assets are fatal, not silently
// skipped: a release-host compromise could otherwise delete the signatures and
// swap in a malicious archive + matching (attacker-controlled) checksums.txt to
// bypass signing entirely. RELAYIUM_UPDATE_ALLOW_UNSIGNED=1 is an explicit escape
// hatch for the rare genuinely-unsigned release. A present-but-failing
// verification is always fatal (a tampered checksums.txt).
func verifyCosign(ctx context.Context, o Options, base, tmp, sumsPath string, progress io.Writer) error {
	cosign, err := exec.LookPath("cosign")
	if err != nil {
		fmt.Fprintln(progress, "Note: cosign not found; verifying checksum only.")
		return nil
	}
	sigPath := filepath.Join(tmp, "checksums.txt.sig")
	pemPath := filepath.Join(tmp, "checksums.txt.pem")
	if download(ctx, o, base+"/checksums.txt.sig", sigPath) != nil ||
		download(ctx, o, base+"/checksums.txt.pem", pemPath) != nil {
		if os.Getenv("RELAYIUM_UPDATE_ALLOW_UNSIGNED") == "1" {
			fmt.Fprintln(progress, "WARNING: signature files not found; verifying checksum only (RELAYIUM_UPDATE_ALLOW_UNSIGNED=1).")
			return nil
		}
		return fmt.Errorf("release signature (.sig/.pem) not found but cosign is installed — refusing to install a possibly-unsigned build; set RELAYIUM_UPDATE_ALLOW_UNSIGNED=1 to override")
	}
	idRe := "^https://github.com/" + regexp.QuoteMeta(o.Repo) + "/\\.github/workflows/release\\.yml@"
	cmd := exec.CommandContext(ctx, cosign, "verify-blob",
		"--certificate", pemPath,
		"--signature", sigPath,
		"--certificate-identity-regexp", idRe,
		"--certificate-oidc-issuer", oidcIssuer,
		sumsPath)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("cosign signature verification failed — refusing to install: %v\n%s", err, out)
	}
	fmt.Fprintln(progress, "Verified release signature (cosign).")
	return nil
}

// replaceFromArchive extracts entryName from the tar.gz archive into a temp
// file in targetPath's own directory (same filesystem → atomic rename), makes
// it executable, and renames it over targetPath. On Unix the rename succeeds
// even while the old binary is still running.
func replaceFromArchive(archivePath, entryName, targetPath string) error {
	dir := filepath.Dir(targetPath)
	tmpf, err := os.CreateTemp(dir, ".relayium-update-*")
	if err != nil {
		return permHint(targetPath, err)
	}
	tmpName := tmpf.Name()
	defer os.Remove(tmpName) // harmless no-op once the rename below succeeds

	if err := extractInto(archivePath, entryName, tmpf); err != nil {
		tmpf.Close()
		return err
	}
	if err := tmpf.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, 0o755); err != nil {
		return err
	}
	if err := os.Rename(tmpName, targetPath); err != nil {
		return permHint(targetPath, err)
	}
	return nil
}

// extractInto streams the tar.gz's entryName (matched by base name) into w.
func extractInto(archivePath, entryName string, w io.Writer) error {
	f, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("read archive: %w", err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return fmt.Errorf("archive did not contain %q", entryName)
		}
		if err != nil {
			return fmt.Errorf("read archive: %w", err)
		}
		if hdr.Typeflag == tar.TypeReg && filepath.Base(hdr.Name) == entryName {
			if _, err := io.Copy(w, tr); err != nil {
				return err
			}
			return nil
		}
	}
}

// permHint turns a permission error on the target's directory into an
// actionable message (the binary often lives in a root-owned dir like
// /usr/local/bin), and passes other errors through wrapped.
func permHint(target string, err error) error {
	if errors.Is(err, fs.ErrPermission) {
		return fmt.Errorf("cannot write %s: %w\n  re-run with sudo, or reinstall with: curl -fsSL https://relayium.com/install.sh | sh", target, err)
	}
	return fmt.Errorf("replace %s: %w", target, err)
}
