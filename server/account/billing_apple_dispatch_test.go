package account

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
)

func TestAppleNextRenewalChangesNeverCreateAPurchaseDispatch(t *testing.T) {
	f := newAppleCatalogFixture(t)
	products := []AppleProduct{
		{BundleID: testBundleMac, ProductID: "pro.yearly", PlanID: "pro", Cycle: "yearly", Active: true},
		{BundleID: testBundleMac, ProductID: "plus.monthly", PlanID: "plus", Cycle: "monthly", Active: true},
		{BundleID: testBundleMac, ProductID: "max.monthly", PlanID: "max", Cycle: "monthly", Active: true},
	}
	for _, product := range products {
		mustAppleProduct(t, f.store, product)
	}
	if _, err := f.store.AcquireBillingAuthority(context.Background(), BillingAuthorityRequest{
		UserID: f.userID, Provider: ProviderApple, ExternalScope: testBundleMac,
		AppleAccountToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Now: 99,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.ApplySubscriptionSource(context.Background(), SourceEvent{
		UserID: f.userID, Provider: ProviderApple, PlanID: "pro", Status: "active",
		Cycle: "monthly", PeriodEnd: 2_000_000_000, ExternalID: "sandbox:current",
		ExternalScope: testBundleMac, EventAt: 100, Now: 100,
	}); err != nil {
		t.Fatal(err)
	}
	for _, productID := range []string{"pro.yearly", "plus.monthly"} {
		resp := postApplePurchaseDispatch(t, f, testBundleMac, productID)
		var body map[string]string
		_ = json.NewDecoder(resp.Body).Decode(&body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusConflict || body["error"] != "manage_with_apple" {
			t.Fatalf("%s was not sent to Apple management: status=%d body=%v", productID, resp.StatusCode, body)
		}
	}
	var attempts int
	if err := f.store.db.QueryRow(`SELECT COUNT(*) FROM billing_purchase_attempts WHERE user_id=?`, f.userID).Scan(&attempts); err != nil || attempts != 0 {
		t.Fatalf("next-renewal change created attempts=%d err=%v", attempts, err)
	}
	resp := postApplePurchaseDispatch(t, f, testBundleMac, "max.monthly")
	var body map[string]string
	_ = json.NewDecoder(resp.Body).Decode(&body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("immediate upgrade regressed: status=%d body=%v", resp.StatusCode, body)
	}
}

func postApplePurchaseDispatch(t *testing.T, f *appleCatalogFixture, bundleID, productID string) *http.Response {
	t.Helper()
	body, err := json.Marshal(map[string]string{"bundleId": bundleID, "productId": productID})
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, f.ts.URL+"/api/billing/apple/purchase-dispatch", strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(f.cookie)
	resp, err := f.ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func TestApplePurchaseDispatchIsEmittedExactlyOnceAcrossDevices(t *testing.T) {
	f := newAppleCatalogFixture(t)
	productID := "com.relayium.mac.pro.monthly"
	mustAppleProduct(t, f.store, AppleProduct{
		BundleID: testBundleMac, ProductID: productID,
		PlanID: "pro", Cycle: "monthly", Active: true,
	})

	start := make(chan struct{})
	statuses := make(chan int, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			resp := postApplePurchaseDispatch(t, f, testBundleMac, productID)
			defer resp.Body.Close()
			statuses <- resp.StatusCode
		}()
	}
	close(start)
	wg.Wait()
	close(statuses)

	counts := map[int]int{}
	for status := range statuses {
		counts[status]++
	}
	if counts[http.StatusOK] != 1 || counts[http.StatusConflict] != 1 {
		t.Fatalf("want one dispatch and one reconciliation response, got %v", counts)
	}

	authority, ok, err := f.store.BillingAuthority(t.Context(), f.userID)
	if err != nil || !ok {
		t.Fatalf("BillingAuthority: ok=%v err=%v", ok, err)
	}
	if authority.Provider != ProviderApple || authority.ExternalScope != testBundleMac || authority.AppleAccountToken == "" {
		t.Fatalf("wrong durable authority: %+v", authority)
	}
}

func TestApplePurchaseDispatchIsStickyAcrossCancelPendingAndApps(t *testing.T) {
	f := newAppleCatalogFixture(t)
	macProduct := "com.relayium.mac.plus.monthly"
	iosProduct := "com.relayium.app.plus.monthly"
	for _, p := range []AppleProduct{
		{BundleID: testBundleMac, ProductID: macProduct, PlanID: "plus", Cycle: "monthly", Active: true},
		{BundleID: testBundleIOS, ProductID: iosProduct, PlanID: "plus", Cycle: "monthly", Active: true},
	} {
		mustAppleProduct(t, f.store, p)
	}

	first := postApplePurchaseDispatch(t, f, testBundleMac, macProduct)
	first.Body.Close()
	if first.StatusCode != http.StatusOK {
		t.Fatalf("first dispatch: want 200, got %d", first.StatusCode)
	}
	for _, tc := range []struct{ bundle, product string }{
		{testBundleMac, macProduct}, // cancel/pending/crash retry
		{testBundleIOS, iosProduct}, // another Relayium App Store app
	} {
		resp := postApplePurchaseDispatch(t, f, tc.bundle, tc.product)
		var body map[string]string
		_ = json.NewDecoder(resp.Body).Decode(&body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusConflict {
			t.Fatalf("%s retry: want 409, got %d", tc.bundle, resp.StatusCode)
		}
		if body["error"] != "purchase_reconciliation_required" && body["error"] != "billing_authority_conflict" {
			t.Fatalf("%s retry: unsafe response %#v", tc.bundle, body)
		}
	}
}
