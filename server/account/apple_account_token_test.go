package account

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// POST /api/billing/apple/account-token is the whole server contract the next
// (StoreKit) batch needs: it hands the app the stable, opaque UUID it must set
// as `appAccountToken` on a purchase so the eventual App Store notification can
// be attributed to this Relayium account.
//
// It is state-changing (it may mint the token) and native-capable (the app
// authenticates with a bearer token, not a cookie), which is why it is a POST
// behind RequireAuth rather than a GET behind RequireSession.

func TestAppleAccountTokenEndpointMintsStableToken(t *testing.T) {
	ts, _, store, mail := newBillingServer(t)
	email := "apple-token-endpoint@example.com"
	cookie := loginCookie(t, ts, mail, email)

	first := postAppleToken(t, ts, cookie)
	if !validAppAccountToken(first) {
		t.Fatalf("not an RFC 4122 v4 UUID: %q", first)
	}
	if second := postAppleToken(t, ts, cookie); second != first {
		t.Fatalf("token is not stable across calls: %q then %q", first, second)
	}

	owner, ok, err := store.UserByAppleAccountToken(context.Background(), first)
	if err != nil || !ok {
		t.Fatalf("minted token does not resolve: ok=%v err=%v", ok, err)
	}
	if owner.ID != mustUserID(t, store, email) {
		t.Fatalf("token bound to the wrong account")
	}
}

// It is an account credential-adjacent identifier, not a credential: it never
// authenticates anything, and it is not published on the ordinary account
// surfaces a client already reads.
func TestAppleAccountTokenIsNotExposedByAccountEndpoints(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	svc.biller = &fakeBiller{}
	seedTiers(t, store)
	email := "apple-token-hidden@example.com"
	cookie := loginCookie(t, ts, mail, email)
	token := postAppleToken(t, ts, cookie)

	for _, path := range []string{"/api/me", "/api/me/usage"} {
		req, _ := http.NewRequest(http.MethodGet, ts.URL+path, nil)
		req.AddCookie(cookie)
		resp, err := ts.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if strings.Contains(string(raw), token) {
			t.Fatalf("%s leaks the app account token", path)
		}
	}
}

func TestAppleAccountTokenEndpointRequiresAuthAndPost(t *testing.T) {
	ts, _, _, _ := newBillingServer(t)

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/billing/apple/account-token", nil)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("want 401 unauthenticated, got %d", resp.StatusCode)
	}

	greq, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/billing/apple/account-token", nil)
	gresp, err := ts.Client().Do(greq)
	if err != nil {
		t.Fatal(err)
	}
	gresp.Body.Close()
	if gresp.StatusCode == http.StatusOK {
		t.Fatal("GET must not serve the token endpoint")
	}
}

// Two concurrent first-time requests (two devices, or a retry) converge on one
// token rather than racing two into the account.
//
// The spawned goroutines only COLLECT: every assertion happens on the parent.
// t.Fatal is documented as callable only from the goroutine running the test —
// elsewhere it exits that ONE goroutine and the test carries on with whatever
// partial data it has. The failure that produces is not the failure that
// happened: with n empty strings left behind, `got != out[0]` compares "" to ""
// and holds, so the only thing standing between a broken endpoint and a green
// convergence test is the incidental `got == ""` clause. Collecting instead
// makes the status and the error the things asserted on.
func TestAppleAccountTokenEndpointConcurrentRequestsConverge(t *testing.T) {
	ts, _, _, mail := newBillingServer(t)
	cookie := loginCookie(t, ts, mail, "apple-token-race@example.com")

	const n = 6
	out := make([]appleTokenResult, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			out[i] = requestAppleToken(ts, cookie)
		}(i)
	}
	wg.Wait()
	for i, got := range out {
		if got.err != nil {
			t.Fatalf("concurrent mint %d: %v", i, got.err)
		}
		if got.status != http.StatusOK {
			t.Fatalf("concurrent mint %d: status %d", i, got.status)
		}
		if got.token == "" || got.token != out[0].token {
			t.Fatalf("concurrent mints diverged: [%d]=%q want %q", i, got.token, out[0].token)
		}
	}
}

// The user lookup disappears at hard purge, while the opaque billing subject
// remains as a non-rebindable tombstone for late Ask-to-Buy facts.
func TestAppleAccountTokenDisappearsWithTheAccount(t *testing.T) {
	ts, _, store, mail := newBillingServer(t)
	email := "apple-token-purge@example.com"
	cookie := loginCookie(t, ts, mail, email)
	token := postAppleToken(t, ts, cookie)
	uid := mustUserID(t, store, email)

	ctx := context.Background()
	if err := store.SetAccountDeletion(ctx, uid, 1, 100); err != nil {
		t.Fatalf("schedule deletion: %v", err)
	}
	if err := store.ArchiveAndPurgeUser(ctx, uid, 200); err != nil {
		t.Fatalf("purge: %v", err)
	}
	if _, ok, err := store.UserByAppleAccountToken(ctx, token); err != nil || ok {
		t.Fatalf("token outlived the account: ok=%v err=%v", ok, err)
	}
	if subject, ok, err := store.AppleBillingSubjectByToken(ctx, token); err != nil || !ok || subject.UserID != uid || subject.DeletedAt != 200 {
		t.Fatalf("billing tombstone=%+v ok=%v err=%v", subject, ok, err)
	}
}

func TestAppleNotificationProjectionDisappearsWithTheAccount(t *testing.T) {
	ts, _, store, mail := newBillingServer(t)
	email := "apple-notification-purge@example.com"
	cookie := loginCookie(t, ts, mail, email)
	token := postAppleToken(t, ts, cookie)
	uid := mustUserID(t, store, email)
	ctx := context.Background()

	rec := AppleNotificationRecord{
		UUID: appleNotifyUUID(990), Type: "DID_RENEW", ReceivedAt: 1,
		Projection: AppleNotificationProjection{
			BundleID: "com.relayium.ios", ProductID: "relayium.pro.monthly",
			OriginalTransactionID: "purged-original-transaction", AppAccountToken: token,
			PurchaseDateMS: 1, ExpiresDateMS: 2,
		},
	}
	if _, fresh, err := store.ClaimAppleNotification(ctx, rec); err != nil || !fresh {
		t.Fatalf("claim notification: fresh=%v err=%v", fresh, err)
	}
	if err := store.SetAccountDeletion(ctx, uid, 1, 100); err != nil {
		t.Fatalf("schedule deletion: %v", err)
	}
	if err := store.ArchiveAndPurgeUser(ctx, uid, 200); err != nil {
		t.Fatalf("purge: %v", err)
	}
	if _, ok, err := store.GetAppleNotification(ctx, rec.UUID); err != nil || ok {
		t.Fatalf("notification projection outlived account: ok=%v err=%v", ok, err)
	}
}

func TestAppleNotificationProjectionPurgesThroughSubscriptionBinding(t *testing.T) {
	_, _, store, _ := newBillingServer(t)
	ctx := context.Background()
	u, err := store.UpsertUserByEmail(ctx, "apple-binding-purge@example.com", "")
	if err != nil {
		t.Fatal(err)
	}
	originalID := "binding-only-original-transaction"
	if _, err := store.ApplySubscriptionSource(ctx, SourceEvent{
		UserID: u.ID, Provider: ProviderApple, ExternalID: originalID,
		PlanID: "free", Status: "canceled", EventAt: 1, Now: 1,
	}); err != nil {
		t.Fatalf("bind subscription: %v", err)
	}
	rec := AppleNotificationRecord{
		UUID: appleNotifyUUID(991), Type: "EXPIRED", ReceivedAt: 1, Supported: true,
		Projection: AppleNotificationProjection{
			BundleID: "com.relayium.ios", ProductID: "relayium.pro.monthly",
			OriginalTransactionID: originalID, PurchaseDateMS: 1, ExpiresDateMS: 2,
		},
	}
	if _, fresh, err := store.ClaimAppleNotification(ctx, rec); err != nil || !fresh {
		t.Fatalf("claim notification: fresh=%v err=%v", fresh, err)
	}
	if err := store.SetAccountDeletion(ctx, u.ID, 1, 100); err != nil {
		t.Fatal(err)
	}
	if err := store.ArchiveAndPurgeUser(ctx, u.ID, 200); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := store.GetAppleNotification(ctx, rec.UUID); err != nil || ok {
		t.Fatalf("binding-attributed projection outlived account: ok=%v err=%v", ok, err)
	}
}

// The same purge, through a SANDBOX binding. The ledger stores the raw id Apple
// signed plus its environment, while the subscription binding stores the
// environment-QUALIFIED id, so the join has to qualify before it compares.
// Matching the raw column against the qualified id would leave a purged
// account's replayable billing identity behind, which is the one thing this
// delete exists to prevent.
func TestAppleNotificationProjectionPurgesThroughSandboxBinding(t *testing.T) {
	_, _, store, _ := newBillingServer(t)
	ctx := context.Background()
	u, err := store.UpsertUserByEmail(ctx, "apple-sandbox-binding-purge@example.com", "")
	if err != nil {
		t.Fatal(err)
	}
	originalID := "sandbox-binding-original-transaction"
	if _, err := store.ApplySubscriptionSource(ctx, SourceEvent{
		UserID: u.ID, Provider: ProviderApple,
		ExternalID: appleSandboxExternalPrefix + originalID,
		PlanID:     "free", Status: "canceled", EventAt: 1, Now: 1,
	}); err != nil {
		t.Fatalf("bind subscription: %v", err)
	}
	rec := AppleNotificationRecord{
		UUID: appleNotifyUUID(992), Type: "EXPIRED", ReceivedAt: 1, Supported: true,
		Projection: AppleNotificationProjection{
			BundleID: testBundleMac, ProductID: "relayium.pro.monthly",
			OriginalTransactionID: originalID, Environment: appleEnvSandbox,
			PurchaseDateMS: 1, ExpiresDateMS: 2,
		},
	}
	if _, fresh, err := store.ClaimAppleNotification(ctx, rec); err != nil || !fresh {
		t.Fatalf("claim notification: fresh=%v err=%v", fresh, err)
	}
	// A Production row carrying the SAME digits belongs to nobody here and must
	// survive: the purge is scoped to one account's subscriptions, not to a
	// number that happens to appear in two stores.
	other := rec
	other.UUID = appleNotifyUUID(993)
	other.Projection.Environment = appleEnvProduction
	if _, fresh, err := store.ClaimAppleNotification(ctx, other); err != nil || !fresh {
		t.Fatalf("claim production notification: fresh=%v err=%v", fresh, err)
	}

	if err := store.SetAccountDeletion(ctx, u.ID, 1, 100); err != nil {
		t.Fatal(err)
	}
	if err := store.ArchiveAndPurgeUser(ctx, u.ID, 200); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := store.GetAppleNotification(ctx, rec.UUID); err != nil || ok {
		t.Fatalf("sandbox-attributed projection outlived account: ok=%v err=%v", ok, err)
	}
	if _, ok, err := store.GetAppleNotification(ctx, other.UUID); err != nil || !ok {
		t.Fatalf("the other store's projection was purged too: ok=%v err=%v", ok, err)
	}
}

func TestDeletedAppleBillingSubjectTokenCannotBeRebound(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	owner, _ := store.UpsertUserByEmail(ctx, "deleted-billing-subject@example.test", "")
	token := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	authority, err := store.AcquireBillingAuthority(ctx, BillingAuthorityRequest{UserID: owner.ID, Provider: ProviderApple, ExternalScope: testBundleIOS, AppleAccountToken: token, Now: 100})
	if err != nil {
		t.Fatal(err)
	}
	if _, created, err := store.DispatchAppleBillingPurchase(ctx, authority, testAppleProduct, token, 101); err != nil || !created {
		t.Fatalf("dispatch created=%v err=%v", created, err)
	}
	if _, err := store.db.ExecContext(ctx, `UPDATE apple_billing_subjects SET deleted_at=200 WHERE app_account_token=?`, token); err != nil {
		t.Fatal(err)
	}
	other, _ := store.UpsertUserByEmail(ctx, "new-billing-subject@example.test", "")
	if _, err := store.EnsureAppleAccountToken(ctx, other.ID, token); err == nil {
		t.Fatal("retained Apple billing token rebound to another account")
	}
	subject, ok, err := store.AppleBillingSubjectByToken(ctx, token)
	if err != nil || !ok || subject.UserID != owner.ID || subject.DeletedAt != 200 {
		t.Fatalf("tombstone=%+v ok=%v err=%v", subject, ok, err)
	}
}

// appleTokenResult carries one call's outcome back to whoever asked for it.
type appleTokenResult struct {
	token  string
	status int
	err    error
}

// requestAppleToken performs the call and REPORTS; it touches no *testing.T, so
// it is safe to run from a spawned goroutine (see the concurrency test above).
func requestAppleToken(ts *httptest.Server, cookie *http.Cookie) appleTokenResult {
	req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/billing/apple/account-token", nil)
	if err != nil {
		return appleTokenResult{err: err}
	}
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		return appleTokenResult{err: err}
	}
	defer resp.Body.Close()
	res := appleTokenResult{status: resp.StatusCode}
	if resp.StatusCode != http.StatusOK {
		return res
	}
	var out struct {
		AppAccountToken string `json:"appAccountToken"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		res.err = err
		return res
	}
	res.token = out.AppAccountToken
	return res
}

// postAppleToken is the sequential form: it asserts, so it must only be called
// from the test goroutine.
func postAppleToken(t *testing.T, ts *httptest.Server, cookie *http.Cookie) string {
	t.Helper()
	res := requestAppleToken(ts, cookie)
	if res.err != nil {
		t.Fatal(res.err)
	}
	if res.status != http.StatusOK {
		t.Fatalf("want 200, got %d", res.status)
	}
	if res.token == "" {
		t.Fatal("empty appAccountToken")
	}
	return res.token
}
