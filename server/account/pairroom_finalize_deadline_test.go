package account

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

// The deadline finalize BINDS an object to, as opposed to the one it reports.
//
// A pre-upload's last request creates the stored_files row, and that row's
// expires_at is when the ciphertext stops being readable. It has to be the room's
// own — every other object in the batch carries it (touchPairRoomOn projects it
// onto them), and the receiver joins once for all of them.
//
// Finalize used to build it out of a room snapshot it had read, plus its own
// clock: notePairRoomUpload's touch, then `room.LastUploadAt = now` on the value
// copy, then pairRoomExpiry of that. Both halves are stale by construction. A
// SIBLING request — the next file of the same batch, or a retry of an append
// whose answer was lost — can move the room after the touch has already projected
// onto the objects that exist, and before this one's row is inserted. The new
// object then lands with an expires_at BEHIND its own room's: it is the only file
// in the batch that dies early, and the response tells the sender a window
// shorter than the one the code registry is still admitting joins for.
//
// The fix puts the read where the write is. The object's deadline comes from the
// pair_rooms row inside the same writer transaction that enforces the room's open
// precondition and the storage caps and inserts the row — so there is no interval
// for a sibling to land in, and no projection anywhere.

// finalizeExpiry finalizes and reports (status, id, expiresAt) — the deadline as
// a pointer, so "said nothing" is distinguishable from "said zero".
func (h *pairHarness) finalizeExpiry(t *testing.T, uploadID string) (int, string, *int64) {
	t.Helper()
	req, _ := http.NewRequest("POST", h.ts.URL+"/api/uploads/"+uploadID+"/finalize", nil)
	req.AddCookie(h.cookie)
	resp, err := h.ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out struct {
		ID        string `json:"id"`
		ExpiresAt *int64 `json:"expiresAt"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out.ID, out.ExpiresAt
}

// assertDeadlineIsUnanimous pins the four places one room's deadline lives, which
// only ever disagree in one direction: the room row and the code registry are
// moved by whichever request commits LAST, while the object and the response are
// written by this one. Anything this finalize derived for itself is therefore the
// value that comes out short.
//
// `want` is the room's join deadline, which is also its expiry while nobody has
// joined — the only state these tests put a room in.
func (h *pairHarness) assertDeadlineIsUnanimous(t *testing.T, code, fileID string, reported *int64, want int64) {
	t.Helper()
	if room := h.roomFor(t, code); room.ExpiresAt != want {
		t.Fatalf("the room row holds %d, want %d — the test did not stage the race it meant to", room.ExpiresAt, want)
	}
	f, err := h.store.GetStoredFile(context.Background(), fileID)
	if err != nil {
		t.Fatalf("read the object finalize just persisted: %v", err)
	}
	if f.ExpiresAt != want {
		t.Fatalf("the object was persisted with expires_at %d, %d seconds before its own room's %d — it is the one file in the batch whose ciphertext dies early, and no later touch repairs it (touchPairRoomOn only ever moves objects FORWARD, and this one is already past the row it would be moved to)",
			f.ExpiresAt, want-f.ExpiresAt, want)
	}
	if reported == nil {
		t.Fatal("finalize reported no expiresAt at all; it is the sender's only word on the window its own batch bought")
	}
	if *reported != want {
		t.Fatalf("finalize answered %d, want %d — the sender counts this down and treats it as certainty, so %d seconds of a live rendezvous are announced dead",
			*reported, want, want-*reported)
	}
	if got := h.codes.codes[code].exp; got != want {
		t.Fatalf("the code registry holds %d and the sender was told %d; a receiver may still join for %d seconds the sender does not know about",
			got, want, got-want)
	}
}

// The ordinary case, first: an accepted finalize still buys the room the final
// progress window the protocol promises, and every party agrees on where it
// landed. This is what the race tests below must not be able to pass by simply
// never extending anything.
func TestFinalizeBuysTheFinalProgressWindowAndSaysWhereItLanded(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("585858", "")
	blob := bytes.Repeat([]byte("F"), 4096)

	status, uploadID, _ := h.initPairUpload(t, "585858", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	if code := h.patch(t, uploadID, blob, 0, len(blob), len(blob)); code != 200 {
		t.Fatalf("patch: %d", code)
	}
	// Well past the mint's own five minutes, so an answer that merely echoed the
	// mint would be visibly wrong rather than accidentally right.
	h.advance(240)
	at := h.now

	status, id, exp := h.finalizeExpiry(t, uploadID)
	if status != 200 {
		t.Fatalf("finalize: %d", status)
	}
	h.assertDeadlineIsUnanimous(t, "585858", id, exp, at+pairRoomJoinWindow)
}

// THE RACE, on the billable/capped path — the ordinary deployment, where the
// object is inserted by CreateStoredFileWithinStorageCaps.
//
// The sibling lands in the one interval finalize used to leave open: after its
// own touch has moved the room and projected onto the objects that exist, before
// its own object exists to be projected onto. Nothing later repairs it —
// touchPairRoomOn's projection is `expires_at < ?`, and by the time the next
// touch runs this row is not behind the room, it IS the room's older value
// carried on a row nobody will look at again.
func TestFinalizeBindsTheObjectToTheDeadlineTheRoomHoldsWhenItLands(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("595959", "")
	blob := bytes.Repeat([]byte("G"), 4096)

	status, uploadID, _ := h.initPairUpload(t, "595959", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	if code := h.patch(t, uploadID, blob, 0, len(blob), len(blob)); code != 200 {
		t.Fatalf("patch: %d", code)
	}
	h.advance(120)
	stale := h.now + pairRoomJoinWindow // what this finalize's own touch buys

	racing := h.withRacingStore()
	var sibling int64
	racing.atTouch, racing.onTouch = 1, func() {
		sibling = h.advanceRoomFromAnotherRequest(t, "595959", 75)
	}
	status, id, exp := h.finalizeExpiry(t, uploadID)
	if status != 200 {
		t.Fatalf("finalize: %d", status)
	}
	if sibling <= stale {
		t.Fatalf("the sibling landed at %d, not past this finalize's own %d — the race was not staged", sibling, stale)
	}
	h.assertDeadlineIsUnanimous(t, "595959", id, exp, sibling)
}

// The same race on the own-node path, which reaches the insert through a
// different call in persistStoredFile: an upload that lands on the user's own
// storage node is quota- and cap-exempt, so none of the gates the billable path
// runs stand between the touch and the row. It is the shorter path, and the one
// where a deadline stitched together after the transaction would look most
// obviously fine.
func TestFinalizeOnAnOwnNodeBindsTheObjectToTheRoomsDeadlineToo(t *testing.T) {
	h := newPairHarness(t)
	node := newHeldPatchNode(t) // hold nil: an ordinary, healthy node
	h.registerOwnStorageNode(t, node.URL)
	h.mintCode("606060", "")
	blob := bytes.Repeat([]byte("H"), 4096)

	status, uploadID, _ := h.initPairUpload(t, "606060", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	if sess := h.session(t, uploadID); sess.NodeID == "" || sess.Billable {
		t.Fatalf("this upload is not on the user's own node (node=%q billable=%v); the test is exercising the capped path twice", sess.NodeID, sess.Billable)
	}
	if code := h.patch(t, uploadID, blob, 0, len(blob), len(blob)); code != 200 {
		t.Fatalf("patch: %d", code)
	}
	h.advance(120)
	stale := h.now + pairRoomJoinWindow

	racing := h.withRacingStore()
	var sibling int64
	racing.atTouch, racing.onTouch = 1, func() {
		sibling = h.advanceRoomFromAnotherRequest(t, "606060", 75)
	}
	status, id, exp := h.finalizeExpiry(t, uploadID)
	if status != 200 {
		t.Fatalf("finalize: %d", status)
	}
	if sibling <= stale {
		t.Fatalf("the sibling landed at %d, not past this finalize's own %d — the race was not staged", sibling, stale)
	}
	h.assertDeadlineIsUnanimous(t, "606060", id, exp, sibling)
}

// An ordinary upload's finalize is untouched, which is worth pinning because the
// deadline now comes back from the store rather than from the row the handler
// built: a share has no room to read one from, and its answer must still be the
// session's own TTL rather than whatever a zero value would look like.
func TestAnOrdinaryFinalizeStillReportsItsOwnTTL(t *testing.T) {
	h := newPairHarness(t)
	blob := bytes.Repeat([]byte("N"), 4096)
	uploadID := initUpload(t, h.ts, h.cookie, []byte("MANIFEST"), len(blob), 3600)
	if code := h.patch(t, uploadID, blob, 0, len(blob), len(blob)); code != 200 {
		t.Fatalf("patch: %d", code)
	}
	status, id, exp := h.finalizeExpiry(t, uploadID)
	if status != 200 {
		t.Fatalf("finalize: %d", status)
	}
	if exp == nil || *exp != h.now+3600 {
		t.Fatalf("finalize reported %v, want the session's own TTL (%d)", exp, h.now+3600)
	}
	f, err := h.store.GetStoredFile(context.Background(), id)
	if err != nil {
		t.Fatalf("read the object: %v", err)
	}
	if f.ExpiresAt != *exp {
		t.Fatalf("the row expires at %d and the sender was told %d", f.ExpiresAt, *exp)
	}
}

// registerOwnStorageNode makes url a storage node OWNED BY the harness's user, so
// uploads land there and are billable=false (placeUpload prefers it, and the
// quota/cap gates skip it entirely).
func (h *pairHarness) registerOwnStorageNode(t *testing.T, url string) string {
	t.Helper()
	n, err := h.store.UpsertNode(context.Background(), Node{
		OwnerType: "user", OwnerUserID: h.userID, URLs: []string{"turn:x:3478"}, TURNSecret: "t",
		StorageEnabled: true, StorageURL: url, StorageSecret: "ss",
		StorageFree: 100 << 30, CreatedAt: 1, LastSeenAt: h.now,
	})
	if err != nil {
		t.Fatalf("register the user's own node: %v", err)
	}
	return n.ID
}
