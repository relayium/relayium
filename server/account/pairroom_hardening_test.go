package account

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/storage"
)

// Second adversarial suite for code-first pre-upload, written against the ways
// the first implementation of it was wrong rather than against the design.
//
// Three shapes recur here and are worth naming, because each one passed every
// test that existed before:
//   - accounting split across two writes that can fail independently,
//   - a durable row created before the check that would have refused it,
//   - a refusal that stops accounting for bytes that already crossed the wire.

// flakyStore wraps a real store and fails chosen methods on demand, so a test
// can ask what the server does when the database says no — the case every
// `_ = s.store.Something(...)` on these paths silently assumes away.
type flakyStore struct {
	Store
	mu sync.Mutex
	// remaining failures per method name; a negative count fails forever.
	fail map[string]int
	// calls counts attempts per method, so a test can prove a retry happened.
	calls map[string]int
}

func newFlakyStore(inner Store) *flakyStore {
	return &flakyStore{Store: inner, fail: map[string]int{}, calls: map[string]int{}}
}

func (f *flakyStore) failNext(method string, times int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fail[method] = times
}

func (f *flakyStore) callCount(method string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[method]
}

// shouldFail records the call and reports whether this one is a failure.
func (f *flakyStore) shouldFail(method string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls[method]++
	n, ok := f.fail[method]
	if !ok || n == 0 {
		return false
	}
	if n > 0 {
		f.fail[method] = n - 1
	}
	return true
}

var errInjected = errors.New("injected store failure")

func (f *flakyStore) CommitUploadProgress(ctx context.Context, p UploadProgress) (UploadProgressResult, error) {
	if f.shouldFail("CommitUploadProgress") {
		return UploadProgressResult{}, errInjected
	}
	return f.Store.CommitUploadProgress(ctx, p)
}

func (f *flakyStore) ClaimUploadDone(ctx context.Context, id string, now int64) (int64, int64, bool, error) {
	if f.shouldFail("ClaimUploadDone") {
		return 0, 0, false, errInjected
	}
	return f.Store.ClaimUploadDone(ctx, id, now)
}

func (f *flakyStore) ReconcileUploadMeter(ctx context.Context, id string, now int64) (int64, error) {
	if f.shouldFail("ReconcileUploadMeter") {
		return 0, errInjected
	}
	return f.Store.ReconcileUploadMeter(ctx, id, now)
}

func (f *flakyStore) RecordMeter(ctx context.Context, userID string, kind UsageKind, bytes, at int64) error {
	if f.shouldFail("RecordMeter") {
		return errInjected
	}
	return f.Store.RecordMeter(ctx, userID, kind, bytes, at)
}

func (f *flakyStore) EnqueueUnbilledMeter(ctx context.Context, m UnbilledMeter) error {
	if f.shouldFail("EnqueueUnbilledMeter") {
		return errInjected
	}
	return f.Store.EnqueueUnbilledMeter(ctx, m)
}

func (f *flakyStore) SettleBlobBilling(ctx context.Context, blobKey, nodeID string, through, at int64) (int64, error) {
	if f.shouldFail("SettleBlobBilling") {
		return 0, errInjected
	}
	return f.Store.SettleBlobBilling(ctx, blobKey, nodeID, through, at)
}

func (f *flakyStore) JournalBlobBilling(ctx context.Context, blobKey, nodeID string, through, at int64, reason string) (int64, error) {
	if f.shouldFail("JournalBlobBilling") {
		return 0, errInjected
	}
	return f.Store.JournalBlobBilling(ctx, blobKey, nodeID, through, at, reason)
}

func (f *flakyStore) ClosePairRoom(ctx context.Context, id string, at, holdUntil int64) (PairRoomClosure, error) {
	if f.shouldFail("ClosePairRoom") {
		return PairRoomClosure{}, errInjected
	}
	return f.Store.ClosePairRoom(ctx, id, at, holdUntil)
}

func (f *flakyStore) LivePairRoomByCode(ctx context.Context, code string) (PairRoom, bool, error) {
	if f.shouldFail("LivePairRoomByCode") {
		return PairRoom{}, false, errInjected
	}
	return f.Store.LivePairRoomByCode(ctx, code)
}

func (f *flakyStore) JoinPairRoom(ctx context.Context, id string, at, expiresAt int64) error {
	if f.shouldFail("JoinPairRoom") {
		return errInjected
	}
	return f.Store.JoinPairRoom(ctx, id, at, expiresAt)
}

func (f *flakyStore) TouchPairRoomUpload(ctx context.Context, id string, at, expiresAt int64) error {
	if f.shouldFail("TouchPairRoomUpload") {
		return errInjected
	}
	return f.Store.TouchPairRoomUpload(ctx, id, at, expiresAt)
}

func (f *flakyStore) GetPlan(ctx context.Context, id string) (Plan, bool, error) {
	if f.shouldFail("GetPlan") {
		return Plan{}, false, errInjected
	}
	return f.Store.GetPlan(ctx, id)
}

// withFlakyStore puts a flakyStore in front of the harness's service and returns
// it. Tests that inject a permanent failure also zero the retry backoff, so the
// suite does not pay for it.
func (h *pairHarness) withFlakyStore(t *testing.T) *flakyStore {
	t.Helper()
	f := newFlakyStore(h.store)
	h.svc.store = f
	prev := storeRetryDelay
	storeRetryDelay = 0
	t.Cleanup(func() { storeRetryDelay = prev })
	return f
}

// setPlan gives the harness's user a plan, for the quota gates below.
//
// The plan_id is written directly rather than through SetUserPlanAdmin because
// that path also stamps a mid-month plan CHANGE, which prorates the allowance
// for the rest of the month (monthlyTrafficCap) and would make every byte
// figure below depend on today's date. This models the ordinary case: an
// account that has been on its plan all month, with its full allowance.
func (h *pairHarness) setPlan(t *testing.T, p Plan) {
	t.Helper()
	p.Active, p.UpdatedAt = true, 1
	if err := h.store.UpsertPlan(context.Background(), p); err != nil {
		t.Fatalf("upsert plan: %v", err)
	}
	if _, err := h.store.db.Exec(`UPDATE users SET plan_id = ? WHERE id = ?`, p.ID, h.userID); err != nil {
		t.Fatalf("set user plan: %v", err)
	}
}

func (h *pairHarness) openRooms(t *testing.T, code string) int {
	t.Helper()
	var n int
	if err := h.store.db.QueryRow(
		`SELECT COUNT(*) FROM pair_rooms WHERE code = ? AND closed_at = 0`, code).Scan(&n); err != nil {
		t.Fatalf("count rooms: %v", err)
	}
	return n
}

// ---------------------------------------------------------------------------
// Admission: a room is durable state, so it must not exist before the checks
// that would have refused it.
// ---------------------------------------------------------------------------

// An account already over a limit does not get a room. The room used to be
// created before every quota gate in handleUploadInit, so an over-quota sender
// left a live pairing room behind on a request that was then refused — and the
// owner's rule is the opposite: block BEFORE entering the room.
func TestNoRoomIsCreatedForAnAccountAlreadyOverQuota(t *testing.T) {
	for _, tc := range []struct {
		name string
		plan Plan
		// prime charges usage against the plan before the attempt.
		prime func(h *pairHarness)
		want  int
	}{
		{
			name: "monthly traffic spent",
			plan: Plan{ID: "tight-traffic", Name: "Tight", StorageBytes: 1 << 30, TrafficBytes: 1000, RetentionSecs: 3600},
			prime: func(h *pairHarness) {
				_ = h.store.RecordMeter(context.Background(), h.userID, MeterUpload, 1001, h.now)
			},
			want: 429,
		},
		{
			name: "daily quota spent",
			plan: Plan{ID: "tight-daily", Name: "Tight", StorageBytes: 1 << 30, TrafficBytes: 1 << 40,
				RetentionSecs: 3600, DailyQuotaBytes: 1000},
			prime: func(h *pairHarness) {
				_, _ = h.store.ReserveUpload(context.Background(),
					UploadEvent{ID: "ev1", UserID: h.userID, Bytes: 1000, UploadedAt: h.now},
					h.now-dayWindow, 1<<40)
			},
			want: 429,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newPairHarness(t)
			h.setPlan(t, tc.plan)
			tc.prime(h)
			h.mintCode("242424", "")

			// size=0 so the client-declared-size pre-check cannot be what refuses
			// this: the point is that an over-quota account is refused even when it
			// declares nothing, and refused BEFORE a room exists.
			if status, _, _ := h.initPairUpload(t, "242424", 0, ""); status != tc.want {
				t.Fatalf("init while over quota: %d, want %d", status, tc.want)
			}
			if n := h.openRooms(t, "242424"); n != 0 {
				t.Fatalf("%d room(s) created for an account known to be over quota", n)
			}
		})
	}
}

// ...and a quota read that FAILS is not the same as a quota that is spent. The
// owner named this behaviour for this decision: fail open, like turn.go. One
// database blip must not stop everyone from starting a transfer.
func TestPairRoomAdmissionFailsOpenWhenTheQuotaReadFails(t *testing.T) {
	h := newPairHarness(t)
	f := h.withFlakyStore(t)
	h.mintCode("252525", "")
	f.failNext("GetPlan", -1) // every plan read errors ⇒ every quota is unknown

	status, uploadID, _ := h.initPairUpload(t, "252525", 0, "")
	if status != 200 {
		t.Fatalf("init with an unreadable quota: %d, want 200 (fail open)", status)
	}
	if uploadID == "" {
		t.Fatal("no upload session")
	}
	if n := h.openRooms(t, "252525"); n != 1 {
		t.Fatalf("open rooms = %d, want 1", n)
	}
}

// ---------------------------------------------------------------------------
// One room per code.
// ---------------------------------------------------------------------------

// Two files of one batch starting at the same instant must share a room. Two
// rooms for one code strands a file: the join resolves one of them and whatever
// was uploaded into the other expires unreachable while its sender is told it
// was handed over.
func TestConcurrentFirstUploadsShareOneRoom(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("262626", "")
	ctx := context.Background()

	const racers = 8
	ids := make([]string, racers)
	errs := make([]error, racers)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			room, err := h.svc.pairRoomForUpload(ctx, h.userID, "262626")
			ids[i], errs[i] = room.ID, err
		}(i)
	}
	close(start)
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("racer %d could not resolve the room: %v", i, err)
		}
	}
	for i, id := range ids {
		if id != ids[0] {
			t.Fatalf("racer %d got room %s, racer 0 got %s — one code opened two rooms", i, id, ids[0])
		}
	}
	if n := h.openRooms(t, "262626"); n != 1 {
		t.Fatalf("%d open rooms for one code", n)
	}
}

// The same property at the store: the database itself refuses a second open,
// unjoined room for a code, so a future caller that forgets the get-or-create
// path cannot reintroduce the race.
func TestStoreRefusesASecondOpenRoomForOneCode(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	first := PairRoom{ID: "room-a", Code: "272727", UserID: h.userID, CreatedAt: h.now, ExpiresAt: h.now + 300}
	if _, created, err := h.store.CreatePairRoomIfAbsent(ctx, first); err != nil || !created {
		t.Fatalf("first room: created=%v err=%v", created, err)
	}
	second := PairRoom{ID: "room-b", Code: "272727", UserID: h.userID, CreatedAt: h.now + 1, ExpiresAt: h.now + 301}
	got, created, err := h.store.CreatePairRoomIfAbsent(ctx, second)
	if err != nil {
		t.Fatalf("second room: %v", err)
	}
	if created {
		t.Fatal("a second open room was created for one code")
	}
	if got.ID != "room-a" {
		t.Fatalf("get-or-create returned %s, want the existing room-a", got.ID)
	}
	// The raw insert is refused too — the index, not the helper, is the guarantee.
	if _, err := h.store.db.Exec(
		`INSERT INTO pair_rooms (`+pairRoomCols+`) VALUES (?, ?, ?, ?, 0, 0, 0, ?)`,
		"room-c", "272727", h.userID, h.now, h.now+300); err == nil {
		t.Fatal("the database allowed a second open, unjoined room for one code")
	}
}

// A code recycled to a DIFFERENT account after the previous holder paired must
// still open its own room. The uniqueness that prevents the race must not
// deadlock the next holder of the digits — a joined room now lives indefinitely,
// so "one open room per code" could otherwise mean "these six digits are burned
// forever".
func TestRecycledCodeStillOpensARoomAfterThePreviousHolderPaired(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	h.mintCode("282828", "")
	firstID := h.preUpload(t, "282828", bytes.Repeat([]byte("1"), 512), 1)
	h.svc.MarkPairRoomJoined(ctx, "282828")

	other, _ := h.store.UpsertUserByEmail(ctx, "next@example.com", "Next")
	// Minted AFTER the wait, which is the only way a recycled code is ever
	// issued: the digits are not free until the previous code has expired.
	h.advance(pairRoomJoinWindow + 1)
	h.mintCode("282828", other.ID)

	room, err := h.svc.pairRoomForUpload(ctx, other.ID, "282828")
	if err != nil {
		t.Fatalf("the next holder of the code could not open a room: %v", err)
	}
	if room.UserID != other.ID {
		t.Fatalf("new room belongs to %s, want %s", room.UserID, other.ID)
	}
	// And the previous holder's joined transfer is untouched by any of it.
	if s, _ := h.getAnon(t, "/api/files/"+firstID+"/blob"); s != 200 {
		t.Fatalf("recycling the code disturbed the previous, joined transfer: %d", s)
	}
}

// ---------------------------------------------------------------------------
// Accounting: every accepted byte, including the ones a refusal or a crash
// interrupted.
// ---------------------------------------------------------------------------

// A chunk the server refuses as too large still crossed the network, and the
// blob still absorbed everything up to the cap. Returning 413 without recording
// it made an oversize chunk free bandwidth — worse, a repeatable one.
func TestOversizeChunkIsBilledForWhatItCommittedLocally(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("292929", "")
	status, uploadID, _ := h.initPairUpload(t, "292929", 0, "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	// MaxFileSize in this harness is 1 MiB; send half again as much in one chunk.
	oversize := bytes.Repeat([]byte("O"), (1<<20)+(1<<19))
	if got := h.patch(t, uploadID, oversize, 0, len(oversize), len(oversize)); got != 413 {
		t.Fatalf("oversize chunk: %d, want 413", got)
	}
	metered := h.uploadMetered(t)
	if metered == 0 {
		t.Fatal("a refused oversize chunk was free bandwidth")
	}
	if metered != 1<<20 {
		t.Fatalf("metered %d, want the %d bytes the write cap allowed to commit", metered, 1<<20)
	}
	// The offset moved with it: the ledger and the blob agree, so nothing can be
	// billed a second time by a later reconcile.
	sess, _, _ := h.store.GetUploadSession(context.Background(), uploadID, h.userID)
	if sess.Received != metered || sess.Metered != metered {
		t.Fatalf("received=%d metered=%d, want both %d", sess.Received, sess.Metered, metered)
	}
	// Abandoning it now bills nothing further — the bytes are already paid for.
	h.svc.ReapPendingUploads(h.now + pendingUploadTTL + 1)
	if got := h.uploadMetered(t); got != metered {
		t.Fatalf("reaping re-billed the same bytes: %d, want %d", got, metered)
	}
}

// The same seam with the blob on a REMOTE node, which fails completely
// differently: central cuts the request body, the node commits the prefix it
// already read and answers 500, and Append reports 0 bytes — "I do not know",
// not "nothing landed". Writing that 0 down would clobber the offset; treating
// it as nothing landed loses the bill.
func TestOversizeChunkIsBilledForWhatItCommittedOnARemoteNode(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	dir := t.TempDir()
	node := nodeFaithfulToTruncatedBodies(t, dir)
	if _, err := h.store.UpsertNode(ctx, Node{
		OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "t",
		StorageEnabled: true, StorageURL: node.URL, StorageSecret: "ss",
		StorageFree: 100 << 30, CreatedAt: 1, LastSeenAt: h.now,
	}); err != nil {
		t.Fatalf("register node: %v", err)
	}
	h.mintCode("303030", "")
	status, uploadID, _ := h.initPairUpload(t, "303030", 0, "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	sess, _, _ := h.store.GetUploadSession(ctx, uploadID, h.userID)
	if sess.NodeID == "" {
		t.Fatal("upload did not land on the fleet node")
	}

	oversize := bytes.Repeat([]byte("R"), (1<<20)+(1<<19))
	if got := h.patch(t, uploadID, oversize, 0, len(oversize), len(oversize)); got != 413 {
		t.Fatalf("oversize chunk to a node: %d, want 413", got)
	}
	onNode := nodeBlobSize(t, dir, sess.BlobKey)
	if onNode == 0 {
		t.Skip("the node committed nothing before the body was cut; nothing to bill")
	}
	metered := h.uploadMetered(t)
	if metered == 0 {
		t.Fatalf("the node holds %d bytes of this upload and none of them were billed", onNode)
	}
	if metered != min(onNode, 1<<20) {
		t.Fatalf("metered %d, but the node holds %d (write cap %d)", metered, onNode, 1<<20)
	}
}

// A session that is abandoned after an append committed bytes but crashed
// before recording them must still be billed. The reaper deletes the row, which
// is the last moment anything knows what was received.
func TestReaperBillsCommittedBytesNoAppendRecorded(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("313131", "")
	blob := bytes.Repeat([]byte("A"), 2000)
	status, uploadID, _ := h.initPairUpload(t, "313131", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	if got := h.patch(t, uploadID, blob, 0, 1000, len(blob)); got != 200 {
		t.Fatalf("chunk: %d", got)
	}
	// The state a crash between committing and billing leaves behind: the offset
	// moved, the ledger did not.
	if _, err := h.store.db.Exec(
		`UPDATE upload_sessions SET received = 1800, metered = 0 WHERE id = ?`, uploadID); err != nil {
		t.Fatalf("simulate a crashed append: %v", err)
	}
	if _, err := h.store.db.Exec(
		`UPDATE usage_monthly SET upload_bytes = 0 WHERE user_id = ?`, h.userID); err != nil {
		t.Fatalf("reset meter: %v", err)
	}

	h.svc.ReapPendingUploads(h.now + pendingUploadTTL + 1)

	if got := h.uploadMetered(t); got != 1800 {
		t.Fatalf("abandoned session billed %d, want the 1800 bytes it had committed", got)
	}
}

// The traffic gate at finalize asks about CURRENT usage, not usage plus this
// upload again. Every byte is already on the meter by then (per-append), so
// adding `size` a second time refused uploads that fit — this is the boundary
// where that shows: an object that exactly fills the remaining allowance.
func TestFinalizeTrafficGateDoesNotCountThisUploadTwice(t *testing.T) {
	const size = 4000
	for _, tc := range []struct {
		name string
		// otherTraffic is billed to the account AFTER the bytes land and before
		// finalize — a download, or another transfer, in the same month. It is what
		// pushes the account over, since the write cap would otherwise have refused
		// the chunk long before finalize ever ran.
		otherTraffic int64
		want         int
	}{
		{name: "the upload exactly fills the allowance", otherTraffic: 0, want: 200},
		{name: "other traffic pushes it one byte past", otherTraffic: 1, want: 429},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newPairHarness(t)
			h.setPlan(t, Plan{ID: "cap", Name: "Cap", StorageBytes: 1 << 30,
				TrafficBytes: size, RetentionSecs: 3600, DailyQuotaBytes: 1 << 30})
			h.mintCode("323232", "")

			blob := bytes.Repeat([]byte("T"), size)
			status, uploadID, _ := h.initPairUpload(t, "323232", 0, "")
			if status != 200 {
				t.Fatalf("init: %d", status)
			}
			if got := h.patch(t, uploadID, blob, 0, size, size); got != 200 {
				t.Fatalf("chunk: %d", got)
			}
			if got := h.uploadMetered(t); got != size {
				t.Fatalf("the chunk metered %d, want %d", got, size)
			}
			if tc.otherTraffic > 0 {
				if err := h.store.RecordMeter(context.Background(), h.userID, MeterDownload,
					tc.otherTraffic, h.now); err != nil {
					t.Fatalf("record other traffic: %v", err)
				}
			}
			if status, _ := h.finalize(t, uploadID); status != tc.want {
				t.Fatalf("finalize with %d bytes of allowance, %d uploaded and %d other: %d, want %d",
					int64(size), int64(size), tc.otherTraffic, status, tc.want)
			}
			// Billed once either way: a refused finalize does not un-send the bytes,
			// and does not bill them twice either.
			if got := h.uploadMetered(t); got != size {
				t.Fatalf("upload metered %d, want %d billed exactly once", got, size)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Failure injection: what these paths do when the database says no.
// ---------------------------------------------------------------------------

// A commit that cannot be persisted fails the request VISIBLY, and the retry
// recovers the exact same bytes exactly once. Silently ignoring it (as three
// separate best-effort writes did) loses the bill, the offset, or the room's
// deadline depending on which write failed.
func TestFailedProgressCommitIsVisibleAndTheRetryBillsOnce(t *testing.T) {
	h := newPairHarness(t)
	f := h.withFlakyStore(t)
	h.mintCode("343434", "")
	blob := bytes.Repeat([]byte("V"), 3000)
	status, uploadID, _ := h.initPairUpload(t, "343434", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}

	f.failNext("CommitUploadProgress", 1)
	if got := h.patch(t, uploadID, blob, 0, 1500, len(blob)); got != 500 {
		t.Fatalf("a chunk whose accounting could not be persisted: %d, want 500", got)
	}
	if got := h.uploadMetered(t); got != 0 {
		t.Fatalf("a failed commit billed %d bytes anyway", got)
	}

	// The client retries the same range. The blob already holds those bytes, so
	// the append reports the offset mismatch and the retry commits the recovered
	// progress — the event was deferred, not lost.
	h.advance(30) // a later instant, so the room's deadline really has to move
	code, received := patchChunk(t, h.ts, h.cookie, uploadID, blob, 0, 1500, len(blob))
	if code != 409 || received != 1500 {
		t.Fatalf("retry of the same chunk: %d received=%d, want 409 received=1500", code, received)
	}
	if got := h.uploadMetered(t); got != 1500 {
		t.Fatalf("after the retry metered = %d, want 1500 billed exactly once", got)
	}
	// And the room's deadline moved with it, in the same transaction.
	room, found, _ := h.store.LivePairRoomByCode(context.Background(), "343434")
	if !found || room.LastUploadAt != h.now {
		t.Fatalf("room progress not recorded with the retried commit: %+v", room)
	}

	// The rest of the upload proceeds normally and is billed exactly once.
	if got := h.patch(t, uploadID, blob, 1500, 3000, len(blob)); got != 200 {
		t.Fatalf("next chunk: %d", got)
	}
	if status, _ := h.finalize(t, uploadID); status != 200 {
		t.Fatalf("finalize: %d", status)
	}
	if got := h.uploadMetered(t); got != int64(len(blob)) {
		t.Fatalf("whole upload metered = %d, want %d", got, len(blob))
	}
}

// The join stamp is retried rather than dropped on the first error. Losing it
// leaves the room with the five-minute join deadline it should have just shed,
// so ciphertext the receiver is about to fetch expires underneath them.
func TestJoinIsRetriedWhenTheFirstWriteFails(t *testing.T) {
	h := newPairHarness(t)
	f := h.withFlakyStore(t)
	h.mintCode("353535", "")
	id := h.preUpload(t, "353535", bytes.Repeat([]byte("J"), 1024), 1)
	ctx := context.Background()

	f.failNext("JoinPairRoom", 2) // two transient failures, then it lands
	h.svc.MarkPairRoomJoined(ctx, "353535")

	if n := f.callCount("JoinPairRoom"); n != 3 {
		t.Fatalf("JoinPairRoom attempted %d times, want 3 (two failures then success)", n)
	}
	sf, _ := h.store.GetStoredFile(ctx, id)
	room, _, _ := h.store.GetPairRoom(ctx, sf.PairRoomID)
	if room.JoinedAt == 0 {
		t.Fatal("the join was lost after a transient write failure")
	}
	// Long past the join window, and the object is still readable: the retried
	// join really did end the clock.
	h.advance(pairRoomJoinWindow * 10)
	if status, _ := h.getAnon(t, "/api/files/"+id+"/blob"); status != 200 {
		t.Fatalf("blob after a retried join: %d, want 200", status)
	}
}

// If the deadline move at finalize cannot be persisted, the finalize FAILS
// rather than handing back an object whose room is already counting down from an
// earlier chunk. The bytes stay billed, because they moved.
func TestFinalizeFailsVisiblyWhenTheDeadlineMoveCannotBePersisted(t *testing.T) {
	h := newPairHarness(t)
	f := h.withFlakyStore(t)
	h.mintCode("363636", "")
	blob := bytes.Repeat([]byte("D"), 1500)
	status, uploadID, _ := h.initPairUpload(t, "363636", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	if got := h.patch(t, uploadID, blob, 0, len(blob), len(blob)); got != 200 {
		t.Fatalf("chunk: %d", got)
	}
	h.advance(1) // so finalize's touch is a real forward move, not a no-op

	f.failNext("TouchPairRoomUpload", -1)
	if status, _ := h.finalize(t, uploadID); status != 500 {
		t.Fatalf("finalize with an unpersistable deadline: %d, want 500", status)
	}
	if n := f.callCount("TouchPairRoomUpload"); n != storeRetryAttempts {
		t.Fatalf("TouchPairRoomUpload attempted %d times, want %d", n, storeRetryAttempts)
	}
	if got := h.uploadMetered(t); got != int64(len(blob)) {
		t.Fatalf("bytes that crossed the wire were refunded by a failed finalize: %d, want %d",
			got, len(blob))
	}
}

// ---------------------------------------------------------------------------
// A node that behaves like the real one when central cuts the request body:
// it commits the prefix it read and answers 500 (relayium-node/storage.go).
// The map-backed fakeNode elsewhere in this package cannot model this — it
// discards the read error and answers 200.
// ---------------------------------------------------------------------------

func nodeFaithfulToTruncatedBodies(t *testing.T, dir string) *httptest.Server {
	t.Helper()
	ds, err := storage.NewDiskStore(dir)
	if err != nil {
		t.Fatalf("node disk store: %v", err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimPrefix(r.URL.Path, "/blob/")
		switch r.Method {
		case http.MethodPatch:
			off, _ := strconv.ParseInt(r.Header.Get("X-Blob-Offset"), 10, 64)
			// DiskStore.Append holds a per-key lock for the whole copy, exactly as
			// the node does, which is what makes central's read-back deterministic:
			// the probe blocks until the aborted append has finished writing.
			size, aerr := ds.Append(r.Context(), key, off, r.Body)
			if errors.Is(aerr, storage.ErrOffsetMismatch) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusConflict)
				fmt.Fprintf(w, `{"size":%d}`, size)
				return
			}
			if aerr != nil {
				// The body was cut. The bytes read so far ARE on disk; the node has
				// no way to report that here, which is the whole problem.
				http.Error(w, "append failed", http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"size":%d}`, size)
		case http.MethodGet:
			rc, gerr := ds.Get(r.Context(), key)
			if gerr != nil {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			defer rc.Close()
			_, _ = io.Copy(w, rc)
		case http.MethodDelete:
			_ = ds.Delete(r.Context(), key)
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func nodeBlobSize(t *testing.T, dir, key string) int64 {
	t.Helper()
	ds, err := storage.NewDiskStore(dir)
	if err != nil {
		t.Fatalf("node disk store: %v", err)
	}
	rc, err := ds.Get(context.Background(), key)
	if err != nil {
		return 0
	}
	defer rc.Close()
	n, _ := io.Copy(io.Discard, rc)
	return n
}

// Keep the import of time meaningful for the harness clock helpers used above.
var _ = time.Second
