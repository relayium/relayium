package account

import (
	"context"
	"testing"
)

// A reserved daily-quota event can be refunded, so a finalize that reserves quota
// but is then rejected by the authoritative storage-cap gate doesn't leave the
// user charged for a file that never landed.
func TestRefundUploadReleasesDailyQuota(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "refund@example.com", "R")

	ok, err := st.ReserveUpload(ctx, UploadEvent{ID: "ev1", UserID: u.ID, Bytes: 1000, UploadedAt: 500}, 0, 1<<40)
	if err != nil || !ok {
		t.Fatalf("reserve: ok=%v err=%v", ok, err)
	}
	if used, _ := st.UserUploadedSince(ctx, u.ID, 0); used != 1000 {
		t.Fatalf("after reserve, used = %d, want 1000", used)
	}

	if err := st.RefundUpload(ctx, "ev1"); err != nil {
		t.Fatal(err)
	}
	if used, _ := st.UserUploadedSince(ctx, u.ID, 0); used != 0 {
		t.Fatalf("after refund, used = %d, want 0 (quota released)", used)
	}
	// Refunding an unknown id is a harmless no-op.
	if err := st.RefundUpload(ctx, "nope"); err != nil {
		t.Fatalf("refund of unknown id must be a no-op, got %v", err)
	}
}
