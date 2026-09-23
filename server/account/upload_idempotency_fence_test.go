package account

// A14 part 2, review round 1 (Codex gate 2): the account-deletion fence, the
// staggered-retry recheck, the retention boundary and the digest encoding.

import (
	"context"
	"net/http"
	"net/url"
	"testing"
	"time"
)

const (
	// qpEpochBefore: the handler is about to read the account's upload fence.
	qpEpochBefore quotaPoint = "epoch.before"
	// qpCreateBefore: the handler is about to call the UNCAPPED insert (the
	// own-node path).
	qpCreateBefore quotaPoint = "create.before"
	// qpPrecheck: the handler's daily-quota pre-check is about to read usage.
	qpPrecheck quotaPoint = "precheck"
)

func (q *quotaHookStore) UploadEpoch(ctx context.Context, userID string) (int64, error) {
	q.hit(ctx, qpEpochBefore)
	return q.Store.UploadEpoch(ctx, userID)
}

func (q *quotaHookStore) CreateStoredFile(ctx context.Context, f StoredFile) error {
	q.hit(ctx, qpCreateBefore)
	return q.Store.CreateStoredFile(ctx, f)
}

func (q *quotaHookStore) UserUploadedSince(ctx context.Context, userID string, since int64) (int64, error) {
	q.hit(ctx, qpPrecheck)
	return q.Store.UserUploadedSince(ctx, userID, since)
}

// idemHold sends a request and waits for its handler to reach p. The caller
// then acts and calls finish to release the handler and read its answer.
func (h *quotaHarness) idemHold(p quotaPoint, path string, n int, hdr map[string]string) (finish func() idemResp) {
	h.t.Helper()
	h.hook.arm(p)
	conn, req := h.idemSend(h.cookie, "POST", path, quotaSingleBody(n), hdr)
	select {
	case <-h.hook.entered:
	case d := <-h.done:
		h.t.Fatalf("handler returned %d before reaching %s", d.code, p)
	case <-time.After(20 * time.Second):
		h.t.Fatalf("never reached %s", p)
	}
	return func() idemResp {
		h.t.Helper()
		defer conn.Close()
		h.hook.open()
		r, err := idemRead(conn, req)
		if err != nil {
			h.t.Fatalf("held request: %v", err)
		}
		h.waitDone("POST", "/api/files")
		return r
	}
}

// idemDeleteAccount runs the account-deletion writes the delete handler runs
// (PurgeTransientUserData, then SetAccountDeletion), and optionally the
// cancellation that reactivates the account.
func (h *quotaHarness) idemDeleteAccount(reactivate bool) {
	h.t.Helper()
	ctx := context.Background()
	blobs, err := h.store.PurgeTransientUserData(ctx, h.userID)
	if err != nil {
		h.t.Fatal(err)
	}
	// The delete handler reclaims what the purge hands back; do the same for
	// central blobs so a leftover on disk can only be the stale request's.
	for _, b := range blobs {
		if b.NodeID == "" {
			_ = h.svc.blobs.Delete(ctx, b.BlobKey)
		}
	}
	if err := h.store.SetAccountDeletion(ctx, h.userID, time.Now().Unix(), time.Now().Unix()+86400); err != nil {
		h.t.Fatal(err)
	}
	if reactivate {
		if err := h.store.ClearAccountDeletion(ctx, h.userID); err != nil {
			h.t.Fatal(err)
		}
	}
}

func (h *quotaHarness) idemOwnNode() map[string][]byte {
	h.t.Helper()
	blobs := map[string][]byte{}
	fn := fakeNode(h.t, blobs)
	h.t.Cleanup(fn.Close)
	if _, err := h.store.UpsertNode(context.Background(), Node{ID: "own", OwnerType: "user", OwnerUserID: h.userID,
		URLs: []string{"turn:x:3478"}, TURNSecret: "t", StorageEnabled: true, StorageURL: fn.URL, StorageSecret: "ss",
		StorageFree: 100 << 30, CreatedAt: 1, LastSeenAt: time.Now().Unix()}); err != nil {
		h.t.Fatal(err)
	}
	return blobs
}

// A (keyed) commits; the account is deleted — its object and key claim go,
// its debit and users row stay; B, the same key, in flight since before the
// deletion and past the lookup, then reaches its insert. B must write nothing:
// no claim, no second debit, no ciphertext after the deletion. Covered with
// and without a reactivation in between, keyed and unkeyed, billable and
// own-node.
func TestUploadFenceStaleRequestCannotLandAfterAccountDeletion(t *testing.T) {
	for _, tc := range []struct {
		name       string
		ownNode    bool
		keyed      bool
		reactivate bool
	}{
		{"billable keyed", false, true, false},
		{"billable keyed reactivated", false, true, true},
		{"billable unkeyed reactivated", false, false, true},
		{"own-node keyed", true, true, false},
		{"own-node keyed reactivated", true, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newQuotaHarness(t, quotaOpts{})
			point := qpPersistBefore
			if tc.ownNode {
				h.idemOwnNode()
				point = qpCreateBefore
			}
			hdr := map[string]string{}
			if tc.keyed {
				hdr["Idempotency-Key"] = idemKey
			}
			finishB := h.idemHold(point, "/api/files?ttl=7200", idemBodyBytes, hdr)
			a := h.upload(hdr["Idempotency-Key"], "?ttl=7200", idemBodyBytes)
			if a.code != http.StatusOK || a.replay != "" {
				t.Fatalf("A: %d %q", a.code, a.text)
			}
			before := h.ledger()
			h.idemDeleteAccount(tc.reactivate)
			b := finishB()
			if b.code != http.StatusUnauthorized {
				t.Fatalf("B after the deletion: %d %q, want 401 and nothing written", b.code, b.text)
			}
			l := h.ledger()
			if l.Files != 0 || l.Events != before.Events || h.opRows() != 0 {
				t.Fatalf("after deletion + stale B: files=%d events=%d (before %d) ops=%d — B landed", l.Files, l.Events, before.Events, h.opRows())
			}
			if !tc.ownNode && l.CentralBlobs != 0 {
				t.Fatalf("B's ciphertext is on disk after the deletion: %d blobs", l.CentralBlobs)
			}
		})
	}
}

// The credential is re-checked after the fence value is read: a request that
// authenticated before the deletion but reads the fence only after it (and
// after a reactivation reset deleted_at) is refused there.
func TestUploadFenceReadAfterDeletionIsRefusedByTheCredentialRecheck(t *testing.T) {
	h := newQuotaHarness(t, quotaOpts{})
	finish := h.idemHold(qpEpochBefore, "/api/files?ttl=7200", idemBodyBytes, map[string]string{"Idempotency-Key": idemKey})
	h.idemDeleteAccount(true)
	r := finish()
	if r.code != http.StatusUnauthorized {
		t.Fatalf("request authenticated before the deletion: %d %q, want 401", r.code, r.text)
	}
	if l := h.ledger(); l.Files != 0 || l.Events != 0 || l.Meter != 0 || h.opRows() != 0 {
		t.Fatalf("it wrote something: %+v ops=%d", l, h.opRows())
	}
}

// Staggered twins: B misses the lookup and stops before the daily-quota
// pre-check; A (same key) commits and fills the quota; B then meets the full
// quota. It must hear A's object, not 429.
func TestUploadIdempotencyStaggeredTwinHearsWinnerNotLimit(t *testing.T) {
	// A's debit (the 64 KiB floor) fits; A's debit plus B's declared 900
	// bytes does not, so B's pre-check — not the insert — is what refuses it.
	h := newQuotaHarness(t, quotaOpts{dailyQuota: minBillableBytes + 400})
	finishB := h.idemHold(qpPrecheck, "/api/files?ttl=7200", idemBodyBytes, map[string]string{"Idempotency-Key": idemKey})
	a := h.upload(idemKey, "?ttl=7200", idemBodyBytes)
	if a.code != http.StatusOK {
		t.Fatalf("A: %d %q", a.code, a.text)
	}
	b := finishB()
	if b.code != http.StatusOK || b.id() != a.id() || b.replay != "true" {
		t.Fatalf("B: %d %q replay=%q, want the 200 replay of %s", b.code, b.text, b.replay, a.id())
	}
	if l := h.assertOneDebitPerObject("staggered twins"); l.Files != 1 || l.Meter != idemBodyBytes {
		t.Fatalf("ledger: %+v", l)
	}
	// An unrelated key at the same full quota is still refused.
	if r := h.upload("another-key-0123456789", "?ttl=7200", idemBodyBytes); r.code != http.StatusTooManyRequests {
		t.Fatalf("different key at a full quota: %d, want 429", r.code)
	}
}

// Replay protection lasts as long as the key record does. Once the record is
// pruned (24h after its object was found gone), the same request is a NEW
// upload: a new object, a new debit, new traffic.
func TestUploadIdempotencyProtectionEndsWithTheRecord(t *testing.T) {
	h := newQuotaHarness(t, quotaOpts{})
	first := h.upload(idemKey, "?ttl=7200", idemBodyBytes)
	if r := h.idemDo(h.cookie, "DELETE", "/api/files/"+first.id(), nil, nil); r.code/100 != 2 {
		t.Fatalf("delete: %d", r.code)
	}
	now := time.Now().Unix()
	h.runGC(now) // stamps the key row
	h.runGC(now + uploadOperationGoneRetention - 1)
	if r := h.upload(idemKey, "?ttl=7200", idemBodyBytes); r.code != http.StatusGone {
		t.Fatalf("inside retention: %d, want 410", r.code)
	}
	h.runGC(now + uploadOperationGoneRetention + 1)
	if h.opRows() != 0 {
		t.Fatal("record not pruned")
	}
	r := h.upload(idemKey, "?ttl=7200", idemBodyBytes)
	if r.code != http.StatusOK || r.replay != "" || r.id() == first.id() {
		t.Fatalf("after retention: %d %q replay=%q, want a fresh upload", r.code, r.text, r.replay)
	}
	if l := h.ledger(); l.Files != 1 || l.Events != 2 || l.Meter != 2*idemBodyBytes {
		t.Fatalf("after retention the retry is a second billed upload: %+v", l)
	}
}

// The digest input is length-prefixed: parameter values holding NUL and '='
// cannot be shifted from one field into the next (Codex gate 2, finding 3).
func TestUploadOperationDigestIsUnambiguous(t *testing.T) {
	a := "burnAfterRead=x%00ttl%3D3600&ttl=7200"
	b := "burnAfterRead=x&ttl=3600%00ttl%3D7200"
	d := func(q string) []byte {
		r := &http.Request{URL: &url.URL{RawQuery: q}, ContentLength: 100}
		return uploadOperationDigest(r)
	}
	if string(d(a)) == string(d(b)) {
		t.Fatal("two different requests share a digest")
	}
	h := newQuotaHarness(t, quotaOpts{})
	if r := h.upload(idemKey, "?"+a, idemBodyBytes); r.code != http.StatusOK {
		t.Fatalf("first: %d %q", r.code, r.text)
	}
	if r := h.upload(idemKey, "?"+b, idemBodyBytes); r.code != http.StatusUnprocessableEntity {
		t.Fatalf("colliding retry: %d %q, want 422", r.code, r.text)
	}
}

// Store level: a fenced insert writes nothing on either door, and deletion
// bumps the epoch in the purge transaction.
func TestUploadFenceStore(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	uid := idemStoreUser(t, s, "fence@example.com")
	e0, err := s.UploadEpoch(ctx, uid)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	mk := func(id string) StoredFile {
		f := idemStoreFile(uid, id, "fence-key-"+id+"-0123456789", now)
		f.UploadFence = &UploadFence{Epoch: e0}
		return f
	}
	if err := s.CreateStoredFile(ctx, mk("f1")); err != nil {
		t.Fatalf("unfenced account: %v", err)
	}
	if _, err := s.PurgeTransientUserData(ctx, uid); err != nil {
		t.Fatal(err)
	}
	if e1, _ := s.UploadEpoch(ctx, uid); e1 != e0+1 {
		t.Fatalf("epoch %d after deletion, want %d", e1, e0+1)
	}
	if err := s.CreateStoredFile(ctx, mk("f2")); err != ErrUploadAccountFenced {
		t.Fatalf("uncapped door after deletion: %v", err)
	}
	f3 := mk("f3")
	f3.QuotaCharge = &UploadQuotaCharge{Event: UploadEvent{ID: "ev3", UserID: uid, Bytes: minBillableBytes, UploadedAt: now}, Since: now - dayWindow, Quota: 1 << 30}
	if _, err := s.CreateStoredFileWithinStorageCaps(ctx, f3, now, 0, 0); err != ErrUploadAccountFenced {
		t.Fatalf("capped door after deletion: %v", err)
	}
	f4 := mk("f4")
	f4.UploadFence.Epoch = e0 + 1
	if err := s.SetAccountDeletion(ctx, uid, now, now+10); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateStoredFile(ctx, f4); err != ErrUploadAccountFenced {
		t.Fatalf("current epoch but pending deletion: %v", err)
	}
	if f, e, o := idemCount(t, s, "stored_files"), idemCount(t, s, "upload_events"), idemCount(t, s, "upload_operations"); f != 0 || e != 0 || o != 0 {
		t.Fatalf("fenced inserts wrote: files=%d events=%d ops=%d", f, e, o)
	}
}
