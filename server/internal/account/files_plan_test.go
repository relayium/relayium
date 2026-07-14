package account

import (
	"bytes"
	"context"
	"net/http"
	"testing"
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
