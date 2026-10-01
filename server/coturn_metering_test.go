package main

import (
	"crypto/sha256"
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
