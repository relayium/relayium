package account

import (
	"bytes"
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// A finalized upload session is not deleted; it is left behind, done-claimed, as
// the tombstone that tells a repeated finalize apart from a finalize of an
// upload that never existed. These tests are the contract that tombstone owes:
// one 200 ever, 409 for every retry, 404 for every appender and every status
// probe, no open-session slot, no blob, and a reaper that eventually collects it
// without touching the object it produced.
//
// Everything here is deterministic and sequential ON PURPOSE. The property is
// not "concurrency is handled"; it is that the answer to a second finalize does
// not depend on timing at all. TestRacingFinalizesLandOneObjectAndItCarriesTheVerifier
// (pairroom_complete_test.go) is the concurrent form of the same contract, and
// it is the test the deleted row used to fail intermittently: five racers saw
// 409 or 404 depending on whether the winner's DELETE had landed yet.

// --- helpers ---------------------------------------------------------------

// finalizeOnce POSTs /finalize and returns (status, id). The id is "" for any
// non-200, which is every case below except the one that lands the object.
func finalizeOnce(t *testing.T, ts *httptest.Server, cookie *http.Cookie, uploadID string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest("POST", ts.URL+"/api/uploads/"+uploadID+"/finalize", nil)
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return resp.StatusCode, ""
	}
	var out struct {
		ID string `json:"id"`
	}
	decodeJSON(t, resp, &out)
	return http.StatusOK, out.ID
}

// uploadStatusCode is GET /api/uploads/{id} reduced to its status: this endpoint
// exists to say where to resume from, so for a terminal session the only
// interesting thing about it is that it refuses.
func uploadStatusCode(t *testing.T, ts *httptest.Server, cookie *http.Cookie, uploadID string) int {
	t.Helper()
	req, _ := http.NewRequest("GET", ts.URL+"/api/uploads/"+uploadID, nil)
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	return resp.StatusCode
}

// landOneUpload runs a whole share upload up to (but not including) finalize.
func landOneUpload(t *testing.T, ts *httptest.Server, cookie *http.Cookie, blob []byte) string {
	t.Helper()
	uploadID := initUpload(t, ts, cookie, []byte("MANIFEST"), len(blob), 0)
	if code, got := patchChunk(t, ts, cookie, uploadID, blob, 0, len(blob), len(blob)); code != 200 || got != int64(len(blob)) {
		t.Fatalf("patch: code=%d received=%d", code, got)
	}
	return uploadID
}

func sessionRowExists(t *testing.T, store *SQLiteStore, uploadID, userID string) bool {
	t.Helper()
	_, ok, err := store.GetUploadSession(context.Background(), uploadID, userID)
	if err != nil {
		t.Fatalf("read session: %v", err)
	}
	return ok
}

// uploadedThisMonth is the account's metered upload traffic for the current
// period — the number a double-billed retry would move.
func uploadedThisMonth(t *testing.T, store *SQLiteStore, userID string) int64 {
	t.Helper()
	up, _, err := store.MonthlyUsage(context.Background(), userID,
		time.Now().UTC().Format("200601"))
	if err != nil {
		t.Fatalf("monthly usage: %v", err)
	}
	return up
}

// downloadFile fetches an object's blob over the ordinary public path.
func downloadFile(t *testing.T, ts *httptest.Server, id string) (int, []byte) {
	t.Helper()
	resp, err := ts.Client().Get(ts.URL + "/api/files/" + id + "/blob")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}

// --- the contract ----------------------------------------------------------

// The headline property, and the one the deleted row could not provide: an
// upload is finalized exactly once, and every later attempt by its owner is told
// so — the SAME way, every time, with no dependence on how long ago the first
// one was.
//
// Five sequential attempts rather than two, because "the second one is 409" is
// also true of a design that stores one extra answer and then forgets it. The
// tombstone is what makes attempts three through five identical to two.
func TestFinalizeIsAnsweredOnceAndEveryRetryIsAConflict(t *testing.T) {
	ts, _, store, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "once@example.com")
	u, _ := store.UpsertUserByEmail(context.Background(), "once@example.com", "")

	blob := bytes.Repeat([]byte("F"), 900)
	uploadID := landOneUpload(t, ts, cookie, blob)

	status, id := finalizeOnce(t, ts, cookie, uploadID)
	if status != http.StatusOK || id == "" {
		t.Fatalf("first finalize = %d %q, want 200 and an object", status, id)
	}
	for attempt := 2; attempt <= 5; attempt++ {
		got, gotID := finalizeOnce(t, ts, cookie, uploadID)
		if got == http.StatusNotFound {
			t.Fatalf("finalize attempt %d = 404: the session was deleted, so a retry cannot "+
				"tell a spent upload from one that never existed", attempt)
		}
		if got != http.StatusConflict {
			t.Fatalf("finalize attempt %d = %d %q, want 409", attempt, got, gotID)
		}
	}
	// The retries changed nothing: one object, still whole.
	if !sessionRowExists(t, store, uploadID, u.ID) {
		t.Fatal("the terminal session row is gone, so the next retry would be answered 404")
	}
	code, got := downloadFile(t, ts, id)
	if code != 200 || !bytes.Equal(got, blob) {
		t.Fatalf("the object after four retried finalizes: %d, %d bytes", code, len(got))
	}
	// Lifetime stats counted the one upload that completed, not the five requests
	// — the retries take the 409 exit before AddUploadStat can run again.
	st, err := store.GetUserStats(context.Background(), u.ID)
	if err != nil {
		t.Fatalf("stats: %v", err)
	}
	if st.TransfersTotal != 1 || st.UploadBytes != int64(len(blob)) {
		t.Fatalf("lifetime stats = %d transfers / %d bytes, want 1 / %d",
			st.TransfersTotal, st.UploadBytes, len(blob))
	}
}

// A finalize the SERVER refused is just as terminal as one it granted — the
// claim is taken before any gate can say no, precisely so the bytes cannot be
// re-finalized into a second object. So the retry after a refusal must hear the
// same 409, not a 404 that reads as "wrong id" and not a second 429 that reads
// as "try again when your quota resets", which is the one thing that will never
// help: this upload is spent whatever the quota does next.
func TestARetryAfterARefusedFinalizeIsAlsoAConflict(t *testing.T) {
	const quota = 1 << 20
	ts, svc, store, mail := newFileServerWithQuota(t, quota, 1<<20)
	cookie := loginCookie(t, ts, mail, "refused@example.com")
	u, _ := store.UpsertUserByEmail(context.Background(), "refused@example.com", "")

	blob := bytes.Repeat([]byte("R"), 900)
	uploadID := landOneUpload(t, ts, cookie, blob)
	// The bytes are on the blob and already on the meter; the daily quota runs
	// out between the last chunk and the finalize. This is the ordinary way a
	// finalize is refused after its terminal claim.
	seedDailyUsage(t, svc, store, u.ID, quota)
	metered := uploadedThisMonth(t, store, u.ID)

	if got, _ := finalizeOnce(t, ts, cookie, uploadID); got != http.StatusTooManyRequests {
		t.Fatalf("finalize over quota = %d, want 429", got)
	}
	for attempt := 2; attempt <= 4; attempt++ {
		got, _ := finalizeOnce(t, ts, cookie, uploadID)
		if got == http.StatusNotFound {
			t.Fatalf("retry %d after a refusal = 404: the refusal deleted the session, so a "+
				"spent upload is indistinguishable from a bad id", attempt)
		}
		if got != http.StatusConflict {
			t.Fatalf("retry %d after a refusal = %d, want 409", attempt, got)
		}
	}
	// The refusal's cleanup still happened, and the retries did not undo or
	// repeat it: no object, and the bytes that moved stay billed exactly once.
	objects, err := store.ListStoredFilesByUser(context.Background(), u.ID)
	if err != nil {
		t.Fatalf("list objects: %v", err)
	}
	if len(objects) != 0 {
		t.Fatalf("a refused finalize (and its retries) produced %d objects", len(objects))
	}
	if got := uploadedThisMonth(t, store, u.ID); got != metered {
		t.Fatalf("metered %d after three retries, want the %d the refusal left", got, metered)
	}
	// And the session is a tombstone, not an open upload: no appending to it.
	if code, _ := patchChunk(t, ts, cookie, uploadID, blob, 0, len(blob), len(blob)); code != http.StatusNotFound {
		t.Fatalf("PATCH after a refused finalize = %d, want 404", code)
	}
}

// A terminal session answers a finalize and refuses everything else. Both other
// verbs, both terminal shapes (granted and refused): the row exists to make one
// answer possible, not to make the upload look alive.
//
// The status probe is the one that had to change. It reported `received` for any
// row it could read, which for a tombstone is an offset no PATCH will ever
// accept — a client resuming from it would loop forever against a 404 it was
// told not to expect.
func TestATerminalSessionRefusesChunksAndStatusProbes(t *testing.T) {
	const quota = 1 << 20
	blob := bytes.Repeat([]byte("T"), 900)

	t.Run("after a granted finalize", func(t *testing.T) {
		ts, _, _, mail := newFileServer(t)
		cookie := loginCookie(t, ts, mail, "granted@example.com")
		uploadID := landOneUpload(t, ts, cookie, blob)
		if got, _ := finalizeOnce(t, ts, cookie, uploadID); got != http.StatusOK {
			t.Fatalf("finalize: %d", got)
		}
		if code, _ := patchChunk(t, ts, cookie, uploadID, blob, 0, len(blob), len(blob)); code != http.StatusNotFound {
			t.Fatalf("PATCH on a finalized session = %d, want 404", code)
		}
		if got := uploadStatusCode(t, ts, cookie, uploadID); got != http.StatusNotFound {
			t.Fatalf("GET status on a finalized session = %d, want 404", got)
		}
	})

	t.Run("after a refused finalize", func(t *testing.T) {
		ts, svc, store, mail := newFileServerWithQuota(t, quota, 1<<20)
		cookie := loginCookie(t, ts, mail, "refused-probe@example.com")
		u, _ := store.UpsertUserByEmail(context.Background(), "refused-probe@example.com", "")
		uploadID := landOneUpload(t, ts, cookie, blob)
		seedDailyUsage(t, svc, store, u.ID, quota)
		if got, _ := finalizeOnce(t, ts, cookie, uploadID); got != http.StatusTooManyRequests {
			t.Fatalf("finalize over quota: %d", got)
		}
		if code, _ := patchChunk(t, ts, cookie, uploadID, blob, 0, len(blob), len(blob)); code != http.StatusNotFound {
			t.Fatalf("PATCH on a refused session = %d, want 404", code)
		}
		if got := uploadStatusCode(t, ts, cookie, uploadID); got != http.StatusNotFound {
			t.Fatalf("GET status on a refused session = %d, want 404", got)
		}
	})
}

// The tombstone belongs to its owner and to nobody else. A second account gets
// the same 404 it would get for an id that was never minted — on all three
// verbs — so keeping the row cannot turn /finalize into an oracle for whether
// some other account once uploaded something.
func TestATerminalSessionIsInvisibleToAnotherAccount(t *testing.T) {
	ts, _, _, mail := newFileServer(t)
	owner := loginCookie(t, ts, mail, "owner@example.com")
	blob := bytes.Repeat([]byte("O"), 900)
	uploadID := landOneUpload(t, ts, owner, blob)
	if got, _ := finalizeOnce(t, ts, owner, uploadID); got != http.StatusOK {
		t.Fatalf("finalize: %d", got)
	}
	outsider := loginCookie(t, ts, mail, "outsider@example.com")

	if got, _ := finalizeOnce(t, ts, outsider, uploadID); got != http.StatusNotFound {
		t.Fatalf("outsider finalize of a tombstone = %d, want 404 (409 would confirm it exists)", got)
	}
	if got := uploadStatusCode(t, ts, outsider, uploadID); got != http.StatusNotFound {
		t.Fatalf("outsider status of a tombstone = %d, want 404", got)
	}
	if code, _ := patchChunk(t, ts, outsider, uploadID, blob, 0, len(blob), len(blob)); code != http.StatusNotFound {
		t.Fatalf("outsider PATCH of a tombstone = %d, want 404", code)
	}
	// The same answer for digits that never named anything, which is the whole
	// point of the comparison.
	if got, _ := finalizeOnce(t, ts, outsider, "no-such-upload-id"); got != http.StatusNotFound {
		t.Fatalf("finalize of an id that never existed = %d, want 404", got)
	}
}

// The account's open-session budget counts uploads that can still be appended
// to. A tombstone cannot, so it must cost nothing — otherwise finishing five
// transfers would lock the account out of starting a sixth for an hour, which is
// a far worse bug than the one the tombstone fixes.
//
// The last assertion is what makes the first five load-bearing: the cap is still
// there and still refuses, so "all five succeeded" is a statement about
// tombstones rather than about a cap that stopped working.
func TestTerminalSessionsDoNotConsumeTheOpenSessionCap(t *testing.T) {
	ts, _, store, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "cap@example.com")
	u, _ := store.UpsertUserByEmail(context.Background(), "cap@example.com", "")
	blob := bytes.Repeat([]byte("C"), 100)

	// Fill the account with exactly maxSessionsPerUser tombstones.
	for i := range maxSessionsPerUser {
		uploadID := landOneUpload(t, ts, cookie, blob)
		if got, _ := finalizeOnce(t, ts, cookie, uploadID); got != http.StatusOK {
			t.Fatalf("finalize %d: %d", i, got)
		}
		if !sessionRowExists(t, store, uploadID, u.ID) {
			t.Fatalf("upload %d left no tombstone; this test is not staging what it means to", i)
		}
	}
	// ...and then open a full cap's worth of real sessions anyway.
	for i := range maxSessionsPerUser {
		if code := initUploadStatus(t, ts, cookie, []byte("M")); code != http.StatusOK {
			t.Fatalf("opening session %d alongside %d tombstones = %d, want 200",
				i+1, maxSessionsPerUser, code)
		}
	}
	// The cap itself is intact: the next one is refused.
	if code := initUploadStatus(t, ts, cookie, []byte("M")); code != http.StatusTooManyRequests {
		t.Fatalf("session %d = %d, want 429 — the cap is not being enforced at all",
			maxSessionsPerUser+1, code)
	}
}

// The tombstone is bounded, and the thing that bounds it must not take the
// object with it. The orphan pass drops the partial blob of a finalize that
// crashed; this row's blob is a live stored_files row, and the query that
// separates the two (ListOrphanDoneUploadSessions) is the only thing standing
// between the reaper and a file it must not delete.
//
// The last assertion states the boundary honestly rather than hiding it: after
// the purge the 409 is gone and a very late retry gets 404. That is deliberate —
// the row is a receipt for the client's retry window, not a permanent record —
// and pinning it here means a future change to the window is a visible decision.
func TestTheReaperCollectsTheTombstoneAndLeavesTheObjectAlone(t *testing.T) {
	ts, svc, store, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "reap@example.com")
	u, _ := store.UpsertUserByEmail(context.Background(), "reap@example.com", "")

	blob := bytes.Repeat([]byte("K"), 900)
	uploadID := landOneUpload(t, ts, cookie, blob)
	status, id := finalizeOnce(t, ts, cookie, uploadID)
	if status != http.StatusOK {
		t.Fatalf("finalize: %d", status)
	}
	sess, ok, err := store.GetUploadSession(context.Background(), uploadID, u.ID)
	if err != nil || !ok {
		t.Fatalf("the finalize left no tombstone: ok=%v err=%v", ok, err)
	}
	if !sess.Done {
		t.Fatal("the retained session is not done-claimed, so a retry would re-finalize it")
	}

	// One sweep, from far enough in the future that the row is idle past its TTL.
	svc.ReapPendingUploads(time.Now().Unix() + pendingUploadTTL + 60)

	if sessionRowExists(t, store, uploadID, u.ID) {
		t.Fatal("the reaper left the tombstone behind; it accumulates one row per upload forever")
	}
	// THE OBJECT IS UNTOUCHED — the assertion this whole test exists for.
	code, got := downloadFile(t, ts, id)
	if code != 200 || !bytes.Equal(got, blob) {
		t.Fatalf("the object after its session was reaped: %d, %d of %d bytes", code, len(got), len(blob))
	}
	// Nor was its blob queued for a later delete, which would destroy the object
	// on the next GC tick instead of this one.
	pend, err := store.ListPendingNodeDeletes(context.Background())
	if err != nil {
		t.Fatalf("pending deletes: %v", err)
	}
	for _, p := range pend {
		if p.BlobKey == sess.BlobKey {
			t.Fatalf("the reaper queued the live object's blob %s for deletion", p.BlobKey)
		}
	}
	// The documented boundary: past the window, the receipt is gone.
	if got, _ := finalizeOnce(t, ts, cookie, uploadID); got != http.StatusNotFound {
		t.Fatalf("finalize after the tombstone was reaped = %d, want 404", got)
	}
}

// The deterministic form of TestRacingFinalizesLandOneObjectAndItCarriesTheVerifier:
// same five attempts, same contract, no goroutines. Exactly one object, it
// carries the completion verifier, and none of the four losers is told 404.
//
// The concurrent test could only ever assert this probabilistically — which
// answer a loser got depended on whether the winner's DELETE had committed — so
// it failed intermittently under load for a real reason. This one cannot: with
// the delete gone, the losers' answer is a property of the row rather than of
// the schedule, and a sequential run is the strongest possible demonstration of
// that, because it is the case with the LONGEST gap between the winner and the
// losers.
func TestSequentialFinalizesOfOnePreUploadLandOneObjectWithItsVerifier(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("341000", "")
	key := fileKeyN(21)
	proof, err := pairRoomCompletionProof(key)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	want := pairRoomCompletionVerifier(proof)
	body := verifierBody(base64.RawURLEncoding.EncodeToString(want))

	blob := bytes.Repeat([]byte("S"), 2048)
	status, uploadID, _ := h.initPairUpload(t, "341000", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	if got := h.patch(t, uploadID, blob, 0, len(blob), len(blob)); got != 200 {
		t.Fatalf("patch: %d", got)
	}

	var ids []string
	for attempt := 1; attempt <= 5; attempt++ {
		s, id := h.finalizeWith(t, uploadID, body)
		switch s {
		case 200:
			ids = append(ids, id)
		case 409:
		default:
			t.Fatalf("finalize attempt %d = %d, want 200 once then 409", attempt, s)
		}
	}
	if len(ids) != 1 {
		t.Fatalf("five finalizes produced %d objects, want exactly 1", len(ids))
	}
	if got := h.storedVerifier(t, ids[0]); !bytes.Equal(got, want) {
		t.Fatalf("the object's verifier = %x, want %x", got, want)
	}
	if resp, _ := h.completeWithKey(t, ids[0], key); resp.StatusCode != 204 {
		t.Fatalf("completing the object: %d", resp.StatusCode)
	}
}

// A pair room asks its upload_sessions rows one question — is anything still
// arriving — and a tombstone is not an answer to it. Keeping the row would have
// told the owner their room is still uploading for an hour after the transfer
// finished, and refused the release they asked for.
//
// Three states of ONE room, in order, so the predicate is pinned from both
// sides rather than merely satisfied:
//
//  1. an OPEN session blocks the release (unchanged, and what makes 3 meaningful);
//  2. a RECOVERY-state session still blocks it — done = 1 too, but its node never
//     said how many bytes it took, and the close is what durably transfers that
//     unsettled bill. This is the half a plain `done = 0` would have dropped;
//  3. once it is settled it is an ordinary tombstone, and the release goes through.
func TestATombstoneDoesNotHoldItsPairRoomOpen(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	h.mintCode("342000", "")
	blob := bytes.Repeat([]byte("P"), 2048)

	// One finished pre-upload (leaving a tombstone) and one still in flight.
	h.preUpload(t, "342000", blob, 1)
	status, openID, _ := h.initPairUpload(t, "342000", len(blob), "")
	if status != 200 {
		t.Fatalf("init second: %d", status)
	}
	if got := h.patch(t, openID, blob, 0, 1024, len(blob)); got != 200 {
		t.Fatalf("patch second: %d", got)
	}
	h.join(t, "342000")
	room := h.roomFor(t, "342000")

	// 1. Still uploading, and the owner is told so.
	if code, body := h.release(t, h.cookie, room.ID); code != http.StatusConflict {
		t.Fatalf("release with an open session = %d %s, want 409", code, body)
	}
	if got := h.holdings(t, h.cookie); len(got.Rooms) != 1 || got.Rooms[0].Releasable {
		t.Fatalf("holdings report the room releasable while an upload is open: %+v", got.Rooms)
	}

	// 2. The open session's node went away mid-upload: terminal, but its true
	// size is unknown and the close is what bills the difference.
	sess := h.session(t, openID)
	moved, err := h.store.MarkUploadUnresolved(ctx, openID, h.now)
	if err != nil || !moved {
		t.Fatalf("move to recovery: moved=%v err=%v", moved, err)
	}
	if code, body := h.release(t, h.cookie, room.ID); code != http.StatusConflict {
		t.Fatalf("release with an unresolved session = %d %s, want 409 — an unknown bill is "+
			"not the same as nothing arriving", code, body)
	}
	if got := h.holdings(t, h.cookie); len(got.Rooms) != 1 || got.Rooms[0].Releasable {
		t.Fatalf("holdings report the room releasable while a bill is unresolved: %+v", got.Rooms)
	}

	// 3. The probe comes back and settles it. Now BOTH rows are ordinary
	// tombstones, and nothing is arriving.
	if _, err := h.store.SettleUnresolvedUpload(ctx, openID, sess.Received, h.now); err != nil {
		t.Fatalf("settle: %v", err)
	}
	if got := h.holdings(t, h.cookie); len(got.Rooms) != 1 || !got.Rooms[0].Releasable {
		t.Fatalf("holdings still report the room as uploading with only tombstones left: %+v", got.Rooms)
	}
	if code, body := h.release(t, h.cookie, room.ID); code != http.StatusOK {
		t.Fatalf("release with only tombstones left = %d %s, want 200 — the transfer is over",
			code, body)
	}
}
