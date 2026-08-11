package account

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/signal"
	"github.com/relayium/relayium/internal/storage"
)

// Adversarial suite for code-first pre-upload. Each test names the property it
// would catch losing; none of them assert an implementation detail that a
// different-but-correct lifecycle would fail.

// pairHarness is a stored-transfer server with a movable clock and a fake
// pairing-code registry, so a test can make a deadline pass without sleeping and
// can mint a code owned by whoever it likes.
type pairHarness struct {
	ts     *httptest.Server
	svc    *Service
	store  *SQLiteStore
	disk   *storage.DiskStore
	cookie *http.Cookie
	userID string
	now    int64
	// codes is the live pairing-code registry, in miniature. The real one is
	// signal.PairRegistry, in memory in the signaling layer; the account layer
	// only ever sees it through the PairCodes interface, which is exactly what
	// this implements.
	//
	// It carries EXPIRIES, not just owners, and that is the point: a code dies
	// signal.CodeTTLSeconds after it is minted unless something moves it, so a
	// fake without a clock would hide the whole bug this suite exists to pin —
	// a progressing pre-upload whose own code has quietly expired underneath it.
	// TestARealPairRegistryFollowsAProgressingUpload runs the real object over
	// the same path so the two cannot drift.
	codes *fakeCodes
}

// fakeCodes mirrors signal.PairRegistry's three lifetime rules: owner-bound,
// forward-only, never a resurrection.
type fakeCodes struct {
	now   func() int64
	codes map[string]fakeCode
}

type fakeCode struct {
	owner string
	exp   int64
}

func (f *fakeCodes) OwnerOf(code string) (string, bool) {
	e, ok := f.codes[code]
	if !ok || e.exp <= f.now() {
		return "", false
	}
	return e.owner, true
}

func (f *fakeCodes) valid(code string) bool {
	_, ok := f.OwnerOf(code)
	return ok
}

func (f *fakeCodes) ExtendFor(code, owner string, until int64) bool {
	e, ok := f.codes[code]
	if !ok || e.exp <= f.now() || e.owner != owner {
		return false
	}
	if until > e.exp {
		e.exp = until
		f.codes[code] = e
	}
	return true
}

func (f *fakeCodes) RevokeFor(code, owner string, notAfter int64) bool {
	e, ok := f.codes[code]
	if !ok || e.owner != owner || e.exp > notAfter {
		return false
	}
	delete(f.codes, code)
	return true
}

func newPairHarness(t *testing.T) *pairHarness {
	t.Helper()
	store := newTestStore(t)
	mail := &capturingMailer{}
	svc := NewService(store, mail, Config{
		BaseURL: "http://example.test",
		// Longer than the six-hour pairRoomMaxJoinable ceiling: this harness moves
		// its clock by hours to reach a room's outer bound, and a sender being
		// logged out at hour one is a property of the harness rather than of
		// anything under test here.
		SessionTTL: 24 * time.Hour, MagicTTL: 15 * time.Minute,
		EnableMagic: true,
		// Room enough for the multi-chunk uploads below; the daily quota is far
		// above minBillableBytes so the 64 KiB floor never decides a test.
		MaxFileSize: 1 << 20, DailyQuota: 64 << 20, DefaultTTL: 3600, MaxTTL: 7200,
		DefaultRetention: retentionTTL, AccountGraceDays: 30,
	})
	svc.nodeHTTP.Transport.(*http.Transport).DialContext = guardedDialContext(true)
	disk, err := storage.NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatalf("disk: %v", err)
	}
	svc.SetBlobStore(disk)
	h := &pairHarness{
		svc: svc, store: store, disk: disk,
		now: 1_767_312_000, // 2026-01-02 00:00:00 UTC
	}
	h.codes = &fakeCodes{now: func() int64 { return h.now }, codes: map[string]fakeCode{}}
	svc.now = func() time.Time { return time.Unix(h.now, 0) }
	svc.SetPairCodes(h.codes)
	// Pre-upload is off unless a deployment opts in, so every test of it has to
	// say so. TestPreUploadIsOffUnlessTheDeploymentTurnsItOn is the one that does
	// not, and asserts the default.
	svc.SetPreUpload(true)
	h.ts = httptest.NewServer(svc.Routes())
	t.Cleanup(h.ts.Close)
	h.cookie = loginCookie(t, h.ts, mail, "sender@example.com")
	u, err := store.UpsertUserByEmail(context.Background(), "sender@example.com", "Sender")
	if err != nil {
		t.Fatalf("resolve user: %v", err)
	}
	h.userID = u.ID
	return h
}

// mintCode makes `code` a live pairing code owned by owner ("" = this harness's
// signed-in user), on the same terms the real registry mints one: alive for
// signal.CodeTTLSeconds from now, and no longer unless something extends it.
func (h *pairHarness) mintCode(code, owner string) {
	if owner == "" {
		owner = h.userID
	}
	h.codes.codes[code] = fakeCode{owner: owner, exp: h.now + signal.CodeTTLSeconds}
}

// advance moves the clock. Nothing else happens: no sweep, no GC, no reaper —
// which is the point of every expiry test below.
func (h *pairHarness) advance(seconds int64) { h.now += seconds }

// initPairUpload starts a pre-upload for `code` and returns (status, uploadId,
// chunkSize).
func (h *pairHarness) initPairUpload(t *testing.T, code string, size int, extra string) (int, string, int64) {
	t.Helper()
	var body bytes.Buffer
	manifest := []byte("OPAQUE-ENCRYPTED-MANIFEST")
	_ = binary.Write(&body, binary.BigEndian, uint32(len(manifest)))
	body.Write(manifest)
	url := h.ts.URL + "/api/uploads?purpose=pair_room&code=" + code + "&size=" + strconv.Itoa(size) + extra
	req, _ := http.NewRequest("POST", url, &body)
	req.AddCookie(h.cookie)
	resp, err := h.ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return resp.StatusCode, "", 0
	}
	var out struct {
		UploadID  string `json:"uploadId"`
		ChunkSize int64  `json:"chunkSize"`
	}
	decodeJSON(t, resp, &out)
	return 200, out.UploadID, out.ChunkSize
}

func (h *pairHarness) patch(t *testing.T, uploadID string, blob []byte, start, end, total int) int {
	t.Helper()
	status, _ := patchChunk(t, h.ts, h.cookie, uploadID, blob, start, end, total)
	return status
}

func (h *pairHarness) finalize(t *testing.T, uploadID string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest("POST", h.ts.URL+"/api/uploads/"+uploadID+"/finalize", nil)
	req.AddCookie(h.cookie)
	resp, err := h.ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return resp.StatusCode, ""
	}
	var out struct {
		ID string `json:"id"`
	}
	decodeJSON(t, resp, &out)
	return 200, out.ID
}

// preUpload runs a whole pre-upload of `blob` in `chunks` pieces and returns the
// stored object's id.
func (h *pairHarness) preUpload(t *testing.T, code string, blob []byte, chunks int) string {
	t.Helper()
	status, uploadID, _ := h.initPairUpload(t, code, len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	per := (len(blob) + chunks - 1) / chunks
	for start := 0; start < len(blob); start += per {
		end := min(start+per, len(blob))
		if got := h.patch(t, uploadID, blob, start, end, len(blob)); got != 200 {
			t.Fatalf("patch %d-%d: %d", start, end, got)
		}
	}
	status, id := h.finalize(t, uploadID)
	if status != 200 {
		t.Fatalf("finalize: %d", status)
	}
	return id
}

// getAnon fetches a URL with NO cookie at all — the receiver's real situation.
func (h *pairHarness) getAnon(t *testing.T, path string) (int, []byte) {
	t.Helper()
	req, _ := http.NewRequest("GET", h.ts.URL+path, nil)
	resp, err := h.ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}

func (h *pairHarness) blobExists(t *testing.T, blobKey string) bool {
	t.Helper()
	rc, err := h.disk.GetRange(context.Background(), blobKey, 0)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			return false
		}
		t.Fatalf("blob read: %v", err)
	}
	rc.Close()
	return true
}

func (h *pairHarness) uploadMetered(t *testing.T) int64 {
	t.Helper()
	up, _, err := h.store.MonthlyUsage(context.Background(), h.userID, time.Unix(h.now, 0).UTC().Format("200601"))
	if err != nil {
		t.Fatalf("usage: %v", err)
	}
	return up
}

// A receiver holds six digits and, over the peers' own encrypted channel, an id
// and a key. It has no account, and this is the whole download path it gets.
func TestPairRoomReceiverIsAnonymousAndSenderKeepsNoLink(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("123456", "")
	blob := bytes.Repeat([]byte("C"), 3000)
	id := h.preUpload(t, "123456", blob, 3)

	status, body := h.getAnon(t, "/api/files/"+id+"/meta")
	if status != 200 {
		t.Fatalf("anonymous /meta: %d %s", status, body)
	}
	status, got := h.getAnon(t, "/api/files/"+id+"/blob")
	if status != 200 {
		t.Fatalf("anonymous /blob: %d", status)
	}
	if !bytes.Equal(got, blob) {
		t.Fatalf("blob mismatch: %d of %d bytes", len(got), len(blob))
	}

	// It is delivery ciphertext, not a share: it must not appear in the account's
	// file list (which offers a link, a download count and a delete button, none
	// of which apply) and the share-delete route must not reach it.
	req, _ := http.NewRequest("GET", h.ts.URL+"/api/files", nil)
	req.AddCookie(h.cookie)
	resp, _ := h.ts.Client().Do(req)
	var list struct {
		Files []struct {
			ID string `json:"id"`
		} `json:"files"`
	}
	decodeJSON(t, resp, &list)
	resp.Body.Close()
	for _, f := range list.Files {
		if f.ID == id {
			t.Fatal("a pre-uploaded object appeared in the account's share list")
		}
	}
	dreq, _ := http.NewRequest("DELETE", h.ts.URL+"/api/files/"+id, nil)
	dreq.AddCookie(h.cookie)
	dresp, _ := h.ts.Client().Do(dreq)
	dresp.Body.Close()
	if dresp.StatusCode != 404 {
		t.Fatalf("share-delete of a pair-room object: %d, want 404", dresp.StatusCode)
	}
}

// The deadline must be true on disk, not merely true in a query. Nothing sweeps
// in this test: no GC, no reaper, no background goroutine. The first read after
// the deadline is what has to take the ciphertext away.
func TestPairRoomExpiryDeletesCiphertextWithoutASweep(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("222222", "")
	id := h.preUpload(t, "222222", bytes.Repeat([]byte("X"), 2048), 2)

	sf, err := h.store.GetStoredFile(context.Background(), id)
	if err != nil {
		t.Fatalf("stored file: %v", err)
	}
	if !h.blobExists(t, sf.BlobKey) {
		t.Fatal("blob missing before the deadline")
	}
	if sf.PairRoomID == "" {
		t.Fatal("pre-uploaded object is not bound to a room")
	}

	h.advance(pairRoomJoinWindow + 1)
	if status, _ := h.getAnon(t, "/api/files/"+id+"/meta"); status != 404 {
		t.Fatalf("/meta after the join deadline: %d, want 404", status)
	}
	if _, err := h.store.GetStoredFile(context.Background(), id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("row still present after the deadline: %v", err)
	}
	if h.blobExists(t, sf.BlobKey) {
		t.Fatal("ciphertext still on disk after the deadline — expiry waited for GC")
	}
	room, found, _ := h.store.GetPairRoom(context.Background(), sf.PairRoomID)
	if !found || room.ClosedAt == 0 {
		t.Fatalf("room not closed by the read: found=%v room=%+v", found, room)
	}
}

// The join window follows real progress — a ten-minute upload must not kill its
// own code at T+5 — but only real progress, and only up to a ceiling the server
// picks. A client that drips one byte per interval must not own a code forever.
func TestPairRoomJoinDeadlineFollowsProgressButIsBounded(t *testing.T) {
	open := int64(1000)
	room := PairRoom{CreatedAt: open}

	if got := pairRoomJoinDeadline(room); got != open+pairRoomJoinWindow {
		t.Fatalf("fresh room deadline = %d, want %d", got, open+pairRoomJoinWindow)
	}
	// A long upload that keeps committing keeps the code alive past its own
	// nominal five minutes — this is B1's whole point.
	progressing := room
	progressing.LastUploadAt = open + 10*60
	if !pairRoomJoinable(progressing, open+10*60+10) {
		t.Fatal("a room whose upload is still progressing stopped being joinable")
	}
	if got := pairRoomJoinDeadline(progressing); got != open+10*60+pairRoomJoinWindow {
		t.Fatalf("progressing deadline = %d, want last upload + window", got)
	}
	// ...and the final window starts at the last byte, not at the mint.
	if pairRoomJoinable(progressing, open+10*60+pairRoomJoinWindow) {
		t.Fatal("still joinable at exactly last-upload + window")
	}
	// A trickle that keeps committing past the ceiling gets nothing more.
	trickled := room
	trickled.LastUploadAt = open + pairRoomMaxJoinable + 99999
	if got := pairRoomJoinDeadline(trickled); got != open+pairRoomMaxJoinable {
		t.Fatalf("trickled deadline = %d, want the ceiling %d", got, open+pairRoomMaxJoinable)
	}
	if pairRoomJoinable(trickled, open+pairRoomMaxJoinable) {
		t.Fatal("a trickled upload held the code past the absolute ceiling")
	}
	// A stall is bounded by the same rule from the other direction: no progress
	// for one window and the room is over even though it once was progressing.
	stalled := room
	stalled.LastUploadAt = open + 60
	if pairRoomJoinable(stalled, open+60+pairRoomJoinWindow+1) {
		t.Fatal("a stalled upload kept the code joinable past the idle bound")
	}
}

// The same bound, through the HTTP surface: an append for a room whose ceiling
// has passed is refused, and refusing also voids — the client cannot keep
// spending our disk on ciphertext nobody can ever read.
func TestPairRoomStalledUploadIsRefusedAndVoided(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("333333", "")
	blob := bytes.Repeat([]byte("S"), 4000)
	status, uploadID, chunk := h.initPairUpload(t, "333333", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	// A pre-upload is told to use small chunks precisely so that "no progress for
	// a whole window" means a stalled client, not a slow one.
	if chunk != pairRoomChunkSize {
		t.Fatalf("pre-upload chunkSize = %d, want %d", chunk, pairRoomChunkSize)
	}
	if got := h.patch(t, uploadID, blob, 0, 1000, len(blob)); got != 200 {
		t.Fatalf("first chunk: %d", got)
	}
	// Progress keeps it alive across more than one window...
	for _, at := range []int{2000, 3000} {
		h.advance(pairRoomJoinWindow - 10)
		if got := h.patch(t, uploadID, blob, at-1000, at, len(blob)); got != 200 {
			t.Fatalf("chunk to %d after a near-window gap: %d", at, got)
		}
	}
	// ...and stalling does not.
	h.advance(pairRoomJoinWindow + 1)
	if got := h.patch(t, uploadID, blob, 3000, 4000, len(blob)); got != 410 {
		t.Fatalf("append after a full idle window: %d, want 410", got)
	}
	if status, _ := h.finalize(t, uploadID); status != 410 && status != 404 {
		t.Fatalf("finalize of a stalled pre-upload: %d, want 410/404", status)
	}
}

// Bytes that crossed the wire are billed even though no object was ever created.
// Without this an abandoned chunked upload is an unmetered bandwidth channel.
func TestPartialPreUploadIsBilledForWhatMoved(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("444444", "")
	blob := bytes.Repeat([]byte("P"), 3000)
	status, uploadID, _ := h.initPairUpload(t, "444444", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	if h.uploadMetered(t) != 0 {
		t.Fatal("init alone was metered")
	}
	if got := h.patch(t, uploadID, blob, 0, 1200, len(blob)); got != 200 {
		t.Fatalf("chunk: %d", got)
	}
	if got := h.uploadMetered(t); got != 1200 {
		t.Fatalf("after one chunk metered = %d, want 1200", got)
	}
	if got := h.patch(t, uploadID, blob, 1200, 2000, len(blob)); got != 200 {
		t.Fatalf("chunk 2: %d", got)
	}
	if got := h.uploadMetered(t); got != 2000 {
		t.Fatalf("after two chunks metered = %d, want 2000", got)
	}
	// Abandon it. The reaper reclaims the partial blob; the bill stands.
	h.svc.ReapPendingUploads(h.now + pendingUploadTTL + 1)
	if got := h.uploadMetered(t); got != 2000 {
		t.Fatalf("after abandonment metered = %d, want the 2000 that moved", got)
	}
}

// The other half of the same property: finishing must not bill the object twice
// now that every append bills itself.
func TestFinalizeBillsOnlyTheUnbilledRemainder(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("555555", "")
	blob := bytes.Repeat([]byte("F"), 2400)
	h.preUpload(t, "555555", blob, 3)
	if got := h.uploadMetered(t); got != int64(len(blob)) {
		t.Fatalf("metered = %d, want exactly the %d bytes uploaded", got, len(blob))
	}
}

// An ordinary share upload is billed exactly once too — the per-append change is
// not allowed to double-charge the path that has always worked.
func TestShareUploadStillBilledExactlyOnce(t *testing.T) {
	h := newPairHarness(t)
	blob := bytes.Repeat([]byte("H"), 1800)
	uploadID := initUpload(t, h.ts, h.cookie, []byte("M"), len(blob), 0)
	for _, r := range [][2]int{{0, 900}, {900, 1800}} {
		if code, _ := patchChunk(t, h.ts, h.cookie, uploadID, blob, r[0], r[1], len(blob)); code != 200 {
			t.Fatalf("chunk %v: %d", r, code)
		}
	}
	freq, _ := http.NewRequest("POST", h.ts.URL+"/api/uploads/"+uploadID+"/finalize", nil)
	freq.AddCookie(h.cookie)
	fresp, _ := h.ts.Client().Do(freq)
	fresp.Body.Close()
	if fresp.StatusCode != 200 {
		t.Fatalf("finalize: %d", fresp.StatusCode)
	}
	if got := h.uploadMetered(t); got != int64(len(blob)) {
		t.Fatalf("share upload metered = %d, want %d", got, len(blob))
	}
}

// A single-shot upload the server refuses mid-body still crossed the network.
// Before this, hanging up (or overshooting the cap) was free bandwidth.
func TestFailedSingleShotUploadIsStillBilled(t *testing.T) {
	h := newPairHarness(t)
	oversize := bytes.Repeat([]byte("O"), (1<<20)+4096) // past MaxFileSize
	resp := postUpload(t, h.ts, h.cookie, "?ttl=0", uploadBody([]byte("M"), oversize))
	resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize upload: %d, want 413", resp.StatusCode)
	}
	if got := h.uploadMetered(t); got <= 0 {
		t.Fatal("a refused single-shot upload was free bandwidth")
	}
}

// Joining stops the join clock and starts NOTHING in its place. Not a transfer
// deadline, not a "storage backstop" measured in hours — no clock at all. This
// is the owner's rule stated literally, and the test is deliberately extreme
// because the previous implementation satisfied every gentler version of it: it
// kept a 24-hour window, called it storage rather than transfer, and deleted the
// ciphertext at the end of it anyway.
func TestJoinEndsTheDeadlineAndImposesNoDeadlineAtAll(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("666666", "")
	id := h.preUpload(t, "666666", bytes.Repeat([]byte("J"), 2048), 2)

	ctx := context.Background()
	h.advance(60)
	h.svc.MarkPairRoomJoined(ctx, "666666")

	sf, err := h.store.GetStoredFile(ctx, id)
	if err != nil {
		t.Fatalf("stored file: %v", err)
	}
	room, _, _ := h.store.GetPairRoom(ctx, sf.PairRoomID)
	firstExpiry := room.ExpiresAt

	// A second notification (a reconnect, a third connection, a duplicate
	// observer call) must not re-stamp the join.
	h.advance(600)
	h.svc.MarkPairRoomJoined(ctx, "666666")
	room, _, _ = h.store.GetPairRoom(ctx, sf.PairRoomID)
	if room.ExpiresAt != firstExpiry {
		t.Fatalf("a repeated join moved the deadline %d -> %d", firstExpiry, room.ExpiresAt)
	}

	// A year later — past any window anyone would call a backstop — every truth-
	// bearing path still says the ciphertext is there. Each of these deletes on a
	// passed deadline, so passing all four is the assertion that no deadline
	// passed: the public read, the room sweep GC would run, and the file sweep GC
	// would run.
	h.advance(365 * 24 * 3600)
	h.svc.SweepPairRooms(ctx, h.now)
	expired, err := h.store.ListExpiredStoredFiles(ctx, h.now)
	if err != nil {
		t.Fatalf("list expired: %v", err)
	}
	for _, f := range expired {
		if f.ID == id {
			t.Fatal("a joined room's object was listed as expired a year later — a clock was imposed on a joined transfer")
		}
	}
	if status, _ := h.getAnon(t, "/api/files/"+id+"/blob"); status != 200 {
		t.Fatalf("blob a year after joining: %d, want 200 — a joined transfer was cut off by a clock", status)
	}
	if !h.blobExists(t, sf.BlobKey) {
		t.Fatal("a joined room's ciphertext was deleted by a clock")
	}
}

// The other half of that rule, and the reason it is affordable to state: nothing
// can create a room at all unless the deployment opted in. A joined room has no
// expiry and no completion lifecycle yet, so an operator who has not asked for
// that storage commitment does not get it — and gets it explicitly, not as a
// 403 that reads like a bad code.
func TestPreUploadIsOffUnlessTheDeploymentTurnsItOn(t *testing.T) {
	h := newPairHarness(t)
	h.svc.SetPreUpload(false)
	h.mintCode("112233", "")

	if status, _, _ := h.initPairUpload(t, "112233", 1024, ""); status != 503 {
		t.Fatalf("pre-upload with the feature off: %d, want 503", status)
	}
	if _, found, _ := h.store.LivePairRoomByCode(context.Background(), "112233"); found {
		t.Fatal("a refused pre-upload created a room anyway")
	}
	// The rest of the server is untouched by the gate: an ordinary share still
	// uploads.
	blob := bytes.Repeat([]byte("S"), 512)
	uploadID := initUpload(t, h.ts, h.cookie, []byte("M"), len(blob), 0)
	if code, _ := patchChunk(t, h.ts, h.cookie, uploadID, blob, 0, len(blob), len(blob)); code != 200 {
		t.Fatalf("share upload while pre-upload is off: %d", code)
	}
	if status, _ := h.finalize(t, uploadID); status != 200 {
		t.Fatalf("share finalize while pre-upload is off: %d", status)
	}
}

// Somebody who arrives after the deadline gets nothing, and the arrival itself
// is what takes the ciphertext away.
func TestLateJoinVoidsTheCiphertext(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("777777", "")
	id := h.preUpload(t, "777777", bytes.Repeat([]byte("L"), 1024), 1)
	sf, _ := h.store.GetStoredFile(context.Background(), id)

	h.advance(pairRoomJoinWindow + 5)
	h.svc.MarkPairRoomJoined(context.Background(), "777777")

	if _, err := h.store.GetStoredFile(context.Background(), id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("late join left the row behind: %v", err)
	}
	if h.blobExists(t, sf.BlobKey) {
		t.Fatal("late join left the ciphertext on disk")
	}
}

// Pre-uploading into a code is gated on OWNING that code. Without this any
// signed-in account could push ciphertext into a stranger's room.
func TestPreUploadRequiresAnOwnedLiveCode(t *testing.T) {
	h := newPairHarness(t)
	other, err := h.store.UpsertUserByEmail(context.Background(), "other@example.com", "Other")
	if err != nil {
		t.Fatal(err)
	}
	h.mintCode("888888", other.ID) // live, but somebody else's

	for _, tc := range []struct {
		name, code string
		want       int
	}{
		{"unknown code", "999999", 403},
		{"another account's code", "888888", 403},
		{"not a code at all", "abcdef", 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if status, _, _ := h.initPairUpload(t, tc.code, 10, ""); status != tc.want {
				t.Fatalf("init with %s: %d, want %d", tc.name, status, tc.want)
			}
		})
	}

	// And no room was created for any of them: a refused binding must not leave
	// lifecycle state behind for a later, legitimate mint to inherit.
	for _, code := range []string{"999999", "888888", "abcdef"} {
		if _, found, _ := h.store.LivePairRoomByCode(context.Background(), code); found {
			t.Fatalf("a refused pre-upload created a room for %s", code)
		}
	}
}

// Once the peer is here, the accelerated path is closed: anything new goes over
// the live link. This is what keeps a single file from being split across two
// transports, at the only place the decision can be made.
func TestPreUploadRefusedOnceSomebodyJoined(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("121212", "")
	h.preUpload(t, "121212", bytes.Repeat([]byte("A"), 1024), 1)
	h.svc.MarkPairRoomJoined(context.Background(), "121212")

	if status, _, _ := h.initPairUpload(t, "121212", 1024, ""); status != 409 {
		t.Fatalf("pre-upload into a joined room: %d, want 409", status)
	}
}

// An upload that is already running when the peer arrives is allowed to finish —
// it is paid for, and killing it would be the "split a file" failure by another
// name.
func TestUploadInFlightAtJoinIsAllowedToFinish(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("131313", "")
	blob := bytes.Repeat([]byte("I"), 3000)
	status, uploadID, _ := h.initPairUpload(t, "131313", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	if got := h.patch(t, uploadID, blob, 0, 1500, len(blob)); got != 200 {
		t.Fatalf("first half: %d", got)
	}
	h.svc.MarkPairRoomJoined(context.Background(), "131313")
	if got := h.patch(t, uploadID, blob, 1500, 3000, len(blob)); got != 200 {
		t.Fatalf("second half after the join: %d, want 200", got)
	}
	if status, id := h.finalize(t, uploadID); status != 200 {
		t.Fatalf("finalize after the join: %d", status)
	} else if s, _ := h.getAnon(t, "/api/files/"+id+"/blob"); s != 200 {
		t.Fatalf("object finalized after the join is unreadable: %d", s)
	}
}

// Retention is the room's, and a caller must not be able to describe a different
// object than the one this is.
func TestPreUploadRefusesCallerChosenRetention(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("141414", "")
	for _, extra := range []string{"&burnAfterRead=1", "&maxDownloads=3", "&ttl=86400"} {
		if status, _, _ := h.initPairUpload(t, "141414", 10, extra); status != 400 {
			t.Fatalf("init with %s: %d, want 400", extra, status)
		}
	}
}

// Pre-upload is resumable-only, and says so instead of half-working.
func TestSingleShotPreUploadIsRefused(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("151515", "")
	resp := postUpload(t, h.ts, h.cookie, "?purpose=pair_room&code=151515",
		uploadBody([]byte("M"), []byte("ciphertext")))
	resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatalf("single-shot pre-upload: %d, want 400", resp.StatusCode)
	}
}

// The server is not given a key, and has nowhere to put one if it were.
//
// Asserted structurally rather than by inspecting one request: a future column
// or field called "key" would pass any behavioural test right up until something
// wrote to it.
func TestPairRoomHoldsNoKeyMaterial(t *testing.T) {
	var cols []string
	rows, err := newPairHarness(t).store.db.Query(`PRAGMA table_info(pair_rooms)`)
	if err != nil {
		t.Fatalf("schema: %v", err)
	}
	for rows.Next() {
		var cid int
		var name, typ string
		var notnull, pk int
		var dflt any
		if err := rows.Scan(&cid, &name, &typ, &notnull, &dflt, &pk); err != nil {
			rows.Close()
			t.Fatalf("scan: %v", err)
		}
		cols = append(cols, name)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}
	sort.Strings(cols)
	want := []string{"closed_at", "code", "created_at", "expires_at", "id", "joined_at",
		"last_upload_at", "user_id"}
	if !reflect.DeepEqual(cols, want) {
		t.Fatalf("pair_rooms columns = %v, want exactly %v", cols, want)
	}
	// The Go struct is the other half of the same promise, and is where a field
	// would be added first.
	rt := reflect.TypeOf(PairRoom{})
	for i := 0; i < rt.NumField(); i++ {
		name := strings.ToLower(rt.Field(i).Name)
		for _, forbidden := range []string{"key", "secret", "name", "manifest", "plain"} {
			if strings.Contains(name, forbidden) {
				t.Fatalf("PairRoom.%s looks like key or plaintext material", rt.Field(i).Name)
			}
		}
	}
}

// Everything that worked before still works, unchanged: an upload that says
// nothing is a share, with the share chunk size and share retention, publicly
// readable; a device-task object is still refused on the public endpoints.
func TestPairRoomChangesNothingForExistingPurposes(t *testing.T) {
	st := Settings{DefaultTTL: 3600, MaxTTL: 7200, DefaultRetention: retentionTTL}
	purpose, ttl, maxDL, ok := resolveUploadRetention(nil, st)
	if !ok || purpose != StoredPurposeShare || ttl != 3600 || maxDL != 0 {
		t.Fatalf("a parameterless upload resolved to %q ttl=%d maxDL=%d ok=%v", purpose, ttl, maxDL, ok)
	}
	if got := chunkSizeFor(StoredPurposeShare); got != uploadChunkSize {
		t.Fatalf("share chunkSize = %d, want the unchanged %d", got, uploadChunkSize)
	}
	if got := chunkSizeFor(StoredPurposeDeviceTask); got != uploadChunkSize {
		t.Fatalf("device-task chunkSize = %d, want the unchanged %d", got, uploadChunkSize)
	}
	if directDownloadEligible(StoredPurposeDeviceTask) {
		t.Fatal("a device-task object became direct-download eligible")
	}
	if !directDownloadEligible(StoredPurposeShare) {
		t.Fatal("a share stopped being direct-download eligible")
	}
	if !isValidStoredPurpose(StoredPurposePairRoom) {
		t.Fatal("pair_room is not a recognised purpose")
	}

	// A row written before this column existed reads as the share it has always
	// been, and is served.
	h := newPairHarness(t)
	blob := bytes.Repeat([]byte("B"), 512)
	uploadID := initUpload(t, h.ts, h.cookie, []byte("M"), len(blob), 0)
	if code, _ := patchChunk(t, h.ts, h.cookie, uploadID, blob, 0, len(blob), len(blob)); code != 200 {
		t.Fatalf("legacy-shaped upload chunk: %d", code)
	}
	status, id := h.finalize(t, uploadID)
	if status != 200 {
		t.Fatalf("finalize: %d", status)
	}
	if _, err := h.store.db.Exec(`UPDATE stored_files SET purpose = '', pair_room_id = '' WHERE id = ?`, id); err != nil {
		t.Fatalf("simulate a pre-migration row: %v", err)
	}
	if s, _ := h.getAnon(t, "/api/files/"+id+"/blob"); s != 200 {
		t.Fatalf("a pre-migration share stopped being readable: %d", s)
	}
}

// A pair-room object whose room row is gone is unreachable ciphertext: no
// deadline can be evaluated for it, so it must fail closed AND be reclaimed
// rather than lingering as an object nothing can ever expire.
func TestPairRoomObjectWithoutARoomIsReclaimed(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("161616", "")
	id := h.preUpload(t, "161616", bytes.Repeat([]byte("R"), 1024), 1)
	sf, _ := h.store.GetStoredFile(context.Background(), id)
	if _, err := h.store.db.Exec(`DELETE FROM pair_rooms WHERE id = ?`, sf.PairRoomID); err != nil {
		t.Fatalf("drop room: %v", err)
	}
	if status, _ := h.getAnon(t, "/api/files/"+id+"/meta"); status != 404 {
		t.Fatalf("orphaned pair-room object: %d, want 404", status)
	}
	if _, err := h.store.GetStoredFile(context.Background(), id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("orphaned object was not reclaimed: %v", err)
	}
	if h.blobExists(t, sf.BlobKey) {
		t.Fatal("orphaned ciphertext left on disk")
	}
}

// GC is the backstop for a room nobody ever reads again — and only that.
func TestSweepPairRoomsVoidsUnreadRooms(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("171717", "")
	id := h.preUpload(t, "171717", bytes.Repeat([]byte("G"), 1024), 1)
	sf, _ := h.store.GetStoredFile(context.Background(), id)

	h.advance(pairRoomJoinWindow + 1)
	h.svc.SweepPairRooms(context.Background(), h.now)

	if _, err := h.store.GetStoredFile(context.Background(), id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("sweep left the row: %v", err)
	}
	if h.blobExists(t, sf.BlobKey) {
		t.Fatal("sweep left the ciphertext")
	}
	// And the closed row is purged once it is old enough to be uninteresting.
	h.advance(pairRoomPurgeAfter + 1)
	h.svc.SweepPairRooms(context.Background(), h.now)
	if _, found, _ := h.store.GetPairRoom(context.Background(), sf.PairRoomID); found {
		t.Fatal("closed room row was never purged")
	}
}

// A recycled code opens a NEW room. The previous holder's ciphertext must stay
// unreachable through the digits somebody else now has.
func TestRecycledCodeOpensItsOwnRoom(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("181818", "")
	first := h.preUpload(t, "181818", bytes.Repeat([]byte("1"), 1024), 1)
	firstFile, _ := h.store.GetStoredFile(context.Background(), first)
	h.svc.MarkPairRoomJoined(context.Background(), "181818") // in flight, long-lived

	// The same digits are handed to a different account later.
	other, _ := h.store.UpsertUserByEmail(context.Background(), "second@example.com", "Second")
	h.mintCode("181818", other.ID)
	room, err := h.svc.pairRoomForUpload(context.Background(), other.ID, "181818")
	if err != nil {
		t.Fatalf("second holder could not open a room: %v", err)
	}
	if room.ID == firstFile.PairRoomID {
		t.Fatal("a recycled code resolved to the previous holder's room")
	}
	if room.UserID != other.ID {
		t.Fatalf("new room owner = %s, want %s", room.UserID, other.ID)
	}
	// The first transfer is untouched.
	if s, _ := h.getAnon(t, "/api/files/"+first+"/blob"); s != 200 {
		t.Fatalf("recycling the code killed the previous transfer: %d", s)
	}
}

// The whole batch shares one deadline: a later file's progress must keep an
// earlier, already-finished one alive, or a three-file pre-upload silently loses
// its first file while the third is still going up.
func TestLaterUploadKeepsAnEarlierFileInTheSameRoomAlive(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("191919", "")
	firstID := h.preUpload(t, "191919", bytes.Repeat([]byte("1"), 1024), 1)

	blob := bytes.Repeat([]byte("2"), 3000)
	status, uploadID, _ := h.initPairUpload(t, "191919", len(blob), "")
	if status != 200 {
		t.Fatalf("second init: %d", status)
	}
	for start := 0; start < len(blob); start += 1000 {
		h.advance(pairRoomJoinWindow - 30)
		if got := h.patch(t, uploadID, blob, start, start+1000, len(blob)); got != 200 {
			t.Fatalf("second file chunk at %d: %d", start, got)
		}
		if s, _ := h.getAnon(t, "/api/files/"+firstID+"/meta"); s != 200 {
			t.Fatalf("the first file expired at %d while the second was uploading: %d", h.now, s)
		}
	}
	if status, _ := h.finalize(t, uploadID); status != 200 {
		t.Fatalf("second finalize: %d", status)
	}
	// Both now share the final window, which starts at the last byte.
	if s, _ := h.getAnon(t, "/api/files/"+firstID+"/meta"); s != 200 {
		t.Fatalf("first file gone right after the batch finished: %d", s)
	}
	h.advance(pairRoomJoinWindow + 1)
	if s, _ := h.getAnon(t, "/api/files/"+firstID+"/meta"); s != 404 {
		t.Fatalf("first file outlived the batch's join window: %d", s)
	}
}

// A finalize that passes its own liveness check can insert an object
// microseconds after a concurrent void has already collected the room's object
// list. Nothing later would ever return that object from a void, so the read
// that refuses it has to reclaim it directly — otherwise "deleted immediately"
// quietly degrades to "deleted by GC" in exactly the race it was written for.
func TestObjectLandingInAnAlreadyClosedRoomIsReclaimedByTheRead(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("202020", "")
	id := h.preUpload(t, "202020", bytes.Repeat([]byte("Z"), 1024), 1)
	sf, _ := h.store.GetStoredFile(context.Background(), id)

	// Close the room without touching its objects — the exact state the loser of
	// that race leaves behind.
	if _, err := h.store.db.Exec(`UPDATE pair_rooms SET closed_at = ? WHERE id = ?`, h.now, sf.PairRoomID); err != nil {
		t.Fatalf("close room: %v", err)
	}
	if status, _ := h.getAnon(t, "/api/files/"+id+"/meta"); status != 404 {
		t.Fatalf("object in a closed room: %d, want 404", status)
	}
	if _, err := h.store.GetStoredFile(context.Background(), id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("orphan of a closed room survived the read: %v", err)
	}
	if h.blobExists(t, sf.BlobKey) {
		t.Fatal("orphan ciphertext left on disk for GC")
	}
}
