package account

import (
	"bytes"
	"context"
	"net/http"
	"testing"
	"time"
)

// setUserPlanWith overrides a plan's caps for the test user, then assigns it.
func setUserPlanWith(t *testing.T, st *SQLiteStore, userID string, storage, traffic, retention int64) {
	t.Helper()
	ctx := context.Background()
	_ = st.UpsertPlan(ctx, Plan{ID: "free", Name: "Free", StorageBytes: storage, TrafficBytes: traffic, RetentionSecs: retention, Active: true, UpdatedAt: 1})
	_ = st.SetUserPlan(ctx, userID, "free")
}

func TestUploadRefusedOverStorage(t *testing.T) {
	ts, _, store, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "st@example.com")
	u, _ := store.UpsertUserByEmail(context.Background(), "st@example.com", "")
	setUserPlanWith(t, store, u.ID, 10 /*storage bytes*/, 1<<30, 3*86400)

	// Body larger than the 10-byte storage cap.
	resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), bytes.Repeat([]byte("A"), 50)))
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("over-storage upload = %d, want 413", resp.StatusCode)
	}
}

func TestUploadRefusedOverTraffic(t *testing.T) {
	ts, _, store, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "tr@example.com")
	u, _ := store.UpsertUserByEmail(context.Background(), "tr@example.com", "")
	setUserPlanWith(t, store, u.ID, 1<<30, 10 /*traffic bytes*/, 3*86400)

	resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), bytes.Repeat([]byte("A"), 50)))
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("over-traffic upload = %d, want 429", resp.StatusCode)
	}
}

// TestUploadRefusedOverGlobalStorage covers the M3b/plan-phase-1 global logical
// storage ceiling (overGlobalStorage in plan_enforce.go), which is checked
// BEFORE the per-plan storage/traffic gates in handleUploadFile. The user is
// given a GENEROUS plan so neither of those per-plan gates can trip; only the
// global cap (SettingStorageDiskCap) is made tight, and it must alone refuse
// the upload with 507.
func TestUploadRefusedOverGlobalStorage(t *testing.T) {
	ts, _, store, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "gs@example.com")
	u, _ := store.UpsertUserByEmail(context.Background(), "gs@example.com", "")
	// Generous per-plan storage/traffic/retention — must never be the binding limit here.
	setUserPlanWith(t, store, u.ID, 1<<30, 1<<30, 3*86400)

	// Global logical cap far below the declared upload size. overGlobalStorage
	// compares used+add > cap; a 5-byte cap against a 50-byte body trips it
	// regardless of any prior global usage (there is none in a fresh test store).
	ctx := context.Background()
	if err := store.SetSetting(ctx, SettingStorageDiskCap, 5, time.Now().Unix()); err != nil {
		t.Fatalf("SetSetting: %v", err)
	}

	resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), bytes.Repeat([]byte("A"), 50)))
	if resp.StatusCode != http.StatusInsufficientStorage {
		t.Fatalf("over-global-storage upload = %d, want 507", resp.StatusCode)
	}
}

// TestUploadTTLClampedToPlan covers the retention clamp in handleUploadFile:
// if the user's plan RetentionSecs is set, a request that asks for a much
// larger ttl gets silently clamped down to the plan cap rather than honoured
// or rejected. Storage/traffic are generous so only the clamp is exercised.
func TestUploadTTLClampedToPlan(t *testing.T) {
	ts, _, store, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "ttl@example.com")
	u, _ := store.UpsertUserByEmail(context.Background(), "ttl@example.com", "")
	const retentionSecs = 3 * 86400 // small plan cap: 3 days
	setUserPlanWith(t, store, u.ID, 1<<30, 1<<30, retentionSecs)

	before := time.Now().Unix()
	// Requested ttl (9,999,999s ≈ 115 days) is far beyond the 3-day plan cap.
	resp := postUpload(t, ts, cookie, "?ttl=9999999", uploadBody([]byte("m"), []byte("clampme")))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("upload: %d", resp.StatusCode)
	}
	after := time.Now().Unix()
	var out struct {
		ID        string `json:"id"`
		ExpiresAt int64  `json:"expiresAt"`
	}
	decodeJSON(t, resp, &out)

	// The requested ttl (9,999,999s) must have been clamped to the plan's
	// retentionSecs (3 days): expiresAt-createdAt must be <= retentionSecs, with
	// a small slack window for the request's own wall-clock execution time
	// (createdAt is read with s.now() during the handler, which for this
	// server is the real clock — hence bracketing with before/after rather
	// than a single fixed "now").
	if out.ExpiresAt > after+retentionSecs {
		t.Fatalf("ttl not clamped: expiresAt=%d, want <= now(%d)+retentionSecs(%d) = %d",
			out.ExpiresAt, after, retentionSecs, after+retentionSecs)
	}
	// Sanity: it's still a real forward-looking expiry, not zero/clamped-to-nothing.
	if out.ExpiresAt < before {
		t.Fatalf("expiresAt=%d is in the past relative to upload start %d", out.ExpiresAt, before)
	}
}

// TestDownloadRefusedWhenOwnerOverTraffic covers the download-side traffic
// gate in handleFileBlob (M-phase-1 task 8): the download is refused BEFORE
// streaming when the FILE'S OWNER is over their monthly traffic — the
// anonymous downloader's identity is never read (zero-knowledge), so quota
// is always charged to the owner regardless of who is fetching the blob.
func TestDownloadRefusedWhenOwnerOverTraffic(t *testing.T) {
	ts, _, store, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "ow@example.com")
	u, _ := store.UpsertUserByEmail(context.Background(), "ow@example.com", "")
	// Generous storage so the upload itself succeeds; tiny traffic so the
	// download trips the cap. Upload first (counts some traffic), then shrink.
	setUserPlanWith(t, store, u.ID, 1<<30, 1<<30, 3*86400)

	resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), []byte("PAYLOAD")))
	var up struct {
		ID string `json:"id"`
	}
	decodeJSON(t, resp, &up)

	// Now set the owner's traffic cap below their month-to-date usage.
	_ = store.UpsertPlan(context.Background(), Plan{ID: "free", Name: "Free", StorageBytes: 1 << 30, TrafficBytes: 1, RetentionSecs: 3 * 86400, Active: true, UpdatedAt: 2})

	br, _ := ts.Client().Get(ts.URL + "/api/files/" + up.ID + "/blob")
	br.Body.Close()
	if br.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("download for over-quota owner = %d, want 429", br.StatusCode)
	}
}
