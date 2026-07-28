package account

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"
)

func reachableTestNode(id, ip string, now int64) Node {
	return Node{
		OwnerType: "fleet", ID: id, URLs: []string{"turn:" + ip + ":3478"}, TURNSecret: "s",
		CreatedAt: 1, LastSeenAt: now, StorageEnabled: true,
		StorageURL: "https://" + ip + ":8081", StorageFP: "ab",
		StorageTotal: 200 << 30, StorageFree: 150 << 30,
	}
}

// The heartbeat is node→central; blob writes are central→node. A node whose
// blob port is firewalled shut keeps heartbeating perfectly and so keeps being
// picked for placement, and every chunk PATCH against it 500s forever.
func TestStorageNodesExcludesAnUnreachableBlobEndpoint(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	const now = 10000

	st.UpsertNode(ctx, reachableTestNode("alive", "1.1.1.1", now))
	st.UpsertNode(ctx, reachableTestNode("dead", "2.2.2.2", now))

	// Never probed yet: eligible. The gate fails OPEN, so a prober that is
	// broken or has not run cannot empty the placement pool.
	if nodes, err := st.StorageNodes(ctx, now-1, 0); err != nil || len(nodes) != 2 {
		t.Fatalf("unprobed nodes must stay eligible: got %d, err %v", len(nodes), err)
	}

	if err := st.SetNodeStorageReachable(ctx, "dead", false, now); err != nil {
		t.Fatalf("SetNodeStorageReachable: %v", err)
	}

	nodes, err := st.StorageNodes(ctx, now-1, 0)
	if err != nil {
		t.Fatalf("StorageNodes: %v", err)
	}
	if len(nodes) != 1 || nodes[0].ID != "alive" {
		t.Fatalf("an unreachable blob endpoint must not be offered for placement, got %+v", nodes)
	}
}

// Recovery has to come from a successful probe, not from a heartbeat: the node
// heartbeats every few seconds and would otherwise clear its own mark
// immediately, putting it straight back into the pool it just failed out of.
func TestHeartbeatDoesNotClearAnUnreachableMark(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	const now = 10000

	st.UpsertNode(ctx, reachableTestNode("dead", "2.2.2.2", now))
	if err := st.SetNodeStorageReachable(ctx, "dead", false, now); err != nil {
		t.Fatalf("SetNodeStorageReachable: %v", err)
	}

	// A routine re-register/heartbeat.
	st.UpsertNode(ctx, reachableTestNode("dead", "2.2.2.2", now+30))

	if nodes, err := st.StorageNodes(ctx, now-1, 0); err != nil || len(nodes) != 0 {
		t.Fatalf("a heartbeat must not restore placement eligibility, got %d nodes, err %v", len(nodes), err)
	}

	// A successful probe does.
	if err := st.SetNodeStorageReachable(ctx, "dead", true, now+60); err != nil {
		t.Fatalf("SetNodeStorageReachable: %v", err)
	}
	if nodes, err := st.StorageNodes(ctx, now-1, 0); err != nil || len(nodes) != 1 {
		t.Fatalf("a successful probe must restore eligibility, got %d nodes, err %v", len(nodes), err)
	}
}

// A strict (own-nodes-only) user whose node is unreachable must be told that,
// not "no free space" — the previous strict branch assumed non-selection could
// only ever mean a full disk, which stopped being true once reachability
// became a placement condition.
func TestStrictUserGetsTheReachabilityReasonNotDiskFull(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	const now = 10000
	s := &Service{store: st, now: func() time.Time { return time.Unix(now, 0) },
		nodeHTTP: http.DefaultClient, cfg: Config{MaxFileSize: 1 << 20},
		pickN: func(n int) int { return 0 }}

	u, err := st.UpsertUserByEmail(ctx, "strict@example.com", "Strict")
	if err != nil {
		t.Fatalf("UpsertUserByEmail: %v", err)
	}
	if err := st.SetOnlyOwnNodes(ctx, u.ID, true); err != nil {
		t.Fatalf("SetOnlyOwnNodes: %v", err)
	}

	own := reachableTestNode("mine", "5.5.5.5", now)
	own.OwnerType = "user"
	own.OwnerUserID = u.ID
	st.UpsertNode(ctx, own)

	// Reachable: placement picks it, unbilled.
	if id, _, billable, perr := s.placeUpload(ctx, u.ID, 1<<10); id != "mine" || billable || perr != nil {
		t.Fatalf("own reachable node should be chosen unbilled, got %q billable=%v err=%v", id, billable, perr)
	}

	if err := st.SetNodeStorageReachable(ctx, "mine", false, now); err != nil {
		t.Fatalf("SetNodeStorageReachable: %v", err)
	}

	_, _, _, perr := s.placeUpload(ctx, u.ID, 1<<10)
	if !errors.Is(perr, errStrictNodeUnreachable) {
		t.Fatalf("want errStrictNodeUnreachable, got %v", perr)
	}
}
