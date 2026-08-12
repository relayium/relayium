package account

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// Adversarial suite for the OWNER-facing half of pair-room storage
// (pairroom_owner.go): seeing what a joined pairing transfer left behind, and
// releasing it.
//
// The properties under test are of two kinds, and both matter:
//
//   - CONFINEMENT. One account can neither see nor destroy another's room, and
//     the listing discloses nothing that could reach ciphertext (no code, no
//     object id, no blob key, no verifier, no node, no peer).
//   - NOT DESTROYING SOMETHING LIVE. A release is refused while a room is still
//     receiving an upload, and an unjoined room — which is what a pre-upload
//     looks like while it is happening — is neither listed nor releasable.
//
// None of these assert an implementation detail a different-but-correct design
// would fail.

// --- harness helpers -------------------------------------------------------

// holdingsRaw fetches GET /api/pair-rooms with `cookie` and returns the status
// and the RAW body, so a test can assert over the bytes on the wire rather than
// over a struct that would silently drop a field nobody decoded.
func (h *pairHarness) holdingsRaw(t *testing.T, cookie *http.Cookie) (int, []byte) {
	t.Helper()
	req, _ := http.NewRequest("GET", h.ts.URL+"/api/pair-rooms", nil)
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := h.ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}

type holdingView struct {
	ID         string `json:"id"`
	CreatedAt  int64  `json:"createdAt"`
	JoinedAt   int64  `json:"joinedAt"`
	Objects    int64  `json:"objects"`
	Bytes      int64  `json:"bytes"`
	Releasable bool   `json:"releasable"`
}

type holdingsView struct {
	Rooms  []holdingView `json:"rooms"`
	Totals struct {
		Rooms   int64 `json:"rooms"`
		Objects int64 `json:"objects"`
		Bytes   int64 `json:"bytes"`
	} `json:"totals"`
	Limit     int  `json:"limit"`
	Truncated bool `json:"truncated"`
}

func (h *pairHarness) holdings(t *testing.T, cookie *http.Cookie) holdingsView {
	t.Helper()
	status, body := h.holdingsRaw(t, cookie)
	if status != 200 {
		t.Fatalf("GET /api/pair-rooms: %d %s", status, body)
	}
	var out holdingsView
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode holdings: %v (%s)", err, body)
	}
	return out
}

// release issues DELETE /api/pair-rooms/{id} and returns the status and body.
func (h *pairHarness) release(t *testing.T, cookie *http.Cookie, roomID string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest("DELETE", h.ts.URL+"/api/pair-rooms/"+roomID, nil)
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := h.ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, strings.TrimSpace(string(b))
}

// otherCookie signs a SECOND account in through the same magic-link path the
// harness's own user used, and returns its cookie and user id.
func (h *pairHarness) otherCookie(t *testing.T, email string) (*http.Cookie, string) {
	t.Helper()
	c := loginCookie(t, h.ts, h.mail, email)
	u, err := h.store.UpsertUserByEmail(context.Background(), email, "Other")
	if err != nil {
		t.Fatalf("resolve %s: %v", email, err)
	}
	return c, u.ID
}

// joinedRoom pre-uploads `blob` against `code` and lands a join, returning the
// object id and the room — the ordinary way this feature's storage comes to
// exist.
func (h *pairHarness) joinedRoom(t *testing.T, code string, blob []byte) (string, PairRoom) {
	t.Helper()
	id := h.preUpload(t, code, blob, 1)
	h.join(t, code)
	room := h.roomOf(t, id)
	if room.JoinedAt == 0 {
		t.Fatalf("room for %s is not joined; the test did not stage what it meant to", code)
	}
	return id, room
}

func (h *pairHarness) storedFileExists(t *testing.T, id string) bool {
	t.Helper()
	_, err := h.store.GetStoredFile(context.Background(), id)
	return err == nil
}

// --- confinement -----------------------------------------------------------

// The headline confinement property, both halves in one test: B cannot SEE A's
// room, and B cannot DESTROY it either — and the refusal B gets is the same one
// it would get for a room id that never existed, so the route is not a probe.
func TestOnePersonsPairRoomIsInvisibleAndUntouchableToAnother(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("410000", "")
	blob := bytes.Repeat([]byte("A"), 2048)
	objectID, room := h.joinedRoom(t, "410000", blob)

	other, _ := h.otherCookie(t, "stranger@example.com")

	if got := h.holdings(t, other); got.Totals.Rooms != 0 || len(got.Rooms) != 0 {
		t.Fatalf("a stranger sees %d room(s) and totals %+v", len(got.Rooms), got.Totals)
	}
	// And the same answer a nonexistent id gets, so nothing about A's room —
	// including that it exists — is learnable from the status.
	foreign, foreignBody := h.release(t, other, room.ID)
	absent, absentBody := h.release(t, other, "no-such-room-id")
	if foreign != 200 || absent != 200 || foreignBody != absentBody {
		t.Fatalf("foreign %d %s vs absent %d %s: a stranger can tell them apart",
			foreign, foreignBody, absent, absentBody)
	}
	// Nothing was destroyed by the attempt.
	got, found, err := h.store.GetPairRoom(context.Background(), room.ID)
	if err != nil || !found || got.ClosedAt != 0 {
		t.Fatalf("a stranger's DELETE closed the room: found=%v closed=%d err=%v", found, got.ClosedAt, err)
	}
	if !h.storedFileExists(t, objectID) {
		t.Fatal("a stranger's DELETE removed the object row")
	}
	if !h.blobExists(t, mustStoredFile(t, h, objectID).BlobKey) {
		t.Fatal("a stranger's DELETE removed the ciphertext")
	}
	// The owner, meanwhile, sees exactly one room and can act on it.
	mine := h.holdings(t, h.cookie)
	if len(mine.Rooms) != 1 || mine.Rooms[0].ID != room.ID {
		t.Fatalf("the owner's listing is %+v, want the one room %s", mine.Rooms, room.ID)
	}
}

// Both routes are account controls, so an anonymous caller gets nothing at all —
// not an empty list, which would be an answer.
func TestPairRoomStorageRoutesRefuseAnAnonymousCaller(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("411000", "")
	_, room := h.joinedRoom(t, "411000", bytes.Repeat([]byte("A"), 1024))

	if status, body := h.holdingsRaw(t, nil); status != 401 {
		t.Fatalf("anonymous GET /api/pair-rooms: %d %s", status, body)
	}
	if status, body := h.release(t, nil, room.ID); status != 401 {
		t.Fatalf("anonymous DELETE: %d %s", status, body)
	}
	if _, found, _ := h.store.GetPairRoom(context.Background(), room.ID); !found {
		t.Fatal("an anonymous DELETE removed the room")
	}
}

// An account that has asked to be deleted is FROZEN: its sessions and bearers
// stop working everywhere (ValidateSession / UserFromAuth), and these two routes
// are not an exception. A control that could still release storage on a frozen
// account would be a live credential on a dead account — and the purge deletes
// the rooms outright anyway.
func TestAFrozenAccountReachesNeitherRoute(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("415000", "")
	id, room := h.joinedRoom(t, "415000", bytes.Repeat([]byte("Z"), 1100))

	if err := h.store.SetAccountDeletion(context.Background(), h.userID, h.now, h.now+30*86400); err != nil {
		t.Fatalf("freeze the account: %v", err)
	}
	if status, body := h.holdingsRaw(t, h.cookie); status != 401 {
		t.Fatalf("a frozen account's GET /api/pair-rooms: %d %s", status, body)
	}
	if status, body := h.release(t, h.cookie, room.ID); status != 401 {
		t.Fatalf("a frozen account's DELETE: %d %s", status, body)
	}
	// And nothing was released on the strength of the refused request — the purge
	// owns that, not this control.
	if !h.storedFileExists(t, id) {
		t.Fatal("a refused request from a frozen account still destroyed the object")
	}
}

// What the listing may say, stated as what it may NOT contain. The room is a
// deadline and an owner (pairroom.go's PairRoom comment); this surface adds a
// size, and must add nothing that could reach the ciphertext or the rendezvous.
func TestTheListingCarriesNothingThatCouldReachTheCiphertext(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("412000", "")
	key := fileKeyN(41)
	id := h.preUploadCompletable(t, "412000", bytes.Repeat([]byte("Z"), 4096), key)
	h.join(t, "412000")
	sf := mustStoredFile(t, h, id)

	_, body := h.holdingsRaw(t, h.cookie)
	forbidden := map[string]string{
		"the pairing code":        "412000",
		"the object id":           id,
		"the blob key":            sf.BlobKey,
		"the encrypted manifest":  string(sf.EncManifest),
		"the completion verifier": string(sf.CompletionVerifier),
	}
	for what, secret := range forbidden {
		if secret == "" {
			t.Fatalf("the test staged no %s, so its absence proves nothing", what)
		}
		if bytes.Contains(body, []byte(secret)) {
			t.Fatalf("the listing discloses %s: %s", what, body)
		}
	}
	// The receiver is never recorded at all, so there is nothing to assert about
	// a peer id — what CAN be asserted is that the room's own id is the only id
	// in the answer, and that it is not the code.
	var got holdingsView
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Rooms) != 1 || got.Rooms[0].ID == "412000" {
		t.Fatalf("rooms %+v", got.Rooms)
	}
}

// --- what is listed, and what is not ---------------------------------------

// The three exclusions, each for its own reason, plus the aggregate's agreement
// with the storage the account is actually charged for.
func TestTheListingShowsJoinedRoomsThatHoldCiphertextAndNothingElse(t *testing.T) {
	h := newPairHarness(t)

	// (1) a joined room holding an object — the one thing that should be listed.
	h.mintCode("413000", "")
	kept := bytes.Repeat([]byte("K"), 3000)
	_, keptRoom := h.joinedRoom(t, "413000", kept)

	// (2) an UNJOINED room holding an object. It is on its own deadline and is
	// also what a pre-upload looks like mid-flight; it must not be listed.
	h.mintCode("413001", "")
	waitingID := h.preUpload(t, "413001", bytes.Repeat([]byte("W"), 1000), 1)
	waitingRoom := h.roomOf(t, waitingID)

	// (3) a joined room that was already released. Its ciphertext is gone; a row
	// lingers for an hour (pairRoomPurgeAfter) and must not be offered again.
	h.mintCode("413002", "")
	_, closedRoom := h.joinedRoom(t, "413002", bytes.Repeat([]byte("C"), 1500))
	if status, body := h.release(t, h.cookie, closedRoom.ID); status != 200 {
		t.Fatalf("release: %d %s", status, body)
	}

	got := h.holdings(t, h.cookie)
	ids := map[string]bool{}
	for _, r := range got.Rooms {
		ids[r.ID] = true
	}
	if !ids[keptRoom.ID] {
		t.Fatalf("the joined room holding ciphertext is missing: %+v", got.Rooms)
	}
	if ids[waitingRoom.ID] {
		t.Fatal("an UNJOINED room was offered for release; its upload may still be in flight")
	}
	if ids[closedRoom.ID] {
		t.Fatal("an already-released room is still being offered")
	}
	if got.Totals.Rooms != 1 || got.Totals.Objects != 1 {
		t.Fatalf("totals %+v, want exactly the one live joined room", got.Totals)
	}
	if got.Rooms[0].Bytes != int64(len(kept)) || got.Totals.Bytes != int64(len(kept)) {
		t.Fatalf("bytes %d/%d, want the object's own %d", got.Rooms[0].Bytes, got.Totals.Bytes, len(kept))
	}
	if !got.Rooms[0].Releasable {
		t.Fatal("a settled joined room reports itself unreleasable")
	}
	if got.Rooms[0].JoinedAt != keptRoom.JoinedAt || got.Rooms[0].CreatedAt != keptRoom.CreatedAt {
		t.Fatalf("row %+v does not match the room %+v", got.Rooms[0], keptRoom)
	}
}

// The number on this surface must be the number the storage meter beside it
// sums, including for an object that lives on the user's OWN node — otherwise
// the page explains a figure with a different figure.
func TestTheAggregateMatchesTheStorageTheAccountIsCharged(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("414000", "")
	h.mintCode("414001", "")
	a := bytes.Repeat([]byte("A"), 2500)
	b := bytes.Repeat([]byte("B"), 4100)
	h.joinedRoom(t, "414000", a)
	h.joinedRoom(t, "414001", b)

	got := h.holdings(t, h.cookie)
	if got.Totals.Bytes != int64(len(a)+len(b)) {
		t.Fatalf("totals.bytes %d, want %d", got.Totals.Bytes, len(a)+len(b))
	}
	// CurrentStorage is what the plan cap and the quota meter are computed from.
	// These two rooms are the account's only storage, so the two must agree
	// exactly — a pair-room object carries no deadline, so nothing about the
	// clock can separate them.
	if live := h.currentStorage(t); live != got.Totals.Bytes {
		t.Fatalf("the listing totals %d but CurrentStorage says %d", got.Totals.Bytes, live)
	}
	// Per-room bytes sum to the same thing, and the order is newest-first.
	var sum int64
	for _, r := range got.Rooms {
		sum += r.Bytes
	}
	if sum != got.Totals.Bytes {
		t.Fatalf("rows sum to %d, totals say %d", sum, got.Totals.Bytes)
	}
	if len(got.Rooms) != 2 || got.Rooms[0].CreatedAt < got.Rooms[1].CreatedAt {
		t.Fatalf("rooms are not newest-first: %+v", got.Rooms)
	}
}

// The page is bounded and the totals are not. Driven at the store, because the
// production cap is two hundred and the property is about the CAP, not the
// number: staging two hundred rooms would test SQLite's patience instead.
func TestTheListingIsBoundedWhileItsTotalsStayComplete(t *testing.T) {
	h := newPairHarness(t)
	sizes := []int{1000, 2000, 3000}
	for i, size := range sizes {
		code := string(rune('4')) + "1500" + string(rune('0'+i))
		h.mintCode(code, "")
		h.joinedRoom(t, code, bytes.Repeat([]byte("R"), size))
		h.advance(1) // distinct created_at, so "newest first" is a real assertion
	}
	ctx := context.Background()
	page, err := h.store.ListPairRoomHoldings(ctx, h.userID, 1)
	if err != nil {
		t.Fatalf("holdings: %v", err)
	}
	if len(page.Rooms) != 1 || !page.Truncated {
		t.Fatalf("a limit of 1 over 3 rooms gave %d row(s), truncated=%v", len(page.Rooms), page.Truncated)
	}
	if page.Total.Rooms != 3 || page.Total.Objects != 3 || page.Total.Bytes != 6000 {
		t.Fatalf("totals %+v stopped at the page bound", page.Total)
	}
	// Deterministic: the same request twice returns the same row, and it is the
	// newest one.
	again, err := h.store.ListPairRoomHoldings(ctx, h.userID, 1)
	if err != nil {
		t.Fatalf("holdings again: %v", err)
	}
	if again.Rooms[0].RoomID != page.Rooms[0].RoomID {
		t.Fatalf("two identical requests returned different rows: %s then %s",
			page.Rooms[0].RoomID, again.Rooms[0].RoomID)
	}
	full, err := h.store.ListPairRoomHoldings(ctx, h.userID, 10)
	if err != nil {
		t.Fatalf("holdings full: %v", err)
	}
	if full.Truncated || len(full.Rooms) != 3 {
		t.Fatalf("a limit above the population still truncates: %d rows truncated=%v",
			len(full.Rooms), full.Truncated)
	}
	if full.Rooms[0].RoomID != page.Rooms[0].RoomID {
		t.Fatal("the bounded page is not a prefix of the full listing")
	}
	newest := full.Rooms[0].CreatedAt
	for _, r := range full.Rooms[1:] {
		if r.CreatedAt > newest {
			t.Fatalf("rooms are not ordered newest-first: %+v", full.Rooms)
		}
	}
}

// --- releasing -------------------------------------------------------------

// The happy path and every consequence it must have at once: the room is closed,
// the storage is back immediately, the responsibility for the ciphertext was
// written down BEFORE anything could fail, the bytes are gone, and the code is
// back in circulation.
func TestReleasingARoomFreesItsStorageAndQueuesItsCiphertextFirst(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("416000", "")
	blob := bytes.Repeat([]byte("R"), 5000)
	id, room := h.joinedRoom(t, "416000", blob)
	sf := mustStoredFile(t, h, id)
	if h.currentStorage(t) != int64(len(blob)) {
		t.Fatalf("staging: storage is %d, want %d", h.currentStorage(t), len(blob))
	}

	status, body := h.release(t, h.cookie, room.ID)
	if status != 200 {
		t.Fatalf("release: %d %s", status, body)
	}
	// Quota, now — not at the next sweep and not when a node answers.
	if live := h.currentStorage(t); live != 0 {
		t.Fatalf("storage is still %d after the release", live)
	}
	if h.storedFileExists(t, id) {
		t.Fatal("the object row survived the release")
	}
	if got, found, _ := h.store.GetPairRoom(context.Background(), room.ID); !found || got.ClosedAt == 0 {
		t.Fatalf("the room is not closed: found=%v %+v", found, got)
	}
	// INTENT FIRST: the blob's durable delete intent exists whether or not the
	// physical delete succeeded, which is what makes an unreachable node cost
	// promptness rather than certainty.
	var queued bool
	for _, p := range h.pendingDeletes(t) {
		if p.BlobKey == sf.BlobKey {
			queued = true
		}
	}
	if !queued {
		t.Fatal("the released blob has no durable delete intent")
	}
	if h.blobExists(t, sf.BlobKey) {
		t.Fatal("the ciphertext survived a release against a reachable node")
	}
	// The room is over, so its digits go back.
	if h.codes.valid("416000") {
		t.Fatal("the released room's pairing code is still live")
	}
	// And it no longer appears anywhere.
	if got := h.holdings(t, h.cookie); got.Totals.Rooms != 0 || len(got.Rooms) != 0 {
		t.Fatalf("the released room is still listed: %+v", got)
	}
}

// A release response is a truth claim: 200 means the authoritative close
// committed and storage quota is back. If that transaction fails, returning
// success would strand the bytes while teaching the UI not to retry.
func TestReleaseReportsFailureWhenTheAuthoritativeCloseDoesNotCommit(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("416001", "")
	blob := bytes.Repeat([]byte("E"), 1700)
	id, room := h.joinedRoom(t, "416001", blob)
	flaky := h.withFlakyStore(t)
	flaky.failNext("ClosePairRoom", 1)

	if status, body := h.release(t, h.cookie, room.ID); status != 500 {
		t.Fatalf("release across failed close: %d %s, want 500", status, body)
	}
	if live := h.currentStorage(t); live != int64(len(blob)) {
		t.Fatalf("failed close changed storage to %d, want %d", live, len(blob))
	}
	if !h.storedFileExists(t, id) {
		t.Fatal("failed close removed the object row")
	}
	if got, found, err := h.store.GetPairRoom(context.Background(), room.ID); err != nil || !found || got.ClosedAt != 0 {
		t.Fatalf("failed close changed room: found=%v closed=%d err=%v", found, got.ClosedAt, err)
	}

	// The same explicit request is safe to retry and now tells the truth.
	if status, body := h.release(t, h.cookie, room.ID); status != 200 {
		t.Fatalf("retry release: %d %s", status, body)
	}
	if live := h.currentStorage(t); live != 0 {
		t.Fatalf("successful retry left %d bytes charged", live)
	}
}

// A retry of a request whose response was lost must be a no-op, not an error and
// not a second reclaim.
func TestReleasingTheSameRoomTwiceIsANoOp(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("417000", "")
	id, room := h.joinedRoom(t, "417000", bytes.Repeat([]byte("T"), 2000))
	sf := mustStoredFile(t, h, id)

	first, _ := h.release(t, h.cookie, room.ID)
	intents := len(h.pendingDeletes(t))
	second, body := h.release(t, h.cookie, room.ID)
	if first != 200 || second != 200 {
		t.Fatalf("statuses %d then %d (%s)", first, second, body)
	}
	if got := len(h.pendingDeletes(t)); got != intents {
		t.Fatalf("the second release queued more work: %d intents, was %d", got, intents)
	}
	// It also cannot reclaim the same blob twice against a node — there is
	// nothing left pointing at it.
	if h.blobExists(t, sf.BlobKey) {
		t.Fatal("ciphertext survived")
	}
}

// A release must revoke THE CODE THIS ROOM WAS OPENED FOR and nothing else. Six
// digits are recycled minutes after they are minted, so by the time an account
// gets around to releasing a joined room those digits may name somebody else's
// live transfer.
func TestAReleaseCannotTakeBackDigitsThatNowNameSomebodyElsesTransfer(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("418000", "")
	_, room := h.joinedRoom(t, "418000", bytes.Repeat([]byte("D"), 1200))

	// Time passes, the digits are minted again — to a stranger this time.
	h.advance(pastCodeLifetime())
	_, otherID := h.otherCookie(t, "reissued@example.com")
	h.mintCode("418000", otherID)

	if status, body := h.release(t, h.cookie, room.ID); status != 200 {
		t.Fatalf("release: %d %s", status, body)
	}
	owner, ok := h.codes.OwnerOf("418000")
	if !ok || owner != otherID {
		t.Fatalf("the release took back digits that now belong to %q (live=%v)", owner, ok)
	}
}

// The safety boundary, stated as a refusal rather than as a filter: a room that
// is still receiving an upload is not releasable, and the refusal is stable and
// distinguishable so the surface can say why.
func TestAReleaseIsRefusedWhileAnUploadIsStillArriving(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("419000", "")
	// File one lands. File two's session opens and stays open — the batch case
	// §3 of the protocol promises is allowed to finish.
	first := h.preUpload(t, "419000", bytes.Repeat([]byte("1"), 1000), 1)
	status, uploadID, _ := h.initPairUpload(t, "419000", 2000, "")
	if status != 200 {
		t.Fatalf("init the second file: %d", status)
	}
	h.join(t, "419000")
	room := h.roomOf(t, first)

	got := h.holdings(t, h.cookie)
	if len(got.Rooms) != 1 || got.Rooms[0].Releasable {
		t.Fatalf("a room with an upload still arriving reports itself releasable: %+v", got.Rooms)
	}
	code, body := h.release(t, h.cookie, room.ID)
	if code != 409 || !strings.Contains(body, "pair_room_uploading") {
		t.Fatalf("release while uploading: %d %s", code, body)
	}
	// Nothing was destroyed by the refusal.
	if !h.storedFileExists(t, first) {
		t.Fatal("a refused release still removed the first file")
	}
	// The in-flight upload finishes as promised, and the room becomes releasable
	// with no clock and no retry policy involved — the fact changed, so the
	// verdict changed.
	blob := bytes.Repeat([]byte("2"), 2000)
	if got := h.patch(t, uploadID, blob, 0, len(blob), len(blob)); got != 200 {
		t.Fatalf("patch: %d", got)
	}
	if st, _ := h.finalize(t, uploadID); st != 200 {
		t.Fatalf("finalize: %d", st)
	}
	after := h.holdings(t, h.cookie)
	if len(after.Rooms) != 1 || !after.Rooms[0].Releasable || after.Rooms[0].Objects != 2 {
		t.Fatalf("after the upload finished: %+v", after.Rooms)
	}
	if code, body := h.release(t, h.cookie, room.ID); code != 200 {
		t.Fatalf("release after the upload finished: %d %s", code, body)
	}
	if h.currentStorage(t) != 0 {
		t.Fatalf("storage is %d after releasing both files", h.currentStorage(t))
	}
}

// An unjoined room is nobody's to end from here. It has its own deadline, and it
// is what a pre-upload looks like while it is happening — including between two
// files of a batch, when no session is bound to it at all.
func TestAnUnjoinedRoomIsNeitherListedNorReleasable(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("420000", "")
	id := h.preUpload(t, "420000", bytes.Repeat([]byte("U"), 1400), 1)
	room := h.roomOf(t, id)

	if got := h.holdings(t, h.cookie); len(got.Rooms) != 0 || got.Totals.Rooms != 0 {
		t.Fatalf("an unjoined room is listed: %+v", got)
	}
	status, body := h.release(t, h.cookie, room.ID)
	if status != 409 || !strings.Contains(body, "pair_room_waiting") {
		t.Fatalf("release of an unjoined room: %d %s", status, body)
	}
	if !h.storedFileExists(t, id) {
		t.Fatal("the refusal still destroyed the pre-uploaded object")
	}
	if !h.codes.valid("420000") {
		t.Fatal("the refusal still revoked the code")
	}
	// A receiver arriving afterwards still gets the file: nothing about the
	// refused request may have changed the transfer's outcome.
	if st, _ := h.getAnon(t, "/api/files/"+id+"/blob"); st != 200 {
		t.Fatalf("the receiver's download after a refused release: %d", st)
	}
}

// A receiver completing the last object closes the room in the same transaction.
// A release arriving afterwards — the ordinary "two tabs" case — must be a no-op
// rather than a double reclaim or an error.
func TestAReleaseAfterTheReceiverCompletedTheTransferIsANoOp(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("421000", "")
	key := fileKeyN(42)
	id := h.preUploadCompletable(t, "421000", bytes.Repeat([]byte("C"), 2048), key)
	h.join(t, "421000")
	room := h.roomOf(t, id)

	resp, body := h.completeWithKey(t, id, key)
	if resp.StatusCode != 204 {
		t.Fatalf("completion: %d %s", resp.StatusCode, body)
	}
	intents := len(h.pendingDeletes(t))

	status, rbody := h.release(t, h.cookie, room.ID)
	if status != 200 {
		t.Fatalf("release after completion: %d %s", status, rbody)
	}
	if got := len(h.pendingDeletes(t)); got != intents {
		t.Fatalf("the release queued more work over a completed room: %d, was %d", got, intents)
	}
	if h.currentStorage(t) != 0 {
		t.Fatalf("storage is %d", h.currentStorage(t))
	}
}

// A room whose node cannot be reached still loses its rows, its quota and its
// code when it is released; the bytes are queued and GC keeps asking. "We are
// still holding your encrypted file because a machine of ours is offline" is not
// a release.
func TestAReleaseSurvivesAnUnreachableNode(t *testing.T) {
	h := newPairHarness(t)
	// The ciphertext lands on a real fleet node, and only THEN does the node go
	// away — the only ordering in which a placed object can become unreachable.
	node := newCommitThenFailNode(t)
	h.registerStorageNode(t, node.URL)
	uploadID := h.initOnNode(t, "422000")
	blob := bytes.Repeat([]byte("N"), 1800)
	if got := h.patch(t, uploadID, blob, 0, len(blob), len(blob)); got != 200 {
		t.Fatalf("patch: %d", got)
	}
	status, id := h.finalize(t, uploadID)
	if status != 200 {
		t.Fatalf("finalize: %d", status)
	}
	h.join(t, "422000")
	room := h.roomOf(t, id)
	sf := mustStoredFile(t, h, id)
	if sf.NodeID == "" {
		t.Fatal("the object did not land on the fleet node; the test staged nothing")
	}
	node.Server.Close() // and now nothing can reach it, to probe or to delete

	if status, body := h.release(t, h.cookie, room.ID); status != 200 {
		t.Fatalf("release: %d %s", status, body)
	}
	if h.storedFileExists(t, id) {
		t.Fatal("the object row survived a release against an unreachable node")
	}
	if h.currentStorage(t) != 0 {
		t.Fatalf("storage is %d: an offline machine of ours held the account's quota hostage", h.currentStorage(t))
	}
	if got, _, _ := h.store.GetPairRoom(context.Background(), room.ID); got.ClosedAt == 0 {
		t.Fatal("the room stayed open because a node was unreachable")
	}
	if h.codes.valid("422000") {
		t.Fatal("the code survived because a node was unreachable")
	}
	var queued bool
	for _, p := range h.pendingDeletes(t) {
		if p.BlobKey == sf.BlobKey {
			queued = true
		}
	}
	if !queued {
		t.Fatal("the unreachable node's blob has no durable delete intent, so nothing will ever retry it")
	}
}

// --- the feature flag ------------------------------------------------------

// The kill switch stops rooms being CREATED. It must not trap the rooms that
// already exist: a deployment that turns pre-upload off after a joined room
// exists would otherwise leave its owner charged for storage with no way to see
// or release it.
func TestTurningPreUploadOffStillLetsAnAccountSeeAndReleaseWhatItAlreadyHas(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("423000", "")
	blob := bytes.Repeat([]byte("F"), 2600)
	id, room := h.joinedRoom(t, "423000", blob)

	h.svc.SetPreUpload(false)

	// New rooms are refused, as the flag promises...
	if status, _, _ := h.initPairUpload(t, "423001", 100, ""); status != 503 {
		t.Fatalf("a new pre-upload with the flag off: %d, want 503", status)
	}
	// ...and the existing one is still visible and still releasable.
	got := h.holdings(t, h.cookie)
	if len(got.Rooms) != 1 || got.Rooms[0].ID != room.ID || got.Totals.Bytes != int64(len(blob)) {
		t.Fatalf("with the flag off the listing is %+v / %+v", got.Rooms, got.Totals)
	}
	if status, body := h.release(t, h.cookie, room.ID); status != 200 {
		t.Fatalf("release with the flag off: %d %s", status, body)
	}
	if h.storedFileExists(t, id) || h.currentStorage(t) != 0 {
		t.Fatalf("the release did nothing: row=%v storage=%d", h.storedFileExists(t, id), h.currentStorage(t))
	}
}

// --- helpers used above ----------------------------------------------------

func mustStoredFile(t *testing.T, h *pairHarness, id string) StoredFile {
	t.Helper()
	sf, err := h.store.GetStoredFile(context.Background(), id)
	if err != nil {
		t.Fatalf("stored file %s: %v", id, err)
	}
	return sf
}

// pastCodeLifetime is long enough that a pairing code minted before it has
// expired and its digits are free to be minted again — named so the reissue test
// above reads as what it is staging rather than as an arithmetic expression.
func pastCodeLifetime() int64 { return pairRoomJoinWindow + 1 }
