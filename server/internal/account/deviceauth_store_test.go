package account

import (
	"context"
	"testing"
)

func TestDeviceAuthApproveConsumeOnce(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	req := DeviceAuthRequest{UserCode: "WDJB-MJHT", DeviceCodeHash: hashToken("dev"), Status: "pending", CreatedAt: 1, ExpiresAt: 1 << 40}
	if err := st.CreateDeviceAuth(ctx, req); err != nil {
		t.Fatal(err)
	}
	ok, err := st.ApproveDeviceAuth(ctx, "WDJB-MJHT", "u1", hashToken("tok"), "rlm_cli_raw", 2)
	if err != nil || !ok {
		t.Fatalf("approve: %v %v", ok, err)
	}
	// second approve on same code must fail (already approved)
	ok2, _ := st.ApproveDeviceAuth(ctx, "WDJB-MJHT", "u1", hashToken("tok"), "rlm_cli_raw", 3)
	if ok2 {
		t.Fatal("double approve should fail")
	}
	tok1, c1, _ := st.ConsumeDeviceAuth(ctx, hashToken("dev"), 4)
	_, c2, _ := st.ConsumeDeviceAuth(ctx, hashToken("dev"), 5)
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
	if err := st.CreateCLIToken(ctx, CLIToken{TokenHash: hashToken("t"), UserID: u.ID, DeviceID: d.ID, CreatedAt: 1}); err != nil {
		t.Fatalf("create cli token: %v", err)
	}
	uid, did, ok, err := st.GetCLITokenUser(ctx, hashToken("t"))
	if err != nil || !ok || uid != u.ID || did != d.ID {
		t.Fatalf("lookup: %v %v %q %q", ok, err, uid, did)
	}
	_, _, ok2, _ := st.GetCLITokenUser(ctx, hashToken("nope"))
	if ok2 {
		t.Fatal("unknown token must not resolve")
	}
	if err := st.TouchCLIToken(ctx, hashToken("t"), 99); err != nil {
		t.Fatalf("touch: %v", err)
	}
}
