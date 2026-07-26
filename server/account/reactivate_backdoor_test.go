package account

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

// A reactivate token must undo a pending deletion — not serve as a passwordless
// login afterwards. Each frozen-login attempt mints its own token; once the
// account is recovered, any leftover token must be dead (rejected, no session),
// or it is a multi-day backdoor that survives recovery and a password change.
func TestReactivateTokenIsDeadAfterRecovery(t *testing.T) {
	ts, svc, store, _ := newFileServer(t)
	ctx := context.Background()
	u := mustPasswordUser(t, svc, store, "b@example.com", "correct-horse")
	if err := store.SetAccountDeletion(ctx, u.ID, 100, 100+30*86400); err != nil {
		t.Fatalf("set deletion: %v", err)
	}

	// Two frozen logins → two independently-valid reactivate tokens.
	tok1, _ := loginPassword(t, ts.URL, "b@example.com", "correct-horse").json["reactivateToken"].(string)
	tok2, _ := loginPassword(t, ts.URL, "b@example.com", "correct-horse").json["reactivateToken"].(string)
	if tok1 == "" || tok2 == "" || tok1 == tok2 {
		t.Fatalf("want two distinct reactivate tokens, got %q / %q", tok1, tok2)
	}

	// Recover with the first token.
	if r := httptestPostJSON(t, ts.URL+"/api/account/reactivate", map[string]string{"token": tok1}); r.StatusCode != 200 {
		t.Fatalf("reactivate with tok1: %d", r.StatusCode)
	}
	if u2, _ := store.GetUserByID(ctx, u.ID); u2.DeletedAt != 0 {
		t.Fatal("reactivation should have cleared the pending deletion")
	}

	// The still-unused second token must NOT log in now that the account is active.
	r := httptestPostJSON(t, ts.URL+"/api/account/reactivate", map[string]string{"token": tok2})
	if r.StatusCode != http.StatusBadRequest {
		t.Fatalf("leftover reactivate token after recovery: status = %d, want 400", r.StatusCode)
	}
	if sc := r.Header.Get("Set-Cookie"); strings.Contains(sc, "session") {
		t.Fatalf("rejected reactivate must not mint a session cookie, got %q", sc)
	}
}

// Even without a prior successful reactivation, a valid token presented against
// an account that is not pending deletion must be refused (the DeletedAt>0
// guard), so a leaked token can't be used as a general login.
func TestReactivateRefusedWhenNotPending(t *testing.T) {
	ts, svc, store, _ := newFileServer(t)
	ctx := context.Background()
	u := mustPasswordUser(t, svc, store, "c@example.com", "correct-horse")

	// Mint a reactivate token directly, then leave the account active (never set
	// deletion, or clear it) — the token exists but the account isn't pending.
	raw, err := svc.issueReactivateToken(ctx, u.ID, u.Email)
	if err != nil {
		t.Fatal(err)
	}
	r := httptestPostJSON(t, ts.URL+"/api/account/reactivate", map[string]string{"token": raw})
	if r.StatusCode != http.StatusBadRequest {
		t.Fatalf("reactivate against active account: status = %d, want 400", r.StatusCode)
	}
	if sc := r.Header.Get("Set-Cookie"); strings.Contains(sc, "session") {
		t.Fatalf("must not mint a session, got cookie %q", sc)
	}
}
