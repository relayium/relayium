package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"log"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/relayium/relayium/account"
	coturnwire "github.com/relayium/relayium/internal/coturnbridge/wire"
)

func coturnTestService(t *testing.T) *account.Service {
	t.Helper()
	store, err := account.OpenSQLite(filepath.Join(t.TempDir(), "cm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	return account.NewService(store, &account.LogMailer{Log: log.Default()}, account.Config{})
}

// The F02 route is opt-in, fails closed on misconfiguration, and is not the
// retired -redis-addr ingest (that guard stays inert, see
// redis_metering_guard_test.go).
func TestCoturnMeteringRouteConfig(t *testing.T) {
	acct := coturnTestService(t)
	sum := sha256.Sum256([]byte("tok"))
	relays := "coturn-central=" + hex.EncodeToString(sum[:])

	if h, err := coturnMeteringRoute(acct, "", account.CoturnMeteringShadow, 0); h != nil || err != nil {
		t.Fatalf("unset relays must disable the route: %v %v", h, err)
	}
	for _, bad := range []struct{ relays, mode string }{
		{"coturn-central=nothex", account.CoturnMeteringShadow},
		{relays, "bogus"},
		{relays, account.CoturnMeteringBillable}, // no billable-since
	} {
		if h, err := coturnMeteringRoute(acct, bad.relays, bad.mode, 0); err == nil || h != nil {
			t.Fatalf("%+v accepted", bad)
		}
	}
	h, err := coturnMeteringRoute(acct, relays, account.CoturnMeteringShadow, 0)
	if err != nil || h == nil {
		t.Fatalf("shadow route: %v", err)
	}

	// Registered as in main: the specific route wins over the /api/ catch-all,
	// and the fleet node token is not a metering identity.
	mux := http.NewServeMux()
	mux.Handle("POST "+coturnwire.Path, h)
	mux.Handle("/api/", acct.Routes())
	for _, c := range []struct {
		method, auth string
		want         int
	}{
		{http.MethodPost, "", http.StatusUnauthorized},
		{http.MethodPost, "Bearer wrong", http.StatusUnauthorized},
		{http.MethodPost, "Bearer tok", http.StatusBadRequest}, // authenticated, empty body
	} {
		req := httptest.NewRequest(c.method, coturnwire.Path, strings.NewReader(""))
		if c.auth != "" {
			req.Header.Set("Authorization", c.auth)
		}
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != c.want {
			t.Fatalf("%s %q: %d, want %d", c.method, c.auth, rec.Code, c.want)
		}
	}
}

// coturnBillableBinding opens a file-backed store, creates one billable
// binding of 1000 B for a fresh user, and returns the store, its path and
// the bound snapshot.
func coturnBillableBinding(t *testing.T) (*account.SQLiteStore, string, coturnwire.Snapshot) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "cm.db")
	store, err := account.OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	ctx := context.Background()
	u, err := store.UpsertUserByEmail(ctx, "startup@example.com", "")
	if err != nil {
		t.Fatal(err)
	}
	snap := coturnwire.Snapshot{
		Version: coturnwire.Version, RelayID: "coturn-central", BootID: "8f9c0d4e-1111-4a2b-9c3d-000000000001", PID: 7, StartTicks: 77,
		SessionID: "001000000000000001", Username: "1790000000:" + u.ID + ".g1", Seq: 1, StreamSum: 1000,
		State: coturnwire.StateLive, FirstObservedUnix: 2000, CreatedUnix: 2001,
	}
	snap.Seal()
	out, err := store.ApplyCoturnSnapshot(ctx, account.CoturnSnapshotApply{
		RelayID: "coturn-central", Snapshot: snap, UsernameHash: "h", UserID: u.ID, Token: "g1",
		Now: 3000, Billable: true, BillableSince: 1000,
	})
	if err != nil || out.Ledger != coturnwire.LedgerBillable || out.Accepted != 1000 {
		t.Fatalf("setup binding: %+v %v", out, err)
	}
	return store, path, snap
}

func coturnLedger(t *testing.T, store *account.SQLiteStore) string {
	t.Helper()
	bs, err := store.CoturnBindings(context.Background())
	if err != nil || len(bs) != 1 {
		t.Fatalf("bindings: %v %v", bs, err)
	}
	return bs[0].Ledger
}

// Money: the route's startup is where a non-billable period begins. With the
// ingest disabled (no relays, whatever the mode flags say) or in shadow mode,
// every billable binding is demoted before the route returns; an invalid
// relay list is refused before anything is written; a billable route demotes
// nothing.
func TestCoturnMeteringRouteNonBillableStartupDemotes(t *testing.T) {
	sum := sha256.Sum256([]byte("tok"))
	relays := "coturn-central=" + hex.EncodeToString(sum[:])
	for _, tc := range []struct {
		name, relays, mode string
		since              int64
		wantHandler        bool
		wantErr            bool
		wantLedger         string
	}{
		{"disabled", "", account.CoturnMeteringShadow, 0, false, false, coturnwire.LedgerShadow},
		{"disabled, blank", "  ", account.CoturnMeteringShadow, 0, false, false, coturnwire.LedgerShadow},
		{"disabled, billable flags", "", account.CoturnMeteringBillable, 1000, false, false, coturnwire.LedgerShadow},
		{"shadow", relays, account.CoturnMeteringShadow, 0, true, false, coturnwire.LedgerShadow},
		{"billable", relays, account.CoturnMeteringBillable, 1000, true, false, coturnwire.LedgerBillable},
		{"unparseable relays", "coturn-central=nothex", account.CoturnMeteringShadow, 0, false, true, coturnwire.LedgerBillable},
		{"bogus mode", relays, "bogus", 0, false, true, coturnwire.LedgerBillable},
		{"billable without since", relays, account.CoturnMeteringBillable, 0, false, true, coturnwire.LedgerBillable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store, _, _ := coturnBillableBinding(t)
			acct := account.NewService(store, &account.LogMailer{Log: log.Default()}, account.Config{})
			h, err := coturnMeteringRoute(acct, tc.relays, tc.mode, tc.since)
			if (h != nil) != tc.wantHandler || (err != nil) != tc.wantErr {
				t.Fatalf("route: handler %v err %v", h, err)
			}
			if got := coturnLedger(t, store); got != tc.wantLedger {
				t.Fatalf("binding ledger %q, want %q", got, tc.wantLedger)
			}
		})
	}
}

// A demotion failure refuses startup on both non-billable branches: a real
// SQLite trigger aborts the UPDATE, the route returns an error and no
// handler, and the binding is still billable. Dropping the trigger lets the
// same startup demote it.
func TestCoturnMeteringRouteDemotionFailureRefusesStartup(t *testing.T) {
	sum := sha256.Sum256([]byte("tok"))
	relays := "coturn-central=" + hex.EncodeToString(sum[:])
	for _, r := range []string{"", relays} {
		store, path, _ := coturnBillableBinding(t)
		acct := account.NewService(store, &account.LogMailer{Log: log.Default()}, account.Config{})
		side, err := sql.Open("sqlite", path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := side.Exec(`CREATE TRIGGER cm_inject BEFORE UPDATE OF ledger ON coturn_metering_bindings
			BEGIN SELECT RAISE(ABORT, 'injected demotion failure'); END`); err != nil {
			t.Fatal(err)
		}
		h, err := coturnMeteringRoute(acct, r, account.CoturnMeteringShadow, 0)
		if h != nil || err == nil || !strings.Contains(err.Error(), "injected demotion failure") {
			t.Fatalf("relays %q: handler %v err %v", r, h, err)
		}
		if got := coturnLedger(t, store); got != coturnwire.LedgerBillable {
			t.Fatalf("relays %q: ledger %q after a failed demotion", r, got)
		}
		if _, err := side.Exec(`DROP TRIGGER cm_inject`); err != nil {
			t.Fatal(err)
		}
		side.Close()
		if _, err := coturnMeteringRoute(acct, r, account.CoturnMeteringShadow, 0); err != nil {
			t.Fatalf("relays %q: control: %v", r, err)
		}
		if got := coturnLedger(t, store); got != coturnwire.LedgerShadow {
			t.Fatalf("relays %q: control ledger %q", r, got)
		}
		// A closed database refuses the disabled branch too.
		store.Close()
		if _, err := coturnMeteringRoute(acct, r, account.CoturnMeteringShadow, 0); err == nil {
			t.Fatalf("relays %q: closed database accepted", r)
		}
	}
}
