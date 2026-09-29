package account

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/relayium/relayium/authx"
)

func idleExpiryBearer(t *testing.T, s *Service, createdAt int64) (raw string, user User, device Device) {
	t.Helper()
	var err error
	user, err = s.store.UpsertUserByEmail(context.Background(), authx.NewID()+"@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	device, err = s.store.UpsertDevice(context.Background(), Device{
		ID: authx.NewID(), UserID: user.ID, Name: "idle-test", Kind: "cli", CreatedAt: createdAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	raw = "rlm_cli_" + authx.RandToken()
	if err := s.store.CreateCLIToken(context.Background(), CLIToken{
		TokenHash: authx.HashToken(raw), UserID: user.ID, DeviceID: device.ID, CreatedAt: createdAt,
	}); err != nil {
		t.Fatal(err)
	}
	return raw, user, device
}

func authenticateAt(t *testing.T, s *Service, raw string, at int64) int {
	t.Helper()
	s.now = func() time.Time { return time.Unix(at, 0) }
	req := httptest.NewRequest(http.MethodGet, "/protected", nil)
	req.Header.Set("Authorization", "Bearer "+raw)
	rec := httptest.NewRecorder()
	s.RequireAuth(func(w http.ResponseWriter, _ *http.Request, _ User) {
		w.WriteHeader(http.StatusNoContent)
	})(rec, req)
	return rec.Code
}

func cliTokenTimes(t *testing.T, s *Service, raw string) (lastSeen, expires int64) {
	t.Helper()
	if err := s.store.(*SQLiteStore).db.QueryRow(
		`SELECT last_seen_at, idle_expires_at FROM cli_tokens WHERE token_hash = ?`,
		authx.HashToken(raw)).Scan(&lastSeen, &expires); err != nil {
		t.Fatal(err)
	}
	return lastSeen, expires
}

func TestCLITokenIdleExpiryBoundaryAndRenewal(t *testing.T) {
	s, _ := newTestService(t)
	const createdAt int64 = 10_000

	beforeRaw, _, _ := idleExpiryBearer(t, s, createdAt)
	oldDeadline := createdAt + cliTokenIdleTTLSeconds
	if got := authenticateAt(t, s, beforeRaw, oldDeadline-1); got != http.StatusNoContent {
		t.Fatalf("just before deadline status = %d, want 204", got)
	}
	lastSeen, expires := cliTokenTimes(t, s, beforeRaw)
	if lastSeen != oldDeadline-1 || expires != oldDeadline-1+cliTokenIdleTTLSeconds {
		t.Fatalf("renewed times = (%d, %d), want (%d, %d)", lastSeen, expires, oldDeadline-1, oldDeadline-1+cliTokenIdleTTLSeconds)
	}

	boundaryRaw, _, boundaryDevice := idleExpiryBearer(t, s, createdAt)
	if got := authenticateAt(t, s, boundaryRaw, oldDeadline); got != http.StatusUnauthorized {
		t.Fatalf("at deadline status = %d, want 401", got)
	}
	lastSeen, expires = cliTokenTimes(t, s, boundaryRaw)
	if lastSeen != 0 || expires != oldDeadline {
		t.Fatalf("expired token mutated to (%d, %d)", lastSeen, expires)
	}
	var deviceSeen int64
	var deviceIP string
	if err := s.store.(*SQLiteStore).db.QueryRow(
		`SELECT last_seen_at, last_ip FROM devices WHERE id = ?`, boundaryDevice.ID).
		Scan(&deviceSeen, &deviceIP); err != nil {
		t.Fatal(err)
	}
	if deviceSeen != 0 || deviceIP != "" {
		t.Fatalf("expired token mutated device to (%d, %q)", deviceSeen, deviceIP)
	}
}

func TestCLITokenMigrationGraceAndRollingWriterClaim(t *testing.T) {
	s, _ := newTestService(t)
	st := s.store.(*SQLiteStore)
	ctx := context.Background()
	raw, _, _ := idleExpiryBearer(t, s, 1)
	if _, err := st.db.Exec(`UPDATE cli_tokens SET idle_expires_at = 0 WHERE token_hash = ?`, authx.HashToken(raw)); err != nil {
		t.Fatal(err)
	}
	if _, err := st.db.Exec(`DELETE FROM schema_migrations WHERE id = ?`, "backfill_cli_token_idle_expiry"); err != nil {
		t.Fatal(err)
	}
	const migratedAt int64 = 50_000
	if err := migrateCLITokenIdleExpiry(st.db, migratedAt); err != nil {
		t.Fatal(err)
	}
	_, expires := cliTokenTimes(t, s, raw)
	if expires != migratedAt+cliTokenIdleTTLSeconds {
		t.Fatalf("migrated deadline = %d, want %d", expires, migratedAt+cliTokenIdleTTLSeconds)
	}
	if err := migrateCLITokenIdleExpiry(st.db, migratedAt+999); err != nil {
		t.Fatal(err)
	}
	_, expires = cliTokenTimes(t, s, raw)
	if expires != migratedAt+cliTokenIdleTTLSeconds {
		t.Fatalf("repeat migration moved deadline to %d", expires)
	}

	// A binary from the rolling-deploy window can still insert the new column's
	// DEFAULT 0. The first new-server authentication claims it once.
	rollingRaw, _, _ := idleExpiryBearer(t, s, 1)
	if _, err := st.db.ExecContext(ctx, `UPDATE cli_tokens SET idle_expires_at = 0 WHERE token_hash = ?`, authx.HashToken(rollingRaw)); err != nil {
		t.Fatal(err)
	}
	const claimAt int64 = 90_000_000
	if got := authenticateAt(t, s, rollingRaw, claimAt); got != http.StatusNoContent {
		t.Fatalf("rolling-writer row status = %d, want 204", got)
	}
	lastSeen, expires := cliTokenTimes(t, s, rollingRaw)
	if lastSeen != claimAt || expires != claimAt+cliTokenIdleTTLSeconds {
		t.Fatalf("claimed times = (%d, %d)", lastSeen, expires)
	}
}

func TestCLITokenIdleExpiryMigratesLegacyTableShape(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy-cli-token.db")
	st, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	u, err := st.UpsertUserByEmail(context.Background(), "legacy-idle@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	d, err := st.UpsertDevice(context.Background(), Device{ID: authx.NewID(), UserID: u.ID, Name: "legacy", Kind: "cli", CreatedAt: 1})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.CreateCLIToken(context.Background(), CLIToken{TokenHash: "legacy-hash", UserID: u.ID, DeviceID: d.ID, CreatedAt: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.db.Exec(`DELETE FROM schema_migrations WHERE id = ?`, "backfill_cli_token_idle_expiry"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.db.Exec(`ALTER TABLE cli_tokens DROP COLUMN idle_expires_at`); err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}

	before := time.Now().Unix()
	reopened, err := OpenSQLite(path)
	if err != nil {
		t.Fatalf("open legacy shape: %v", err)
	}
	t.Cleanup(func() { reopened.Close() })
	var deadline int64
	if err := reopened.db.QueryRow(`SELECT idle_expires_at FROM cli_tokens WHERE token_hash = 'legacy-hash'`).Scan(&deadline); err != nil {
		t.Fatal(err)
	}
	after := time.Now().Unix()
	if deadline < before+cliTokenIdleTTLSeconds || deadline > after+cliTokenIdleTTLSeconds {
		t.Fatalf("legacy deadline = %d, want migration time + 90 days in [%d, %d]", deadline, before+cliTokenIdleTTLSeconds, after+cliTokenIdleTTLSeconds)
	}
}

func TestExpiredCLITokenConcurrentRequestsCannotReviveIt(t *testing.T) {
	s, _ := newTestService(t)
	const createdAt int64 = 100
	raw, _, _ := idleExpiryBearer(t, s, createdAt)
	at := createdAt + cliTokenIdleTTLSeconds
	const attempts = 12
	statuses := make(chan int, attempts)
	var wg sync.WaitGroup
	for range attempts {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _, ok, err := s.store.AuthenticateCLIToken(context.Background(), authx.HashToken(raw), at, "203.0.113.7")
			if err != nil {
				statuses <- http.StatusInternalServerError
				return
			}
			if ok {
				statuses <- http.StatusNoContent
				return
			}
			statuses <- http.StatusUnauthorized
		}()
	}
	wg.Wait()
	close(statuses)
	for status := range statuses {
		if status != http.StatusUnauthorized {
			t.Fatalf("concurrent expired status = %d, want 401", status)
		}
	}
	lastSeen, expires := cliTokenTimes(t, s, raw)
	if lastSeen != 0 || expires != at {
		t.Fatalf("concurrent requests revived token to (%d, %d)", lastSeen, expires)
	}
}

func TestFrozenCLITokenDoesNotMoveIdleState(t *testing.T) {
	s, _ := newTestService(t)
	const now int64 = 1_000
	raw, user, _ := idleExpiryBearer(t, s, now)
	beforeSeen, beforeExpiry := cliTokenTimes(t, s, raw)
	if err := s.store.SetAccountDeletion(context.Background(), user.ID, now, now+100); err != nil {
		t.Fatal(err)
	}
	if got := authenticateAt(t, s, raw, now+1); got != http.StatusUnauthorized {
		t.Fatalf("frozen status = %d, want 401", got)
	}
	afterSeen, afterExpiry := cliTokenTimes(t, s, raw)
	if afterSeen != beforeSeen || afterExpiry != beforeExpiry {
		t.Fatalf("frozen bearer moved (%d, %d) -> (%d, %d)", beforeSeen, beforeExpiry, afterSeen, afterExpiry)
	}
}
