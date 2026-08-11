package account

import (
	"bytes"
	"context"
	"io"
	"log"
	"testing"
)

// What a voided room takes with it.
//
// "Void means gone, now" was implemented for the ciphertext the room had
// FINISHED receiving — the finalized stored_files rows — and for nothing else.
// A pre-upload that was still in flight when the deadline passed left its
// partial blob and its upload session on disk until the generic one-hour
// reaper noticed, which is twelve times the window the room itself promised.
// The bytes are the same bytes: encrypted content the sender uploaded for a
// receiver who never came, held long past the deadline the whole feature is
// built around.
//
// Every test here fails if the room-void stops reclaiming an unfinished upload.

// The headline: no reaper, no GC of any other kind — the room's own void takes
// the partial blob and its session.
func TestATimedOutRoomReclaimsItsPartialUploadWithoutWaitingForTheReaper(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("616161", "")
	blob := bytes.Repeat([]byte("U"), 4096)
	status, uploadID, _ := h.initPairUpload(t, "616161", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	if got := h.patch(t, uploadID, blob, 0, 2048, len(blob)); got != 200 {
		t.Fatalf("patch: %d", got)
	}
	key := h.session(t, uploadID).BlobKey
	if !h.blobExists(t, key) {
		t.Fatal("the partial blob should exist while the room is open")
	}
	billed := h.uploadMetered(t)
	if billed != 2048 {
		t.Fatalf("billed %d for the chunk that landed, want 2048", billed)
	}

	// Nobody joins. One sweep, and nothing else: no ReapPendingUploads.
	h.advance(pairRoomJoinWindow + 1)
	h.svc.SweepPairRooms(context.Background(), h.now)

	if h.blobExists(t, key) {
		t.Fatal("a timed-out room left its partial ciphertext on disk for the one-hour reaper")
	}
	if h.sessionExists(t, uploadID) {
		t.Fatal("a timed-out room left its upload session behind, so the blob could still be appended to")
	}
	// The bytes that moved stay billed. Reclaiming ciphertext is not a refund.
	if got := h.uploadMetered(t); got != billed {
		t.Fatalf("billed %d after the void, want the %d bytes that actually crossed the wire", got, billed)
	}
}

// The same thing from the read path, which is the one that matters most: the
// first request after the deadline is what makes expiry true, and it must be
// true for the unfinished upload as well as for the finished object.
func TestAReadAfterTheDeadlineReclaimsAnUnfinishedUploadToo(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("626262", "")
	// One finished object and one upload still in flight, in the same room.
	id := h.preUpload(t, "626262", bytes.Repeat([]byte("F"), 1024), 1)
	blob := bytes.Repeat([]byte("P"), 4096)
	status, uploadID, _ := h.initPairUpload(t, "626262", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	if got := h.patch(t, uploadID, blob, 0, 2048, len(blob)); got != 200 {
		t.Fatalf("patch: %d", got)
	}
	partial := h.session(t, uploadID).BlobKey

	h.advance(pairRoomJoinWindow + 1)
	if status, _ := h.getAnon(t, "/api/files/"+id+"/meta"); status != 404 {
		t.Fatalf("meta after the deadline = %d, want 404", status)
	}
	if h.blobExists(t, partial) {
		t.Fatal("the read voided the room's finished object but left its half-uploaded one")
	}
	if h.sessionExists(t, uploadID) {
		t.Fatal("the half-uploaded session survived the void")
	}
}

// Storage and the account's upload-session budget are freed by the void itself,
// from the authoritative database state — not eventually, by a sweep.
func TestAVoidFreesStorageAndTheUploadSlotAtOnce(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	h.mintCode("636363", "")
	h.preUpload(t, "636363", bytes.Repeat([]byte("S"), 2048), 1)
	blob := bytes.Repeat([]byte("Q"), 4096)
	status, uploadID, _ := h.initPairUpload(t, "636363", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	if got := h.patch(t, uploadID, blob, 0, 2048, len(blob)); got != 200 {
		t.Fatalf("patch: %d", got)
	}

	h.advance(pairRoomJoinWindow + 1)
	h.svc.SweepPairRooms(ctx, h.now)

	used, err := h.store.CurrentStorage(ctx, h.userID, h.now)
	if err != nil {
		t.Fatalf("storage: %v", err)
	}
	if used != 0 {
		t.Fatalf("CurrentStorage = %d after the room was voided, want 0 — a timed-out transfer holds no quota", used)
	}
	// maxPerUser=1 succeeds only if the reclaimed session no longer counts as open.
	ok, err := h.store.CreateUploadSession(ctx, UploadSessionRow{
		ID: "probe-session", UserID: h.userID, BlobKey: "probe-key", CreatedAt: h.now,
	}, 1)
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if !ok {
		t.Fatal("the voided room's upload session is still occupying one of the account's open-session slots")
	}
}

// "As far as physically knowable" — the void asks the blob how big it really is
// BEFORE deleting it, because deleting it destroys the answer. A node that
// committed bytes and died before it could say so is the ordinary way for the
// database's offset to be a lower bound.
func TestATimedOutRoomBillsWhatItsBlobReallyHoldsBeforeDroppingIt(t *testing.T) {
	h := newPairHarness(t)
	uploadID, node, known, onNode := unreachableAfterCommit(t, h, "646464")
	sess := h.session(t, uploadID)
	if onNode <= known {
		t.Fatalf("the fixture did not stage unrecorded bytes: node %d, known %d", onNode, known)
	}
	// The node comes back before the room's deadline passes, so the exact size IS
	// knowable at void time.
	node.failProbe.Store(false)
	node.failAfterCommit.Store(false)

	h.advance(pairRoomJoinWindow + 1)
	h.svc.SweepPairRooms(context.Background(), h.now)

	if got := h.uploadMetered(t); got != onNode {
		t.Fatalf("billed %d, want the %d bytes the blob really held — %d bytes were deleted without being charged",
			got, onNode, onNode-got)
	}
	if got := nodeBlobSize(t, node.dir, sess.BlobKey); got != 0 {
		t.Fatalf("the partial blob still holds %d bytes after its room was voided", got)
	}
	if h.sessionExists(t, uploadID) {
		t.Fatal("the settled session was left behind")
	}
}

// The impossible case, and the one place this lifecycle deliberately gives up
// accounting evidence.
//
// A node that cannot be reached at all cannot say how many bytes it holds, and
// the ordinary reaper answers that by keeping the row and the blob FOREVER as
// evidence (uploads_resumable.go, the recovery state). A room whose deadline
// passed cannot afford that answer: the owner's rule is that timed-out
// ciphertext is deleted, and "we are holding your encrypted file indefinitely
// because a machine of ours is offline" is not a deletion. So the precedence
// inverts here, exactly as it does for account deletion: what is known stays
// billed, the blob is queued for deletion, the session and its binding to the
// room stop existing, and the unknown residual is written off.
func TestATimedOutRoomWritesOffOnlyWhatAnUnreachableNodeCannotConfirm(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	uploadID, node, known, onNode := unreachableAfterCommit(t, h, "656565")
	sess := h.session(t, uploadID)
	// Gone, not merely lying: the node answers nothing at all, so neither the
	// probe nor the delete can reach the bytes.
	node.Server.Close()

	h.advance(pairRoomJoinWindow + 1)
	h.svc.SweepPairRooms(ctx, h.now)

	if got := h.uploadMetered(t); got != known {
		t.Fatalf("billed %d, want the %d bytes the node acknowledged — an unreachable node is not a licence to invent a number",
			got, known)
	}
	if h.sessionExists(t, uploadID) {
		t.Fatalf("the session for a timed-out room survived as accounting evidence; the deadline outranks the %d unknown bytes",
			onNode-known)
	}
	pending, err := h.store.ListPendingNodeDeletes(ctx)
	if err != nil {
		t.Fatalf("pending deletes: %v", err)
	}
	var queued bool
	for _, p := range pending {
		if p.BlobKey == sess.BlobKey {
			queued = true
		}
	}
	if !queued {
		t.Fatal("the unreachable node's partial blob was not queued for deletion — nothing would ever reclaim it")
	}
	// The ciphertext really is still on the node's disk. That is the honest state
	// of this case: unreachable is unreachable. What matters is that nothing
	// central holds still points at it, the queue keeps trying, and the account
	// was not charged for a number nobody could confirm.
	if got := nodeBlobSize(t, node.dir, sess.BlobKey); got != onNode {
		t.Fatalf("the offline node's blob is %d bytes, want the %d it committed", got, onNode)
	}
}

// The pending-join hold covers the whole room, not just its finished objects. A
// join the server SAW but could not write down is the reason a room survives its
// stale deadline; an upload still running inside that room must survive it too,
// or the receiver arrives to a batch with a hole in it.
func TestAHeldJoinKeepsAnUnfinishedUploadAlive(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("676767", "")
	blob := bytes.Repeat([]byte("J"), 4096)
	status, uploadID, _ := h.initPairUpload(t, "676767", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	if got := h.patch(t, uploadID, blob, 0, 2048, len(blob)); got != 200 {
		t.Fatalf("patch: %d", got)
	}
	key := h.session(t, uploadID).BlobKey

	// The server observed a join inside the window and could not persist it.
	h.svc.pairJoins.hold(observedJoin{code: "676767", observedAt: h.now, roomID: h.roomFor(t, "676767").ID})

	h.advance(pairRoomJoinWindow + 1)
	h.svc.SweepPairRooms(context.Background(), h.now)

	if !h.blobExists(t, key) {
		t.Fatal("a held join must stop the void, including the partial blob of an upload still running")
	}
	if !h.sessionExists(t, uploadID) {
		t.Fatal("the upload session was reclaimed on a deadline the observed join had already ended")
	}
}

// After the void there is nothing left to append to. The session is gone, so the
// blob cannot be recreated through the API at all — and nothing is billed twice
// for trying.
func TestAnAppendAfterTheVoidCannotResurrectTheUpload(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("686868", "")
	blob := bytes.Repeat([]byte("A"), 4096)
	status, uploadID, _ := h.initPairUpload(t, "686868", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	if got := h.patch(t, uploadID, blob, 0, 2048, len(blob)); got != 200 {
		t.Fatalf("patch: %d", got)
	}
	key := h.session(t, uploadID).BlobKey
	billed := h.uploadMetered(t)

	h.advance(pairRoomJoinWindow + 1)
	h.svc.SweepPairRooms(context.Background(), h.now)

	if got := h.patch(t, uploadID, blob, 2048, 4096, len(blob)); got != 404 {
		t.Fatalf("append after the void = %d, want 404 — there is no session to append to", got)
	}
	if h.blobExists(t, key) {
		t.Fatal("a refused append recreated the reclaimed blob")
	}
	if got := h.uploadMetered(t); got != billed {
		t.Fatalf("billed %d after a refused append, want %d — a refusal that writes nothing bills nothing", got, billed)
	}
	if status, _ := h.finalize(t, uploadID); status != 404 {
		t.Fatalf("finalize after the void = %d, want 404", status)
	}
}

// An append that is ALREADY in flight when the room closes is the one case the
// void cannot pre-empt. It must not be billed twice, must not be told it
// succeeded, and whatever it manages to commit is bounded by the append cap the
// resumable path already enforces.
func TestAnAppendInFlightWhenTheRoomClosesIsRefusedAndNeverDoubleBilled(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("696969", "")
	blob := bytes.Repeat([]byte("I"), 4096)
	status, uploadID, _ := h.initPairUpload(t, "696969", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	if got := h.patch(t, uploadID, blob, 0, 1024, len(blob)); got != 200 {
		t.Fatalf("first chunk: %d", got)
	}
	sess := h.session(t, uploadID)

	// The room is voided — session claimed, blob dropped, row gone — and only
	// THEN does the in-flight append's commit reach the store. That is the exact
	// interleaving; running it through the store is the only way to hold it.
	h.advance(pairRoomJoinWindow + 1)
	h.svc.SweepPairRooms(context.Background(), h.now)
	billed := h.uploadMetered(t)

	res, err := h.store.CommitUploadProgress(context.Background(), UploadProgress{
		SessionID: sess.ID, UserID: h.userID, Committed: 4096, Billable: true, Now: h.now,
		RoomID: sess.PairRoomID, RoomExpiry: h.now + pairRoomJoinWindow,
	})
	if err != nil {
		t.Fatalf("commit: %v", err)
	}
	if res.RoomOpen {
		t.Fatal("a commit into a closed room must never report the room open — the client would be told its bytes bought a deadline")
	}
	if got := h.uploadMetered(t); got != billed {
		t.Fatalf("billed %d for bytes committed to a reclaimed session, want %d", got, billed)
	}
}

// Two voids can race — a request and the sweep, two requests, two instances —
// and the artifact list must be handed out exactly once. The close is what
// arbitrates, for the unfinished uploads exactly as for the finished objects:
// whoever loses gets an empty closure and reclaims nothing, so no blob is
// deleted twice and no bogus pending-delete is queued for a key that is already
// gone.
func TestClosingARoomTwiceHandsOutItsArtifactsOnlyOnce(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	h.mintCode("727272", "")
	h.preUpload(t, "727272", bytes.Repeat([]byte("1"), 1024), 1)
	blob := bytes.Repeat([]byte("2"), 4096)
	status, uploadID, _ := h.initPairUpload(t, "727272", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	if got := h.patch(t, uploadID, blob, 0, 2048, len(blob)); got != 200 {
		t.Fatalf("patch: %d", got)
	}
	roomID := h.roomFor(t, "727272").ID

	first, err := h.store.ClosePairRoom(ctx, roomID, h.now, h.now+pairRoomBlobHold)
	if err != nil {
		t.Fatalf("close: %v", err)
	}
	if len(first.Objects) != 1 || len(first.Sessions) != 1 {
		t.Fatalf("first close returned %d object(s) and %d session(s), want 1 and 1",
			len(first.Objects), len(first.Sessions))
	}
	second, err := h.store.ClosePairRoom(ctx, roomID, h.now, h.now+pairRoomBlobHold)
	if err != nil {
		t.Fatalf("second close: %v", err)
	}
	if len(second.Objects) != 0 || len(second.Sessions) != 0 {
		t.Fatalf("a second close handed out %d object(s) and %d session(s); two voids would each reclaim them",
			len(second.Objects), len(second.Sessions))
	}
}

// A TERMINALLY CLAIMED session is taken too, and this is the case that used to
// be excepted.
//
// The exception's argument was that a claimed session belongs to a finalize
// between its claim and its insert, which cannot succeed (the insert carries the
// room's open-ness) and will drop this same blob on its way to a 410 — so the
// void could step aside and let it. The argument is only as good as the finalize
// coming back. One that CRASHES holding the claim never does, and the exception
// then left the account's session row and the sender's ciphertext alive until the
// generic one-hour reaper: twelve times the window the room promised, for a
// transfer that is void, decided by a process that no longer exists.
//
// Timeout privacy outranks letting a finalize keep ownership. A finalize that IS
// still running fails safely on the room's precondition and tolerates finding the
// blob already gone (blob deletion is idempotent), which is a strictly cheaper
// price than the crash case's.
func TestTheVoidTakesASessionATerminalClaimAlreadyOwns(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	h.mintCode("717171", "")
	blob := bytes.Repeat([]byte("C"), 4096)
	status, uploadID, _ := h.initPairUpload(t, "717171", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	if got := h.patch(t, uploadID, blob, 0, 2048, len(blob)); got != 200 {
		t.Fatalf("patch: %d", got)
	}
	sess := h.session(t, uploadID)
	// A finalize claims the session terminally... and never comes back. Nothing
	// below simulates its return: this is the crash.
	if _, _, ok, err := h.store.ClaimUploadDone(ctx, sess.ID, h.now); err != nil || !ok {
		t.Fatalf("claim: %v %v", ok, err)
	}
	billed := h.uploadMetered(t)

	// The room times out. One sweep, and nothing else: no ReapPendingUploads, no
	// GC drain. Everything asserted below is the timeout's own work.
	h.advance(pairRoomJoinWindow + 1)
	h.svc.SweepPairRooms(ctx, h.now)

	if h.sessionExists(t, uploadID) {
		t.Fatal("a terminally claimed session survived its room's timeout, waiting on a finalize that crashed")
	}
	// The account's open-session budget is free at once — maxPerUser=1 succeeds
	// only if nothing of this upload is left occupying it.
	ok, err := h.store.CreateUploadSession(ctx, UploadSessionRow{
		ID: "probe-session", UserID: h.userID, BlobKey: "probe-key", CreatedAt: h.now,
	}, 1)
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if !ok {
		t.Fatal("a crashed finalize's session is still holding one of the account's open-session slots")
	}
	if h.blobExists(t, sess.BlobKey) {
		t.Fatal("the ciphertext of a crashed finalize's upload survived its room's timeout")
	}
	// ...and deletion is ESTABLISHED, not merely done: the intent that outlives
	// this process is on disk, so a node that had been unreachable — or an append
	// that re-creates the key a moment from now — still has an owner.
	assertQueuedForDeletion(t, h, sess.BlobKey)
	// The bytes that moved stay billed. Reclaiming ciphertext is not a refund.
	if got := h.uploadMetered(t); got != billed {
		t.Fatalf("billed %d after the void, want the %d bytes that crossed the wire", got, billed)
	}
}

// The same crash, with the node unreachable as well: nothing can be deleted at
// all, and the durable responsibility has to carry the whole weight. The row and
// the slot still go immediately — the deadline's promise does not depend on a
// machine of ours being up.
func TestACrashedFinalizeOnAnUnreachableNodeStillLosesItsRowAndKeepsAnOwner(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	uploadID, node, known, _ := unreachableAfterCommit(t, h, "737373")
	sess := h.session(t, uploadID)
	if _, _, ok, err := h.store.ClaimUploadDone(ctx, sess.ID, h.now); err != nil || !ok {
		t.Fatalf("claim: %v %v", ok, err)
	}
	node.Server.Close() // and now nothing can reach it, to probe or to delete

	h.advance(pairRoomJoinWindow + 1)
	h.svc.SweepPairRooms(ctx, h.now)

	if h.sessionExists(t, uploadID) {
		t.Fatal("an unreachable node kept a voided room's session row alive")
	}
	assertQueuedForDeletion(t, h, sess.BlobKey)
	if got := h.uploadMetered(t); got != known {
		t.Fatalf("billed %d, want the %d bytes the node acknowledged", got, known)
	}
}

// The retirement rule, which is the other half of "queued for deletion" meaning
// anything. A delete intent a room's void raised is NOT discharged by the first
// successful delete: an append that read the session row before the close can
// still be streaming, and it will re-create the key afterwards. GC keeps asking
// for the length of the hold, and only a success taken at or after it retires
// the row — which is also what stops the queue growing without bound.
func TestARoomVoidsDeleteIntentIsHeldUntilNoAppendCanStillLand(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	h.mintCode("747474", "")
	blob := bytes.Repeat([]byte("H"), 4096)
	status, uploadID, _ := h.initPairUpload(t, "747474", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	if got := h.patch(t, uploadID, blob, 0, 2048, len(blob)); got != 200 {
		t.Fatalf("patch: %d", got)
	}
	key := h.session(t, uploadID).BlobKey

	h.advance(pairRoomJoinWindow + 1)
	voidedAt := h.now
	h.svc.SweepPairRooms(ctx, h.now)
	if h.blobExists(t, key) {
		t.Fatal("the void did not delete the blob")
	}

	gc := func(now int64) *GC {
		return &GC{Store: h.store, Blobs: h.disk, Now: func() int64 { return now },
			Log: log.New(io.Discard, "", 0)}
	}
	// A sweep inside the hold deletes again (idempotently) and keeps the row.
	gc(voidedAt + 60).drainPending(ctx)
	assertQueuedForDeletion(t, h, key)

	// Now the thing the hold exists for: a blob re-appears on the node after the
	// void's own delete, exactly as an append that was in flight would leave it.
	if _, err := h.disk.Append(ctx, key, 0, bytes.NewReader(blob)); err != nil {
		t.Fatalf("re-create the blob: %v", err)
	}
	gc(voidedAt + 120).drainPending(ctx)
	if h.blobExists(t, key) {
		t.Fatal("a blob re-created after the void's delete survived — the queued responsibility never came back for it")
	}

	// Past the hold, one more success and the row is retired: an intent is not
	// immortal.
	gc(voidedAt + pairRoomBlobHold).drainPending(ctx)
	if queuedForDeletion(t, h, key) {
		t.Fatal("the delete intent was never retired, so the queue grows forever")
	}
}

// queuedForDeletion reports whether GC holds durable responsibility for this
// blob: a pending_node_deletes row it will keep retrying until it lands.
func queuedForDeletion(t *testing.T, h *pairHarness, blobKey string) bool {
	t.Helper()
	pending, err := h.store.ListPendingNodeDeletes(context.Background())
	if err != nil {
		t.Fatalf("pending deletes: %v", err)
	}
	for _, p := range pending {
		if p.BlobKey == blobKey {
			return true
		}
	}
	return false
}

func assertQueuedForDeletion(t *testing.T, h *pairHarness, blobKey string) {
	t.Helper()
	if !queuedForDeletion(t, h, blobKey) {
		t.Fatalf("blob %s has no durable delete responsibility: nothing would ever reclaim it if this process died now", blobKey)
	}
}

// A session that is claimed but whose room is still OPEN is a different story:
// the reaper or a finalize got there first, and the answer is about the session,
// not the room. This is the guard above not over-reaching.
func TestACommitForAClaimedSessionInALiveRoomStillReportsTheRoomOpen(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	h.mintCode("707070", "")
	blob := bytes.Repeat([]byte("O"), 4096)
	status, uploadID, _ := h.initPairUpload(t, "707070", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	if got := h.patch(t, uploadID, blob, 0, 1024, len(blob)); got != 200 {
		t.Fatalf("first chunk: %d", got)
	}
	sess := h.session(t, uploadID)
	if _, _, ok, err := h.store.ClaimUploadDone(ctx, sess.ID, h.now); err != nil || !ok {
		t.Fatalf("claim: %v %v", ok, err)
	}

	res, err := h.store.CommitUploadProgress(ctx, UploadProgress{
		SessionID: sess.ID, UserID: h.userID, Committed: 4096, Billable: true, Now: h.now,
		RoomID: sess.PairRoomID, RoomExpiry: h.now + pairRoomJoinWindow,
	})
	if err != nil {
		t.Fatalf("commit: %v", err)
	}
	if !res.RoomOpen {
		t.Fatal("a live room must still be reported open, whatever state the session is in")
	}
}
