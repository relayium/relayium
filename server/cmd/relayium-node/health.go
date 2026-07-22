package main

import (
	"os"
	"path/filepath"
	"strings"
	"time"
)

// healthFile is rewritten after every successful heartbeat. It carries TWO
// facts and the updater needs both:
//
//   - its mtime says WHEN the last heartbeat succeeded, so a heartbeat left
//     behind by the previous version is not mistaken for the new one working;
//   - its contents say WHICH version produced that heartbeat, so a heartbeat
//     from a still-running old process (e.g. the unit's ExecStart points at a
//     path the updater did not replace, which -bin/RELAYIUM_NODE_BIN makes
//     possible) is not mistaken for the new one either.
//
// "The process is running" is not enough — a binary can start fine and still
// fail to reach central, which is exactly the failure a rollout must catch.
const healthFile = "last-heartbeat"

func healthFilePath(stateDir string) string {
	return filepath.Join(stateDir, healthFile)
}

// markHealthy records that a heartbeat just succeeded, stamping the running
// version into the file. The write goes to a temp file in the same directory
// and is renamed into place, so a concurrent reader (the updater's watchdog
// polls this file every couple of seconds) always sees either the whole
// previous marker or the whole new one, never a torn value.
func markHealthy(stateDir, version string) error {
	f, err := os.CreateTemp(stateDir, healthFile+".tmp*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	if _, err := f.WriteString(version); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	// CreateTemp makes the file 0600 already, but say so explicitly: the mode
	// must not depend on that detail, and Chmod ignores the umask.
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	p := healthFilePath(stateDir)
	if err := os.Rename(tmp, p); err != nil {
		os.Remove(tmp)
		return err
	}
	// The freshness comparison in waitHealthy is an mtime comparison, so set it
	// explicitly rather than relying on whatever the rename left behind.
	now := time.Now()
	return os.Chtimes(p, now, now)
}

// lastHealthy returns the time of the last successful heartbeat and the version
// that produced it. A missing file means "never" and is not an error — a node
// that has not heartbeated yet is a normal state, not a failure.
//
// The returned version is "" when it is unknown: either the file is missing, or
// it was written by a node older than this format and has no version in it. An
// unknown version must never be treated as a match by the caller. That costs an
// occasional spurious rollback when updating from a pre-format node, which is
// recoverable; the other direction — reporting a false success and letting
// central record `ok` for a node that is not running the new binary — is not.
func lastHealthy(stateDir string) (time.Time, string, error) {
	p := healthFilePath(stateDir)
	fi, err := os.Stat(p)
	if os.IsNotExist(err) {
		return time.Time{}, "", nil
	}
	if err != nil {
		return time.Time{}, "", err
	}
	b, err := os.ReadFile(p)
	if err != nil {
		// The timestamp is still good; the version is simply unknown.
		return fi.ModTime(), "", nil
	}
	return fi.ModTime(), strings.TrimSpace(string(b)), nil
}
