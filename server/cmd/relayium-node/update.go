package main

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/relayium/relayium/internal/selfupdate"
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
//	                                      (also "already on that version", a no-op)
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

	// APIBase and DownloadBase override the GitHub hosts selfupdate.Update talks
	// to. Always empty in production — parseUpdateFlags never sets them, so
	// selfupdate falls back to the real GitHub API/download hosts — and exist
	// only so tests can point runUpdateWith at an httptest server and drive the
	// full orchestration (backup, restart, health check, rollback) without a
	// network dependency.
	APIBase      string
	DownloadBase string
}

// parseUpdateFlags parses `relayium-node update` arguments. The target version
// is always explicit: this command never resolves "latest" on its own, because
// a rollout that raced a new release would leave the fleet on two versions.
//
// Config precedence for the paths: explicit flag > process environment >
// /etc/relayium-node/env (the unit's EnvironmentFile) > built-in default.
func parseUpdateFlags(args []string, stderr io.Writer) (updateConfig, error) {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	fs.SetOutput(stderr)
	uc := updateConfig{Repo: updateRepo}
	var envFile string
	fs.StringVar(&uc.StateDir, "state-dir", env("RELAYIUM_NODE_STATE_DIR", ""), "directory holding state.json (default from "+defaultEnvFile+", else /var/lib/relayium-node)")
	fs.StringVar(&uc.BinPath, "bin", env("RELAYIUM_NODE_BIN", ""), "path of the binary to replace (default from "+defaultEnvFile+", else "+defaultBinPath+")")
	fs.StringVar(&uc.TargetTag, "to", "", "exact release tag to install, e.g. v0.9.0 (required)")
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

	if uc.ClearFailed {
		return uc, nil // -clear-failed is standalone; -to is not required with it
	}
	if uc.TargetTag == "" {
		return uc, errors.New("relayium-node update: -to <version> is required")
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
// `since` within timeout. Comparing against `since` (the restart moment) is the
// whole point: a heartbeat left behind by the previous version must never be
// read as the new one working. Note on granularity: lastHealthy's timestamp is
// a file mtime, and on a filesystem that truncates mtimes downward (e.g. to
// whole seconds), the comparison here can only err toward treating a genuinely
// healthy heartbeat as too-early and rolling back a working node — it can never
// make a heartbeat that didn't happen appear to be after `since`, so a broken
// node is never mistaken for a healthy one by this effect.
func waitHealthy(stateDir string, since time.Time, timeout, poll time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		if ts, err := lastHealthy(stateDir); err == nil && ts.After(since) {
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
	return runUpdateWith(uc, systemctlCtl{Unit: nodeUnit}, healthWindow, 2*time.Second, stdout, stderr)
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

	from, to, changed, err := selfupdate.Update(context.Background(), selfupdate.Options{
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
	}, stdout)
	if err != nil {
		// Verification or download failed — the live binary was never touched.
		fmt.Fprintf(stderr, "update to %s failed, binary untouched: %v\n", uc.TargetTag, err)
		os.Remove(backupPath(uc.BinPath)) // nothing to roll back to; don't leave a stray .prev
		return exitUpdateFailed
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

	if !waitHealthy(uc.StateDir, restartedAt, window, poll) {
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
