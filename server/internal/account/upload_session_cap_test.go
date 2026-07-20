package account

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// seedDailyUsage debits the rolling-24h upload ledger by n bytes so the tests
// below can put a user at a precise *remaining* daily quota. It goes through
// ReserveUpload (the same writer finalize uses) rather than poking the table.
func seedDailyUsage(t *testing.T, svc *Service, store *SQLiteStore, userID string, n int64) {
	t.Helper()
	now := svc.now().Unix()
	ok, err := store.ReserveUpload(context.Background(),
		UploadEvent{ID: newID(), UserID: userID, Bytes: n, UploadedAt: now},
		now-dayWindow, 1<<40)
	if err != nil || !ok {
		t.Fatalf("seedDailyUsage: ok=%v err=%v", ok, err)
	}
}

// uploadReceived reads the session's committed offset via GET
// /api/uploads/{id}. It is the byte count that actually reached the blob, which
// is what the squatting attack is about — as opposed to whatever finalize would
// later have said.
func uploadReceived(t *testing.T, ts *httptest.Server, cookie *http.Cookie, uploadID string) int64 {
	t.Helper()
	req, _ := http.NewRequest("GET", ts.URL+"/api/uploads/"+uploadID, nil)
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status probe = %d, want 200", resp.StatusCode)
	}
	var out struct {
		Received int64 `json:"received"`
	}
	decodeJSON(t, resp, &out)
	return out.Received
}

// TestUploadSessionCapClampsToRemainingDailyQuota is the reason this whole
// change exists.
//
// A client that declares ?size=0 skips init's early rejection (which only ever
// sees the *declared* size). Before this change the session's write cap was a
// snapshot of MaxFileSize, so that client could then PATCH a full MaxFileSize
// of ciphertext to disk and only be refused at finalize — burning the bandwidth
// and squatting the disk for pendingUploadTTL, maxSessionsPerUser times over.
//
// The assertion is deliberately made *at the PATCH stage*: this test never
// calls finalize at all. A 413 from PATCH plus a committed byte count nowhere
// near MaxFileSize is only possible if the server derived the cap from the
// account's remaining quota on its own. If the only guard were finalize, every
// PATCH here would return 200 and the blob would reach 8 MiB.
func TestUploadSessionCapClampsToRemainingDailyQuota(t *testing.T) {
	const maxFile = 8 << 20        // MaxFileSize: what the old snapshot cap would allow
	const quota = 1 << 20          // daily quota
	const used = 896 << 10         // already spent today
	const remaining = quota - used // 128 KiB left

	ts, svc, store, mail := newFileServerWithQuota(t, quota, maxFile)
	cookie := loginCookie(t, ts, mail, "cap-daily@example.com")
	u, _ := store.UpsertUserByEmail(context.Background(), "cap-daily@example.com", "")
	seedDailyUsage(t, svc, store, u.ID, used)

	// The lie: declare nothing, then try to push a full MaxFileSize.
	uploadID := initUpload(t, ts, cookie, []byte("M"), 0, 0)
	blob := bytes.Repeat([]byte("D"), maxFile)
	code, _ := patchChunk(t, ts, cookie, uploadID, blob, 0, maxFile, maxFile)

	if code != http.StatusRequestEntityTooLarge {
		t.Fatalf("PATCH past the remaining daily quota = %d, want 413 — the write must be refused "+
			"during PATCH, not deferred to finalize", code)
	}
	// received is read back from the session (not from finalize) to prove how
	// many bytes actually hit the disk. io.Copy uses a 32 KiB buffer, so the
	// cap can overshoot by at most one buffer; anything near maxFile means the
	// session was still sized from MaxFileSize.
	if got := uploadReceived(t, ts, cookie, uploadID); got > remaining+(64<<10) {
		t.Fatalf("committed %d bytes with only %d of daily quota left (MaxFileSize=%d) — "+
			"the session cap is not derived from the remaining quota", got, remaining, maxFile)
	}
}

// TestUploadSessionCapClampsToRemainingStorage: same lie, but the binding
// constraint is the plan's storage cap rather than the daily quota. Present so
// that dropping *only* the storage term from the min still fails a test.
func TestUploadSessionCapClampsToRemainingStorage(t *testing.T) {
	const maxFile = 8 << 20
	const storageCap = 128 << 10

	ts, _, store, mail := newFileServerWithQuota(t, 64<<20 /*roomy daily quota*/, maxFile)
	cookie := loginCookie(t, ts, mail, "cap-storage@example.com")
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "cap-storage@example.com", "")
	_ = store.UpsertPlan(ctx, Plan{ID: "tight-storage", Name: "TightStorage", StorageBytes: storageCap,
		TrafficBytes: 1 << 30, RetentionSecs: 3 * 86400, Active: true, UpdatedAt: 1})
	_ = store.SetUserPlan(ctx, u.ID, "tight-storage", 1)

	uploadID := initUpload(t, ts, cookie, []byte("M"), 0, 0)
	blob := bytes.Repeat([]byte("S"), maxFile)
	if code, _ := patchChunk(t, ts, cookie, uploadID, blob, 0, maxFile, maxFile); code != http.StatusRequestEntityTooLarge {
		t.Fatalf("PATCH past the remaining storage = %d, want 413", code)
	}
	if got := uploadReceived(t, ts, cookie, uploadID); got > storageCap+(64<<10) {
		t.Fatalf("committed %d bytes against a %d storage cap (MaxFileSize=%d)", got, storageCap, maxFile)
	}
}

// TestUploadSessionCapClampsToRemainingTraffic: same again with the monthly
// traffic allowance as the binding constraint, so dropping *only* the traffic
// term from the min also fails a test.
func TestUploadSessionCapClampsToRemainingTraffic(t *testing.T) {
	const maxFile = 8 << 20
	const trafficCap = 128 << 10

	ts, _, store, mail := newFileServerWithQuota(t, 64<<20, maxFile)
	cookie := loginCookie(t, ts, mail, "cap-traffic@example.com")
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "cap-traffic@example.com", "")
	_ = store.UpsertPlan(ctx, Plan{ID: "tight-traffic", Name: "TightTraffic", StorageBytes: 1 << 30,
		TrafficBytes: trafficCap, RetentionSecs: 3 * 86400, Active: true, UpdatedAt: 1})
	_ = store.SetUserPlan(ctx, u.ID, "tight-traffic", 1)

	uploadID := initUpload(t, ts, cookie, []byte("M"), 0, 0)
	blob := bytes.Repeat([]byte("T"), maxFile)
	if code, _ := patchChunk(t, ts, cookie, uploadID, blob, 0, maxFile, maxFile); code != http.StatusRequestEntityTooLarge {
		t.Fatalf("PATCH past the remaining traffic = %d, want 413", code)
	}
	if got := uploadReceived(t, ts, cookie, uploadID); got > trafficCap+(64<<10) {
		t.Fatalf("committed %d bytes against a %d traffic cap (MaxFileSize=%d)", got, trafficCap, maxFile)
	}
}

// TestUploadSessionCapStillBoundedByMaxFileSize is the other side of the min:
// when the account has plenty of quota left, MaxFileSize must still bound the
// session. Deriving the cap purely from quota would let one file exceed the
// admin's per-file ceiling.
func TestUploadSessionCapStillBoundedByMaxFileSize(t *testing.T) {
	const maxFile = 1 << 10

	ts, _, _, mail := newFileServerWithQuota(t, 100<<20 /*quota far above maxFile*/, maxFile)
	cookie := loginCookie(t, ts, mail, "cap-maxfile@example.com")

	uploadID := initUpload(t, ts, cookie, []byte("M"), 0, 0)
	blob := bytes.Repeat([]byte("X"), 64<<10)
	if code, _ := patchChunk(t, ts, cookie, uploadID, blob, 0, len(blob), len(blob)); code != http.StatusRequestEntityTooLarge {
		t.Fatalf("PATCH past MaxFileSize = %d, want 413", code)
	}
	if got := uploadReceived(t, ts, cookie, uploadID); got > maxFile+(64<<10) {
		t.Fatalf("committed %d bytes with MaxFileSize=%d", got, maxFile)
	}
}

// TestUploadSessionCapLeavesHealthyUploadsAlone is the false-positive guard: an
// account with quota to spare must still be able to run a size=0 session to
// completion. A cap that clamped to 0 on any read hiccup (or that mistook "no
// declared size" for "no allowance") would break every honest client.
func TestUploadSessionCapLeavesHealthyUploadsAlone(t *testing.T) {
	ts, _, _, mail := newFileServerWithQuota(t, 8<<20 /*daily quota*/, 4<<20 /*MaxFileSize*/)
	cookie := loginCookie(t, ts, mail, "cap-healthy@example.com")

	uploadID := initUpload(t, ts, cookie, []byte("M"), 0, 0)
	blob := bytes.Repeat([]byte("H"), 300<<10)
	for _, r := range [][2]int{{0, 100 << 10}, {100 << 10, 200 << 10}, {200 << 10, 300 << 10}} {
		code, received := patchChunk(t, ts, cookie, uploadID, blob, r[0], r[1], len(blob))
		if code != 200 || received != int64(r[1]) {
			t.Fatalf("healthy chunk %v: code=%d received=%d, want 200/%d", r, code, received, r[1])
		}
	}
	freq, _ := http.NewRequest("POST", ts.URL+"/api/uploads/"+uploadID+"/finalize", nil)
	freq.AddCookie(cookie)
	fresp, err := ts.Client().Do(freq)
	if err != nil {
		t.Fatal(err)
	}
	fresp.Body.Close()
	if fresp.StatusCode != http.StatusOK {
		t.Fatalf("finalize of a healthy size=0 upload = %d, want 200", fresp.StatusCode)
	}
}

// TestUploadSessionCapExemptsOwnNodeUploads pins a deliberate carve-out: an
// upload placed on the user's OWN storage node (placeUpload → billable=false)
// is never metered against a plan — init and finalize both skip every quota
// gate for it. Sizing its session from "remaining quota" would therefore be
// enforcing a budget that is not being spent, and would break BYO users the
// moment their (irrelevant) central allowance ran out. The bytes land on their
// own disk, which the node's own StorageFree/disk-cap machinery governs.
//
// Here the account's daily quota is already fully spent, so a *billable*
// session would be capped at ~0 — the own-node session must still write.
func TestUploadSessionCapExemptsOwnNodeUploads(t *testing.T) {
	ts, svc, store, mail := newFileServerWithQuota(t, 128<<10 /*daily quota*/, 4<<20 /*MaxFileSize*/)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "cap-ownnode@example.com", "")
	nodeStore := map[string][]byte{}
	fn := fakeNode(t, nodeStore)
	defer fn.Close()
	_, _ = store.UpsertNode(ctx, Node{ID: "mynode", OwnerType: "user", OwnerUserID: u.ID, URLs: []string{"turn:x:3478"},
		TURNSecret: "t", StorageEnabled: true, StorageURL: fn.URL, StorageSecret: "ss", StorageFree: 100 << 30,
		CreatedAt: 1, LastSeenAt: time.Now().Unix()})
	// Spend the whole daily quota: a billable session would now get a ~0 cap.
	seedDailyUsage(t, svc, store, u.ID, 128<<10)

	cookie := loginCookie(t, ts, mail, "cap-ownnode@example.com")
	uploadID := initUpload(t, ts, cookie, []byte("M"), 0, 0)
	blob := bytes.Repeat([]byte("O"), 256<<10) // 2x the exhausted daily quota
	if code, received := patchChunk(t, ts, cookie, uploadID, blob, 0, len(blob), len(blob)); code != 200 || received != int64(len(blob)) {
		t.Fatalf("own-node chunk: code=%d received=%d, want 200/%d — own-node uploads are unmetered "+
			"and must not be capped by the central quota", code, received, len(blob))
	}
}
