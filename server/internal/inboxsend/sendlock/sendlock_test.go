package sendlock

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The contention tests run a SECOND PROCESS — this test binary re-executed as
// a lock holder — because the property that matters is exclusion between two
// relayium commands, not between two handles of one process. They use only
// the standard library, so they run as-is on Windows.

const (
	helperEnv = "RELAYIUM_SENDLOCK_HELPER"
	pathEnv   = "RELAYIUM_SENDLOCK_PATH"
)

func TestMain(m *testing.M) {
	if os.Getenv(helperEnv) == "hold" {
		os.Exit(holdUntilStdinCloses(os.Getenv(pathEnv)))
	}
	os.Exit(m.Run())
}

// holdUntilStdinCloses is the helper process: it reports "held" or "busy" on
// stdout, and a holder keeps the lock until its stdin reaches EOF.
func holdUntilStdinCloses(path string) int {
	l, err := Acquire(path)
	if errors.Is(err, ErrLocked) {
		fmt.Println("busy")
		return 0
	}
	if err != nil {
		fmt.Println("error:", err)
		return 1
	}
	fmt.Println("held")
	_, _ = io.Copy(io.Discard, os.Stdin)
	l.Release()
	return 0
}

type holder struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser
	first string
}

// startHelper runs the helper against path and returns once it has reported.
func startHelper(t *testing.T, path string) *holder {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	cmd.Env = append(os.Environ(), helperEnv+"=hold", pathEnv+"="+path)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	h := &holder{cmd: cmd, stdin: stdin}
	t.Cleanup(func() {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
	line := make(chan string, 1)
	go func() {
		s, _ := bufio.NewReader(stdout).ReadString('\n')
		line <- strings.TrimSpace(s)
		_, _ = io.Copy(io.Discard, stdout)
	}()
	select {
	case h.first = <-line:
	case <-time.After(20 * time.Second):
		t.Fatal("helper process did not report within 20s")
	}
	return h
}

// exit closes the holder's stdin and waits for it to exit normally.
func (h *holder) exit(t *testing.T) {
	t.Helper()
	_ = h.stdin.Close()
	done := make(chan error, 1)
	go func() { done <- h.cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("helper exited with %v", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("helper did not exit after its stdin closed")
	}
}

// acquireWithin retries Acquire for up to d: Windows releases a killed
// process's locks when its handles are torn down, which the documentation
// allows to happen shortly after the process is reported as exited.
func acquireWithin(t *testing.T, path string, d time.Duration) *Lock {
	t.Helper()
	deadline := time.Now().Add(d)
	for {
		l, err := Acquire(path)
		if err == nil {
			return l
		}
		if !errors.Is(err, ErrLocked) || time.Now().After(deadline) {
			t.Fatalf("lock not acquirable after the holder went away: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestAnotherProcessHoldingTheLockExcludesThisOne(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".send.lock")
	h := startHelper(t, path)
	if h.first != "held" {
		t.Fatalf("helper did not take a free lock: %q", h.first)
	}
	// This process cannot take it while the helper holds it…
	if l, err := Acquire(path); !errors.Is(err, ErrLocked) {
		l.Release()
		t.Fatalf("second process acquired a held lock: err=%v", err)
	}
	// …and neither can a third process.
	if other := startHelper(t, path); other.first != "busy" {
		t.Fatalf("third process was not refused: %q", other.first)
	}
	// Once the holder releases and exits, the lock is free again.
	h.exit(t)
	l := acquireWithin(t, path, 5*time.Second)
	// And now this process excludes a new helper.
	if other := startHelper(t, path); other.first != "busy" {
		t.Fatalf("helper acquired a lock this process holds: %q", other.first)
	}
	l.Release()
}

func TestAKilledHolderLeavesNoStaleLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".send.lock")
	h := startHelper(t, path)
	if h.first != "held" {
		t.Fatalf("helper did not take a free lock: %q", h.first)
	}
	if err := h.cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = h.cmd.Wait()
	// The lock file is still there, but nobody holds it: a crash must not
	// block a later retry.
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("lock file: %v", err)
	}
	acquireWithin(t, path, 5*time.Second).Release()
}

func TestTwoHandlesInOneProcessExcludeEachOther(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".send.lock")
	a, err := Acquire(path)
	if err != nil {
		t.Fatal(err)
	}
	if b, err := Acquire(path); !errors.Is(err, ErrLocked) {
		b.Release()
		t.Fatalf("second handle acquired a held lock: err=%v", err)
	}
	a.Release()
	a.Release() // idempotent
	b, err := Acquire(path)
	if err != nil {
		t.Fatalf("released lock not acquirable: %v", err)
	}
	b.Release()
}
