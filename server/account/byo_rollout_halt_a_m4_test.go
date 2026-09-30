package account

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	"github.com/relayium/relayium/authx"
)

// A-M4: one account must not be able to halt the BYO rollout for everyone by
// registering many nodes (ids ground into the canary batch) and failing them.

// am4FailingSnaps returns n BYO snapshots all commanded by the current stage
// of tr and all reporting "failed".
func am4FailingSnaps(prefix string, n int, tr RolloutTrack) []NodeSnapshot {
	out := make([]NodeSnapshot, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, NodeSnapshot{
			ID: fmt.Sprintf("%s%02d", prefix, i), Version: "v0.8.0", LastSeenAt: tNow,
			UpdateStartedAt: tr.StageStartedAt, UpdateFromVersion: "v0.8.0", UpdateResult: "failed",
		})
	}
	return out
}

func am4Track() RolloutTrack {
	return RolloutTrack{Track: "byo", TargetVersion: "v0.9.0", Status: "rolling", ByoBatch: 100, StageStartedAt: tNow - 100}
}

// One owner, ten nodes, every one failed: counted once, below the floor of 2,
// so no halt. The same snapshots with no owner map (per-node, the pre-A-M4
// accounting) DO halt — that is the attack this closes.
func TestA_M4_OneOwnerManyFailuresCannotHalt(t *testing.T) {
	tr := am4Track()
	snaps := am4FailingSnaps("evil", 10, tr)
	owners := map[string]string{}
	for _, n := range snaps {
		owners[n.ID] = "attacker"
	}
	if action, _, reason := decideByoOwned(tr, snaps, owners, tNow); action == "halt" {
		t.Fatalf("one owner's 10 failing nodes halted the BYO track: %q", reason)
	}
	if action, _, _ := decideByo(tr, snaps, tNow); action != "halt" {
		t.Fatalf("control: per-node accounting of the same input should halt, got %q", action)
	}
}

// Positive control: two distinct owners failing still halt under the existing
// thresholds (2 of 3 owners = 67% > 20%, count 2 >= floor), even when the
// attacker-sized owner contributes many nodes.
func TestA_M4_TwoOwnersFailingStillHalt(t *testing.T) {
	tr := am4Track()
	a := am4FailingSnaps("a", 6, tr)
	b := am4FailingSnaps("b", 1, tr)
	c := am4FailingSnaps("c", 1, tr)
	c[0].UpdateResult = "" // commanded, no failure
	owners := map[string]string{}
	for _, n := range a {
		owners[n.ID] = "user-a"
	}
	owners[b[0].ID] = "user-b"
	owners[c[0].ID] = "user-c"
	all := append(append(append([]NodeSnapshot{}, a...), b...), c...)
	action, _, reason := decideByoOwned(tr, all, owners, tNow)
	if action != "halt" {
		t.Fatalf("two distinct owners failing: action = %q, want halt", action)
	}
	if want := "byo rollout: 2/3 owners (7/8 nodes)"; len(reason) < len(want) || reason[:len(want)] != want {
		t.Fatalf("halt reason = %q, want prefix %q", reason, want)
	}

	// The rate threshold is still per owner: 2 failing of 10 commanded owners
	// is 20%, NOT above the threshold, so no halt.
	var wide []NodeSnapshot
	wideOwners := map[string]string{}
	for i := 0; i < 10; i++ {
		s := am4FailingSnaps(fmt.Sprintf("w%d-", i), 1, tr)[0]
		if i >= 2 {
			s.UpdateResult = ""
		}
		wide = append(wide, s)
		wideOwners[s.ID] = fmt.Sprintf("user-%d", i)
	}
	if action, _, reason := decideByoOwned(tr, wide, wideOwners, tNow); action == "halt" {
		t.Fatalf("2/10 owners (20%%, not above threshold) halted: %q", reason)
	}
}

// Through the real update-check endpoint: the owner map is built from the
// stored rows. One account's four failing nodes do not halt; the same setup
// with one of the failing nodes belonging to a second account does. (Each case
// is a fresh server: a non-halting poll re-commands the batch, which clears
// the failure results.)
func TestA_M4_UpdateCheckCountsFailuresPerOwner(t *testing.T) {
	for _, tc := range []struct {
		name       string
		twoOwners  bool
		wantStatus string
	}{
		{"one account", false, "rolling"},
		{"two accounts", true, "halted"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ts, _, st := newUpdateCheckServer(t)
			ctx := context.Background()
			if err := st.PutRolloutTrack(ctx, RolloutTrack{
				Track: "byo", TargetVersion: "v0.9.0", Status: "rolling",
				ByoBatch: 100, StageStartedAt: tNow - 100000,
			}); err != nil {
				t.Fatal(err)
			}
			snaps := newByoFleet(t, st, 5, "v0.8.0") // all owned by one user
			if tc.twoOwners {
				u2, err := st.UpsertUserByEmail(ctx, "am4-second@example.com", "s")
				if err != nil {
					t.Fatal(err)
				}
				if _, err := st.db.ExecContext(ctx, `UPDATE nodes SET owner_user_id = ? WHERE id = ?`, u2.ID, snaps[0].ID); err != nil {
					t.Fatal(err)
				}
			}
			for _, n := range snaps {
				if err := st.CommandNodeUpdate(ctx, n.ID, "v0.8.0", tNow-100000); err != nil {
					t.Fatal(err)
				}
			}
			for _, n := range snaps[:4] {
				if err := st.SetNodeUpdateResult(ctx, n.ID, "failed"); err != nil {
					t.Fatal(err)
				}
			}
			postUpdateCheck(t, ts, "user-token", updateCheckReq{NodeID: snaps[4].ID, CurrentVersion: "v0.8.0"})
			got, _, err := st.GetRolloutTrack(ctx, "byo")
			if err != nil {
				t.Fatal(err)
			}
			if got.Status != tc.wantStatus {
				t.Fatalf("track = %q (%q), want %q", got.Status, got.HaltedReason, tc.wantStatus)
			}
		})
	}
}

// Registration cap: a user at maxLiveNodesPerUser live nodes cannot register a
// new id (or an empty one), but re-registering a node they already have works,
// a deregistered node frees a slot, and another user is unaffected.
func TestA_M4_RegisterCapsLiveUserNodes(t *testing.T) {
	s, st, u1, _ := am3Service(t)
	ctx := context.Background()
	var ids []string
	for i := 0; i < maxLiveNodesPerUser; i++ {
		got := am3Register(t, s, "owner-token", authx.NewID())
		if got.Code != http.StatusOK {
			t.Fatalf("node %d under the cap: got %d (%q)", i, got.Code, got.Error)
		}
		ids = append(ids, got.NodeID)
	}
	for _, id := range []string{authx.NewID(), ""} {
		got := am3Register(t, s, "owner-token", id)
		if got.Code != http.StatusForbidden || got.Reason != nodeRegisterCodeLimit {
			t.Fatalf("new id %q past the cap: got %d code=%q (%q), want 403 %q", id, got.Code, got.Reason, got.Error, nodeRegisterCodeLimit)
		}
		if id != "" {
			if _, ok, _ := st.GetNode(ctx, id); ok {
				t.Fatal("a refused registration still created the node row")
			}
		}
	}
	if n, _ := st.CountLiveUserNodes(ctx, u1.ID); n != maxLiveNodesPerUser {
		t.Fatalf("live nodes = %d, want exactly the cap %d", n, maxLiveNodesPerUser)
	}
	// Re-register at the cap: allowed.
	if got := am3Register(t, s, "owner-token", ids[3]); got.Code != http.StatusOK {
		t.Fatalf("re-register of an existing node at the cap: got %d (%q), want 200", got.Code, got.Error)
	}
	// Another account is not affected by this one's cap.
	if got := am3Register(t, s, "attacker-token", authx.NewID()); got.Code != http.StatusOK {
		t.Fatalf("another user's first node: got %d (%q), want 200", got.Code, got.Error)
	}
	// A deregistered node frees its slot.
	if err := st.MarkNodeRemoved(ctx, ids[0], tNow); err != nil {
		t.Fatal(err)
	}
	if got := am3Register(t, s, "owner-token", authx.NewID()); got.Code != http.StatusOK {
		t.Fatalf("new id after one node was deregistered: got %d (%q), want 200", got.Code, got.Error)
	}
}

// An account already OVER the cap (nodes from before it existed) keeps every
// node: each re-registers; only a new id is refused.
func TestA_M4_OverCapAccountKeepsExistingNodes(t *testing.T) {
	s, st, u1, _ := am3Service(t)
	ctx := context.Background()
	var ids []string
	for i := 0; i < maxLiveNodesPerUser+3; i++ {
		n, err := st.UpsertNode(ctx, Node{ID: authx.NewID(), OwnerType: "user", OwnerUserID: u1.ID,
			URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, n.ID)
	}
	for _, id := range ids {
		if got := am3Register(t, s, "owner-token", id); got.Code != http.StatusOK {
			t.Fatalf("existing node %s of an over-cap account: got %d (%q), want 200", id, got.Code, got.Error)
		}
	}
	if got := am3Register(t, s, "owner-token", authx.NewID()); got.Code != http.StatusForbidden {
		t.Fatalf("new id for an over-cap account: got %d, want 403", got.Code)
	}
}
