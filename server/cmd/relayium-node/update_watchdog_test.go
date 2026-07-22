package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWaitHealthyReturnsTrueWhenHeartbeatArrives(t *testing.T) {
	dir := t.TempDir()
	since := time.Now()

	go func() {
		time.Sleep(30 * time.Millisecond)
		_ = markHealthy(dir, "0.9.0")
	}()

	// "0.9.0" vs "v0.9.0": the stamped binary version has no leading v, the
	// target tag does. SameVersion reconciles them.
	if !waitHealthy(dir, since, "v0.9.0", 2*time.Second, 5*time.Millisecond) {
		t.Error("waitHealthy = false, want true once a heartbeat lands after `since`")
	}
}

// A heartbeat that is genuinely fresh but came from the OLD version must not
// count: that is what happens when the unit still executes a binary the updater
// did not replace (a -bin/RELAYIUM_NODE_BIN mismatch). Without the version
// check this is indistinguishable from success.
func TestWaitHealthyRejectsFreshHeartbeatFromOldVersion(t *testing.T) {
	dir := t.TempDir()
	since := time.Now()

	go func() {
		time.Sleep(10 * time.Millisecond)
		for i := 0; i < 50; i++ {
			_ = markHealthy(dir, "0.8.0") // the old process, still alive and healthy
			time.Sleep(5 * time.Millisecond)
		}
	}()

	if waitHealthy(dir, since, "v0.9.0", 150*time.Millisecond, 5*time.Millisecond) {
		t.Error("waitHealthy = true for a heartbeat stamped 0.8.0 while updating to v0.9.0, want false")
	}
}

// A marker written by a node older than the versioned format has no version in
// it. Unknown must not count as a match: a spurious rollback is recoverable, a
// false success recorded as `ok` by central is not.
func TestWaitHealthyRejectsLegacyMarkerWithoutVersion(t *testing.T) {
	dir := t.TempDir()
	since := time.Now()

	go func() {
		time.Sleep(10 * time.Millisecond)
		for i := 0; i < 50; i++ {
			// Exactly what the pre-version markHealthy left behind: an empty
			// file whose mtime is the heartbeat time.
			_ = os.WriteFile(healthFilePath(dir), nil, 0o600)
			now := time.Now()
			_ = os.Chtimes(healthFilePath(dir), now, now)
			time.Sleep(5 * time.Millisecond)
		}
	}()

	if waitHealthy(dir, since, "v0.9.0", 150*time.Millisecond, 5*time.Millisecond) {
		t.Error("waitHealthy = true for a legacy marker with no recorded version, want false")
	}
}

func TestWaitHealthyTimesOutWhenNodeNeverComesBack(t *testing.T) {
	dir := t.TempDir()
	since := time.Now()

	start := time.Now()
	if waitHealthy(dir, since, "v0.9.0", 100*time.Millisecond, 5*time.Millisecond) {
		t.Error("waitHealthy = true, want false when no heartbeat ever lands")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Errorf("waitHealthy blocked %v, want it to give up near the 100ms timeout", elapsed)
	}
}

// A heartbeat written by the OLD version before the restart must not be
// mistaken for the new version working. This is the bug that would make the
// self-rescue useless.
func TestWaitHealthyIgnoresHeartbeatFromBeforeRestart(t *testing.T) {
	dir := t.TempDir()
	// Stamped with the TARGET version so the only thing that can reject it is
	// its timestamp.
	if err := markHealthy(dir, "0.9.0"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(10 * time.Millisecond)
	since := time.Now() // the restart happens here

	if waitHealthy(dir, since, "v0.9.0", 100*time.Millisecond, 5*time.Millisecond) {
		t.Error("waitHealthy = true using a pre-restart heartbeat, want false")
	}
}

type fakeSvc struct {
	restarts    int
	failRestart bool
	// heartbeatOnRestart, when non-empty, is a stateDir to stamp with a
	// heartbeat as part of Restart() itself — simulating the OLD binary's
	// in-flight heartbeat HTTP round trip completing while `systemctl restart`
	// is still running. Used to prove runUpdateWith takes its `restartedAt`
	// timestamp AFTER Restart() returns, not before.
	heartbeatOnRestart string
	// healthyAfterRestart, when non-empty, is a stateDir that gets GENUINE
	// post-restart heartbeats: Restart() starts a goroutine that keeps stamping
	// the health file, the way a working new version would. Stamping repeatedly
	// rather than once keeps it robust on filesystems that truncate mtimes to
	// whole seconds (see waitHealthy's note). Build one with newHealthySvc so
	// the goroutine is stopped at test end.
	healthyAfterRestart string
	stopHeartbeat       chan struct{}
	// heartbeatVersion is the version stamped into every heartbeat this fake
	// writes — i.e. which binary the "running" process is, independent of which
	// binary the updater installed on disk.
	heartbeatVersion string
}

// newHealthySvc returns a fakeSvc whose restarts bring the node back healthy on
// version `ver`.
func newHealthySvc(t *testing.T, stateDir, ver string) *fakeSvc {
	t.Helper()
	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })
	return &fakeSvc{healthyAfterRestart: stateDir, stopHeartbeat: stop, heartbeatVersion: ver}
}

func (f *fakeSvc) Restart() error {
	f.restarts++
	if f.heartbeatOnRestart != "" {
		_ = markHealthy(f.heartbeatOnRestart, f.heartbeatVersion)
	}
	if f.healthyAfterRestart != "" {
		dir, stop, ver := f.healthyAfterRestart, f.stopHeartbeat, f.heartbeatVersion
		go func() {
			for {
				select {
				case <-stop:
					return
				default:
				}
				_ = markHealthy(dir, ver)
				time.Sleep(10 * time.Millisecond)
			}
		}()
	}
	if f.failRestart {
		return errTestRestart
	}
	return nil
}

var errTestRestart = errors.New("restart refused")

// The whole point of the local self-rescue: a version that installs fine but
// never heartbeats gets undone without central's involvement.
func TestRunUpdateRollsBackWhenNewVersionNeverHeartbeats(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "relayium-node")
	if err := os.WriteFile(bin, []byte("OLD"), 0o755); err != nil {
		t.Fatal(err)
	}
	// Pre-create the backup and a "new" binary to stand in for a completed
	// selfupdate, then drive only the watchdog half via rollback().
	if err := backupBinary(bin); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bin, []byte("NEW-BROKEN"), 0o755); err != nil {
		t.Fatal(err)
	}

	svc := &fakeSvc{}
	var errBuf bytes.Buffer
	rollback(updateConfig{BinPath: bin, StateDir: dir}, svc, &errBuf)

	got, err := os.ReadFile(bin)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "OLD" {
		t.Errorf("after rollback, binary = %q, want the previous %q", got, "OLD")
	}
	if svc.restarts != 1 {
		t.Errorf("restarts = %d, want 1 (the node must be restarted onto the old binary)", svc.restarts)
	}
}
