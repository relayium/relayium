package inboxclient

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestJournalIsALocalSecret. A journal carries manifest file names and absolute
// destinations — plaintext-derived data that the whole design keeps away from
// central. It therefore lives at 0600 inside a 0700 directory, like the keys.
func TestJournalIsALocalSecret(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "tasks")
	s := NewJournalStore(dir)
	j := &Journal{TaskID: "abc123", Root: "/tmp/inbox", Plan: []PlanEntry{{Name: "secret.pdf", Dest: "/tmp/inbox/secret.pdf"}}}
	if err := s.Save(j, testNow()); err != nil {
		t.Fatalf("save: %v", err)
	}
	fi, err := os.Stat(filepath.Join(dir, "abc123.json"))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("journal mode = %v, want 0600", fi.Mode().Perm())
	}
	di, _ := os.Stat(dir)
	if di.Mode().Perm() != 0o700 {
		t.Fatalf("journal directory mode = %v, want 0700", di.Mode().Perm())
	}
}

// TestJournalRejectsAnUnsafeTaskID. A journal turns a REMOTE string into a local
// file name. That conversion must not depend on central's id format staying
// benign — this is the guard, and it is why it can never fire in practice.
func TestJournalRejectsAnUnsafeTaskID(t *testing.T) {
	s := NewJournalStore(filepath.Join(t.TempDir(), "tasks"))
	for _, id := range []string{"../escape", "a/b", "", "with space", "dots..", string(make([]byte, 65))} {
		if _, _, err := s.Load(id); !errors.Is(err, ErrBadTaskID) {
			t.Fatalf("Load(%q) error = %v, want ErrBadTaskID", id, err)
		}
		if err := s.Save(&Journal{TaskID: id}, testNow()); !errors.Is(err, ErrBadTaskID) {
			t.Fatalf("Save(%q) error = %v, want ErrBadTaskID", id, err)
		}
	}
	// And the ids central actually mints must work.
	for _, id := range []string{"task-1", "AbC_123-xyz"} {
		if err := s.Save(&Journal{TaskID: id}, testNow()); err != nil {
			t.Fatalf("Save(%q): %v", id, err)
		}
	}
}

// TestJournalRoundTripsAndSurvivesAnUnknownVersion.
func TestJournalRoundTrips(t *testing.T) {
	s := NewJournalStore(filepath.Join(t.TempDir(), "tasks"))
	want := &Journal{
		TaskID: "t1", Root: "/r", Staging: "/r/.relayium-incoming/t1",
		Plan:      []PlanEntry{{Index: 0, Name: "a.txt", Size: 3, Dest: "/r/a.txt"}},
		Committed: []string{"/r/a.txt"}, Completed: true,
	}
	if err := s.Save(want, testNow()); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, found, err := s.Load("t1")
	if err != nil || !found {
		t.Fatalf("load: found=%v err=%v", found, err)
	}
	if !got.Completed || len(got.Plan) != 1 || got.Plan[0].Dest != "/r/a.txt" || !got.IsCommitted("/r/a.txt") {
		t.Fatalf("round trip lost data: %+v", got)
	}
	if got.UpdatedAt != testNow().Unix() {
		t.Fatalf("UpdatedAt = %d, want %d", got.UpdatedAt, testNow().Unix())
	}
}

// TestJournalPruneKeepsUnfinishedWork. An unfinished journal is the ONLY record
// of an in-flight task's destination plan; deleting it early would turn a
// resumable crash into an ambiguous directory. Only reported, completed receipts
// past retention may go.
func TestJournalPruneKeepsUnfinishedWork(t *testing.T) {
	s := NewJournalStore(filepath.Join(t.TempDir(), "tasks"))
	old := testNow().Add(-2 * JournalRetention)

	inflight := &Journal{TaskID: "inflight", Plan: []PlanEntry{{Dest: "/r/x"}}}
	if err := s.Save(inflight, old); err != nil {
		t.Fatalf("save: %v", err)
	}
	committedNotReported := &Journal{TaskID: "unreported", Completed: true}
	if err := s.Save(committedNotReported, old); err != nil {
		t.Fatalf("save: %v", err)
	}
	done := &Journal{TaskID: "done", Completed: true, SavedReported: true}
	if err := s.Save(done, old); err != nil {
		t.Fatalf("save: %v", err)
	}
	recent := &Journal{TaskID: "recent", Completed: true, SavedReported: true}
	if err := s.Save(recent, testNow()); err != nil {
		t.Fatalf("save: %v", err)
	}

	if err := s.Prune(testNow()); err != nil {
		t.Fatalf("prune: %v", err)
	}
	for _, id := range []string{"inflight", "unreported", "recent"} {
		if _, found, _ := s.Load(id); !found {
			t.Fatalf("prune deleted %q, which is still load-bearing", id)
		}
	}
	if _, found, _ := s.Load("done"); found {
		t.Fatal("prune kept a reported receipt well past retention")
	}
}

// TestConfigRoundTripsAndIsPrivate.
func TestConfigRoundTripsAndIsPrivate(t *testing.T) {
	s := NewStore(filepath.Join(t.TempDir(), "inbox"))
	if _, found, err := s.LoadConfig(); found || err != nil {
		t.Fatalf("a device that never enabled must report found=false, no error: %v %v", found, err)
	}
	want := Config{DeviceID: "dev-1", Server: "https://example.test", Dir: "/srv/inbox", Enabled: true, AutoAccept: "auto"}
	if err := s.SaveConfig(want, testNow()); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, found, err := s.LoadConfig()
	if err != nil || !found {
		t.Fatalf("load: %v %v", found, err)
	}
	if got.Dir != want.Dir || !got.Enabled || got.DeviceID != want.DeviceID || got.Server != want.Server {
		t.Fatalf("round trip = %+v, want %+v", got, want)
	}
	fi, err := os.Stat(filepath.Join(s.Dir(), configFile))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("config mode = %v, want 0600", fi.Mode().Perm())
	}
}

// TestWriteSecretFileReplacesAtomically. A crash mid-write must leave the
// previous contents intact, never a truncated file: for keys.json that would be
// a lost private key.
func TestWriteSecretFileReplacesAtomically(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "secret")
	if err := writeSecretFile(p, []byte("first")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := writeSecretFile(p, []byte("second")); err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	if got := read(t, p); got != "second" {
		t.Fatalf("content = %q", got)
	}
	// No temp files may survive a successful write.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	for _, e := range entries {
		if e.Name() != "secret" {
			t.Fatalf("a temporary file survived the atomic write: %q", e.Name())
		}
	}
}

// TestWorkerLockExcludesASecondWorker. Two workers on one state directory would
// race on the journals and the receive directory; no server-side claim token can
// prevent that, so the exclusion lives here.
func TestWorkerLockExcludesASecondWorker(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "inbox")
	s := NewStore(dir)
	if err := s.Ensure(); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	first, err := AcquireLock(s.LockPath())
	if err != nil {
		t.Fatalf("first lock: %v", err)
	}
	running, err := WorkerRunning(s.LockPath())
	if errors.Is(err, ErrLockUnsupported) {
		t.Skip("advisory locks are unavailable on this platform")
	}
	if err != nil || !running {
		t.Fatalf("WorkerRunning = %v, %v; want true", running, err)
	}
	if _, err := AcquireLock(s.LockPath()); !errors.Is(err, ErrWorkerRunning) {
		t.Fatalf("second lock = %v, want ErrWorkerRunning", err)
	}
	if err := first.Release(); err != nil {
		t.Fatalf("release: %v", err)
	}
	// After release the lock is free again — and, crucially, it would also be
	// free after a crash, because the kernel owns it. A pid file would not be.
	if running, err := WorkerRunning(s.LockPath()); err != nil || running {
		t.Fatalf("WorkerRunning after release = %v, %v; want false", running, err)
	}
	second, err := AcquireLock(s.LockPath())
	if err != nil {
		t.Fatalf("re-acquire: %v", err)
	}
	_ = second.Release()
}

var _ = time.Second
