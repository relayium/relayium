package account

import (
	"context"
	"testing"
	"time"
)

func TestNodeRelayedSince(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	jul := func(day int) int64 { return time.Date(2026, 7, day, 12, 0, 0, 0, time.UTC).Unix() }
	jun15 := time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC).Unix()
	julStart := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC).Unix()

	// This month (July): two allocs on node A (100 + 250) and one on node B (40).
	st.RecordUsage(ctx, UsageEvent{AllocID: "a1", Token: "c", UserID: "u", RelayedBytes: 100, RecordedAt: jul(2), NodeID: "A", Billable: true})
	st.RecordUsage(ctx, UsageEvent{AllocID: "a2", Token: "c", UserID: "u", RelayedBytes: 250, RecordedAt: jul(5), NodeID: "A", Billable: true})
	st.RecordUsage(ctx, UsageEvent{AllocID: "b1", Token: "c", UserID: "u", RelayedBytes: 40, RecordedAt: jul(3), NodeID: "B", Billable: true})
	// Last month (June): must be excluded by the current-month cutoff.
	st.RecordUsage(ctx, UsageEvent{AllocID: "old", Token: "c", UserID: "u", RelayedBytes: 999, RecordedAt: jun15, NodeID: "A", Billable: true})

	m, err := st.NodeRelayedSince(ctx, julStart)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if m["A"] != 350 {
		t.Fatalf("node A = %d, want 350", m["A"])
	}
	if m["B"] != 40 {
		t.Fatalf("node B = %d, want 40", m["B"])
	}
}
