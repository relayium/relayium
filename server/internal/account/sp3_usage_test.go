package account

import (
	"context"
	"testing"
)

func TestUserRelayedSinceBillableOnly(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "b@x.com", "b")
	// billable fleet-relay event
	st.RecordUsage(ctx, UsageEvent{AllocID: "a1", Token: "c1", UserID: u.ID, RelayedBytes: 1000, RecordedAt: 100, NodeID: "fleet-1", Billable: true})
	// non-billable own-node event
	st.RecordUsage(ctx, UsageEvent{AllocID: "a2", Token: "c2", UserID: u.ID, RelayedBytes: 5000, RecordedAt: 100, NodeID: "user-1", Billable: false})
	got, err := st.UserRelayedSince(ctx, u.ID, 0)
	if err != nil {
		t.Fatalf("relayed: %v", err)
	}
	if got != 1000 {
		t.Fatalf("quota sum = %d, want 1000 (billable only)", got)
	}
}
