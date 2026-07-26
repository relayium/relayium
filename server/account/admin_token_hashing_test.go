package account

import (
	"context"
	"testing"

	"github.com/relayium/relayium/authx"
)

// Admin bearer tokens must be stored as SHA-256 hashes, never raw: a read of the
// DB file or a backup must not yield a copy-pasteable live admin credential.
// These tests pin that the on-disk column is the hash while lookups by the raw
// token still work (store hashes on both sides).

func TestAdminSessionTokenStoredHashed(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	const raw = "raw-admin-session-token"
	if err := store.CreateAdminSession(ctx, raw, "password", "", 1<<40); err != nil {
		t.Fatal(err)
	}

	var stored string
	if err := store.db.QueryRowContext(ctx,
		`SELECT token FROM admin_sessions LIMIT 1`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored == raw {
		t.Fatal("admin session token stored raw — DB/backup read yields a live admin cookie")
	}
	if stored != authx.HashToken(raw) {
		t.Fatalf("stored token = %q, want authx.HashToken(raw) = %q", stored, authx.HashToken(raw))
	}

	// Lookup by the raw token must still resolve the session.
	auth, _, ok, err := store.AdminSession(ctx, raw, "", 0)
	if err != nil || !ok || auth != "password" {
		t.Fatalf("AdminSession(raw) = %q/%v/%v, want password/true/nil", auth, ok, err)
	}
	// Deleting by the raw token must remove the (hashed) row.
	if err := store.DeleteAdminSession(ctx, raw); err != nil {
		t.Fatal(err)
	}
	if _, _, ok, _ := store.AdminSession(ctx, raw, "", 0); ok {
		t.Fatal("session survived DeleteAdminSession(raw)")
	}
}

func TestPendingActionTokensStoredHashed(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	const tok, sess = "raw-pending-tok", "raw-session-tok"
	ok, err := store.PutPendingAction(ctx, tok, sess, "user.plan", "plan=max", "u123", 0, 1<<40, 16)
	if err != nil || !ok {
		t.Fatalf("PutPendingAction = %v/%v", ok, err)
	}

	var storedTok, storedSess string
	if err := store.db.QueryRowContext(ctx,
		`SELECT token, session_tok FROM admin_pending_actions LIMIT 1`).Scan(&storedTok, &storedSess); err != nil {
		t.Fatal(err)
	}
	if storedTok == tok || storedSess == sess {
		t.Fatal("pending action token/session_tok stored raw")
	}
	if storedTok != authx.HashToken(tok) || storedSess != authx.HashToken(sess) {
		t.Fatal("pending action columns are not the token hashes")
	}

	// Claim by the raw token; the returned session_tok is the stored hash, which
	// the service compares against authx.HashToken(current cookie).
	gotSess, action, form, pathID, _, ok, err := store.TakePendingAction(ctx, tok)
	if err != nil || !ok {
		t.Fatalf("TakePendingAction = %v/%v", ok, err)
	}
	if gotSess != authx.HashToken(sess) || action != "user.plan" || form != "plan=max" || pathID != "u123" {
		t.Fatalf("claimed fields wrong: sess=%q action=%q form=%q path=%q", gotSess, action, form, pathID)
	}
}

func TestPasskeyCeremonyTokenStoredHashed(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	const tok = "raw-ceremony-tok"
	ok, err := store.PutPasskeyCeremony(ctx, tok, "login", "{}", "", 0, 1<<40, 16)
	if err != nil || !ok {
		t.Fatalf("PutPasskeyCeremony = %v/%v", ok, err)
	}

	var stored string
	if err := store.db.QueryRowContext(ctx,
		`SELECT token FROM admin_passkey_ceremonies LIMIT 1`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored == tok {
		t.Fatal("passkey ceremony token stored raw")
	}
	if stored != authx.HashToken(tok) {
		t.Fatalf("stored = %q, want authx.HashToken(raw) = %q", stored, authx.HashToken(tok))
	}

	kind, _, _, _, ok, err := store.TakePasskeyCeremony(ctx, tok)
	if err != nil || !ok || kind != "login" {
		t.Fatalf("TakePasskeyCeremony(raw) = %q/%v/%v", kind, ok, err)
	}
}
