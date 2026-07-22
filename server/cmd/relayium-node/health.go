package main

import (
	"os"
	"path/filepath"
	"time"
)

// healthFile is touched after every successful heartbeat. The updater reads its
// mtime to decide whether a freshly-installed version is actually working:
// "the process is running" is not enough — a binary can start fine and still
// fail to reach central, which is exactly the failure a rollout must catch.
const healthFile = "last-heartbeat"

func healthFilePath(stateDir string) string {
	return filepath.Join(stateDir, healthFile)
}

// markHealthy records that a heartbeat just succeeded.
func markHealthy(stateDir string) error {
	p := healthFilePath(stateDir)
	f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if cerr := f.Close(); cerr != nil {
		return cerr
	}
	now := time.Now()
	return os.Chtimes(p, now, now)
}

// lastHealthy returns the time of the last successful heartbeat. A missing file
// means "never" and is not an error — a node that has not heartbeated yet is a
// normal state, not a failure.
func lastHealthy(stateDir string) (time.Time, error) {
	fi, err := os.Stat(healthFilePath(stateDir))
	if os.IsNotExist(err) {
		return time.Time{}, nil
	}
	if err != nil {
		return time.Time{}, err
	}
	return fi.ModTime(), nil
}
