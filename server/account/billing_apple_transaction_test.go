package account

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// POST /api/billing/apple/transaction is the first place a native client can
// change a Relayium entitlement. Everything it grants must come from Apple's
// signature and the server's own configuration — never from a field the client
// decoded, and never from possession of an attribution token.

const testAppleProduct = "com.relayium.app.pro.monthly"

// appleTxFixture is one wired server: a live verifier anchored on a test root,
// one mapped product, and one authenticated account holding its app account
// token.
type appleTxFixture struct {
	ts       *httptest.Server
	svc      *Service
	store    *SQLiteStore
	mail     *capturingMailer
	chain    *appleTestChain
	verifier *AppleTransactionVerifier
	cookie   *http.Cookie
	userID   string
	token    string
}

func newAppleTxFixture(t *testing.T) *appleTxFixture {
	t.Helper()
	ts, svc, store, mail := newBillingServer(t)
	seedTiers(t, store)
	chain := newAppleTestChain(t)
	verifier := testVerifier(t, chain)
	svc.SetAppleTransactionVerifier(verifier)
	svc.SetAppleSubscriptionReconciler(appleReconcilerFunc(func(_ context.Context, tx VerifiedAppleTransaction, now time.Time) (AppleSubscriptionCanonical, error) {
		return AppleSubscriptionCanonical{Transaction: tx, Renewal: VerifiedAppleRenewalInfo{
			OriginalTransactionID: tx.OriginalTransactionID, AutoRenewProductID: tx.ProductID,
			Environment: tx.Environment, RenewalDateMS: tx.ExpiresDateMS, SignedDateMS: now.UnixMilli(),
		}}, nil
	}))
	mustAppleProduct(t, store, AppleProduct{
		BundleID: testBundleIOS, ProductID: testAppleProduct,
		PlanID: "pro", Cycle: "monthly", Active: true,
	})
	email := "apple-tx@example.com"
	cookie := loginCookie(t, ts, mail, email)
	f := &appleTxFixture{
		ts: ts, svc: svc, store: store, mail: mail, chain: chain, verifier: verifier,
		cookie: cookie, userID: mustUserID(t, store, email),
	}
	f.token = postAppleToken(t, ts, cookie)
	return f
}

func mustAppleProduct(t *testing.T, store *SQLiteStore, p AppleProduct) {
	t.Helper()
	if err := store.UpsertAppleProduct(context.Background(), p); err != nil {
		t.Fatalf("UpsertAppleProduct(%s/%s): %v", p.BundleID, p.ProductID, err)
	}
}

// payload builds a transaction for THIS fixture's account and mapped product.
func (f *appleTxFixture) payload(mut ...func(map[string]any)) map[string]any {
	return applePayload(append([]func(map[string]any){func(p map[string]any) {
		p["appAccountToken"] = f.token
		p["productId"] = testAppleProduct
	}}, mut...)...)
}

func (f *appleTxFixture) submit(t *testing.T, jws string) *http.Response {
	t.Helper()
	return f.submitAs(t, f.cookie, jws)
}

func (f *appleTxFixture) submitAs(t *testing.T, cookie *http.Cookie, jws string) *http.Response {
	t.Helper()
	renewal := map[string]any{"originalTransactionId": "2000000000000001", "autoRenewProductId": testAppleProduct,
		"environment": appleEnvProduction, "signedDate": time.Now().UnixMilli()}
	if tx, err := f.verifier.verifyTransactionIdentity(jws, time.Now()); err == nil {
		renewal["originalTransactionId"] = tx.OriginalTransactionID
		renewal["autoRenewProductId"] = tx.ProductID
		renewal["environment"] = tx.Environment
	}
	return f.post(t, cookie, string(mustJSON(t, map[string]string{"signedTransactionInfo": jws,
		"signedRenewalInfo": f.chain.sign(t, renewal)})))
}

type appleReconcilerFunc func(context.Context, VerifiedAppleTransaction, time.Time) (AppleSubscriptionCanonical, error)

func (f appleReconcilerFunc) CanonicalSubscription(ctx context.Context, tx VerifiedAppleTransaction, now time.Time) (AppleSubscriptionCanonical, error) {
	return f(ctx, tx, now)
}

func (f *appleTxFixture) post(t *testing.T, cookie *http.Cookie, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, f.ts.URL+"/api/billing/apple/transaction", strings.NewReader(body))
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

// appleTxResult mirrors the endpoint's success body.
type appleTxResult struct {
	Applied   bool   `json:"applied"`
	PlanID    string `json:"planId"`
	Status    string `json:"status"`
	ExpiresAt int64  `json:"expiresAt"`
	Provider  string `json:"provider"`
}

func (f *appleTxFixture) mustAccept(t *testing.T, jws string) (appleTxResult, string) {
	t.Helper()
	resp := f.submit(t, jws)
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d (%s)", resp.StatusCode, raw)
	}
	var out appleTxResult
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("decode: %v (%s)", err, raw)
	}
	return out, string(raw)
}

func (f *appleTxFixture) mustReject(t *testing.T, jws string, status int, code string) {
	t.Helper()
	resp := f.submit(t, jws)
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != status {
		t.Fatalf("want %d, got %d (%s)", status, resp.StatusCode, raw)
	}
	var body map[string]string
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("decode: %v (%s)", err, raw)
	}
	if body["error"] != code {
		t.Fatalf("want error %q, got %q", code, body["error"])
	}
}

func (f *appleTxFixture) user(t *testing.T) User {
	t.Helper()
	u, err := f.store.GetUserByID(context.Background(), f.userID)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func (f *appleTxFixture) appleSource(t *testing.T) (SubscriptionSource, bool) {
	t.Helper()
	src, ok, err := f.store.GetSubscriptionSource(context.Background(), f.userID, ProviderApple)
	if err != nil {
		t.Fatal(err)
	}
	return src, ok
}

// ── The accepting path ───────────────────────────────────────────────────────

func TestAppleTransactionGrantsOnlyTheAuthenticatedUser(t *testing.T) {
	f := newAppleTxFixture(t)
	// A second account that must be untouched by anything below.
	_ = loginCookie(t, f.ts, f.mail, "apple-tx-bystander@example.com")
	otherID := mustUserID(t, f.store, "apple-tx-bystander@example.com")

	expires := time.Now().Add(30 * 24 * time.Hour).UnixMilli()
	jws := f.chain.sign(t, f.payload(func(p map[string]any) { p["expiresDate"] = expires }))
	got, raw := f.mustAccept(t, jws)

	if !got.Applied || got.PlanID != "pro" || got.Status != "active" || got.Provider != ProviderApple {
		t.Fatalf("unexpected result: %+v", got)
	}
	if got.ExpiresAt != expires/1000 {
		t.Fatalf("expiresAt = %d, want %d", got.ExpiresAt, expires/1000)
	}
	// Nothing the client sent (or that identifies the purchase) comes back.
	for _, secret := range []string{f.token, jws, "2000000000000001"} {
		if strings.Contains(raw, secret) {
			t.Fatalf("response echoed submitted material: %s", raw)
		}
	}

	u := f.user(t)
	if u.PlanID != "pro" || u.PlanSource != ProviderApple || u.SubscriptionStatus != "active" {
		t.Fatalf("effective entitlement not applied: %+v", u)
	}
	if u.BillingCycle != "monthly" {
		t.Fatalf("cycle came from somewhere other than the mapping: %q", u.BillingCycle)
	}
	src, ok := f.appleSource(t)
	// The recorded subscription identity is ENVIRONMENT-QUALIFIED: this fixture
	// signs Sandbox payloads, so the binding lives in the sandbox namespace and
	// the bare originalTransactionId — which is a different, Production
	// subscription's identity — resolves to nobody.
	if !ok || src.PlanID != "pro" || src.ExternalID != testAppleSandboxExternalID {
		t.Fatalf("apple source row: ok=%v %+v", ok, src)
	}
	if owner, ok, err := f.store.UserByExternalSubscription(context.Background(), ProviderApple, "2000000000000001"); err != nil || ok {
		t.Fatalf("the raw originalTransactionId must own nothing: %q ok=%v err=%v", owner, ok, err)
	}
	// The original transaction id, in its own environment, is owned by exactly
	// this account.
	owner, ok, err := f.store.UserByExternalSubscription(context.Background(), ProviderApple, testAppleSandboxExternalID)
	if err != nil || !ok || owner != f.userID {
		t.Fatalf("external subscription owner: %q ok=%v err=%v", owner, ok, err)
	}

	// The bystander gained nothing: no plan, no Apple source row.
	other, err := f.store.GetUserByID(context.Background(), otherID)
	if err != nil {
		t.Fatal(err)
	}
	if other.PlanID != "free" || other.PlanSource == ProviderApple {
		t.Fatalf("a second account changed: %+v", other)
	}
	if _, ok, err := f.store.GetSubscriptionSource(context.Background(), otherID, ProviderApple); err != nil || ok {
		t.Fatalf("a second account gained an apple source row: ok=%v err=%v", ok, err)
	}
}

// The plan and cycle come from the server's mapping, not from anything the
// payload says about price, tier or period.
func TestAppleTransactionTakesPlanAndCycleFromTheServerMapping(t *testing.T) {
	f := newAppleTxFixture(t)
	mustAppleProduct(t, f.store, AppleProduct{
		BundleID: testBundleIOS, ProductID: "com.relayium.app.max.yearly",
		PlanID: "max", Cycle: "yearly", Active: true,
	})
	jws := f.chain.sign(t, f.payload(func(p map[string]any) {
		p["productId"] = "com.relayium.app.max.yearly"
		// Deliberate noise: a client-chosen tier claim has no effect.
		p["planId"] = "free"
		p["price"] = 0
	}))
	got, _ := f.mustAccept(t, jws)
	if got.PlanID != "max" {
		t.Fatalf("plan = %q, want the mapped tier", got.PlanID)
	}
	if u := f.user(t); u.PlanID != "max" || u.BillingCycle != "yearly" {
		t.Fatalf("mapping not applied: plan=%q cycle=%q", u.PlanID, u.BillingCycle)
	}
}

// ── Refusals ─────────────────────────────────────────────────────────────────

func TestAppleTransactionRequiresAuthentication(t *testing.T) {
	f := newAppleTxFixture(t)
	jws := f.chain.sign(t, f.payload())

	resp := f.submitAs(t, nil, jws)
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("want 401 unauthenticated, got %d", resp.StatusCode)
	}
	// Possession of a valid signed transaction (and of the token inside it)
	// granted nothing without a session.
	if u := f.user(t); u.PlanID != "free" {
		t.Fatalf("an unauthenticated submission changed an account: %+v", u)
	}
	if _, ok := f.appleSource(t); ok {
		t.Fatal("an unauthenticated submission created a source row")
	}
}

// With no trust roots or app configuration there is nothing to verify against,
// and the honest answer is "not available here" — never "accepted".
func TestAppleTransactionWithoutVerifierIsUnavailable(t *testing.T) {
	f := newAppleTxFixture(t)
	jws := f.chain.sign(t, f.payload())
	f.svc.SetAppleTransactionVerifier(nil)

	f.mustReject(t, jws, http.StatusServiceUnavailable, "verifier_unavailable")
	if u := f.user(t); u.PlanID != "free" {
		t.Fatalf("an unconfigured server granted a plan: %+v", u)
	}
}

func TestAppleTransactionRejectsMalformedAndOversizedRequests(t *testing.T) {
	f := newAppleTxFixture(t)
	valid := f.chain.sign(t, f.payload())

	for name, body := range map[string]string{
		"empty":         "",
		"not json":      "signedTransactionInfo=x",
		"wrong type":    `{"signedTransactionInfo":42}`,
		"missing field": `{}`,
		"blank field":   `{"signedTransactionInfo":"   "}`,
		// An unknown key is either a client this endpoint does not implement or a
		// second assertion smuggled alongside the JWS. Both are refused, including
		// when the JWS itself is perfectly good.
		"unknown field":       `{"signedTransactionInfo":"` + valid + `","grantPlan":"max"}`,
		"trailing json":       `{"signedTransactionInfo":"` + valid + `"}{"signedTransactionInfo":"` + valid + `"}`,
		"trailing junk":       `{"signedTransactionInfo":"` + valid + `"}x`,
		"leading whitespace":  `{"signedTransactionInfo":" ` + valid + `"}`,
		"trailing whitespace": `{"signedTransactionInfo":"` + valid + ` "}`,
		"trailing newline":    `{"signedTransactionInfo":"` + valid + `\n"}`,
		"oversized":           `{"signedTransactionInfo":"` + strings.Repeat("A", 32<<10) + `"}`,
		"oversized valid":     `{"signedTransactionInfo":"` + valid + `","padding":"` + strings.Repeat("A", 32<<10) + `"}`,
	} {
		resp := f.post(t, f.cookie, body)
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s: want 400, got %d (%s)", name, resp.StatusCode, raw)
		}
	}
	if u := f.user(t); u.PlanID != "free" {
		t.Fatalf("a malformed request changed an account: %+v", u)
	}
}

// Everything the verifier refuses collapses to one client-visible answer: a
// per-reason vocabulary here would be an oracle for shaping a forgery.
func TestAppleTransactionRejectsUnverifiableTransactions(t *testing.T) {
	f := newAppleTxFixture(t)
	foreign := newAppleTestChain(t)

	cases := map[string]string{
		"foreign root":     foreign.sign(t, f.payload()),
		"wrong signer":     f.chain.signWith(t, foreign.leafKey, f.chain.header(), f.payload()),
		"alg substitution": f.chain.signWith(t, f.chain.leafKey, map[string]any{"alg": "none", "x5c": f.chain.x5c()}, f.payload()),
		"wrong bundle":     f.chain.sign(t, f.payload(func(p map[string]any) { p["bundleId"] = "com.evil.app" })),
		"wrong env":        f.chain.sign(t, f.payload(func(p map[string]any) { p["environment"] = appleEnvProduction })),
		"tampered payload": tamperPayload(t, f.chain.sign(t, f.payload())),
	}
	for name, jws := range cases {
		resp := f.submit(t, jws)
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s: want 400, got %d (%s)", name, resp.StatusCode, raw)
		}
		var body map[string]string
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatalf("%s: decode %v (%s)", name, err, raw)
		}
		if body["error"] != "invalid_transaction" {
			t.Fatalf("%s: error = %q", name, body["error"])
		}
		// No crypto internals reach the client.
		for _, leak := range []string{"x509", "ecdsa", "certificate", "signature", "base64", "alg"} {
			if strings.Contains(strings.ToLower(string(raw)), leak) {
				t.Fatalf("%s: response exposed verification internals: %s", name, raw)
			}
		}
	}
	if u := f.user(t); u.PlanID != "free" {
		t.Fatalf("an unverifiable transaction granted a plan: %+v", u)
	}
}

// tamperPayload replaces a verified JWS's payload with another one, keeping the
// original header and signature — the substitution a client-side "I already
// checked it" verifier would wave through.
func tamperPayload(t *testing.T, jws string) string {
	t.Helper()
	parts := strings.Split(jws, ".")
	if len(parts) != 3 {
		t.Fatalf("not a compact JWS: %q", jws)
	}
	swapped := parts[1][:len(parts[1])-4] + "AAAA"
	if swapped == parts[1] {
		t.Fatal("fixture did not actually change the payload")
	}
	return parts[0] + "." + swapped + "." + parts[2]
}

func TestAppleTransactionRejectsUnmappedOrRetiredProducts(t *testing.T) {
	f := newAppleTxFixture(t)

	// Never mapped.
	f.mustReject(t, f.chain.sign(t, f.payload(func(p map[string]any) {
		p["productId"] = "com.relayium.app.unknown.monthly"
	})), http.StatusBadRequest, "invalid_transaction")

	// The macOS product id under the iOS bundle: same string, different app.
	mustAppleProduct(t, f.store, AppleProduct{
		BundleID: testBundleMac, ProductID: "com.relayium.mac.pro.monthly",
		PlanID: "pro", Cycle: "monthly", Active: true,
	})
	f.mustReject(t, f.chain.sign(t, f.payload(func(p map[string]any) {
		p["productId"] = "com.relayium.mac.pro.monthly"
	})), http.StatusBadRequest, "invalid_transaction")

	// Retired mapping.
	mustAppleProduct(t, f.store, AppleProduct{
		BundleID: testBundleIOS, ProductID: testAppleProduct,
		PlanID: "pro", Cycle: "monthly", Active: false,
	})
	f.mustReject(t, f.chain.sign(t, f.payload()), http.StatusBadRequest, "invalid_transaction")

	if u := f.user(t); u.PlanID != "free" {
		t.Fatalf("an unmapped product granted a plan: %+v", u)
	}
	if _, ok := f.appleSource(t); ok {
		t.Fatal("an unmapped product created a source row")
	}
}

// The token attributes a purchase; it authorizes nothing. A submitter may only
// ever claim the token their own account holds.
func TestAppleTransactionRejectsAnotherAccountsToken(t *testing.T) {
	f := newAppleTxFixture(t)
	victimCookie := loginCookie(t, f.ts, f.mail, "apple-tx-victim@example.com")
	victimID := mustUserID(t, f.store, "apple-tx-victim@example.com")
	victimToken := postAppleToken(t, f.ts, victimCookie)

	// f's session submitting a transaction carrying the victim's token.
	f.mustReject(t, f.chain.sign(t, f.payload(func(p map[string]any) {
		p["appAccountToken"] = victimToken
	})), http.StatusForbidden, "token_mismatch")

	// A well-formed token no account holds.
	f.mustReject(t, f.chain.sign(t, f.payload(func(p map[string]any) {
		p["appAccountToken"] = "11111111-2222-4333-8444-555555555555"
	})), http.StatusForbidden, "token_mismatch")

	for id, label := range map[string]string{f.userID: "submitter", victimID: "token holder"} {
		u, err := f.store.GetUserByID(context.Background(), id)
		if err != nil {
			t.Fatal(err)
		}
		if u.PlanID != "free" {
			t.Fatalf("%s changed: %+v", label, u)
		}
	}
}

// One App Store subscription has exactly one Relayium owner. A second account
// presenting the same originalTransactionId is refused whole — it must not
// receive the tier and leave the ownership record behind.
func TestAppleTransactionRejectsCrossAccountOriginalTransactionID(t *testing.T) {
	f := newAppleTxFixture(t)
	f.mustAccept(t, f.chain.sign(t, f.payload()))

	// A second account with its own token, presenting the SAME subscription.
	secondCookie := loginCookie(t, f.ts, f.mail, "apple-tx-second@example.com")
	secondID := mustUserID(t, f.store, "apple-tx-second@example.com")
	secondToken := postAppleToken(t, f.ts, secondCookie)

	resp := f.submitAs(t, secondCookie, f.chain.sign(t, applePayload(func(p map[string]any) {
		p["appAccountToken"] = secondToken
		p["productId"] = testAppleProduct
	})))
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("want 409, got %d (%s)", resp.StatusCode, raw)
	}
	var body map[string]string
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("decode: %v (%s)", err, raw)
	}
	if body["error"] != "subscription_owned" {
		t.Fatalf("error = %q", body["error"])
	}

	second, err := f.store.GetUserByID(context.Background(), secondID)
	if err != nil {
		t.Fatal(err)
	}
	if second.PlanID != "free" || second.PlanSource == ProviderApple {
		t.Fatalf("the second claimant was partially granted: %+v", second)
	}
	if _, ok, err := f.store.GetSubscriptionSource(context.Background(), secondID, ProviderApple); err != nil || ok {
		t.Fatalf("the second claimant got a source row: ok=%v err=%v", ok, err)
	}
	// The first owner is undisturbed.
	if u := f.user(t); u.PlanID != "pro" || u.PlanSource != ProviderApple {
		t.Fatalf("the owner's entitlement moved: %+v", u)
	}
	owner, _, err := f.store.UserByExternalSubscription(context.Background(), ProviderApple, testAppleSandboxExternalID)
	if err != nil || owner != f.userID {
		t.Fatalf("ownership moved to %q (err=%v)", owner, err)
	}
}

func TestAppleTransactionRejectsSecondAppWhileAppleSourceIsLive(t *testing.T) {
	f := newAppleTxFixture(t)
	f.mustAccept(t, f.chain.sign(t, f.payload()))
	before, ok := f.appleSource(t)
	if !ok {
		t.Fatal("accepted iOS purchase did not create an Apple source")
	}

	const macProduct = "com.relayium.mac.pro.monthly"
	mustAppleProduct(t, f.store, AppleProduct{
		BundleID: testBundleMac, ProductID: macProduct,
		PlanID: "pro", Cycle: "monthly", Active: true,
	})
	f.mustReject(t, f.chain.sign(t, f.payload(func(p map[string]any) {
		p["bundleId"] = testBundleMac
		p["productId"] = macProduct
		p["transactionId"] = "2000000000000002"
		p["originalTransactionId"] = "2000000000000002"
		p["purchaseDate"] = time.Now().Add(-24 * time.Hour).UnixMilli()
	})), http.StatusConflict, "billing_authority_conflict")

	after, ok := f.appleSource(t)
	if !ok || after != before {
		t.Fatalf("cross-app transaction mutated source: %+v -> %+v", before, after)
	}
}

func TestAppleTransactionRejectsSecondSubscriptionInSameAppWhileSourceIsLive(t *testing.T) {
	f := newAppleTxFixture(t)
	f.mustAccept(t, f.chain.sign(t, f.payload()))
	before, ok := f.appleSource(t)
	if !ok {
		t.Fatal("accepted purchase did not create an Apple source")
	}

	// Same bundle and product, but a new originalTransactionId: this is another
	// subscription (for example a different Apple ID), not a renewal or upgrade.
	f.mustReject(t, f.chain.sign(t, f.payload(func(p map[string]any) {
		p["transactionId"] = "2000000000000017"
		p["originalTransactionId"] = "2000000000000017"
		p["purchaseDate"] = time.Now().UnixMilli()
	})), http.StatusConflict, "apple_subscription_conflict")

	after, ok := f.appleSource(t)
	if !ok || after != before {
		t.Fatalf("second same-app subscription mutated source: %+v -> %+v", before, after)
	}
}

// Redelivery is normal: StoreKit re-presents the current entitlement on every
// launch. The same transaction must converge, and an OLDER one must never
// rewind a newer state.
func TestAppleTransactionRedeliveryConvergesAndStaleIsDropped(t *testing.T) {
	f := newAppleTxFixture(t)
	base := time.Now()
	renewal := f.chain.sign(t, f.payload(func(p map[string]any) {
		p["transactionId"] = "2000000000000009"
		p["purchaseDate"] = base.Add(-time.Hour).UnixMilli()
		p["expiresDate"] = base.Add(30 * 24 * time.Hour).UnixMilli()
	}))

	first, _ := f.mustAccept(t, renewal)
	if !first.Applied {
		t.Fatal("the first submission was not applied")
	}
	before, _ := f.appleSource(t)

	// Byte-identical redelivery converges on the same state.
	second, _ := f.mustAccept(t, renewal)
	if !second.Applied || second.PlanID != first.PlanID || second.ExpiresAt != first.ExpiresAt {
		t.Fatalf("redelivery diverged: %+v then %+v", first, second)
	}
	after, _ := f.appleSource(t)
	if after.PlanID != before.PlanID || after.PeriodEnd != before.PeriodEnd || after.EventAt != before.EventAt {
		t.Fatalf("redelivery rewrote the source row: %+v then %+v", before, after)
	}

	// An older transaction of the same subscription — a cached earlier period —
	// must not shorten the entitlement.
	stale := f.chain.sign(t, f.payload(func(p map[string]any) {
		p["transactionId"] = "2000000000000008"
		p["purchaseDate"] = base.Add(-31 * 24 * time.Hour).UnixMilli()
		p["expiresDate"] = base.Add(-time.Hour).UnixMilli()
	}))
	got, _ := f.mustAccept(t, stale)
	if got.Applied {
		t.Fatalf("a stale transaction was applied: %+v", got)
	}
	if got.PlanID != "pro" || got.Status != "active" {
		t.Fatalf("the stale answer did not report current state: %+v", got)
	}
	if u := f.user(t); u.PlanID != "pro" || u.SubscriptionStatus != "active" {
		t.Fatalf("a stale transaction rewound the entitlement: %+v", u)
	}
	if src, _ := f.appleSource(t); src.PeriodEnd != before.PeriodEnd {
		t.Fatalf("a stale transaction moved the paid-through date: %d want %d", src.PeriodEnd, before.PeriodEnd)
	}
}

// Access follows the verified fields: an expired window and a refund both stop
// granting, and a refund of a live subscription withdraws access that was
// already applied.
func TestAppleTransactionExpiredAndRevokedGrantNothing(t *testing.T) {
	f := newAppleTxFixture(t)
	now := time.Now()

	expired := f.chain.sign(t, f.payload(func(p map[string]any) {
		p["transactionId"] = "2000000000000002"
		p["purchaseDate"] = now.Add(-60 * 24 * time.Hour).UnixMilli()
		p["expiresDate"] = now.Add(-30 * 24 * time.Hour).UnixMilli()
	}))
	got, _ := f.mustAccept(t, expired)
	if got.PlanID != "free" || got.Status == "active" {
		t.Fatalf("an expired subscription granted access: %+v", got)
	}
	if u := f.user(t); u.PlanID != "free" {
		t.Fatalf("an expired subscription granted a plan: %+v", u)
	}

	// A live purchase, then its refund.
	live := f.chain.sign(t, f.payload(func(p map[string]any) {
		p["transactionId"] = "2000000000000003"
		p["purchaseDate"] = now.Add(-time.Hour).UnixMilli()
		p["expiresDate"] = now.Add(30 * 24 * time.Hour).UnixMilli()
	}))
	if got, _ := f.mustAccept(t, live); got.PlanID != "pro" {
		t.Fatalf("a live subscription did not grant: %+v", got)
	}
	revoked := f.chain.sign(t, f.payload(func(p map[string]any) {
		p["transactionId"] = "2000000000000003"
		p["purchaseDate"] = now.Add(-time.Hour).UnixMilli()
		p["expiresDate"] = now.Add(30 * 24 * time.Hour).UnixMilli()
		p["revocationDate"] = now.Add(-time.Minute).UnixMilli()
		p["revocationReason"] = 1
	}))
	after, _ := f.mustAccept(t, revoked)
	if after.PlanID != "free" {
		t.Fatalf("a revoked transaction kept granting: %+v", after)
	}
	if u := f.user(t); u.PlanID != "free" || u.PlanSource != ProviderApple {
		t.Fatalf("revocation was not applied: %+v", u)
	}
	live2, ok := f.appleSource(t)
	if !ok || live2.PlanID != freePlanID {
		t.Fatalf("the apple source row still grants: %+v", live2)
	}
	providers, err := f.store.LiveEntitlementProviders(context.Background(), f.userID)
	if err != nil {
		t.Fatal(err)
	}
	if len(providers) != 0 {
		t.Fatalf("a revoked subscription is still a live provider: %v", providers)
	}
}

// A refund must not be undoable by replaying the copy of the same transaction
// that was signed while it was still live. Both copies carry the same
// purchaseDate, so a bare purchase-date clock would treat the replay as an
// equal-and-therefore-applicable redelivery and hand the tier back to somebody
// who has already been refunded.
func TestAppleTransactionRefundCannotBeUndoneByReplayingTheLiveCopy(t *testing.T) {
	f := newAppleTxFixture(t)
	now := time.Now()
	purchased := now.Add(-time.Hour).UnixMilli()
	expires := now.Add(30 * 24 * time.Hour).UnixMilli()

	live := f.chain.sign(t, f.payload(func(p map[string]any) {
		p["purchaseDate"] = purchased
		p["expiresDate"] = expires
	}))
	if got, _ := f.mustAccept(t, live); got.PlanID != "pro" {
		t.Fatalf("the live purchase did not grant: %+v", got)
	}
	refunded := f.chain.sign(t, f.payload(func(p map[string]any) {
		p["purchaseDate"] = purchased
		p["expiresDate"] = expires
		p["revocationDate"] = now.Add(-time.Minute).UnixMilli()
		p["revocationReason"] = 1
	}))
	if got, _ := f.mustAccept(t, refunded); got.PlanID != "free" {
		t.Fatalf("the refund did not withdraw access: %+v", got)
	}

	// The attack: resubmit the still-perfectly-signed live copy.
	replay, _ := f.mustAccept(t, live)
	if replay.PlanID != "free" || replay.Applied {
		t.Fatalf("replaying the pre-refund copy resurrected access: %+v", replay)
	}
	if u := f.user(t); u.PlanID != "free" {
		t.Fatalf("the account is paid again after a refund: %+v", u)
	}
	src, ok := f.appleSource(t)
	if !ok || src.PlanID != freePlanID || src.Status != "canceled" {
		t.Fatalf("the apple source row was rewound: ok=%v %+v", ok, src)
	}
	providers, err := f.store.LiveEntitlementProviders(context.Background(), f.userID)
	if err != nil {
		t.Fatal(err)
	}
	if len(providers) != 0 {
		t.Fatalf("a refunded subscription is still live: %v", providers)
	}

	// …and a genuinely later renewal still supersedes the refund, so the guard
	// above is ordering rather than a permanent lock-out.
	renewal := f.chain.sign(t, f.payload(func(p map[string]any) {
		p["transactionId"] = "2000000000000042"
		p["purchaseDate"] = now.UnixMilli()
		p["expiresDate"] = now.Add(60 * 24 * time.Hour).UnixMilli()
	}))
	if got, _ := f.mustAccept(t, renewal); !got.Applied || got.PlanID != "pro" {
		t.Fatalf("a later renewal could not supersede the refund: %+v", got)
	}
}

// The mirror image of the test above, and the reason the ordering key is the
// PURCHASE date rather than whichever timestamp is newest.
//
// A refund is recorded whenever Apple gets round to it, which can be long after
// the period it ends and therefore after a later period has already been
// bought. Ordering by the revocation timestamp would let that refund of an old
// generation outrank — and cancel — a renewal the user is currently paying for.
// The submission order here is the adversarial one: old live, then the newer
// renewal, then the late refund FOR THE OLD TRANSACTION.
func TestAppleTransactionLateRefundOfAnOldPeriodCannotCancelANewerRenewal(t *testing.T) {
	f := newAppleTxFixture(t)
	now := time.Now()
	oldPurchase := now.Add(-40 * 24 * time.Hour).UnixMilli()
	oldExpires := now.Add(20 * 24 * time.Hour).UnixMilli()
	newPurchase := now.Add(-24 * time.Hour).UnixMilli()
	newExpires := now.Add(50 * 24 * time.Hour).UnixMilli()

	oldLive := f.chain.sign(t, f.payload(func(p map[string]any) {
		p["transactionId"] = "2000000000000200"
		p["purchaseDate"] = oldPurchase
		p["expiresDate"] = oldExpires
	}))
	if got, _ := f.mustAccept(t, oldLive); !got.Applied || got.PlanID != "pro" {
		t.Fatalf("the old period did not grant: %+v", got)
	}

	renewal := f.chain.sign(t, f.payload(func(p map[string]any) {
		p["transactionId"] = "2000000000000201"
		p["purchaseDate"] = newPurchase
		p["expiresDate"] = newExpires
	}))
	if got, _ := f.mustAccept(t, renewal); !got.Applied || got.PlanID != "pro" {
		t.Fatalf("the renewal did not apply: %+v", got)
	}
	if got := f.mustExpiry(t); got != newExpires/1000 {
		t.Fatalf("the renewal's period end was not recorded: %d want %d", got, newExpires/1000)
	}

	// The late refund: same OLD transaction, revoked a minute ago — newer in
	// wall-clock time than everything else here, and older by generation.
	lateRefund := f.chain.sign(t, f.payload(func(p map[string]any) {
		p["transactionId"] = "2000000000000200"
		p["purchaseDate"] = oldPurchase
		p["expiresDate"] = oldExpires
		p["revocationDate"] = now.Add(-time.Minute).UnixMilli()
		p["revocationReason"] = 1
	}))
	refundResult, _ := f.mustAccept(t, lateRefund)
	if refundResult.Applied {
		t.Fatalf("a refund of an older generation displaced the current one: %+v", refundResult)
	}
	if refundResult.PlanID != "pro" || refundResult.Status != "active" {
		t.Fatalf("the answer did not report the still-current entitlement: %+v", refundResult)
	}
	f.assertRenewalStillLive(t, newExpires)

	// And the pre-refund copy of that old transaction fares no better: it is an
	// older generation whether or not it has been refunded.
	replay, _ := f.mustAccept(t, oldLive)
	if replay.Applied {
		t.Fatalf("replaying the old live copy displaced the renewal: %+v", replay)
	}
	f.assertRenewalStillLive(t, newExpires)
}

// assertRenewalStillLive checks the whole of what "the renewal is untouched"
// means: the effective projection, the source row's own state and paid-through
// date, and that Apple is still a live provider.
func (f *appleTxFixture) assertRenewalStillLive(t *testing.T, expiresMS int64) {
	t.Helper()
	u := f.user(t)
	if u.PlanID != "pro" || u.PlanSource != ProviderApple || u.SubscriptionStatus != "active" {
		t.Fatalf("the paid entitlement was cancelled: %+v", u)
	}
	src, ok := f.appleSource(t)
	if !ok || src.PlanID != "pro" || src.Status != "active" {
		t.Fatalf("the apple source row was cancelled: ok=%v %+v", ok, src)
	}
	if src.PeriodEnd != expiresMS/1000 {
		t.Fatalf("the paid-through date moved: %d want %d", src.PeriodEnd, expiresMS/1000)
	}
	providers, err := f.store.LiveEntitlementProviders(context.Background(), f.userID)
	if err != nil {
		t.Fatal(err)
	}
	if len(providers) != 1 || providers[0] != ProviderApple {
		t.Fatalf("live providers = %v", providers)
	}
}

// mustExpiry returns the Apple source row's recorded paid-through date.
func (f *appleTxFixture) mustExpiry(t *testing.T) int64 {
	t.Helper()
	src, ok := f.appleSource(t)
	if !ok {
		t.Fatal("no apple source row")
	}
	return src.PeriodEnd
}

// The same hole, with Apple's other terminal marker: an upgraded transaction is
// superseded, and the pre-upgrade copy of it must not be able to bring it back.
func TestAppleTransactionUpgradeCannotBeUndoneByReplayingTheActiveCopy(t *testing.T) {
	f := newAppleTxFixture(t)
	now := time.Now()
	purchased := now.Add(-time.Hour).UnixMilli()
	expires := now.Add(30 * 24 * time.Hour).UnixMilli()

	active := f.chain.sign(t, f.payload(func(p map[string]any) {
		p["purchaseDate"] = purchased
		p["expiresDate"] = expires
	}))
	if got, _ := f.mustAccept(t, active); got.PlanID != "pro" {
		t.Fatalf("the active purchase did not grant: %+v", got)
	}
	upgraded := f.chain.sign(t, f.payload(func(p map[string]any) {
		p["purchaseDate"] = purchased
		p["expiresDate"] = expires
		p["isUpgraded"] = true
	}))
	if got, _ := f.mustAccept(t, upgraded); got.PlanID != "free" {
		t.Fatalf("a superseded transaction kept granting: %+v", got)
	}

	replay, _ := f.mustAccept(t, active)
	if replay.PlanID != "free" || replay.Applied {
		t.Fatalf("replaying the pre-upgrade copy resurrected it: %+v", replay)
	}
	if u := f.user(t); u.PlanID != "free" {
		t.Fatalf("the account is paid again after an upgrade: %+v", u)
	}

	// The transaction the upgrade actually produced — same subscription, later
	// purchase date — still grants.
	replacement := f.chain.sign(t, f.payload(func(p map[string]any) {
		p["transactionId"] = "2000000000000077"
		p["purchaseDate"] = now.UnixMilli()
		p["expiresDate"] = now.Add(60 * 24 * time.Hour).UnixMilli()
	}))
	if got, _ := f.mustAccept(t, replacement); !got.Applied || got.PlanID != "pro" {
		t.Fatalf("the upgrade's replacement transaction did not grant: %+v", got)
	}
}

// The native apps authenticate with a bearer token, not a cookie. That path is
// what this endpoint is FOR, so it is proven end to end rather than inferred
// from RequireAuth's other callers.
func TestAppleTransactionAcceptsABearerCredential(t *testing.T) {
	f := newAppleTxFixture(t)
	token, err := f.svc.issueBearer(context.Background(), f.userID, "Relayium for iOS")
	if err != nil {
		t.Fatalf("issue bearer: %v", err)
	}

	tx := f.payload()
	body := string(mustJSON(t, map[string]string{
		"signedTransactionInfo": f.chain.sign(t, tx),
		"signedRenewalInfo": f.chain.sign(t, map[string]any{
			"originalTransactionId": tx["originalTransactionId"], "autoRenewProductId": tx["productId"],
			"environment": tx["environment"], "signedDate": time.Now().UnixMilli(),
		}),
	}))
	req, err := http.NewRequest(http.MethodPost, f.ts.URL+"/api/billing/apple/transaction", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	withBearer(token)(req)
	resp, err := f.ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("bearer submission: want 200, got %d (%s)", resp.StatusCode, raw)
	}
	var out appleTxResult
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("decode: %v (%s)", err, raw)
	}
	if !out.Applied || out.PlanID != "pro" || out.Provider != ProviderApple {
		t.Fatalf("bearer submission result: %+v", out)
	}
	if u := f.user(t); u.PlanID != "pro" || u.PlanSource != ProviderApple {
		t.Fatalf("the bearer's own account was not entitled: %+v", u)
	}
	// A bearer request carries no Origin, so it must not be caught by CSRF
	// either — the same property the other native routes rely on.
	if strings.Contains(string(raw), token) {
		t.Fatalf("the response echoed the bearer: %s", raw)
	}
}

// A live Stripe source is already provider authority. Apple intake must not
// turn it into a second charge or mutate either provider projection.
func TestAppleTransactionCannotCrossALiveStripeAuthority(t *testing.T) {
	f := newAppleTxFixture(t)
	ctx := context.Background()
	if err := f.store.SetUserStripeCustomer(ctx, f.userID, "cus_apple_side"); err != nil {
		t.Fatal(err)
	}
	if err := f.store.SetUserSubscription(ctx, f.userID, "plus", "active", 1_900_000_000, ProviderStripe, "monthly", time.Now().Unix(), 100); err != nil {
		t.Fatal(err)
	}

	f.mustReject(t, f.chain.sign(t, f.payload()), http.StatusConflict, "billing_authority_conflict")
	stripe, ok, err := f.store.GetSubscriptionSource(ctx, f.userID, ProviderStripe)
	if err != nil || !ok {
		t.Fatalf("stripe row: ok=%v err=%v", ok, err)
	}
	if stripe.PlanID != "plus" || stripe.Status != "active" || stripe.EventAt != 100 {
		t.Fatalf("the apple event rewrote Stripe's row: %+v", stripe)
	}
	providers, err := f.store.LiveEntitlementProviders(ctx, f.userID)
	if err != nil {
		t.Fatal(err)
	}
	if len(providers) != 1 || providers[0] != ProviderStripe {
		t.Fatalf("apple intake changed provider authority: %v", providers)
	}
	if _, ok, err := f.store.GetSubscriptionSource(ctx, f.userID, ProviderApple); err != nil || ok {
		t.Fatalf("refused apple intake wrote a source: ok=%v err=%v", ok, err)
	}
}
