// Package selfupdate upgrades the running relayium binary to the latest
// GitHub release — the native equivalent of re-running install.sh. It resolves
// the newest release tag, downloads the platform archive, verifies it (sha256
// against checksums.txt, plus an ECDSA signature over checksums.txt using a
// release public key embedded in this binary — Go stdlib only, no external
// tool), and atomically replaces the target binary. The live binary is touched
// only after the download verifies, so any earlier failure leaves it intact.
//
// Windows is out of scope here (a running .exe can't be overwritten); the CLI
// command handles that case before calling in.
package selfupdate

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	defaultAPIBase      = "https://api.github.com"
	defaultDownloadBase = "https://github.com"
)

// ErrFetch and ErrVerify classify why an update did not happen, because the
// fleet's reaction to the two is opposite.
//
// ErrFetch means the bytes could not be OBTAINED -- DNS, TLS, a reset, a 404.
// It says nothing about the release: it is a property of this machine's path to
// the host. A 404 is deliberately on this side; a mirror may simply not carry a
// file, and the node refuses to install either way.
//
// ErrVerify means the bytes ARRIVED and did not check out -- a checksum
// mismatch, or a signature that does not verify against the key compiled into
// this binary. That is either a broken release or something serving bytes it
// should not be, and it is the one category here that can be a security event.
var (
	ErrFetch  = errors.New("selfupdate: could not fetch release artifact")
	ErrVerify = errors.New("selfupdate: release artifact failed verification")
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
	// TargetTag pins the exact release to install. Empty means "latest" (the
	// CLI's `relayium update` behaviour). Node rollouts always set it: central
	// hands out an exact version so a release published mid-rollout can't
	// scatter the fleet across two versions.
	TargetTag string
	// AllowDowngrade permits installing a version older than CurrentVersion.
	// Off by default so nothing can walk a node back to a known-vulnerable
	// build; only an explicit rollback sets it.
	AllowDowngrade bool
	// AssetPrefix and BinaryName select WHICH artifact of a release to install:
	// the archive is "<AssetPrefix>_<goos>_<goarch>.tar.gz" and BinaryName is
	// the file extracted from it. Both default to the CLI's ("relayium"), so
	// `relayium update` is unaffected; relayium-node sets them to
	// "relayium-node" because the node ships in its own archive
	// (.goreleaser.yaml, install-node.sh).
	//
	// This picks the artifact, never the trust level: whatever it names is
	// still sha256-checked against checksums.txt and covered by the signature
	// over that file. checksums.txt lists EVERY artifact of the release, so a
	// wrong name here verifies perfectly and installs the wrong program — which
	// is precisely why it must be set deliberately per command.
	AssetPrefix string
	BinaryName  string
}

// DefaultAssetPrefix / DefaultBinaryName are the CLI's names, used when Options
// leaves AssetPrefix / BinaryName empty.
const (
	DefaultAssetPrefix = "relayium"
	DefaultBinaryName  = "relayium"
)

func (o Options) assetName() string {
	prefix := o.AssetPrefix
	if prefix == "" {
		prefix = DefaultAssetPrefix
	}
	return AssetNameFor(prefix, o.GOOS, o.GOARCH)
}

func (o Options) binaryName() string {
	if o.BinaryName == "" {
		return DefaultBinaryName
	}
	return o.BinaryName
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

// CompareVersions reports -1/0/1 for a<b / a==b / a>b over two release tags.
// ok=false when either isn't a plain numeric semver, in which case the result
// must not be trusted (a "dev" or unparseable current version never blocks an
// update).
//
// Exported because the admin panel decides whether a release is newer than
// what the fleet targets, and it lives in another package.
func CompareVersions(a, b string) (int, bool) {
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

// AssetName is the CLI's release archive for a Unix os/arch (goreleaser's
// naming). Other artifacts of the same release use AssetNameFor.
func AssetName(goos, goarch string) string {
	return AssetNameFor(DefaultAssetPrefix, goos, goarch)
}

// AssetNameFor is goreleaser's archive name for an artifact prefix, e.g.
// AssetNameFor("relayium-node", "linux", "amd64").
func AssetNameFor(prefix, goos, goarch string) string {
	return fmt.Sprintf("%s_%s_%s.tar.gz", prefix, goos, goarch)
}

// IsPlainVersion reports whether s is a plain "vMAJOR.MINOR.PATCH" release tag
// (leading "v" optional) — the only form Update can compare, and therefore the
// only form for which the downgrade check is meaningful. Exported so callers
// that pin an exact TargetTag can reject "latest"/"dev" up front instead of
// silently skipping that check.
func IsPlainVersion(s string) bool {
	_, ok := parseVer(s)
	return ok
}

// isCanonicalServerTag reports whether s is exactly a server release tag:
// ^v[0-9]+\.[0-9]+\.[0-9]+$. Stricter than IsPlainVersion, which accepts a bare
// "1.2.3" because it also has to read main.version (goreleaser drops the "v").
// Tag DISCOVERY is the other direction — it reads names out of a repository that
// carries several tag families — so here the leading "v" is required and the
// match must be exact. This is deliberately the same rule as
// scripts/release/server-tag.sh's is_canonical: the shape that repo refuses to
// tag or sign must not be a shape the updater agrees to install.
//
// The surrounding whitespace check is not decoration: parseVer trims space
// before it parses (it reads human-supplied flag values too), so without it a
// tag literally named "v1.2.3 " would match, and then every download URL built
// from it would 404.
func isCanonicalServerTag(s string) bool {
	if !strings.HasPrefix(s, "v") || s != strings.TrimSpace(s) {
		return false
	}
	_, ok := parseVer(s)
	return ok
}

// ErrNoRelease means the scan completed and found no published canonical server
// release — every release in the repository belonged to another tag family, or
// was a draft or a pre-release. It is NOT an error about reaching GitHub, and it
// must not be reported as "you are up to date": there is simply no server
// release to compare against.
var ErrNoRelease = errors.New("selfupdate: no published server release found")

// ErrScanTruncated means the scan ran out of its page budget while the release
// list still had more pages: the window it saw is incomplete, so no answer can
// be drawn from it. Like a fetch failure and unlike ErrNoRelease, this says
// "could not look", not "looked and there is nothing" — the repository may well
// have a newer server release, or its only one, on a page that was never asked
// for. The fix is to raise maxReleasePages, which is why the message names it.
var ErrScanTruncated = errors.New("selfupdate: release scan hit its page limit before the end of the list")

// releasesPerPage / maxReleasePages bound the scan below: at most
// maxReleasePages requests covering the most recent
// maxReleasePages*releasesPerPage releases. 100 is the API's maximum page size,
// so a repository with fewer than 100 releases — this one, today — is one
// request, the same cost as the releases/latest call this replaced.
//
// maxReleasePages is a budget for reaching the END of the list, not a sample
// size: a list that is still full at the cap fails with ErrScanTruncated rather
// than answering from what was read, so raising this number is the only way to
// keep a bigger repository working. Each increment costs one more request per
// check, per instance, per hour, against an unauthenticated 60/hour limit — but
// only for repositories whose lists are actually that long, since the scan stops
// at the first short page either way.
const (
	releasesPerPage = 100
	maxReleasePages = 5
)

// githubRelease is the part of a GitHub release object that tag discovery reads.
type githubRelease struct {
	TagName    string `json:"tag_name"`
	Draft      bool   `json:"draft"`
	Prerelease bool   `json:"prerelease"`
}

// LatestTag returns the highest published canonical server release tag
// (v<major>.<minor>.<patch>) in the repository.
//
// It does NOT use /releases/latest, and that is the whole point of this
// function. That endpoint is repository-wide: it returns the most recent
// non-draft, non-prerelease release of ANY tag family. This repo also releases
// the macOS app as `macos-v1.1.3` and friends, so on 2026-08-12 the central
// release check cached `macos-v1.1.3` as "the newest relayium release" — a
// string that is not a server version at all. The admin panel dropped it on the
// floor (releaseNotice refuses to offer a tag it cannot parse) and `relayium
// update --check` compared the running version against it and could only ever
// say "update available". The same failure returns on every macOS release, so
// the fix belongs here, in discovery, not in each reader.
//
// The rules, and why each one is here:
//
//   - Only ^v[0-9]+\.[0-9]+\.[0-9]+$ counts. Other families are not errors, they
//     are simply not server releases (see isCanonicalServerTag).
//   - Drafts and pre-releases are skipped. /releases/latest excluded both; the
//     list endpoint does not, so dropping them is what PRESERVES the old
//     behaviour rather than changing it.
//   - Every candidate is compared numerically and the highest wins. The API
//     documents no ordering guarantee this may rely on, and the one it does have
//     in practice — newest-created first — is the wrong key anyway: a hotfix
//     v0.9.1 published after v0.10.0 is more recent and lower. Sorting as text
//     would also put v0.9.0 above v0.10.0.
//
// The scan is bounded, because a repository's release list is unbounded and this
// runs hourly on every self-hosted instance. The bound is a page budget, not a
// coverage guarantee: pages are read until one comes back short, which is the
// end of the list, or until maxReleasePages have been read.
//
// Reaching that cap with a full final page returns ErrScanTruncated and NO tag,
// even when the pages already read held a perfectly good candidate. Returning
// the best-so-far there would be a claim about what the NEWEST release is, drawn
// from a window known to be missing releases — and the missing ones are the very
// releases most likely to matter, since page N+1 can hold v0.20.0 while pages 1
// through N hold v0.19.0, or hold the repository's only server tag while every
// scanned page is a foreign family. Neither of the two shapes that answer would
// take is survivable: naming an older release as the newest silently parks the
// fleet on it, and reporting ErrNoRelease against a repository that HAS a server
// release invites the reader to conclude the release channel is empty. 500 is
// far above this repository's real list, so hitting the cap means the budget
// needs raising, and an error is how that gets noticed rather than absorbed.
//
// Any page that fails to fetch or decode aborts the whole scan with its own
// error, on the same reasoning, and again even when an earlier page already
// produced a candidate. ReleaseChecker.CheckOnce turns any error into "keep the
// last known value and stay quiet", which is the correct outcome for every one
// of these: incomplete evidence leaves the panel showing what it last knew
// instead of quietly presenting an older release as the newest one.
//
// The Link header's rel="next" is deliberately not parsed. It carries no
// information this loop lacks — a page shorter than per_page is the last page —
// and depending on it would make the scan stop after page 1 against any mirror
// or proxy that drops the header, which is a silent truncation rather than a
// visible failure.
func LatestTag(ctx context.Context, o Options) (string, error) {
	best := ""
	reachedEnd := false
	for page := 1; page <= maxReleasePages; page++ {
		rels, err := fetchReleasePage(ctx, o, page)
		if err != nil {
			return "", err
		}
		for _, r := range rels {
			if r.Draft || r.Prerelease || !isCanonicalServerTag(r.TagName) {
				continue
			}
			if best == "" {
				best = r.TagName
				continue
			}
			// Both are canonical, so ok is always true. Checking it anyway
			// keeps an unreadable version from silently comparing as "not
			// newer" if that ever stops being true.
			if n, ok := CompareVersions(r.TagName, best); ok && n > 0 {
				best = r.TagName
			}
		}
		if len(rels) < releasesPerPage {
			reachedEnd = true // short page — this was the last one
			break
		}
	}
	// Checked before best, and deliberately not softened by having found one: a
	// truncated scan cannot say what the newest release is, so it says nothing.
	if !reachedEnd {
		return "", fmt.Errorf("check latest release: %w in %s (read %d pages of %d and the last was still full, so newer releases may be unscanned; raise maxReleasePages)",
			ErrScanTruncated, o.Repo, maxReleasePages, releasesPerPage)
	}
	if best == "" {
		return "", fmt.Errorf("check latest release: %w in %s (scanned the whole release list; tags of other families, drafts and pre-releases are not server releases)",
			ErrNoRelease, o.Repo)
	}
	return best, nil
}

// fetchReleasePage GETs one page of the repository's release list.
func fetchReleasePage(ctx context.Context, o Options, page int) ([]githubRelease, error) {
	u := fmt.Sprintf("%s/repos/%s/releases?per_page=%d&page=%d", o.apiBase(), o.Repo, releasesPerPage, page)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := o.httpClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("check latest release (page %d): %w", page, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("check latest release (page %d): unexpected status %d", page, resp.StatusCode)
	}
	var out []githubRelease
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("check latest release (page %d): %w", page, err)
	}
	return out, nil
}

// Update upgrades the binary at o.TargetPath to o.TargetTag, or to the latest
// release when TargetTag is empty. It returns the from/to versions and whether
// anything changed (false = already at the target and Force unset). On any
// failure the live binary is left untouched.
func Update(ctx context.Context, o Options, progress io.Writer) (from, to string, changed bool, err error) {
	tag := o.TargetTag
	if tag == "" {
		var err error
		if tag, err = LatestTag(ctx, o); err != nil {
			return o.CurrentVersion, "", false, err
		}
	}
	if SameVersion(tag, o.CurrentVersion) && !o.Force {
		return o.CurrentVersion, tag, false, nil
	}
	// Downgrade protection: refuse to install a release older than the running
	// version. This defends against a compromised or rolled-back release host
	// serving an OLD (known-vulnerable) but still validly-signed tag — signature
	// verification alone can't catch that, so bound it to same-or-newer. --force
	// overrides for a deliberate rollback (existing behaviour, unchanged);
	// AllowDowngrade is the same escape hatch for a fleet rollback driven by
	// central rather than a human running --force. An unparseable current
	// version ("dev") never blocks.
	// 版本地板（见 version_floor.go）。**必须排在 AllowDowngrade 那道检查之前，
	// 而且只认 o.Force**：AllowDowngrade 是中心下发的，如果地板也能被它越过，那么
	// 一个被攻破的中心照样能把车队降到有洞的旧版本——地板就白设了。
	if !o.Force && minSupportedVersion != "" {
		if cmp, ok := CompareVersions(tag, minSupportedVersion); ok && cmp < 0 {
			return o.CurrentVersion, tag, false, fmt.Errorf(
				"refusing to install %s: below the minimum version %s burned into this build "+
					"(a rollback past a security fix must be done on the machine itself with --force)",
				tag, minSupportedVersion)
		}
	}

	if !o.Force && !o.AllowDowngrade {
		if cmp, ok := CompareVersions(tag, o.CurrentVersion); ok && cmp < 0 {
			return o.CurrentVersion, tag, false, fmt.Errorf(
				"refusing to downgrade: latest release %s is older than the running %s (use --force to override)",
				tag, o.CurrentVersion)
		}
	}

	asset := o.assetName()
	base := o.downloadBase() + "/" + o.Repo + "/releases/download/" + tag

	tmp, err := os.MkdirTemp("", "relayium-update-")
	if err != nil {
		return o.CurrentVersion, tag, false, err
	}
	defer os.RemoveAll(tmp)

	fmt.Fprintf(progress, "Downloading %s (%s)...\n", asset, tag)
	archivePath := filepath.Join(tmp, asset)
	if err := download(ctx, o, base+"/"+asset, archivePath); err != nil {
		return o.CurrentVersion, tag, false, fmt.Errorf("download %s: %w: %w", asset, ErrFetch, err)
	}
	sumsPath := filepath.Join(tmp, "checksums.txt")
	if err := download(ctx, o, base+"/checksums.txt", sumsPath); err != nil {
		return o.CurrentVersion, tag, false, fmt.Errorf("download checksums: %w: %w", ErrFetch, err)
	}

	if err := verifyChecksum(archivePath, asset, sumsPath); err != nil {
		return o.CurrentVersion, tag, false, fmt.Errorf("%w: %w", ErrVerify, err)
	}
	if err := verifyReleaseSignature(ctx, o, base, tmp, sumsPath, progress); err != nil {
		return o.CurrentVersion, tag, false, err
	}

	if err := replaceFromArchive(archivePath, o.binaryName(), o.TargetPath); err != nil {
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

// verifyReleaseSignature verifies checksums.txt's ECDSA-P256 signature against
// the release public key embedded in THIS binary (releaseSigningPubKeyPEM),
// using only the Go standard library — no external cosign/openssl needed, so
// EVERY `relayium update` is signature-checked, not just runs on a machine that
// happens to have a verification tool installed. checksums.txt binds every
// artifact's sha256, so a valid signature over it (combined with the earlier
// per-artifact sha256 check) proves the archive is exactly what the signed
// release published — the defense against a compromised release host swapping in
// a malicious archive + matching (attacker-controlled) checksums.txt.
//
// Fail-closed: a missing or invalid signature aborts the update. The only escape
// is RELAYIUM_UPDATE_ALLOW_UNSIGNED=1, for a deliberately-unsigned build. When no
// key is embedded yet (releaseSigningPubKeyPEM empty — signing not configured),
// it falls back to checksum-only with a clear note so nothing breaks pre-rollout.
func verifyReleaseSignature(ctx context.Context, o Options, base, tmp, sumsPath string, progress io.Writer) error {
	if strings.TrimSpace(releaseSigningPubKeyPEM) == "" {
		fmt.Fprintln(progress, "Note: no release signing key embedded; verifying checksum only.")
		return nil
	}
	pub, err := parseECDSAPublicKey(releaseSigningPubKeyPEM)
	if err != nil {
		return fmt.Errorf("embedded release public key is invalid: %w", err)
	}
	sigPath := filepath.Join(tmp, "checksums.txt.sig")
	if err := download(ctx, o, base+"/checksums.txt.sig", sigPath); err != nil {
		if os.Getenv("RELAYIUM_UPDATE_ALLOW_UNSIGNED") == "1" {
			fmt.Fprintln(progress, "WARNING: release signature not found; verifying checksum only (RELAYIUM_UPDATE_ALLOW_UNSIGNED=1).")
			return nil
		}
		return fmt.Errorf("release signature (checksums.txt.sig) not found — refusing to install a possibly-unsigned build; set RELAYIUM_UPDATE_ALLOW_UNSIGNED=1 to override: %w: %w", ErrFetch, err)
	}
	sums, err := os.ReadFile(sumsPath)
	if err != nil {
		return err
	}
	sig, err := os.ReadFile(sigPath)
	if err != nil {
		return err
	}
	if err := verifyECDSASignature(pub, sums, sig); err != nil {
		return fmt.Errorf("release signature verification failed — refusing to install: %w: %w", ErrVerify, err)
	}
	fmt.Fprintln(progress, "Verified release signature.")
	return nil
}

// parseECDSAPublicKey decodes a PKIX/PEM ("BEGIN PUBLIC KEY") ECDSA public key,
// the format `openssl ec -pubout` emits.
func parseECDSAPublicKey(pemStr string) (*ecdsa.PublicKey, error) {
	blk, _ := pem.Decode([]byte(pemStr))
	if blk == nil {
		return nil, errors.New("no PEM block found")
	}
	key, err := x509.ParsePKIXPublicKey(blk.Bytes)
	if err != nil {
		return nil, err
	}
	pub, ok := key.(*ecdsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("not an ECDSA public key (%T)", key)
	}
	return pub, nil
}

// verifyECDSASignature checks an ASN.1/DER ECDSA signature over sha256(data) —
// exactly what `openssl dgst -sha256 -sign` produces (validated by a golden
// vector in signing_test.go), so the CI signing step needs only stock openssl.
func verifyECDSASignature(pub *ecdsa.PublicKey, data, derSig []byte) error {
	h := sha256.Sum256(data)
	if !ecdsa.VerifyASN1(pub, h[:], derSig) {
		return errors.New("signature does not match the embedded release key")
	}
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
