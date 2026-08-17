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
	var state string
	if err := store.db.QueryRowContext(ctx, `SELECT state FROM billing_purchase_attempts WHERE id=?`, attempt.ID).Scan(&state); err != nil || state != "resolved" {
		t.Fatalf("attempt state=%q err=%v", state, err)
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

func TestAuthorizedStripeLifecycleResolvesAttemptAndBlocksApple(t *testing.T) {
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
	if err := store.db.QueryRowContext(ctx, `SELECT state FROM billing_purchase_attempts WHERE id=?`, attempt.ID).Scan(&state); err != nil || state != "resolved" {
		t.Fatalf("attempt state=%q err=%v", state, err)
	}
	if _, err := store.AcquireBillingAuthority(ctx, BillingAuthorityRequest{UserID: u.ID, Provider: ProviderApple, ExternalScope: testBundleIOS, AppleAccountToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Now: 103}); !errors.Is(err, ErrBillingAuthorityConflict) {
		t.Fatalf("Apple crossed Stripe authority: %v", err)
	}
}
