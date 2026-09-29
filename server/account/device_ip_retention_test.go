package account

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/relayium/relayium/authx"
)

func TestDeviceIPRetentionUsesItsOwnObservationClock(t *testing.T) {
	ctx := context.Background()
	st := newTestStore(t)
	u, err := st.UpsertUserByEmail(ctx, "ip-clock@example.test", "IP Clock")
	if err != nil {
		t.Fatal(err)
	}
	d, err := st.UpsertDevice(ctx, Device{ID: "ip-device", UserID: u.ID, Name: "CLI", Kind: "cli", CreatedAt: 1})
	if err != nil {
		t.Fatal(err)
	}
	raw := "ip-retention-token"
	if err := st.CreateCLIToken(ctx, CLIToken{TokenHash: authx.HashToken(raw), UserID: u.ID, DeviceID: d.ID, CreatedAt: 1}); err != nil {
		t.Fatal(err)
	}

	const observed = int64(10_000)
	if err := st.TouchCLIToken(ctx, authx.HashToken(raw), observed, "203.0.113.10"); err != nil {
		t.Fatal(err)
	}
	// Activity without a valid address moves last_seen, but must not refresh the
	// independent observation time.
	if err := st.TouchCLIToken(ctx, authx.HashToken(raw), observed+deviceIPRetentionSeconds-1, ""); err != nil {
		t.Fatal(err)
	}
	var ip string
	var ipAt, seen int64
	if err := st.db.QueryRow(`SELECT last_ip,last_ip_observed_at,last_seen_at FROM devices WHERE id=?`, d.ID).Scan(&ip, &ipAt, &seen); err != nil {
		t.Fatal(err)
	}
	if ip != "203.0.113.10" || ipAt != observed || seen != observed+deviceIPRetentionSeconds-1 {
		t.Fatalf("before boundary ip=%q observed=%d seen=%d", ip, ipAt, seen)
	}
	if err := st.PruneExpiredDeviceIPs(ctx, observed+deviceIPRetentionSeconds-1); err != nil {
		t.Fatal(err)
	}
	if err := st.db.QueryRow(`SELECT last_ip,last_ip_observed_at FROM devices WHERE id=?`, d.ID).Scan(&ip, &ipAt); err != nil {
		t.Fatal(err)
	}
	if ip == "" || ipAt != observed {
		t.Fatalf("just-before boundary was cleared: ip=%q observed=%d", ip, ipAt)
	}
	if err := st.PruneExpiredDeviceIPs(ctx, observed+deviceIPRetentionSeconds); err != nil {
		t.Fatal(err)
	}
	if err := st.db.QueryRow(`SELECT last_ip,last_ip_observed_at,last_seen_at FROM devices WHERE id=?`, d.ID).Scan(&ip, &ipAt, &seen); err != nil {
		t.Fatal(err)
	}
	if ip != "" || ipAt != 0 || seen != observed+deviceIPRetentionSeconds-1 {
		t.Fatalf("at boundary ip=%q observed=%d seen=%d", ip, ipAt, seen)
	}
}

func TestValidDeviceIPObservationRefreshesAddressAndClockTogether(t *testing.T) {
	ctx := context.Background()
	st := newTestStore(t)
	u, _ := st.UpsertUserByEmail(ctx, "ip-refresh@example.test", "IP Refresh")
	d, _ := st.UpsertDevice(ctx, Device{ID: "refresh-device", UserID: u.ID, Name: "CLI", Kind: "cli", CreatedAt: 1})
	raw := "refresh-token"
	_ = st.CreateCLIToken(ctx, CLIToken{TokenHash: authx.HashToken(raw), UserID: u.ID, DeviceID: d.ID, CreatedAt: 1})

	if _, _, ok, err := st.AuthenticateCLIToken(ctx, authx.HashToken(raw), 20_000, "198.51.100.8"); err != nil || !ok {
		t.Fatalf("authenticate: ok=%v err=%v", ok, err)
	}
	var ip string
	var ipAt int64
	if err := st.db.QueryRow(`SELECT last_ip,last_ip_observed_at FROM devices WHERE id=?`, d.ID).Scan(&ip, &ipAt); err != nil {
		t.Fatal(err)
	}
	if ip != "198.51.100.8" || ipAt != 20_000 {
		t.Fatalf("first observation ip=%q at=%d", ip, ipAt)
	}
	if _, _, ok, err := st.AuthenticateCLIToken(ctx, authx.HashToken(raw), 20_100, "203.0.113.9"); err != nil || !ok {
		t.Fatalf("refresh authenticate: ok=%v err=%v", ok, err)
	}
	if err := st.db.QueryRow(`SELECT last_ip,last_ip_observed_at FROM devices WHERE id=?`, d.ID).Scan(&ip, &ipAt); err != nil {
		t.Fatal(err)
	}
	if ip != "203.0.113.9" || ipAt != 20_100 {
		t.Fatalf("refreshed observation ip=%q at=%d", ip, ipAt)
	}
}

func TestConcurrentDeviceIPObservationsCannotMixAddressAndClock(t *testing.T) {
	ctx := context.Background()
	st := newTestStore(t)
	u, _ := st.UpsertUserByEmail(ctx, "ip-atomic@example.test", "IP Atomic")
	d, _ := st.UpsertDevice(ctx, Device{ID: "atomic-device", UserID: u.ID, Name: "CLI", Kind: "cli", CreatedAt: 1})
	raw := "atomic-token"
	hash := authx.HashToken(raw)
	if err := st.CreateCLIToken(ctx, CLIToken{TokenHash: hash, UserID: u.ID, DeviceID: d.ID, CreatedAt: 1}); err != nil {
		t.Fatal(err)
	}

	start := make(chan struct{})
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for _, observation := range []struct {
		at int64
		ip string
	}{{30_000, "198.51.100.30"}, {30_001, "203.0.113.31"}} {
		observation := observation
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, _, ok, err := st.AuthenticateCLIToken(ctx, hash, observation.at, observation.ip)
			if err == nil && !ok {
				err = ErrInvalidToken
			}
			results <- err
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}

	var ip string
	var ipAt int64
	if err := st.db.QueryRow(`SELECT last_ip,last_ip_observed_at FROM devices WHERE id=?`, d.ID).Scan(&ip, &ipAt); err != nil {
		t.Fatal(err)
	}
	if !((ip == "198.51.100.30" && ipAt == 30_000) || (ip == "203.0.113.31" && ipAt == 30_001)) {
		t.Fatalf("mixed observation pair ip=%q at=%d", ip, ipAt)
	}
}

func TestDeviceIPMigrationClearsLegacyOnceAndOldWriterRowsFailClosed(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "legacy-ip.db")
	st, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	u, _ := st.UpsertUserByEmail(ctx, "legacy-ip@example.test", "Legacy")
	d, _ := st.UpsertDevice(ctx, Device{ID: "legacy-ip-device", UserID: u.ID, Name: "CLI", Kind: "cli", CreatedAt: 1})
	if _, err := st.db.Exec(`UPDATE devices SET last_ip='192.0.2.4',last_ip_observed_at=123 WHERE id=?`, d.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.db.Exec(`DELETE FROM schema_migrations WHERE id='clear_legacy_device_ips'`); err != nil {
		t.Fatal(err)
	}
	st.Close()

	st, err = OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	var ip string
	var ipAt int64
	if err := st.db.QueryRow(`SELECT last_ip,last_ip_observed_at FROM devices WHERE id=?`, d.ID).Scan(&ip, &ipAt); err != nil {
		t.Fatal(err)
	}
	if ip != "" || ipAt != 0 {
		t.Fatalf("migration retained legacy ip=%q at=%d", ip, ipAt)
	}
	// A rolling old writer can still fill last_ip while leaving the new column
	// at its default. The recurring pruner must clear that unknowable age.
	if _, err := st.db.Exec(`UPDATE devices SET last_ip='192.0.2.5',last_ip_observed_at=0 WHERE id=?`, d.ID); err != nil {
		t.Fatal(err)
	}
	if err := st.PruneExpiredDeviceIPs(ctx, 500); err != nil {
		t.Fatal(err)
	}
	if err := st.db.QueryRow(`SELECT last_ip,last_ip_observed_at FROM devices WHERE id=?`, d.ID).Scan(&ip, &ipAt); err != nil {
		t.Fatal(err)
	}
	if ip != "" || ipAt != 0 {
		t.Fatalf("old-writer row retained ip=%q at=%d", ip, ipAt)
	}
}

func TestDeviceListPrunesAtBoundaryAndNeverExposesObservationClock(t *testing.T) {
	store := newTestStore(t)
	u, err := store.UpsertUserByEmail(context.Background(), "list-ip@example.test", "List IP")
	if err != nil {
		t.Fatal(err)
	}
	svc := NewService(store, nil, Config{})
	svc.now = func() time.Time { return time.Unix(50_000+deviceIPRetentionSeconds, 0) }
	_, err = store.UpsertDevice(context.Background(), Device{
		ID: "visible-device", UserID: u.ID, Name: "CLI", Kind: "cli", CreatedAt: 1,
		LastIP: "203.0.113.44", LastIPObservedAt: 50_000,
	})
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/devices", nil)
	svc.handleListDevices(rec, req, u)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	encoded := rec.Body.String()
	if containsAny(encoded, "203.0.113.44", "LastIPObservedAt", "last_ip_observed_at") {
		t.Fatalf("device response exposed expired address or clock: %s", encoded)
	}
}

func containsAny(s string, values ...string) bool {
	for _, value := range values {
		if len(value) > 0 && len(s) >= len(value) {
			for i := 0; i+len(value) <= len(s); i++ {
				if s[i:i+len(value)] == value {
					return true
				}
			}
		}
	}
	return false
}
