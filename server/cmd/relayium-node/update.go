package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/relayium/relayium/selfupdate"
)

// updateRepo is the GitHub repo node updates are pulled from. Same repo as the
// CLI; the node ships in its own archive (see .goreleaser.yaml).
const updateRepo = "relayium/relayium"

// defaultBinPath is where install-node.sh puts the binary.
const defaultBinPath = "/usr/local/bin/relayium-node"

// Exit codes of `relayium-node update`. Part 2's central rollout queue reads
// them to record a result without parsing text, so each outcome gets its own
// code and they map to the queue's result states as follows:
//
//	0 exitOK              -> ok           new version installed and confirmed healthy
//	                                      (also "already on that version", a no-op;
//	                                      and, task 6, when -to is omitted and central
//	                                      answers "not this node's turn yet" — that is
//	                                      the overwhelmingly common answer on every
//	                                      poll of every node, forever, so it must never
//	                                      mark the systemd unit failed. It is not
//	                                      reported to central: this path returns
//	                                      before any result is recorded, so systemd and
//	                                      the operator are the only consumers)
//	2 exitUsage           -> skipped      bad or missing flags; nothing was attempted
//	3 exitAlreadyFailed   -> skipped      this version already failed here; refused
//	                                      (clear with -clear-failed once fixed)
//	4 exitPrecondition    -> skipped      the host needs a human first (stray .prev,
//	                                      unreadable binary): nothing was touched
//	5 exitUpdateFailed    -> failed       download/checksum/signature failed; the
//	                                      live binary was never touched
//	6 exitRestartFailed   -> rolled_back  new binary installed, service would not
//	                                      restart; old binary restored
//	7 exitNotHealthy      -> rolled_back  new binary ran but never heartbeated in
//	                                      the health window; old binary restored
//	8 exitFetchFailed     -> unreachable  the artifact could not be OBTAINED
//	                                      (DNS, TLS, a reset, a 404); says
//	                                      nothing about the release itself, so
//	                                      central advances the rollout queue
//	                                      past this node instead of halting the
//	                                      fleet for one machine's network
//
// Codes are API: renumbering one silently rewrites history in central's queue.
const (
	exitOK            = 0
	exitUsage         = 2
	exitAlreadyFailed = 3
	exitPrecondition  = 4
	exitUpdateFailed  = 5
	exitRestartFailed = 6
	exitNotHealthy    = 7
	// exitFetchFailed: the artifact could not be OBTAINED (DNS, TLS, a reset,
	// a 404). Distinct from exitUpdateFailed because it says nothing about the
	// release -- central advances the rollout queue past this node instead of
	// halting the fleet for one machine's network. See selfupdate.ErrFetch.
	exitFetchFailed = 8
)

// nodeAssetPrefix / nodeBinaryName name the NODE's release artifact:
// "relayium-node_<os>_<arch>.tar.gz" containing "relayium-node"
// (.goreleaser.yaml archives id relayium-node, install-node.sh). They must be
// passed to selfupdate, whose defaults are the CLI's names — checksums.txt
// covers every artifact of a release, so fetching the CLI archive here would
// verify perfectly and then install the CLI over the node binary.
const (
	nodeAssetPrefix = "relayium-node"
	nodeBinaryName  = "relayium-node"
)

// defaultEnvFile is the KEY=value file install-node.sh writes and the systemd
// unit loads with EnvironmentFile. `sudo relayium-node update` runs with a
// scrubbed environment and no EnvironmentFile, so the updater reads it itself —
// otherwise a node whose state dir was moved is watched at the wrong path,
// never looks healthy, and gets rolled back after a full outage window.
const defaultEnvFile = "/etc/relayium-node/env"

type updateConfig struct {
	StateDir       string
	BinPath        string
	TargetTag      string
	AllowDowngrade bool
	ClearFailed    bool
	Repo           string

	// CentralURL and NodeToken are used ONLY when TargetTag is empty, to ask
	// central which version this node should run (task 6). Same precedence
	// chain as StateDir/BinPath: explicit flag > process env > env file >
	// built-in default (none here — an empty value simply fails the central
	// call with a clear error, same as a hand-typed -to being required used to).
	CentralURL string
	NodeToken  string

	// TargetFromCentral is true only when TargetTag was resolved by
	// resolveTargetFromCentral, never for a hand-typed -to. runUpdate uses it
	// to gate recordPendingResult (finding 2): a node that currently holds the
	// fleet slot has none of central's defences against an uncommanded
	// result, so reporting the outcome of a human-run -to can wedge the track
	// (a manual success looks like "still not on target, not failed, not
	// skipped" forever) or halt it for an action central never commanded.
	TargetFromCentral bool

	// APIBase and DownloadBase override the GitHub hosts selfupdate.Update talks
	// to: tests point them at an httptest server to drive the full orchestration
	// (backup, restart, health check, rollback) without a network dependency,
	// and DownloadBase additionally carries RELAYIUM_NODE_UPDATE_BASE — the
	// escape hatch for a host that cannot reach github.com (China, mainly).
	// Pointing it at central's mirror is NOT a weakening: the archive is still
	// checksummed and signature-verified here, against a key compiled into this
	// binary, so a mirror that served something else fails before install.
	APIBase      string
	DownloadBase string
}

// parseUpdateFlags parses `relayium-node update` arguments. The target version
// is never resolved to "latest" on its own — either it is given explicitly via
// -to, or (task 6) it is omitted and asked of central's rollout queue instead
// (see fetchTarget / resolveTargetFromCentral in runUpdate). Either way a
// rollout that raced a new release, or a node guessing on its own, would leave
// the fleet on two versions; this command never guesses.
//
// Config precedence for the paths, and for CentralURL/NodeToken: explicit
// flag > process environment > /etc/relayium-node/env (the unit's
// EnvironmentFile) > built-in default.
func parseUpdateFlags(args []string, stderr io.Writer) (updateConfig, error) {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	fs.SetOutput(stderr)
	uc := updateConfig{Repo: updateRepo}
	var envFile string
	fs.StringVar(&uc.StateDir, "state-dir", env("RELAYIUM_NODE_STATE_DIR", ""), "directory holding state.json (default from "+defaultEnvFile+", else /var/lib/relayium-node)")
	fs.StringVar(&uc.BinPath, "bin", env("RELAYIUM_NODE_BIN", ""), "path of the binary to replace (default from "+defaultEnvFile+", else "+defaultBinPath+")")
	fs.StringVar(&uc.TargetTag, "to", "", "exact release tag to install, e.g. v0.9.0 (omit to ask central which version this node should run)")
	fs.StringVar(&uc.CentralURL, "central-url", env("RELAYIUM_CENTRAL_URL", ""), "central relayium server base URL; used only when -to is omitted (default from "+defaultEnvFile+")")
	fs.StringVar(&uc.NodeToken, "node-token", env("RELAYIUM_NODE_TOKEN", ""), "node bearer token; used only when -to is omitted (default from "+defaultEnvFile+")")
	fs.BoolVar(&uc.AllowDowngrade, "allow-downgrade", false, "permit installing a version older than the running one")
	fs.BoolVar(&uc.ClearFailed, "clear-failed", false, "forget every version recorded as failed on this node (clears "+failedVersionsFile+" and exits); use after a bad rollout was fixed centrally")
	fs.StringVar(&envFile, "env-file", defaultEnvFile, "KEY=value file to read RELAYIUM_NODE_* defaults from; missing file is fine")
	if err := fs.Parse(args); err != nil {
		return uc, err
	}

	// Fill in anything still unset from the unit's EnvironmentFile, then from
	// the built-in defaults. Values that came from a flag or the process
	// environment are already non-empty and are left alone.
	fileEnv := readEnvFile(envFile)
	if uc.StateDir == "" {
		uc.StateDir = valueOr(fileEnv["RELAYIUM_NODE_STATE_DIR"], "/var/lib/relayium-node")
	}
	if uc.BinPath == "" {
		uc.BinPath = valueOr(fileEnv["RELAYIUM_NODE_BIN"], defaultBinPath)
	}
	if uc.CentralURL == "" {
		uc.CentralURL = fileEnv["RELAYIUM_CENTRAL_URL"] // no built-in default; empty fails clearly when actually needed
	}
	if uc.NodeToken == "" {
		uc.NodeToken = fileEnv["RELAYIUM_NODE_TOKEN"]
	}
	if uc.DownloadBase == "" {
		// e.g. https://relayium.com/gh — the asset path under it is GitHub's own
		// shape, so this is a pure prefix swap.
		uc.DownloadBase = valueOr(env("RELAYIUM_NODE_UPDATE_BASE", ""), fileEnv["RELAYIUM_NODE_UPDATE_BASE"])
	}

	if uc.ClearFailed {
		return uc, nil // -clear-failed is standalone; -to is not required with it
	}
	if uc.TargetTag == "" {
		return uc, nil // ask central (task 6); resolved later in runUpdate
	}
	// Reject anything that isn't a plain vMAJOR.MINOR.PATCH. selfupdate treats
	// an unparseable tag as incomparable, so "latest"/"dev" would sail past the
	// downgrade check unnoticed — and no such asset exists to download anyway.
	if !selfupdate.IsPlainVersion(uc.TargetTag) {
		return uc, fmt.Errorf("relayium-node update: -to %q is not a release version (want vMAJOR.MINOR.PATCH, e.g. v0.9.0)", uc.TargetTag)
	}
	return uc, nil
}

func valueOr(v, def string) string {
	if v != "" {
		return v
	}
	return def
}

// readEnvFile parses a systemd-style KEY=value file into a map. Blank lines and
// "#" comments are ignored, surrounding quotes on the value are stripped, and
// nothing is executed or expanded — this is a data file, not a shell script. A
// missing or unreadable file yields an empty map: a node installed by
// install-node.sh always has one, a dev machine never does.
func readEnvFile(path string) map[string]string {
	out := map[string]string{}
	if path == "" {
		return out
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		v = strings.TrimSpace(v)
		if len(v) >= 2 && (v[0] == '"' && v[len(v)-1] == '"' || v[0] == '\'' && v[len(v)-1] == '\'') {
			v = v[1 : len(v)-1]
		}
		if k != "" {
			out[k] = v
		}
	}
	return out
}

// serviceCtl restarts the node service. An interface so tests don't shell out.
type serviceCtl interface{ Restart() error }

type systemctlCtl struct{ Unit string }

func (s systemctlCtl) Restart() error {
	cmd := exec.Command("systemctl", "restart", s.Unit)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("systemctl restart %s: %w (%s)", s.Unit, err, bytes.TrimSpace(out))
	}
	return nil
}

// waitHealthy reports whether the node produced a successful heartbeat AFTER
// `since` AND from version `target`, within timeout. Both halves are required:
//
//   - Comparing against `since` (the restart moment) rejects a heartbeat left
//     behind by the previous version before it was replaced.
//   - Comparing the recorded version against `target` rejects a heartbeat that
//     is genuinely fresh but came from a process still running the OLD binary.
//     That happens whenever the unit executes a path other than the one this
//     command replaced — `-bin`/RELAYIUM_NODE_BIN make that path configurable,
//     and a host whose unit runs the binary from a custom install path while the
//     updater defaults to /usr/local/bin/relayium-node would otherwise report a
//     confident false success.
//
// The comparison goes through selfupdate.SameVersion because the binary's
// version is goreleaser-stamped without the leading "v" ("0.9.0") while the
// target tag carries it ("v0.9.0"). An empty recorded version means "unknown"
// (a marker written by a node older than this format) and deliberately does NOT
// match — see lastHealthy for why rolling back is the safe direction.
//
// Note on granularity: lastHealthy's timestamp is a file mtime, and on a
// filesystem that truncates mtimes downward (e.g. to whole seconds), the
// comparison here can only err toward treating a genuinely healthy heartbeat as
// too-early and rolling back a working node — it can never make a heartbeat
// that didn't happen appear to be after `since`, so a broken node is never
// mistaken for a healthy one by this effect.
func waitHealthy(stateDir string, since time.Time, target string, timeout, poll time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		if ts, ver, err := lastHealthy(stateDir); err == nil && ts.After(since) &&
			ver != "" && selfupdate.SameVersion(ver, target) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(poll)
	}
}

// healthWindow is how long the updater waits for the new version to prove
// itself by completing one heartbeat.
const healthWindow = 10 * time.Minute

// nodeUnit is the systemd unit install-node.sh creates.
const nodeUnit = "relayium-node"

func runUpdate(uc updateConfig, stdout, stderr io.Writer) int {
	// -to omitted (and this isn't the standalone -clear-failed action): ask
	// central which version to run instead of failing outright (task 6).
	// -clear-failed never touches the network — it is a purely local
	// maintenance action and must work even with no CentralURL configured.
	if !uc.ClearFailed && uc.TargetTag == "" {
		if code, ok := resolveTargetFromCentral(&uc, stdout, stderr); !ok {
			return code
		}
	}
	code := runUpdateWith(uc, systemctlCtl{Unit: nodeUnit}, healthWindow, 2*time.Second, stdout, stderr)
	// Record this attempt's outcome so the NEXT poll can report it to central.
	// Gated on TargetFromCentral (finding 2): a hand-run -to is a local action
	// central never commanded, and reporting its result anyway can wedge or
	// halt the fleet track for a change the rollout queue knows nothing about
	// (see updateConfig.TargetFromCentral). -clear-failed is excluded for a
	// different reason: its exitOK means "forgot some failed versions", not
	// "installed and confirmed healthy", and must never be reported to central
	// as a successful update — though in practice -clear-failed and a central
	// target are mutually exclusive anyway.
	if uc.TargetFromCentral && !uc.ClearFailed {
		recordPendingResult(uc.StateDir, code, stderr)
	}
	return code
}

// centralRequestTimeout bounds the update-check round trip. Unlike
// selfupdate.DefaultHTTPClient (which deliberately sets no Client.Timeout, so
// a large in-flight download is never killed mid-stream) this is a small JSON
// request and must not hang if central is unreachable or wedged. A dedicated
// client is used here rather than reusing or mutating the download client.
const centralRequestTimeout = 10 * time.Second

// resolveTargetFromCentral fills in uc.TargetTag and uc.AllowDowngrade by
// polling central (task 6), and piggybacks the previous update's pending
// result on the same call. Returns ok=false with the exit code the caller
// must return immediately: central unreachable/erroring or a bad answer
// (exitUpdateFailed, binary untouched), central not configured or this node
// not yet registered (exitPrecondition/exitUpdateFailed, nothing touched), or
// central saying it isn't this node's turn (exitOK — see the exit-code table
// above; not an error, and this is the overwhelmingly common answer since
// every node asks every few minutes forever). Returns ok=true once uc carries
// a validated target, uc.TargetFromCentral is set, and the ordinary update
// flow should proceed.
func resolveTargetFromCentral(uc *updateConfig, stdout, stderr io.Writer) (int, bool) {
	if uc.CentralURL == "" {
		fmt.Fprintln(stderr, "update-check: central URL is not configured; set -central-url or RELAYIUM_CENTRAL_URL (directly or via "+defaultEnvFile+")")
		return exitPrecondition, false
	}
	// Read-only: unlike the node process itself, the root-run updater must
	// never conjure state.json into existence (finding 4). loadState does
	// exactly that on a missing file, which would leave a root-owned
	// state.json/dir that the unprivileged node service can't read, turning a
	// benign polling failure into a bricked node.
	st, err := loadStateReadOnly(uc.StateDir)
	if err != nil {
		fmt.Fprintf(stderr, "update-check: %v\n", err)
		return exitUpdateFailed, false
	}
	prev := loadPendingResult(uc.StateDir)
	hc := &http.Client{Timeout: centralRequestTimeout}
	tag, eligible, allowDowngrade, err := fetchTarget(uc.CentralURL, uc.NodeToken, st.NodeID, version, prev, hc)
	if err != nil {
		// Central unreachable, or any non-200 (including a bad token, which
		// must be loud — never silently read as "not my turn", or this node
		// would sit un-updated forever while looking healthy). The binary is
		// never touched on this path.
		fmt.Fprintf(stderr, "update-check failed, binary untouched: %v\n", err)
		return exitUpdateFailed, false
	}
	// The poll itself succeeded (central accepted and answered), so whatever
	// previous result we carried has now been delivered — clear it so it is
	// not sent again on every future poll. This must happen regardless of
	// `eligible`: delivery, not action, is what retires the pending marker.
	clearPendingResult(uc.StateDir, stderr)
	if !eligible {
		// The overwhelmingly common answer, forever. exitOK (not an error):
		// see the exit-code table's 0 entry above for why this must never mark
		// the systemd unit failed.
		if tag != "" {
			fmt.Fprintf(stdout, "central: not this node's turn yet (target %s)\n", tag)
		} else {
			fmt.Fprintln(stdout, "central: no rollout target for this node right now")
		}
		return exitOK, false
	}
	// Central can have bugs too: validate exactly like a hand-typed -to.
	if !selfupdate.IsPlainVersion(tag) {
		fmt.Fprintf(stderr, "central sent %q, which is not a release version (want vMAJOR.MINOR.PATCH) — refusing\n", tag)
		return exitUpdateFailed, false
	}
	uc.TargetTag = tag
	// AllowDowngrade comes from central's answer on this path: central is the
	// one deciding whether the track has been rolled back, and a hand-typed
	// -allow-downgrade never applies here (there is no hand-typed -to).
	// selfupdate.Options.Force is never set — Force implies AllowDowngrade in
	// that package, which would defeat downgrade protection on every node.
	uc.AllowDowngrade = allowDowngrade
	// Marks this result as reportable to central (finding 2): a hand-run -to
	// never sets this, so recordPendingResult in runUpdate stays a no-op for
	// it — see updateConfig.TargetFromCentral.
	uc.TargetFromCentral = true
	return 0, true
}

// fetchTarget asks central what this node should be running. It POSTs
// {nodeID, currentVersion, result} to <centralURL>/api/nodes/update-check
// with a bearer token, matching handleUpdateCheck's updateCheckReq/Resp
// exactly (server/account/nodes.go). Any non-200 status is an error;
// central's answer is otherwise trusted verbatim (validated by the caller).
func fetchTarget(centralURL, token, nodeID, currentVersion, prevResult string, hc *http.Client) (tag string, eligible, allowDowngrade bool, err error) {
	reqBody, err := json.Marshal(struct {
		NodeID         string `json:"nodeID"`
		CurrentVersion string `json:"currentVersion"`
		Result         string `json:"result,omitempty"`
	}{NodeID: nodeID, CurrentVersion: currentVersion, Result: prevResult})
	if err != nil {
		return "", false, false, err
	}
	req, err := http.NewRequest(http.MethodPost, strings.TrimRight(centralURL, "/")+"/api/nodes/update-check", bytes.NewReader(reqBody))
	if err != nil {
		return "", false, false, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := hc.Do(req)
	if err != nil {
		return "", false, false, fmt.Errorf("update-check: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
		return "", false, false, fmt.Errorf("update-check: central returned %d: %s", resp.StatusCode, bytes.TrimSpace(body))
	}
	var out struct {
		TargetVersion  string `json:"targetVersion"`
		Eligible       bool   `json:"eligible"`
		AllowDowngrade bool   `json:"allowDowngrade"`
		Reason         string `json:"reason,omitempty"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", false, false, fmt.Errorf("update-check: decode response: %w", err)
	}
	return out.TargetVersion, out.Eligible, out.AllowDowngrade, nil
}

// pendingResultFile holds the outcome of the last actually-attempted update,
// waiting to be reported to central on the next update-check poll. Without
// this, a result computed while central happened to be unreachable would be
// lost forever and the rollout queue would never learn of a real failure.
const pendingResultFile = "pending-update-result"

// resultForExitCode maps a run's exit code onto the closed set of result
// strings central accepts (updateResults in nodes.go: ok/failed/rolled_back/
// skipped/unreachable), matching the exit-code table above exactly.
// exitAlreadyFailed and exitPrecondition map to "skipped": decideFleet has a
// dedicated branch whose whole purpose is advancing the rollout queue past a
// node that will never reach the target, WITHOUT halting — central needs that
// signal, or a node refusing locally (a version already in failed-versions, a
// stray .prev) just keeps heartbeating happily until the 15-minute silence
// check halts the entire fleet rollout for a human, instead of skipping one
// node. exitFetchFailed maps to "unreachable" for the same shape of reason:
// the artifact was never obtained, which says nothing about the release, so
// the queue advances past this node instead of halting the fleet for one
// machine's network (see exitCodeForUpdateError). Only exitUsage (bad flags;
// nothing was even parsed enough to attempt anything) has genuinely nothing
// to tell central and maps to "".
func resultForExitCode(code int) string {
	switch code {
	case exitOK:
		return "ok"
	case exitUpdateFailed:
		return "failed"
	case exitRestartFailed, exitNotHealthy:
		return "rolled_back"
	case exitAlreadyFailed, exitPrecondition:
		return "skipped"
	case exitFetchFailed:
		return "unreachable"
	default:
		return ""
	}
}

// exitCodeForUpdateError classifies a selfupdate.Update failure. Only the
// fetch case is special: everything else — including a verification failure,
// AND any error carrying neither sentinel — keeps the existing
// exitUpdateFailed, so the track still halts. This is deliberately written as
// "if ErrFetch then advance, else halt" rather than "if ErrVerify then halt,
// else advance": verifyReleaseSignature has paths (a missing signature file,
// a corrupt embedded signing key) that carry neither sentinel, and a corrupt
// embedded key would fail identically on every node in the fleet. The second
// phrasing would read that as "not ErrVerify" and silently roll a broken
// release across the whole fleet; the first phrasing halts it, correctly.
func exitCodeForUpdateError(err error) int {
	if errors.Is(err, selfupdate.ErrFetch) {
		return exitFetchFailed
	}
	return exitUpdateFailed
}

// recordPendingResult persists code's result for the next poll to send. A
// code with nothing reportable (resultForExitCode returns "") is a no-op that
// leaves any existing pending file untouched — a local no-op run must never
// erase an earlier real failure that hasn't been delivered yet.
//
// Deliberately does NOT os.MkdirAll the state dir (finding 4, same hazard as
// loadState): this runs as root, the node runs as an unprivileged service
// user, and a missing/mistyped state dir must surface as a loud write error
// here, not conjure a root-owned directory the node can never read.
func recordPendingResult(stateDir string, code int, w io.Writer) {
	result := resultForExitCode(code)
	if result == "" {
		return
	}
	if err := os.WriteFile(pendingResultPath(stateDir), []byte(result), 0o600); err != nil {
		fmt.Fprintf(w, "could not record pending result %s: %v\n", result, err)
	}
}

// loadPendingResult reads back what recordPendingResult wrote. A missing file
// is the normal state (nothing pending, or already delivered) and yields "".
func loadPendingResult(stateDir string) string {
	b, err := os.ReadFile(pendingResultPath(stateDir))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// clearPendingResult removes the pending-result marker once central has
// acknowledged it (a successful update-check round trip). A missing file is
// success. A failed remove is logged, not swallowed: otherwise the same stale
// result would be re-POSTed on every future poll forever, eventually
// overwriting a later, different outcome.
func clearPendingResult(stateDir string, w io.Writer) {
	if err := os.Remove(pendingResultPath(stateDir)); err != nil && !os.IsNotExist(err) {
		fmt.Fprintf(w, "could not clear delivered pending result: %v\n", err)
	}
}

func pendingResultPath(stateDir string) string { return filepath.Join(stateDir, pendingResultFile) }

// updateOptions builds the selfupdate.Options for uc. Pulled out of
// runUpdateWith so it can be unit-tested directly (minor 6): in particular,
// HTTP is deliberately left unset, so selfupdate.Update falls back to
// selfupdate.DefaultHTTPClient — which sets no blanket Client.Timeout, since
// one would kill a large in-flight download mid-stream. Force is likewise
// never set here: in that package it already implies AllowDowngrade, which
// would defeat downgrade protection on every node.
func updateOptions(uc updateConfig) selfupdate.Options {
	return selfupdate.Options{
		Repo:           uc.Repo,
		CurrentVersion: version,
		GOOS:           runtime.GOOS,
		GOARCH:         runtime.GOARCH,
		TargetPath:     uc.BinPath,
		TargetTag:      uc.TargetTag,
		AllowDowngrade: uc.AllowDowngrade,
		APIBase:        uc.APIBase,
		DownloadBase:   uc.DownloadBase,
		AssetPrefix:    nodeAssetPrefix,
		BinaryName:     nodeBinaryName,
	}
}

// runUpdateWith is runUpdate with its side-effecting dependencies injected so
// the rollback path can be tested without systemd.
func runUpdateWith(uc updateConfig, svc serviceCtl, window, poll time.Duration, stdout, stderr io.Writer) int {
	if uc.ClearFailed {
		if err := clearFailed(uc.StateDir); err != nil {
			fmt.Fprintf(stderr, "could not clear %s: %v\n", failedVersionsFile, err)
			return exitPrecondition
		}
		fmt.Fprintf(stdout, "cleared %s; previously-failed versions may be retried\n",
			filepath.Join(uc.StateDir, failedVersionsFile))
		return exitOK
	}
	if failedBefore(uc.StateDir, uc.TargetTag) {
		fmt.Fprintf(stderr, "refusing to retry %s: it already failed on this node\n", uc.TargetTag)
		fmt.Fprintf(stderr, "if that version has since been fixed, run: relayium-node update -clear-failed\n")
		return exitAlreadyFailed
	}
	// A leftover .prev means an earlier run was killed mid-watchdog. Backing up
	// over it would replace the last known-good binary with the possibly-broken
	// current one, so a later rollback would restore the broken binary. Refuse
	// and let a human look at it — this is rare and never worth guessing at.
	if _, err := os.Stat(backupPath(uc.BinPath)); err == nil {
		fmt.Fprintf(stderr, "refusing to update: a previous backup already exists at %s\n", backupPath(uc.BinPath))
		fmt.Fprintf(stderr, "an earlier update was interrupted. Compare it with %s: if %s is healthy, delete the backup; otherwise restore it (mv %s %s) and restart %s. Then re-run (add -clear-failed if the version was blacklisted).\n",
			uc.BinPath, uc.BinPath, backupPath(uc.BinPath), uc.BinPath, nodeUnit)
		return exitPrecondition
	}
	if err := backupBinary(uc.BinPath); err != nil {
		fmt.Fprintf(stderr, "backup failed, not touching the binary: %v\n", err)
		return exitPrecondition
	}

	from, to, changed, err := selfupdate.Update(context.Background(), updateOptions(uc), stdout)
	if err != nil {
		// Verification or download failed — the live binary was never touched.
		// exitCodeForUpdateError tells the two apart so central can advance the
		// queue past a node that merely could not reach the artifact, while
		// still halting on anything that says the release itself is bad.
		fmt.Fprintf(stderr, "update to %s failed, binary untouched: %v\n", uc.TargetTag, err)
		os.Remove(backupPath(uc.BinPath)) // nothing to roll back to; don't leave a stray .prev
		return exitCodeForUpdateError(err)
	}
	if !changed {
		fmt.Fprintf(stdout, "already on %s, nothing to do\n", to)
		os.Remove(backupPath(uc.BinPath)) // no-op update; don't leave a stray .prev
		return exitOK
	}

	if err := svc.Restart(); err != nil {
		fmt.Fprintf(stderr, "restart failed: %v — rolling back\n", err)
		rollback(uc, svc, stderr)
		return exitRestartFailed
	}
	// restartedAt is captured AFTER svc.Restart() returns, not before. Do not
	// "simplify" this back — it is load-bearing: sendHeartbeat (relay.go) only
	// calls markHealthy AFTER its HTTP round trip completes, and the reporter's
	// client timeout is 15s. If the OLD binary was mid-heartbeat when
	// `systemctl restart` was issued, that in-flight call can complete and stamp
	// the health file with a time that is after a `restartedAt` taken too early
	// — which would make waitHealthy report the NEW binary healthy when it
	// never even started. Capturing restartedAt here is safe: `systemctl
	// restart` is synchronous (Restart() already returned, so the start job
	// finished), and the restarted node's first genuine heartbeat fires a full
	// ticker interval (>= 30s) later, so no real heartbeat can be missed by
	// taking the timestamp this late.
	restartedAt := time.Now()

	if !waitHealthy(uc.StateDir, restartedAt, uc.TargetTag, window, poll) {
		fmt.Fprintf(stderr, "%s did not heartbeat within %s — rolling back to %s\n", to, window, from)
		rollback(uc, svc, stderr)
		recordFailed(uc.StateDir, uc.TargetTag, stderr)
		return exitNotHealthy
	}

	fmt.Fprintf(stdout, "updated %s -> %s and confirmed healthy\n", from, to)
	os.Remove(backupPath(uc.BinPath))
	return exitOK
}

// rollback restores the previous binary and restarts. Best-effort and loud:
// if this fails the node is down and needs a human.
func rollback(uc updateConfig, svc serviceCtl, stderr io.Writer) {
	if err := restoreBinary(uc.BinPath); err != nil {
		fmt.Fprintf(stderr, "CRITICAL: rollback failed, node is likely down: %v\n", err)
		return
	}
	if err := svc.Restart(); err != nil {
		fmt.Fprintf(stderr, "CRITICAL: restart after rollback failed: %v\n", err)
	}
}

// failedVersionsFile lists releases that already broke this node. Without it a
// node that rolls back would be told to install the same bad version on the
// next tick, forever.
const failedVersionsFile = "failed-versions"

func recordFailed(stateDir, tag string, w io.Writer) {
	p := filepath.Join(stateDir, failedVersionsFile)
	f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		fmt.Fprintf(w, "could not record failed version %s: %v\n", tag, err)
		return
	}
	defer f.Close()
	if _, err := fmt.Fprintln(f, tag); err != nil {
		fmt.Fprintf(w, "could not record failed version %s: %v\n", tag, err)
	}
}

// clearFailed forgets every recorded failure on this node. Needed because the
// record is otherwise permanent: a version that failed for a reason since fixed
// elsewhere (a bad artifact, a host problem) can never be installed again
// without an operator deleting the file by hand on every host. A missing file
// is success — the desired state is "nothing blacklisted".
func clearFailed(stateDir string) error {
	err := os.Remove(filepath.Join(stateDir, failedVersionsFile))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// failedBefore reports whether tag already failed on this node. Matching is
// whole-line so v0.9.0 failing never blocks v0.9.01.
func failedBefore(stateDir, tag string) bool {
	b, err := os.ReadFile(filepath.Join(stateDir, failedVersionsFile))
	if err != nil {
		return false // no record (or unreadable) means nothing is known to have failed
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.TrimSpace(line) == tag {
			return true
		}
	}
	return false
}

// backupPath is where the pre-update binary is kept so a broken new version can
// be undone locally. It lives next to the binary, owned by root and outside the
// node sandbox's writable paths — a compromised node cannot touch it.
func backupPath(binPath string) string { return binPath + ".prev" }

// backupBinary copies the current binary aside, preserving its mode. This is
// the precondition for the local self-rescue in task 7: central cannot roll
// back a node that never comes up, because such a node never asks central
// anything.
func backupBinary(binPath string) error {
	src, err := os.Open(binPath)
	if err != nil {
		return err
	}
	defer src.Close()
	fi, err := src.Stat()
	if err != nil {
		return err
	}
	tmp := backupPath(binPath) + ".tmp"
	dst, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, fi.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		os.Remove(tmp)
		return err
	}
	// OpenFile's perm argument is ANDed with the process umask at creation
	// time, so under a restrictive umask (e.g. 0077) the temp file can end up
	// with narrower permissions than the source binary (0755 -> 0700). Chmod
	// is not subject to umask, so set the mode explicitly here to guarantee
	// the backup - and therefore the binary restoreBinary later renames back
	// into place - keeps the source's exact permission bits. Without this,
	// a rollback can silently produce a non-executable live binary, which is
	// strictly worse than the broken update it was meant to undo.
	if err := dst.Chmod(fi.Mode().Perm()); err != nil {
		dst.Close()
		os.Remove(tmp)
		return err
	}
	if err := dst.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	// Rename last so a crash mid-copy never leaves a truncated "backup" that
	// would be restored over a working binary.
	if err := os.Rename(tmp, backupPath(binPath)); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// restoreBinary puts the backed-up binary back. Rename is atomic, so a crash
// here leaves either the new or the old binary in place — never a partial one.
func restoreBinary(binPath string) error {
	prev := backupPath(binPath)
	if _, err := os.Stat(prev); err != nil {
		return fmt.Errorf("no backup to restore at %s: %w", prev, err)
	}
	return os.Rename(prev, binPath)
}
