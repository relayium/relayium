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

type updateConfig struct {
	StateDir       string
	BinPath        string
	TargetTag      string
	AllowDowngrade bool
	Repo           string
}

// parseUpdateFlags parses `relayium-node update` arguments. The target version
// is always explicit: this command never resolves "latest" on its own, because
// a rollout that raced a new release would leave the fleet on two versions.
func parseUpdateFlags(args []string, stderr io.Writer) (updateConfig, error) {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	fs.SetOutput(stderr)
	uc := updateConfig{Repo: updateRepo}
	fs.StringVar(&uc.StateDir, "state-dir", env("RELAYIUM_NODE_STATE_DIR", "/var/lib/relayium-node"), "directory holding state.json")
	fs.StringVar(&uc.BinPath, "bin", env("RELAYIUM_NODE_BIN", defaultBinPath), "path of the binary to replace")
	fs.StringVar(&uc.TargetTag, "to", "", "exact release tag to install, e.g. v0.9.0 (required)")
	fs.BoolVar(&uc.AllowDowngrade, "allow-downgrade", false, "permit installing a version older than the running one")
	if err := fs.Parse(args); err != nil {
		return uc, err
	}
	if uc.TargetTag == "" {
		return uc, errors.New("relayium-node update: -to <version> is required")
	}
	return uc, nil
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
// read as the new one working.
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
	if failedBefore(uc.StateDir, uc.TargetTag) {
		fmt.Fprintf(stderr, "refusing to retry %s: it already failed on this node\n", uc.TargetTag)
		return 1
	}
	if err := backupBinary(uc.BinPath); err != nil {
		fmt.Fprintf(stderr, "backup failed, not touching the binary: %v\n", err)
		return 1
	}

	from, to, changed, err := selfupdate.Update(context.Background(), selfupdate.Options{
		Repo:           uc.Repo,
		CurrentVersion: version,
		GOOS:           runtime.GOOS,
		GOARCH:         runtime.GOARCH,
		TargetPath:     uc.BinPath,
		TargetTag:      uc.TargetTag,
		AllowDowngrade: uc.AllowDowngrade,
	}, stdout)
	if err != nil {
		// Verification or download failed — the live binary was never touched.
		fmt.Fprintf(stderr, "update to %s failed, binary untouched: %v\n", uc.TargetTag, err)
		return 1
	}
	if !changed {
		fmt.Fprintf(stdout, "already on %s, nothing to do\n", to)
		return 0
	}

	restartedAt := time.Now()
	if err := svc.Restart(); err != nil {
		fmt.Fprintf(stderr, "restart failed: %v — rolling back\n", err)
		rollback(uc, svc, stderr)
		return 1
	}

	if !waitHealthy(uc.StateDir, restartedAt, window, poll) {
		fmt.Fprintf(stderr, "%s did not heartbeat within %s — rolling back to %s\n", to, window, from)
		rollback(uc, svc, stderr)
		recordFailed(uc.StateDir, uc.TargetTag, stderr)
		return 1
	}

	fmt.Fprintf(stdout, "updated %s -> %s and confirmed healthy\n", from, to)
	os.Remove(backupPath(uc.BinPath))
	return 0
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
