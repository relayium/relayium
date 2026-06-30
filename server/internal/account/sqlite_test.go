package account

import (
	"context"
	"sort"
	"testing"
)

func newTestStore(t *testing.T) *SQLiteStore {
	t.Helper()
	s, err := OpenSQLite(":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestUpsertUserByEmailIsIdempotentAndNormalizes(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u1, err := s.UpsertUserByEmail(ctx, "Alice@Example.com", "Alice")
	if err != nil {
		t.Fatalf("upsert1: %v", err)
	}
	if u1.Email != "alice@example.com" {
		t.Fatalf("email not normalized: %q", u1.Email)
	}
	u2, err := s.UpsertUserByEmail(ctx, "alice@example.com", "Alice 2")
	if err != nil {
		t.Fatalf("upsert2: %v", err)
	}
	if u2.ID != u1.ID {
		t.Fatalf("same email produced two users: %s vs %s", u1.ID, u2.ID)
	}
}

func TestIdentityLinkAndLookup(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u, err := s.UpsertUserByEmail(ctx, "bob@example.com", "Bob")
	if err != nil {
		t.Fatalf("setup upsert: %v", err)
	}
	if err := s.LinkIdentity(ctx, "google", "sub-123", u.ID); err != nil {
		t.Fatalf("link: %v", err)
	}
	got, ok, err := s.GetUserByIdentity(ctx, "google", "sub-123")
	if err != nil || !ok {
		t.Fatalf("lookup failed: ok=%v err=%v", ok, err)
	}
	if got.ID != u.ID {
		t.Fatalf("wrong user: %s", got.ID)
	}
	if _, ok, _ := s.GetUserByIdentity(ctx, "google", "missing"); ok {
		t.Fatalf("expected no user for missing subject")
	}
}

func TestSessionLifecycle(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u, _ := s.UpsertUserByEmail(ctx, "c@example.com", "C")
	sess := Session{ID: "sess1", UserID: u.ID, CreatedAt: 100, ExpiresAt: 200}
	if err := s.CreateSession(ctx, sess); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, ok, err := s.GetSession(ctx, "sess1")
	if err != nil || !ok || got.UserID != u.ID {
		t.Fatalf("get: ok=%v err=%v got=%+v", ok, err, got)
	}
	if err := s.RevokeSession(ctx, "sess1"); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if _, ok, _ := s.GetSession(ctx, "sess1"); ok {
		t.Fatalf("revoked session must return ok=false")
	}
	if _, ok, _ := s.GetSession(ctx, "missing"); ok {
		t.Fatalf("missing session must return ok=false")
	}
}

func TestMagicTokenOneTimeAndExpiry(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	tok := MagicToken{TokenHash: "h1", Email: "d@example.com", CreatedAt: 10, ExpiresAt: 100}
	if err := s.CreateMagicToken(ctx, tok); err != nil {
		t.Fatalf("create: %v", err)
	}
	// First use within window succeeds.
	got, ok, err := s.UseMagicToken(ctx, "h1", 50)
	if err != nil || !ok || got.Email != "d@example.com" {
		t.Fatalf("first use: ok=%v err=%v", ok, err)
	}
	// Second use of the same token fails (one-time).
	if _, ok, _ := s.UseMagicToken(ctx, "h1", 51); ok {
		t.Fatalf("token must be single-use")
	}
	// Expired token fails.
	exp := MagicToken{TokenHash: "h2", Email: "e@example.com", CreatedAt: 10, ExpiresAt: 100}
	_ = s.CreateMagicToken(ctx, exp)
	if _, ok, _ := s.UseMagicToken(ctx, "h2", 200); ok {
		t.Fatalf("expired token must fail")
	}
}

func TestDeviceRegistryScopedToUser(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u1, _ := s.UpsertUserByEmail(ctx, "u1@example.com", "U1")
	u2, _ := s.UpsertUserByEmail(ctx, "u2@example.com", "U2")

	d, err := s.UpsertDevice(ctx, Device{ID: "dev1", UserID: u1.ID, Name: "Laptop", CreatedAt: 1})
	if err != nil || d.Name != "Laptop" {
		t.Fatalf("upsert: %v %+v", err, d)
	}
	// Re-claiming the same device id by the same user updates the name.
	if _, err := s.UpsertDevice(ctx, Device{ID: "dev1", UserID: u1.ID, Name: "Laptop 2", CreatedAt: 1}); err != nil {
		t.Fatalf("re-upsert: %v", err)
	}
	list, _ := s.ListDevices(ctx, u1.ID)
	if len(list) != 1 || list[0].Name != "Laptop 2" {
		t.Fatalf("list after re-upsert: %+v", list)
	}
	// u2 cannot claim u1's device id; the upsert is rejected and leaks nothing.
	hijack, err := s.UpsertDevice(ctx, Device{ID: "dev1", UserID: u2.ID, Name: "hijack", CreatedAt: 2})
	if err == nil {
		t.Fatalf("u2 upsert of u1's device id must be rejected, got device %+v", hijack)
	}
	if hijack.UserID == u1.ID {
		t.Fatalf("UpsertDevice leaked u1's device row to u2: %+v", hijack)
	}
	// u1's device is unchanged.
	if l, _ := s.ListDevices(ctx, u1.ID); len(l) != 1 || l[0].Name != "Laptop 2" {
		t.Fatalf("u1 device mutated by u2 hijack attempt: %+v", l)
	}
	// u2 cannot rename or delete u1's device.
	if err := s.RenameDevice(ctx, "dev1", u2.ID, "hacked"); err == nil {
		if l, _ := s.ListDevices(ctx, u1.ID); l[0].Name == "hacked" {
			t.Fatalf("u2 renamed u1's device")
		}
	}
	_ = s.DeleteDevice(ctx, "dev1", u2.ID)
	if l, _ := s.ListDevices(ctx, u1.ID); len(l) != 1 {
		t.Fatalf("u2 deleted u1's device")
	}
	// Owner can delete.
	if err := s.DeleteDevice(ctx, "dev1", u1.ID); err != nil {
		t.Fatalf("owner delete: %v", err)
	}
	if l, _ := s.ListDevices(ctx, u1.ID); len(l) != 0 {
		t.Fatalf("device not deleted: %+v", l)
	}
}

func TestCreateAndGetTransfer(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u, err := s.UpsertUserByEmail(ctx, "owner@example.com", "Owner")
	if err != nil {
		t.Fatalf("seed user: %v", err)
	}
	want := Transfer{Token: "tok123", UserID: u.ID, CreatedAt: 1000, ExpiresAt: 4600}
	if err := s.CreateTransfer(ctx, want); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := s.GetTransfer(ctx, "tok123")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got != want {
		t.Fatalf("roundtrip mismatch: got %+v want %+v", got, want)
	}
}

func TestGetTransferMissingReturnsErrNotFound(t *testing.T) {
	s := newTestStore(t)
	_, err := s.GetTransfer(context.Background(), "nope")
	if err != ErrNotFound {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestRecordUsageKeepsMaxPerAlloc(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u, err := s.UpsertUserByEmail(ctx, "o@example.com", "O")
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	rec := func(b int64) {
		if err := s.RecordUsage(ctx, UsageEvent{AllocID: "a1", Token: "tok", UserID: u.ID, RelayedBytes: b, RecordedAt: 1}); err != nil {
			t.Fatalf("record %d: %v", b, err)
		}
	}
	total := func() int64 { v, _ := s.UserUsageTotal(ctx, u.ID); return v }

	rec(100) // first cumulative report
	rec(100) // redelivery of same total → no double-count
	if total() != 100 {
		t.Fatalf("redelivery total = %d, want 100", total())
	}
	rec(250) // later periodic cumulative report (grew) → keep the larger
	if total() != 250 {
		t.Fatalf("growth total = %d, want 250", total())
	}
	rec(200) // stale/out-of-order smaller report → still keep the max
	if total() != 250 {
		t.Fatalf("stale total = %d, want 250", total())
	}
}

func TestUserUsageTotalSumsAndDefaultsZero(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u, _ := s.UpsertUserByEmail(ctx, "o@example.com", "O")
	_ = s.RecordUsage(ctx, UsageEvent{AllocID: "a", Token: "t", UserID: u.ID, RelayedBytes: 100, RecordedAt: 1})
	_ = s.RecordUsage(ctx, UsageEvent{AllocID: "b", Token: "t", UserID: u.ID, RelayedBytes: 250, RecordedAt: 2})
	total, err := s.UserUsageTotal(ctx, u.ID)
	if err != nil || total != 350 {
		t.Fatalf("sum total = %d (err %v), want 350", total, err)
	}
	// Unknown user → 0, no error.
	zero, err := s.UserUsageTotal(ctx, "nobody")
	if err != nil || zero != 0 {
		t.Fatalf("unknown user total = %d (err %v), want 0", zero, err)
	}
}

func TestSetAndGetCredentials(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	// 未知邮箱：ok=false，无错误。
	if _, _, ok, err := s.GetCredentials(ctx, "nobody@example.com"); err != nil || ok {
		t.Fatalf("unknown email: ok=%v err=%v", ok, err)
	}

	u, err := s.UpsertUserByEmail(ctx, "P@Example.com", "P")
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	// 用户存在但还没密码：ok=false。
	if _, _, ok, _ := s.GetCredentials(ctx, "p@example.com"); ok {
		t.Fatalf("user without password should have ok=false")
	}
	if err := s.SetPassword(ctx, u.ID, "hash-xyz"); err != nil {
		t.Fatalf("set password: %v", err)
	}
	uid, hash, ok, err := s.GetCredentials(ctx, "p@example.com")
	if err != nil || !ok {
		t.Fatalf("after set: ok=%v err=%v", ok, err)
	}
	if uid != u.ID || hash != "hash-xyz" {
		t.Fatalf("got uid=%q hash=%q want %q/hash-xyz", uid, hash, u.ID)
	}
}

func TestPasswordColumnMigrationIsIdempotent(t *testing.T) {
	// 在同一文件 DB 上连开两次，ALTER 重复加列不能报错。
	dir := t.TempDir()
	dsn := dir + "/mig.db"
	s1, err := OpenSQLite(dsn)
	if err != nil {
		t.Fatalf("open1: %v", err)
	}
	s1.Close()
	s2, err := OpenSQLite(dsn)
	if err != nil {
		t.Fatalf("open2 (re-migrate) must succeed: %v", err)
	}
	s2.Close()
}

func TestAdminListUsersAggregates(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	u, _ := s.UpsertUserByEmail(ctx, "agg@example.com", "Agg")
	_ = s.SetPassword(ctx, u.ID, "h")
	_ = s.LinkIdentity(ctx, "password", "agg@example.com", u.ID)
	_ = s.LinkIdentity(ctx, "google", "google-sub-1", u.ID)
	_, _ = s.UpsertDevice(ctx, Device{ID: "d1", UserID: u.ID, Name: "Laptop", CreatedAt: 1})
	_, _ = s.UpsertDevice(ctx, Device{ID: "d2", UserID: u.ID, Name: "Phone", CreatedAt: 2})
	_ = s.RecordUsage(ctx, UsageEvent{AllocID: "a1", Token: "t", UserID: u.ID, RelayedBytes: 700, RecordedAt: 1})

	// 第二个用户：无设备、无流量、仅 password。
	u2, _ := s.UpsertUserByEmail(ctx, "solo@example.com", "Solo")
	_ = s.LinkIdentity(ctx, "password", "solo@example.com", u2.ID)

	rows, err := s.AdminListUsers(ctx)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("want 2 rows, got %d", len(rows))
	}
	var agg *AdminUserRow
	for i := range rows {
		if rows[i].Email == "agg@example.com" {
			agg = &rows[i]
		}
	}
	if agg == nil {
		t.Fatalf("agg row missing")
	}
	if agg.DeviceCount != 2 {
		t.Fatalf("device count = %d, want 2", agg.DeviceCount)
	}
	if agg.RelayedBytes != 700 {
		t.Fatalf("relayed = %d, want 700", agg.RelayedBytes)
	}
	want := []string{"google", "password"}
	got := append([]string(nil), agg.Methods...)
	sort.Strings(got)
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("methods = %v, want %v", agg.Methods, want)
	}
}
