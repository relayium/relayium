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
	attempt, created, err := store.DispatchAppleBillingPurchase(ctx, authority, testAppleProduct, token, 101)
	if err != nil || !created {
		t.Fatalf("dispatch created=%v err=%v", created, err)
	}
	ev := SourceEvent{UserID: u.ID, Provider: ProviderApple, PlanID: "pro", Status: "active", Cycle: "monthly", PeriodEnd: 1000, ExternalID: "production:original-one", ExternalScope: testBundleIOS, BillingProductID: testAppleProduct, AppleTransactionReason: "PURCHASE", ApplePurchaseDateMS: 102000, EventAt: 200, Now: 102}
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
	next, created, err := store.DispatchAppleBillingPurchase(ctx, got, "com.relayium.app.max.monthly", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", 103)
	if err != nil || !created || next.Epoch != got.Epoch {
		t.Fatalf("next canonical generation dispatch=%+v created=%v err=%v", next, created, err)
	}
}

func TestAuthorizedAppleLifecycleProductMismatchAppliesFactWithoutResolvingAttempt(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "authority-apple-ambiguous@example.test", "")
	token := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	authority, err := store.AcquireBillingAuthority(ctx, BillingAuthorityRequest{UserID: u.ID, Provider: ProviderApple, ExternalScope: testBundleIOS, AppleAccountToken: token, Now: 100})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = store.DispatchAppleBillingPurchase(ctx, authority, "expected.product", token, 101); err != nil {
		t.Fatal(err)
	}
	ev := SourceEvent{UserID: u.ID, Provider: ProviderApple, PlanID: "pro", Status: "active", Cycle: "monthly", PeriodEnd: 1000, ExternalID: "production:other", ExternalScope: testBundleIOS, EventAt: 200, Now: 102}
	renewal := AppleRenewalState{UserID: u.ID, ExternalID: ev.ExternalID, BundleID: testBundleIOS, CurrentProductID: "different.product", AutoRenewProductID: "different.product", EventAt: 201, UpdatedAt: 102}
	if result, err := store.ApplyAuthorizedAppleLifecycle(ctx, ev, renewal, token, appleEnvProduction); err != nil || !result.Applied {
		t.Fatalf("canonical lifecycle must apply while purchase remains unresolved: result=%+v err=%v", result, err)
	}
	got, _, _ := store.BillingAuthority(ctx, u.ID)
	if got.AppleEnvironment != appleEnvProduction || got.Epoch != authority.Epoch {
		t.Fatalf("lifecycle must bind environment without resolving mismatched purchase: %+v", got)
	}
	if src, ok, err := store.GetSubscriptionSource(ctx, u.ID, ProviderApple); err != nil || !ok || src.PlanID != "pro" {
		t.Fatalf("canonical lifecycle not projected: source=%+v ok=%v err=%v", src, ok, err)
	}
	var state string
	if err := store.db.QueryRowContext(ctx, `SELECT state FROM billing_purchase_attempts WHERE user_id=?`, u.ID).Scan(&state); err != nil || state != "dispatched" {
		t.Fatalf("failed apply changed attempt: state=%q err=%v", state, err)
	}
	var renewalCount int
	if err := store.db.QueryRowContext(ctx, `SELECT count(*) FROM apple_renewal_states WHERE user_id=?`, u.ID).Scan(&renewalCount); err != nil || renewalCount != 1 {
		t.Fatalf("canonical renewal not projected: count=%d err=%v", renewalCount, err)
	}
}

func TestAuthorizedAppleLifecyclePromotesSandboxToProductionAndNeverRegresses(t *testing.T) {
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
	renewal.ExternalID = ev.ExternalID
	if result, err := store.ApplyAuthorizedAppleLifecycle(ctx, ev, renewal, token, appleEnvProduction); err != nil || !result.Applied {
		t.Fatalf("production promotion result=%+v err=%v", result, err)
	}
	var environment string
	if err := store.db.QueryRowContext(ctx, `SELECT apple_environment FROM billing_authorities WHERE user_id=?`, u.ID).Scan(&environment); err != nil && !errors.Is(err, sql.ErrNoRows) {
		t.Fatal(err)
	}
	if environment != appleEnvProduction {
		t.Fatalf("authority environment changed to %q", environment)
	}
	ev.ExternalID = "sandbox:later"
	ev.EventAt++
	renewal.ExternalID = ev.ExternalID
	renewal.EventAt++
	if result, err := store.ApplyAuthorizedAppleLifecycle(ctx, ev, renewal, token, appleEnvSandbox); err != nil || result.Applied {
		t.Fatalf("sandbox regression result=%+v err=%v", result, err)
	}
}

func TestAppleRenewalAndOldTokenCannotResolveANewerPurchaseAttempt(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "authority-apple-old-token@example.test", "")
	firstToken := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	authority, err := store.AcquireBillingAuthority(ctx, BillingAuthorityRequest{UserID: u.ID, Provider: ProviderApple, ExternalScope: testBundleIOS, AppleAccountToken: firstToken, Now: 100})
	if err != nil {
		t.Fatal(err)
	}
	first, created, err := store.DispatchAppleBillingPurchase(ctx, authority, "plus.monthly", firstToken, 101)
	if err != nil || !created {
		t.Fatalf("first dispatch=%+v created=%v err=%v", first, created, err)
	}
	purchase := SourceEvent{UserID: u.ID, Provider: ProviderApple, PlanID: "plus", Status: "active", Cycle: "monthly", PeriodEnd: 1000, ExternalID: "production:original", ExternalScope: testBundleIOS, BillingProductID: "plus.monthly", AppleTransactionReason: "PURCHASE", ApplePurchaseDateMS: 102000, EventAt: 200, Now: 102}
	if result, err := store.ApplyAuthorizedAppleSource(ctx, purchase, firstToken, appleEnvProduction, purchase.BillingProductID); err != nil || !result.Applied {
		t.Fatalf("first purchase result=%+v err=%v", result, err)
	}
	authority, _, _ = store.BillingAuthority(ctx, u.ID)
	secondToken := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	second, created, err := store.DispatchAppleBillingPurchase(ctx, authority, "pro.monthly", secondToken, 103)
	if err != nil || !created {
		t.Fatalf("second dispatch=%+v created=%v err=%v", second, created, err)
	}
	renewal := purchase
	renewal.EventAt = 202
	renewal.Now = 104
	renewal.PeriodEnd = 2000
	renewal.AppleTransactionReason = "RENEWAL"
	if result, err := store.ApplyAuthorizedAppleSource(ctx, renewal, firstToken, appleEnvProduction, renewal.BillingProductID); err != nil || !result.Applied {
		t.Fatalf("old-token renewal result=%+v err=%v", result, err)
	}
	var state string
	if err := store.db.QueryRowContext(ctx, `SELECT state FROM billing_purchase_attempts WHERE id=?`, second.ID).Scan(&state); err != nil || state != "dispatched" {
		t.Fatalf("old renewal resolved new attempt: state=%q err=%v", state, err)
	}
	src, ok, err := store.GetSubscriptionSource(ctx, u.ID, ProviderApple)
	if err != nil || !ok || src.PeriodEnd != renewal.PeriodEnd {
		t.Fatalf("old subscription lifecycle was blocked: source=%+v ok=%v err=%v", src, ok, err)
	}
}

func TestApplePurchaseBeforeDispatchDoesNotResolveAttempt(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "authority-apple-pre-dispatch@example.test", "")
	token := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	authority, err := store.AcquireBillingAuthority(ctx, BillingAuthorityRequest{UserID: u.ID, Provider: ProviderApple, ExternalScope: testBundleIOS, AppleAccountToken: token, Now: 100})
	if err != nil {
		t.Fatal(err)
	}
	attempt, _, err := store.DispatchAppleBillingPurchase(ctx, authority, testAppleProduct, token, 200)
	if err != nil {
		t.Fatal(err)
	}
	ev := SourceEvent{UserID: u.ID, Provider: ProviderApple, PlanID: "pro", Status: "active", Cycle: "monthly", PeriodEnd: 1000, ExternalID: "production:old", ExternalScope: testBundleIOS, BillingProductID: testAppleProduct, AppleTransactionReason: "PURCHASE", ApplePurchaseDateMS: 199000, EventAt: 400, Now: 201}
	if result, err := store.ApplyAuthorizedAppleSource(ctx, ev, token, appleEnvProduction, testAppleProduct); err != nil || !result.Applied {
		t.Fatalf("canonical old purchase result=%+v err=%v", result, err)
	}
	var state string
	if err := store.db.QueryRowContext(ctx, `SELECT state FROM billing_purchase_attempts WHERE id=?`, attempt.ID).Scan(&state); err != nil || state != "dispatched" {
		t.Fatalf("pre-dispatch purchase resolved attempt: state=%q err=%v", state, err)
	}
}

func TestBillingHistoryRejectsLegacyAppleTokenAndStripeHistory(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "ambiguous-provider-history@example.test", "")
	if _, err := store.db.ExecContext(ctx, `UPDATE users SET apple_account_token=?,stripe_customer_id=? WHERE id=?`, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "cus_legacy", u.ID); err != nil {
		t.Fatal(err)
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := billingHistoryTx(ctx, tx, u.ID); !errors.Is(err, ErrBillingAuthorityConflict) {
		t.Fatalf("ambiguous Apple+Stripe history error=%v", err)
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

func TestLegacyAppleTokenDoesNotBlockPerDispatchPurchaseToken(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "legacy-to-dispatch-token@example.test", "")
	legacy := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	if _, err := store.EnsureAppleAccountToken(ctx, u.ID, legacy); err != nil {
		t.Fatal(err)
	}
	dispatch := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	authority, err := store.AcquireBillingAuthority(ctx, BillingAuthorityRequest{UserID: u.ID, Provider: ProviderApple, ExternalScope: testBundleIOS, AppleAccountToken: dispatch, Now: 100})
	if err != nil || authority.AppleAccountToken != legacy {
		t.Fatalf("authority=%+v err=%v", authority, err)
	}
	attempt, created, err := store.DispatchAppleBillingPurchase(ctx, authority, testAppleProduct, dispatch, 101)
	if err != nil || !created || attempt.AppleAccountToken != dispatch {
		t.Fatalf("attempt=%+v created=%v err=%v", attempt, created, err)
	}
}
