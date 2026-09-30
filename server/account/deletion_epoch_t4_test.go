package account

import (
	"testing"

	"github.com/relayium/relayium/authx"
)

// A-L5: a password login reads credential_epoch before checking the password
// and inserts its session only at that epoch. If the account deletion commits
// in between, the session (and a CLI bearer minted the same way) must not
// appear on the just-deleted account.
func TestAccountDeletionFencesInFlightCredentialChecks(t *testing.T) {
	ctx := t.Context()
	st := newTestStore(t)
	u, err := st.UpsertUserByEmail(ctx, "gone@example.com", "Gone")
	if err != nil {
		t.Fatal(err)
	}
	// The in-flight login's read, before the deletion.
	epoch, err := st.CredentialEpochByEmail(ctx, u.Email)
	if err != nil {
		t.Fatal(err)
	}

	const now = int64(50_000)
	tokenHash := authx.HashToken("delete-token")
	if err := st.CreateEmailToken(ctx, EmailToken{TokenHash: tokenHash, UserID: u.ID, Email: u.Email,
		Purpose: "delete", CreatedAt: now, ExpiresAt: now + 3600}); err != nil {
		t.Fatal(err)
	}
	react := EmailToken{TokenHash: authx.HashToken("react"), UserID: u.ID, Purpose: "reactivate", CreatedAt: now, ExpiresAt: now + 86400}
	if _, committed, err := st.CommitAccountDeletion(ctx, tokenHash, u, now, now+86400, react); err != nil || !committed {
		t.Fatalf("commit deletion: committed=%v err=%v", committed, err)
	}

	ok, err := st.CreateSessionAtEpoch(ctx, Session{ID: authx.RandToken(), UserID: u.ID, CreatedAt: now, ExpiresAt: now + 3600}, epoch)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("a session read at the pre-deletion epoch was inserted after the deletion committed")
	}
	ok, err = st.CreateCLITokenAtEpoch(ctx, CLIToken{TokenHash: authx.HashToken("bearer"), UserID: u.ID, DeviceID: "d", CreatedAt: now, LastSeenAt: now}, epoch)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("a CLI bearer read at the pre-deletion epoch was inserted after the deletion committed")
	}

	// Reactivation reads the epoch after the deletion, so it still issues.
	fresh, err := st.CredentialEpoch(ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := st.CreateSessionAtEpoch(ctx, Session{ID: authx.RandToken(), UserID: u.ID, CreatedAt: now, ExpiresAt: now + 3600}, fresh); err != nil || !ok {
		t.Fatalf("post-deletion epoch session: ok=%v err=%v", ok, err)
	}
}
