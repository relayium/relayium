//go:build !windows

// Real signals and the process table: Unix only (Windows cannot send SIGINT
// to one process; TestPushStdinDaemonCancelInProcess covers cancel there).

package main

import (
	"strings"
	"syscall"
	"testing"
	"time"
)

// Cancel with a real SIGINT to the CLI while stdin is an open, silent pipe
// and the listener has accepted: exit 130 in bounded time, the pump helper
// reaped, the listener's staging removed, nothing installed, --once 1.
func TestE2EPushStdinDaemonSIGINT(t *testing.T) {
	bin := buildCLIExe(t)
	for _, sig := range []struct {
		s    syscall.Signal
		code int
	}{{syscall.SIGINT, 130}, {syscall.SIGTERM, 143}} {
		t.Run(sig.s.String(), func(t *testing.T) {
			l := startStreamListener(t, true, true)
			r, w := osPipe(t)
			p := startCLIProc(t, l.pushArgv(bin, "x"), r)
			r.Close()
			if _, err := w.Write(e2eRandom(t, 100<<10)); err != nil {
				t.Fatal(err)
			}
			waitUntil(t, e2eCleanupTimeout, "the staging directory", func() bool { return len(stagingIn(t, l.recv)) == 1 })
			pump := waitPumpOf(t, p.cmd.Process.Pid)
			if err := p.cmd.Process.Signal(sig.s); err != nil {
				t.Fatal(err)
			}
			code, took := p.wait(t, 15*time.Second)
			stderr := p.stderr.String()
			if code != sig.code || !strings.Contains(stderr, "interrupted") || !strings.Contains(stderr, "nothing was installed") {
				t.Fatalf("exit %d after %v\n%s", code, took, stderr)
			}
			if took > 12*time.Second {
				t.Fatalf("took %v", took)
			}
			assertReaped(t, "the stdin pump", pump)
			if c := l.onceCode(t); c != 1 {
				t.Fatalf("--once listener exit %d, want 1", c)
			}
			assertDirNames(t, l.recv)
			assertNoPumpFor(t, bin)
		})
	}
}

// waitPumpOf waits (bounded) for the CLI's `__pump-stdin` child.
func waitPumpOf(t *testing.T, cli int) int {
	t.Helper()
	var pid int
	waitUntil(t, e2eCleanupTimeout, "the stdin pump", func() bool {
		if kids := pumpChildren(t, cli); len(kids) == 1 {
			pid = kids[0]
			return true
		}
		return false
	})
	return pid
}
