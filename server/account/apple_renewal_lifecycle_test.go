package account

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestAppleRenewalInfoIsIndependentlyVerifiedAndBoundToTransaction(t *testing.T) {
	chain := newAppleTestChain(t)
	v := testVerifier(t, chain)
	now := time.Now()
	tx, err := v.Verify(chain.sign(t, applePayload(func(p map[string]any) {
		p["appAccountToken"] = "73f2ef7a-7203-4ccb-9cb4-fbfbf4561925"
	})), now)
	if err != nil {
		t.Fatal(err)
	}
	renewal := func(original string) string {
		return chain.sign(t, map[string]any{
			"originalTransactionId": original, "autoRenewProductId": tx.ProductID,
			"environment": tx.Environment, "signedDate": now.UnixMilli(),
		})
	}
	if _, err := v.VerifyRenewalInfo(renewal(tx.OriginalTransactionID), tx, now); err != nil {
		t.Fatal(err)
	}
	if _, err := v.VerifyRenewalInfo(renewal("9999999999999999"), tx, now); err == nil {
		t.Fatal("mismatched renewal identity accepted")
	}
}

func TestAppleGraceIsBoundedAndNeverResurrectsTerminalTransaction(t *testing.T) {
	now := time.Unix(2_000_000_000, 0)
	tx := VerifiedAppleTransaction{OriginalTransactionID: "1", BundleID: testBundleIOS,
		ProductID: testAppleProduct, Environment: appleEnvProduction, ExpiresDateMS: now.Add(-time.Hour).UnixMilli()}
	product := AppleProduct{PlanID: "pro", Cycle: "monthly"}
	renewal := AppleRenewalState{UserID: "u", IsInBillingRetry: true, GraceUntil: now.Add(time.Hour).Unix()}
	if got := appleSourceEventWithRenewal("u", tx, product, renewal, now); got.PlanID != "pro" || got.PeriodEnd != renewal.GraceUntil {
		t.Fatalf("active grace = %+v", got)
	}
	if got := appleSourceEventWithRenewal("u", tx, product, renewal, now.Add(2*time.Hour)); got.PlanID != "free" {
		t.Fatalf("expired grace resurrected: %+v", got)
	}
	tx.RevocationDateMS = now.Add(-time.Minute).UnixMilli()
	if got := appleSourceEventWithRenewal("u", tx, product, renewal, now); got.PlanID != "free" {
		t.Fatalf("revoked transaction resurrected: %+v", got)
	}
}

func TestAppleRenewalProjectionRejectsOutOfOrderState(t *testing.T) {
	store, err := OpenSQLite(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx := context.Background()
	user, err := store.UpsertUserByEmail(ctx, "renewal-order@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	newer := AppleRenewalState{UserID: user.ID, ExternalID: "Production:1", BundleID: testBundleIOS, CurrentProductID: "pro.m", AutoRenewProductID: "pro.y", EventAt: 20, UpdatedAt: 20}
	if applied, err := store.ApplyAppleRenewalState(ctx, newer); err != nil || !applied {
		t.Fatalf("newer: %v %v", applied, err)
	}
	older := newer
	older.AutoRenewProductID = "plus.m"
	older.EventAt = 10
	if applied, err := store.ApplyAppleRenewalState(ctx, older); err != nil || applied {
		t.Fatalf("older: %v %v", applied, err)
	}
	got, ok, err := store.GetAppleRenewalState(ctx, user.ID)
	if err != nil || !ok || got.AutoRenewProductID != "pro.y" {
		t.Fatalf("state: %+v %v %v", got, ok, err)
	}
}

func TestApplePurchaseFailsClosedWithoutCanonicalReconciler(t *testing.T) {
	f := newAppleTxFixture(t)
	f.svc.SetAppleSubscriptionReconciler(nil)
	f.mustReject(t, f.chain.sign(t, f.payload()), 503, "reconciliation_unavailable")
	if _, ok := f.appleSource(t); ok {
		t.Fatal("entitlement granted without canonical App Store status")
	}
}

func TestAppleServerAPISelectsOnlyCanonicalMatchingSubscription(t *testing.T) {
	chain := newAppleTestChain(t)
	verifier := testVerifier(t, chain)
	now := time.Now().UTC().Truncate(time.Second)
	submittedJWS := chain.sign(t, applePayload(func(p map[string]any) {
		p["appAccountToken"] = "73f2ef7a-7203-4ccb-9cb4-fbfbf4561925"
		p["signedDate"] = now.Add(-time.Minute).UnixMilli()
	}))
	submitted, err := verifier.Verify(submittedJWS, now)
	if err != nil {
		t.Fatal(err)
	}
	canonicalJWS := chain.sign(t, applePayload(func(p map[string]any) {
		p["appAccountToken"] = "73f2ef7a-7203-4ccb-9cb4-fbfbf4561925"
		p["signedDate"] = now.UnixMilli()
	}))
	renewalJWS := chain.sign(t, map[string]any{
		"originalTransactionId": submitted.OriginalTransactionID,
		"autoRenewProductId":    submitted.ProductID,
		"environment":           submitted.Environment,
		"signedDate":            now.UnixMilli(),
	})
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "" {
			t.Error("missing App Store API bearer")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{
			"lastTransactions": []any{map[string]any{
				"signedTransactionInfo": canonicalJWS, "signedRenewalInfo": renewalJWS,
			}},
		}}})
	}))
	defer server.Close()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	client, err := NewAppleServerAPIClient(AppleServerAPIConfig{
		IssuerID: "issuer", KeyID: "key", PrivateKey: key, HTTP: server.Client(),
		ProductionURL: server.URL, SandboxURL: server.URL,
	}, verifier)
	if err != nil {
		t.Fatal(err)
	}
	got, err := client.CanonicalSubscription(context.Background(), submitted, now)
	if err != nil {
		t.Fatal(err)
	}
	if got.Transaction.SignedDateMS != now.UnixMilli() || got.Renewal.OriginalTransactionID != submitted.OriginalTransactionID {
		t.Fatalf("noncanonical result: %+v", got)
	}
}
