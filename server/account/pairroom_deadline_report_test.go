package account

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"testing"
)

// What a pre-upload's own requests are told about the deadline they are moving.
//
// The room's join deadline follows the last byte the server committed
// (pairroom.go), and the CODE is dragged along with it (syncPairCode). Until
// this file, the only place a client could ever learn where that landed was
// finalize's response — so a batch whose upload FAILED mid-way, after chunks had
// already extended the room, was left counting the mint's window down and
// announcing a dead code while the room was demonstrably still joinable, with a
// button offering to burn it and mint another.
//
// The fix is additive, not a new endpoint: the append and the status probe both
// already answer a pre-upload, and both now say which instant the room (and
// therefore the code) is joinable until. Every case here would pass silently if
// the field were merely present — each pins the exact number instead, and the
// two that matter most pin what must NOT move it.

// patchExpiry PATCHes blob[start:end] like patchChunk and additionally reports
// the response's `expiresAt` — as a pointer, so "the server said nothing" is
// distinguishable from "the server said zero".
func patchExpiry(t *testing.T, h *pairHarness, uploadID string, blob []byte, start, end, total int) (int, int64, *int64) {
	t.Helper()
	req, _ := http.NewRequest("PATCH", h.ts.URL+"/api/uploads/"+uploadID, bytes.NewReader(blob[start:end]))
	req.AddCookie(h.cookie)
	req.Header.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end-1, total))
	resp, err := h.ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out struct {
		Received  int64  `json:"received"`
		ExpiresAt *int64 `json:"expiresAt"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out.Received, out.ExpiresAt
}

// statusExpiry GETs the resume probe and reports (status, received, expiresAt).
func statusExpiry(t *testing.T, h *pairHarness, uploadID string) (int, int64, *int64) {
	t.Helper()
	req, _ := http.NewRequest("GET", h.ts.URL+"/api/uploads/"+uploadID, nil)
	req.AddCookie(h.cookie)
	resp, err := h.ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out struct {
		Received  int64  `json:"received"`
		ExpiresAt *int64 `json:"expiresAt"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out.Received, out.ExpiresAt
}

// The headline property: the append that moves the deadline says where it moved
// it to, and that answer is the same number the pairing code itself was just
// extended to. One rule, one home — a client that counts this down is counting
// the registry entry the receiver will actually be resolved against.
func TestAnAppendReportsTheJoinDeadlineItJustBought(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("515151", "")
	blob := bytes.Repeat([]byte("D"), 4096)

	status, uploadID, _ := h.initPairUpload(t, "515151", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	// Well past the mint's own five minutes, so a response that merely echoed the
	// mint would be visibly wrong rather than accidentally right.
	h.advance(240)
	at := h.now
	code, received, exp := patchExpiry(t, h, uploadID, blob, 0, 1024, len(blob))
	if code != 200 || received != 1024 {
		t.Fatalf("patch: %d received=%d", code, received)
	}
	if exp == nil {
		t.Fatal("a pre-upload's append must report the room's join deadline — without it a failed batch has no way to learn the window its own bytes bought")
	}
	if want := at + pairRoomJoinWindow; *exp != want {
		t.Fatalf("append reported %d, want the join window from the byte it just committed (%d)", *exp, want)
	}
	if got := h.codes.codes["515151"].exp; got != *exp {
		t.Fatalf("the append reported %d but the code registry holds %d — the client would count down a different clock from the one the receiver is resolved against", *exp, got)
	}
}

// The other half, and the one an over-eager implementation fails: a request that
// commits NOTHING must be told the truth without being sold any of it. A resume
// overshoot is acked idempotently (the client re-sent bytes the server already
// has), and the deadline it hears back is the one the earlier bytes bought —
// not one measured from the replay. Otherwise an empty replay in a loop holds
// six digits open for free, which is the whole reason the store moves the room
// only when the offset moves.
func TestAReplayedAppendIsToldTheDeadlineItDidNotBuy(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("525252", "")
	blob := bytes.Repeat([]byte("R"), 4096)

	status, uploadID, _ := h.initPairUpload(t, "525252", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	committedAt := h.now
	if code, _, _ := patchExpiry(t, h, uploadID, blob, 0, 1024, len(blob)); code != 200 {
		t.Fatalf("first patch: %d", code)
	}
	earned := committedAt + pairRoomJoinWindow

	// Two minutes later the client replays bytes the server already has.
	h.advance(120)
	code, received, exp := patchExpiry(t, h, uploadID, blob, 512, 1024, len(blob))
	if code != 200 || received != 1024 {
		t.Fatalf("replay: %d received=%d", code, received)
	}
	if exp == nil {
		t.Fatal("the replay's ack must still carry the room's deadline: it is the answer a client that lost the first response came back for")
	}
	if *exp != earned {
		t.Fatalf("replay reported %d, want the deadline the committed bytes bought (%d) — a replay that buys time makes the window free", *exp, earned)
	}
	if got := h.codes.codes["525252"].exp; got != earned {
		t.Fatalf("a replay extended the code to %d, want %d", got, earned)
	}
}

// The recovery path this whole change exists for. The append committed; its
// response never arrived. The client's next move is the resume probe, and that
// probe now carries the same answer the lost response did — so the ambiguity
// closes on the first successful request instead of lasting until finalize.
func TestTheResumeProbeCarriesTheDeadlineALostAppendAnswerHeld(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("535353", "")
	blob := bytes.Repeat([]byte("S"), 4096)

	status, uploadID, _ := h.initPairUpload(t, "535353", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	h.advance(200)
	committedAt := h.now
	if code, _, _ := patchExpiry(t, h, uploadID, blob, 0, 1024, len(blob)); code != 200 {
		t.Fatalf("patch: %d", code)
	}

	h.advance(30) // the client spent it retrying, and asks where it stands
	code, received, exp := statusExpiry(t, h, uploadID)
	if code != 200 || received != 1024 {
		t.Fatalf("status: %d received=%d", code, received)
	}
	if exp == nil {
		t.Fatal("the resume probe must report the room's join deadline — it is the only request left once an append's answer is lost")
	}
	if want := committedAt + pairRoomJoinWindow; *exp != want {
		t.Fatalf("status reported %d, want %d", *exp, want)
	}
	// A read renews nothing. The probe must not be a way to hold the room open.
	if got := h.codes.codes["535353"].exp; got != committedAt+pairRoomJoinWindow {
		t.Fatalf("asking for the status moved the code to %d — a read must buy nothing", got)
	}
}

// A room that is over says nothing rather than something reassuring. The probe
// is a plain read (it does not void, and it does not refuse), so the one thing
// it must not do is hand back a join deadline computed from a room whose
// ciphertext has already been reclaimed.
func TestTheResumeProbeIsSilentOnceTheRoomIsOver(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("545454", "")
	blob := bytes.Repeat([]byte("O"), 4096)

	status, uploadID, _ := h.initPairUpload(t, "545454", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	if code, _, _ := patchExpiry(t, h, uploadID, blob, 0, 1024, len(blob)); code != 200 {
		t.Fatalf("patch: %d", code)
	}
	// Nobody joined inside the window; the room's deadline passes.
	h.advance(pairRoomJoinWindow + 1)
	// The append is what voids it — that is the immediate-void rule.
	if code, _, _ := patchExpiry(t, h, uploadID, blob, 1024, 2048, len(blob)); code != http.StatusGone {
		t.Fatalf("append into an expired room: %d, want 410", code)
	}
	if _, _, exp := statusExpiry(t, h, uploadID); exp != nil {
		t.Fatalf("the probe offered %d for a room that is over — a deadline in the future here is an invitation to a rendezvous the server has emptied", *exp)
	}
}

// racingStore wraps a store and runs `sibling` inside one chosen call, so a test
// can put a CONCURRENT request's committed progress exactly where the race is:
// after this request read the room, before its own answer is produced.
//
// A hook rather than a goroutine on purpose. The interleaving that breaks this
// path is a specific one — a later deadline lands between one handler's room
// read and that handler's response — and two real goroutines would reach it only
// sometimes, which is how a regression here survives a green suite. The sibling
// itself is real: it goes through the same store, on the same rows, and leaves
// the same durable state a second handler would.
type racingStore struct {
	Store
	mu      sync.Mutex
	commits int
	// onCommit fires before the commits'th CommitUploadProgress delegates.
	onCommit  func()
	atCommit  int
	getRooms  int
	onGetRoom func()
	atGetRoom int
	touches   int
	// onTouch fires AFTER the touches'th TouchPairRoomUpload has committed — the
	// seam finalize's own deadline move opens. Everything finalize does after it
	// (the quota gates, the object's insert) runs against a room a sibling may
	// already have pushed further out.
	onTouch func()
	atTouch int
}

func (r *racingStore) CommitUploadProgress(ctx context.Context, p UploadProgress) (UploadProgressResult, error) {
	r.mu.Lock()
	r.commits++
	fire := r.onCommit != nil && r.commits == r.atCommit
	r.mu.Unlock()
	if fire {
		r.onCommit()
	}
	return r.Store.CommitUploadProgress(ctx, p)
}

func (r *racingStore) GetPairRoom(ctx context.Context, id string) (PairRoom, bool, error) {
	room, found, err := r.Store.GetPairRoom(ctx, id)
	r.mu.Lock()
	r.getRooms++
	fire := r.onGetRoom != nil && r.getRooms == r.atGetRoom
	r.mu.Unlock()
	if fire {
		r.onGetRoom() // after the read, so this request is holding the older snapshot
	}
	return room, found, err
}

func (r *racingStore) TouchPairRoomUpload(ctx context.Context, id string, at, expiresAt int64) error {
	err := r.Store.TouchPairRoomUpload(ctx, id, at, expiresAt)
	if err != nil {
		return err
	}
	r.mu.Lock()
	r.touches++
	fire := r.onTouch != nil && r.touches == r.atTouch
	r.mu.Unlock()
	if fire {
		r.onTouch() // after this request's own move, before whatever it writes next
	}
	return nil
}

// withRacingStore puts a racingStore in front of the harness's service.
func (h *pairHarness) withRacingStore() *racingStore {
	r := &racingStore{Store: h.store}
	h.svc.store = r
	return r
}

// advanceRoomFromAnotherRequest is what a SIBLING append leaves behind: the
// clock has moved on, another request committed bytes for the same room, and
// both the row and the code registry now stand at a deadline measured from that
// later instant. Exactly what the store's own append transaction and
// syncPairCode do, done directly so a test can place it inside another request.
func (h *pairHarness) advanceRoomFromAnotherRequest(t *testing.T, code string, seconds int64) int64 {
	t.Helper()
	h.advance(seconds)
	ctx := context.Background()
	room, found, err := h.store.LivePairRoomByCode(ctx, code)
	if err != nil || !found {
		t.Fatalf("resolve room for %s: found=%v err=%v", code, found, err)
	}
	if err := h.store.TouchPairRoomUpload(ctx, room.ID, h.now, pairRoomProgressExpiry(room, h.now)); err != nil {
		t.Fatalf("sibling touch: %v", err)
	}
	h.svc.syncPairCode(room, h.now)
	return pairRoomProgressJoinDeadline(room, h.now)
}

// THE RACE, on the path the response is written from.
//
// Two requests for one room overlap — which is the ORDINARY case here, not an
// exotic one: a lost answer is retried, and a batch uploads its files at once.
// One of them reads the room, is delayed, and settles after the other has
// already pushed the room and the code registry out to a later deadline.
//
// What it may not do is answer from what it read. The response is a deadline the
// sender's page counts down and treats as certainty — it clears the "I could not
// tell" state on the strength of it — so a number reconstructed from a snapshot
// that has since been replaced is a page announcing a dead code minutes before
// the registry stops admitting joins. The answer has to come from the row the
// transaction itself saw.
func TestAnAppendReportsTheDeadlineTheStoreHoldsNotTheOneItRead(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("565656", "")
	blob := bytes.Repeat([]byte("C"), 8192)

	status, uploadID, _ := h.initPairUpload(t, "565656", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	stale := h.now
	if code, _, _ := patchExpiry(t, h, uploadID, blob, 0, 1024, len(blob)); code != 200 {
		t.Fatalf("first patch: %d", code)
	}

	// The second append reads the room here, at `stale`. Its sibling commits 90
	// seconds later, while this one is still in flight — so by the time this one's
	// transaction runs, the room and the code are both 90 seconds further out than
	// anything this request could compute from what it read.
	racing := h.withRacingStore()
	var sibling int64
	racing.atCommit, racing.onCommit = 1, func() {
		sibling = h.advanceRoomFromAnotherRequest(t, "565656", 90)
	}
	code, received, exp := patchExpiry(t, h, uploadID, blob, 1024, 2048, len(blob))
	if code != 200 || received != 2048 {
		t.Fatalf("racing patch: %d received=%d", code, received)
	}
	if exp == nil {
		t.Fatal("the append lost the room's deadline entirely")
	}
	if *exp == stale+pairRoomJoinWindow {
		t.Fatalf("the append reported %d — the deadline it derived from the room IT read, %d seconds before a sibling moved the room past it. A page counting that down declares the code dead while the registry is still admitting joins", *exp, sibling-*exp)
	}
	if *exp != sibling {
		t.Fatalf("the append reported %d, want the deadline the row actually holds (%d)", *exp, sibling)
	}
	// And the registry cannot be ahead of what the sender was told, which is the
	// property the client's certainty rests on.
	if got := h.codes.codes["565656"].exp; got != *exp {
		t.Fatalf("the sender was told %d and the code registry holds %d; a receiver may still join for %d seconds the sender does not know about", *exp, got, got-*exp)
	}
}

// The same race against the OTHER answer that never reaches the store's
// transaction: the resume overshoot's idempotent ack.
//
// It is the reply to a client that re-sent bytes the server already has, which
// is precisely what a client does after an answer is lost — so it is very likely
// to be racing the request whose answer went missing. It commits nothing and
// must buy nothing, but "buys nothing" is not "reports a stale number": the
// deadline it hands back has to be the one the room holds when it is sent.
func TestAReplayedAppendReportsTheDeadlineTheRoomHasWhenItAnswers(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("575757", "")
	blob := bytes.Repeat([]byte("V"), 8192)

	status, uploadID, _ := h.initPairUpload(t, "575757", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	stale := h.now
	if code, _, _ := patchExpiry(t, h, uploadID, blob, 0, 1024, len(blob)); code != 200 {
		t.Fatalf("first patch: %d", code)
	}

	// The replay's own liveness read is the first GetPairRoom of the request; the
	// sibling commits immediately after it, before this request answers.
	racing := h.withRacingStore()
	var sibling int64
	racing.atGetRoom, racing.onGetRoom = 1, func() {
		sibling = h.advanceRoomFromAnotherRequest(t, "575757", 45)
	}
	code, received, exp := patchExpiry(t, h, uploadID, blob, 512, 1024, len(blob))
	if code != 200 || received != 1024 {
		t.Fatalf("racing replay: %d received=%d", code, received)
	}
	if exp == nil {
		t.Fatal("the replay's ack lost the room's deadline")
	}
	if *exp == stale+pairRoomJoinWindow {
		t.Fatalf("the replay reported %d, the deadline from the room it read on the way in — %d seconds behind the one the room holds now", *exp, sibling-*exp)
	}
	if *exp != sibling {
		t.Fatalf("the replay reported %d, want the room's current deadline (%d)", *exp, sibling)
	}
	// It reported a later window than it arrived to find — and still bought none
	// of it. The room's deadline is exactly the sibling's, not one measured from
	// this replay.
	room := h.roomFor(t, "575757")
	if want := pairRoomJoinDeadline(room); want != sibling {
		t.Fatalf("the replay moved the room to %d; a request that commits nothing must buy nothing (%d)", want, sibling)
	}
}

// Ordinary uploads are untouched. `expiresAt` is a pair-room fact — the instant
// a CODE stops admitting a second device — and a share upload has no code, no
// room and no such instant, so inventing one would be a fabrication the client
// could not use and a rolling-deploy hazard for no gain.
func TestAnOrdinaryUploadIsToldNoJoinDeadline(t *testing.T) {
	h := newPairHarness(t)
	blob := bytes.Repeat([]byte("N"), 4096)
	uploadID := initUpload(t, h.ts, h.cookie, []byte("MANIFEST"), len(blob), 3600)

	code, received, exp := patchExpiry(t, h, uploadID, blob, 0, 1024, len(blob))
	if code != 200 || received != 1024 {
		t.Fatalf("patch: %d received=%d", code, received)
	}
	if exp != nil {
		t.Fatalf("a share upload's append reported a join deadline (%d); it has no room to have one", *exp)
	}
	if _, _, exp := statusExpiry(t, h, uploadID); exp != nil {
		t.Fatalf("a share upload's resume probe reported a join deadline (%d)", *exp)
	}
}
