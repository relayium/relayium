package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/relayium/relayium/account"
	"github.com/relayium/relayium/authx"
	"github.com/relayium/relayium/internal/signal"
)

// That the B3 gate is actually WIRED, on the route it has to be wired on.
//
// The evaluator and the handler contract are pinned in their own packages
// (account/pairmint_test.go, internal/signal/pairhttp_test.go); what neither can
// see is main.go's one line of assembly. An unwired gate is the whole feature
// missing while every unit test stays green, and the route it is missing from is
// the AUTHORITATIVE one — the choose screen's preflight is advisory, and a CLI or
// bearer client never asks it at all.

// pairMux builds POST /api/pair exactly as main.go does, over a real account
// service and a real pairing registry.
func pairMux(t *testing.T, svc *account.Service) (*http.ServeMux, *signal.PairRegistry) {
	t.Helper()
	reg := signal.NewPairRegistry(signal.CodeTTLSeconds, func() int64 { return time.Now().Unix() })
	rl := signal.NewRateLimiter(100, time.Minute, func() int64 { return time.Now().Unix() })
	mux := http.NewServeMux()
	mux.Handle("POST /api/pair", svc.CSRFGuard(
		signal.PairHandler(reg, rl, signal.NewIPExtractor(nil), pairUser(svc), svc.PairMintRefusal)))
	return mux, reg
}

// bearerFor gives `email` a CLI token, which is how a non-browser client mints —
// the path a client-side preflight can never stand in front of.
func bearerFor(t *testing.T, svc *account.Service, email string) (string, string) {
	t.Helper()
	ctx := context.Background()
	u, err := svc.Store().UpsertUserByEmail(ctx, email, "")
	if err != nil {
		t.Fatalf("upsert user: %v", err)
	}
	raw := "rlm_cli_" + authx.RandToken()
	dev, err := svc.Store().UpsertDevice(ctx, account.Device{
		ID: authx.NewID(), UserID: u.ID, Name: "cli", Kind: "cli", CreatedAt: 1})
	if err != nil {
		t.Fatalf("upsert device: %v", err)
	}
	if err := svc.Store().CreateCLIToken(ctx, account.CLIToken{
		TokenHash: authx.HashToken(raw), UserID: u.ID, DeviceID: dev.ID, CreatedAt: 1}); err != nil {
		t.Fatalf("create cli token: %v", err)
	}
	return u.ID, raw
}

func postPair(t *testing.T, mux *http.ServeMux, bearer string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/pair", nil)
	req.Header.Set("Authorization", "Bearer "+bearer)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	var body map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	return rec.Code, body
}

// spendMonthlyTraffic puts the account past its combined monthly allowance.
//
// By billing far more than any tier grants rather than by shrinking the tier:
// a mid-month plan change prorates the cap (monthlyTrafficCap), which would make
// the arithmetic here depend on what day the suite runs. This account stays on
// the plan it was created with — the Free fallback, 1 GiB — and is simply well
// past it.
func spendMonthlyTraffic(t *testing.T, svc *account.Service, userID string) {
	t.Helper()
	const wayPastAnyTier = int64(4) << 40 // 4 TiB
	if err := svc.Store().RecordMeter(context.Background(), userID, account.MeterUpload,
		wayPastAnyTier, time.Now().Unix()); err != nil {
		t.Fatalf("record meter: %v", err)
	}
}

// A bearer client — no browser, no preflight, nothing but the POST — is refused,
// and no code is allocated for it.
func TestBearerMintIsRefusedWhenTheMonthlyAllowanceIsSpent(t *testing.T) {
	svc := newPairTestService(t)
	mux, reg := pairMux(t, svc)
	userID, bearer := bearerFor(t, svc, "spent@example.com")
	spendMonthlyTraffic(t, svc, userID)

	status, body := postPair(t, mux, bearer)
	if status != http.StatusTooManyRequests {
		t.Fatalf("mint while out of allowance = %d, want 429", status)
	}
	if body["error"] != account.PairMintTrafficSpent {
		t.Fatalf("refusal body = %+v, want a stable %q code", body, account.PairMintTrafficSpent)
	}
	if body["code"] != nil {
		t.Fatalf("a refused mint still handed out %v", body["code"])
	}
	if got, ok := reg.OwnerOf(""); ok {
		t.Fatalf("registry resolved an empty code to %q", got)
	}
}

// And the old success shape is untouched for everybody else.
func TestAnAdmittedMintStillAnswersCodeAndExpiresAt(t *testing.T) {
	svc := newPairTestService(t)
	mux, reg := pairMux(t, svc)
	userID, bearer := bearerFor(t, svc, "fine@example.com")

	status, body := postPair(t, mux, bearer)
	if status != 200 {
		t.Fatalf("mint = %d, want 200", status)
	}
	code, _ := body["code"].(string)
	exp, _ := body["expiresAt"].(float64)
	if len(code) != signal.CodeLen || exp <= 0 {
		t.Fatalf("mint body = %+v, want a %d-digit code and an expiresAt", body, signal.CodeLen)
	}
	if owner, ok := reg.OwnerOf(code); !ok || owner != userID {
		t.Fatalf("minted code owner = (%q,%v), want %q", owner, ok, userID)
	}
}
