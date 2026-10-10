package coturnbridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/relayium/relayium/account"
)

// tempsIn counts temp files (".tmp-*") in dir.
func tempsIn(t *testing.T, dir string) int {
	t.Helper()
	n := 0
	ents, err := os.ReadDir(dir)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), tmpPrefix) {
			n++
		}
	}
	return n
}

func tempsUnder(t *testing.T, dir string) int {
	n := 0
	for _, d := range []string{"", "overflow", "dead", "corrupt", "gone"} {
		n += tempsIn(t, filepath.Join(dir, d))
	}
	return n
}

func failTempRemoval(ff *faultFS) {
	ff.fail("remove", func(p string) bool { return strings.HasPrefix(filepath.Base(p), tmpPrefix) })
}

// Root R5 reviewer case (copied assertion): a write failing at fsync whose
// temp cannot be removed, retried 100 times, must not leave 100 temp files.
// The first failure leaves one temp; it blocks every new temp (each attempt
// retries removing it) until it can be removed; then writes recover.
func TestFailedTempCleanupBounded(t *testing.T) {
	dir := t.TempDir()
	ff := newFaultFS()
	sp := &Spool{Dir: dir, MaxEntries: 1, MaxBytes: 65536, CorruptMaxEntries: 1, CorruptMaxBytes: 65536, fs: ff}
	openSpool(t, sp)
	a := newAllocs(t, 1)[0]
	ff.fail("sync", nil)
	failTempRemoval(ff)
	errs := make([]error, 100)
	for i := range errs {
		errs[i] = sp.Put(a)
	}
	// The physical bound first (the property root asked for), then the
	// fail-closed error kinds.
	if n := tempsIn(t, dir); n > 2 {
		t.Fatalf("temporary evidence unbounded after failed cleanup: recordsmax1 corruptmax1 attempts100 temps%d", n)
	}
	for i, err := range errs {
		if err == nil {
			t.Fatal("injected write failed but reported durable")
		}
		if i > 0 && !errors.Is(err, ErrTempHeld) {
			t.Fatalf("attempt %d: %v (want fail-closed ErrTempHeld)", i, err)
		}
	}
	if held, stuck := sp.Temps(); held != 0 || stuck != 1 {
		t.Fatalf("held %d stuck %d", held, stuck)
	}
	ff.clear()
	if err := sp.Put(a); err != nil {
		t.Fatalf("recovery: %v", err)
	}
	if n := tempsIn(t, dir); n != 0 {
		t.Fatalf("%d temps after recovery", n)
	}
	if _, stuck := sp.Temps(); stuck != 0 {
		t.Fatal("stuck temp not cleared")
	}
}

// Status (metadata) temps share the gate: a failing status write whose temp
// cannot be removed is retried every flush without growing temps; the
// status names the failure; recovery is automatic.
func TestStatusTempCleanupBounded(t *testing.T) {
	ff := newFaultFS()
	h := newHarness(t, account.CoturnMeteringShadow)
	h.startWith(func(c *Config) { c.fs = ff })
	h.eventually("subscription", h.subscribed)
	ff.fail("sync", func(p string) bool { return strings.HasPrefix(filepath.Base(p), statusTmpPrefix) })
	failTempRemoval(ff)
	h.eventually("status write failing", func() bool {
		st := h.b.Status()
		return st.StatusWriteFailures > 5 && st.TempsStuck == 1
	})
	if n := tempsIn(t, h.dir); n > 1 {
		t.Fatalf("%d status temps after repeated failures", n)
	}
	if st := h.b.Status(); st.SpoolState != "pressure" || !strings.Contains(st.AdmissionReason, "could not be removed") {
		t.Fatalf("not signalled: %+v", st)
	}
	ff.clear()
	h.eventually("recovered", func() bool {
		st := readStatus(t, h.dir)
		return st.TempsStuck == 0 && tempsIn(t, h.dir) == 0
	})
}

// A dead letter linked into dead/ whose temp then cannot be removed: the
// dead letter exists once, the live record is kept (the move did not
// complete), exactly one temp remains and blocks new temps; after recovery
// the temp is removed and the dead letter is never deleted.
func TestDeadLetterLinkedTempRemoveFails(t *testing.T) {
	dir := t.TempDir()
	ff := newFaultFS()
	sp := &Spool{Dir: dir, MaxEntries: 5, MaxBytes: 65536, fs: ff}
	openSpool(t, sp)
	a := newAllocs(t, 2)
	for _, x := range a {
		if err := sp.Put(x); err != nil {
			t.Fatal(err)
		}
	}
	failTempRemoval(ff)
	if err := sp.DeadLetter(a[0], "conflict"); err == nil {
		t.Fatal("dead letter reported complete")
	}
	deadDir := filepath.Join(dir, "dead")
	if n := len(listDir(t, deadDir)) - tempsIn(t, deadDir); n != 1 {
		t.Fatalf("%d dead letters", n)
	}
	if tempsIn(t, deadDir) != 1 {
		t.Fatal("expected the one stuck temp")
	}
	if _, err := os.Stat(filepath.Join(dir, sp.name(a[0].Key))); err != nil {
		t.Fatal("live record removed although the dead-letter move did not complete")
	}
	for range 20 {
		if err := sp.Put(a[1]); !errors.Is(err, ErrTempHeld) {
			t.Fatalf("new temp not refused: %v", err)
		}
	}
	if n := tempsUnder(t, dir); n != 1 {
		t.Fatalf("%d temps", n)
	}
	ff.clear()
	if err := sp.Put(a[1]); err != nil {
		t.Fatal(err)
	}
	if tempsUnder(t, dir) != 0 || len(listDir(t, deadDir)) != 1 {
		t.Fatalf("after recovery: temps %d dead %v", tempsUnder(t, dir), listDir(t, deadDir))
	}
}

// Linked, but the directory sync fails: the temp (a second name of the
// linked file) is removed — no duplicate temp — and the live record stays.
func TestDeadLetterLinkedSyncFailsNoDuplicateTemp(t *testing.T) {
	dir := t.TempDir()
	ff := newFaultFS()
	sp := &Spool{Dir: dir, MaxEntries: 5, MaxBytes: 65536, fs: ff}
	openSpool(t, sp)
	a := newAllocs(t, 1)[0]
	if err := sp.Put(a); err != nil {
		t.Fatal(err)
	}
	// The link into dead/ succeeds; the following sync of dead/ fails, so
	// archiveMove returns before removing its source temp.
	ff.fail("syncdir", func(p string) bool { return filepath.Base(p) == "dead" })
	if err := sp.DeadLetter(a, "conflict"); err == nil {
		t.Fatal("dead letter reported complete")
	}
	deadDir := filepath.Join(dir, "dead")
	if tempsIn(t, deadDir) != 0 {
		t.Fatalf("duplicate temp left: %v", listDir(t, deadDir))
	}
	if len(listDir(t, deadDir)) != 1 {
		t.Fatalf("dead/ %v", listDir(t, deadDir))
	}
	if _, err := os.Stat(filepath.Join(dir, sp.name(a.Key))); err != nil {
		t.Fatal("live record removed")
	}
	if _, stuck := sp.Temps(); stuck != 0 {
		t.Fatal("removed temp tracked as stuck")
	}
}

// Earlier-run temps held in place because corrupt/ is full are kept byte for
// byte, counted, reported (drain not exact, downgrade blocked); at the hold
// limit the start is refused (its first status needs a temp) and nothing is
// deleted or overwritten.
func TestStartupHeldTempsArchiveFull(t *testing.T) {
	for _, n := range []int{3, tempHoldMax} {
		t.Run(fmt.Sprintf("held%d", n), func(t *testing.T) {
			dir := t.TempDir()
			for _, d := range []string{"overflow", "dead", "corrupt", "gone"} {
				os.MkdirAll(filepath.Join(dir, d), 0o700)
			}
			os.WriteFile(filepath.Join(dir, "corrupt", "existing"), []byte("x"), 0o600)
			for i := range n {
				os.WriteFile(filepath.Join(dir, fmt.Sprintf(".tmp-held%d", i)), []byte(fmt.Sprintf("evidence-%d", i)), 0o600)
			}
			before := tree(t, dir)
			cfg := bareConfig(dir)
			cfg.SpoolCorruptMaxEntries = 1
			b, err := New(cfg)
			if n >= tempHoldMax {
				if b != nil {
					b.Close()
				}
				if err == nil || !strings.Contains(err.Error(), "temporary files of earlier runs are held") {
					t.Fatalf("start at the hold limit: %v", err)
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				st := b.Status()
				if st.TempsHeld != n || len(st.DowngradeBlockers) == 0 {
					t.Fatalf("held not reported: %+v", st)
				}
				if why, final := drainSpoolReady(st, st); !final || !strings.Contains(why, "temporary files of earlier runs") {
					t.Fatalf("drain: %q %v", why, final)
				}
				b.Close()
			}
			after := tree(t, dir)
			for name, sum := range before {
				if after[name] != sum {
					t.Fatalf("%s changed or removed", name)
				}
			}
		})
	}
}

// Across restarts with temp removal always failing and corrupt/ full, temps
// stop growing at the hold limit: each run can leave at most one, and a run
// that starts at the limit creates none.
func TestTempsBoundedAcrossRestarts(t *testing.T) {
	dir := t.TempDir()
	ff := newFaultFS()
	ff.fail("sync", nil)
	failTempRemoval(ff)
	os.MkdirAll(filepath.Join(dir, "corrupt"), 0o700)
	os.WriteFile(filepath.Join(dir, "corrupt", "existing"), []byte("x"), 0o600)
	a := newAllocs(t, 1)[0]
	for range 3 * tempHoldMax {
		sp := &Spool{Dir: dir, MaxEntries: 5, MaxBytes: 65536, CorruptMaxEntries: 1, fs: ff}
		if err := sp.Open(); err != nil {
			t.Fatal(err)
		}
		for range 5 {
			sp.Put(a)
		}
		sp.Close()
		if n := tempsUnder(t, dir); n > tempHoldMax {
			t.Fatalf("%d temps across restarts (limit %d)", n, tempHoldMax)
		}
	}
	if n := tempsUnder(t, dir); n != tempHoldMax {
		t.Fatalf("expected exactly the hold limit %d, got %d", tempHoldMax, n)
	}
}

// A dead-letter reason of control bytes or invalid UTF-8 expands in JSON up
// to 6 bytes per byte; the written file stays within deadLetterMaxBytes,
// which WrittenMaxBytes uses (the R4 formula, record+1024+64, was too low).
func TestDeadLetterReasonEscapingBound(t *testing.T) {
	for name, r := range map[string]string{"control": strings.Repeat("\x01", 5000), "invalidUTF8": strings.Repeat("\xff", 5000)} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			sp := &Spool{Dir: dir, MaxEntries: 5, MaxBytes: 65536}
			openSpool(t, sp)
			a := newAllocs(t, 1)[0]
			if err := sp.Put(a); err != nil {
				t.Fatal(err)
			}
			if err := sp.DeadLetter(a, r); err != nil {
				t.Fatal(err)
			}
			names := listDir(t, filepath.Join(dir, "dead"))
			fi, _ := os.Stat(filepath.Join(dir, "dead", names[0]))
			rec, _ := json.Marshal(a)
			if fi.Size() <= int64(len(rec))+deadReasonMax+64 {
				t.Fatalf("expected escaping growth, got %d", fi.Size())
			}
			if bound := deadLetterMaxBytes(int64(len(rec))); fi.Size() > bound { // the bound WrittenMaxBytes uses
				t.Fatalf("dead letter %d bytes exceeds bound %d", fi.Size(), bound)
			}
		})
	}
	cfg := bareConfig(t.TempDir())
	l, _ := EffectiveLimits(cfg)
	if l.TempsHoldMax != tempHoldMax || l.WrittenMaxBytes != writtenMaxBytes(func() Config { c := cfg; c.defaults(); return c }()) {
		t.Fatalf("limits %+v", l)
	}
}
