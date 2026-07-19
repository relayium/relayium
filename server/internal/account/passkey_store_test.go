package account

import (
	"bytes"
	"context"
	"testing"
)

func TestAdminCredentialCRUD(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	// 空表：无 handle
	if _, ok, err := st.AdminUserHandle(ctx); err != nil || ok {
		t.Fatalf("empty store: handle ok=%v err=%v, want ok=false", ok, err)
	}
	if creds, err := st.ListAdminCredentials(ctx); err != nil || len(creds) != 0 {
		t.Fatalf("empty store: got %d creds err=%v, want 0", len(creds), err)
	}

	handle := []byte("handle-32-bytes-aaaaaaaaaaaaaaaa")
	c := AdminCredential{
		ID: "cred-a", UserHandle: handle, CredJSON: []byte(`{"id":"a"}`),
		Name: "MacBook", CreatedAt: 1000, LastUsedAt: 0,
	}
	if err := st.InsertAdminCredential(ctx, c); err != nil {
		t.Fatalf("insert: %v", err)
	}

	got, ok, err := st.GetAdminCredential(ctx, "cred-a")
	if err != nil || !ok {
		t.Fatalf("get: ok=%v err=%v", ok, err)
	}
	if got.Name != "MacBook" || !bytes.Equal(got.UserHandle, handle) {
		t.Fatalf("get: name=%q handle=%q", got.Name, got.UserHandle)
	}
	if !bytes.Equal(got.CredJSON, []byte(`{"id":"a"}`)) {
		t.Fatalf("get: credJSON=%q", got.CredJSON)
	}

	// handle 现在可读
	h, ok, err := st.AdminUserHandle(ctx)
	if err != nil || !ok || !bytes.Equal(h, handle) {
		t.Fatalf("handle: %q ok=%v err=%v", h, ok, err)
	}

	// 回写 credJSON + last_used_at
	if err := st.TouchAdminCredential(ctx, "cred-a", []byte(`{"id":"a","n":1}`), 2000); err != nil {
		t.Fatalf("touch: %v", err)
	}
	got, _, _ = st.GetAdminCredential(ctx, "cred-a")
	if got.LastUsedAt != 2000 || !bytes.Equal(got.CredJSON, []byte(`{"id":"a","n":1}`)) {
		t.Fatalf("after touch: lastUsed=%d json=%q", got.LastUsedAt, got.CredJSON)
	}

	// 缺失键
	if _, ok, err := st.GetAdminCredential(ctx, "nope"); err != nil || ok {
		t.Fatalf("missing: ok=%v err=%v, want ok=false", ok, err)
	}

	// 删除
	if err := st.DeleteAdminCredential(ctx, "cred-a"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, ok, _ := st.GetAdminCredential(ctx, "cred-a"); ok {
		t.Fatalf("still present after delete")
	}
}

// 第二枚凭据必须复用第一枚的 user handle：handle 与 RELAYIUM_ADMIN_USER 解耦，
// 变更用户名不得作废已注册凭据。
func TestAdminUserHandleSharedAcrossCredentials(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	handle := []byte("shared-handle-aaaaaaaaaaaaaaaaaa")

	for _, id := range []string{"c1", "c2"} {
		err := st.InsertAdminCredential(ctx, AdminCredential{
			ID: id, UserHandle: handle, CredJSON: []byte(`{}`),
			Name: id, CreatedAt: 1, LastUsedAt: 0,
		})
		if err != nil {
			t.Fatalf("insert %s: %v", id, err)
		}
	}

	h, ok, err := st.AdminUserHandle(ctx)
	if err != nil || !ok || !bytes.Equal(h, handle) {
		t.Fatalf("shared handle: %q ok=%v err=%v", h, ok, err)
	}
	creds, err := st.ListAdminCredentials(ctx)
	if err != nil || len(creds) != 2 {
		t.Fatalf("list: %d creds err=%v, want 2", len(creds), err)
	}
	// 按 created_at, id 稳定排序
	if creds[0].ID != "c1" || creds[1].ID != "c2" {
		t.Fatalf("order: %s,%s", creds[0].ID, creds[1].ID)
	}
}
