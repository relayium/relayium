package account

import (
	"context"
	"testing"
)

// PurgeTransientUserData is the deletion-confirmation-time purge (Task 3
// calls it): it wipes a user's transient/live data immediately while keeping
// the account shell (users row + identities + usage rows) intact until the
// 30-day hard-purge (Task 5). It returns the deleted stored_files so the
// caller can enqueue blob deletes.
//
// This test covers ALL eight deletes (sessions, cli_tokens, cli_device_auth,
// devices, magic_tokens, stored_files, node_tokens, user nodes) AND asserts
// the account shell survives (users row + identities + email_tokens + a
// usage_monthly row), so a regression in any single statement — e.g. a typo
// in the magic_tokens email subquery, a wrong owner_type on the nodes delete,
// or accidental over-deletion of shell rows — is caught.
func TestPurgeTransientUserData(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "a@example.com", "")

	// --- transient/live rows that MUST be purged ---
	sessID := newID()
	if err := st.CreateSession(ctx, Session{ID: sessID, UserID: u.ID, CreatedAt: 1, ExpiresAt: 1 << 40}); err != nil {
		t.Fatalf("create session: %v", err)
	}
	dev, _ := st.UpsertDevice(ctx, Device{ID: newID(), UserID: u.ID, Name: "cli", Kind: "cli", CreatedAt: 1})
	if err := st.CreateCLIToken(ctx, CLIToken{TokenHash: hashToken("t"), UserID: u.ID, DeviceID: dev.ID, CreatedAt: 1}); err != nil {
		t.Fatalf("create cli token: %v", err)
	}
	if err := st.CreateStoredFile(ctx, StoredFile{ID: newID(), UserID: u.ID, BlobKey: "bk", EncManifest: []byte("x"), Size: 1, ExpiresAt: 1 << 40, CreatedAt: 1}); err != nil {
		t.Fatalf("create stored file: %v", err)
	}
	// magic_tokens has no user_id column — it's keyed by the login email, and
	// PurgeTransientUserData matches on the user's stored email. Insert one for
	// this user's email so the email-subquery path is exercised.
	if err := st.CreateMagicToken(ctx, MagicToken{TokenHash: hashToken("magic"), Email: u.Email, CreatedAt: 1, ExpiresAt: 1 << 40}); err != nil {
		t.Fatalf("create magic token: %v", err)
	}
	// cli_device_auth row bound to the user (approved-state: user_id set).
	if err := st.CreateDeviceAuth(ctx, DeviceAuthRequest{UserCode: "WDJB-MJHT", DeviceCodeHash: hashToken("dev"), Status: "pending", CreatedAt: 1, ExpiresAt: 1 << 40}); err != nil {
		t.Fatalf("create device auth: %v", err)
	}
	if ok, err := st.ApproveDeviceAuth(ctx, "WDJB-MJHT", u.ID, hashToken("clitok"), "rlm_cli_raw", 2); err != nil || !ok {
		t.Fatalf("approve device auth: ok=%v err=%v", ok, err)
	}
	// A user-owned node + a node_token bound to the user.
	node, err := st.UpsertNode(ctx, Node{ID: newID(), OwnerType: "user", OwnerUserID: u.ID, URLs: []string{"turn:example:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1 << 40})
	if err != nil {
		t.Fatalf("upsert node: %v", err)
	}
	if err := st.CreateNodeToken(ctx, NodeToken{ID: newID(), TokenHash: hashToken("nt"), UserID: u.ID, Name: "byo", CreatedAt: 1}); err != nil {
		t.Fatalf("create node token: %v", err)
	}

	// --- account-shell rows that MUST SURVIVE the purge ---
	if err := st.LinkIdentity(ctx, "email", u.Email, u.ID); err != nil {
		t.Fatalf("link identity: %v", err)
	}
	if err := st.CreateEmailToken(ctx, EmailToken{TokenHash: hashToken("verif"), UserID: u.ID, Email: u.Email, Purpose: "verify", CreatedAt: 1, ExpiresAt: 1 << 40}); err != nil {
		t.Fatalf("create email token: %v", err)
	}
	if err := st.RecordMeter(ctx, u.ID, MeterUpload, 4096, 100); err != nil {
		t.Fatalf("record meter: %v", err)
	}

	// --- purge ---
	blobs, err := st.PurgeTransientUserData(ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(blobs) != 1 || blobs[0].BlobKey != "bk" {
		t.Fatalf("expected 1 blob returned, got %+v", blobs)
	}

	// --- transient rows gone ---
	if _, ok, err := st.GetSession(ctx, sessID); err != nil || ok {
		t.Fatalf("session should be gone: ok=%v err=%v", ok, err)
	}
	if files, _ := st.ListStoredFilesByUser(ctx, u.ID); len(files) != 0 {
		t.Fatalf("stored_files survived: %d", len(files))
	}
	if devs, _ := st.ListDevices(ctx, u.ID); len(devs) != 0 {
		t.Fatalf("devices survived: %d", len(devs))
	}
	if _, _, ok, _ := st.GetCLITokenUser(ctx, hashToken("t")); ok {
		t.Fatal("cli token should be gone")
	}
	if countRows(t, st, `SELECT COUNT(*) FROM magic_tokens WHERE email=?`, u.Email) != 0 {
		t.Fatal("magic_tokens should be gone")
	}
	if countRows(t, st, `SELECT COUNT(*) FROM cli_device_auth WHERE user_id=?`, u.ID) != 0 {
		t.Fatal("cli_device_auth should be gone")
	}
	if _, ok, _ := st.GetNode(ctx, node.ID); ok {
		t.Fatal("user node should be gone")
	}
	if nodes, _ := st.UserNodesAll(ctx, u.ID); len(nodes) != 0 {
		t.Fatalf("user nodes survived: %d", len(nodes))
	}
	if _, ok, _ := st.NodeTokenByHash(ctx, hashToken("nt")); ok {
		t.Fatal("node token should be gone (a leftover would let a deregistered node keep authenticating)")
	}
	if toks, _ := st.ListNodeTokensByUser(ctx, u.ID); len(toks) != 0 {
		t.Fatalf("node tokens survived: %d", len(toks))
	}

	// --- account shell survives ---
	if _, err := st.GetUserByID(ctx, u.ID); err != nil {
		t.Fatalf("user shell should survive: %v", err)
	}
	if _, ok, err := st.GetUserByIdentity(ctx, "email", u.Email); err != nil || !ok {
		t.Fatalf("identity should survive: ok=%v err=%v", ok, err)
	}
	if countRows(t, st, `SELECT COUNT(*) FROM email_tokens WHERE user_id=?`, u.ID) != 1 {
		t.Fatal("email_tokens should survive the transient purge")
	}
	if up, _, err := st.MonthlyUsage(ctx, u.ID, periodOf(100)); err != nil || up != 4096 {
		t.Fatalf("usage_monthly should survive: up=%d err=%v", up, err)
	}
}

// countRows runs a COUNT(*) query against the store's write DB directly, for
// tables that have no convenient store reader in this test's assertions.
func countRows(t *testing.T, st *SQLiteStore, query string, args ...any) int {
	t.Helper()
	var n int
	if err := st.db.QueryRowContext(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatalf("count query %q: %v", query, err)
	}
	return n
}
