//go:build !windows

package sshx

import (
	"errors"
	"os/exec"
	"sync"
	"syscall"
	"testing"
	"time"
)

// These drive Session over children the test controls, standing in for an ssh
// whose peer keeps writing, never answers, or ignores polite signals. What is
// asserted is the property `pull ... -` depends on: Abort returns in bounded
// time AND the exact child it owns has been reaped, whatever the child does.

func shortAbortGraces(t *testing.T) {
	t.Helper()
	a, tg, k := abortGrace, termGrace, killGrace
	abortGrace, termGrace, killGrace = 200*time.Millisecond, 300*time.Millisecond, 5*time.Second
	t.Cleanup(func() { abortGrace, termGrace, killGrace = a, tg, k })
}

func startChild(t *testing.T, script string) *Session {
	t.Helper()
	s, err := start(exec.Command("/bin/sh", "-c", script))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		// Never leak a child from a failed test.
		_ = s.cmd.Process.Kill()
		s.waitFor(5 * time.Second)
	})
	return s
}

// abortWithin runs Abort and fails if it does not return within d.
func abortWithin(t *testing.T, s *Session, d time.Duration) error {
	t.Helper()
	res := make(chan error, 1)
	began := time.Now()
	go func() { res <- s.Abort() }()
	select {
	case err := <-res:
		t.Logf("Abort returned after %v: %v", time.Since(began).Round(time.Millisecond), err)
		return err
	case <-time.After(d):
		t.Fatalf("Abort did not return within %v", d)
		return nil
	}
}

// assertReaped proves the child is gone: Wait has returned, and the PID no
// longer names a process (ESRCH). A zombie would still answer signal 0.
func assertReaped(t *testing.T, s *Session) {
	t.Helper()
	select {
	case <-s.done:
	default:
		t.Fatal("Abort returned but the child has not been reaped")
	}
	if s.cmd.ProcessState == nil {
		t.Fatal("no ProcessState after Abort")
	}
	if err := syscall.Kill(s.cmd.Process.Pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("pid %d still exists after Abort (kill 0 = %v)", s.cmd.Process.Pid, err)
	}
}

// A peer that never answers and never writes: closing the pipes changes
// nothing for it, so only the SIGTERM step ends it.
func TestAbortReapsSilentChild(t *testing.T) {
	shortAbortGraces(t)
	s := startChild(t, "exec sleep 60")
	err := abortWithin(t, s, 3*time.Second)
	assertReaped(t, s)
	var ee *exec.ExitError
	if !errors.As(err, &ee) {
		t.Fatalf("Abort error = %v, want the child's signal exit", err)
	}
}

// A child that ignores SIGTERM and SIGPIPE (dispositions survive exec) and
// never exits on its own: only SIGKILL ends it.
func TestAbortReapsChildIgnoringTermAndPipe(t *testing.T) {
	shortAbortGraces(t)
	s := startChild(t, "trap '' TERM PIPE; exec sleep 60")
	err := abortWithin(t, s, 4*time.Second)
	assertReaped(t, s)
	if st := s.cmd.ProcessState.Sys().(syscall.WaitStatus); !st.Signaled() || st.Signal() != syscall.SIGKILL {
		t.Fatalf("child ended with %v (err %v), want SIGKILL", s.cmd.ProcessState, err)
	}
}

// A child that writes forever while ignoring SIGPIPE and SIGTERM: closing the
// read end makes its writes fail, but it keeps going. The stand-in for an old
// `__send` streaming a body nobody reads, behind an ssh that does not exit.
func TestAbortReapsWriterIgnoringPipe(t *testing.T) {
	shortAbortGraces(t)
	s := startChild(t, "trap '' TERM PIPE; while :; do echo xxxxxxxxxxxxxxxx 2>/dev/null; done")
	buf := make([]byte, 64)
	if _, err := s.Read(buf); err != nil {
		t.Fatalf("child produced nothing: %v", err)
	}
	abortWithin(t, s, 4*time.Second)
	assertReaped(t, s)
}

// A writer with default SIGPIPE dies as soon as the read end is closed, well
// inside the first grace: Abort must not escalate what is already over.
func TestAbortWriterDiesOfSigpipeWithoutEscalation(t *testing.T) {
	shortAbortGraces(t)
	abortGrace = 3 * time.Second
	s := startChild(t, "exec yes")
	buf := make([]byte, 64)
	if _, err := s.Read(buf); err != nil {
		t.Fatalf("child produced nothing: %v", err)
	}
	abortWithin(t, s, 5*time.Second)
	assertReaped(t, s)
	if st := s.cmd.ProcessState.Sys().(syscall.WaitStatus); !st.Signaled() || st.Signal() != syscall.SIGPIPE {
		t.Fatalf("child ended with %v, want SIGPIPE (no escalation needed)", s.cmd.ProcessState)
	}
}

// Negative control for the whole mechanism: Close on a silent child blocks —
// it trusts the peer — and Abort then unblocks that stuck Close. Both return
// the same cached exit error.
func TestCloseBlocksOnSilentChildAndAbortRescuesIt(t *testing.T) {
	shortAbortGraces(t)
	s := startChild(t, "exec sleep 60")
	closed := make(chan error, 1)
	go func() { closed <- s.Close() }()
	select {
	case err := <-closed:
		t.Fatalf("Close returned %v on a silent child; the control must block", err)
	case <-time.After(500 * time.Millisecond):
	}
	aerr := abortWithin(t, s, 3*time.Second)
	select {
	case cerr := <-closed:
		if cerr != aerr {
			t.Fatalf("Close returned %v, Abort %v: want the same cached error", cerr, aerr)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Close stayed blocked after Abort reaped the child")
	}
	assertReaped(t, s)
	if werr := s.Wait(); werr != aerr {
		t.Fatalf("Wait = %v, want the cached %v", werr, aerr)
	}
}

// A child that exits once stdin closes is simply reaped; every later call
// returns the one cached result, and calling them concurrently is safe.
func TestAbortCloseWaitShareOneReap(t *testing.T) {
	shortAbortGraces(t)
	s := startChild(t, "cat >/dev/null; exit 3")
	var wg sync.WaitGroup
	errs := make([]error, 6)
	for i := range errs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			switch i % 3 {
			case 0:
				errs[i] = s.Abort()
			case 1:
				errs[i] = s.Close()
			default:
				errs[i] = s.Wait()
			}
		}(i)
	}
	wg.Wait()
	var ee *exec.ExitError
	if !errors.As(errs[0], &ee) || ee.ExitCode() != 3 {
		t.Fatalf("exit error = %v, want exit status 3", errs[0])
	}
	for i, e := range errs {
		if e != errs[0] {
			t.Fatalf("call %d returned %v, want the one cached %v", i, e, errs[0])
		}
	}
	assertReaped(t, s)
	if again := s.Abort(); again != errs[0] {
		t.Fatalf("second Abort = %v, want %v", again, errs[0])
	}
}
