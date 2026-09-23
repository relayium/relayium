package account

// A33: the daily-quota debit must never outlive — or be missing from — the
// object it pays for, whatever stops an upload between deciding to charge and
// storing the object. Before the fix the debit was a separate committed
// reservation, refunded on failure; these are the failures a refund cannot
// cover:
//
//   - the server process is killed (a real SIGKILL of a real child process,
//     restarted on the same database file and blob directory);
//   - the database refuses the insert for a reason that is not a cancellation
//     (another connection holding SQLite's write lock past busy_timeout, and
//     an insert that fails inside its own transaction).
//
// Every case ends with invariant I1+I2 (assertOneDebitPerObject): debits and
// objects agree one-for-one, before and after a restart, a GC pass and a
// retry.

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"
)

const (
	quotaChildDirEnv   = "RELAYIUM_QUOTA_CRASH_DIR"
	quotaChildRouteEnv = "RELAYIUM_QUOTA_CRASH_ROUTE"
	quotaChildPointEnv = "RELAYIUM_QUOTA_CRASH_POINT"
	// quotaPersistInside is not a store-wrapper point: the child is killed
	// while the insert's own transaction is open, after the debit row was
	// written and before the object's insert could finish.
	quotaPersistInside = "persist.inside"
	// oneUploadQuota fits exactly one small upload (a 64 KiB-floored debit)
	// and not two, so a phantom debit is visible as a refused retry.
	oneUploadQuota = 100000
)

// installSlowObjectInsert makes every stored_files INSERT spend (effectively)
// forever inside its transaction, in a BEFORE trigger — after the debit row
// the same transaction writes first. It is a real, persistent trigger in the
// database file; dropSlowObjectInsert removes it after the restart.
func installSlowObjectInsert(t *testing.T, store *SQLiteStore) {
	t.Helper()
	stmts := []string{
		`CREATE TABLE quota_crash_n (x INTEGER)`,
		`WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 2000) INSERT INTO quota_crash_n (x) SELECT x FROM c`,
		`CREATE TRIGGER quota_crash_slow BEFORE INSERT ON stored_files BEGIN
		   SELECT count(*) FROM quota_crash_n a, quota_crash_n b, quota_crash_n c;
		 END`,
	}
	for _, s := range stmts {
		if _, err := store.db.Exec(s); err != nil {
			t.Fatalf("installing the slow insert: %s: %v", s, err)
		}
	}
}

func dropSlowObjectInsert(t *testing.T, store *SQLiteStore) {
	t.Helper()
	for _, s := range []string{`DROP TRIGGER IF EXISTS quota_crash_slow`, `DROP TABLE IF EXISTS quota_crash_n`} {
		if _, err := store.db.Exec(s); err != nil {
			t.Fatalf("%s: %v", s, err)
		}
	}
}

// writeLockHeld reports whether some connection holds dbPath's write lock:
// an independent connection's BEGIN IMMEDIATE with no busy wait fails.
func writeLockHeld(dbPath string) bool {
	db, err := sql.Open("sqlite", withPragmas("file:"+dbPath, "busy_timeout(0)"))
	if err != nil {
		return false
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	conn, err := db.Conn(context.Background())
	if err != nil {
		return false
	}
	defer conn.Close()
	if _, err := conn.ExecContext(context.Background(), "BEGIN IMMEDIATE"); err != nil {
		return true
	}
	_, _ = conn.ExecContext(context.Background(), "ROLLBACK")
	return false
}

// TestUploadQuotaCrashChild is the server process the SIGKILL test kills. It
// does nothing unless the parent re-executed the test binary for it.
func TestUploadQuotaCrashChild(t *testing.T) {
	dir := os.Getenv(quotaChildDirEnv)
	if dir == "" {
		t.Skip("child process of TestUploadQuotaDebitMatchesObjectsAcrossSIGKILL only")
	}
	route, point := os.Getenv(quotaChildRouteEnv), os.Getenv(quotaChildPointEnv)
	h := newQuotaHarness(t, quotaOpts{dir: dir, dailyQuota: oneUploadQuota})
	path, body := h.route(route, 900)
	kill := func() {
		_ = os.WriteFile(dir+"/killed-at", []byte(point), 0o600)
		_ = syscall.Kill(os.Getpid(), syscall.SIGKILL)
		select {}
	}
	switch point {
	case quotaPersistInside:
		installSlowObjectInsert(t, h.store)
		h.hook.setOnPoint(func(p quotaPoint, _ context.Context) {
			if p != qpPersistBefore {
				return
			}
			// The insert runs on this goroutine once the callback returns; kill
			// from another one as soon as its transaction holds the write lock
			// and has had ample time to write the debit and reach the trigger.
			go func() {
				for deadline := time.Now().Add(20 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
					if writeLockHeld(h.dbPath) {
						time.Sleep(500 * time.Millisecond)
						if !writeLockHeld(h.dbPath) {
							break // the transaction ended: not the point under test
						}
						kill()
					}
				}
				_ = os.WriteFile(dir+"/not-killed", []byte("the insert transaction was never observed open"), 0o600)
				os.Exit(3)
			}()
		})
	default:
		h.hook.setOnPoint(func(p quotaPoint, _ context.Context) {
			if string(p) == point {
				kill()
			}
		})
	}
	conn, _ := h.rawSend("POST", path, body, nil)
	defer conn.Close()
	time.Sleep(30 * time.Second)
	_ = os.WriteFile(dir+"/not-killed", []byte("timeout"), 0o600)
	os.Exit(3) // never reach the harness cleanup: a server blocked in a trigger cannot be closed
}

// T1. SIGKILL of the server at each point around the object insert, then a
// restart on the same database and blobs, a GC pass an hour later, and a retry
// under a quota that fits exactly one upload.
func TestUploadQuotaDebitMatchesObjectsAcrossSIGKILL(t *testing.T) {
	if testing.Short() {
		t.Skip("re-executes the test binary and kills it")
	}
	for _, route := range []string{"single", "finalize"} {
		for _, point := range []string{string(qpPersistBefore), quotaPersistInside, string(qpPersistAfter)} {
			t.Run(route+"/"+point, func(t *testing.T) {
				dir := t.TempDir()
				ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
				defer cancel()
				cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestUploadQuotaCrashChild$", "-test.count=1", "-test.v")
				cmd.Env = append(os.Environ(), quotaChildDirEnv+"="+dir, quotaChildRouteEnv+"="+route, quotaChildPointEnv+"="+point)
				childStart := time.Now()
				out, _ := cmd.CombinedOutput()
				childTook := time.Since(childStart)
				ws, _ := cmd.ProcessState.Sys().(syscall.WaitStatus)
				killedAt, _ := os.ReadFile(dir + "/killed-at")
				if !ws.Signaled() || ws.Signal() != syscall.SIGKILL || string(killedAt) != point {
					notKilled, _ := os.ReadFile(dir + "/not-killed")
					t.Fatalf("child was not SIGKILLed at %s (status %v, marker %q, not-killed %q); output:\n%s", point, ws, killedAt, notKilled, out)
				}
				t.Logf("child SIGKILLed at %s after %v", killedAt, childTook.Round(time.Millisecond))

				// Restart: a new server on the same database file and blob dir.
				h := newQuotaHarness(t, quotaOpts{dir: dir, dailyQuota: oneUploadQuota})
				dropSlowObjectInsert(t, h.store)
				l := h.assertOneDebitPerObject("after SIGKILL at " + point)
				wantObjects := int64(0)
				if point == string(qpPersistAfter) {
					wantObjects = 1 // the insert committed: the object and its debit are both real
				}
				if l.Files != wantObjects {
					t.Fatalf("objects after the restart: %d, want %d", l.Files, wantObjects)
				}

				// A legitimate debit is not revoked by anything but the 24h prune
				// (I6), and GC recovers nothing into a phantom one.
				start := time.Now().Unix()
				h.runGC(start + pendingUploadTTL + 60)
				h.runGC(start + pendingUploadTTL + 120)
				h.assertOneDebitPerObject("after GC at +1h")

				// The retry: free quota unless an object really exists.
				wantRetry := http.StatusOK
				if wantObjects == 1 {
					wantRetry = http.StatusTooManyRequests
				}
				code, _ := h.do("POST", "/api/files?ttl=7200", quotaSingleBody(900))
				if code != wantRetry {
					t.Fatalf("retry under a one-upload quota: %d, want %d", code, wantRetry)
				}
				h.assertOneDebitPerObject("after the retry")
				h.assertNoLegacyLedgerCalls()
			})
		}
	}
}

// T2. Another connection holds SQLite's write lock past busy_timeout while the
// upload reaches its insert, and until the handler has answered: the insert
// fails with SQLITE_BUSY — a database failure, not a cancellation — and the
// answer is 500 with no debit, so a retry once the lock is gone is admitted.
func TestUploadQuotaWriteLockAtInsertLeavesNoDebit(t *testing.T) {
	if testing.Short() {
		t.Skip("waits out busy_timeout")
	}
	for _, route := range []string{"single", "finalize"} {
		t.Run(route, func(t *testing.T) {
			h := newQuotaHarness(t, quotaOpts{dailyQuota: oneUploadQuota})
			path, body := h.route(route, 900)
			var release func()
			h.hook.setOnPoint(func(p quotaPoint, _ context.Context) {
				if p == qpPersistBefore && release == nil {
					release = holdWriteLock(t, h.dbPath)
				}
			})
			conn, req := h.rawSend("POST", path, body, nil)
			code, _, err := quotaReadResp(conn, req)
			conn.Close()
			if err != nil {
				t.Fatalf("read response: %v", err)
			}
			h.waitDone("POST", strings.SplitN(path, "?", 2)[0])
			h.hook.setOnPoint(nil)
			if release == nil {
				t.Fatal("the upload never reached its insert")
			}
			release()
			errs := h.hook.persistErrors()
			t.Logf("answered %d; insert errors: %v", code, errs)
			if code != http.StatusInternalServerError {
				t.Fatalf("answered %d under a held write lock, want 500", code)
			}
			if len(errs) != 1 || !strings.Contains(errs[0].Error(), "locked") || errors.Is(errs[0], context.Canceled) {
				t.Fatalf("insert errors %v, want exactly one SQLITE_BUSY that is not a cancellation", errs)
			}
			h.assertOneDebitPerObject("after SQLITE_BUSY at the insert")
			if l := h.ledger(); l.Events != 0 {
				t.Fatalf("a failed insert left %d debit(s)", l.Events)
			}
			rc, _ := h.do("POST", "/api/files?ttl=7200", quotaSingleBody(900))
			if rc != http.StatusOK {
				t.Fatalf("retry refused %d: the failed attempt still holds quota", rc)
			}
			h.assertOneDebitPerObject("after the retry")
			h.assertNoLegacyLedgerCalls()
		})
	}
}

// T2b. The object's own INSERT fails inside the transaction that has already
// written the debit (a trigger raising on exactly this object's size). The
// debit must roll back with it. This is the failure that tells "debit in the
// same transaction" apart from "debit committed just before it".
func TestUploadQuotaInsertFailureRollsBackTheDebit(t *testing.T) {
	for _, route := range []string{"single", "finalize"} {
		t.Run(route, func(t *testing.T) {
			h := newQuotaHarness(t, quotaOpts{dailyQuota: oneUploadQuota})
			if _, err := h.store.db.Exec(`CREATE TRIGGER quota_insert_fails BEFORE INSERT ON stored_files
				WHEN NEW.size = 901 BEGIN SELECT RAISE(ABORT, 'injected stored_files insert failure'); END`); err != nil {
				t.Fatalf("trigger: %v", err)
			}
			path, body := h.route(route, 901)
			code, _ := h.do("POST", path, body)
			errs := h.hook.persistErrors()
			t.Logf("answered %d; insert errors: %v", code, errs)
			if code != http.StatusInternalServerError {
				t.Fatalf("answered %d, want 500", code)
			}
			if len(errs) != 1 || !strings.Contains(errs[0].Error(), "injected stored_files insert failure") {
				t.Fatalf("insert errors %v, want the injected one", errs)
			}
			l := h.assertOneDebitPerObject("after a failed insert")
			if l.Events != 0 || l.CentralBlobs != 0 {
				t.Fatalf("a failed insert left %d debit(s) and %d blob(s)", l.Events, l.CentralBlobs)
			}
			if l.Meter != 901 {
				t.Fatalf("meter %d, want the 901 bytes that moved (W-N35)", l.Meter)
			}
			if _, err := h.store.db.Exec(`DROP TRIGGER quota_insert_fails`); err != nil {
				t.Fatal(err)
			}
			rc, _ := h.do("POST", "/api/files?ttl=7200", quotaSingleBody(900))
			if rc != http.StatusOK {
				t.Fatalf("retry refused %d: the failed attempt still holds quota", rc)
			}
			h.assertOneDebitPerObject("after the retry")
			h.assertNoLegacyLedgerCalls()
		})
	}
}
