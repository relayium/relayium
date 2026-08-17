package account

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type appleSweepFact struct{ value AppleSubscriptionCanonical }

func (f *appleSweepFact) CanonicalSubscription(context.Context, VerifiedAppleTransaction, time.Time) (AppleSubscriptionCanonical, error) {
	return f.value, nil
}
func (f *appleSweepFact) CanonicalSubscriptionByIdentity(context.Context, AppleSubscriptionIdentity, time.Time) (AppleSubscriptionCanonical, error) {
	return f.value, nil
}

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
			"appAccountToken": tx.AppAccountToken, "autoRenewStatus": 1,
			"environment": tx.Environment, "signedDate": now.UnixMilli(),
		})
	}
	if _, err := v.VerifyRenewalInfo(renewal(tx.OriginalTransactionID), tx, now); err != nil {
		t.Fatal(err)
	}
	upperToken := chain.sign(t, map[string]any{"originalTransactionId": tx.OriginalTransactionID, "autoRenewProductId": tx.ProductID, "appAccountToken": strings.ToUpper(tx.AppAccountToken), "environment": tx.Environment, "signedDate": now.UnixMilli()})
	if _, err := v.VerifyRenewalInfo(upperToken, tx, now); err != nil {
		t.Fatalf("UUID casing rejected: %v", err)
	}
	if _, err := v.VerifyRenewalInfo(renewal("9999999999999999"), tx, now); err == nil {
		t.Fatal("mismatched renewal identity accepted")
	}
	badToken := chain.sign(t, map[string]any{"originalTransactionId": tx.OriginalTransactionID, "autoRenewProductId": tx.ProductID, "appAccountToken": "00000000-0000-0000-0000-000000000000", "environment": tx.Environment, "signedDate": now.UnixMilli()})
	if _, err := v.VerifyRenewalInfo(badToken, tx, now); err == nil {
		t.Fatal("mismatched renewal account token accepted")
	}
}

func TestAppleGraceRejectsUnboundedAndNonRetryRenewal(t *testing.T) {
	chain := newAppleTestChain(t)
	v := testVerifier(t, chain)
	now := time.Now().UTC()
	tx, err := v.Verify(chain.sign(t, applePayload(func(p map[string]any) { p["appAccountToken"] = "73f2ef7a-7203-4ccb-9cb4-fbfbf4561925" })), now)
	if err != nil {
		t.Fatal(err)
	}
	sign := func(retry bool, grace time.Time) string {
		return chain.sign(t, map[string]any{"originalTransactionId": tx.OriginalTransactionID, "autoRenewProductId": tx.ProductID, "autoRenewStatus": 1, "environment": tx.Environment, "isInBillingRetryPeriod": retry, "gracePeriodExpiresDate": grace.UnixMilli(), "signedDate": now.UnixMilli()})
	}
	for _, jws := range []string{sign(false, now.Add(time.Hour)), sign(true, time.UnixMilli(tx.ExpiresDateMS).Add(29*24*time.Hour))} {
		r, err := v.VerifyRenewalInfo(jws, tx, now)
		if err != nil {
			t.Fatal(err)
		}
		if r.GracePeriodExpiresMS != 0 {
			t.Fatalf("unbounded grace accepted: %+v", r)
		}
	}
}

func TestAppleAutoRenewOffDoesNotCancelASignedBillingGracePeriod(t *testing.T) {
	chain := newAppleTestChain(t)
	v := testVerifier(t, chain)
	now := time.Now().UTC()
	tx, err := v.Verify(chain.sign(t, applePayload()), now)
	if err != nil {
		t.Fatal(err)
	}
	jws := chain.sign(t, map[string]any{"originalTransactionId": tx.OriginalTransactionID, "autoRenewProductId": "", "autoRenewStatus": 0, "environment": tx.Environment, "isInBillingRetryPeriod": true, "gracePeriodExpiresDate": time.UnixMilli(tx.ExpiresDateMS).Add(time.Hour).UnixMilli(), "expirationIntent": 1, "priceIncreaseStatus": 0, "signedDate": now.UnixMilli()})
	r, err := v.VerifyRenewalInfo(jws, tx, now)
	if err != nil {
		t.Fatal(err)
	}
	state := appleRenewalState("u", tx, r, now)
	if r.AutoRenewEnabled || r.AutoRenewProductID != "" || !state.graceActive(now) {
		t.Fatalf("auto-renew-off misprojected: %+v", r)
	}
}

func TestAppleGraceIsBoundedAndNeverResurrectsTerminalTransaction(t *testing.T) {
	now := time.Unix(2_000_000_000, 0)
	tx := VerifiedAppleTransaction{OriginalTransactionID: "1", BundleID: testBundleIOS,
		ProductID: testAppleProduct, Environment: appleEnvProduction, ExpiresDateMS: now.Add(-time.Hour).UnixMilli()}
	product := AppleProduct{PlanID: "pro", Cycle: "monthly"}
	renewal := AppleRenewalState{UserID: "u", AutoRenewEnabled: true, IsInBillingRetry: true, GraceUntil: now.Add(time.Hour).Unix()}
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

func TestApplePurchaseAllowsMissingSubmittedRenewalWhenCanonicalExists(t *testing.T) {
	f := newAppleTxFixture(t)
	jws := f.chain.sign(t, f.payload())
	resp := f.post(t, f.cookie, string(mustJSON(t, map[string]string{"signedTransactionInfo": jws, "signedRenewalInfo": ""})))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status=%d body=%s", resp.StatusCode, body)
	}
}

func TestAppleCanonicalTokenDriftFailsClosedWithoutWrite(t *testing.T) {
	f := newAppleTxFixture(t)
	f.svc.SetAppleSubscriptionReconciler(appleReconcilerFunc(func(_ context.Context, tx VerifiedAppleTransaction, now time.Time) (AppleSubscriptionCanonical, error) {
		tx.AppAccountToken = mustNewAppAccountToken(t)
		return AppleSubscriptionCanonical{Transaction: tx, Renewal: VerifiedAppleRenewalInfo{OriginalTransactionID: tx.OriginalTransactionID, AutoRenewProductID: tx.ProductID, Environment: tx.Environment, SignedDateMS: now.UnixMilli()}}, nil
	}))
	f.mustReject(t, f.chain.sign(t, f.payload()), http.StatusServiceUnavailable, "reconciliation_unavailable")
	if _, ok := f.appleSource(t); ok {
		t.Fatal("canonical token drift wrote entitlement")
	}
}

func TestAppleLocalClockLapsesAndNewerRenewalRestores(t *testing.T) {
	store, err := OpenSQLite(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx := context.Background()
	u, err := store.UpsertUserByEmail(ctx, "clock-lapse@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	now := int64(2_000_000_000)
	ev := SourceEvent{UserID: u.ID, Provider: ProviderApple, PlanID: "pro", Status: "active", Cycle: "monthly", PeriodEnd: now - 1, ExternalID: "1", ExternalScope: testBundleIOS, EventAt: 10, Now: now - 100}
	ren := AppleRenewalState{UserID: u.ID, ExternalID: "1", BundleID: testBundleIOS, CurrentProductID: "pro.m", AutoRenewProductID: "pro.m", AutoRenewEnabled: true, EventAt: 10, UpdatedAt: now - 100}
	if _, err = store.ApplyAppleLifecycle(ctx, ev, ren); err != nil {
		t.Fatal(err)
	}
	if err = store.LapseAppleSubscription(ctx, u.ID, now); err != nil {
		t.Fatal(err)
	}
	got, err := store.GetUserByID(ctx, u.ID)
	if err != nil || got.PlanID != "free" {
		t.Fatalf("missed expiry still grants: %+v %v", got, err)
	}
	ev.PlanID = "pro"
	ev.Status = "active"
	ev.PeriodEnd = now + 3600
	ev.EventAt = 12
	ev.Now = now + 1
	ren.EventAt = 12
	if _, err = store.ApplyAppleLifecycle(ctx, ev, ren); err != nil {
		t.Fatal(err)
	}
	got, err = store.GetUserByID(ctx, u.ID)
	if err != nil || got.PlanID != "pro" {
		t.Fatalf("renewal did not restore: %+v %v", got, err)
	}
}

func TestAppleDerivedLapsePreservesRealProviderClockOrdering(t *testing.T) {
	store, err := OpenSQLite(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "clock-order@example.test", "")
	now := time.Unix(2_000_000_000, 0)
	tx := VerifiedAppleTransaction{OriginalTransactionID: "clock-1", BundleID: testBundleIOS, ProductID: testAppleProduct, Environment: appleEnvProduction, PurchaseDateMS: now.Add(-time.Hour).UnixMilli(), ExpiresDateMS: now.Add(-time.Second).UnixMilli()}
	product := AppleProduct{PlanID: "pro", Cycle: "monthly"}
	initial := appleSourceEvent(u.ID, tx, product, now.Add(-2*time.Second))
	if initial.EventAt != appleEventClock(tx) {
		t.Fatal("test is not using real Apple clock")
	}
	if _, err = store.ApplySubscriptionSource(ctx, initial); err != nil {
		t.Fatal(err)
	}
	if err = store.LapseAppleSubscription(ctx, u.ID, now.Unix()); err != nil {
		t.Fatal(err)
	}
	src, _, _ := store.GetSubscriptionSource(ctx, u.ID, ProviderApple)
	if src.EventAt != appleEventClock(tx) {
		t.Fatalf("derived lapse advanced provider clock: %d", src.EventAt)
	}
	grace := AppleRenewalState{UserID: u.ID, ExternalID: src.ExternalID, BundleID: testBundleIOS, CurrentProductID: testAppleProduct, AutoRenewProductID: testAppleProduct, IsInBillingRetry: true, GraceUntil: now.Add(time.Hour).Unix(), EventAt: now.Unix(), UpdatedAt: now.Unix()}
	if _, err = store.ApplyAppleLifecycle(ctx, appleSourceEventWithRenewal(u.ID, tx, product, grace, now), grace); err != nil {
		t.Fatal(err)
	}
	got, _ := store.GetUserByID(ctx, u.ID)
	if got.PlanID != "pro" {
		t.Fatalf("same-generation canonical grace did not restore: %+v", got)
	}
	if _, err = store.ApplySubscriptionSource(ctx, appleSourceEvent(u.ID, tx, product, now)); err != nil {
		t.Fatal(err)
	}
	got, _ = store.GetUserByID(ctx, u.ID)
	if got.PlanID != "free" {
		t.Fatalf("expired JWS replay resurrected: %+v", got)
	}
	refund := tx
	refund.RevocationDateMS = now.UnixMilli()
	if _, err = store.ApplySubscriptionSource(ctx, appleSourceEvent(u.ID, refund, product, now)); err != nil {
		t.Fatal(err)
	}
	if _, err = store.ApplySubscriptionSource(ctx, appleSourceEventWithRenewal(u.ID, tx, product, grace, now)); err != nil {
		t.Fatal(err)
	}
	got, _ = store.GetUserByID(ctx, u.ID)
	if got.PlanID != "free" {
		t.Fatalf("live same-generation JWS beat refund terminal: %+v", got)
	}
}

func TestAppleOlderSameGenerationRenewalCannotDropDurableGrace(t *testing.T) {
	now := time.Unix(2_000_000_000, 0)
	tx := VerifiedAppleTransaction{OriginalTransactionID: "renewal-order", BundleID: testBundleIOS, ProductID: testAppleProduct, Environment: appleEnvProduction, PurchaseDateMS: now.Add(-time.Hour).UnixMilli(), ExpiresDateMS: now.Add(-time.Second).UnixMilli()}
	external, _ := appleSubscriptionKeyOf(tx).externalID()
	newer := AppleRenewalState{UserID: "u", ExternalID: external, BundleID: testBundleIOS, CurrentProductID: testAppleProduct, AutoRenewProductID: testAppleProduct, IsInBillingRetry: true, GraceUntil: now.Add(time.Hour).Unix(), EventAt: 20}
	older := newer
	older.IsInBillingRetry = false
	older.GraceUntil = 0
	older.EventAt = 10
	chosen, ok := preferDurableAppleRenewal(newer, true, older, tx)
	if !ok || !chosen.graceActive(now) {
		t.Fatalf("older renewal displaced grace: %+v", chosen)
	}
	mismatch := newer
	mismatch.ExternalID = "other"
	if _, ok := preferDurableAppleRenewal(mismatch, true, older, tx); ok {
		t.Fatal("cross-subscription renewal merged")
	}
	mismatch = newer
	mismatch.BundleID = "other.bundle"
	if _, ok := preferDurableAppleRenewal(mismatch, true, older, tx); ok {
		t.Fatal("cross-bundle renewal merged")
	}
	for _, terminal := range []VerifiedAppleTransaction{func() VerifiedAppleTransaction { x := tx; x.RevocationDateMS = now.UnixMilli(); return x }(), func() VerifiedAppleTransaction { x := tx; x.IsUpgraded = true; return x }()} {
		ev := appleSourceEventWithRenewal("u", terminal, AppleProduct{PlanID: "pro", Cycle: "monthly"}, chosen, now)
		if ev.PlanID != "free" || ev.Status != "canceled" {
			t.Fatalf("terminal resurrected by renewal: %+v", ev)
		}
	}
}

func TestApplePendingReplayPreservesCurrentGenerationGrace(t *testing.T) {
	_, svc, store, _ := newBillingServer(t)
	ctx := context.Background()
	if err := svc.SeedPlans(ctx); err != nil {
		t.Fatal(err)
	}
	now := time.Unix(2_000_000_000, 0)
	svc.now = func() time.Time { return now }
	u, _ := store.UpsertUserByEmail(ctx, "pending-grace@example.test", "")
	if err := store.UpsertAppleProduct(ctx, AppleProduct{BundleID: testBundleIOS, ProductID: testAppleProduct, PlanID: "pro", Cycle: "monthly", Active: true, UpdatedAt: 1}); err != nil {
		t.Fatal(err)
	}
	tx := VerifiedAppleTransaction{OriginalTransactionID: "pending-grace", BundleID: testBundleIOS, ProductID: testAppleProduct, Environment: appleEnvProduction, PurchaseDateMS: now.Add(-time.Hour).UnixMilli(), ExpiresDateMS: now.Add(-time.Second).UnixMilli()}
	external, _ := appleSubscriptionKeyOf(tx).externalID()
	renewal := AppleRenewalState{UserID: u.ID, ExternalID: external, BundleID: testBundleIOS, CurrentProductID: testAppleProduct, AutoRenewProductID: testAppleProduct, IsInBillingRetry: true, GraceUntil: now.Add(time.Hour).Unix(), EventAt: 20, UpdatedAt: now.Unix()}
	if _, err := store.ApplyAppleLifecycle(ctx, appleSourceEventWithRenewal(u.ID, tx, AppleProduct{PlanID: "pro", Cycle: "monthly"}, renewal, now), renewal); err != nil {
		t.Fatal(err)
	}
	uuid := "9f0b2e3a-1c4d-4e5f-8a9b-000000000099"
	if _, _, err := store.ClaimAppleNotification(ctx, AppleNotificationRecord{UUID: uuid, Type: "DID_RENEW", ReceivedAt: now.Unix(), Supported: true, Projection: appleNotificationProjection(tx)}); err != nil {
		t.Fatal(err)
	}
	if err := store.SetAppleNotificationState(ctx, uuid, appleNotificationPending, now.Unix()); err != nil {
		t.Fatal(err)
	}
	svc.reconcileApplePendingNotifications(ctx, u.ID, appleSubscriptionKeyOf(tx), now)
	src, ok, err := store.GetSubscriptionSource(ctx, u.ID, ProviderApple)
	if err != nil || !ok || !src.grantsAccess() || src.PeriodEnd != renewal.GraceUntil {
		t.Fatalf("pending replay dropped grace: %+v ok=%v err=%v", src, ok, err)
	}
}

func TestAppleLifecycleConflictDoesNotPolluteRenewalState(t *testing.T) {
	store, err := OpenSQLite(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx := context.Background()
	a, _ := store.UpsertUserByEmail(ctx, "owner-a@example.test", "")
	b, _ := store.UpsertUserByEmail(ctx, "owner-b@example.test", "")
	ev := SourceEvent{UserID: a.ID, Provider: ProviderApple, PlanID: "pro", Status: "active", PeriodEnd: 300, ExternalID: "shared", ExternalScope: testBundleIOS, EventAt: 10, Now: 100}
	ren := AppleRenewalState{UserID: a.ID, ExternalID: "shared", BundleID: testBundleIOS, CurrentProductID: "pro.m", AutoRenewProductID: "pro.y", AutoRenewEnabled: true, EventAt: 10, UpdatedAt: 100}
	if _, err = store.ApplyAppleLifecycle(ctx, ev, ren); err != nil {
		t.Fatal(err)
	}
	ev.UserID = b.ID
	ren.UserID = b.ID
	if _, err = store.ApplyAppleLifecycle(ctx, ev, ren); !errors.Is(err, ErrExternalSubscriptionOwned) {
		t.Fatalf("conflict=%v", err)
	}
	if _, ok, err := store.GetAppleRenewalState(ctx, b.ID); err != nil || ok {
		t.Fatalf("conflict polluted renewal: ok=%v err=%v", ok, err)
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
	mismatchedJWS := chain.sign(t, applePayload(func(p map[string]any) { p["originalTransactionId"] = "other-subscription" }))
	renewalJWS := chain.sign(t, map[string]any{
		"originalTransactionId": submitted.OriginalTransactionID,
		"autoRenewProductId":    submitted.ProductID,
		"environment":           submitted.Environment,
		"signedDate":            now.UnixMilli(),
	})
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if auth == "" {
			t.Error("missing App Store API bearer")
		}
		if r.URL.Path != "/inApps/v1/subscriptions/"+submitted.OriginalTransactionID {
			t.Errorf("path=%s", r.URL.Path)
		}
		parsed, _, err := new(jwt.Parser).ParseUnverified(auth, jwt.MapClaims{})
		if err != nil {
			t.Error(err)
		} else {
			claims := parsed.Claims.(jwt.MapClaims)
			if claims["bid"] != submitted.BundleID || claims["aud"] != "appstoreconnect-v1" {
				t.Errorf("claims=%v", claims)
			}
			if parsed.Header["kid"] != "key" {
				t.Errorf("kid=%v", parsed.Header["kid"])
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{
			"lastTransactions": []any{map[string]any{"signedTransactionInfo": mismatchedJWS, "signedRenewalInfo": renewalJWS}, map[string]any{
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

func TestAppleServerAPIFailsClosedOnNon200AndUsesSandboxRoute(t *testing.T) {
	chain := newAppleTestChain(t)
	verifier := testVerifier(t, chain)
	now := time.Now().UTC()
	tx, err := verifier.Verify(chain.sign(t, applePayload(func(p map[string]any) { p["environment"] = appleEnvSandbox })), now)
	if err != nil {
		t.Fatal(err)
	}
	prodHits, sandboxHits := 0, 0
	prod := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { prodHits++ }))
	defer prod.Close()
	sandbox := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sandboxHits++
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
	}))
	defer sandbox.Close()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	client, err := NewAppleServerAPIClient(AppleServerAPIConfig{IssuerID: "issuer", KeyID: "key", PrivateKey: key, HTTP: sandbox.Client(), ProductionURL: prod.URL, SandboxURL: sandbox.URL}, verifier)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = client.CanonicalSubscription(context.Background(), tx, now); err == nil {
		t.Fatal("non-200 canonical response accepted")
	}
	if prodHits != 0 || sandboxHits != 1 {
		t.Fatalf("routes production=%d sandbox=%d", prodHits, sandboxHits)
	}
}

func TestAppleSweepRevokesExpiredCanonicalFactAndRestoresRenewal(t *testing.T) {
	_, svc, store, _ := newBillingServer(t)
	seedTiers(t, store)
	ctx := context.Background()
	now := time.Unix(2_000_000_000, 0)
	svc.now = func() time.Time { return now }
	u, _ := store.UpsertUserByEmail(ctx, "sweep-renew@example.test", "")
	token := mustNewAppAccountToken(t)
	if _, err := store.EnsureAppleAccountToken(ctx, u.ID, token); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertAppleProduct(ctx, AppleProduct{BundleID: testBundleIOS, ProductID: testAppleProduct, PlanID: "pro", Cycle: "monthly", Active: true, UpdatedAt: 1}); err != nil {
		t.Fatal(err)
	}
	base := VerifiedAppleTransaction{OriginalTransactionID: "sweep-1", TransactionID: "tx", BundleID: testBundleIOS, ProductID: testAppleProduct, Environment: appleEnvProduction, AppAccountToken: token, PurchaseDateMS: now.Add(-time.Hour).UnixMilli(), SignedDateMS: now.UnixMilli()}
	live := base
	live.ExpiresDateMS = now.Add(time.Hour).UnixMilli()
	ren := VerifiedAppleRenewalInfo{OriginalTransactionID: base.OriginalTransactionID, AutoRenewProductID: testAppleProduct, Environment: appleEnvProduction, AutoRenewEnabled: true, SignedDateMS: now.UnixMilli()}
	state := appleRenewalState(u.ID, live, ren, now)
	if _, err := store.ApplyAppleLifecycle(ctx, appleSourceEventWithRenewal(u.ID, live, AppleProduct{PlanID: "pro", Cycle: "monthly"}, state, now), state); err != nil {
		t.Fatal(err)
	}
	facts := &appleSweepFact{value: AppleSubscriptionCanonical{Transaction: base, Renewal: ren}}
	facts.value.Transaction.ExpiresDateMS = now.Add(-time.Second).UnixMilli()
	svc.SetAppleSubscriptionReconciler(facts)
	svc.ReconcileAppleSubscriptions(ctx)
	got, _ := store.GetUserByID(ctx, u.ID)
	if got.PlanID != "free" {
		t.Fatalf("sweep missed expiry: %+v", got)
	}
	facts.value.Transaction.ExpiresDateMS = now.Add(time.Hour).UnixMilli()
	facts.value.Transaction.SignedDateMS = now.Add(time.Minute).UnixMilli()
	facts.value.Renewal.SignedDateMS = facts.value.Transaction.SignedDateMS
	svc.ReconcileAppleSubscriptions(ctx)
	got, _ = store.GetUserByID(ctx, u.ID)
	if got.PlanID != "pro" {
		t.Fatalf("sweep missed renewal: %+v", got)
	}
	if err := store.UpsertAppleProduct(ctx, AppleProduct{BundleID: testBundleIOS, ProductID: testAppleProduct, PlanID: "pro", Cycle: "monthly", Active: false, UpdatedAt: 2}); err != nil {
		t.Fatal(err)
	}
	facts.value.Transaction.RevocationDateMS = now.Add(2 * time.Minute).UnixMilli()
	facts.value.Transaction.SignedDateMS = facts.value.Transaction.RevocationDateMS
	facts.value.Renewal.SignedDateMS = facts.value.Transaction.SignedDateMS
	svc.ReconcileAppleSubscriptions(ctx)
	got, _ = store.GetUserByID(ctx, u.ID)
	if got.PlanID != "free" {
		t.Fatalf("unmapped refund still grants: %+v", got)
	}
}
