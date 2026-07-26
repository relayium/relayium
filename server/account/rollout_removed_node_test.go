package account

import (
	"context"
	"net/http"
	"testing"
)

// A deregistered node must never be commanded to self-update, ON ANY PATH.
//
// The staged ladders cannot do it: their snapshot comes from NodesByOwnerType,
// which filters removed_at = 0, and the fleet path additionally refuses to act
// for anyone but d.NodeID. The EMERGENCY path had no such protection — it reads
// the node with an unfiltered GetNode and commands it directly — so a machine
// that is being uninstalled right now (deregister happens seconds BEFORE the
// service stops) was still told to download and install a new binary.
func TestUpdateCheckNeverCommandsRemovedNode(t *testing.T) {
	for _, tc := range []struct {
		name      string
		emergency bool
	}{
		{"emergency release", true},
		{"staged ladder", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ts, s, st := newUpdateCheckServer(t)
			ctx := context.Background()
			if err := st.PutRolloutTrack(ctx, RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
				StageStartedAt: tNow, Emergency: tc.emergency,
			}); err != nil {
				t.Fatal(err)
			}
			if _, err := st.UpsertNode(ctx, Node{
				ID: "n1", OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s",
				Version: "v0.8.0", CreatedAt: 1, LastSeenAt: tNow,
			}); err != nil {
				t.Fatal(err)
			}
			// The uninstaller has already told central this machine is going away.
			if err := st.MarkNodeRemoved(ctx, "n1", tNow); err != nil {
				t.Fatal(err)
			}

			resp, out := postUpdateCheck(t, ts, "fleet-secret", updateCheckReq{
				NodeID: "n1", CurrentVersion: "v0.8.0"})
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("update-check: got %d want 200", resp.StatusCode)
			}
			if out.Eligible {
				t.Fatalf("a deregistered node was told it may self-update (reason %q)", out.Reason)
			}
			// Eligible=false is not enough on its own: the emergency path wrote
			// update_started_at BEFORE answering, so the node's row must be clean
			// too or a later poll/resume path can still act on that command record.
			n, _, err := s.store.GetNode(ctx, "n1")
			if err != nil {
				t.Fatal(err)
			}
			if n.UpdateStartedAt != 0 {
				t.Fatalf("update_started_at = %d, want 0: a removed node must never be commanded", n.UpdateStartedAt)
			}
		})
	}
}

// A refusal must mean NOTHING was written, not just "nothing was commanded".
// The removed-node guard used to sit AFTER SetNodeUpdateResult, so a removed
// node piggybacking Result:"failed" on its poll (a real shape: the updater
// reports the outcome of whatever it was doing right up to the moment it was
// told to deregister) got update_result="failed" persisted before being
// refused.
func TestUpdateCheckRemovedNodeResultNotPersisted(t *testing.T) {
	ts, s, st := newUpdateCheckServer(t)
	ctx := context.Background()
	if err := st.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling", StageStartedAt: tNow,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpsertNode(ctx, Node{
		ID: "n1", OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s",
		Version: "v0.8.0", CreatedAt: 1, LastSeenAt: tNow,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.MarkNodeRemoved(ctx, "n1", tNow); err != nil {
		t.Fatal(err)
	}

	_, out := postUpdateCheck(t, ts, "fleet-secret", updateCheckReq{
		NodeID: "n1", CurrentVersion: "v0.8.0", Result: "failed"})
	if out.Eligible {
		t.Fatalf("a deregistered node was told it may self-update (reason %q)", out.Reason)
	}
	n, _, err := s.store.GetNode(ctx, "n1")
	if err != nil {
		t.Fatal(err)
	}
	if n.UpdateResult != "" {
		t.Fatalf("update_result = %q, want %q: a removed node's report must not be persisted, its refusal writes nothing", n.UpdateResult, "")
	}
}
