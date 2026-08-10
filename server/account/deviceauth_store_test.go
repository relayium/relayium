package account

import (
	"context"
	"testing"

	"github.com/relayium/relayium/authx"
)

func TestDeviceAuthApproveConsumeOnce(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, err := st.UpsertUserByEmail(ctx, "approve-once@example.com", "Approve Once")
	if err != nil {
		t.Fatal(err)
	}
	req := DeviceAuthRequest{UserCode: "WDJB-MJHT", DeviceCodeHash: authx.HashToken("dev"), Status: "pending", CreatedAt: 1, ExpiresAt: 1 << 40}
	if err := st.CreateDeviceAuth(ctx, req); err != nil {
		t.Fatal(err)
	}
	_, _, ok, err := st.ApproveAndRegisterDeviceAuth(ctx, "WDJB-MJHT", u.ID, "rlm_cli_raw", "approve-once-device", 2)
	if err != nil || !ok {
		t.Fatalf("approve: %v %v", ok, err)
	}
	// second approve on same code must fail (already approved)
	_, _, ok2, _ := st.ApproveAndRegisterDeviceAuth(ctx, "WDJB-MJHT", u.ID, "rlm_cli_raw", "must-not-exist", 3)
	if ok2 {
		t.Fatal("double approve should fail")
	}
	tok1, c1, _ := st.ConsumeDeviceAuth(ctx, authx.HashToken("dev"), 4)
	_, c2, _ := st.ConsumeDeviceAuth(ctx, authx.HashToken("dev"), 5)
	if !c1 || c2 || tok1 != "rlm_cli_raw" {
		t.Fatalf("consume should succeed once with token: tok=%q c1=%v c2=%v", tok1, c1, c2)
	}
}

func TestApproveAndRegisterMakesTheReturnedBearerImmediatelyValid(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, err := st.UpsertUserByEmail(ctx, "atomic-approve@example.com", "Atomic Approve")
	if err != nil {
		t.Fatal(err)
	}
	req := DeviceAuthRequest{
		UserCode: "ATOM-CODE", DeviceCodeHash: authx.HashToken("atomic-device-code"),
		Status: "pending", CreatedAt: 1, ExpiresAt: 1 << 40,
		DeviceName: "This Mac", InstallID: sampleInstallID, ClientIP: "203.0.113.9",
	}
	if err := st.CreateDeviceAuth(ctx, req); err != nil {
		t.Fatal(err)
	}
	raw := "rlm_cli_atomic"
	_, device, ok, err := st.ApproveAndRegisterDeviceAuth(ctx, req.UserCode, u.ID, raw, "atomic-device", 2)
	if err != nil || !ok {
		t.Fatalf("approve and register: ok=%v err=%v", ok, err)
	}
	if device.Kind != "app" {
		t.Fatalf("native installation was presented as %q, want app", device.Kind)
	}
	if gotUser, gotDevice, valid, err := st.GetCLITokenUser(ctx, authx.HashToken(raw)); err != nil || !valid || gotUser != u.ID || gotDevice != device.ID {
		t.Fatalf("committed token is not immediately valid: user=%q device=%q valid=%v err=%v", gotUser, gotDevice, valid, err)
	}
	gotRaw, consumed, err := st.ConsumeDeviceAuth(ctx, req.DeviceCodeHash, 3)
	if err != nil || !consumed || gotRaw != raw {
		t.Fatalf("poll handoff: raw=%q consumed=%v err=%v", gotRaw, consumed, err)
	}
}

func TestApproveAndRegisterRollsBackApprovalWhenBearerCannotCommit(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, err := st.UpsertUserByEmail(ctx, "atomic-rollback@example.com", "Atomic Rollback")
	if err != nil {
		t.Fatal(err)
	}
	other, err := st.UpsertDevice(ctx, Device{ID: "other-device", UserID: u.ID, Name: "Other", Kind: "cli", CreatedAt: 1})
	if err != nil {
		t.Fatal(err)
	}
	raw := "rlm_cli_collision"
	if err := st.CreateCLIToken(ctx, CLIToken{TokenHash: authx.HashToken(raw), UserID: u.ID, DeviceID: other.ID, CreatedAt: 1}); err != nil {
		t.Fatal(err)
	}
	req := DeviceAuthRequest{
		UserCode: "ROLL-BACK", DeviceCodeHash: authx.HashToken("rollback-device-code"),
		Status: "pending", CreatedAt: 1, ExpiresAt: 1 << 40,
		DeviceName: "This Mac", InstallID: sampleInstallID,
	}
	if err := st.CreateDeviceAuth(ctx, req); err != nil {
		t.Fatal(err)
	}
	if _, _, ok, err := st.ApproveAndRegisterDeviceAuth(ctx, req.UserCode, u.ID, raw, "must-not-exist", 2); err == nil || ok {
		t.Fatalf("colliding bearer should refuse the whole transaction: ok=%v err=%v", ok, err)
	}
	after, found, err := st.GetDeviceAuthByUserCode(ctx, req.UserCode)
	if err != nil || !found || after.Status != "pending" {
		t.Fatalf("failed registration exposed an approved request: found=%v status=%q err=%v", found, after.Status, err)
	}
	if _, consumed, err := st.ConsumeDeviceAuth(ctx, req.DeviceCodeHash, 3); err != nil || consumed {
		t.Fatalf("failed registration exposed a pollable token: consumed=%v err=%v", consumed, err)
	}
	if devices, err := st.ListDevices(ctx, u.ID); err != nil || len(devices) != 1 || devices[0].ID != other.ID {
		t.Fatalf("failed registration left a device row: devices=%+v err=%v", devices, err)
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
	if err := st.TouchCLIToken(ctx, authx.HashToken("t"), 99, "203.0.113.9"); err != nil {
		t.Fatalf("touch: %v", err)
	}
	devices, err := st.ListDevices(ctx, u.ID)
	if err != nil || len(devices) != 1 {
		t.Fatalf("list touched device: %v %+v", err, devices)
	}
	if devices[0].LastSeenAt != 99 || devices[0].LastIP != "203.0.113.9" {
		t.Fatalf("device hint was not touched with its credential: %+v", devices[0])
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
