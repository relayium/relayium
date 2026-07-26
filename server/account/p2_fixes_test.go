package account

import (
	"context"
	"path/filepath"
	"sync"
	"testing"
)

// A hard purge must delete the user's usage_periods rows too — they carry a
// user_id and would otherwise retain per-user relay attribution forever after
// the account is anonymized/purged.
func TestArchivePurgeDeletesUsagePeriods(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "purge-periods@example.com", "P")

	// RecordUsage populates both usage_events and usage_periods for the user.
	if err := st.RecordUsage(ctx, UsageEvent{
		AllocID: "a1", Token: "t", UserID: u.ID, RelayedBytes: 500, RecordedAt: 1_800_000_000, Billable: true,
	}); err != nil {
		t.Fatalf("record usage: %v", err)
	}
	var before int
	st.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM usage_periods WHERE user_id=?`, u.ID).Scan(&before)
	if before == 0 {
		t.Fatal("setup: expected a usage_periods row for the user")
	}

	// Schedule + hard-purge.
	if err := st.SetAccountDeletion(ctx, u.ID, 1, 1); err != nil {
		t.Fatal(err)
	}
	if err := st.ArchiveAndPurgeUser(ctx, u.ID, 100); err != nil {
		t.Fatalf("purge: %v", err)
	}
	var after int
	if err := st.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM usage_periods WHERE user_id=?`, u.ID).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != 0 {
		t.Fatalf("PRIVACY: %d usage_periods rows survived the hard purge (user_id retained)", after)
	}
}

// The canonical_email backfill must run on every boot (not only when the ALTER
// just succeeded), so a row left with canonical_email='' by a crash between the
// ALTER and the backfill is healed on the next start.
func TestCanonicalBackfillHealsEmptyRowsOnReopen(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "canon.db")

	st, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	u, _ := st.UpsertUserByEmail(ctx, "gap+tag@gmail.com", "G")
	// Simulate the crash-window leftover: column exists but this row never got
	// its canonical form.
	if _, err := st.db.ExecContext(ctx, `UPDATE users SET canonical_email='' WHERE id=?`, u.ID); err != nil {
		t.Fatal(err)
	}
	st.Close()

	// Reopen: the unconditional backfill must populate the empty row.
	st2, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer st2.Close()
	var got string
	if err := st2.db.QueryRowContext(ctx, `SELECT canonical_email FROM users WHERE id=?`, u.ID).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if want := canonicalEmail("gap+tag@gmail.com"); got != want {
		t.Fatalf("backfill on reopen: want %q, got %q", want, got)
	}
}

// UnlinkIdentityIfSafe refuses to remove the last login method and never leaves
// an account with zero, even under concurrent unlinks of different providers.
func TestUnlinkIdentityIfSafe(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	// Passwordless account with two linked providers.
	u, _ := st.UpsertUserByEmail(ctx, "unlink@example.com", "U")
	for _, p := range []string{"google", "apple"} {
		if err := st.LinkIdentity(ctx, p, "sub-"+p, u.ID); err != nil {
			t.Fatal(err)
		}
	}

	// Removing one of two is safe.
	deleted, orphan, err := st.UnlinkIdentityIfSafe(ctx, "google", u.ID)
	if err != nil || !deleted || orphan {
		t.Fatalf("first unlink: deleted=%v orphan=%v err=%v", deleted, orphan, err)
	}
	// Removing the last one is refused.
	deleted, orphan, err = st.UnlinkIdentityIfSafe(ctx, "apple", u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if deleted || !orphan {
		t.Fatalf("last unlink: want wouldOrphan, got deleted=%v orphan=%v", deleted, orphan)
	}
	if got, _ := st.ListIdentityProviders(ctx, u.ID); len(got) != 1 {
		t.Fatalf("account must keep its last login method, got providers=%v", got)
	}
}

// Concurrent unlinks of the two different providers on a passwordless account
// must not both succeed (which would zero out the login methods).
func TestUnlinkIdentityIfSafeConcurrent(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "unlink-race@example.com", "U")
	for _, p := range []string{"google", "apple"} {
		_ = st.LinkIdentity(ctx, p, "sub-"+p, u.ID)
	}

	var wg sync.WaitGroup
	var mu sync.Mutex
	deletedCount := 0
	for _, p := range []string{"google", "apple"} {
		wg.Add(1)
		go func(prov string) {
			defer wg.Done()
			if d, _, err := st.UnlinkIdentityIfSafe(ctx, prov, u.ID); err == nil && d {
				mu.Lock()
				deletedCount++
				mu.Unlock()
			}
		}(p)
	}
	wg.Wait()

	if deletedCount != 1 {
		t.Fatalf("exactly one concurrent unlink may succeed, got %d", deletedCount)
	}
	if got, _ := st.ListIdentityProviders(ctx, u.ID); len(got) != 1 {
		t.Fatalf("LOCKOUT: account left with %d login methods after concurrent unlinks", len(got))
	}
}
