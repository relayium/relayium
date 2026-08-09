package account

import (
	"context"
	"testing"

	"github.com/relayium/relayium/authx"
)

func TestDeviceAuthApproveConsumeOnce(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	req := DeviceAuthRequest{UserCode: "WDJB-MJHT", DeviceCodeHash: authx.HashToken("dev"), Status: "pending", CreatedAt: 1, ExpiresAt: 1 << 40}
	if err := st.CreateDeviceAuth(ctx, req); err != nil {
		t.Fatal(err)
	}
	_, ok, err := st.ApproveDeviceAuth(ctx, "WDJB-MJHT", "u1", authx.HashToken("tok"), "rlm_cli_raw", 2)
	if err != nil || !ok {
		t.Fatalf("approve: %v %v", ok, err)
	}
	// second approve on same code must fail (already approved)
	_, ok2, _ := st.ApproveDeviceAuth(ctx, "WDJB-MJHT", "u1", authx.HashToken("tok"), "rlm_cli_raw", 3)
	if ok2 {
		t.Fatal("double approve should fail")
	}
	tok1, c1, _ := st.ConsumeDeviceAuth(ctx, authx.HashToken("dev"), 4)
	_, c2, _ := st.ConsumeDeviceAuth(ctx, authx.HashToken("dev"), 5)
	if !c1 || c2 || tok1 != "rlm_cli_raw" {
		t.Fatalf("consume should succeed once with token: tok=%q c1=%v c2=%v", tok1, c1, c2)
	}
}

func TestCLITokenLookup(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	// cli_tokens has FK constraints on user_id -> users(id) and device_id ->
	// devices(id) (foreign_keys pragma is on), so create real rows first.
	u, err := st.UpsertUserByEmail(ctx, "clitok@example.com", "CLI User")
	if err != nil {
		t.Fatalf("upsert user: %v", err)
	}
	d, err := st.UpsertDevice(ctx, Device{ID: "d1", UserID: u.ID, Name: "laptop", CreatedAt: 1, Kind: "cli"})
	if err != nil {
		t.Fatalf("upsert device: %v", err)
	}
	if err := st.CreateCLIToken(ctx, CLIToken{TokenHash: authx.HashToken("t"), UserID: u.ID, DeviceID: d.ID, CreatedAt: 1}); err != nil {
		t.Fatalf("create cli token: %v", err)
	}
	uid, did, ok, err := st.GetCLITokenUser(ctx, authx.HashToken("t"))
	if err != nil || !ok || uid != u.ID || did != d.ID {
		t.Fatalf("lookup: %v %v %q %q", ok, err, uid, did)
	}
	_, _, ok2, _ := st.GetCLITokenUser(ctx, authx.HashToken("nope"))
	if ok2 {
		t.Fatal("unknown token must not resolve")
	}
	if err := st.TouchCLIToken(ctx, authx.HashToken("t"), 99); err != nil {
		t.Fatalf("touch: %v", err)
	}
}

func TestDeleteCLITokenRevokesOnlyPresentedToken(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, err := st.UpsertUserByEmail(ctx, "logout-token@example.com", "Logout User")
	if err != nil {
		t.Fatal(err)
	}
	d, err := st.UpsertDevice(ctx, Device{ID: "logout-device", UserID: u.ID, Name: "CLI", Kind: "cli", CreatedAt: 1})
	if err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{"one", "two"} {
		if err := st.CreateCLIToken(ctx, CLIToken{TokenHash: authx.HashToken(raw), UserID: u.ID, DeviceID: d.ID, CreatedAt: 1}); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.DeleteCLIToken(ctx, authx.HashToken("one")); err != nil {
		t.Fatal(err)
	}
	if _, _, ok, _ := st.GetCLITokenUser(ctx, authx.HashToken("one")); ok {
		t.Fatal("deleted token remains valid")
	}
	if _, _, ok, _ := st.GetCLITokenUser(ctx, authx.HashToken("two")); !ok {
		t.Fatal("logout revoked another device token")
	}
}

// Deleting a CLI device is the token-revocation path: DELETE /api/devices/{id}
// does a bare DELETE FROM devices, which (with FKs on) would fail the
// cli_tokens.device_id constraint unless it cascades. ON DELETE CASCADE makes
// the delete succeed AND drop the token row, so a leaked rlm_cli_ token stops
// authenticating.
func TestDeleteCLIDeviceRevokesToken(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, err := st.UpsertUserByEmail(ctx, "revoke@example.com", "Revoke User")
	if err != nil {
		t.Fatalf("upsert user: %v", err)
	}
	d, err := st.UpsertDevice(ctx, Device{ID: "dev-cli", UserID: u.ID, Name: "cli-laptop", CreatedAt: 1, Kind: "cli"})
	if err != nil {
		t.Fatalf("upsert device: %v", err)
	}
	raw := "rlm_cli_secret"
	if err := st.CreateCLIToken(ctx, CLIToken{TokenHash: authx.HashToken(raw), UserID: u.ID, DeviceID: d.ID, CreatedAt: 1}); err != nil {
		t.Fatalf("create cli token: %v", err)
	}
	// Sanity: token authenticates before deletion.
	if _, _, ok, _ := st.GetCLITokenUser(ctx, authx.HashToken(raw)); !ok {
		t.Fatal("token should resolve before device deletion")
	}
	// The revocation path: deleting the device must not 500 on the FK...
	if err := st.DeleteDevice(ctx, d.ID, u.ID); err != nil {
		t.Fatalf("DeleteDevice failed (FK not cascading?): %v", err)
	}
	// ...and the token must no longer authenticate (cascade-deleted).
	if _, _, ok, err := st.GetCLITokenUser(ctx, authx.HashToken(raw)); err != nil || ok {
		t.Fatalf("token must be revoked after device delete: ok=%v err=%v", ok, err)
	}
}
