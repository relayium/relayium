package account

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/authx"
)

// N-0930-5: a reactivate token is honoured only for the pending-deletion
// generation it was issued in, and redemption is one transaction.

const n5Now = int64(1_800_000_000)

func n5Service(t *testing.T) (*Service, *SQLiteStore) {
	t.Helper()
	store := newTestStore(t)
	svc := NewService(store, &capturingMailer{}, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour, AccountGraceDays: 30,
	})
	svc.now = func() time.Time { return time.Unix(n5Now, 0) }
	return svc, store
}

func n5Account(t *testing.T, store *SQLiteStore, email string) User {
	t.Helper()
	u, err := store.UpsertUserByEmail(context.Background(), email, "")
	if err != nil {
		t.Fatal(err)
	}
	return u
}

// n5Delete runs the real deletion transaction at time at (epoch bump, session
// purge, deleted_at, confirmation-flow reactivate token) and returns the raw
// reactivate token it minted. label keeps token hashes distinct across
// repeated deletions of one account.
func n5Delete(t *testing.T, store *SQLiteStore, userID, label string, at int64) string {
	t.Helper()
	ctx := context.Background()
	u, err := store.GetUserByID(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	delHash := authx.HashToken("n5-delete-" + label + userID)
	if err := store.CreateEmailToken(ctx, EmailToken{TokenHash: delHash, UserID: u.ID, Email: u.Email,
		Purpose: "delete", CreatedAt: at, ExpiresAt: at + 3600}); err != nil {
		t.Fatal(err)
	}
	raw := "n5-react-" + label + userID
	react := EmailToken{TokenHash: authx.HashToken(raw), UserID: u.ID, Purpose: "reactivate", CreatedAt: at, ExpiresAt: at + 30*86400}
	if _, committed, err := store.CommitAccountDeletion(ctx, delHash, u, at, at+30*86400, react); err != nil || !committed {
		t.Fatalf("commit deletion: committed=%v err=%v", committed, err)
	}
	return raw
}

func n5Epoch(t *testing.T, store *SQLiteStore, userID string) int64 {
	t.Helper()
	e, err := store.CredentialEpoch(context.Background(), userID)
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func n5AssertRefusedStillPending(t *testing.T, svc *Service, store *SQLiteStore, userID, raw string) {
	t.Helper()
	rec := postReactivate(svc, raw)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"invalid_or_expired_token"`) {
		t.Fatalf("want 400 invalid_or_expired_token, got %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Header().Get("Set-Cookie"), sessionCookie+"=") {
		t.Fatalf("a refused reactivation set a session cookie: %q", rec.Header().Get("Set-Cookie"))
	}
	if u, _ := store.GetUserByID(context.Background(), userID); u.DeletedAt == 0 {
		t.Fatal("a refused reactivation must leave the account pending deletion")
	}
	if n := liveSessions(t, store, userID); n != 0 {
		t.Fatalf("a refused reactivation must leave no session, found %d", n)
	}
}

// A token that slipped in after a recovery (a login that read the pending
// state, paused while the owner recovered, then minted its token at the
// recovered epoch) cannot undo the NEXT deletion.
func TestReactivateN0930StaleIssuanceCannotUndoNextDeletion(t *testing.T) {
	ctx := context.Background()
	svc, store := n5Service(t)
	u := n5Account(t, store, "stale@example.com")
	n5Delete(t, store, u.ID, "g1", n5Now-1000)
	if err := store.ClearAccountDeletion(ctx, u.ID); err != nil { // the owner recovers
		t.Fatal(err)
	}
	stale, err := svc.issueReactivateToken(ctx, u.ID, u.Email) // the paused login resumes
	if err != nil {
		t.Fatal(err)
	}
	n5Delete(t, store, u.ID, "g2", n5Now-500) // the owner deletes again
	n5AssertRefusedStillPending(t, svc, store, u.ID, stale)
	if _, ok, _ := store.PeekEmailToken(ctx, authx.HashToken(stale), "reactivate", n5Now); ok {
		t.Fatal("the cross-generation token must be spent by the refused attempt")
	}
}

// A redemption paused just before its (atomic) store call, overtaken by a
// recovery and a second deletion, cannot recover the second deletion or come
// out with a session.
func TestReactivateN0930PausedRedemptionOvertakenByRecoveryAndRedeletion(t *testing.T) {
	ctx := context.Background()
	svc, store := n5Service(t)
	u := n5Account(t, store, "paused@example.com")
	n5Delete(t, store, u.ID, "g1", n5Now-1000)
	attacker, err := svc.issueReactivateToken(ctx, u.ID, u.Email)
	if err != nil {
		t.Fatal(err)
	}
	owner, err := svc.issueReactivateToken(ctx, u.ID, u.Email)
	if err != nil {
		t.Fatal(err)
	}
	hook := &recoverAndResetFirst{SQLiteStore: store, owner: func() {
		if rec := postReactivate(svc, owner); rec.Code != http.StatusOK {
			t.Errorf("owner recovery: %d %s", rec.Code, rec.Body.String())
		}
		n5Delete(t, store, u.ID, "g2", n5Now-500)
	}}
	svc.store = hook
	rec := postReactivate(svc, attacker)
	if !hook.fired {
		t.Fatalf("the attacker's reactivation never reached the interleaving point: %d %s", rec.Code, rec.Body.String())
	}
	svc.store = store
	n5AssertRefusedStillPending(t, svc, store, u.ID, attacker)
}

// A token of an earlier generation that survived to the next one — its row
// carries that generation's epoch — is refused, while the current
// generation's token recovers the account.
func TestReactivateN0930CrossGenerationTokenRefused(t *testing.T) {
	ctx := context.Background()
	svc, store := n5Service(t)
	u := n5Account(t, store, "cross@example.com")
	n5Delete(t, store, u.ID, "g1", n5Now-1000)
	gen1 := n5Epoch(t, store, u.ID)
	if err := store.ClearAccountDeletion(ctx, u.ID); err != nil {
		t.Fatal(err)
	}
	old := "n5-old-" + u.ID
	if err := store.CreateEmailToken(ctx, EmailToken{TokenHash: authx.HashToken(old), UserID: u.ID, Email: u.Email,
		Purpose: "reactivate", CredentialEpoch: gen1, CreatedAt: n5Now - 400, ExpiresAt: n5Now + 86400}); err != nil {
		t.Fatal(err)
	}
	current := n5Delete(t, store, u.ID, "g2", n5Now-500)
	if gen2 := n5Epoch(t, store, u.ID); gen2 == gen1 {
		t.Fatalf("a deletion must advance the epoch (still %d)", gen2)
	}
	n5AssertRefusedStillPending(t, svc, store, u.ID, old)

	rec := postReactivate(svc, current)
	if rec.Code != http.StatusOK {
		t.Fatalf("the current generation's token must recover: %d %s", rec.Code, rec.Body.String())
	}
	if got := sessionUser(t, store, rec); got != u.ID {
		t.Fatalf("recovery must sign in %s, got %q", u.ID, got)
	}
	if acc, _ := store.GetUserByID(ctx, u.ID); acc.DeletedAt != 0 {
		t.Fatal("the account must be recovered")
	}
}

// Legacy epoch-0 rows: honoured only when created inside the current pending
// generation (created_at >= deleted_at), never across it.
func TestReactivateN0930LegacyEpochZeroRule(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		name      string
		createdAt int64
		want      bool
	}{
		{"created before the current deletion", n5Now - 600, false},
		{"created at the current deletion", n5Now - 500, true},
		{"created after the current deletion", n5Now - 100, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, store := n5Service(t)
			u := n5Account(t, store, "legacy@example.com")
			n5Delete(t, store, u.ID, "g1", n5Now-500)
			if n5Epoch(t, store, u.ID) == 0 {
				t.Fatal("fixture must be at a non-zero epoch")
			}
			raw := "n5-legacy-" + u.ID
			if err := store.CreateEmailToken(ctx, EmailToken{TokenHash: authx.HashToken(raw), UserID: u.ID, Email: u.Email,
				Purpose: "reactivate", CredentialEpoch: 0, CreatedAt: tc.createdAt, ExpiresAt: n5Now + 86400}); err != nil {
				t.Fatal(err)
			}
			if !tc.want {
				n5AssertRefusedStillPending(t, svc, store, u.ID, raw)
				return
			}
			rec := postReactivate(svc, raw)
			if rec.Code != http.StatusOK || sessionUser(t, store, rec) != u.ID {
				t.Fatalf("legacy token of the current generation must recover: %d %s", rec.Code, rec.Body.String())
			}
		})
	}
}

// A legacy epoch-0 token never revives an account that is not pending.
func TestReactivateN0930LegacyEpochZeroRefusedWhenActive(t *testing.T) {
	ctx := context.Background()
	svc, store := n5Service(t)
	u := n5Account(t, store, "active0@example.com")
	raw := "n5-active0-" + u.ID
	if err := store.CreateEmailToken(ctx, EmailToken{TokenHash: authx.HashToken(raw), UserID: u.ID, Email: u.Email,
		Purpose: "reactivate", CreatedAt: n5Now, ExpiresAt: n5Now + 86400}); err != nil {
		t.Fatal(err)
	}
	rec := postReactivate(svc, raw)
	if rec.Code != http.StatusBadRequest || liveSessions(t, store, u.ID) != 0 {
		t.Fatalf("token for an active account must mint nothing: %d %s", rec.Code, rec.Body.String())
	}
}

// Every issuer records the epoch: the deletion transaction's token carries the
// post-bump epoch (the generation it starts) and redeems; the shared issuer
// records the current epoch.
func TestReactivateN0930IssuersRecordEpoch(t *testing.T) {
	ctx := context.Background()
	svc, store := n5Service(t)
	u := n5Account(t, store, "issuers@example.com")
	if _, err := store.db.Exec(`UPDATE users SET credential_epoch = 4 WHERE id = ?`, u.ID); err != nil {
		t.Fatal(err)
	}
	raw := n5Delete(t, store, u.ID, "g1", n5Now-100)
	tok, ok, err := store.PeekEmailToken(ctx, authx.HashToken(raw), "reactivate", n5Now)
	if err != nil || !ok || tok.CredentialEpoch != 5 {
		t.Fatalf("the deletion's token must record the post-bump epoch 5: ok=%v err=%v tok=%+v", ok, err, tok)
	}
	issued, err := svc.issueReactivateToken(ctx, u.ID, u.Email)
	if err != nil {
		t.Fatal(err)
	}
	tok, ok, err = store.PeekEmailToken(ctx, authx.HashToken(issued), "reactivate", n5Now)
	if err != nil || !ok || tok.CredentialEpoch != 5 {
		t.Fatalf("issueReactivateToken must record the current epoch 5: ok=%v err=%v tok=%+v", ok, err, tok)
	}
	rec := postReactivate(svc, raw)
	if rec.Code != http.StatusOK || sessionUser(t, store, rec) != u.ID {
		t.Fatalf("the deletion's own token must recover: %d %s", rec.Code, rec.Body.String())
	}
	if _, ok, _ := store.PeekEmailToken(ctx, authx.HashToken(issued), "reactivate", n5Now); ok {
		t.Fatal("recovery must revoke the other unused reactivate tokens")
	}
}
