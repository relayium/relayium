package account

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// useRealAppleServerAPI makes the fixture exercise the production canonical
// status client rather than a reconciler stub. The response closures allow one
// verified transaction to outlive an optional renewal projection.
func (f *appleTxFixture) useRealAppleServerAPI(t *testing.T, transactionJWS func() string, renewalJWS func() string) {
	t.Helper()
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/inApps/v1/subscriptions/") {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{
			"lastTransactions": []any{map[string]string{
				"signedTransactionInfo": transactionJWS(),
				"signedRenewalInfo":     renewalJWS(),
			}},
		}}})
	}))
	t.Cleanup(server.Close)
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	client, err := NewAppleServerAPIClient(AppleServerAPIConfig{
		IssuerID: "issuer", KeyID: "key", PrivateKey: key, HTTP: server.Client(),
		ProductionURL: server.URL, SandboxURL: server.URL,
	}, f.verifier)
	if err != nil {
		t.Fatal(err)
	}
	f.svc.SetAppleSubscriptionReconciler(client)
}

func seedAppleGraceWithRealAPI(t *testing.T) (*appleTxFixture, map[string]any, string, *string) {
	t.Helper()
	f := newAppleTxFixture(t)
	now := time.Now().UTC()
	txPayload := f.payload(func(p map[string]any) {
		p["purchaseDate"] = now.Add(-31 * 24 * time.Hour).UnixMilli()
		p["originalPurchaseDate"] = now.Add(-31 * 24 * time.Hour).UnixMilli()
		p["expiresDate"] = now.Add(-time.Hour).UnixMilli()
		p["signedDate"] = now.UnixMilli()
	})
	txJWS := f.chain.sign(t, txPayload)
	renewal := f.chain.sign(t, map[string]any{
		"originalTransactionId": txPayload["originalTransactionId"],
		"autoRenewProductId":    txPayload["productId"],
		"autoRenewStatus":       1, "isInBillingRetryPeriod": true,
		"gracePeriodExpiresDate": now.Add(48 * time.Hour).UnixMilli(),
		"environment":            txPayload["environment"], "signedDate": now.UnixMilli(),
	})
	f.useRealAppleServerAPI(t, func() string { return txJWS }, func() string { return renewal })
	f.mustAccept(t, txJWS)
	return f, txPayload, txJWS, &renewal
}

func TestApplePurchaseNeverPersistsFabricatedRenewalProjection(t *testing.T) {
	f := newAppleTxFixture(t)
	txJWS := f.chain.sign(t, f.payload())
	f.useRealAppleServerAPI(t, func() string { return txJWS }, func() string { return "not.a.jws" })

	f.mustAccept(t, txJWS)
	u := f.user(t)
	if u.PlanID != "pro" {
		t.Fatalf("verified paid transaction did not grant: %+v", u)
	}
	if renewal, ok, err := f.store.GetAppleRenewalState(context.Background(), u.ID); err != nil || ok {
		t.Fatalf("absent renewal projection was persisted: renewal=%+v ok=%v err=%v", renewal, ok, err)
	}
}

func TestApplePurchaseAndSweepKeepVerifiedGraceWhenCanonicalRenewalIsUnreadable(t *testing.T) {
	f := newAppleTxFixture(t)
	now := time.Now().UTC()
	txPayload := f.payload(func(p map[string]any) {
		p["purchaseDate"] = now.Add(-31 * 24 * time.Hour).UnixMilli()
		p["originalPurchaseDate"] = now.Add(-31 * 24 * time.Hour).UnixMilli()
		p["expiresDate"] = now.Add(-time.Hour).UnixMilli()
		p["signedDate"] = now.UnixMilli()
	})
	txJWS := f.chain.sign(t, txPayload)
	renewalJWS := f.chain.sign(t, map[string]any{
		"originalTransactionId": txPayload["originalTransactionId"],
		"autoRenewProductId":    txPayload["productId"],
		"appAccountToken":       "not-a-uuid", "autoRenewStatus": 1,
		"isInBillingRetryPeriod": true,
		"gracePeriodExpiresDate": now.Add(48 * time.Hour).UnixMilli(),
		"environment":            txPayload["environment"], "signedDate": now.UnixMilli(),
	})
	currentRenewal := renewalJWS
	f.useRealAppleServerAPI(t, func() string { return txJWS }, func() string { return currentRenewal })

	f.mustAccept(t, txJWS)
	u := f.user(t)
	seeded, ok, err := f.store.GetAppleRenewalState(context.Background(), u.ID)
	if err != nil || !ok || !seeded.IsInBillingRetry || seeded.GraceUntil <= now.Unix() || u.PlanID != "pro" {
		t.Fatalf("verified grace was not seeded: user=%+v renewal=%+v ok=%v err=%v", u, seeded, ok, err)
	}

	currentRenewal = "not.a.jws"
	f.mustAccept(t, txJWS)
	if after := f.user(t); after.PlanID != "pro" {
		t.Fatalf("intake revoked durable grace after optional renewal became unreadable: %+v", after)
	}
	f.svc.ReconcileAppleSubscriptions(context.Background())
	if after := f.user(t); after.PlanID != "pro" {
		t.Fatalf("sweep revoked durable grace after optional renewal became unreadable: %+v", after)
	}
	kept, ok, err := f.store.GetAppleRenewalState(context.Background(), u.ID)
	if err != nil || !ok || kept != seeded {
		t.Fatalf("unreadable renewal changed durable grace: before=%+v after=%+v ok=%v err=%v", seeded, kept, ok, err)
	}
}

func TestAppleNotificationKeepsDurableGraceWhenRenewalIsUnreadable(t *testing.T) {
	f, txPayload, txJWS, _ := seedAppleGraceWithRealAPI(t)
	u := f.user(t)
	before, ok, err := f.store.GetAppleRenewalState(context.Background(), u.ID)
	if err != nil || !ok {
		t.Fatalf("missing seeded grace: ok=%v err=%v", ok, err)
	}

	var logs bytes.Buffer
	previousLog := log.Writer()
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(previousLog) })
	uuid := appleNotifyUUID(201)
	notification := f.chain.notify(t, txJWS, func(p map[string]any) {
		p["notificationUUID"] = uuid
		p["data"].(map[string]any)["signedRenewalInfo"] = "not.a.jws"
	})
	f.mustNotify(t, notification, http.StatusOK)
	if got := f.ledger(t, uuid).State; got != appleNotificationApplied {
		t.Fatalf("verified transaction with unreadable renewal was not applied: %q", got)
	}
	if after := f.user(t); after.PlanID != "pro" {
		t.Fatalf("unreadable renewal revoked durable grace: %+v payload=%+v", after, txPayload)
	}
	after, ok, err := f.store.GetAppleRenewalState(context.Background(), u.ID)
	if err != nil || !ok || after != before {
		t.Fatalf("notification changed durable grace: before=%+v after=%+v ok=%v err=%v", before, after, ok, err)
	}
	if !strings.Contains(logs.String(), "renewal info ignored") || !strings.Contains(logs.String(), "(b64_segment)") || strings.Contains(logs.String(), "not.a.jws") {
		t.Fatalf("fixed-code renewal rejection was not logged: %q", logs.String())
	}
}

func TestAppleRefundStillRevokesWhenRenewalIsUnreadable(t *testing.T) {
	f, txPayload, _, _ := seedAppleGraceWithRealAPI(t)
	now := time.Now().UTC()
	txPayload["revocationDate"] = now.UnixMilli()
	txPayload["signedDate"] = now.UnixMilli()
	uuid := appleNotifyUUID(202)
	notification := f.chain.notify(t, f.chain.sign(t, txPayload), func(p map[string]any) {
		p["notificationUUID"] = uuid
		p["data"].(map[string]any)["signedRenewalInfo"] = "not.a.jws"
	})
	f.mustNotify(t, notification, http.StatusOK)
	if got := f.ledger(t, uuid).State; got != appleNotificationApplied {
		t.Fatalf("refund with unreadable renewal was not applied: %q", got)
	}
	if u := f.user(t); u.PlanID != freePlanID || u.SubscriptionStatus != "canceled" {
		t.Fatalf("refund failed to revoke entitlement: %+v", u)
	}
}

func TestAppleNotificationRenewalRejectionIsExplicitAndAbsentOnlyWhenNoRenewalWasSent(t *testing.T) {
	f := newAppleTxFixture(t)
	txJWS := f.chain.sign(t, f.payload())
	for i, bad := range []string{"not.a.jws", "a.b.c", f.chain.sign(t, map[string]any{"signedDate": time.Now().UnixMilli()})} {
		payload := f.chain.notify(t, txJWS, func(p map[string]any) {
			p["notificationUUID"] = appleNotifyUUID(210 + i)
			p["data"].(map[string]any)["signedRenewalInfo"] = bad
		})
		verified, err := f.verifier.VerifyNotification(payload, time.Now())
		if err != nil {
			t.Fatalf("transaction authority was lost to renewal failure: %v", err)
		}
		if verified.RenewalRejection == "" || verified.HasRenewal {
			t.Fatalf("renewal rejection not represented: %+v", verified)
		}
	}
	absent := f.chain.notify(t, txJWS, func(p map[string]any) { p["notificationUUID"] = appleNotifyUUID(220) })
	verified, err := f.verifier.VerifyNotification(absent, time.Now())
	if err != nil || verified.RenewalRejection != "" {
		t.Fatalf("absent renewal was reported as rejected: rejection=%q err=%v", verified.RenewalRejection, err)
	}
}

func TestAppleReadableNewerRenewalEndsStoredGrace(t *testing.T) {
	f, txPayload, txJWS, currentRenewal := seedAppleGraceWithRealAPI(t)
	now := time.Now().UTC().Add(time.Minute)
	*currentRenewal = f.chain.sign(t, map[string]any{
		"originalTransactionId": txPayload["originalTransactionId"],
		"autoRenewProductId":    txPayload["productId"],
		"autoRenewStatus":       0, "isInBillingRetryPeriod": false,
		"environment": txPayload["environment"], "signedDate": now.UnixMilli(),
	})
	f.mustAccept(t, txJWS)
	u := f.user(t)
	renewal, ok, err := f.store.GetAppleRenewalState(context.Background(), u.ID)
	if err != nil || !ok {
		t.Fatalf("newer readable renewal was not persisted: ok=%v err=%v", ok, err)
	}
	if renewal.IsInBillingRetry || renewal.GraceUntil != 0 || renewal.AutoRenewEnabled {
		t.Fatalf("newer readable renewal failed to end old grace: %+v", renewal)
	}
	if u.PlanID != freePlanID {
		t.Fatalf("expired transaction retained paid entitlement after grace ended: %+v", u)
	}
}
