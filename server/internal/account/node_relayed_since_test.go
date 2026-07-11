package account

import (
	"context"
	"testing"
)

func TestNodeRelayedSince(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	// Two allocs on node A (100 + 250) and one on node B (40), all this period;
	// one older alloc on A (999) that must be excluded by the `since` cutoff.
	st.RecordUsage(ctx, UsageEvent{AllocID: "a1", Token: "c", UserID: "u", RelayedBytes: 100, RecordedAt: 2000, NodeID: "A", Billable: true})
	st.RecordUsage(ctx, UsageEvent{AllocID: "a2", Token: "c", UserID: "u", RelayedBytes: 250, RecordedAt: 2500, NodeID: "A", Billable: true})
	st.RecordUsage(ctx, UsageEvent{AllocID: "b1", Token: "c", UserID: "u", RelayedBytes: 40, RecordedAt: 2100, NodeID: "B", Billable: true})
	st.RecordUsage(ctx, UsageEvent{AllocID: "old", Token: "c", UserID: "u", RelayedBytes: 999, RecordedAt: 100, NodeID: "A", Billable: true})

	m, err := st.NodeRelayedSince(ctx, 1000)
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
