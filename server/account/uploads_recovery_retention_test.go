package account

// G34-N5 (OA-053 Q4): a successfully finalized, still UNBOUND Device Inbox
// object and its finalize record are retained together until the object's own
// expires_at, so a sender whose finalize answer was lost can recover it with
// `{"recoverFinalized":true}` after the one-hour bind grace and tombstone idle
// bound that used to delete both.
//
// PRE-IMPLEMENTATION INVARIANTS, restated so the assertions are read against
// the intent:
//
//  1. Only a RECOVERABLE object is kept: one a resumable finalize linked to its
//     session (same user, blob, purpose). A single-shot upload, a row from
//     before the link and one whose record is gone keep the bind grace.
//  2. The window is the object's own expires_at, fixed by the finalize from the
//     plan-clamped TTL. Recovery neither refreshes nor extends it, and at
//     expires_at the object and its record both go; nothing is resurrected.
//  3. Recovery is a pure read: no debit, no meter, no stat, no object, no task.
//     The retained object keeps counting toward the account's storage until it
//     expires (invisible occupancy, documented rather than hidden).
//  4. Binding ends the special case: the record reverts to the ordinary idle
//     purge, and the object to the ordinary bound/terminal rules.
//  5. Every deletion re-evaluates its predicate in the statement that deletes;
//     a failed statement deletes nothing.
//
// Every test runs the real handlers over real HTTP on a FILE-backed SQLite
// database with the real reaper and the real GC sweep.

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/inbox"
)

// sweepAll runs every production cleanup pass that could touch a finalized
// upload: the upload reaper (open-session expiry, orphan claims, tombstone
// purge) and the full GC sweep (expiry, task-object reclaim, queue drain).
func sweepAll(h *pairHarness) {
	h.svc.ReapPendingUploads(h.now)
	gcSweep(h)
}

func blobBytes(t *testing.T, h *pairHarness, key string) []byte {
	t.Helper()
	rc, err := h.disk.GetRange(context.Background(), key, 0)
	if err != nil {
		t.Fatalf("read blob %s: %v", key, err)
	}
	defer rc.Close()
	b, err := io.ReadAll(rc)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func inboxTaskCount(t *testing.T, h *pairHarness) int {
	t.Helper()
	var n int
	if err := h.store.db.QueryRow(`SELECT COUNT(*) FROM inbox_tasks`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// lostDeviceTaskFinalize uploads a device_task object whose finalize answer is
// lost, and returns the session id, blob key and the object the link names.
func lostDeviceTaskFinalize(t *testing.T, h *pairHarness) (uploadID, key string, sf StoredFile) {
	t.Helper()
	uploadID, key = purposeUpload(t, h, StoredPurposeDeviceTask, 900)
	finalizeAnswerLost(t, h, uploadID)
	sf, err := h.store.GetStoredFile(context.Background(), linkOf(t, h, uploadID))
	if err != nil || sf.BlobKey != key || sf.Purpose != StoredPurposeDeviceTask || sf.InboxTaskID != "" {
		t.Fatalf("linked object %+v, %v", sf, err)
	}
	return uploadID, key, sf
}

// The acceptance path: +1h01m, restart, and one second before expiry all
// recover the same id with the same expiry over the same ciphertext, with one
// daily debit and no further traffic, stats or task. At expires_at recovery
// refuses, the sweeps take object, blob and record, and nothing comes back.
func TestG34N5RecoversAnUnboundTaskObjectUntilItsOwnExpiry(t *testing.T) {
	path := filepath.Join(t.TempDir(), "central.sqlite")
	h := openFileHarness(t, path, 1_767_312_000)
	id, key, sf := lostDeviceTaskFinalize(t, h)
	disk := h.disk
	cipher := blobBytes(t, h, key)
	if sf.ExpiresAt-sf.CreatedAt != 7200 {
		t.Fatalf("setup: TTL %d, want the requested and plan-clamped 7200", sf.ExpiresAt-sf.CreatedAt)
	}
	before := ledgerOf(t, h)
	if before.objects != 1 || before.events != 1 || before.metered != 900 || before.transfers != 1 || before.ownedUnbound != 1 {
		t.Fatalf("after the lost answer: %+v", before)
	}
	if got := h.currentStorage(t); got != sf.Size {
		t.Fatalf("storage %d, want the object's %d counted while it is retained", got, sf.Size)
	}

	check := func(stage string) {
		t.Helper()
		wantRecovered(t, finalizeT(t, h, id, recoverOptIn), sf.ID, sf.ExpiresAt)
		if after := ledgerOf(t, h); after != before {
			t.Fatalf("%s: the ledger moved: %+v -> %+v", stage, before, after)
		}
		if !bytes.Equal(blobBytes(t, h, key), cipher) {
			t.Fatalf("%s: the ciphertext changed", stage)
		}
		if n := inboxTaskCount(t, h); n != 0 {
			t.Fatalf("%s: recovery created %d task(s)", stage, n)
		}
		if got := h.currentStorage(t); got != sf.Size {
			t.Fatalf("%s: storage %d, want %d", stage, got, sf.Size)
		}
		// The default answer stays the legacy repeat 409, never a new object.
		wantLegacy409(t, finalizeT(t, h, id, ""))
	}

	// Past both one-hour bounds that used to delete the object and its record.
	h.now = sf.CreatedAt + int64(taskObjectBindGrace/time.Second) + 60
	for i := 0; i < 3; i++ {
		sweepAll(h)
	}
	check("+1h01m")

	// A process restart: nothing but the database file and the node's disk.
	now := h.now
	closeHarness(h)
	h = openFileHarness(t, path, now)
	h.disk = disk
	h.svc.SetBlobStore(disk)
	sweepAll(h)
	check("after restart")

	h.now = sf.ExpiresAt - 1
	sweepAll(h)
	check("expires_at-1")

	// At expires_at: refused before any sweep, and the sweep takes everything.
	h.now = sf.ExpiresAt
	wantOutcome(t, finalizeT(t, h, id, recoverOptIn), "expired")
	sweepAll(h)
	sweepAll(h)
	if h.storedFileExists(t, sf.ID) || h.sessionExists(t, id) {
		t.Fatal("the expired object or its record survived the sweep")
	}
	if h.blobExists(t, key) {
		t.Fatal("the expired object's ciphertext survived the sweep")
	}
	for _, at := range []int64{sf.ExpiresAt, sf.ExpiresAt + 3600} {
		h.now = at
		wantLegacy404(t, finalizeT(t, h, id, recoverOptIn))
		wantLegacy404(t, finalizeT(t, h, id, ""))
	}
	after := ledgerOf(t, h)
	if after.objects != 0 || after.events != 1 || after.metered != 900 || after.transfers != 1 || after.sessions != 0 {
		t.Fatalf("after expiry: %+v; want no object, the one debit kept, nothing re-created", after)
	}
	if got := h.currentStorage(t); got != 0 {
		t.Fatalf("storage after expiry = %d", got)
	}
}

// Another account asking for the retained object past the grace: the legacy
// 404, the owner's ledger untouched, and the owner can still recover it.
func TestG34N5AnotherAccountCannotRecoverTheRetainedObject(t *testing.T) {
	h := newRecoveryHarness(t)
	id, _, sf := lostDeviceTaskFinalize(t, h)
	h.now = sf.CreatedAt + int64(taskObjectBindGrace/time.Second) + 60
	sweepAll(h)
	other, _ := h.otherCookie(t, "other@example.com")
	before := ledgerOf(t, h)
	for _, body := range []string{"", recoverOptIn} {
		a, err := finalizeAs(h, other, id, body)
		if err != nil {
			t.Fatal(err)
		}
		wantLegacy404(t, a)
	}
	if after := ledgerOf(t, h); after != before {
		t.Fatalf("a foreign request moved the owner's ledger: %+v -> %+v", before, after)
	}
	wantRecovered(t, finalizeT(t, h, id, recoverOptIn), sf.ID, sf.ExpiresAt)
}

// Rows without a live finalize record keep the one-hour bind grace: a session
// finalized before the link existed (simulated by clearing it), and one whose
// record is gone. A share's record keeps its ordinary idle purge.
func TestG34N5ObjectsWithoutARecoverableRecordKeepTheBindGrace(t *testing.T) {
	t.Run("no_link", func(t *testing.T) {
		h := newRecoveryHarness(t)
		id, key := purposeUpload(t, h, StoredPurposeDeviceTask, 900)
		a := finalizeT(t, h, id, "")
		if a.status != 200 {
			t.Fatalf("finalize = %s", a)
		}
		if _, err := h.store.db.Exec(`UPDATE upload_sessions SET finalized_file_id = '' WHERE id = ?`, id); err != nil {
			t.Fatal(err)
		}
		h.advance(int64(taskObjectBindGrace/time.Second) + 60)
		sweepAll(h)
		sweepAll(h)
		if h.storedFileExists(t, a.body.ID) || h.blobExists(t, key) {
			t.Fatal("an object with no finalize link outlived the bind grace")
		}
		if h.sessionExists(t, id) {
			t.Fatal("a link-less tombstone outlived its idle bound")
		}
	})
	t.Run("record_gone", func(t *testing.T) {
		h := newRecoveryHarness(t)
		id, key := purposeUpload(t, h, StoredPurposeDeviceTask, 900)
		a := finalizeT(t, h, id, "")
		if a.status != 200 {
			t.Fatalf("finalize = %s", a)
		}
		if _, err := h.store.db.Exec(`DELETE FROM upload_sessions WHERE id = ?`, id); err != nil {
			t.Fatal(err)
		}
		h.advance(int64(taskObjectBindGrace/time.Second) + 60)
		sweepAll(h)
		sweepAll(h)
		if h.storedFileExists(t, a.body.ID) || h.blobExists(t, key) {
			t.Fatal("an object whose record is gone outlived the bind grace")
		}
	})
	t.Run("share_record", func(t *testing.T) {
		h := newRecoveryHarness(t)
		id, _ := purposeUpload(t, h, StoredPurposeShare, 900)
		a := finalizeT(t, h, id, "")
		if a.status != 200 {
			t.Fatalf("finalize = %s", a)
		}
		reapIdle(h)
		wantLegacy404(t, finalizeT(t, h, id, recoverOptIn))
		if !h.storedFileExists(t, a.body.ID) {
			t.Fatal("the purge took the share")
		}
	})
}

// The conditional delete re-evaluates the recoverable link itself: a GC acting
// on a stale candidate list (or on any caller's say-so) cannot delete a
// retained object, and neither can the set-based purge take its record.
func TestG34N5ConditionalDeletesReevaluateTheLink(t *testing.T) {
	h := newRecoveryHarness(t)
	id, key, sf := lostDeviceTaskFinalize(t, h)
	h.now = sf.CreatedAt + int64(taskObjectBindGrace/time.Second) + 60
	grace := int64(taskObjectBindGrace / time.Second)
	listed, err := h.store.ListReclaimableTaskObjects(context.Background(), h.now, grace)
	if err != nil || len(listed) != 0 {
		t.Fatalf("reclaim list = %+v, %v; want nothing", listed, err)
	}
	ok, err := h.store.DeleteTaskObjectIfReclaimable(context.Background(), sf.ID, h.now, grace)
	if err != nil || ok {
		t.Fatalf("stale reclaim of a retained object: ok=%v err=%v", ok, err)
	}
	if err := h.store.PurgeDoneUploadSessions(context.Background(), h.now, h.now); err != nil {
		t.Fatal(err)
	}
	if !h.storedFileExists(t, sf.ID) || !h.sessionExists(t, id) || !h.blobExists(t, key) {
		t.Fatal("a retained object, its blob or its record was deleted")
	}
	if q := queuedFor(t, h, key); len(q) != 0 {
		t.Fatalf("a retained object's blob was queued: %+v", q)
	}
	// At expires_at the same statements do reclaim.
	h.now = sf.ExpiresAt
	ok, err = h.store.DeleteTaskObjectIfReclaimable(context.Background(), sf.ID, h.now, grace)
	if err != nil || !ok {
		t.Fatalf("reclaim at expiry: ok=%v err=%v", ok, err)
	}
	if err := h.store.PurgeDoneUploadSessions(context.Background(), h.now, h.now); err != nil {
		t.Fatal(err)
	}
	if h.sessionExists(t, id) {
		t.Fatal("the record outlived its object")
	}
}

// A database that refuses deletes loses nothing: past the grace every sweep
// fails closed and recovery still answers; at expiry the rows stay (recovery
// says "expired", never an id) until the database heals, then both go.
func TestG34N5AFailingDatabaseDeletesNothing(t *testing.T) {
	h := newRecoveryHarness(t)
	id, key, sf := lostDeviceTaskFinalize(t, h)
	for _, q := range []string{
		`CREATE TRIGGER g34n5_sessions_refuse BEFORE DELETE ON upload_sessions BEGIN SELECT RAISE(ABORT, 'injected'); END`,
		`CREATE TRIGGER g34n5_files_refuse BEFORE DELETE ON stored_files BEGIN SELECT RAISE(ABORT, 'injected'); END`,
	} {
		if _, err := h.store.db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	before := ledgerOf(t, h)
	h.now = sf.CreatedAt + int64(taskObjectBindGrace/time.Second) + 60
	sweepAll(h)
	wantRecovered(t, finalizeT(t, h, id, recoverOptIn), sf.ID, sf.ExpiresAt)
	h.now = sf.ExpiresAt + 60
	sweepAll(h)
	if !h.storedFileExists(t, sf.ID) || !h.sessionExists(t, id) {
		t.Fatal("a refused delete still removed a row")
	}
	wantOutcome(t, finalizeT(t, h, id, recoverOptIn), "expired")
	if after := ledgerOf(t, h); after.events != before.events || after.metered != before.metered || after.transfers != before.transfers {
		t.Fatalf("a failing sweep moved the ledger: %+v -> %+v", before, after)
	}
	for _, q := range []string{`DROP TRIGGER g34n5_sessions_refuse`, `DROP TRIGGER g34n5_files_refuse`} {
		if _, err := h.store.db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	sweepAll(h)
	sweepAll(h)
	if h.storedFileExists(t, sf.ID) || h.sessionExists(t, id) || h.blobExists(t, key) {
		t.Fatal("the healed sweep left the expired object, its record or its blob")
	}
}

// Binding ends the special case (task-object harness: real device enrolment
// and task create). The recovered object binds after the grace; the next reap
// purges its record; the live delivery keeps the object; a terminal task
// releases it exactly as before.
func TestG34N5BindingAfterTheGraceRevertsToOrdinaryRules(t *testing.T) {
	h := newTaskObjectHarness(t)
	u := h.user(t, "g34n5@example.test")
	tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
	fileID := h.resumableUpload(t, tg.token, "&purpose=device_task", []byte("opaque-manifest"), bytes.Repeat([]byte("C"), 900))
	key := h.blobKey(t, fileID)
	var uploadID string
	if err := h.store.db.QueryRow(`SELECT id FROM upload_sessions WHERE finalized_file_id = ?`, fileID).Scan(&uploadID); err != nil {
		t.Fatalf("finalize record: %v", err)
	}
	sessionRows := func() int {
		var n int
		if err := h.store.db.QueryRow(`SELECT COUNT(*) FROM upload_sessions WHERE id = ?`, uploadID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	sweep := func() {
		h.svc.ReapPendingUploads(h.nowUnix())
		h.gc().sweep(context.Background())
	}
	h.advance(taskObjectBindGrace + time.Minute)
	sweep()
	if !h.fileExists(t, fileID) || sessionRows() != 1 {
		t.Fatal("the recoverable object or its record did not survive the grace")
	}
	resp := h.createTask(t, tg.deviceID, createOpts{
		idem: "late-send", fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen,
		authMutate: withBearer(tg.token),
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("bind after the grace: got %d, want 201", resp.StatusCode)
	}
	task := decodeJSONBody(t, resp)["task"].(map[string]any)
	taskID := task["ID"].(string)
	sweep()
	if sessionRows() != 0 {
		t.Fatal("a bound object's record was kept past its idle bound")
	}
	if !h.fileExists(t, fileID) || !h.blobExists(t, key) {
		t.Fatal("the bound object of a live delivery was reclaimed")
	}
	_, claim := h.claimOne(t, tg)
	if resp := h.report(t, tg, taskID, claim, inbox.TaskVerifying, "", false); resp.StatusCode != 200 {
		t.Fatalf("report verifying: got %d", resp.StatusCode)
	}
	if resp := h.report(t, tg, taskID, claim, inbox.TaskSaved, "", true); resp.StatusCode != 200 {
		t.Fatalf("report saved: got %d", resp.StatusCode)
	}
	sweep()
	if h.fileExists(t, fileID) || h.blobExists(t, key) {
		t.Fatal("a terminal task's object was retained")
	}
}

// Bind racing the sweeps, both orders and truly concurrent: whatever order
// SQLite serializes them in, the object is bound and alive afterwards, and its
// record is either still there (the purge ran first) or purged (after the
// bind) — never an object reclaimed under the bind.
func TestG34N5BindRacingTheSweepsNeverLosesTheObject(t *testing.T) {
	for round := 0; round < 4; round++ {
		h := newTaskObjectHarness(t)
		u := h.user(t, "g34n5-race@example.test")
		tg := h.enrolTarget(t, u, "server", inbox.AutoAcceptAuto, true)
		fileID := h.resumableUpload(t, tg.token, "&purpose=device_task", []byte("opaque-manifest"), bytes.Repeat([]byte("R"), 900))
		key := h.blobKey(t, fileID)
		h.advance(taskObjectBindGrace + time.Minute)
		var wg sync.WaitGroup
		stop := make(chan struct{})
		for w := 0; w < 2; w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for {
					select {
					case <-stop:
						return
					default:
					}
					h.svc.ReapPendingUploads(h.nowUnix())
					h.gc().sweep(context.Background())
				}
			}()
		}
		if round%2 == 1 {
			time.Sleep(5 * time.Millisecond) // let the sweeps get ahead
		}
		resp := h.createTask(t, tg.deviceID, createOpts{
			idem: "race", fileID: fileID, keyID: tg.keyID, keyGen: tg.keyGen,
			authMutate: withBearer(tg.token),
		})
		close(stop)
		wg.Wait()
		if resp.StatusCode != http.StatusCreated {
			t.Fatalf("round %d: bind racing the sweeps: got %d, want 201", round, resp.StatusCode)
		}
		h.svc.ReapPendingUploads(h.nowUnix())
		h.gc().sweep(context.Background())
		if !h.fileExists(t, fileID) || !h.blobExists(t, key) || h.boundTaskID(t, fileID) == "" {
			t.Fatalf("round %d: the bound object was lost to a racing sweep", round)
		}
	}
}
