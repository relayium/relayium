package account

import (
	"context"
	"testing"
)

func TestAppleVerifiedRenewalTargetResolvesDeferredPurchaseWithoutChangingCurrentEntitlement(t *testing.T) {
	for _, tc := range []struct {
		name, currentProduct, targetProduct, currentPlan, currentCycle string
	}{
		{"tier downgrade", "pro.yearly", "plus.yearly", "pro", "yearly"},
		{"same tier yearly to monthly", "pro.yearly", "pro.monthly", "pro", "yearly"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := newTestStore(t)
			ctx := context.Background()
			u, _ := store.UpsertUserByEmail(ctx, "deferred-"+tc.targetProduct+"@example.test", "")
			token := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
			authority, err := store.AcquireBillingAuthority(ctx, BillingAuthorityRequest{
				UserID: u.ID, Provider: ProviderApple, ExternalScope: testBundleIOS,
				AppleAccountToken: token, Now: 100,
			})
			if err != nil {
				t.Fatal(err)
			}
			attempt, created, err := store.DispatchAppleBillingPurchase(ctx, authority, tc.targetProduct, token, 101)
			if err != nil || !created {
				t.Fatalf("dispatch: attempt=%+v created=%v err=%v", attempt, created, err)
			}
			renewal := AppleRenewalState{
				UserID: u.ID, ExternalID: "original-deferred", BundleID: testBundleIOS,
				CurrentProductID: tc.currentProduct, AutoRenewProductID: tc.targetProduct,
				AutoRenewEnabled: true, RenewalAt: 2_000, EventAt: 200, UpdatedAt: 102,
			}
			event := SourceEvent{
				UserID: u.ID, Provider: ProviderApple, PlanID: tc.currentPlan,
				Status: "active", Cycle: tc.currentCycle, PeriodEnd: 2_000,
				ExternalID: renewal.ExternalID, ExternalScope: testBundleIOS,
				EventAt: 200, Now: 102,
				AppleRenewalOriginalID: renewal.ExternalID, AppleRenewalEnvironment: appleEnvProduction,
				AppleRenewalAccountToken: token, AppleRenewalTargetProductID: tc.targetProduct,
				AppleRenewalAutoRenewEnabled: true,
			}
			result, err := store.ApplyAuthorizedAppleLifecycle(ctx, event, renewal, token, appleEnvProduction)
			if err != nil || !result.Applied {
				t.Fatalf("apply: result=%+v err=%v", result, err)
			}
			if result.Effective.PlanID != tc.currentPlan || result.Effective.Cycle != tc.currentCycle {
				t.Fatalf("deferred target changed current entitlement: %+v", result.Effective)
			}
			var state string
			if err := store.db.QueryRowContext(ctx, `SELECT state FROM billing_purchase_attempts WHERE id=?`, attempt.ID).Scan(&state); err != nil {
				t.Fatal(err)
			}
			if state != "resolved" {
				t.Fatalf("verified deferred target left attempt %q", state)
			}
			next, ok, err := store.BillingAuthority(ctx, u.ID)
			if err != nil || !ok || next.Epoch != authority.Epoch+1 {
				t.Fatalf("resolved deferred attempt did not open the next generation: %+v ok=%v err=%v", next, ok, err)
			}
			stored, ok, err := store.GetAppleRenewalState(ctx, u.ID)
			if err != nil || !ok || stored.AutoRenewProductID != tc.targetProduct || stored.CurrentProductID != tc.currentProduct {
				t.Fatalf("renewal intent was not durable: %+v ok=%v err=%v", stored, ok, err)
			}
		})
	}
}

func TestAppleUnrelatedRenewalCannotResolveDeferredPurchase(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "unrelated-renewal@example.test", "")
	token := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	authority, _ := store.AcquireBillingAuthority(ctx, BillingAuthorityRequest{UserID: u.ID, Provider: ProviderApple, ExternalScope: testBundleIOS, AppleAccountToken: token, Now: 100})
	attempt, _, _ := store.DispatchAppleBillingPurchase(ctx, authority, "plus.yearly", token, 101)
	renewal := AppleRenewalState{UserID: u.ID, ExternalID: "original-other", BundleID: testBundleIOS, CurrentProductID: "pro.yearly", AutoRenewProductID: "max.yearly", AutoRenewEnabled: true, EventAt: 200, UpdatedAt: 102}
	event := SourceEvent{UserID: u.ID, Provider: ProviderApple, PlanID: "pro", Status: "active", Cycle: "yearly", PeriodEnd: 2_000, ExternalID: renewal.ExternalID, ExternalScope: testBundleIOS, EventAt: 200, Now: 102,
		AppleRenewalOriginalID: renewal.ExternalID, AppleRenewalEnvironment: appleEnvProduction,
		AppleRenewalAccountToken: token, AppleRenewalTargetProductID: "max.yearly", AppleRenewalAutoRenewEnabled: true}
	if _, err := store.ApplyAuthorizedAppleLifecycle(ctx, event, renewal, token, appleEnvProduction); err != nil {
		t.Fatal(err)
	}
	var state string
	if err := store.db.QueryRowContext(ctx, `SELECT state FROM billing_purchase_attempts WHERE id=?`, attempt.ID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "dispatched" {
		t.Fatalf("unrelated renewal released attempt: %q", state)
	}
}
