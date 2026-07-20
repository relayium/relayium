package account

import (
	"context"
	"testing"
)

func TestAuditRoundTrip(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t)
	e := AuditEntry{
		At: 1700000000, Actor: "admin", IP: "203.0.113.7", Auth: "passkey",
		Action: "settings.update", Target: "-",
		Changes: `[{"field":"daily_quota","old":209715200,"new":419430400}]`,
		StepUp:  "totp",
	}
	if err := store.InsertAudit(ctx, e); err != nil {
		t.Fatalf("InsertAudit: %v", err)
	}
	got, err := store.ListAudit(ctx, 10, 0, "")
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("want 1 entry, got %d", len(got))
	}
	if got[0].Action != "settings.update" || got[0].StepUp != "totp" || got[0].Changes != e.Changes {
		t.Fatalf("round-trip mismatch: %+v", got[0])
	}
	if got[0].ID == 0 {
		t.Fatal("want a non-zero autoincrement id")
	}
}

// 倒序是审计页的默认视图：最近的操作必须排在最前。
func TestAuditListIsNewestFirst(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t)
	for _, at := range []int64{100, 300, 200} {
		if err := store.InsertAudit(ctx, AuditEntry{
			At: at, Actor: "admin", IP: "-", Auth: "password",
			Action: "node.label", Target: "node:x", Changes: "[]", StepUp: "",
		}); err != nil {
			t.Fatal(err)
		}
	}
	got, err := store.ListAudit(ctx, 10, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[0].At != 300 || got[2].At != 100 {
		t.Fatalf("want 300,200,100 order, got %v", []int64{got[0].At, got[1].At, got[2].At})
	}
}

func TestAuditFilterByAction(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t)
	for _, a := range []string{"login.ok", "node.delete", "login.ok"} {
		if err := store.InsertAudit(ctx, AuditEntry{
			At: 1, Actor: "admin", IP: "-", Auth: "password",
			Action: a, Target: "-", Changes: "[]", StepUp: "",
		}); err != nil {
			t.Fatal(err)
		}
	}
	got, err := store.ListAudit(ctx, 10, 0, "login.ok")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 login.ok entries, got %d", len(got))
	}
}

// 分页：offset 必须跳过最近的若干条，而不是从头返回。
func TestAuditPaging(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t)
	for i := int64(1); i <= 5; i++ {
		if err := store.InsertAudit(ctx, AuditEntry{
			At: i, Actor: "admin", IP: "-", Auth: "password",
			Action: "node.label", Target: "-", Changes: "[]", StepUp: "",
		}); err != nil {
			t.Fatal(err)
		}
	}
	got, err := store.ListAudit(ctx, 2, 2, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].At != 3 || got[1].At != 2 {
		t.Fatalf("want at=3,2 on page 2, got %+v", got)
	}
}
