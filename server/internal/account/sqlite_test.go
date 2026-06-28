package account

import (
	"context"
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
