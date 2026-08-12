package account

import (
	"context"
	"testing"
)

// fast_after_canary arrives by ALTER on live databases and rolloutCols is
// positional, so a drift between the SELECT and the upsert would silently swap
// it with a neighbouring column rather than erroring. Round-trip it explicitly,
// and alongside the two flags it now sits next to.
func TestRolloutTrackFastAfterCanaryRoundTrips(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	want := RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", CurrentNodeID: "node7",
		FirstNodeID: "node7", StageStartedAt: 1000, Status: "rolling", FastAfterCanary: true,
	}
	if err := store.PutRolloutTrack(ctx, want); err != nil {
		t.Fatalf("PutRolloutTrack: %v", err)
	}
	got, ok, err := store.GetRolloutTrack(ctx, "fleet")
	if err != nil || !ok {
		t.Fatalf("GetRolloutTrack: ok=%v err=%v", ok, err)
	}
	if got != want {
		t.Fatalf("round trip = %+v, want %+v", got, want)
	}

	// The three flags are independent columns, and the round trip has to prove
	// each one moves on its own — a positional drift that swapped two of them
	// would still round-trip a row with both set.
	for _, c := range []struct {
		name                               string
		emergency, manualFast, afterCanary bool
	}{
		{name: "emergency only", emergency: true},
		{name: "manual fast only", manualFast: true},
		{name: "canary-then-fast only", afterCanary: true},
		{name: "none"},
	} {
		t.Run(c.name, func(t *testing.T) {
			row := want
			row.Emergency, row.ManualFast, row.FastAfterCanary = c.emergency, c.manualFast, c.afterCanary
			if err := store.PutRolloutTrack(ctx, row); err != nil {
				t.Fatal(err)
			}
			got, _, _ := store.GetRolloutTrack(ctx, "fleet")
			if got.Emergency != c.emergency || got.ManualFast != c.manualFast || got.FastAfterCanary != c.afterCanary {
				t.Fatalf("flags = %v/%v/%v, want %v/%v/%v",
					got.Emergency, got.ManualFast, got.FastAfterCanary, c.emergency, c.manualFast, c.afterCanary)
			}
		})
	}
}

// A database that predates the column must read as "not in this mode", which is
// the only safe default: it is what an existing rolling track was, and reading
// the column as set would tell decideFleet that a staged rollout's later nodes
// may skip their soak.
func TestRolloutTrackFastAfterCanaryDefaultsOffOnMigratedRows(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	// A row written by the previous schema: every column the old code knew
	// about, none of the new one.
	if _, err := store.db.ExecContext(ctx,
		`INSERT INTO node_rollout (track, target_version, status, manual_fast)
		 VALUES ('fleet', 'v0.9.0', 'rolling', 1)`); err != nil {
		t.Fatal(err)
	}
	got, ok, err := store.GetRolloutTrack(ctx, "fleet")
	if err != nil || !ok {
		t.Fatalf("GetRolloutTrack: ok=%v err=%v", ok, err)
	}
	if got.FastAfterCanary {
		t.Fatal("a row from before this column reads as canary-then-fast mode")
	}
	// ...and the mode it WAS in survives the migration unchanged. A rollout in
	// flight when this deploys must not change what it is doing.
	if !got.ManualFast {
		t.Fatal("the migration lost an in-flight rollout's existing mode")
	}
}

// The safe start's own compare-and-swap: only "no row at all" or a FINISHED row
// on exactly the version the operator was shown. Anything else must write
// NOTHING — a rollout in flight is the one thing this may never replace, and a
// paused one belongs to 继续.
func TestStartCanaryFastRolloutRefusesEveryUnstartableState(t *testing.T) {
	cases := []struct {
		name         string
		row          *RolloutTrack
		expectStatus string
		expectVer    string
	}{
		{
			name:         "rolling",
			row:          &RolloutTrack{Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling", CurrentNodeID: "n1"},
			expectStatus: "rolling", expectVer: "v0.9.0",
		},
		{
			name:         "halted",
			row:          &RolloutTrack{Track: "fleet", TargetVersion: "v0.9.0", Status: "halted", HaltedReason: "n1 rolled back"},
			expectStatus: "halted", expectVer: "v0.9.0",
		},
		{
			name:         "complete but a different version than the page showed",
			row:          &RolloutTrack{Track: "fleet", TargetVersion: "v0.9.1", Status: "complete"},
			expectStatus: "complete", expectVer: "v0.9.0",
		},
		{
			name:         "no row expected, but one appeared",
			row:          &RolloutTrack{Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling"},
			expectStatus: "", expectVer: "",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			store := newTestStore(t)
			ctx := context.Background()
			if err := store.PutRolloutTrack(ctx, *c.row); err != nil {
				t.Fatal(err)
			}
			before, _, _ := store.GetRolloutTrack(ctx, "fleet")

			ok, err := store.StartCanaryFastRollout(ctx, "fleet", c.expectStatus, c.expectVer, "v1.0.0", 2000)
			if err != nil {
				t.Fatal(err)
			}
			if ok {
				t.Fatal("StartCanaryFastRollout accepted an unstartable state")
			}
			if got, _, _ := store.GetRolloutTrack(ctx, "fleet"); got != before {
				t.Fatalf("a refused start mutated the row:\ngot  %+v\nwant %+v", got, before)
			}
		})
	}
}

// The two startable states, and what the row must look like afterwards: rolling,
// on the new target, in the SAFE mode, with the previous rollout's positional
// state cleared so a fresh canary is picked.
func TestStartCanaryFastRolloutStartsFromAFinishedTrackOrNoRow(t *testing.T) {
	t.Run("finished track", func(t *testing.T) {
		store := newTestStore(t)
		ctx := context.Background()
		if err := store.PutRolloutTrack(ctx, RolloutTrack{
			Track: "fleet", TargetVersion: "v0.9.0", Status: "complete",
			CurrentNodeID: "n3", FirstNodeID: "n3", ByoBatch: 50, HaltedReason: "stale",
		}); err != nil {
			t.Fatal(err)
		}
		ok, err := store.StartCanaryFastRollout(ctx, "fleet", "complete", "v0.9.0", "v1.0.0", 2000)
		if err != nil || !ok {
			t.Fatalf("StartCanaryFastRollout: ok=%v err=%v", ok, err)
		}
		got, _, _ := store.GetRolloutTrack(ctx, "fleet")
		want := RolloutTrack{
			Track: "fleet", TargetVersion: "v1.0.0", Status: "rolling",
			StageStartedAt: 2000, FastAfterCanary: true,
		}
		if got != want {
			t.Fatalf("after start = %+v, want %+v", got, want)
		}
	})

	t.Run("no row at all", func(t *testing.T) {
		store := newTestStore(t)
		ctx := context.Background()
		ok, err := store.StartCanaryFastRollout(ctx, "fleet", "", "", "v1.0.0", 2000)
		if err != nil || !ok {
			t.Fatalf("StartCanaryFastRollout: ok=%v err=%v", ok, err)
		}
		got, _, _ := store.GetRolloutTrack(ctx, "fleet")
		want := RolloutTrack{
			Track: "fleet", TargetVersion: "v1.0.0", Status: "rolling",
			StageStartedAt: 2000, FastAfterCanary: true,
		}
		if got != want {
			t.Fatalf("after start = %+v, want %+v", got, want)
		}
	})
}

// THE MODES ARE MUTUALLY EXCLUSIVE, and neither start may inherit the other's
// flag from the finished row it replaces. A row carrying two modes is not a
// display problem: it is a decideFleet precedence question, i.e. a canary window
// whose presence depends on which branch happened to be checked first.
func TestFastStartsAreMutuallyExclusive(t *testing.T) {
	t.Run("safe start clears manual fast", func(t *testing.T) {
		store := newTestStore(t)
		ctx := context.Background()
		if err := store.PutRolloutTrack(ctx, RolloutTrack{
			Track: "fleet", TargetVersion: "v0.9.0", Status: "complete",
			ManualFast: true, Emergency: true,
		}); err != nil {
			t.Fatal(err)
		}
		ok, err := store.StartCanaryFastRollout(ctx, "fleet", "complete", "v0.9.0", "v1.0.0", 2000)
		if err != nil || !ok {
			t.Fatalf("StartCanaryFastRollout: ok=%v err=%v", ok, err)
		}
		got, _, _ := store.GetRolloutTrack(ctx, "fleet")
		if !got.FastAfterCanary || got.ManualFast || got.Emergency {
			t.Fatalf("modes = fastAfterCanary:%v manualFast:%v emergency:%v, want only the first",
				got.FastAfterCanary, got.ManualFast, got.Emergency)
		}
	})

	t.Run("manual fast start clears the safe mode", func(t *testing.T) {
		store := newTestStore(t)
		ctx := context.Background()
		if err := store.PutRolloutTrack(ctx, RolloutTrack{
			Track: "fleet", TargetVersion: "v0.9.0", Status: "complete",
			FastAfterCanary: true, Emergency: true,
		}); err != nil {
			t.Fatal(err)
		}
		ok, err := store.StartManualFastRollout(ctx, "fleet", "complete", "v0.9.0", "v1.0.0", 2000)
		if err != nil || !ok {
			t.Fatalf("StartManualFastRollout: ok=%v err=%v", ok, err)
		}
		got, _, _ := store.GetRolloutTrack(ctx, "fleet")
		if !got.ManualFast || got.FastAfterCanary || got.Emergency {
			t.Fatalf("modes = manualFast:%v fastAfterCanary:%v emergency:%v, want only the first",
				got.ManualFast, got.FastAfterCanary, got.Emergency)
		}
	})
}

// The safe start is another way a fleet ladder BEGINS, so it must hand back the
// candidacy of nodes an earlier rollout moved on without — and it must do so in
// the same transaction as the row write, so a REFUSED start writes nothing at
// all. Both halves in one test because they are one property.
func TestStartCanaryFastRolloutClearsPassedOverResultsOnlyWhenItStarts(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	u, err := store.UpsertUserByEmail(ctx, "canary@example.test", "C")
	if err != nil {
		t.Fatal(err)
	}
	seedRolloutNode(t, store, "n1", "fleet", "", "v0.9.0", "", "unreachable")
	seedRolloutNode(t, store, "n2", "fleet", "", "v0.9.0", "", "failed")
	seedRolloutNode(t, store, "u1", "user", u.ID, "v0.9.0", "", "skipped")

	// A refusal first: the markers must survive it untouched, because the
	// panel's finished-but-incomplete count and the per-node retry guard are
	// both derived from them.
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling", CurrentNodeID: "n2",
	}); err != nil {
		t.Fatal(err)
	}
	if ok, err := store.StartCanaryFastRollout(ctx, "fleet", "complete", "v0.9.0", "v1.0.0", 1000); err != nil || ok {
		t.Fatalf("StartCanaryFastRollout against a rolling track: ok=%v err=%v", ok, err)
	}
	if n, _, _ := store.GetNode(ctx, "n1"); n.UpdateResult != "unreachable" {
		t.Fatalf("a refused start cleared a passed-over marker: %q", n.UpdateResult)
	}

	// Now the accepted start.
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "complete",
	}); err != nil {
		t.Fatal(err)
	}
	if ok, err := store.StartCanaryFastRollout(ctx, "fleet", "complete", "v0.9.0", "v1.0.0", 1000); err != nil || !ok {
		t.Fatalf("StartCanaryFastRollout: ok=%v err=%v", ok, err)
	}
	if n, _, _ := store.GetNode(ctx, "n1"); n.UpdateResult != "" {
		t.Errorf("passed-over fleet node kept update_result %q", n.UpdateResult)
	}
	// A failure is the judgement that stopped a track: carried past, never
	// forgotten.
	if n, _, _ := store.GetNode(ctx, "n2"); n.UpdateResult != "failed" {
		t.Errorf("failed fleet node lost its result: %q", n.UpdateResult)
	}
	// The tracks stay independent.
	if n, _, _ := store.GetNode(ctx, "u1"); n.UpdateResult != "skipped" {
		t.Errorf("a fleet start cleared a user node's result: %q", n.UpdateResult)
	}
}

// 继续 restarts the ladder from the beginning and deliberately returns it to the
// STAGED rhythm. It picks a FRESH canary, so "the machines after the canary need
// no soak" is a judgement that has to be made again — with the halt that just
// happened in view.
func TestResumeRolloutTrackDisarmsFastAfterCanary(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "halted",
		HaltedReason: "node n1 rolled back", FastAfterCanary: true,
		CurrentNodeID: "n1", FirstNodeID: "n1",
	}); err != nil {
		t.Fatal(err)
	}
	ok, err := store.ResumeRolloutTrack(ctx, "fleet", 1000)
	if err != nil || !ok {
		t.Fatalf("ResumeRolloutTrack: ok=%v err=%v", ok, err)
	}
	got, _, _ := store.GetRolloutTrack(ctx, "fleet")
	if got.FastAfterCanary {
		t.Fatal("继续 silently re-armed the canary-then-fast mode")
	}
	if got.FirstNodeID != "" || got.CurrentNodeID != "" {
		t.Fatalf("继续 kept the halted rollout's positional state: %+v", got)
	}
}

// A finished track is not "安全快速发布中". Leaving the column set would park a
// badge next to 已完成 forever, the display bug both other flags already had.
func TestCompleteRolloutTrackDisarmsFastAfterCanary(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling", FastAfterCanary: true,
	}); err != nil {
		t.Fatal(err)
	}
	ok, err := store.CompleteRolloutTrack(ctx, "fleet", 1000)
	if err != nil || !ok {
		t.Fatalf("CompleteRolloutTrack: ok=%v err=%v", ok, err)
	}
	if got, _, _ := store.GetRolloutTrack(ctx, "fleet"); got.FastAfterCanary {
		t.Fatal("a completed track still reports the canary-then-fast mode")
	}
}

// A halted one KEEPS it, exactly as manual fast does: the operator opening the
// panel after a halt, and the incident review reading the row later, both have
// to be able to see which kind of rollout stopped.
func TestHaltRolloutTrackKeepsFastAfterCanary(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling", FastAfterCanary: true,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.HaltRolloutTrack(ctx, "fleet", "node n1 failed", 1000); err != nil {
		t.Fatal(err)
	}
	if got, _, _ := store.GetRolloutTrack(ctx, "fleet"); !got.FastAfterCanary {
		t.Fatal("a halted canary-then-fast track forgot which mode it was in")
	}
}

// SetTargetVersion is the ordinary staged control. Typing a version into it must
// never inherit a mode somebody armed earlier.
func TestSetTargetVersionDisarmsFastAfterCanary(t *testing.T) {
	svc, store := newRolloutService(t)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling", FastAfterCanary: true,
	}); err != nil {
		t.Fatal(err)
	}
	if err := svc.SetTargetVersion(ctx, "fleet", "v1.0.0"); err != nil {
		t.Fatalf("SetTargetVersion: %v", err)
	}
	if got, _, _ := store.GetRolloutTrack(ctx, "fleet"); got.FastAfterCanary {
		t.Fatal("the ordinary target box inherited the canary-then-fast mode")
	}
}

// An emergency release is the opposite trade (whole track at once, no failure
// gating), so arming one must clear this mode rather than run both claims at
// once on the same row.
func TestSetEmergencyTargetVersionDisarmsFastAfterCanary(t *testing.T) {
	svc, store := newRolloutService(t)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling", FastAfterCanary: true,
	}); err != nil {
		t.Fatal(err)
	}
	if err := svc.SetEmergencyTargetVersion(ctx, "fleet", "v1.0.0"); err != nil {
		t.Fatalf("SetEmergencyTargetVersion: %v", err)
	}
	got, _, _ := store.GetRolloutTrack(ctx, "fleet")
	if got.FastAfterCanary || !got.Emergency {
		t.Fatalf("modes = fastAfterCanary:%v emergency:%v, want false/true", got.FastAfterCanary, got.Emergency)
	}
}

// SQLiteStore.SetRolloutEmergency is off the admin path and retained only for a
// live deployment that might still call it mid-rollout — which is exactly why it
// is worth testing adversarially. It is the one arming path that does NOT
// rewrite the row wholesale, so it is the only place a row could come out
// carrying emergency AND a fast mode. That row is not a display glitch: the
// panel would show a badge promising a gated one-at-a-time queue while the
// update check released the build to the whole fleet at once, and decideFleet
// would be answering a precedence question instead of running a mode.
//
// The whole row is compared rather than the three flags, because "clears the
// modes" must not have been bought by clobbering the node in flight.
func TestSetRolloutEmergencyClearsBothFastModes(t *testing.T) {
	// The adversarial start is the SAFE mode: a track whose entire claim is that
	// the canary still gets its six hours, being handed the one mode that has no
	// canary at all.
	for _, c := range []struct {
		name string
		mode func(*RolloutTrack)
	}{
		{"from canary-then-fast", func(tr *RolloutTrack) { tr.FastAfterCanary = true }},
		{"from manual fast", func(tr *RolloutTrack) { tr.ManualFast = true }},
	} {
		t.Run(c.name, func(t *testing.T) {
			store := newTestStore(t)
			ctx := context.Background()

			row := RolloutTrack{
				Track: "fleet", TargetVersion: "v1.0.0", Status: "rolling",
				StageStartedAt: 1000, CurrentNodeID: "n1", FirstNodeID: "n1",
			}
			c.mode(&row)
			if err := store.PutRolloutTrack(ctx, row); err != nil {
				t.Fatal(err)
			}

			ok, err := store.SetRolloutEmergency(ctx, "fleet", "v1.0.0", 3000)
			if err != nil || !ok {
				t.Fatalf("SetRolloutEmergency: ok=%v err=%v", ok, err)
			}
			want := RolloutTrack{
				Track: "fleet", TargetVersion: "v1.0.0", Status: "rolling",
				StageStartedAt: 3000, CurrentNodeID: "n1", FirstNodeID: "n1",
				Emergency: true,
			}
			if got, _, _ := store.GetRolloutTrack(ctx, "fleet"); got != want {
				t.Fatalf("after arming emergency:\n got %+v\nwant %+v", got, want)
			}
		})
	}
}

// Clearing the fast columns must not have cost the compare-and-swap, and that
// matters in both directions. A refused arm still has to write NOTHING: telling
// the operator 紧急发布失败 while having quietly stripped the mode off a rollout
// that is still running is the same class of split-state bug that took this
// method off the admin path in the first place.
func TestSetRolloutEmergencyRefusalLeavesTheRowUntouched(t *testing.T) {
	for _, c := range []struct {
		name          string
		row           RolloutTrack
		expectVersion string
	}{
		{
			name: "stale target version",
			row: RolloutTrack{
				Track: "fleet", TargetVersion: "v1.0.0", Status: "rolling",
				StageStartedAt: 1000, CurrentNodeID: "n1", FirstNodeID: "n1",
				FastAfterCanary: true,
			},
			expectVersion: "v0.9.0",
		},
		{
			name: "track no longer rolling",
			row: RolloutTrack{
				Track: "fleet", TargetVersion: "v1.0.0", Status: "halted",
				StageStartedAt: 1000, CurrentNodeID: "n1", FirstNodeID: "n1",
				HaltedReason: "node n1 rolled back", ManualFast: true,
			},
			expectVersion: "v1.0.0",
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			store := newTestStore(t)
			ctx := context.Background()
			if err := store.PutRolloutTrack(ctx, c.row); err != nil {
				t.Fatal(err)
			}
			ok, err := store.SetRolloutEmergency(ctx, "fleet", c.expectVersion, 3000)
			if err != nil || ok {
				t.Fatalf("SetRolloutEmergency: ok=%v err=%v, want false/nil", ok, err)
			}
			if got, _, _ := store.GetRolloutTrack(ctx, "fleet"); got != c.row {
				t.Fatalf("a refused arm wrote to the row:\n got %+v\nwant %+v", got, c.row)
			}
		})
	}
}
