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
		_ = markHealthy(dir)
	}()

	if !waitHealthy(dir, since, 2*time.Second, 5*time.Millisecond) {
		t.Error("waitHealthy = false, want true once a heartbeat lands after `since`")
	}
}

func TestWaitHealthyTimesOutWhenNodeNeverComesBack(t *testing.T) {
	dir := t.TempDir()
	since := time.Now()

	start := time.Now()
	if waitHealthy(dir, since, 100*time.Millisecond, 5*time.Millisecond) {
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
	if err := markHealthy(dir); err != nil {
		t.Fatal(err)
	}
	time.Sleep(10 * time.Millisecond)
	since := time.Now() // the restart happens here

	if waitHealthy(dir, since, 100*time.Millisecond, 5*time.Millisecond) {
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
}

// newHealthySvc returns a fakeSvc whose restarts bring the node back healthy.
func newHealthySvc(t *testing.T, stateDir string) *fakeSvc {
	t.Helper()
	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })
	return &fakeSvc{healthyAfterRestart: stateDir, stopHeartbeat: stop}
}

func (f *fakeSvc) Restart() error {
	f.restarts++
	if f.heartbeatOnRestart != "" {
		_ = markHealthy(f.heartbeatOnRestart)
	}
	if f.healthyAfterRestart != "" {
		dir, stop := f.healthyAfterRestart, f.stopHeartbeat
		go func() {
			for {
				select {
				case <-stop:
					return
				default:
				}
				_ = markHealthy(dir)
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
