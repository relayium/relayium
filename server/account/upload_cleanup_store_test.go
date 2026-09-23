package account

// Store-level contracts of upload cleanup ownership (W-N36): the single and the
// set-based cleanup claim, and the stored-file insert's session precondition.
// The handler- and reaper-level races are in upload_cleanup_ownership_test.go.

import (
	"context"
	"errors"
	"testing"
)

// cleanupRow creates one session row for userID in the given terminal state.
func cleanupRow(t *testing.T, st *SQLiteStore, id, userID string, done bool, received, metered, unresolvedAt, lastActivity int64) UploadSessionRow {
	t.Helper()
	ctx := context.Background()
	row := mkUploadRow(id, userID)
	row.CreatedAt = 100
	if ok, err := st.CreateUploadSession(ctx, row, 1000); err != nil || !ok {
		t.Fatalf("create %s: ok=%v err=%v", id, ok, err)
	}
	if _, err := st.db.Exec(`UPDATE upload_sessions
		SET done = ?, received = ?, metered = ?, unresolved_at = ?, last_activity = ? WHERE id = ?`,
		b2i(done), received, metered, unresolvedAt, lastActivity, id); err != nil {
		t.Fatal(err)
	}
	return row
}

func queueRows(t *testing.T, st *SQLiteStore, key string) []PendingNodeDelete {
	t.Helper()
	all, err := st.ListPendingNodeDeletes(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var out []PendingNodeDelete
	for _, p := range all {
		if p.BlobKey == key {
			out = append(out, p)
		}
	}
	return out
}

func sessionPresent(t *testing.T, st *SQLiteStore, id, userID string) bool {
	t.Helper()
	_, ok, err := st.GetUploadSession(context.Background(), id, userID)
	if err != nil {
		t.Fatal(err)
	}
	return ok
}

// Every clause of the eligibility predicate is re-read inside the claim, and a
// row that fails any of them is left exactly as it was, with nothing queued.
func TestTheCleanupClaimRechecksEveryClause(t *testing.T) {
	ctx := context.Background()
	st := newTestStore(t)
	u, _ := st.UpsertUserByEmail(ctx, "claim@example.com", "C")
	const idleBefore = 5000

	cleanupRow(t, st, "open", u.ID, false, 10, 10, 0, 1000)
	cleanupRow(t, st, "unresolved", u.ID, true, 10, 10, 1000, 1000)
	cleanupRow(t, st, "unsettled", u.ID, true, 10, 5, 0, 1000)
	cleanupRow(t, st, "recent", u.ID, true, 10, 10, 0, idleBefore+1)
	cleanupRow(t, st, "referenced", u.ID, true, 10, 10, 0, 1000)
	if err := st.CreateStoredFile(ctx, StoredFile{ID: "f-ref", UserID: u.ID, BlobKey: "blob-referenced",
		EncManifest: []byte("m"), Size: 10, CreatedAt: 100, ExpiresAt: 1 << 40}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"open", "unresolved", "unsettled", "recent", "referenced", "missing"} {
		key, node, ok, err := st.ClaimUploadSessionCleanup(ctx, id, idleBefore, 7000)
		if err != nil || ok || key != "" || node != "" {
			t.Fatalf("claim %s: key=%q node=%q ok=%v err=%v, want not eligible", id, key, node, ok, err)
		}
		if id != "missing" && !sessionPresent(t, st, id, u.ID) {
			t.Fatalf("an ineligible claim deleted row %s", id)
		}
		if q := queueRows(t, st, "blob-"+id); len(q) != 0 {
			t.Fatalf("an ineligible claim queued %s: %+v", id, q)
		}
	}

	// Own-node (billable=0) rows are settled whatever the meter says.
	cleanupRow(t, st, "own", u.ID, true, 10, 0, 0, 1000)
	if _, err := st.db.Exec(`UPDATE upload_sessions SET billable = 0, node_id = 'n1' WHERE id = 'own'`); err != nil {
		t.Fatal(err)
	}
	key, node, ok, err := st.ClaimUploadSessionCleanup(ctx, "own", idleBefore, 7000)
	if err != nil || !ok || key != "blob-own" || node != "n1" {
		t.Fatalf("claim own: key=%q node=%q ok=%v err=%v", key, node, ok, err)
	}
	if sessionPresent(t, st, "own", u.ID) {
		t.Fatal("the claimed row survived")
	}
	q := queueRows(t, st, "blob-own")
	if len(q) != 1 || q[0].NodeID != "n1" || q[0].EnqueuedAt != 7000 || q[0].NotBefore != 0 || q[0].BillUserID != "" {
		t.Fatalf("queue after the claim = %+v, want one deletion-only row enqueued at 7000", q)
	}
	if _, _, ok, err := st.ClaimUploadSessionCleanup(ctx, "own", idleBefore, 7001); err != nil || ok {
		t.Fatalf("a second claim: ok=%v err=%v, want a no-op", ok, err)
	}
}

// A claim whose queue write fails writes nothing: the row still owns the blob.
func TestAFailedCleanupClaimWritesNothing(t *testing.T) {
	ctx := context.Background()
	st := newTestStore(t)
	u, _ := st.UpsertUserByEmail(ctx, "claimfail@example.com", "C")
	cleanupRow(t, st, "s1", u.ID, true, 10, 10, 0, 1000)
	if _, err := st.db.Exec(`CREATE TRIGGER q_refuses BEFORE INSERT ON pending_node_deletes
		BEGIN SELECT RAISE(ABORT, 'injected'); END`); err != nil {
		t.Fatal(err)
	}
	if _, _, ok, err := st.ClaimUploadSessionCleanup(ctx, "s1", 5000, 7000); err == nil || ok {
		t.Fatalf("claim under a failing queue write: ok=%v err=%v, want an error", ok, err)
	}
	if !sessionPresent(t, st, "s1", u.ID) {
		t.Fatal("the row went although its blob was never queued")
	}
}

// The purge is one transaction: a failed queue write rolls back its deletes, and
// a successful one queues exactly the unreferenced rows it removes, keeping an
// existing hold and obligation on a key.
func TestThePurgeIsOneTransaction(t *testing.T) {
	ctx := context.Background()
	st := newTestStore(t)
	u, _ := st.UpsertUserByEmail(ctx, "purge@example.com", "P")
	cleanupRow(t, st, "orphan", u.ID, true, 10, 10, 0, 1000)
	cleanupRow(t, st, "held", u.ID, true, 10, 10, 0, 1000)
	cleanupRow(t, st, "live", u.ID, true, 10, 10, 0, 1000)
	cleanupRow(t, st, "unsettled", u.ID, true, 10, 5, 0, 1000)
	if err := st.CreateStoredFile(ctx, StoredFile{ID: "f-live", UserID: u.ID, BlobKey: "blob-live",
		EncManifest: []byte("m"), Size: 10, CreatedAt: 100, ExpiresAt: 1 << 40}); err != nil {
		t.Fatal(err)
	}
	if err := enqueueBilledNodeDeleteOn(ctx, st.db, "blob-held", "", 50, 9999, u.ID, MeterUpload, 100, 10); err != nil {
		t.Fatal(err)
	}

	if _, err := st.db.Exec(`CREATE TRIGGER q_refuses BEFORE INSERT ON pending_node_deletes
		BEGIN SELECT RAISE(ABORT, 'injected'); END`); err != nil {
		t.Fatal(err)
	}
	if err := st.PurgeDoneUploadSessions(ctx, 5000, 7000); err == nil {
		t.Fatal("a purge whose queue write failed reported success")
	}
	for _, id := range []string{"orphan", "held", "live", "unsettled"} {
		if !sessionPresent(t, st, id, u.ID) {
			t.Fatalf("a purge whose queue write failed still deleted %s", id)
		}
	}
	if q := queueRows(t, st, "blob-orphan"); len(q) != 0 {
		t.Fatalf("a failed purge left a queue row: %+v", q)
	}
	if _, err := st.db.Exec(`DROP TRIGGER q_refuses`); err != nil {
		t.Fatal(err)
	}

	if err := st.PurgeDoneUploadSessions(ctx, 5000, 7000); err != nil {
		t.Fatalf("purge: %v", err)
	}
	for id, want := range map[string]bool{"orphan": false, "held": false, "live": false, "unsettled": true} {
		if got := sessionPresent(t, st, id, u.ID); got != want {
			t.Fatalf("after the purge row %s present=%v, want %v", id, got, want)
		}
	}
	if q := queueRows(t, st, "blob-orphan"); len(q) != 1 || q[0].EnqueuedAt != 7000 || q[0].BillUserID != "" {
		t.Fatalf("the orphan's queue = %+v, want one deletion-only row enqueued at 7000", q)
	}
	if q := queueRows(t, st, "blob-live"); len(q) != 0 {
		t.Fatalf("the purge queued a live object's blob: %+v", q)
	}
	if q := queueRows(t, st, "blob-unsettled"); len(q) != 0 {
		t.Fatalf("the purge queued an unsettled row's blob: %+v", q)
	}
	q := queueRows(t, st, "blob-held")
	if len(q) != 1 || q[0].NotBefore != 9999 || q[0].EnqueuedAt != 50 ||
		q[0].BillUserID != u.ID || q[0].BilledThrough != 10 || q[0].BillMax != 100 {
		t.Fatalf("the purge rewrote an existing hold/obligation: %+v", q)
	}
}

// The insert's session precondition, on all three doors, after the caps and
// after the pair-room check.
func TestTheStoredFileInsertRequiresItsSessionToStillOwnTheBlob(t *testing.T) {
	ctx := context.Background()
	st := newTestStore(t)
	u, _ := st.UpsertUserByEmail(ctx, "cas@example.com", "S")
	other, _ := st.UpsertUserByEmail(ctx, "cas-other@example.com", "O")
	file := func(id, session string) StoredFile {
		return StoredFile{ID: id, UserID: u.ID, BlobKey: "blob-" + session, EncManifest: []byte("m"),
			Size: 10, CreatedAt: 100, ExpiresAt: 1 << 40, UploadSessionID: session}
	}
	exists := func(id string) bool {
		_, err := st.GetStoredFile(ctx, id)
		return err == nil
	}

	cleanupRow(t, st, "tomb", u.ID, true, 10, 10, 0, 1000)
	cleanupRow(t, st, "open", u.ID, false, 10, 10, 0, 1000)
	cleanupRow(t, st, "unres", u.ID, true, 10, 10, 1000, 1000)
	cleanupRow(t, st, "theirs", other.ID, true, 10, 10, 0, 1000)

	refused := []struct {
		name string
		f    StoredFile
	}{
		{"missing", file("f-missing", "gone")},
		{"open", file("f-open", "open")},
		{"unresolved", file("f-unres", "unres")},
		{"another user's", file("f-theirs", "theirs")},
		{"another blob", func() StoredFile { f := file("f-blob", "tomb"); f.BlobKey = "blob-else"; return f }()},
	}
	for _, c := range refused {
		if err := st.CreateStoredFile(ctx, c.f); !errors.Is(err, ErrUploadSessionReclaimed) {
			t.Fatalf("CreateStoredFile, %s session: %v, want ErrUploadSessionReclaimed", c.name, err)
		}
		if _, err := st.CreateStoredFileWithinStorageCaps(ctx, c.f, 100, 1<<30, 1<<30); !errors.Is(err, ErrUploadSessionReclaimed) {
			t.Fatalf("capped insert, %s session: %v, want ErrUploadSessionReclaimed", c.name, err)
		}
		if exists(c.f.ID) {
			t.Fatalf("a refused insert (%s) wrote its row", c.name)
		}
	}

	// A cap refusal is decided first and still reports its reason.
	if w, err := st.CreateStoredFileWithinStorageCaps(ctx, file("f-cap", "gone"), 100, 5, 0); err != nil || w.Reason != "storage" {
		t.Fatalf("over-cap insert with a missing session: %+v %v, want Reason storage", w, err)
	}
	// Without a session id nothing changes.
	if err := st.CreateStoredFile(ctx, StoredFile{ID: "f-plain", UserID: u.ID, BlobKey: "blob-plain",
		EncManifest: []byte("m"), Size: 10, CreatedAt: 100, ExpiresAt: 1 << 40}); err != nil {
		t.Fatalf("plain insert: %v", err)
	}
	// The tombstone that still owns its blob is accepted, on the plain door.
	if err := st.CreateStoredFile(ctx, file("f-ok", "tomb")); err != nil || !exists("f-ok") {
		t.Fatalf("insert for a live tombstone: %v", err)
	}
	// ...and then no claim can take that blob.
	if _, _, ok, err := st.ClaimUploadSessionCleanup(ctx, "tomb", 5000, 7000); err != nil || ok {
		t.Fatalf("claim of a referenced tombstone: ok=%v err=%v", ok, err)
	}
}

// For a pair-room object the room's check comes before the session's: a closed
// room whose close also removed the session still answers ErrPairRoomClosed.
func TestAPairRoomInsertReportsTheClosedRoomBeforeTheMissingSession(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	h.mintCode("565656", "")
	status, uploadID, _ := h.initPairUpload(t, "565656", 10, "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	sess := h.session(t, uploadID)
	f := StoredFile{ID: "f-pair", UserID: h.userID, BlobKey: sess.BlobKey, EncManifest: []byte("m"),
		Size: 10, CreatedAt: h.now, ExpiresAt: h.now + 300, Purpose: StoredPurposePairRoom,
		PairRoomID: sess.PairRoomID, UploadSessionID: sess.ID}

	// Open room, session not yet claimed (done=0): the session check refuses.
	if _, err := h.store.CreateStoredFileWithinStorageCaps(ctx, f, h.now, 0, 0); !errors.Is(err, ErrUploadSessionReclaimed) {
		t.Fatalf("open room, open session: %v, want ErrUploadSessionReclaimed", err)
	}
	// Closed room (its close deleted the session row too): the room answers.
	h.advance(pairRoomJoinWindow + 1)
	h.svc.SweepPairRooms(ctx, h.now)
	if h.sessionExists(t, uploadID) {
		t.Fatal("the room's close kept the session row; the case is not staged")
	}
	if _, err := h.store.CreateStoredFileWithinStorageCaps(ctx, f, h.now, 0, 0); !errors.Is(err, ErrPairRoomClosed) {
		t.Fatalf("closed room, session gone: %v, want ErrPairRoomClosed", err)
	}
	if err := h.store.CreateStoredFile(ctx, f); !errors.Is(err, ErrPairRoomClosed) {
		t.Fatalf("closed room via the plain door: %v, want ErrPairRoomClosed", err)
	}
}
