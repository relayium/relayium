package account

import (
	"context"
	"errors"
	"testing"
)

func TestNodeLimitsRoundTripAndPreserveOnUpsert(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	n, err := st.UpsertNode(ctx, Node{OwnerType: "fleet", URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	// Defaults are unlimited (0).
	if got, _, _ := st.GetNode(ctx, n.ID); got.TrafficLimitBytes != 0 || got.DiskLimitBytes != 0 {
		t.Fatalf("defaults not zero: %+v", got)
	}
	// Admin sets limits.
	if err := st.SetNodeLimits(ctx, n.ID, 500<<30, 100<<30); err != nil {
		t.Fatalf("setlimits: %v", err)
	}
	got, _, _ := st.GetNode(ctx, n.ID)
	if got.TrafficLimitBytes != 500<<30 || got.DiskLimitBytes != 100<<30 {
		t.Fatalf("limits not stored: %+v", got)
	}
	// A re-register (upsert of same id) must NOT reset admin-set limits.
	if _, err := st.UpsertNode(ctx, Node{ID: n.ID, OwnerType: "fleet", URLs: []string{"turn:2.2.2.2:3478"}, TURNSecret: "s2", CreatedAt: 1, LastSeenAt: 2}); err != nil {
		t.Fatalf("re-upsert: %v", err)
	}
	got, _, _ = st.GetNode(ctx, n.ID)
	if got.TrafficLimitBytes != 500<<30 || got.DiskLimitBytes != 100<<30 {
		t.Fatalf("limits lost on re-register: %+v", got)
	}
}

func TestDeleteFleetNodeScoped(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	fleet, _ := st.UpsertNode(ctx, Node{OwnerType: "fleet", URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
	user, _ := st.UpsertNode(ctx, Node{OwnerType: "user", OwnerUserID: "u1", URLs: []string{"turn:2.2.2.2:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})

	// A user node must not be deletable via DeleteFleetNode.
	if err := st.DeleteFleetNode(ctx, user.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("user node via DeleteFleetNode: want ErrNotFound, got %v", err)
	}
	// The fleet node deletes.
	if err := st.DeleteFleetNode(ctx, fleet.ID); err != nil {
		t.Fatalf("delete fleet: %v", err)
	}
	if _, ok, _ := st.GetNode(ctx, fleet.ID); ok {
		t.Fatal("fleet node still present")
	}
}

func TestDeleteUserNodeScopedAndClearsOnlyItsPendingDeletes(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	userNode, _ := st.UpsertNode(ctx, Node{OwnerType: "user", OwnerUserID: "u1", URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
	otherNode, _ := st.UpsertNode(ctx, Node{OwnerType: "user", OwnerUserID: "u2", URLs: []string{"turn:2.2.2.2:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
	if err := st.EnqueueNodeDelete(ctx, "user-blob", userNode.ID, 1); err != nil {
		t.Fatalf("enqueue user node delete: %v", err)
	}
	if err := st.EnqueueNodeDelete(ctx, "other-blob", otherNode.ID, 1); err != nil {
		t.Fatalf("enqueue other node delete: %v", err)
	}

	if err := st.DeleteNode(ctx, userNode.ID, "u2"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("wrong owner DeleteNode: want ErrNotFound, got %v", err)
	}
	if _, ok, _ := st.GetNode(ctx, userNode.ID); !ok {
		t.Fatal("wrong owner deleted the user node")
	}
	if _, ok := pendingKeys(t, st)["user-blob"]; !ok {
		t.Fatal("wrong owner retired the node's pending delete")
	}

	if err := st.DeleteNode(ctx, userNode.ID, "u1"); err != nil {
		t.Fatalf("delete user node: %v", err)
	}
	if _, ok, _ := st.GetNode(ctx, userNode.ID); ok {
		t.Fatal("user node still present")
	}
	left := pendingKeys(t, st)
	if _, ok := left["user-blob"]; ok {
		t.Fatal("deleted user node left its pending delete behind")
	}
	if _, ok := left["other-blob"]; !ok {
		t.Fatal("deleting one user node retired another node's pending delete")
	}
}
