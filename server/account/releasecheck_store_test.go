package account

import (
	"context"
	"testing"
)

// The row is created on demand: a deployment that has never checked reads a
// zero value rather than an error, because "never checked" is a state the
// panel renders, not a failure.
func TestReleaseCheckStartsEmpty(t *testing.T) {
	st := newTestStore(t)
	got, err := st.GetReleaseCheck(context.Background())
	if err != nil {
		t.Fatalf("GetReleaseCheck: %v", err)
	}
	if got.LatestTag != "" || got.CheckedAt != 0 || got.DismissedTag != "" || got.DismissedAt != 0 {
		t.Fatalf("fresh store returned %+v, want the zero value", got)
	}
}

// The two halves are written independently. A dismissal must not disturb the
// stored result, and a check must not disturb the dismissal -- otherwise a
// successful hourly check would silently un-dismiss a notice the operator
// already dealt with.
func TestReleaseCheckHalvesAreIndependent(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	if err := st.SetReleaseCheckResult(ctx, "v1.2.0", 1000); err != nil {
		t.Fatal(err)
	}
	if err := st.SetReleaseCheckDismissed(ctx, "v1.2.0", 1100); err != nil {
		t.Fatal(err)
	}
	got, err := st.GetReleaseCheck(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got.LatestTag != "v1.2.0" || got.CheckedAt != 1000 {
		t.Fatalf("dismissal disturbed the result: %+v", got)
	}
	if got.DismissedTag != "v1.2.0" || got.DismissedAt != 1100 {
		t.Fatalf("dismissal not recorded: %+v", got)
	}

	// A later check records a newer tag and must leave the dismissal alone.
	if err := st.SetReleaseCheckResult(ctx, "v1.3.0", 2000); err != nil {
		t.Fatal(err)
	}
	got, err = st.GetReleaseCheck(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got.LatestTag != "v1.3.0" || got.CheckedAt != 2000 {
		t.Fatalf("result not updated: %+v", got)
	}
	if got.DismissedTag != "v1.2.0" || got.DismissedAt != 1100 {
		t.Fatalf("check disturbed the dismissal: %+v", got)
	}
}

// Clearing the dismissal is how 撤销 works.
func TestReleaseCheckDismissalCanBeCleared(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	if err := st.SetReleaseCheckDismissed(ctx, "v1.2.0", 1100); err != nil {
		t.Fatal(err)
	}
	if err := st.SetReleaseCheckDismissed(ctx, "", 1200); err != nil {
		t.Fatal(err)
	}
	got, err := st.GetReleaseCheck(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got.DismissedTag != "" {
		t.Fatalf("dismissal not cleared: %+v", got)
	}
}
