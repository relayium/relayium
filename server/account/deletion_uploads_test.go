package account

import (
	"bytes"
	"context"
	"sort"
	"testing"

	"github.com/relayium/relayium/authx"
)

// Account deletion versus the resumable-upload tables.
//
// A chunked upload is ciphertext on disk plus a row carrying a user_id, exactly
// like a finalized stored file — it is simply one that never reached the point
// of having a file id. When an account is deleted, both have to go, and the
// blob of each has to be reclaimed or queued. The tests here are written against
// that property rather than against the delete statement that implements it.

// blobRefSet renders refs as sortable "node|key" strings, so an assertion can
// compare SETS without depending on the order a UNION happens to return.
func blobRefSet(refs []BlobRef) []string {
	out := make([]string, 0, len(refs))
	for _, r := range refs {
		out = append(out, r.NodeID+"|"+r.BlobKey)
	}
	return sortedStrings(out)
}

func sortedStrings(s []string) []string {
	sort.Strings(s)
	return s
}

// newUploadSession creates one session in the given state. state is "open",
// "done" or "unresolved"; the last two are reached through the real transitions
// (ClaimUploadDone / MarkUploadUnresolved) rather than hand-written SQL, so the
// rows are the ones production actually produces.
func newUploadSession(t *testing.T, st *SQLiteStore, id, userID, blobKey, nodeID, state string) {
	t.Helper()
	ctx := context.Background()
	row := UploadSessionRow{
		ID: id, UserID: userID, BlobKey: blobKey, NodeID: nodeID,
		Billable: nodeID == "", EncManifest: []byte("m"), TTL: 3600,
		MaxSize: 1 << 20, CreatedAt: 1000,
	}
	if ok, err := st.CreateUploadSession(ctx, row, 64); err != nil || !ok {
		t.Fatalf("create session %s: ok=%v err=%v", id, ok, err)
	}
	switch state {
	case "open":
	case "done":
		if _, _, ok, err := st.ClaimUploadDone(ctx, id, 1100); err != nil || !ok {
			t.Fatalf("claim %s done: ok=%v err=%v", id, ok, err)
		}
	case "unresolved":
		if ok, err := st.MarkUploadUnresolved(ctx, id, 1100); err != nil || !ok {
			t.Fatalf("mark %s unresolved: ok=%v err=%v", id, ok, err)
		}
	default:
		t.Fatalf("unknown session state %q", state)
	}
}

// TestPurgeTransientUserDataReclaimsEveryUploadSessionBlob is the release
// blocker's test. Before the fix, PurgeTransientUserData enumerated and deleted
// stored_files only: an account could confirm its deletion and leave behind
// partial ciphertext plus user-attributed rows for every chunked upload it had
// open, half-finished, or stuck waiting on an unreachable node — the last of
// which nothing else ever cleans up, because every automatic sweep is
// deliberately forbidden to touch the recovery state.
//
// It covers every session state and both placements, asserts the returned
// reclaim list is exactly the set of distinct blobs (so a stored file and a
// stale session naming ONE blob are handed over ONCE), and proves the purge is
// scoped to its user.
func TestPurgeTransientUserDataReclaimsEveryUploadSessionBlob(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "purge-uploads@example.com", "")
	other, _ := st.UpsertUserByEmail(ctx, "bystander@example.com", "")

	// Finalized ciphertext, central and on the user's own node.
	if err := st.CreateStoredFile(ctx, StoredFile{
		ID: authx.NewID(), UserID: u.ID, BlobKey: "sf-central", EncManifest: []byte("x"),
		Size: 1, ExpiresAt: 1 << 40, CreatedAt: 1,
	}); err != nil {
		t.Fatalf("create central stored file: %v", err)
	}
	if err := st.CreateStoredFile(ctx, StoredFile{
		ID: authx.NewID(), UserID: u.ID, BlobKey: "sf-node", NodeID: "node-1",
		EncManifest: []byte("x"), Size: 1, ExpiresAt: 1 << 40, CreatedAt: 1,
	}); err != nil {
		t.Fatalf("create node stored file: %v", err)
	}

	// One session per state, spread across central and user-node placement.
	newUploadSession(t, st, "s-open", u.ID, "up-open", "", "open")
	newUploadSession(t, st, "s-done", u.ID, "up-done", "node-1", "done")
	newUploadSession(t, st, "s-unresolved", u.ID, "up-unresolved", "node-2", "unresolved")
	// A finalize that persisted its stored_file and died before dropping its
	// session: two rows, ONE blob. It must be reclaimed exactly once — handing it
	// over twice means a second delete against a key that is already gone, which
	// on a remote node fails and lodges a permanently un-drainable entry in the
	// node-delete queue.
	newUploadSession(t, st, "s-dup", u.ID, "sf-central", "", "done")

	// The bystander's rows, which must not be touched by another user's deletion.
	if err := st.CreateStoredFile(ctx, StoredFile{
		ID: authx.NewID(), UserID: other.ID, BlobKey: "other-file", EncManifest: []byte("x"),
		Size: 1, ExpiresAt: 1 << 40, CreatedAt: 1,
	}); err != nil {
		t.Fatalf("create bystander stored file: %v", err)
	}
	newUploadSession(t, st, "s-other", other.ID, "other-upload", "", "open")

	blobs, err := st.PurgeTransientUserData(ctx, u.ID)
	if err != nil {
		t.Fatalf("purge: %v", err)
	}
	want := sortedStrings([]string{
		"|sf-central",          // central stored file, shared with s-dup — ONCE
		"|up-open",             // central, still open
		"node-1|sf-node",       // finalized on the user's own node
		"node-1|up-done",       // finalized-but-orphaned on the user's own node
		"node-2|up-unresolved", // the recovery state: evidence, but not immune
	})
	if got := blobRefSet(blobs); !equalStrings(got, want) {
		t.Fatalf("blobs to reclaim:\n got %v\nwant %v", got, want)
	}

	// Every row of the user's, gone.
	if n := countRows(t, st, `SELECT COUNT(*) FROM upload_sessions WHERE user_id=?`, u.ID); n != 0 {
		t.Fatalf("upload_sessions survived the purge: %d", n)
	}
	if files, _ := st.ListStoredFilesByUser(ctx, u.ID); len(files) != 0 {
		t.Fatalf("stored_files survived the purge: %d", len(files))
	}
	// ...and only the user's.
	if n := countRows(t, st, `SELECT COUNT(*) FROM upload_sessions WHERE user_id=?`, other.ID); n != 1 {
		t.Fatalf("bystander's upload session count = %d, want 1", n)
	}
	if files, _ := st.ListStoredFilesByUser(ctx, other.ID); len(files) != 1 {
		t.Fatalf("bystander's stored files = %d, want 1", len(files))
	}
	// The account shell is still standing (this is the soft delete, not the hard
	// purge): a regression that widened the upload_sessions delete into something
	// that took the users row with it would show up here.
	if _, err := st.GetUserByID(ctx, u.ID); err != nil {
		t.Fatalf("account shell should survive the transient purge: %v", err)
	}
}

// A session created after the enumeration but before the delete used to be
// possible because the blob list was read outside the transaction. Reading it
// inside means the two cannot interleave: whatever the delete removes is
// exactly what the caller was handed.
//
// Asserted the only way a single-process test can: the enumeration and the
// delete see the same snapshot, so no row is ever deleted without its blob
// being reported.
func TestPurgeTransientUserDataReportsEveryBlobItDeletes(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "atomic@example.com", "")
	for _, id := range []string{"a", "b", "c"} {
		newUploadSession(t, st, "s-"+id, u.ID, "blob-"+id, "", "open")
	}
	blobs, err := st.PurgeTransientUserData(ctx, u.ID)
	if err != nil {
		t.Fatalf("purge: %v", err)
	}
	if got, want := blobRefSet(blobs), sortedStrings([]string{"|blob-a", "|blob-b", "|blob-c"}); !equalStrings(got, want) {
		t.Fatalf("blobs: got %v want %v", got, want)
	}
	if n := countRows(t, st, `SELECT COUNT(*) FROM upload_sessions WHERE user_id=?`, u.ID); n != 0 {
		t.Fatalf("sessions left: %d", n)
	}
}

// The hard purge has to be correct standalone — its whole delete set is a
// deliberate superset of the confirm-time one, so that a purge which runs
// against a row the earlier pass never saw still leaves nothing behind. An
// upload session (including one in the recovery state) is no exception: leaving
// it would retain a user_id indefinitely after the account row is gone.
func TestArchiveAndPurgeUserLeavesNoUploadSessionsStandalone(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "hard-purge-uploads@example.com", "")
	newUploadSession(t, st, "hp-open", u.ID, "hp-blob-open", "", "open")
	newUploadSession(t, st, "hp-unresolved", u.ID, "hp-blob-unresolved", "node-9", "unresolved")

	// Due for the hard purge (ArchiveAndPurgeUser refuses an account that isn't).
	if err := st.SetAccountDeletion(ctx, u.ID, 100, 200); err != nil {
		t.Fatalf("schedule deletion: %v", err)
	}
	// NOTE: no PurgeTransientUserData first. That is the point of "standalone".
	if err := st.ArchiveAndPurgeUser(ctx, u.ID, 300); err != nil {
		t.Fatalf("hard purge: %v", err)
	}
	if n := countRows(t, st, `SELECT COUNT(*) FROM upload_sessions WHERE user_id=?`, u.ID); n != 0 {
		t.Fatalf("upload_sessions survived the hard purge: %d", n)
	}
	if n := countRows(t, st, `SELECT COUNT(*) FROM users WHERE id=?`, u.ID); n != 0 {
		t.Fatalf("users row survived the hard purge: %d", n)
	}
}

// confirmDeletion mints a delete token for the harness's user and confirms it,
// which is the exact path a user clicking the emailed link takes.
func (h *pairHarness) confirmDeletion(t *testing.T) {
	t.Helper()
	raw := authx.RandToken()
	if err := h.store.CreateEmailToken(context.Background(), EmailToken{
		TokenHash: authx.HashToken(raw), UserID: h.userID, Email: "sender@example.com",
		Purpose: "delete", CreatedAt: h.now, ExpiresAt: h.now + 3600,
	}); err != nil {
		t.Fatalf("mint delete token: %v", err)
	}
	if err := h.svc.ConfirmAccountDeletion(context.Background(), raw); err != nil {
		t.Fatalf("confirm deletion: %v", err)
	}
}

// sessionBlobKey reads the blob key central assigned to an upload session.
func (h *pairHarness) sessionBlobKey(t *testing.T, uploadID string) string {
	t.Helper()
	var key string
	if err := h.store.db.QueryRow(
		`SELECT blob_key FROM upload_sessions WHERE id = ?`, uploadID).Scan(&key); err != nil {
		t.Fatalf("read blob key of %s: %v", uploadID, err)
	}
	return key
}

// TestConfirmAccountDeletionDeletesPartialUploadBlobs is the end-to-end shape of
// the same blocker: real chunked uploads through the real handlers, a real blob
// store, and a real confirm. What the user is promised at this moment is that
// their data is gone — not "the finished parts of it".
//
// It deliberately includes a session in the recovery state. Its row is normally
// untouchable, and every automatic pass is written to leave it alone, so if the
// deletion path is going to be wrong anywhere it will be wrong here: the ONE
// thing that outranks keeping unresolved accounting evidence is the account
// owner asking to be deleted.
func TestConfirmAccountDeletionDeletesPartialUploadBlobs(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()

	// 1) A finished pre-upload: a stored file with a full blob.
	h.mintCode("111111", "")
	finished := bytes.Repeat([]byte("F"), 3000)
	fileID := h.preUpload(t, "111111", finished, 2)
	var storedKey string
	if err := h.store.db.QueryRow(`SELECT blob_key FROM stored_files WHERE id = ?`, fileID).Scan(&storedKey); err != nil {
		t.Fatalf("read stored blob key: %v", err)
	}

	// 2) An upload interrupted after one chunk: an OPEN session and a partial blob.
	h.mintCode("222222", "")
	status, openID, _ := h.initPairUpload(t, "222222", 3000, "")
	if status != 200 {
		t.Fatalf("init open upload: %d", status)
	}
	partial := bytes.Repeat([]byte("P"), 3000)
	if got := h.patch(t, openID, partial, 0, 1000, 3000); got != 200 {
		t.Fatalf("patch open upload: %d", got)
	}
	openKey := h.sessionBlobKey(t, openID)

	// 3) An upload whose node could not be reached when the reaper got to it:
	//    the recovery state, holding its blob as evidence.
	h.mintCode("333333", "")
	status, stuckID, _ := h.initPairUpload(t, "333333", 3000, "")
	if status != 200 {
		t.Fatalf("init stuck upload: %d", status)
	}
	if got := h.patch(t, stuckID, partial, 0, 1000, 3000); got != 200 {
		t.Fatalf("patch stuck upload: %d", got)
	}
	stuckKey := h.sessionBlobKey(t, stuckID)
	if ok, err := h.store.MarkUploadUnresolved(ctx, stuckID, h.now); err != nil || !ok {
		t.Fatalf("mark unresolved: ok=%v err=%v", ok, err)
	}

	for _, k := range []string{storedKey, openKey, stuckKey} {
		if !h.blobExists(t, k) {
			t.Fatalf("precondition: blob %s should exist before the deletion", k)
		}
	}

	h.confirmDeletion(t)

	for name, key := range map[string]string{
		"finished stored file": storedKey,
		"interrupted upload":   openKey,
		"unresolved upload":    stuckKey,
	} {
		if h.blobExists(t, key) {
			t.Fatalf("%s: ciphertext %s survived the account deletion", name, key)
		}
	}
	if n := countRows(t, h.store, `SELECT COUNT(*) FROM upload_sessions WHERE user_id=?`, h.userID); n != 0 {
		t.Fatalf("upload_sessions survived the account deletion: %d", n)
	}
	if files, _ := h.store.ListStoredFilesByUser(ctx, h.userID); len(files) != 0 {
		t.Fatalf("stored_files survived the account deletion: %d", len(files))
	}
	// Central storage was reachable throughout, so nothing should be waiting on a
	// retry: a queued delete here would mean a blob was reported but not reclaimed.
	if q, err := h.store.ListPendingNodeDeletes(ctx); err != nil || len(q) != 0 {
		t.Fatalf("pending node deletes = %v (err %v), want none", q, err)
	}
}

// When the node holding a partial blob cannot be resolved, the reclaim is queued
// rather than dropped — the same delete-or-enqueue every other blob path uses,
// so an unreachable node delays the reclaim instead of losing it. The account
// deletion itself must not be blocked by it.
func TestConfirmAccountDeletionQueuesPartialBlobsOnAnUnreachableNode(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()

	// A session placed on a node that no longer exists — a BYO node deregistered
	// (or simply unreachable) while one of its owner's uploads was in flight.
	newUploadSession(t, h.store, "ghost-session", h.userID, "ghost-blob", "ghost-node", "unresolved")

	h.confirmDeletion(t)

	if n := countRows(t, h.store, `SELECT COUNT(*) FROM upload_sessions WHERE user_id=?`, h.userID); n != 0 {
		t.Fatalf("upload_sessions survived the account deletion: %d", n)
	}
	q, err := h.store.ListPendingNodeDeletes(ctx)
	if err != nil {
		t.Fatalf("list pending node deletes: %v", err)
	}
	var found bool
	for _, p := range q {
		if p.BlobKey == "ghost-blob" && p.NodeID == "ghost-node" {
			found = true
		}
	}
	if !found {
		t.Fatalf("partial blob on an unreachable node was neither deleted nor queued: %v", q)
	}
	// The deletion still went through: an unreclaimable blob is a cleanup problem,
	// not a reason to refuse a user their deletion.
	u, err := h.store.GetUserByID(ctx, h.userID)
	if err != nil {
		t.Fatalf("read user: %v", err)
	}
	if u.DeletedAt == 0 || u.PurgeAfter <= u.DeletedAt {
		t.Fatalf("deletion should still be scheduled: %+v", u)
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
