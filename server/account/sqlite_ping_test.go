package account

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestPingProvesTheDatabaseIsWritable pins what /readyz relies on: Ping
// answers for the database's WRITABILITY, not for the existence of a handle.
//
// The unwritable case is produced honestly: the file is made read-only and the
// writer pool is forced to reconnect (idle conns 0), so the next connection is
// opened by SQLite in its read-only fallback — exactly what a restarted process
// or a recycled connection would get. A bare PingContext succeeds on that
// connection (the control asserted below), and so does BEGIN IMMEDIATE on a WAL
// database — which is why Ping also dirties a page.
func TestPingProvesTheDatabaseIsWritable(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores file permissions; the read-only case cannot be produced")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "relayium.db")
	s, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := s.Ping(ctx); err != nil {
		t.Fatalf("Ping on a writable database: %v", err)
	}

	s.db.SetMaxIdleConns(0) // every use now opens a fresh writer connection
	t.Cleanup(func() {
		for _, p := range []string{path, path + "-wal", path + "-shm"} {
			_ = os.Chmod(p, 0o600)
		}
	})
	if err := os.Chmod(path, 0o400); err != nil {
		t.Fatal(err)
	}

	// Negative control: the handle-level ping the probe used to be is blind to it.
	if err := s.db.PingContext(ctx); err != nil {
		t.Fatalf("control: PingContext on the read-only file failed (%v) — the case no longer shows the gap it guards", err)
	}
	if err := s.Ping(ctx); err == nil {
		t.Fatal("Ping answered ready for a database whose file is read-only")
	}

	// And it recovers once the files are writable again. (-wal/-shm are
	// restored too: SQLite gives them the database file's mode when a
	// connection recreates them while it is read-only.)
	for _, p := range []string{path, path + "-wal", path + "-shm"} {
		if err := os.Chmod(p, 0o600); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	}
	if err := s.Ping(ctx); err != nil {
		t.Fatalf("Ping after the file became writable again: %v", err)
	}
}

// TestPingIsBoundedByItsContextBehindAHeldWriter: a probe queued behind the
// single writer connection returns when its deadline does, reports not-ready,
// and leaves the writer's transaction untouched.
func TestPingIsBoundedByItsContextBehindAHeldWriter(t *testing.T) {
	s, err := OpenSQLite(filepath.Join(t.TempDir(), "relayium.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })

	tx, err := s.db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	start := time.Now()
	if err := s.Ping(ctx); err == nil {
		t.Fatal("Ping succeeded while the single writer connection was held")
	}
	if el := time.Since(start); el > 2*time.Second {
		t.Fatalf("Ping took %v; its context bound was 200ms", el)
	}
	if _, err := tx.Exec(`CREATE TABLE ping_probe_left_alone (x INTEGER)`); err != nil {
		t.Fatalf("writer transaction disturbed by the probe: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	ctx2, cancel2 := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel2()
	if err := s.Ping(ctx2); err != nil {
		t.Fatalf("Ping once the writer was released: %v", err)
	}
}
