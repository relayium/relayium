package main

import (
	"context"
	"log"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/relayium/relayium/account"
	"github.com/relayium/relayium/authx"
)

// newPairTestService builds a real account.Service on a temp SQLite file — the
// same constructor main() uses — so the resolver is exercised against the real
// store rather than a stub.
func newPairTestService(t *testing.T) *account.Service {
	t.Helper()
	store, err := account.OpenSQLite(filepath.Join(t.TempDir(), "pair.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return account.NewService(store, &account.LogMailer{Log: log.Default()}, account.Config{
		BaseURL:    "http://example.test",
		SessionTTL: time.Hour,
	})
}

// TestPairUserAcceptsCLIBearer is the regression for the reason a CLI user
// could not obtain a pairing code at all: /api/pair resolved its caller from
// the session cookie only, and the CLI has a bearer token.
func TestPairUserAcceptsCLIBearer(t *testing.T) {
	svc := newPairTestService(t)
	ctx := context.Background()
	u, err := svc.Store().UpsertUserByEmail(ctx, "cli@example.com", "")
	if err != nil {
		t.Fatalf("upsert user: %v", err)
	}
	raw := "rlm_cli_" + authx.RandToken()
	dev, err := svc.Store().UpsertDevice(ctx, account.Device{ID: authx.NewID(), UserID: u.ID, Name: "cli", Kind: "cli", CreatedAt: 1})
	if err != nil {
		t.Fatalf("upsert device: %v", err)
	}
	if err := svc.Store().CreateCLIToken(ctx, account.CLIToken{TokenHash: authx.HashToken(raw), UserID: u.ID, DeviceID: dev.ID, CreatedAt: 1}); err != nil {
		t.Fatalf("create cli token: %v", err)
	}

	resolve := pairUser(svc)

	req := httptest.NewRequest(http.MethodPost, "/api/pair", nil)
	req.Header.Set("Authorization", "Bearer "+raw)
	got, ok := resolve(req)
	if !ok || got != u.ID {
		t.Fatalf("bearer: ok=%v id=%q want %q", ok, got, u.ID)
	}

	if _, ok := resolve(httptest.NewRequest(http.MethodPost, "/api/pair", nil)); ok {
		t.Fatal("anonymous request must not resolve an owner")
	}
}
