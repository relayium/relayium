package account

// residual_provenance across upgrade, rollback and re-upgrade (see
// residualProvenance and migrateUploadResidualProvenance). The invariant under
// test: no session that existed before the upgrade, and no session an older
// binary wrote, is ever billed a residual it would not have been billed before
// — while a session this code created and can prove never became an object is.

import (
	"bytes"
	"context"
	"database/sql"
	"net/http"
	"path/filepath"
	"testing"
)

// openFileHarness is a pair harness over a SQLite FILE, opened — and so
// migrated — by this code.
func openFileHarness(t *testing.T, path string, now int64) *pairHarness {
	t.Helper()
	store, err := OpenSQLite(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	h := newPairHarnessOn(t, store)
	h.now = now
	return h
}

// closeHarness ends a phase the way a process exit would: nothing of it
// survives but the database file and the node's disk.
func closeHarness(h *pairHarness) {
	h.ts.Close()
	h.store.Close()
}

// stripResidualProvenance turns a database this code wrote into the schema the
// code before the residual rule wrote: no triggers, no indexes of its own, no
// column. Every other table and row is exactly what that code would have
// produced for the same history, because nothing before a cleanup claim, a
// purge, a refusal, a void, a settle or an account deletion behaves differently
// under the rule — and the histories built here run none of those.
func stripResidualProvenance(t *testing.T, db *sql.DB) {
	t.Helper()
	for _, q := range []string{
		`DROP TRIGGER IF EXISTS ` + residualTriggers[0],
		`DROP TRIGGER IF EXISTS ` + residualTriggers[1],
		`DROP INDEX IF EXISTS idx_upload_sessions_blob`,
		`DROP INDEX IF EXISTS idx_stored_files_blob`,
		`ALTER TABLE upload_sessions DROP COLUMN residual_provenance`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatalf("strip the residual schema (%s): %v", q, err)
		}
	}
}

func provenanceGuards(t *testing.T, db *sql.DB) int {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name IN (?, ?)`,
		residualTriggers[0], residualTriggers[1]).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func rawProvenance(t *testing.T, db *sql.DB, id string) int64 {
	t.Helper()
	var v int64
	if err := db.QueryRow(`SELECT residual_provenance FROM upload_sessions WHERE id = ?`, id).Scan(&v); err != nil {
		t.Fatalf("residual_provenance(%s): %v", id, err)
	}
	return v
}

// residualUpload is one upload for the version histories below.
type residualUpload struct {
	id, blob, fileID string
}

// placeUpload inits an upload and PATCHes `acked` bytes over HTTP, then puts
// `extra` more bytes straight onto the node's disk (the residual central never
// recorded). finalize: "http" runs the real finalize (before the residual
// lands), "crash" only its durable claim, "" leaves the upload open.
func placeUpload(t *testing.T, h *pairHarness, node *commitThenFailNode, acked, extra int, finalize string) residualUpload {
	t.Helper()
	blob := bytes.Repeat([]byte("R"), acked)
	id := initUpload(t, h.ts, h.cookie, []byte("MANIFEST"), acked, 0)
	if code, _ := patchChunk(t, h.ts, h.cookie, id, blob, 0, acked, acked); code != 200 {
		t.Fatalf("patch %s = %d", id, code)
	}
	u := residualUpload{id: id, blob: h.session(t, id).BlobKey}
	switch finalize {
	case "http":
		code, fid := h.finalize(t, id)
		if code != 200 || fid == "" {
			t.Fatalf("finalize %s = %d", id, code)
		}
		u.fileID = fid
	case "crash":
		claimDone(t, h, id)
	}
	if extra > 0 {
		if _, err := node.ds.Append(context.Background(), u.blob, int64(acked), bytes.NewReader(make([]byte, extra))); err != nil {
			t.Fatalf("residual append: %v", err)
		}
	}
	return u
}

// deleteObjectQueued deletes a stored object whose own blob delete failed: the
// row goes and the blob waits, deletion-only, in the queue.
func deleteObjectQueued(t *testing.T, h *pairHarness, u residualUpload, nodeID string) {
	t.Helper()
	ctx := context.Background()
	if err := h.store.DeleteStoredFile(ctx, u.fileID, h.now); err != nil {
		t.Fatal(err)
	}
	if err := h.store.EnqueueNodeDelete(ctx, u.blob, nodeID, h.now); err != nil {
		t.Fatal(err)
	}
}

// The upgrade: a legacy object was finalized, left 3000 late-append bytes past
// its size, and was deleted with its blob delete queued — all before the
// column existed. After the upgrade its tombstone is unknown provenance, its
// cleanup is deletion-only, and settling the queue charges nothing, although
// no stored object references the key any more.
func TestAnUpgradeNeverBillsTheResidualOfALegacyObject(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "legacy.sqlite")
	node := newCommitThenFailNode(t)

	h := openFileHarness(t, path, 1_767_312_000)
	nodeID := h.registerStorageNode(t, node.URL)
	u := placeUpload(t, h, node, 700, 3000, "http")
	deleteObjectQueued(t, h, u, nodeID)
	if got := h.uploadMetered(t); got != 700 {
		t.Fatalf("setup: metered %d, want 700", got)
	}
	now := h.now
	stripResidualProvenance(t, h.store.db)
	closeHarness(h)

	st, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if got := rawProvenance(t, st.db, u.id); got != residualUnknown {
		t.Errorf("UPGRADE: a legacy session reads provenance %d, want unknown", got)
	}
	if g := provenanceGuards(t, st.db); g != 2 {
		t.Fatalf("UPGRADE: %d provenance triggers, want 2", g)
	}
	if _, _, ok, err := st.ClaimUploadSessionCleanup(ctx, u.id, now+pendingUploadTTL+1, now+pendingUploadTTL+1); err != nil || !ok {
		t.Fatalf("cleanup claim: ok=%v err=%v", ok, err)
	}
	charged, err := st.SettleBlobBilling(ctx, u.blob, nodeID, 3700, now)
	if err != nil {
		t.Fatal(err)
	}
	if charged != 0 {
		t.Fatalf("RETROCHARGE: the upgrade charged %d residual bytes for an object a legacy finalize had committed and then deleted; want 0", charged)
	}
}

// old -> new -> old -> new on ONE database file and ONE node disk. The "old
// binary" phases are the statements the code before the residual rule issues,
// run on a plain connection that knows nothing of the column: its finalize
// inserts a stored_files row, its upload insert names the old column list, and
// its cleanup claim queues deletion-only. After the re-upgrade, the real reaper
// and the real GC sweep charge exactly one residual — the one upload this code
// created and can prove never became an object — and nothing historical.
func TestResidualProvenanceSurvivesRollbackAndReupgrade(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "relayium.sqlite")
	node := newCommitThenFailNode(t)
	start := int64(1_767_312_000)
	u := map[string]residualUpload{}

	// O1 — the old binary's history.
	h := openFileHarness(t, path, start)
	nodeID := h.registerStorageNode(t, node.URL)
	a0 := placeUpload(t, h, node, 700, 3000, "http") // finalized, residual, deleted
	deleteObjectQueued(t, h, a0, nodeID)
	u["A0"] = a0
	u["A"] = placeUpload(t, h, node, 700, 3000, "http")   // live object at the upgrade
	u["B"] = placeUpload(t, h, node, 700, 0, "")          // open at the upgrade
	u["C"] = placeUpload(t, h, node, 1200, 3000, "crash") // legacy crashed orphan
	u["Q"] = placeUpload(t, h, node, 1200, 3000, "")      // legacy open, refused later
	stripResidualProvenance(t, h.store.db)
	closeHarness(h)

	// N1 — the upgrade.
	h = openFileHarness(t, path, start)
	if g := provenanceGuards(t, h.store.db); g != 2 {
		t.Fatalf("UPGRADE: %d provenance triggers, want 2", g)
	}
	for k, want := range map[string]int64{"A0": residualUnknown, "A": residualPersisted, "B": residualUnknown, "C": residualUnknown, "Q": residualUnknown} {
		if got := h.provenanceOf(t, u[k].id); got != want {
			t.Errorf("UPGRADE: %s provenance %d, want %d", k, got, want)
		}
	}
	deleteObjectQueued(t, h, u["A"], nodeID)
	u["D"] = placeUpload(t, h, node, 700, 0, "")          // new, open; the OLD binary finalizes it
	u["E"] = placeUpload(t, h, node, 1200, 3000, "crash") // new crashed orphan: the one residual owed
	f := placeUpload(t, h, node, 700, 3000, "http")       // new, finalized, residual, deleted
	deleteObjectQueued(t, h, f, nodeID)
	u["F"] = f
	u["H"] = placeUpload(t, h, node, 1200, 3000, "crash") // new crashed orphan; the OLD binary claims it
	u["P"] = placeUpload(t, h, node, 1200, 3000, "")      // new, open, refused later
	for k, want := range map[string]int64{"D": residualFresh, "E": residualFresh, "F": residualPersisted, "H": residualFresh, "P": residualFresh} {
		if got := h.provenanceOf(t, u[k].id); got != want {
			t.Errorf("NEW: %s provenance %d, want %d", k, got, want)
		}
	}
	userID := h.userID
	closeHarness(h)

	// O2 — rollback: the old binary writes to the migrated file.
	old, err := sql.Open("sqlite", withPragmas(path, connPragmas...))
	if err != nil {
		t.Fatal(err)
	}
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := old.Exec(q, args...); err != nil {
			t.Fatalf("old binary: %s: %v", q, err)
		}
	}
	for i, k := range []string{"B", "D"} {
		// Its finalize: the terminal claim, then the object insert — which fires
		// the trigger in the database, whatever binary issues it.
		exec(`UPDATE upload_sessions SET done = 1, last_activity = ? WHERE id = ? AND done = 0`, start, u[k].id)
		fid := "old-file-" + k
		exec(`INSERT INTO stored_files (id, user_id, blob_key, enc_manifest, size, created_at, expires_at, node_id)
		      VALUES (?, ?, ?, x'00', 700, ?, ?, ?)`, fid, userID, u[k].blob, start+int64(i), start+3600, nodeID)
		if got := rawProvenance(t, old, u[k].id); got != residualPersisted {
			t.Errorf("ROLLBACK: the old binary's finalize of %s left provenance %d, want persisted (the trigger)", k, got)
		}
		if _, err := node.ds.Append(ctx, u[k].blob, 700, bytes.NewReader(make([]byte, 3000))); err != nil {
			t.Fatal(err)
		}
		exec(`DELETE FROM stored_files WHERE id = ?`, fid)
		exec(`INSERT INTO pending_node_deletes (blob_key, node_id, enqueued_at, not_before) VALUES (?, ?, ?, 0)
		      ON CONFLICT(blob_key, node_id) DO UPDATE SET not_before = max(pending_node_deletes.not_before, excluded.not_before)`,
			u[k].blob, nodeID, start)
	}
	// Its upload insert: the old column list, so the row takes the DEFAULT.
	g := residualUpload{id: "old-upload-G", blob: "old-blob-G"}
	exec(`INSERT INTO upload_sessions (`+uploadSessionCols+`)
	      VALUES (?, ?, ?, ?, 1, x'00', 3600, 0, ?, 1200, ?, 1, 'share', '', 1200, 0)`,
		g.id, userID, g.blob, nodeID, int64(1<<20), start)
	if _, err := node.ds.Append(ctx, g.blob, 0, bytes.NewReader(make([]byte, 4200))); err != nil {
		t.Fatal(err)
	}
	u["G"] = g
	if got := rawProvenance(t, old, g.id); got != residualUnknown {
		t.Errorf("ROLLBACK: the old binary's insert got provenance %d, want unknown (DEFAULT)", got)
	}
	// Its cleanup claim of a new crashed orphan: deletion-only, so that
	// residual goes unbilled (an under-bill, never a charge).
	exec(`INSERT INTO pending_node_deletes (blob_key, node_id, enqueued_at, not_before) VALUES (?, ?, ?, 0)
	      ON CONFLICT(blob_key, node_id) DO UPDATE SET not_before = max(pending_node_deletes.not_before, excluded.not_before)`,
		u["H"].blob, nodeID, start)
	exec(`DELETE FROM upload_sessions WHERE id = ?`, u["H"].id)
	if err := old.Close(); err != nil {
		t.Fatal(err)
	}

	// N2 — re-upgrade: refusals, the real reaper, the real GC sweep.
	h = openFileHarness(t, path, start)
	defer closeHarness(h)
	if g := provenanceGuards(t, h.store.db); g != 2 {
		t.Fatalf("RE-UPGRADE: %d provenance triggers, want 2", g)
	}
	want := map[string]int64{
		"A0": residualUnknown, "A": residualPersisted, "B": residualPersisted, "C": residualUnknown,
		"D": residualPersisted, "E": residualFresh, "F": residualPersisted, "G": residualUnknown,
		"P": residualFresh, "Q": residualUnknown,
	}
	for k, w := range want {
		if got := h.provenanceOf(t, u[k].id); got != w {
			t.Errorf("RE-UPGRADE: %s provenance %d, want %d", k, got, w)
		}
	}
	// Over the 64 MiB daily quota, leaving room under the reservation's own
	// 1 TiB ceiling for the debits the finalizes above already wrote.
	h.spendDailyQuota(t, 1<<30)
	for _, c := range []struct {
		k    string
		owed int64
	}{{"Q", 0}, {"P", 3000}} {
		before := h.uploadMetered(t)
		if code, _ := h.finalize(t, u[c.k].id); code != http.StatusTooManyRequests {
			t.Fatalf("setup: refused finalize %s = %d, want 429", c.k, code)
		}
		if d := h.uploadMetered(t) - before; d != c.owed {
			t.Errorf("REFUSAL: %s's refused finalize billed %d, want %d", c.k, d, c.owed)
		}
		if got := nodeBlobSize(t, node.dir, u[c.k].blob); got != 0 {
			t.Errorf("REFUSAL: %s's blob still holds %d bytes after the refusal", c.k, got)
		}
		if retry, _ := h.finalize(t, u[c.k].id); retry != http.StatusConflict {
			t.Errorf("TOMBSTONE: %s's retry answered %d, want 409", c.k, retry)
		}
	}
	cleaned := []string{"A0", "A", "B", "C", "D", "E", "F", "G"}
	for _, k := range cleaned {
		if got := nodeBlobSize(t, node.dir, u[k].blob); got <= 0 {
			t.Fatalf("setup: %s's blob is missing before cleanup", k)
		}
	}
	h.advance(pendingUploadTTL + 60)
	h.svc.ReapPendingUploads(h.now)
	for _, k := range cleaned {
		if h.sessionExists(t, u[k].id) {
			t.Errorf("CLEANUP: the reaper did not claim %s", k)
		}
		q := queuedFor(t, h, u[k].blob)
		if len(q) != 1 {
			t.Errorf("CLEANUP: %s's blob is queued %+v, want one row", k, q)
			continue
		}
		if k == "E" {
			if q[0].BillUserID != userID || q[0].BilledThrough != 1200 {
				t.Errorf("OWNERSHIP: the fresh orphan E is queued %+v, want an obligation at floor 1200", q[0])
			}
		} else if q[0].BillUserID != "" {
			t.Errorf("RETROCHARGE: %s is queued with an obligation %+v, want deletion-only", k, q[0])
		}
	}
	before := h.uploadMetered(t)
	gcSweep(h)
	charged := h.uploadMetered(t) - before
	if charged != 3000 {
		t.Errorf("RESIDUAL: the sweep charged %d, want exactly E's 3000", charged)
	}
	for _, k := range []string{"A0", "A", "B", "C", "D", "E", "F", "G", "H", "P", "Q"} {
		if got := nodeBlobSize(t, node.dir, u[k].blob); got != 0 {
			t.Errorf("CLEANUP: %s's blob still holds %d bytes after the drain", k, got)
		}
	}
	h.svc.ReapPendingUploads(h.now + 60)
	gcSweep(h)
	if again := h.uploadMetered(t) - before; again != charged {
		t.Errorf("IDEMPOTENCE: a second reap and sweep moved the meter from %d to %d", charged, again)
	}
}

// A provenance trigger missing on reopen (a manual schema rollback) demotes
// every fresh marker to unknown — it can only remove a residual bill — and
// recreates the trigger; persisted is positive evidence and is kept.
func TestAMissingProvenanceGuardDemotesFreshToUnknown(t *testing.T) {
	path := filepath.Join(t.TempDir(), "guard.sqlite")
	node := newCommitThenFailNode(t)
	h := openFileHarness(t, path, 1_767_312_000)
	h.registerStorageNode(t, node.URL)
	open := placeUpload(t, h, node, 700, 0, "")
	done := placeUpload(t, h, node, 700, 0, "http")
	if v, w := h.provenanceOf(t, open.id), h.provenanceOf(t, done.id); v != residualFresh || w != residualPersisted {
		t.Fatalf("setup: provenance open=%d done=%d", v, w)
	}
	if _, err := h.store.db.Exec(`DROP TRIGGER ` + residualTriggers[0]); err != nil {
		t.Fatal(err)
	}
	closeHarness(h)
	st, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if v, w, g := rawProvenance(t, st.db, open.id), rawProvenance(t, st.db, done.id), provenanceGuards(t, st.db); v != residualUnknown || w != residualPersisted || g != 2 {
		t.Fatalf("GUARD LOSS: fresh=%d persisted=%d triggers=%d after reopen, want %d, %d, 2", v, w, g, residualUnknown, residualPersisted)
	}
}

// A session created for a key a stored object already names is persisted from
// its first statement, never fresh.
func TestASessionOnAReferencedKeyIsNeverFresh(t *testing.T) {
	ctx := context.Background()
	st := newTestStore(t)
	u, _ := st.UpsertUserByEmail(ctx, "prov@example.com", "P")
	if err := st.CreateStoredFile(ctx, StoredFile{ID: "f", UserID: u.ID, BlobKey: "blob-dup",
		EncManifest: []byte("m"), Size: 10, CreatedAt: 100, ExpiresAt: 1 << 40}); err != nil {
		t.Fatal(err)
	}
	row := mkUploadRow("dup", u.ID)
	row.BlobKey = "blob-dup"
	if ok, err := st.CreateUploadSession(ctx, row, 10); err != nil || !ok {
		t.Fatalf("create: ok=%v err=%v", ok, err)
	}
	fresh := mkUploadRow("fresh", u.ID)
	if ok, err := st.CreateUploadSession(ctx, fresh, 10); err != nil || !ok {
		t.Fatalf("create: ok=%v err=%v", ok, err)
	}
	if got := rawProvenance(t, st.db, "dup"); got != residualPersisted {
		t.Errorf("a session on a referenced key reads %d, want persisted", got)
	}
	if got := rawProvenance(t, st.db, "fresh"); got != residualFresh {
		t.Errorf("a session on a fresh key reads %d, want fresh", got)
	}
}

// The trigger runs inside the stored_files INSERT, so anything written in the
// same transaction — here, the durable session->file link a later change adds,
// emulated with its compare-and-set — commits or rolls back together with the
// provenance: a failed insert leaves neither.
func TestProvenanceCommitsAndRollsBackWithTheObjectInsert(t *testing.T) {
	ctx := context.Background()
	h := newPairHarness(t)
	node := newCommitThenFailNode(t)
	h.registerStorageNode(t, node.URL)
	id := initUpload(t, h.ts, h.cookie, []byte("MANIFEST"), 10, 0)
	if _, err := h.store.db.Exec(`ALTER TABLE upload_sessions ADD COLUMN finalized_file_id TEXT NOT NULL DEFAULT ''`); err != nil {
		t.Fatal(err)
	}
	claimDone(t, h, id)
	sess := h.session(t, id)
	for _, commit := range []bool{false, true} {
		tx, err := h.store.db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(`INSERT INTO stored_files (id, user_id, blob_key, enc_manifest, size, created_at, expires_at)
		                      VALUES ('f-linked', ?, ?, x'00', 0, ?, ?)`, h.userID, sess.BlobKey, h.now, h.now+60); err != nil {
			t.Fatal(err)
		}
		res, err := tx.Exec(`UPDATE upload_sessions SET finalized_file_id = 'f-linked'
		                      WHERE id = ? AND user_id = ? AND done = 1 AND finalized_file_id = ''`, id, h.userID)
		if err != nil {
			t.Fatal(err)
		}
		if n, _ := res.RowsAffected(); n != 1 {
			t.Fatalf("the link's compare-and-set affected %d rows", n)
		}
		if commit {
			if err := tx.Commit(); err != nil {
				t.Fatal(err)
			}
		} else {
			_ = tx.Rollback()
		}
		var link string
		if err := h.store.db.QueryRow(`SELECT finalized_file_id FROM upload_sessions WHERE id = ?`, id).Scan(&link); err != nil {
			t.Fatal(err)
		}
		p := h.provenanceOf(t, id)
		if commit && (link != "f-linked" || p != residualPersisted) {
			t.Errorf("COMMIT: link=%q provenance=%d, want f-linked/persisted", link, p)
		}
		if !commit && (link != "" || p != residualFresh) {
			t.Errorf("ROLLBACK: link=%q provenance=%d, want ''/fresh (a failed insert leaves neither)", link, p)
		}
	}
}
