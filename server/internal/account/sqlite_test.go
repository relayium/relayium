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

func TestStoredFileCRUDAndExpiry(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u, _ := s.UpsertUserByEmail(ctx, "sf@example.com", "SF")
	f := StoredFile{
		ID: "file1", UserID: u.ID, BlobKey: "blobkey1",
		EncManifest: []byte{0xde, 0xad, 0xbe, 0xef}, Size: 1234,
		BurnAfterRead: true, CreatedAt: 100, ExpiresAt: 200,
	}
	if err := s.CreateStoredFile(ctx, f); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := s.GetStoredFile(ctx, "file1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.UserID != u.ID || got.BlobKey != "blobkey1" || got.Size != 1234 ||
		!got.BurnAfterRead || got.ExpiresAt != 200 || got.DownloadedAt != 0 ||
		string(got.EncManifest) != string(f.EncManifest) {
		t.Fatalf("roundtrip mismatch: %+v", got)
	}
	list, _ := s.ListStoredFilesByUser(ctx, u.ID)
	if len(list) != 1 || list[0].ID != "file1" {
		t.Fatalf("list: %+v", list)
	}
	if err := s.MarkDownloaded(ctx, "file1", 150); err != nil {
		t.Fatalf("mark: %v", err)
	}
	if g, _ := s.GetStoredFile(ctx, "file1"); g.DownloadedAt != 150 {
		t.Fatalf("downloaded_at = %d, want 150", g.DownloadedAt)
	}
	if err := s.DeleteStoredFile(ctx, "file1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := s.GetStoredFile(ctx, "file1"); err != ErrNotFound {
		t.Fatalf("get after delete: want ErrNotFound, got %v", err)
	}
}

func TestListExpiredStoredFiles(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u, _ := s.UpsertUserByEmail(ctx, "e@example.com", "E")
	_ = s.CreateStoredFile(ctx, StoredFile{ID: "old", UserID: u.ID, BlobKey: "k1", EncManifest: []byte{1}, Size: 1, CreatedAt: 1, ExpiresAt: 100})
	_ = s.CreateStoredFile(ctx, StoredFile{ID: "fresh", UserID: u.ID, BlobKey: "k2", EncManifest: []byte{1}, Size: 1, CreatedAt: 1, ExpiresAt: 5000})
	exp, err := s.ListExpiredStoredFiles(ctx, 1000)
	if err != nil {
		t.Fatalf("list expired: %v", err)
	}
	if len(exp) != 1 || exp[0].ID != "old" {
		t.Fatalf("expired = %+v, want only [old]", exp)
	}
}

func TestUserUploadedSinceRollingWindow(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u, _ := s.UpsertUserByEmail(ctx, "q@example.com", "Q")
	// now = 100000; window start = now - 86400 = 13600.
	_ = s.RecordUpload(ctx, UploadEvent{ID: "e1", UserID: u.ID, Bytes: 1000, UploadedAt: 10000}) // before window
	_ = s.RecordUpload(ctx, UploadEvent{ID: "e2", UserID: u.ID, Bytes: 2000, UploadedAt: 50000}) // in window
	_ = s.RecordUpload(ctx, UploadEvent{ID: "e3", UserID: u.ID, Bytes: 3000, UploadedAt: 90000}) // in window
	total, err := s.UserUploadedSince(ctx, u.ID, 13600)
	if err != nil || total != 5000 {
		t.Fatalf("uploaded since = %d (err %v), want 5000", total, err)
	}
	// Unknown user → 0, no error.
	if z, err := s.UserUploadedSince(ctx, "nobody", 0); err != nil || z != 0 {
		t.Fatalf("unknown user = %d (err %v), want 0", z, err)
	}
	// PruneUploadEvents drops rows strictly older than the cutoff.
	if err := s.PruneUploadEvents(ctx, 13600); err != nil {
		t.Fatalf("prune: %v", err)
	}
	if total, _ := s.UserUploadedSince(ctx, u.ID, 0); total != 5000 {
		t.Fatalf("after prune total = %d, want 5000 (only e1 pruned)", total)
	}
}

func TestSettingsGetSetList(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	if _, ok, err := s.GetSetting(ctx, "max_file_size"); err != nil || ok {
		t.Fatalf("unset key: ok=%v err=%v", ok, err)
	}
	if err := s.SetSetting(ctx, "max_file_size", 52428800, 1); err != nil {
		t.Fatalf("set: %v", err)
	}
	v, ok, err := s.GetSetting(ctx, "max_file_size")
	if err != nil || !ok || v != 52428800 {
		t.Fatalf("get: v=%d ok=%v err=%v", v, ok, err)
	}
	// Upsert overwrites.
	_ = s.SetSetting(ctx, "max_file_size", 99, 2)
	if v, _, _ := s.GetSetting(ctx, "max_file_size"); v != 99 {
		t.Fatalf("after upsert v = %d, want 99", v)
	}
	_ = s.SetSetting(ctx, "daily_quota", 200, 3)
	all, err := s.ListSettings(ctx)
	if err != nil || len(all) != 2 {
		t.Fatalf("list: %+v err=%v", all, err)
	}
}

func TestHasPassword(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u, err := s.UpsertUserByEmail(ctx, "p@example.com", "P")
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if has, err := s.HasPassword(ctx, u.ID); err != nil || has {
		t.Fatalf("fresh user: has=%v err=%v, want false", has, err)
	}
	if err := s.SetPassword(ctx, u.ID, "somehash"); err != nil {
		t.Fatalf("set: %v", err)
	}
	if has, err := s.HasPassword(ctx, u.ID); err != nil || !has {
		t.Fatalf("after SetPassword: has=%v err=%v, want true", has, err)
	}
	if has, err := s.HasPassword(ctx, "no-such-user"); err != nil || has {
		t.Fatalf("unknown user: has=%v err=%v, want false", has, err)
	}
}

func TestRevokeUserSessions(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u, _ := s.UpsertUserByEmail(ctx, "s@example.com", "S")
	keep := Session{ID: "keep", UserID: u.ID, CreatedAt: 1, ExpiresAt: 1 << 40}
	drop := Session{ID: "drop", UserID: u.ID, CreatedAt: 1, ExpiresAt: 1 << 40}
	other, _ := s.UpsertUserByEmail(ctx, "o@example.com", "O")
	otherSess := Session{ID: "other", UserID: other.ID, CreatedAt: 1, ExpiresAt: 1 << 40}
	for _, ss := range []Session{keep, drop, otherSess} {
		if err := s.CreateSession(ctx, ss); err != nil {
			t.Fatalf("create %s: %v", ss.ID, err)
		}
	}
	if err := s.RevokeUserSessions(ctx, u.ID, "keep"); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if _, ok, _ := s.GetSession(ctx, "keep"); !ok {
		t.Fatal("current session must survive")
	}
	if _, ok, _ := s.GetSession(ctx, "drop"); ok {
		t.Fatal("other session of same user must be revoked")
	}
	if _, ok, _ := s.GetSession(ctx, "other"); !ok {
		t.Fatal("another user's session must be untouched")
	}
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

	rows, total, err := s.AdminListUsers(ctx, AdminUserQuery{Limit: 10})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if total != 2 || len(rows) != 2 {
		t.Fatalf("want 2 rows, got total=%d len=%d", total, len(rows))
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

func TestAdminMetrics(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	now := int64(1_700_000_000)

	u, err := s.UpsertUserByEmail(ctx, "a@example.com", "A")
	if err != nil {
		t.Fatal(err)
	}

	// stored_files: one active (expires in future), one expired.
	mustCreateStored(t, s, u.ID, "sf-active", 1000, now+3600)
	mustCreateStored(t, s, u.ID, "sf-expired", 9999, now-1)

	// usage_events: in-24h, in-7d-not-24h, older-than-7d.
	mustUsage(t, s, u.ID, "ue-24h", 100, now-10)
	mustUsage(t, s, u.ID, "ue-7d", 200, now-2*86400)
	mustUsage(t, s, u.ID, "ue-old", 400, now-8*86400)

	// upload_events: in-24h (incl. exact boundary) + older.
	mustUpload(t, s, u.ID, "up-24h", 50, now-86400) // boundary: >= now-86400 → included
	mustUpload(t, s, u.ID, "up-old", 70, now-86401) // excluded

	m, err := s.AdminMetrics(ctx, now)
	if err != nil {
		t.Fatal(err)
	}
	want := AdminMetrics{
		TotalUsers:        1,
		ActiveStoredFiles: 1,
		ActiveStoredBytes: 1000,
		RelayedBytes24h:   100,
		RelayedBytes7d:    300, // 100 + 200
		UploadedBytes24h:  50,
	}
	if m != want {
		t.Fatalf("metrics mismatch:\n got %+v\nwant %+v", m, want)
	}
}

func TestAdminListUsersQuery(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	// three users with distinct created_at, names, and relay totals.
	mkUser := func(email, name string, created int64) string {
		u, err := s.UpsertUserByEmail(ctx, email, name)
		if err != nil {
			t.Fatal(err)
		}
		// force created_at deterministically
		if _, err := s.db.ExecContext(ctx, `UPDATE users SET created_at=? WHERE id=?`, created, u.ID); err != nil {
			t.Fatal(err)
		}
		return u.ID
	}
	uA := mkUser("alice@example.com", "Alice", 100)
	mkUser("bob@example.com", "Bob 50%", 200) // literal % to test escaping
	mkUser("carol@example.com", "Carol", 300)
	mustUsage(t, s, uA, "u1", 999, 1_700_000_000) // Alice has the biggest relay total

	all := func(q AdminUserQuery) ([]AdminUserRow, int64) {
		rows, total, err := s.AdminListUsers(ctx, q)
		if err != nil {
			t.Fatal(err)
		}
		return rows, total
	}

	// default sort = created desc → Carol, Bob, Alice
	rows, total := all(AdminUserQuery{Limit: 10})
	if total != 3 || len(rows) != 3 || rows[0].Email != "carol@example.com" || rows[2].Email != "alice@example.com" {
		t.Fatalf("default sort/total wrong: total=%d rows=%v", total, emails(rows))
	}

	// search by name substring
	rows, total = all(AdminUserQuery{Search: "carol", Limit: 10})
	if total != 1 || len(rows) != 1 || rows[0].Email != "carol@example.com" {
		t.Fatalf("search miss: total=%d rows=%v", total, emails(rows))
	}

	// literal % must match only Bob, not act as wildcard
	rows, _ = all(AdminUserQuery{Search: "50%", Limit: 10})
	if len(rows) != 1 || rows[0].Email != "bob@example.com" {
		t.Fatalf("LIKE escape failed: rows=%v", emails(rows))
	}

	// sort by email asc
	rows, _ = all(AdminUserQuery{SortBy: "email", SortDir: "asc", Limit: 10})
	if rows[0].Email != "alice@example.com" || rows[2].Email != "carol@example.com" {
		t.Fatalf("email asc wrong: %v", emails(rows))
	}

	// sort by relayed desc → Alice first
	rows, _ = all(AdminUserQuery{SortBy: "relayed", SortDir: "desc", Limit: 10})
	if rows[0].Email != "alice@example.com" {
		t.Fatalf("relayed desc wrong: %v", emails(rows))
	}

	// pagination: limit 2 offset 2 → one row
	rows, total = all(AdminUserQuery{Limit: 2, Offset: 2})
	if total != 3 || len(rows) != 1 {
		t.Fatalf("paging wrong: total=%d len=%d", total, len(rows))
	}

	// invalid sort/dir fall back to created desc
	rows, _ = all(AdminUserQuery{SortBy: "; DROP", SortDir: "sideways", Limit: 10})
	if rows[0].Email != "carol@example.com" {
		t.Fatalf("fallback wrong: %v", emails(rows))
	}
}

func emails(rows []AdminUserRow) []string {
	out := make([]string, len(rows))
	for i, r := range rows {
		out[i] = r.Email
	}
	return out
}

// helpers
func mustCreateStored(t *testing.T, s *SQLiteStore, uid, id string, size, expires int64) {
	t.Helper()
	if err := s.CreateStoredFile(context.Background(), StoredFile{
		ID: id, UserID: uid, BlobKey: id, EncManifest: []byte("m"),
		Size: size, CreatedAt: expires - 100, ExpiresAt: expires,
	}); err != nil {
		t.Fatal(err)
	}
}
func mustUsage(t *testing.T, s *SQLiteStore, uid, alloc string, bytes, at int64) {
	t.Helper()
	if err := s.RecordUsage(context.Background(), UsageEvent{
		AllocID: alloc, Token: alloc, UserID: uid, RelayedBytes: bytes, RecordedAt: at,
	}); err != nil {
		t.Fatal(err)
	}
}
func mustUpload(t *testing.T, s *SQLiteStore, uid, id string, bytes, at int64) {
	t.Helper()
	if err := s.RecordUpload(context.Background(), UploadEvent{
		ID: id, UserID: uid, Bytes: bytes, UploadedAt: at,
	}); err != nil {
		t.Fatal(err)
	}
}
