package selfupdate

import (
	"context"
	"io"
	"os"
	"runtime"
	"testing"
)

// Central hands out an exact version, never "latest". If a node resolved latest
// itself, a release published mid-rollout would leave the fleet on two
// versions — the precise thing a staged rollout exists to prevent.
func TestUpdateInstallsTargetTagNotLatest(t *testing.T) {
	const payload = "BINARY-v0.22.0"
	fr := &fakeRelease{
		tag:       "v0.22.0",
		latestTag: "v9.9.9", // newer release exists; we must NOT take it
		asset:     AssetName(runtime.GOOS, runtime.GOARCH),
		archive:   tarGzWith(t, payload),
	}
	srv := fr.server(t)
	defer srv.Close()
	target := writeTarget(t, "OLD")

	o := baseOpts(srv, target)
	o.CurrentVersion = "v0.21.0"
	o.TargetTag = "v0.22.0"

	from, to, changed, err := Update(context.Background(), o, io.Discard)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if !changed {
		t.Error("changed = false, want true")
	}
	if from != "v0.21.0" {
		t.Errorf("from = %q, want %q", from, "v0.21.0")
	}
	if to != "v0.22.0" {
		t.Errorf("to = %q, want the pinned tag v0.22.0, not latest", to)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != payload {
		t.Errorf("installed binary = %q, want %q", got, payload)
	}
}

// A rollback names a lower version. Without an explicit opt-in that must be
// refused, so nothing can quietly walk a node back to a known-vulnerable build.
func TestUpdateRefusesDowngradeByDefault(t *testing.T) {
	fr := &fakeRelease{
		tag:     "v0.21.0",
		asset:   AssetName(runtime.GOOS, runtime.GOARCH),
		archive: tarGzWith(t, "OLDER-BINARY"),
	}
	srv := fr.server(t)
	defer srv.Close()
	target := writeTarget(t, "CURRENT")

	o := baseOpts(srv, target)
	o.CurrentVersion = "v0.22.0"
	o.TargetTag = "v0.21.0"

	_, _, changed, err := Update(context.Background(), o, io.Discard)
	if err == nil {
		t.Error("Update err = nil for a downgrade, want a refusal")
	}
	if changed {
		t.Error("changed = true, want false")
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "CURRENT" {
		t.Errorf("binary = %q after a refused downgrade, want it untouched", got)
	}
}

func TestUpdateAllowsDowngradeWhenOptedIn(t *testing.T) {
	const payload = "OLDER-BINARY"
	fr := &fakeRelease{
		tag:     "v0.21.0",
		asset:   AssetName(runtime.GOOS, runtime.GOARCH),
		archive: tarGzWith(t, payload),
	}
	srv := fr.server(t)
	defer srv.Close()
	target := writeTarget(t, "CURRENT")

	o := baseOpts(srv, target)
	o.CurrentVersion = "v0.22.0"
	o.TargetTag = "v0.21.0"
	o.AllowDowngrade = true

	_, to, changed, err := Update(context.Background(), o, io.Discard)
	if err != nil {
		t.Fatalf("Update with AllowDowngrade: %v", err)
	}
	if !changed || to != "v0.21.0" {
		t.Errorf("changed=%v to=%q, want true and v0.21.0", changed, to)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != payload {
		t.Errorf("installed binary = %q, want the rollback payload %q", got, payload)
	}
}
