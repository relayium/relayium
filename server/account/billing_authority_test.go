package account

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"testing"
)

func TestBillingAuthoritySerializesCrossProviderAndAppleAppPurchases(t *testing.T) {
	store := newTestStore(t)
	u, err := store.UpsertUserByEmail(context.Background(), "authority-race@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for _, request := range []BillingAuthorityRequest{
		{UserID: u.ID, Provider: ProviderStripe, Now: 100},
		{UserID: u.ID, Provider: ProviderApple, ExternalScope: "com.relayium.mac", AppleAccountToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Now: 100},
	} {
		wg.Add(1)
		go func(in BillingAuthorityRequest) {
			defer wg.Done()
			<-start
			_, err := store.AcquireBillingAuthority(context.Background(), in)
			errs <- err
		}(request)
	}
	close(start)
	wg.Wait()
	close(errs)
	var won, blocked int
	for err := range errs {
		switch {
		case err == nil:
			won++
		case errors.Is(err, ErrBillingAuthorityConflict):
			blocked++
		default:
			t.Fatal(err)
		}
	}
	if won != 1 || blocked != 1 {
		t.Fatalf("won=%d blocked=%d", won, blocked)
	}
}

func TestBillingAuthorityIsPersistentAndAppleBundleScoped(t *testing.T) {
	store := newTestStore(t)
	u, err := store.UpsertUserByEmail(context.Background(), "authority-apple@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	request := BillingAuthorityRequest{UserID: u.ID, Provider: ProviderApple, ExternalScope: "com.relayium.mac", AppleAccountToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Now: 100}
	first, err := store.AcquireBillingAuthority(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	request.Now = 999999
	retry, err := store.AcquireBillingAuthority(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if retry != first {
		t.Fatalf("retry changed authority: %#v != %#v", retry, first)
	}
	if _, err := store.AcquireBillingAuthority(context.Background(), BillingAuthorityRequest{UserID: u.ID, Provider: ProviderApple, ExternalScope: "com.relayium.app", AppleAccountToken: request.AppleAccountToken, Now: 101}); !errors.Is(err, ErrBillingAuthorityConflict) {
		t.Fatalf("cross-app err=%v", err)
	}
	if _, err := store.AcquireBillingAuthority(context.Background(), BillingAuthorityRequest{UserID: u.ID, Provider: ProviderStripe, Now: 101}); !errors.Is(err, ErrBillingAuthorityConflict) {
		t.Fatalf("cross-provider err=%v", err)
	}
}

func TestBillingAuthorityAllowsOnlyOneUnresolvedDispatchPerGeneration(t *testing.T) {
	store := newTestStore(t)
	u, err := store.UpsertUserByEmail(context.Background(), "authority-dispatch@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	authority, err := store.AcquireBillingAuthority(context.Background(), BillingAuthorityRequest{UserID: u.ID, Provider: ProviderApple, ExternalScope: "com.relayium.mac", AppleAccountToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Now: 100})
	if err != nil {
		t.Fatal(err)
	}
	first, created, err := store.PrepareBillingPurchase(context.Background(), authority, "com.relayium.mac.pro.monthly", 101)
	if err != nil || !created {
		t.Fatalf("first prepare created=%v err=%v", created, err)
	}
	retry, created, err := store.PrepareBillingPurchase(context.Background(), authority, "com.relayium.mac.max.yearly", 102)
	if err != nil || created || retry.ID != first.ID || retry.ProductID != first.ProductID {
		t.Fatalf("retry=%#v created=%v err=%v", retry, created, err)
	}
	if ok, err := store.MarkBillingPurchaseDispatched(context.Background(), u.ID, first.ID, authority.Epoch); err != nil || !ok {
		t.Fatalf("dispatch ok=%v err=%v", ok, err)
	}
	if ok, err := store.MarkBillingPurchaseDispatched(context.Background(), u.ID, first.ID, authority.Epoch); err != nil || ok {
		t.Fatalf("repeat dispatch ok=%v err=%v", ok, err)
	}
}

func TestAdminGrantCannotRacePersistentBillingAuthority(t *testing.T) {
	store := newTestStore(t)
	u, err := store.UpsertUserByEmail(context.Background(), "authority-admin@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.AcquireBillingAuthority(context.Background(), BillingAuthorityRequest{UserID: u.ID, Provider: ProviderStripe, Now: 100}); err != nil {
		t.Fatal(err)
	}
	if err := store.SetUserPlanAdmin(context.Background(), u.ID, "pro", 101); !errors.Is(err, ErrBillingAuthorityConflict) {
		t.Fatalf("admin grant err=%v", err)
	}
	got, err := store.GetUserByID(context.Background(), u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.PlanID != freePlanID || got.PlanSource == SourceAdmin {
		t.Fatalf("admin grant partially applied: %#v", got)
	}
}

func TestAcquireBillingAuthorityBackfillsHazardousStripeHistory(t *testing.T) {
	for _, status := range []string{"incomplete", "unpaid", "paused", "past_due", "canceled"} {
		t.Run(status, func(t *testing.T) {
			store := newTestStore(t)
			ctx := context.Background()
			u, _ := store.UpsertUserByEmail(ctx, "legacy-stripe-"+status+"@example.test", "")
			if _, err := store.ApplySubscriptionSource(ctx, SourceEvent{
				UserID: u.ID, Provider: ProviderStripe, PlanID: freePlanID, Status: status,
				ExternalID: "sub_legacy_" + status, EventAt: 10, Now: 10,
			}); err != nil {
				t.Fatal(err)
			}
			if _, err := store.AcquireBillingAuthority(ctx, BillingAuthorityRequest{
				UserID: u.ID, Provider: ProviderApple, ExternalScope: testBundleIOS,
				AppleAccountToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Now: 20,
			}); !errors.Is(err, ErrBillingAuthorityConflict) {
				t.Fatalf("Apple crossed legacy Stripe status %q: %v", status, err)
			}
			authority, err := store.AcquireBillingAuthority(ctx, BillingAuthorityRequest{UserID: u.ID, Provider: ProviderStripe, Now: 21})
			if err != nil || authority.Provider != ProviderStripe {
				t.Fatalf("Stripe history did not backfill authority: %+v err=%v", authority, err)
			}
		})
	}
}

func TestAcquireBillingAuthorityBackfillsTerminalAppleHistory(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "legacy-apple-terminal@example.test", "")
	if _, err := store.ApplySubscriptionSource(ctx, SourceEvent{
		UserID: u.ID, Provider: ProviderApple, PlanID: freePlanID, Status: "canceled",
		ExternalID: "production:legacy", ExternalScope: testBundleIOS, EventAt: 10, Now: 10,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.AcquireBillingAuthority(ctx, BillingAuthorityRequest{UserID: u.ID, Provider: ProviderStripe, Now: 20}); !errors.Is(err, ErrBillingAuthorityConflict) {
		t.Fatalf("Stripe crossed terminal Apple history: %v", err)
	}
}

func TestAdminGrantCannotCrossLegacyProviderHistory(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "legacy-provider-admin@example.test", "")
	if _, err := store.ApplySubscriptionSource(ctx, SourceEvent{
		UserID: u.ID, Provider: ProviderStripe, PlanID: freePlanID, Status: "unpaid",
		ExternalID: "sub_admin_hazard", EventAt: 10, Now: 10,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SetUserPlanAdmin(ctx, u.ID, "pro", 20); !errors.Is(err, ErrBillingAuthorityConflict) {
		t.Fatalf("admin crossed legacy provider history: %v", err)
	}
}

func TestBillingAuthorityMigrationBackfillsAtomicallyAndIsIdempotent(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	stripeUser, _ := store.UpsertUserByEmail(ctx, "migration-stripe@example.test", "")
	if _, err := store.ApplySubscriptionSource(ctx, SourceEvent{
		UserID: stripeUser.ID, Provider: ProviderStripe, PlanID: freePlanID,
		Status: "incomplete", ExternalID: "sub_migration", EventAt: 1, Now: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if err := backfillBillingAuthorities(ctx, store.db, 10); err != nil {
		t.Fatal(err)
	}
	if err := backfillBillingAuthorities(ctx, store.db, 11); err != nil {
		t.Fatalf("idempotent backfill: %v", err)
	}
	authority, ok, err := store.BillingAuthority(ctx, stripeUser.ID)
	if err != nil || !ok || authority.Provider != ProviderStripe {
		t.Fatalf("backfilled authority=%+v ok=%v err=%v", authority, ok, err)
	}

	ambiguous, _ := store.UpsertUserByEmail(ctx, "migration-ambiguous@example.test", "")
	if _, err := store.ApplySubscriptionSource(ctx, SourceEvent{UserID: ambiguous.ID, Provider: ProviderStripe, PlanID: freePlanID, Status: "unpaid", ExternalID: "sub_ambiguous", EventAt: 1, Now: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ApplySubscriptionSource(ctx, SourceEvent{UserID: ambiguous.ID, Provider: ProviderApple, PlanID: freePlanID, Status: "canceled", ExternalID: "production:ambiguous", ExternalScope: testBundleIOS, EventAt: 1, Now: 1}); err != nil {
		t.Fatal(err)
	}
	if err := backfillBillingAuthorities(ctx, store.db, 12); !errors.Is(err, ErrBillingAuthorityConflict) {
		t.Fatalf("ambiguous historical providers did not fail closed: %v", err)
	}
	if _, ok, err := store.BillingAuthority(ctx, ambiguous.ID); err != nil || ok {
		t.Fatalf("ambiguous backfill partially wrote authority: ok=%v err=%v", ok, err)
	}
}

func TestAuthorizedAppleLifecycleAtomicallyBindsAndResolvesDispatch(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	u, err := store.UpsertUserByEmail(ctx, "authority-apple-apply@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	token := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	authority, err := store.AcquireBillingAuthority(ctx, BillingAuthorityRequest{
		UserID: u.ID, Provider: ProviderApple, ExternalScope: testBundleIOS,
		AppleAccountToken: token, Now: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	attempt, created, err := store.DispatchBillingPurchase(ctx, authority, testAppleProduct, 101)
	if err != nil || !created {
		t.Fatalf("dispatch created=%v err=%v", created, err)
	}
	ev := SourceEvent{UserID: u.ID, Provider: ProviderApple, PlanID: "pro", Status: "active", Cycle: "monthly", PeriodEnd: 1000, ExternalID: "production:original-one", ExternalScope: testBundleIOS, EventAt: 200, Now: 102}
	renewal := AppleRenewalState{UserID: u.ID, ExternalID: ev.ExternalID, BundleID: testBundleIOS, CurrentProductID: testAppleProduct, AutoRenewProductID: testAppleProduct, EventAt: 201, UpdatedAt: 102}
	result, err := store.ApplyAuthorizedAppleLifecycle(ctx, ev, renewal, token, appleEnvProduction)
	if err != nil || !result.Applied {
		t.Fatalf("apply=%+v err=%v", result, err)
	}
	got, ok, err := store.BillingAuthority(ctx, u.ID)
	if err != nil || !ok || got.AppleEnvironment != appleEnvProduction {
		t.Fatalf("authority=%+v ok=%v err=%v", got, ok, err)
	}
	if got.Epoch != authority.Epoch+1 || got.IntentID == authority.IntentID {
		t.Fatalf("canonical apply did not advance generation exactly once: before=%+v after=%+v", authority, got)
	}
	var state string
	if err := store.db.QueryRowContext(ctx, `SELECT state FROM billing_purchase_attempts WHERE id=?`, attempt.ID).Scan(&state); err != nil || state != "resolved" {
		t.Fatalf("attempt state=%q err=%v", state, err)
	}
	next, created, err := store.DispatchBillingPurchase(ctx, got, "com.relayium.app.max.monthly", 103)
	if err != nil || !created || next.Epoch != got.Epoch {
		t.Fatalf("next canonical generation dispatch=%+v created=%v err=%v", next, created, err)
	}
}

func TestAuthorizedAppleLifecycleAmbiguityRollsBackEveryProjection(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "authority-apple-ambiguous@example.test", "")
	token := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	authority, err := store.AcquireBillingAuthority(ctx, BillingAuthorityRequest{UserID: u.ID, Provider: ProviderApple, ExternalScope: testBundleIOS, AppleAccountToken: token, Now: 100})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = store.DispatchBillingPurchase(ctx, authority, "expected.product", 101); err != nil {
		t.Fatal(err)
	}
	ev := SourceEvent{UserID: u.ID, Provider: ProviderApple, PlanID: "pro", Status: "active", Cycle: "monthly", PeriodEnd: 1000, ExternalID: "production:other", ExternalScope: testBundleIOS, EventAt: 200, Now: 102}
	renewal := AppleRenewalState{UserID: u.ID, ExternalID: ev.ExternalID, BundleID: testBundleIOS, CurrentProductID: "different.product", AutoRenewProductID: "different.product", EventAt: 201, UpdatedAt: 102}
	if _, err := store.ApplyAuthorizedAppleLifecycle(ctx, ev, renewal, token, appleEnvProduction); !errors.Is(err, ErrBillingPurchaseAmbiguous) {
		t.Fatalf("want ambiguity, got %v", err)
	}
	got, _, _ := store.BillingAuthority(ctx, u.ID)
	if got.AppleEnvironment != "" {
		t.Fatalf("failed apply partially bound environment: %+v", got)
	}
	if _, ok, err := store.GetSubscriptionSource(ctx, u.ID, ProviderApple); err != nil || ok {
		t.Fatalf("failed apply wrote source: ok=%v err=%v", ok, err)
	}
	var state string
	if err := store.db.QueryRowContext(ctx, `SELECT state FROM billing_purchase_attempts WHERE user_id=?`, u.ID).Scan(&state); err != nil || state != "dispatched" {
		t.Fatalf("failed apply changed attempt: state=%q err=%v", state, err)
	}
	var renewalCount int
	if err := store.db.QueryRowContext(ctx, `SELECT count(*) FROM apple_renewal_states WHERE user_id=?`, u.ID).Scan(&renewalCount); err != nil || renewalCount != 0 {
		t.Fatalf("failed apply wrote renewal: count=%d err=%v", renewalCount, err)
	}
}

func TestAuthorizedAppleLifecycleRejectsEnvironmentDrift(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "authority-apple-env@example.test", "")
	token := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	ev := SourceEvent{UserID: u.ID, Provider: ProviderApple, PlanID: "pro", Status: "active", Cycle: "monthly", PeriodEnd: 1000, ExternalID: "sandbox:one", ExternalScope: testBundleIOS, EventAt: 200, Now: 102}
	renewal := AppleRenewalState{UserID: u.ID, ExternalID: ev.ExternalID, BundleID: testBundleIOS, CurrentProductID: testAppleProduct, AutoRenewProductID: testAppleProduct, EventAt: 201, UpdatedAt: 102}
	if _, err := store.ApplyAuthorizedAppleLifecycle(ctx, ev, renewal, token, appleEnvSandbox); err != nil {
		t.Fatal(err)
	}
	ev.ExternalID = "production:one"
	if _, err := store.ApplyAuthorizedAppleLifecycle(ctx, ev, renewal, token, appleEnvProduction); !errors.Is(err, ErrBillingAuthorityConflict) {
		t.Fatalf("environment drift err=%v", err)
	}
	var environment string
	if err := store.db.QueryRowContext(ctx, `SELECT apple_environment FROM billing_authorities WHERE user_id=?`, u.ID).Scan(&environment); err != nil && !errors.Is(err, sql.ErrNoRows) {
		t.Fatal(err)
	}
	if environment != appleEnvSandbox {
		t.Fatalf("authority environment changed to %q", environment)
	}
}

func TestAuthorizedStripeLifecycleWithoutAttemptIdentityLeavesAttemptOpenAndBlocksApple(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "authority-stripe-apply@example.test", "")
	authority, err := store.AcquireBillingAuthority(ctx, BillingAuthorityRequest{UserID: u.ID, Provider: ProviderStripe, Now: 100})
	if err != nil {
		t.Fatal(err)
	}
	attempt, _, err := store.DispatchBillingPurchase(ctx, authority, "pro:monthly", 101)
	if err != nil {
		t.Fatal(err)
	}
	result, err := store.ApplyAuthorizedStripeLifecycle(ctx, SourceEvent{UserID: u.ID, Provider: ProviderStripe, PlanID: "pro", Status: "active", Cycle: "monthly", PeriodEnd: 1000, EventAt: 200, Now: 102})
	if err != nil || !result.Applied {
		t.Fatalf("stripe apply=%+v err=%v", result, err)
	}
	var state string
	if err := store.db.QueryRowContext(ctx, `SELECT state FROM billing_purchase_attempts WHERE id=?`, attempt.ID).Scan(&state); err != nil || state != "dispatched" {
		t.Fatalf("attempt state=%q err=%v", state, err)
	}
	retry, created, err := store.DispatchBillingPurchase(ctx, authority, "pro:monthly", 103)
	if err != nil {
		t.Fatal(err)
	}
	if created || retry.ID != attempt.ID {
		t.Fatalf("unrelated lifecycle released attempt A: retry=%+v created=%v", retry, created)
	}
	if _, err := store.AcquireBillingAuthority(ctx, BillingAuthorityRequest{UserID: u.ID, Provider: ProviderApple, ExternalScope: testBundleIOS, AppleAccountToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Now: 103}); !errors.Is(err, ErrBillingAuthorityConflict) {
		t.Fatalf("Apple crossed Stripe authority: %v", err)
	}
}

func TestAuthorizedStripeLifecycleResolvesOnlyMatchingPersistedCheckout(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "authority-stripe-match@example.test", "")
	authority, err := store.AcquireBillingAuthority(ctx, BillingAuthorityRequest{UserID: u.ID, Provider: ProviderStripe, Now: 100})
	if err != nil {
		t.Fatal(err)
	}
	attempt, _, err := store.DispatchBillingPurchase(ctx, authority, "price_pro_monthly", 101)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetBillingPurchaseProviderSession(ctx, u.ID, attempt.ID, "cs_match", "https://checkout.stripe.test/match"); err != nil {
		t.Fatal(err)
	}

	for name, attemptID := range map[string]string{"missing": "", "wrong": "attempt_other"} {
		t.Run(name, func(t *testing.T) {
			result, err := store.ApplyAuthorizedStripeLifecycle(ctx, SourceEvent{
				UserID: u.ID, Provider: ProviderStripe, PlanID: "pro", Status: "active", Cycle: "monthly",
				PeriodEnd: 1000, ExternalID: "sub_match", EventAt: 200, Now: 102,
				BillingAttemptID: attemptID, BillingProductID: "price_pro_monthly",
			})
			if err != nil || !result.Applied {
				t.Fatalf("apply=%+v err=%v", result, err)
			}
			var state string
			if err := store.db.QueryRowContext(ctx, `SELECT state FROM billing_purchase_attempts WHERE id=?`, attempt.ID).Scan(&state); err != nil || state != "dispatched" {
				t.Fatalf("attempt state=%q err=%v", state, err)
			}
		})
	}

	result, err := store.ApplyAuthorizedStripeLifecycle(ctx, SourceEvent{
		UserID: u.ID, Provider: ProviderStripe, PlanID: "pro", Status: "active", Cycle: "monthly",
		PeriodEnd: 1000, ExternalID: "sub_match", EventAt: 201, Now: 103,
		BillingAttemptID: attempt.ID, BillingProductID: "price_pro_monthly",
	})
	if err != nil || !result.Applied {
		t.Fatalf("matching apply=%+v err=%v", result, err)
	}
	var state, subscriptionID string
	if err := store.db.QueryRowContext(ctx, `SELECT state,provider_subscription_id FROM billing_purchase_attempts WHERE id=?`, attempt.ID).Scan(&state, &subscriptionID); err != nil {
		t.Fatal(err)
	}
	if state != "resolved" || subscriptionID != "sub_match" {
		t.Fatalf("matching canonical fact did not resolve: state=%q subscription=%q", state, subscriptionID)
	}
}

func TestAuthorizedStripeLifecycleKeepsChargeCapableAttemptOpen(t *testing.T) {
	for _, status := range []string{"incomplete", "unpaid", "paused"} {
		t.Run(status, func(t *testing.T) {
			store := newTestStore(t)
			ctx := context.Background()
			u, _ := store.UpsertUserByEmail(ctx, "stripe-open-"+status+"@example.test", "")
			authority, _ := store.AcquireBillingAuthority(ctx, BillingAuthorityRequest{UserID: u.ID, Provider: ProviderStripe, Now: 100})
			attempt, _, _ := store.DispatchBillingPurchase(ctx, authority, "price_pro_monthly", 101)
			if err := store.SetBillingPurchaseProviderSession(ctx, u.ID, attempt.ID, "cs_"+status, "https://checkout.stripe.test/"+status); err != nil {
				t.Fatal(err)
			}
			if _, err := store.ApplyAuthorizedStripeLifecycle(ctx, SourceEvent{
				UserID: u.ID, Provider: ProviderStripe, PlanID: freePlanID, Status: status,
				ExternalID: "sub_" + status, EventAt: 200, Now: 102,
				BillingAttemptID: attempt.ID, BillingProductID: "price_pro_monthly",
			}); err != nil {
				t.Fatal(err)
			}
			var state string
			if err := store.db.QueryRowContext(ctx, `SELECT state FROM billing_purchase_attempts WHERE id=?`, attempt.ID).Scan(&state); err != nil || state != "dispatched" {
				t.Fatalf("charge-capable status %q released attempt: state=%q err=%v", status, state, err)
			}
		})
	}
}

func TestBillingAuthorityBackfillTreatsLegacyAppleTokenAsStickyHistory(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "legacy-token-only@example.test", "")
	if _, err := store.EnsureAppleAccountToken(ctx, u.ID, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"); err != nil {
		t.Fatal(err)
	}
	if err := backfillBillingAuthorities(ctx, store.db, 10); err != nil {
		t.Fatal(err)
	}
	authority, ok, err := store.BillingAuthority(ctx, u.ID)
	if err != nil || !ok || authority.Provider != ProviderApple || authority.ExternalScope == "" {
		t.Fatalf("legacy token was not quarantined under Apple authority: %+v ok=%v err=%v", authority, ok, err)
	}
	if _, err := store.AcquireBillingAuthority(ctx, BillingAuthorityRequest{UserID: u.ID, Provider: ProviderStripe, Now: 11}); !errors.Is(err, ErrBillingAuthorityConflict) {
		t.Fatalf("Stripe crossed token-only Apple history: %v", err)
	}
}
