package account

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// GET /api/billing/apple/catalog is the only thing that tells a native build
// what it may sell. Everything it says has to come from this server's own
// verifier configuration and its own `apple_products` table; nothing a client
// sends may widen either.

// appleCatalogFixture is one wired server: a live sandbox verifier configured
// for BOTH shipped bundle identities, and one authenticated account.
type appleCatalogFixture struct {
	ts     *httptest.Server
	svc    *Service
	store  *SQLiteStore
	mail   *capturingMailer
	cookie *http.Cookie
	userID string
}

func newAppleCatalogFixture(t *testing.T) *appleCatalogFixture {
	t.Helper()
	ts, svc, store, mail := newBillingServer(t)
	seedTiers(t, store)
	svc.SetAppleTransactionVerifier(testVerifier(t, newAppleTestChain(t)))
	email := "apple-catalog@example.com"
	cookie := loginCookie(t, ts, mail, email)
	return &appleCatalogFixture{
		ts: ts, svc: svc, store: store, mail: mail,
		cookie: cookie, userID: mustUserID(t, store, email),
	}
}

// get issues the request with this fixture's session. `query` is appended
// verbatim so a test can send a repeated or malformed parameter that
// url.Values would otherwise normalize away.
func (f *appleCatalogFixture) get(t *testing.T, query string) *http.Response {
	t.Helper()
	return f.getAs(t, f.cookie, query)
}

func (f *appleCatalogFixture) getAs(t *testing.T, cookie *http.Cookie, query string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, f.ts.URL+"/api/billing/apple/catalog"+query, nil)
	if err != nil {
		t.Fatal(err)
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := f.ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func (f *appleCatalogFixture) decode(t *testing.T, resp *http.Response) appleCatalogResponse {
	t.Helper()
	var out appleCatalogResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode catalog body: %v", err)
	}
	return out
}

func (f *appleCatalogFixture) productIDs(t *testing.T, query string) []string {
	t.Helper()
	resp := f.get(t, query)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}
	body := f.decode(t, resp)
	ids := make([]string, 0, len(body.Products))
	for _, p := range body.Products {
		ids = append(ids, p.ProductID)
	}
	return ids
}

const macQuery = "?bundleId=" + testBundleMac

// ── fail-closed ──────────────────────────────────────────────────────────────

// The shipping default. A deployment with no verifier configured cannot accept
// a purchase, so it must not describe one either — however many rows the
// catalog table holds.
func TestNativeAppleCatalogUnconfiguredVerifierRefusesEvenWithLiveRows(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	seedTiers(t, store)
	mustAppleProduct(t, store, AppleProduct{
		BundleID: testBundleMac, ProductID: "com.relayium.mac.pro.monthly",
		PlanID: "pro", Cycle: "monthly", Active: true,
	})
	if svc.appleTx != nil {
		t.Fatal("a fresh service must have no Apple verifier")
	}
	f := &appleCatalogFixture{ts: ts, svc: svc, store: store, mail: mail,
		cookie: loginCookie(t, ts, mail, "apple-catalog-inert@example.com")}

	resp := f.get(t, macQuery)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("want 503 with no verifier, got %d", resp.StatusCode)
	}
	if code := decodeErrBody(t, resp)["error"]; code != "verifier_unavailable" {
		t.Fatalf("want verifier_unavailable, got %q", code)
	}
}

// The verifier check runs BEFORE the parameter check, so an unconfigured
// deployment cannot be probed for which parameters it would have accepted.
func TestNativeAppleCatalogUnconfiguredVerifierOutranksAMalformedRequest(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	f := &appleCatalogFixture{ts: ts, svc: svc, store: store, mail: mail,
		cookie: loginCookie(t, ts, mail, "apple-catalog-inert-2@example.com")}

	for _, query := range []string{"", "?bundleId=", "?bundleId=a&bundleId=b"} {
		resp := f.get(t, query)
		if resp.StatusCode != http.StatusServiceUnavailable {
			resp.Body.Close()
			t.Fatalf("%q: want 503 before any parameter check, got %d", query, resp.StatusCode)
		}
		resp.Body.Close()
	}
}

func TestNativeAppleCatalogRequiresAuthentication(t *testing.T) {
	f := newAppleCatalogFixture(t)
	resp := f.getAs(t, nil, macQuery)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("want 401 for an anonymous read, got %d", resp.StatusCode)
	}
}

// ── the selector may narrow, never widen ─────────────────────────────────────

// A bundle this deployment is not configured for is refused outright. This is
// the claim that keeps the catalog from being a directory of every app identity
// anybody ever wrote a row for.
func TestNativeAppleCatalogRefusesAnUnconfiguredBundle(t *testing.T) {
	f := newAppleCatalogFixture(t)
	// A live row exists for it — and it still must not be described, because the
	// verifier would never accept a transaction naming this bundle.
	mustAppleProduct(t, f.store, AppleProduct{
		BundleID: "com.attacker.app", ProductID: "com.attacker.app.pro.monthly",
		PlanID: "pro", Cycle: "monthly", Active: true,
	})

	resp := f.get(t, "?bundleId=com.attacker.app")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("want 400 for an unconfigured bundle, got %d", resp.StatusCode)
	}
	if code := decodeErrBody(t, resp)["error"]; code != "unknown_bundle" {
		t.Fatalf("want unknown_bundle, got %q", code)
	}
}

// The selector cannot be omitted into "everything", and it cannot be doubled
// into an ambiguous request whose answer depends on a first/last convention.
func TestNativeAppleCatalogRefusesAnAmbiguousOrMissingSelector(t *testing.T) {
	f := newAppleCatalogFixture(t)
	mustAppleProduct(t, f.store, AppleProduct{
		BundleID: testBundleMac, ProductID: "com.relayium.mac.pro.monthly",
		PlanID: "pro", Cycle: "monthly", Active: true,
	})

	long := "?bundleId=" + strings.Repeat("a", appleProductKeyMaxLen+1)
	for _, query := range []string{
		"",                                   // no selector at all
		"?bundleId=",                         // present and empty
		"?bundleId=%20",                      // whitespace only
		"?bundleId=" + testBundleMac + "%20", // trailing space: not the configured string
		"?bundleId=%20" + testBundleMac,      // leading space
		"?bundleId=" + testBundleMac + "&bundleId=" + testBundleIOS, // two apps
		"?bundleId=" + testBundleMac + "&bundleId=" + testBundleMac, // the same app twice
		long,
	} {
		resp := f.get(t, query)
		body := decodeErrBody(t, resp)
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("%q: want 400, got %d", query, resp.StatusCode)
		}
		if body["error"] != "invalid_request" {
			t.Fatalf("%q: want invalid_request, got %q", query, body["error"])
		}
	}
}

// A configured bundle answers only for ITSELF. macOS and iOS ship different
// products for the same tiers, and a client offered the other platform's
// identifier would start a purchase the store cannot complete.
func TestNativeAppleCatalogNeverDescribesAnotherConfiguredApp(t *testing.T) {
	f := newAppleCatalogFixture(t)
	mustAppleProduct(t, f.store, AppleProduct{
		BundleID: testBundleMac, ProductID: "com.relayium.mac.pro.monthly",
		PlanID: "pro", Cycle: "monthly", Active: true,
	})
	mustAppleProduct(t, f.store, AppleProduct{
		BundleID: testBundleIOS, ProductID: "com.relayium.app.pro.monthly",
		PlanID: "pro", Cycle: "monthly", Active: true,
	})

	if got := f.productIDs(t, macQuery); len(got) != 1 || got[0] != "com.relayium.mac.pro.monthly" {
		t.Fatalf("macOS catalog leaked another app's products: %v", got)
	}
	if got := f.productIDs(t, "?bundleId="+testBundleIOS); len(got) != 1 ||
		got[0] != "com.relayium.app.pro.monthly" {
		t.Fatalf("iOS catalog leaked another app's products: %v", got)
	}
}

// The response names the CONFIGURED identity rather than echoing the request,
// so nothing a caller typed is reflected back as an accepted app identity.
func TestNativeAppleCatalogEchoesTheConfiguredBundleIdentity(t *testing.T) {
	f := newAppleCatalogFixture(t)
	resp := f.get(t, macQuery)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}
	if got := f.decode(t, resp).BundleID; got != testBundleMac {
		t.Fatalf("want the configured bundle %q, got %q", testBundleMac, got)
	}
}

// ── only live rows, and the same definition of live ──────────────────────────

// The four operator-visible states, and only one of them may be sold. Each of
// the other three is a product whose purchase the intake would refuse AFTER the
// customer had been charged.
func TestNativeAppleCatalogDescribesOnlyRowsAPurchaseWouldResolve(t *testing.T) {
	f := newAppleCatalogFixture(t)
	ctx := context.Background()

	mustAppleProduct(t, f.store, AppleProduct{
		BundleID: testBundleMac, ProductID: "live.monthly",
		PlanID: "pro", Cycle: "monthly", Active: true,
	})
	// Retired: the mapping's own switch is off.
	mustAppleProduct(t, f.store, AppleProduct{
		BundleID: testBundleMac, ProductID: "retired.monthly",
		PlanID: "pro", Cycle: "monthly", Active: false,
	})
	// plan_inactive: the row is untouched and its tier was taken off sale. This
	// is the one that LOOKS fine in the table.
	mustAppleProduct(t, f.store, AppleProduct{
		BundleID: testBundleMac, ProductID: "withdrawn.monthly",
		PlanID: "max", Cycle: "monthly", Active: true,
	})
	max, ok, err := f.store.GetPlan(ctx, "max")
	if err != nil || !ok {
		t.Fatalf("GetPlan(max): %v ok=%v", err, ok)
	}
	max.Active = false
	mustPlan(t, f.store, max)

	got := f.productIDs(t, macQuery)
	if len(got) != 1 || got[0] != "live.monthly" {
		t.Fatalf("want only the live row, got %v", got)
	}

	// And the operator view still shows all three, so this endpoint narrowed the
	// answer rather than the table.
	rows, err := f.store.ListAppleProducts(ctx)
	if err != nil {
		t.Fatalf("ListAppleProducts: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("the admin view lost rows: %+v", rows)
	}
}

// A row pointing at a tier that is not there at all. Unreachable through any
// write path (the foreign key is real), represented anyway — because the one
// thing this endpoint must never do is offer a product with no tier behind it.
func TestNativeAppleCatalogHidesAMappingWhoseTierIsGone(t *testing.T) {
	f := newAppleCatalogFixture(t)
	// Written with the foreign key off, exactly as the admin guard describes the
	// only way such a row can come to exist.
	seedOrphanAppleProduct(t, f.store, testBundleMac, "orphan.monthly", "gone")
	if got := f.productIDs(t, macQuery); len(got) != 0 {
		t.Fatalf("a mapping with no tier was offered for sale: %v", got)
	}
}

// What each described row carries, and what it deliberately does not: the plan
// display facts a purchase screen needs, and no price — the storefront's price
// is Apple's to state.
func TestNativeAppleCatalogCarriesPlanDisplayFactsAndNoPrice(t *testing.T) {
	f := newAppleCatalogFixture(t)
	mustAppleProduct(t, f.store, AppleProduct{
		BundleID: testBundleMac, ProductID: "com.relayium.mac.pro.yearly",
		PlanID: "pro", Cycle: "yearly", Active: true,
	})
	pro, ok, err := f.store.GetPlan(context.Background(), "pro")
	if err != nil || !ok {
		t.Fatalf("GetPlan(pro): %v ok=%v", err, ok)
	}

	resp := f.get(t, macQuery)
	defer resp.Body.Close()
	raw, body := readAll(t, resp), appleCatalogResponse{}
	if err := json.Unmarshal([]byte(raw), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Products) != 1 {
		t.Fatalf("want one product, got %+v", body.Products)
	}
	p := body.Products[0]
	if p.PlanID != "pro" || p.PlanName != pro.Name || p.Cycle != "yearly" ||
		p.SortOrder != pro.SortOrder {
		t.Fatalf("plan display facts are wrong: %+v (plan %+v)", p, pro)
	}
	for _, leak := range []string{"price", "Price", "expiresAt", "subscriptionStatus"} {
		if strings.Contains(string(raw), leak) {
			t.Fatalf("the catalog body carries %q: %s", leak, raw)
		}
	}
}

// Deterministic order by the deployment's own tier rank, then cycle. A purchase
// screen renders this list as given; two renders must not disagree.
func TestNativeAppleCatalogOrdersByTierRankThenCycle(t *testing.T) {
	f := newAppleCatalogFixture(t)
	for _, p := range []AppleProduct{
		{ProductID: "z.max.yearly", PlanID: "max", Cycle: "yearly"},
		{ProductID: "a.pro.yearly", PlanID: "pro", Cycle: "yearly"},
		{ProductID: "m.max.monthly", PlanID: "max", Cycle: "monthly"},
		{ProductID: "b.pro.monthly", PlanID: "pro", Cycle: "monthly"},
	} {
		p.BundleID, p.Active = testBundleMac, true
		mustAppleProduct(t, f.store, p)
	}
	pro, _, _ := f.store.GetPlan(context.Background(), "pro")
	max, _, _ := f.store.GetPlan(context.Background(), "max")
	if !(max.SortOrder > pro.SortOrder) {
		t.Skipf("the seeded tiers do not rank max above pro (%d vs %d)", max.SortOrder, pro.SortOrder)
	}

	want := []string{"b.pro.monthly", "a.pro.yearly", "m.max.monthly", "z.max.yearly"}
	got := f.productIDs(t, macQuery)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("want %v, got %v", want, got)
	}
}

// A configured deployment with nothing mapped answers 200 and an empty list —
// distinct from the 503 that means "this deployment can verify nothing". The
// client renders "nothing to sell" for one and stays inert for the other.
func TestNativeAppleCatalogAnswersEmptyRatherThanRefusingWhenNothingIsMapped(t *testing.T) {
	f := newAppleCatalogFixture(t)
	resp := f.get(t, macQuery)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200 for a configured deployment with no rows, got %d", resp.StatusCode)
	}
	body := f.decode(t, resp)
	if len(body.Products) != 0 {
		t.Fatalf("want no products, got %+v", body.Products)
	}
	if !body.Purchase.Allowed {
		t.Fatalf("a free account may purchase: %+v", body.Purchase)
	}
}

// ── eligibility ──────────────────────────────────────────────────────────────

// A live Stripe subscription blocks an App Store purchase, named so the client
// can say where the subscription is managed. Apple cannot see a Stripe
// subscription, so the two would both bill while the effective projection
// granted no more than the higher one already did.
func TestNativeAppleCatalogBlocksPurchaseForALiveStripeSubscriber(t *testing.T) {
	f := newAppleCatalogFixture(t)
	if _, err := f.store.ApplySubscriptionSource(context.Background(), SourceEvent{
		UserID: f.userID, Provider: ProviderStripe, PlanID: "pro", Status: "active",
		Cycle: "monthly", PeriodEnd: 1_900_000_000, EventAt: 100, Now: time.Now().Unix(),
	}); err != nil {
		t.Fatalf("ApplySubscriptionSource(stripe): %v", err)
	}

	resp := f.get(t, macQuery)
	defer resp.Body.Close()
	body := f.decode(t, resp)
	if body.Purchase.Allowed || body.Purchase.BlockedBy != ProviderStripe {
		t.Fatalf("a live Stripe subscriber may not buy through the App Store: %+v", body.Purchase)
	}
}

// An admin comp blocks too: the account already has its access, and a purchase
// would charge for something granted.
func TestNativeAppleCatalogBlocksPurchaseForAnAdminComp(t *testing.T) {
	f := newAppleCatalogFixture(t)
	if err := f.store.SetUserPlanAdmin(context.Background(), f.userID, "max",
		time.Now().Unix()); err != nil {
		t.Fatalf("SetUserPlanAdmin: %v", err)
	}

	resp := f.get(t, macQuery)
	defer resp.Body.Close()
	body := f.decode(t, resp)
	if body.Purchase.Allowed || body.Purchase.BlockedBy != SourceAdmin {
		t.Fatalf("an admin-comped account may not buy: %+v", body.Purchase)
	}
}

// An EXISTING Apple subscriber stays eligible. Changing tier inside the
// subscription group is itself an App Store purchase, and refusing it would
// leave a subscriber with no way to upgrade from the app that sold to them.
func TestNativeAppleCatalogKeepsAnExistingAppleSubscriberEligible(t *testing.T) {
	f := newAppleCatalogFixture(t)
	appleSubscriber(t, f.store, f.userID, "pro")

	resp := f.get(t, macQuery)
	defer resp.Body.Close()
	body := f.decode(t, resp)
	if !body.Purchase.Allowed || body.Purchase.BlockedBy != "" {
		t.Fatalf("an Apple subscriber must stay able to change tier: %+v", body.Purchase)
	}
}

// The double-billed state blocks, and is named 'multiple' — the same word
// `/api/me` shows for it. An account already paying twice must not be sold a
// third subscription, even though one of the two is Apple's own; what it needs
// is the management surface, not another purchase.
func TestNativeAppleCatalogBlocksADoubleBilledAccountAsMultiple(t *testing.T) {
	f := newAppleCatalogFixture(t)
	ctx := context.Background()
	appleSubscriber(t, f.store, f.userID, "pro")
	if _, err := f.store.ApplySubscriptionSource(ctx, SourceEvent{
		UserID: f.userID, Provider: ProviderStripe, PlanID: "pro", Status: "active",
		Cycle: "monthly", PeriodEnd: 1_900_000_000, EventAt: 100, Now: time.Now().Unix(),
	}); err != nil {
		t.Fatalf("ApplySubscriptionSource(stripe): %v", err)
	}

	resp := f.get(t, macQuery)
	defer resp.Body.Close()
	body := f.decode(t, resp)
	if body.Purchase.Allowed || body.Purchase.BlockedBy != ProviderMultiple {
		t.Fatalf("a double-billed account may not buy a third subscription: %+v", body.Purchase)
	}
}

// An admin comp blocks even beside a live Apple subscription. The grant — not
// the subscription — is what the account renders, so selling a tier change
// against it would charge for something the projection may never show.
func TestNativeAppleCatalogAdminCompBlocksEvenAnAppleSubscriber(t *testing.T) {
	f := newAppleCatalogFixture(t)
	appleSubscriber(t, f.store, f.userID, "pro")
	if err := f.store.SetUserPlanAdmin(context.Background(), f.userID, "max",
		time.Now().Unix()); err != nil {
		t.Fatalf("SetUserPlanAdmin: %v", err)
	}

	resp := f.get(t, macQuery)
	defer resp.Body.Close()
	body := f.decode(t, resp)
	if body.Purchase.Allowed || body.Purchase.BlockedBy != SourceAdmin {
		t.Fatalf("an admin comp must outrank an Apple subscription: %+v", body.Purchase)
	}
}

// The eligibility answer is derived from the same two facts `/api/me` reports
// `entitlementProvider` from, so the account screen and the purchase screen
// cannot disagree about who owns the entitlement.
func TestNativeAppleCatalogEligibilityAgreesWithTheAccountProjection(t *testing.T) {
	f := newAppleCatalogFixture(t)
	ctx := context.Background()
	if _, err := f.store.ApplySubscriptionSource(ctx, SourceEvent{
		UserID: f.userID, Provider: ProviderStripe, PlanID: "pro", Status: "active",
		Cycle: "monthly", PeriodEnd: 1_900_000_000, EventAt: 100, Now: time.Now().Unix(),
	}); err != nil {
		t.Fatalf("ApplySubscriptionSource(stripe): %v", err)
	}
	u, err := f.store.GetUserByID(ctx, f.userID)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	live, err := f.store.LiveEntitlementProviders(ctx, f.userID)
	if err != nil {
		t.Fatalf("LiveEntitlementProviders: %v", err)
	}

	resp := f.get(t, macQuery)
	defer resp.Body.Close()
	body := f.decode(t, resp)
	if body.Purchase.BlockedBy != entitlementProviderWire(u, live) {
		t.Fatalf("catalog says %q, /api/me says %q",
			body.Purchase.BlockedBy, entitlementProviderWire(u, live))
	}
}

// ── never cached ─────────────────────────────────────────────────────────────

// The catalog is per-account and is re-read by the client immediately before a
// sale, so no cache — shared or local — may ever answer in the server's place.
func TestNativeAppleCatalogSuccessIsMarkedUncacheable(t *testing.T) {
	f := newAppleCatalogFixture(t)
	resp := f.get(t, macQuery)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("want Cache-Control %q, got %q", "private, no-store", got)
	}
}

// The refusals carry it too. A cached 400 or 503 would outlive the
// configuration change that repairs it, leaving a corrected deployment still
// answering with yesterday's refusal.
func TestNativeAppleCatalogRefusalsAreMarkedUncacheable(t *testing.T) {
	f := newAppleCatalogFixture(t)
	resp := f.get(t, "?bundleId=com.attacker.app")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("want Cache-Control %q on a refusal, got %q", "private, no-store", got)
	}
}

// ── the two truth sources stay separate ──────────────────────────────────────

// A catalog row cannot switch verification on, and reading the catalog cannot
// make a purchase land. The intake keeps refusing while the verifier is
// unconfigured, exactly as production does today.
func TestNativeAppleCatalogRowsCannotActivateTheVerifier(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	seedTiers(t, store)
	mustAppleProduct(t, store, AppleProduct{
		BundleID: testBundleMac, ProductID: "com.relayium.mac.pro.monthly",
		PlanID: "pro", Cycle: "monthly", Active: true,
	})
	cookie := loginCookie(t, ts, mail, "apple-catalog-inert-3@example.com")

	resp := postBilling(t, ts, cookie, "/api/billing/apple/transaction",
		`{"signedTransactionInfo":"a.b.c"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("want 503 from the intake, got %d", resp.StatusCode)
	}
	if svc.appleTx != nil {
		t.Fatal("a catalog row built a verifier")
	}
}
