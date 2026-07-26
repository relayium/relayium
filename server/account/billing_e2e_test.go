package account

import (
	"bytes"
	"context"
	"net/http"
	"testing"
	"time"
)

// TestFreePlanEndToEnd is a black-box end-to-end check that a Free-tier user
// (small storage/traffic caps, short retention) is actually gated by the
// full upload stack: a small upload succeeds with its TTL clamped to the
// plan's retention, and an upload beyond the plan's storage cap is refused.
//
// This mirrors TestUploadTTLClampedToPlan and TestUploadRefusedOverStorage in
// files_plan_test.go, combined into a single Free-plan scenario as required
// by task 12.
func TestFreePlanEndToEnd(t *testing.T) {
	ts, _, store, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "free@example.com")
	u, _ := store.UpsertUserByEmail(context.Background(), "free@example.com", "")
	// storage 100 bytes, traffic 500 bytes, retention 3 days.
	const retentionSecs = 3 * 86400
	_ = store.UpsertPlan(context.Background(), Plan{ID: "free", Name: "Free", StorageBytes: 100, TrafficBytes: 500, RetentionSecs: retentionSecs, Active: true, UpdatedAt: 1})
	_ = store.SetUserPlan(context.Background(), u.ID, "free", time.Now().Unix())

	// Small upload succeeds and its TTL is clamped to <= 3 days even if asked for more.
	before := time.Now().Unix()
	resp := postUpload(t, ts, cookie, "?ttl=9999999", uploadBody([]byte("m"), []byte("hi")))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("small upload = %d, want 200", resp.StatusCode)
	}
	after := time.Now().Unix()
	var up struct {
		ID        string `json:"id"`
		ExpiresAt int64  `json:"expiresAt"`
	}
	decodeJSON(t, resp, &up)

	// expiresAt must be within ~3 days of now. createdAt is read with s.now()
	// during the handler, which for this test server is the real wall clock
	// (see TestUploadTTLClampedToPlan) — so bracket with before/after rather
	// than a single fixed timestamp, and assert the clamp against the upper
	// bound (after) rather than requiring an exact retentionSecs delta.
	if up.ExpiresAt > after+retentionSecs {
		t.Fatalf("ttl not clamped: expiresAt=%d, want <= now(%d)+retentionSecs(%d) = %d",
			up.ExpiresAt, after, retentionSecs, after+retentionSecs)
	}
	if up.ExpiresAt < before {
		t.Fatalf("expiresAt=%d is in the past relative to upload start %d", up.ExpiresAt, before)
	}

	// Upload beyond the 100-byte storage cap → 413.
	big := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), bytes.Repeat([]byte("A"), 300)))
	if big.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("over-storage upload = %d, want 413", big.StatusCode)
	}
}
