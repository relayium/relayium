package account

import (
	"bytes"
	"context"
	"testing"

	"github.com/relayium/relayium/internal/signal"
)

// The pairing CODE's own lifetime, as opposed to the room's.
//
// pairroom_test.go pins the room: its deadline follows the last accepted byte,
// bounded by six hours from the moment it opened. That deadline lives in the
// database. The code lives somewhere else entirely — in signal.PairRegistry, in
// memory — and it is the thing an upload's owner check and a receiver's
// WebSocket are actually resolved against.
//
// So the two have to be one clock. When they were not, the room's rule was
// implemented perfectly and meant nothing: a ten-minute pre-upload pushed its
// row's expires_at out chunk by chunk while the code it was bound to died five
// minutes after the mint, and the receiver it was uploaded for could no longer
// join at all. Every test here fails if the synchronization is removed.

// The headline property, end to end: real accepted progress keeps the code
// usable past the mint TTL, and the promised five minutes start at the last
// byte — not at the mint, and not at the upload's start.
func TestProgressKeepsTheCodeValidPastItsMintTTL(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("424242", "")
	blob := bytes.Repeat([]byte("P"), 4096)

	status, uploadID, _ := h.initPairUpload(t, "424242", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	// A slow upload: one chunk every four minutes, for sixteen minutes. Each is
	// inside the join window and pushes it out again; without the code following
	// the room, the code is dead from T+300 and everything after it is unreachable
	// ciphertext.
	for i := 0; i < 4; i++ {
		h.advance(240)
		start, end := i*1024, (i+1)*1024
		if got := h.patch(t, uploadID, blob, start, end, len(blob)); got != 200 {
			t.Fatalf("patch %d at T+%d: %d", i, 240*(i+1), got)
		}
		if !h.codes.valid("424242") {
			t.Fatalf("the code died at T+%d, while its own upload was still committing chunks", 240*(i+1))
		}
	}
	if _, ok := h.svc.pairCodeOwner("424242"); !ok {
		t.Fatal("a progressing pre-upload's code must still resolve to its owner — this is what admits the rest of the batch")
	}
	if status, _ := h.finalize(t, uploadID); status != 200 {
		t.Fatalf("finalize: %d", status)
	}

	// The last byte has landed. The final five minutes run from HERE.
	h.advance(299)
	if !h.codes.valid("424242") {
		t.Fatal("the code must stay valid for the whole final join window after the upload completes")
	}
	h.advance(1)
	if h.codes.valid("424242") {
		t.Fatal("the code must die 300s after the last accepted byte, not later")
	}
}

// Opening a room is itself a deadline move, and the code has to take it.
//
// The sender mints a code and then spends a while picking files: the room opens
// at the first upload, so its five minutes start THERE, while the code's five
// minutes started at the mint. Left alone the code dies first, and the receiver
// cannot join a room that is demonstrably still alive and still holding
// ciphertext for them.
func TestOpeningARoomGivesItsCodeTheRoomsOwnDeadline(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("434343", "")
	mintedAt := h.now

	h.advance(200) // the sender was choosing files
	status, _, _ := h.initPairUpload(t, "434343", 4096, "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	room := h.roomFor(t, "434343")

	// Not one byte has been uploaded since. The code must nonetheless live as
	// long as the room does — to its join deadline, and not to the mint's.
	h.now = mintedAt + signal.CodeTTLSeconds
	if !h.codes.valid("434343") {
		t.Fatal("the code expired on its mint TTL while the room it opened was still joinable")
	}
	h.now = pairRoomJoinDeadline(room) - 1
	if !h.codes.valid("434343") {
		t.Fatal("the code must last to the room's join deadline")
	}
	h.now = pairRoomJoinDeadline(room)
	if h.codes.valid("434343") {
		t.Fatal("...and no further: the room is over at its join deadline")
	}
}

// The ceiling is the room's, and the code may never outlive it. Without this a
// client that trickles one chunk every four minutes holds a code — one of a
// million — open for as long as it likes, which is the abuse case
// pairRoomMaxJoinable exists to bound.
func TestTricklingCannotHoldACodePastTheSixHourCeiling(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("424242", "")
	// 1 KiB every 290 seconds for six hours: the textbook trickle, every chunk
	// inside the join window and therefore every one of them an extension.
	const step, per = 290, 1024
	blob := bytes.Repeat([]byte("T"), int(pairRoomMaxJoinable/step+2)*per)
	status, uploadID, _ := h.initPairUpload(t, "424242", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	room := h.roomFor(t, "424242")
	ceiling := room.CreatedAt + pairRoomMaxJoinable

	sent := 0
	for h.now+step < ceiling {
		h.advance(step)
		if got := h.patch(t, uploadID, blob, sent, sent+per, len(blob)); got != 200 {
			t.Fatalf("patch at T+%d: %d", h.now-room.CreatedAt, got)
		}
		sent += per
		if !h.codes.valid("424242") {
			t.Fatalf("the code died at T+%d, inside the ceiling and still committing", h.now-room.CreatedAt)
		}
		if got := h.codes.codes["424242"].exp; got > ceiling {
			t.Fatalf("code expiry %d is past the room's ceiling %d — progress must never buy the code more than the room itself has",
				got, ceiling)
		}
	}
	// Within one step of the ceiling, every further extension is clamped to it
	// exactly: this is the number that stops being the client's to choose.
	if got := h.codes.codes["424242"].exp; got != ceiling {
		t.Fatalf("code expiry = %d, want the ceiling %d", got, ceiling)
	}

	h.now = ceiling
	if h.codes.valid("424242") {
		t.Fatal("the code must be dead at the ceiling, whatever the upload is doing")
	}
	if got := h.patch(t, uploadID, blob, sent, sent+per, len(blob)); got != 410 {
		t.Fatalf("patch at the ceiling = %d, want 410 — the room is over and so is the transfer", got)
	}
}

// The billing rule is what makes the deadline rule safe, and it only works if
// "progress" means BYTES.
//
// Holding a code open is supposed to cost the holder: the sole way to push the
// deadline out is to keep uploading, and every uploaded byte is billed to the
// account that minted the code (protocol §5, invariant 3). An append that
// commits nothing — an empty body at the current offset, which any client can
// send in a loop — must therefore buy nothing. If it renewed the window, a
// signed-in attacker could hold six of a million digits (and the room bound to
// them) alive to the six-hour ceiling for free, and the argument the whole
// window rests on would be untrue.
func TestAnAppendThatCommitsNothingBuysNoTime(t *testing.T) {
	h := newPairHarness(t)
	// The REAL registry, not the harness's fake: the code's expiry is half of what
	// "renewed nothing" has to mean, and it is the half a stub can be wrong about
	// for free.
	reg := signal.NewPairRegistry(signal.CodeTTLSeconds, func() int64 { return h.now })
	h.svc.SetPairCodes(reg)
	code, _ := reg.MintFor(h.userID)
	if code == "" {
		t.Fatal("MintFor returned no code")
	}
	// The one real chunk lands well after the mint, so the room has genuinely
	// pushed the code past its own TTL. Without that gap a code renewed for free
	// and a code left alone expire at the same instant and the test proves nothing.
	h.advance(100)
	blob := bytes.Repeat([]byte("N"), 4096)
	status, uploadID, _ := h.initPairUpload(t, code, len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	if got := h.patch(t, uploadID, blob, 0, 1024, len(blob)); got != 200 {
		t.Fatalf("the one real chunk: %d", got)
	}
	lastByteAt := h.now
	deadline := lastByteAt + pairRoomJoinWindow
	billed := h.uploadMetered(t)
	before := h.roomFor(t, code)

	// Three requests that commit nothing, spread across the window they are trying
	// to renew. Each is accepted — none of them is an error — and each has to buy
	// exactly nothing.
	h.advance(120)
	if got := h.patch(t, uploadID, blob, 1024, 1024, len(blob)); got != 200 {
		t.Fatalf("empty append at the committed offset: %d", got)
	}
	h.advance(60)
	if got := h.patch(t, uploadID, blob, 512, 1024, len(blob)); got != 200 {
		t.Fatalf("duplicate append below the committed offset: %d", got)
	}
	h.advance(60) // T+240 into a 300s window
	if got := h.patch(t, uploadID, blob, 1024, 1024, len(blob)); got != 200 {
		t.Fatalf("second empty append: %d", got)
	}

	if got := h.uploadMetered(t); got != billed {
		t.Fatalf("a no-progress append was billed %d bytes: it moved none", got-billed)
	}
	// The authoritative room row, column by column: nothing about it moved. This
	// is the DB deadline (expires_at) as well as the input it is derived from
	// (last_upload_at), so neither a stale write nor a re-derivation can hide here.
	after := h.roomFor(t, code)
	if after != before {
		t.Fatalf("a no-progress append changed the room:\n before %+v\n after  %+v", before, after)
	}
	// And the deadline itself, rather than only the column behind it: a first
	// chunk that lands in the same second the room opened needs no write at all,
	// so last_upload_at can legitimately be 0 while the deadline is already right.
	if got := pairRoomJoinDeadline(after); got != deadline {
		t.Fatalf("join deadline = %d, want %d — the window runs from the last accepted byte",
			got, deadline)
	}

	// The real registry's own expiry, pinned from both sides: the code is alive
	// for the last second of the window the last BYTE bought, and dead the instant
	// after it. A free renewal would have moved this boundary out by 240s.
	h.now = deadline - 1
	if !reg.Validate(code) {
		t.Fatal("the code died before the window its last accepted byte bought")
	}
	h.now = deadline
	if reg.Validate(code) {
		t.Fatal("no-progress appends renewed the code's window — holding a code open must cost the bytes the billing rule charges for")
	}
	if got := h.patch(t, uploadID, blob, 1024, 2048, len(blob)); got != 410 {
		t.Fatalf("append after the window = %d, want 410", got)
	}
}

// The other half of "answers room liveness": a request that commits nothing is
// still answered against the room's real state.
//
// A resume overshoot and a gap are both handled from the session's offset alone,
// and both used to be answered before the room was ever looked at — so a client
// resuming into a room whose ciphertext had just been deleted was told 200 with
// an offset, or 409 with an offset, for a blob that no longer existed. The
// deadline is the one thing it needed to know.
func TestEveryNoProgressRequestIntoADeadRoomIsRefused(t *testing.T) {
	for _, tc := range []struct {
		name         string
		start, end   int
		liveExpected int
	}{
		{"resume overshoot below the committed offset", 512, 1024, 200},
		{"a gap above the committed offset", 3000, 3500, 409},
		{"an empty append at the committed offset", 1024, 1024, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newPairHarness(t)
			h.mintCode("494949", "")
			blob := bytes.Repeat([]byte("L"), 4096)
			status, uploadID, _ := h.initPairUpload(t, "494949", len(blob), "")
			if status != 200 {
				t.Fatalf("init: %d", status)
			}
			if got := h.patch(t, uploadID, blob, 0, 1024, len(blob)); got != 200 {
				t.Fatalf("the one real chunk: %d", got)
			}
			// While the room is alive the answer is about the OFFSET, unchanged.
			if got := h.patch(t, uploadID, blob, tc.start, tc.end, len(blob)); got != tc.liveExpected {
				t.Fatalf("inside the window: %d, want %d", got, tc.liveExpected)
			}
			// Past the deadline it is about the ROOM.
			h.advance(pairRoomJoinWindow + 1)
			if got := h.patch(t, uploadID, blob, tc.start, tc.end, len(blob)); got != 410 {
				t.Fatalf("after the deadline: %d, want 410 — the ciphertext this offset describes is gone", got)
			}
		})
	}
}

// Void means gone, and that has to include the code. A receiver who presents it
// afterwards must be refused, because the ciphertext it named has been deleted —
// a code that still validated would describe a transfer that no longer exists.
func TestVoidingARoomRevokesItsCodeSoAReceiverCannotJoin(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("424242", "")
	blob := bytes.Repeat([]byte("V"), 2048)
	id := h.preUpload(t, "424242", blob, 2)
	if !h.codes.valid("424242") {
		t.Fatal("the code is alive while the room is")
	}

	// Nobody joins. The deadline passes and the first truth-bearing read voids
	// the room.
	h.advance(pairRoomJoinWindow + 1)
	if status, _ := h.getAnon(t, "/api/files/"+id+"/meta"); status != 404 {
		t.Fatalf("meta after the deadline = %d, want 404", status)
	}
	if h.codes.valid("424242") {
		t.Fatal("a voided room's code must not validate — the receiver would join a rendezvous whose ciphertext is gone")
	}
	if _, ok := h.codes.codes["424242"]; ok {
		t.Fatal("the revoked code must be out of the registry, not merely expired in it")
	}
}

// The sweep is the same story from the other side: a room nobody ever touches
// again still takes its code with it.
func TestSweepingADeadRoomRevokesItsCode(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("424242", "")
	h.preUpload(t, "424242", bytes.Repeat([]byte("S"), 1024), 1)

	h.advance(pairRoomJoinWindow + 1)
	h.svc.SweepPairRooms(context.Background(), h.now)
	if h.codes.valid("424242") {
		t.Fatal("the backstop sweep must revoke the code of every room it voids")
	}
	if _, ok := h.codes.codes["424242"]; ok {
		t.Fatal("the code is merely expired, not revoked — the two are the same only while two clocks agree, which is what revocation exists not to depend on")
	}
}

// The recycled-digits case. A room's void may run long after its deadline, and
// by then the same six digits can belong to somebody else's transfer. Ending the
// old room must not take the new holder's code.
func TestVoidingARoomCannotTakeAReissuedCode(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("424242", "")
	id := h.preUpload(t, "424242", bytes.Repeat([]byte("R"), 1024), 1)

	// The deadline passes with nobody joining, and the digits are issued again —
	// to a different account — before anything voids the first room.
	h.advance(pairRoomJoinWindow + 60)
	h.mintCode("424242", "someone-else")

	if status, _ := h.getAnon(t, "/api/files/"+id+"/meta"); status != 404 {
		t.Fatalf("meta after the deadline = %d, want 404", status)
	}
	owner, ok := h.codes.OwnerOf("424242")
	if !ok || owner != "someone-else" {
		t.Fatalf("OwnerOf = %q,%v — voiding the previous holder's room must leave the new code alone", owner, ok)
	}
}

// The registry is the authority on who owns six digits RIGHT NOW, and the room
// is not. If they disagree — the code expired, was reaped, and was minted again
// to another account while the old room was still on disk — the old room's
// progress must not touch the new holder's code.
func TestProgressNeverExtendsACodeThatNowBelongsToSomebodyElse(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("424242", "")
	blob := bytes.Repeat([]byte("X"), 4096)
	status, uploadID, _ := h.initPairUpload(t, "424242", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}

	// The digits change hands. (Reaching this state needs the synchronization to
	// have failed first, which is exactly when a stolen extension would matter.)
	h.mintCode("424242", "someone-else")
	newHolder := h.codes.codes["424242"]

	if got := h.patch(t, uploadID, blob, 0, 1024, len(blob)); got != 200 {
		t.Fatalf("patch: %d", got)
	}
	if got := h.codes.codes["424242"]; got != newHolder {
		t.Fatalf("the new holder's entry changed to %+v (was %+v): one account's upload must never move another's code", got, newHolder)
	}
}

// A code that has already expired stays expired. A late progress report is not
// a reason to hand back digits that are already free to be reissued — the room
// itself lives on (its own deadline is what governs the ciphertext), but the
// rendezvous credential does not come back.
func TestProgressNeverResurrectsAnExpiredCode(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("424242", "")
	blob := bytes.Repeat([]byte("E"), 4096)
	status, uploadID, _ := h.initPairUpload(t, "424242", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	// Simulate the reaper having taken the code (a room kept alive by a join, or
	// a synchronization that failed): the digits are simply gone.
	delete(h.codes.codes, "424242")

	if got := h.patch(t, uploadID, blob, 0, 1024, len(blob)); got != 200 {
		t.Fatalf("patch: %d — a live room's upload is not refused because its code was reaped", got)
	}
	if _, ok := h.codes.codes["424242"]; ok {
		t.Fatal("a reaped code must not be re-created by progress on the room it used to name")
	}
}

// Pre-upload cannot run half-wired. The room lifecycle and the code registry are
// two halves of one deadline, and a deployment that has only the first would
// bind ciphertext to codes that keep dying at five minutes — the exact bug this
// file exists to prevent, shipped as a configuration.
func TestPreUploadIsUnavailableWithoutTheCodeRegistry(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("424242", "")
	h.svc.pairCodes = nil

	status, _, _ := h.initPairUpload(t, "424242", 1024, "")
	if status != 503 {
		t.Fatalf("init without the code registry = %d, want 503", status)
	}
}

// The real signal.PairRegistry over the real path, with a real minted code.
//
// Everything above runs against the harness's miniature registry, which is a
// copy of the rules and could in principle drift from them. This one wires the
// production object into the production setter and asserts the property that
// matters through its own Validate — the same call /ws makes when a receiver
// presents six digits.
func TestARealPairRegistryFollowsAProgressingUpload(t *testing.T) {
	h := newPairHarness(t)
	reg := signal.NewPairRegistry(signal.CodeTTLSeconds, func() int64 { return h.now })
	h.svc.SetPairCodes(reg)
	code, exp := reg.MintFor(h.userID)
	if code == "" {
		t.Fatal("MintFor returned no code")
	}
	if exp != h.now+signal.CodeTTLSeconds {
		t.Fatalf("minted exp = %d, want %d", exp, h.now+signal.CodeTTLSeconds)
	}

	blob := bytes.Repeat([]byte("W"), 4096)
	status, uploadID, _ := h.initPairUpload(t, code, len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	for i := 0; i < 3; i++ {
		h.advance(240)
		if got := h.patch(t, uploadID, blob, i*1024, (i+1)*1024, len(blob)); got != 200 {
			t.Fatalf("patch %d: %d", i, got)
		}
	}
	// T+720, well past the mint TTL. This is the call the receiver's WebSocket
	// makes (signal.RoomFor), and it was false before the two clocks were joined.
	if !reg.Validate(code) {
		t.Fatal("the real registry must still validate a code whose pre-upload is progressing")
	}
	if status, _ := h.finalize(t, uploadID); status != 200 {
		t.Fatalf("finalize: %d", status)
	}
	h.advance(299)
	if !reg.Validate(code) {
		t.Fatal("the real registry must hold the code for the final join window")
	}

	// Nobody joins: the room voids on the next truth-bearing read, and the code
	// goes with it.
	h.advance(2)
	h.svc.SweepPairRooms(context.Background(), h.now)
	if reg.Validate(code) {
		t.Fatal("the real registry must not validate a code whose room has been voided")
	}
}
