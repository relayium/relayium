package coturnbridge

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// writeStatusFile writes a previous-run status directly.
func writeStatusFile(t *testing.T, dir string, st Status) {
	t.Helper()
	b, _ := json.Marshal(st)
	if err := os.WriteFile(filepath.Join(dir, "status.json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
}

// R4 (root + strongest review): the previous status must be read under the
// writer lock. Writer A runs and has written an intermediate status (3
// refused events, 2 allocations at risk). Starter B is paused just before it
// asks for the lock — the private acceptance seam testBeforeSpoolOpen, an
// in-process ordering, not a whole-process claim — and meanwhile A refuses
// more, persists its at-risk state and stops cleanly. B must carry A's final
// counters (42 refused, possibly lost still 19) and must not count A's clean
// stop as a loss. Reading before the lock (R3) carried 3 and 19+2.
func TestStatusReadUnderWriterLock(t *testing.T) {
	dir := t.TempDir()
	writeStatusFile(t, dir, Status{UpdatedUnix: 1, PossiblyLostAtRisk: 19, CleanShutdown: true})
	a, err := New(bareConfig(dir))
	if err != nil {
		t.Fatal(err)
	}
	k1, k2 := AllocKey{Epoch: tE1, SessionID: sid(1)}, AllocKey{Epoch: tE1, SessionID: sid(2)}
	a.mu.Lock()
	a.st.RefusedEvents = 3
	a.atRisk[k1], a.atRisk[k2] = false, false
	a.writeStatusLocked()
	a.mu.Unlock()
	if st := readStatus(t, dir); st.RefusedEvents != 3 || st.AtRisk != 2 || st.CleanShutdown {
		t.Fatalf("intermediate status: %+v", st)
	}

	ran := false
	testBeforeSpoolOpen = func() {
		if ran {
			return
		}
		ran = true
		// A finishes while B waits for the lock.
		a.mu.Lock()
		a.st.RefusedEvents = 42
		delete(a.atRisk, k1)
		delete(a.atRisk, k2)
		a.mu.Unlock()
		if err := a.Close(); err != nil {
			t.Error(err)
		}
	}
	t.Cleanup(func() { testBeforeSpoolOpen = nil })
	b, err := New(bareConfig(dir))
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	if !ran {
		t.Fatal("seam did not run")
	}
	st := b.Status()
	if st.RefusedEvents != 42 || st.PossiblyLostAtRisk != 19 {
		t.Fatalf("status read before lock lost previous writer final counters: refused%d want42 lost%d want19", st.RefusedEvents, st.PossiblyLostAtRisk)
	}
	if on := readStatus(t, dir); on.RefusedEvents != 42 || on.PossiblyLostAtRisk != 19 || on.CleanShutdown {
		t.Fatalf("B's first status: %+v", on)
	}
}

// While A holds the lock, B cannot start, and so cannot consume or replace
// A's intermediate status; once A has stopped cleanly a new start carries
// A's latest counters with no possibly-lost increment.
func TestLockedWriterCannotConsumeStatus(t *testing.T) {
	dir := t.TempDir()
	a, err := New(bareConfig(dir))
	if err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	a.st.RefusedEvents = 7
	a.atRisk[AllocKey{Epoch: tE1, SessionID: sid(1)}] = false
	a.writeStatusLocked()
	a.mu.Unlock()
	before, _ := os.ReadFile(filepath.Join(dir, "status.json"))
	if _, err := New(bareConfig(dir)); !errors.Is(err, ErrSpoolLocked) {
		t.Fatalf("second writer: %v", err)
	}
	if now, _ := os.ReadFile(filepath.Join(dir, "status.json")); string(now) != string(before) {
		t.Fatal("a refused second writer changed the status")
	}
	a.mu.Lock()
	a.st.RefusedEvents = 9
	a.atRisk = map[AllocKey]bool{}
	a.mu.Unlock()
	a.Close()
	b, err := New(bareConfig(dir))
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	if st := b.Status(); st.RefusedEvents != 9 || st.PossiblyLostAtRisk != 0 {
		t.Fatalf("after A's clean stop: refused %d lost %d", st.RefusedEvents, st.PossiblyLostAtRisk)
	}
}

// A status.json that is not a regular file is refused without being opened
// (a FIFO could block, a symlink could lead outside the private spool) and
// is left as it is.
func TestStatusNonRegularRefused(t *testing.T) {
	for _, kind := range []string{"symlink", "fifo"} {
		t.Run(kind, func(t *testing.T) {
			dir := t.TempDir()
			p := filepath.Join(dir, "status.json")
			switch kind {
			case "symlink":
				outside := filepath.Join(t.TempDir(), "elsewhere.json")
				b, _ := json.Marshal(Status{UpdatedUnix: 1, RefusedEvents: 5})
				os.WriteFile(outside, b, 0o600)
				if err := os.Symlink(outside, p); err != nil {
					t.Fatal(err)
				}
			case "fifo":
				if err := syscall.Mkfifo(p, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			before, _ := os.Lstat(p)
			_, err := New(bareConfig(dir))
			if err == nil || !strings.Contains(err.Error(), "not a regular file") {
				t.Fatalf("non-regular status accepted: %v", err)
			}
			after, err2 := os.Lstat(p)
			if err2 != nil || after.Mode() != before.Mode() {
				t.Fatal("non-regular status changed")
			}
		})
	}
}

// drainState names a record or status that is not a regular file instead of
// opening it.
func TestDrainStateNonRegularNamed(t *testing.T) {
	for _, kind := range []string{"record-fifo", "record-symlink", "status-fifo"} {
		t.Run(kind, func(t *testing.T) {
			dir := t.TempDir()
			os.MkdirAll(filepath.Join(dir, "gone"), 0o700)
			if kind != "status-fifo" {
				writeStatusFile(t, dir, Status{UpdatedUnix: 1})
			}
			rec := filepath.Join(dir, strings.Repeat("c", 32)+spoolExt)
			var err error
			switch kind {
			case "record-fifo":
				err = syscall.Mkfifo(rec, 0o600)
			case "record-symlink":
				err = os.Symlink("/dev/zero", rec)
			case "status-fifo":
				err = syscall.Mkfifo(filepath.Join(dir, "status.json"), 0o600)
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, _, _, err := drainState(dir); err == nil || !strings.Contains(err.Error(), "not a regular file") {
				t.Fatalf("not named: %v", err)
			}
		})
	}
}
