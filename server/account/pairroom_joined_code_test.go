package account

import (
	"bytes"
	"context"
	"testing"
)

// What a JOINED room may still do to the six digits that named it.
//
// Nothing. Invariant 5 says joining ends every clock, and syncPairCode's own
// comment says why the code must not be dragged along past that point: a code
// that outlives its usefulness holds six of a million digits out of circulation
// while buying nothing, because the room it names is full and the peers are
// already connected.
//
// The path that broke it is the one where the room's authoritative transaction
// already KNOWS the answer and the caller projects one anyway. Finalize touches
// the room — which for a joined room legitimately pushes its RETENTION deadline
// out (pairRoomJoinedExpiry), and used to match nothing at all against an
// immortal expires_at — and then syncPairCode projects a join
// deadline out of the handler's snapshot with pairRoomProgressJoinDeadline, which
// has never asked whether anybody joined. Same for the two other numbers a store
// transaction hands back for the code to be extended to: the append's
// UploadProgressResult.RoomJoinDeadline and finalize's
// StoredFileWrite.RoomJoinDeadline.
//
// The rule now has one home (pairRoomCodeDeadline) and the store answers with it,
// so the caller has nothing left to project from.

// codeExp is the pairing code's registry expiry, or 0 once the entry is gone.
func (h *pairHarness) codeExp(code string) int64 { return h.codes.codes[code].exp }

// joinRoom is the signaling layer's observation that a second participant
// entered the code's room, landed synchronously.
func (h *pairHarness) joinRoom(t *testing.T, code string) {
	t.Helper()
	if err := h.svc.MarkPairRoomJoined(context.Background(), code); err != nil {
		t.Fatalf("record the join of %s: %v", code, err)
	}
	if room := h.roomFor(t, code); room.JoinedAt == 0 {
		t.Fatalf("the room for %s is not joined; the test did not stage what it meant to", code)
	}
}

// The headline case: the receiver arrives while the batch's last file is still
// uploading, and that file's finalize must not buy the code another window.
func TestFinalizeIntoAJoinedRoomDoesNotExtendItsCode(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("818181", "")
	blob := bytes.Repeat([]byte("J"), 4096)

	status, uploadID, _ := h.initPairUpload(t, "818181", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	if code := h.patch(t, uploadID, blob, 0, len(blob), len(blob)); code != 200 {
		t.Fatalf("patch: %d", code)
	}
	// The peer arrives before the upload is finalized. This is the ordinary
	// interleaving, not an exotic one: pre-upload exists to spend the wait, and
	// the wait ends when somebody joins.
	h.joinRoom(t, "818181")
	held := h.codeExp("818181")

	h.advance(120)
	status, id := h.finalize(t, uploadID)
	if status != 200 {
		t.Fatalf("finalize: %d", status)
	}
	if id == "" {
		t.Fatal("finalize stored nothing")
	}
	if got := h.codeExp("818181"); got != held {
		t.Fatalf("finalizing into a JOINED room pushed the code's expiry from %d to %d — %d more seconds holding six of a million digits for a room that is already full",
			held, got, got-held)
	}
}

// The same claim on the append path, which reaches the registry through a
// different number (UploadProgressResult.RoomJoinDeadline). A batch's later file
// keeps uploading after the peer joins — the protocol only refuses a NEW init
// once someone is in the room — so this is reached by the same ordinary flow.
func TestAnAppendIntoAJoinedRoomDoesNotExtendItsCode(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("828282", "")
	blob := bytes.Repeat([]byte("A"), 8192)

	status, uploadID, _ := h.initPairUpload(t, "828282", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	if code := h.patch(t, uploadID, blob, 0, 1024, len(blob)); code != 200 {
		t.Fatalf("first patch: %d", code)
	}
	h.joinRoom(t, "828282")
	held := h.codeExp("828282")

	h.advance(90)
	code, received, exp := patchExpiry(t, h, uploadID, blob, 1024, 2048, len(blob))
	if code != 200 || received != 2048 {
		t.Fatalf("patch after the join: %d received=%d", code, received)
	}
	if got := h.codeExp("828282"); got != held {
		t.Fatalf("an append into a JOINED room pushed the code's expiry from %d to %d", held, got)
	}
	// And it does not TELL the client one either. The response's expiresAt is
	// the instant the code stops admitting a second device, and a joined room
	// has no such instant left to report.
	if exp != nil {
		t.Fatalf("the append reported a join deadline of %d for a room somebody has already joined", *exp)
	}
}

// The append's OTHER answer — the resume overshoot's idempotent ack, which
// never reaches a store transaction and reads the row directly
// (persistedRoomJoinDeadline). It is the reply a client gets after re-sending
// bytes the server already has, which is exactly what a client does when an
// answer was lost, so it is the one most likely to be asked across a join.
//
// Same claim, same reason: there is no instant left at which anybody may still
// join, so there is no number to report. The status probe shares the read and
// therefore the answer.
func TestTheOvershootAckAndProbeAreSilentOnceTheRoomIsJoined(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("838383", "")
	blob := bytes.Repeat([]byte("O"), 8192)

	status, uploadID, _ := h.initPairUpload(t, "838383", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	if code, _, _ := patchExpiry(t, h, uploadID, blob, 0, 1024, len(blob)); code != 200 {
		t.Fatalf("first patch: %d", code)
	}
	h.joinRoom(t, "838383")
	held := h.codeExp("838383")
	h.advance(60)

	// A replay of bytes the server already has.
	code, received, exp := patchExpiry(t, h, uploadID, blob, 512, 1024, len(blob))
	if code != 200 || received != 1024 {
		t.Fatalf("overshoot ack: %d received=%d", code, received)
	}
	if exp != nil {
		t.Fatalf("the overshoot ack offered %d as a join deadline for a room somebody is already in", *exp)
	}
	if _, _, pexp := statusExpiry(t, h, uploadID); pexp != nil {
		t.Fatalf("the resume probe offered %d as a join deadline for a joined room", *pexp)
	}
	if got := h.codeExp("838383"); got != held {
		t.Fatalf("a read moved the code from %d to %d", held, got)
	}
}

// The half that must NOT be lost with the projection. Finalize's touch is a real
// write: it moves the room row and projects onto every object already in the
// batch. If the finalize then FAILS at one of the gates after it (here the
// authoritative traffic gate), the room keeps that later deadline — so the code
// has to keep it too, or the credential dies while the ciphertext it names is
// still live and joinable, which is precisely the drift invariant 4 exists to
// forbid. Deleting the pre-gate sync instead of re-sourcing its number would
// recreate exactly that.
func TestAFailedFinalizeStillLeavesTheCodeAtTheDeadlineItsTouchBought(t *testing.T) {
	const size = 4000
	h := newPairHarness(t)
	h.setPlan(t, Plan{ID: "cap", Name: "Cap", StorageBytes: 1 << 30,
		TrafficBytes: size, RetentionSecs: 3600, DailyQuotaBytes: 1 << 30})
	h.mintCode("868686", "")

	blob := bytes.Repeat([]byte("F"), size)
	status, uploadID, _ := h.initPairUpload(t, "868686", 0, "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	if got := h.patch(t, uploadID, blob, 0, size, size); got != 200 {
		t.Fatalf("chunk: %d", got)
	}
	// One more byte of traffic in the same month is what makes the finalize
	// refuse — after its touch has already moved the room.
	if err := h.store.RecordMeter(context.Background(), h.userID, MeterDownload, 1, h.now); err != nil {
		t.Fatalf("record other traffic: %v", err)
	}
	h.advance(30) // so the touch is a real forward move, not a silent no-op

	if status, _ := h.finalize(t, uploadID); status != 429 {
		t.Fatalf("finalize over the traffic allowance: %d, want 429", status)
	}
	room := h.roomFor(t, "868686")
	if want := h.now + pairRoomJoinWindow; room.ExpiresAt != want {
		t.Fatalf("the failed finalize's touch left the room at %d, want %d — the test is not exercising the case it means to", room.ExpiresAt, want)
	}
	if got := h.codeExp("868686"); got != room.ExpiresAt {
		t.Fatalf("the room is joinable until %d and its code dies at %d; for %d seconds the ciphertext is live behind a credential nobody can present",
			room.ExpiresAt, got, room.ExpiresAt-got)
	}
}

// The store's own contract, unjoined: the touch reports the deadline the ROW
// holds, which is what the code is then synced to. This is the half that must
// keep working — deleting the projection without replacing it would leave the
// code lagging behind every room the finalize actually moved.
func TestAnUnjoinedTouchReportsTheDeadlineTheRowHolds(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	room := PairRoom{ID: "r-unjoined", Code: "830000", UserID: "u1", CreatedAt: 1000}
	room.ExpiresAt = pairRoomExpiry(room)
	if _, _, err := st.CreatePairRoomIfAbsent(ctx, room); err != nil {
		t.Fatalf("open the room: %v", err)
	}

	at := int64(1100)
	touch, err := st.TouchPairRoomUpload(ctx, room.ID, at, at+pairRoomJoinWindow)
	if err != nil {
		t.Fatalf("touch: %v", err)
	}
	if want := at + pairRoomJoinWindow; touch.CodeDeadline != want {
		t.Fatalf("the touch reported a code deadline of %d, want the one the row now holds (%d)", touch.CodeDeadline, want)
	}
	got, _, err := st.GetPairRoom(ctx, room.ID)
	if err != nil {
		t.Fatalf("re-read the room: %v", err)
	}
	if got.ExpiresAt != touch.CodeDeadline {
		t.Fatalf("the row holds %d and the touch reported %d — the code would be synced to a window the room does not have", got.ExpiresAt, touch.CodeDeadline)
	}
}

// The store's own contract, joined: nothing to extend the code to, and the
// touch says so rather than leaving the caller to work it out from a snapshot.
func TestAJoinedTouchReportsNoCodeDeadline(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	room := PairRoom{ID: "r-joined", Code: "840000", UserID: "u1", CreatedAt: 1000}
	room.ExpiresAt = pairRoomExpiry(room)
	if _, _, err := st.CreatePairRoomIfAbsent(ctx, room); err != nil {
		t.Fatalf("open the room: %v", err)
	}
	joined := room
	joined.JoinedAt = 1050
	if err := st.JoinPairRoom(ctx, room.ID, joined.JoinedAt, pairRoomExpiry(joined)); err != nil {
		t.Fatalf("join the room: %v", err)
	}

	at := int64(1100)
	touch, err := st.TouchPairRoomUpload(ctx, room.ID, at, pairRoomProgressExpiry(joined, at))
	if err != nil {
		t.Fatalf("touch a joined room: %v", err)
	}
	if touch.CodeDeadline != 0 {
		t.Fatalf("the touch offered %d as the code's deadline for a room that is already joined; joining ends every clock (invariant 5)", touch.CodeDeadline)
	}
}

// A touch whose own progress is STALE — a sibling already moved the room past it
// — still reports the row, and the row is a ceiling rather than a floor. The
// caller may only ever bring the code UP to the deadline the room demonstrably
// holds, never to one this request derived.
func TestAStaleTouchReportsTheRowsDeadlineAndNotItsOwn(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	room := PairRoom{ID: "r-stale", Code: "850000", UserID: "u1", CreatedAt: 1000}
	room.ExpiresAt = pairRoomExpiry(room)
	if _, _, err := st.CreatePairRoomIfAbsent(ctx, room); err != nil {
		t.Fatalf("open the room: %v", err)
	}
	// The sibling lands first, at a later instant.
	ahead := int64(1200)
	if _, err := st.TouchPairRoomUpload(ctx, room.ID, ahead, ahead+pairRoomJoinWindow); err != nil {
		t.Fatalf("the sibling's touch: %v", err)
	}
	// This request's own progress is older; its UPDATE matches nothing.
	stale := int64(1100)
	touch, err := st.TouchPairRoomUpload(ctx, room.ID, stale, stale+pairRoomJoinWindow)
	if err != nil {
		t.Fatalf("the stale touch: %v", err)
	}
	if want := ahead + pairRoomJoinWindow; touch.CodeDeadline != want {
		t.Fatalf("the stale touch reported %d, want the row's own %d — reporting its own projection would pull the code back behind bytes a sibling already paid for", touch.CodeDeadline, want)
	}
	if touch.CodeDeadline == stale+pairRoomJoinWindow {
		t.Fatal("the stale touch reported the deadline it projected from its own clock")
	}
}
