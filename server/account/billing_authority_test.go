package account

import (
	"context"
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
