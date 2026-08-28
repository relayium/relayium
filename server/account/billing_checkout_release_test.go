package account

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// --- canned Stripe API surface -------------------------------------------
//
// These tests drive the REAL *stripeClient against an httptest Stripe, so the
// canonical Session parser is exercised end to end rather than stubbed. That
// matters here: the whole safety argument of releasing an abandoned Checkout
// rests on what the raw provider JSON does and does not contain.

// stripeStub is a scripted api.stripe.com.
type stripeStub struct {
	mu sync.Mutex

	// sessions maps a Checkout Session id to the raw JSON body GET returns.
	sessions map[string]string
	// sessionErr, when non-zero for an id, makes GET fail with that status.
	sessionErr map[string]int

	// newSessionID/newSessionURL are what POST /v1/checkout/sessions mints.
	newSessionID  string
	newSessionURL string

	priceBody string

	getSessionCalls  []string
	createSessionRaw []map[string][]string

	// beforeGet, when set, runs before each Session GET is answered. The
	// concurrency test uses it as a barrier so both callers provably read the
	// same pre-release state before either reaches the CAS.
	beforeGet func()
}

func (s *stripeStub) createdSessions() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.createSessionRaw)
}

func (s *stripeStub) sessionGets() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.getSessionCalls...)
}

func (s *stripeStub) handler(t *testing.T) http.Handler {
	t.Helper()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/prices/"):
			fmt.Fprint(w, s.priceBody)
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/checkout/sessions/"):
			id := strings.TrimPrefix(r.URL.Path, "/v1/checkout/sessions/")
			if s.beforeGet != nil {
				s.beforeGet()
			}
			s.mu.Lock()
			s.getSessionCalls = append(s.getSessionCalls, id)
			status, failing := s.sessionErr[id]
			body, known := s.sessions[id]
			s.mu.Unlock()
			if failing {
				w.WriteHeader(status)
				fmt.Fprint(w, `{"error":{"message":"injected provider failure"}}`)
				return
			}
			if !known {
				w.WriteHeader(http.StatusNotFound)
				fmt.Fprint(w, `{"error":{"message":"No such checkout.session"}}`)
				return
			}
			fmt.Fprint(w, body)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/checkout/sessions":
			if err := r.ParseForm(); err != nil {
				t.Errorf("ParseForm: %v", err)
			}
			s.mu.Lock()
			s.createSessionRaw = append(s.createSessionRaw, r.Form)
			id, url := s.newSessionID, s.newSessionURL
			s.mu.Unlock()
			fmt.Fprintf(w, `{"id":%q,"url":%q}`, id, url)
		default:
			t.Errorf("unexpected Stripe call %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"error":{"message":"unexpected"}}`)
		}
	})
}

// abandonedSessionJSON is a Stripe Checkout Session exactly as api.stripe.com
// renders a subscription-mode session the customer walked away from: expired,
// unpaid, and with every liability and recovery field present and null.
func abandonedSessionJSON(sessionID, customerID, userID, attemptID string, overrides map[string]any) string {
	obj := map[string]any{
		"id":                  sessionID,
		"object":              "checkout.session",
		"customer":            customerID,
		"client_reference_id": userID,
		"status":              "expired",
		"payment_status":      "unpaid",
		"mode":                "subscription",
		"livemode":            false,
		"created":             1750000000,
		"expires_at":          1750086400,
		"subscription":        nil,
		"invoice":             nil,
		"payment_intent":      nil,
		"setup_intent":        nil,
		"after_expiration":    nil,
		"recovered_from":      nil,
		"metadata": map[string]any{
			"user_id":            userID,
			"billing_attempt_id": attemptID,
		},
	}
	for k, v := range overrides {
		if v == deleteField {
			delete(obj, k)
			continue
		}
		obj[k] = v
	}
	raw, err := json.Marshal(obj)
	if err != nil {
		panic(err)
	}
	return string(raw)
}

// deleteField is the overrides sentinel meaning "omit this key entirely",
// which is a different provider shape from "present and null".
var deleteField = &struct{ name string }{"delete"}

func planPriceJSON(priceID string, cents int64, interval string) string {
	return fmt.Sprintf(`{"id":%q,"object":"price","type":"recurring","currency":"usd","active":true,"livemode":false,"unit_amount":%d,"recurring":{"usage_type":"licensed","interval":%q,"interval_count":1}}`, priceID, cents, interval)
}

// --- harness --------------------------------------------------------------

type releaseFixture struct {
	ts     *httptest.Server
	svc    *Service
	store  *SQLiteStore
	stub   *stripeStub
	client *stripeClient
	cookie *http.Cookie
	userID string
}

const (
	releaseCustomerID = "cus_release"
	oldSessionID      = "cs_test_abandoned_old"
	oldSessionURL     = "https://checkout.stripe.test/abandoned-old"
	newSessionID      = "cs_test_fresh_new"
	newSessionURL     = "https://checkout.stripe.test/fresh-new"
)

// newReleaseFixture builds an account server whose Biller is the real Stripe
// client pointed at a scripted stub, two purchasable plans, and a signed-in
// user with a bound Stripe customer and no live subscription.
func newReleaseFixture(t *testing.T) *releaseFixture {
	t.Helper()
	ts, svc, store, mail := newBillingServer(t)
	stub := &stripeStub{
		sessions:      map[string]string{},
		sessionErr:    map[string]int{},
		newSessionID:  newSessionID,
		newSessionURL: newSessionURL,
	}
	api := httptest.NewServer(stub.handler(t))
	t.Cleanup(api.Close)

	client := NewStripeClient("sk_test_release", "whsec_release", "")
	client.base = api.URL
	svc.biller = client

	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, PriceMonthly: 900, PriceYearly: 9000, StripePriceMonthlyID: "price_pro_m", StripePriceYearlyID: "price_pro_y"})
	mustPlan(t, store, Plan{ID: "max", Name: "Max", Active: true, PriceMonthly: 2900, PriceYearly: 29000, StripePriceMonthlyID: "price_max_m", StripePriceYearlyID: "price_max_y"})

	email := "abandoned-checkout@example.com"
	cookie := loginCookie(t, ts, mail, email)
	uid := mustUserID(t, store, email)
	if err := store.SetUserStripeCustomer(context.Background(), uid, releaseCustomerID); err != nil {
		t.Fatal(err)
	}
	return &releaseFixture{ts: ts, svc: svc, store: store, stub: stub, client: client, cookie: cookie, userID: uid}
}

// checkout posts a checkout request as the signed-in user.
func (f *releaseFixture) checkout(t *testing.T, planID, cycle string) (int, map[string]string) {
	t.Helper()
	f.stub.mu.Lock()
	f.stub.priceBody = planPriceJSON(stripePriceFor(planID, cycle), planCents(planID, cycle), intervalFor(cycle))
	f.stub.mu.Unlock()
	body := fmt.Sprintf(`{"planId":%q,"cycle":%q}`, planID, cycle)
	req, _ := http.NewRequest(http.MethodPost, f.ts.URL+"/api/billing/checkout", strings.NewReader(body))
	req.AddCookie(f.cookie)
	resp, err := f.ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out := map[string]string{}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// checkoutRaw is checkout without the per-call price rewrite, so concurrent
// callers do not race on the stub's canned price body.
func (f *releaseFixture) checkoutRaw(t *testing.T, planID, cycle string) (int, string, string) {
	t.Helper()
	body := fmt.Sprintf(`{"planId":%q,"cycle":%q}`, planID, cycle)
	req, _ := http.NewRequest(http.MethodPost, f.ts.URL+"/api/billing/checkout", strings.NewReader(body))
	req.AddCookie(f.cookie)
	resp, err := f.ts.Client().Do(req)
	if err != nil {
		t.Error(err)
		return 0, "", ""
	}
	defer resp.Body.Close()
	out := map[string]string{}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out["url"], out["error"]
}

// newReleaseUser creates a bare user for the store-level CAS tests, which have
// no HTTP layer and therefore no login.
func newReleaseUser(t *testing.T, store *SQLiteStore, email string) string {
	t.Helper()
	u, err := store.UpsertUserByEmail(context.Background(), email, "")
	if err != nil {
		t.Fatalf("UpsertUserByEmail: %v", err)
	}
	return u.ID
}

func stripePriceFor(planID, cycle string) string {
	if cycle == "yearly" {
		return "price_" + planID + "_y"
	}
	return "price_" + planID + "_m"
}

func planCents(planID, cycle string) int64 {
	cents := map[string]int64{"pro": 900, "max": 2900}[planID]
	if cycle == "yearly" {
		cents *= 10
	}
	return cents
}

func intervalFor(cycle string) string {
	if cycle == "yearly" {
		return "year"
	}
	return "month"
}

// abandon puts the fixture user into the exact stuck state: one dispatched
// attempt for productID, already carrying the old Checkout Session and URL.
func (f *releaseFixture) abandon(t *testing.T, productID string) BillingPurchaseAttempt {
	t.Helper()
	ctx := context.Background()
	authority, err := f.store.AcquireBillingAuthority(ctx, BillingAuthorityRequest{UserID: f.userID, Provider: ProviderStripe, Now: 1750000000})
	if err != nil {
		t.Fatalf("AcquireBillingAuthority: %v", err)
	}
	attempt, created, err := f.store.DispatchBillingPurchase(ctx, authority, productID, 1750000000)
	if err != nil || !created {
		t.Fatalf("DispatchBillingPurchase: created=%v err=%v", created, err)
	}
	if err := f.store.SetBillingPurchaseProviderSession(ctx, f.userID, attempt.ID, oldSessionID, oldSessionURL); err != nil {
		t.Fatalf("SetBillingPurchaseProviderSession: %v", err)
	}
	attempt.ProviderSessionID, attempt.ProviderURL = oldSessionID, oldSessionURL
	return attempt
}

// attemptRow reads an attempt's durable state straight from SQLite.
func (f *releaseFixture) attemptRow(t *testing.T, id string) BillingPurchaseAttempt {
	t.Helper()
	var out BillingPurchaseAttempt
	err := f.store.db.QueryRowContext(context.Background(), `SELECT id,user_id,provider,product_id,state,provider_ref,provider_session_id,provider_subscription_id,epoch FROM billing_purchase_attempts WHERE id=?`, id).
		Scan(&out.ID, &out.UserID, &out.Provider, &out.ProductID, &out.State, &out.ProviderURL, &out.ProviderSessionID, &out.ProviderSubscriptionID, &out.Epoch)
	if err != nil {
		t.Fatalf("read attempt %s: %v", id, err)
	}
	return out
}

func (f *releaseFixture) authorityRow(t *testing.T) BillingAuthority {
	t.Helper()
	authority, ok, err := f.store.BillingAuthority(context.Background(), f.userID)
	if err != nil || !ok {
		t.Fatalf("BillingAuthority: ok=%v err=%v", ok, err)
	}
	return authority
}

// entitlementSnapshot is the money-visible projection that a release must never
// move: plan, source, subscription id and status.
func (f *releaseFixture) entitlementSnapshot(t *testing.T) [4]string {
	t.Helper()
	var plan, source, sub, status string
	err := f.store.db.QueryRowContext(context.Background(), `SELECT plan_id,plan_source,stripe_subscription_id,subscription_status FROM users WHERE id=?`, f.userID).
		Scan(&plan, &source, &sub, &status)
	if err != nil {
		t.Fatalf("read entitlement: %v", err)
	}
	return [4]string{plan, source, sub, status}
}

// --- RED-first behavioural tests -----------------------------------------

// A user who abandoned a Checkout Session and comes back for the SAME plan is
// currently handed the dead URL forever. Once the canonical Session proves the
// attempt is expired and unpaid, the retry must mint a fresh Session.
func TestCheckoutRecoversAbandonedSessionSamePlan(t *testing.T) {
	f := newReleaseFixture(t)
	attempt := f.abandon(t, "price_pro_m")
	f.stub.sessions[oldSessionID] = abandonedSessionJSON(oldSessionID, releaseCustomerID, f.userID, attempt.ID, nil)
	before := f.entitlementSnapshot(t)

	code, out := f.checkout(t, "pro", "monthly")
	if code != http.StatusOK {
		t.Fatalf("same-plan retry after an abandoned Checkout: status %d body %v", code, out)
	}
	if out["url"] != newSessionURL {
		t.Fatalf("retry returned url %q, want the fresh session %q", out["url"], newSessionURL)
	}
	if n := f.stub.createdSessions(); n != 1 {
		t.Fatalf("created %d provider Sessions, want exactly 1", n)
	}
	if got := f.attemptRow(t, attempt.ID); got.State != "resolved" {
		t.Fatalf("abandoned attempt state = %q, want resolved", got.State)
	}
	if got := f.authorityRow(t); got.Epoch != attempt.Epoch+1 {
		t.Fatalf("authority epoch = %d, want %d", got.Epoch, attempt.Epoch+1)
	}
	if after := f.entitlementSnapshot(t); after != before {
		t.Fatalf("release moved entitlement: %v -> %v", before, after)
	}
}

// The same user coming back for a DIFFERENT plan is currently refused forever
// with billing_reconciliation_required.
func TestCheckoutRecoversAbandonedSessionChangedPlan(t *testing.T) {
	f := newReleaseFixture(t)
	attempt := f.abandon(t, "price_pro_m")
	f.stub.sessions[oldSessionID] = abandonedSessionJSON(oldSessionID, releaseCustomerID, f.userID, attempt.ID, nil)
	before := f.entitlementSnapshot(t)

	code, out := f.checkout(t, "max", "yearly")
	if code != http.StatusOK {
		t.Fatalf("changed-plan retry after an abandoned Checkout: status %d body %v", code, out)
	}
	if out["url"] != newSessionURL {
		t.Fatalf("retry returned url %q, want the fresh session %q", out["url"], newSessionURL)
	}
	if n := f.stub.createdSessions(); n != 1 {
		t.Fatalf("created %d provider Sessions, want exactly 1", n)
	}
	if got := f.attemptRow(t, attempt.ID); got.State != "resolved" {
		t.Fatalf("abandoned attempt state = %q, want resolved", got.State)
	}
	if after := f.entitlementSnapshot(t); after != before {
		t.Fatalf("release moved entitlement: %v -> %v", before, after)
	}
}

// --- raw field-presence parser -------------------------------------------

// The parser is where "we did not observe a liability" is separated from "we
// did not understand the answer". Both must block, and the table below is the
// list of shapes a Checkout Session can actually come back in.
func TestParseCanonicalAbandonedCheckoutFieldPresence(t *testing.T) {
	const (
		sess = "cs_test_parse"
		cus  = "cus_parse"
		uid  = "user_parse"
		att  = "attempt_parse"
	)
	// The liability and recovery fields, each proven blocking in every
	// non-null shape Stripe can send them in.
	liability := []string{"subscription", "invoice", "payment_intent", "setup_intent", "after_expiration", "recovered_from"}
	shapes := map[string]any{
		"string id":       "sub_live_123",
		"empty string":    "",
		"expanded object": map[string]any{"id": "sub_live_123", "status": "active"},
		"number":          7,
		"true":            true,
	}
	for _, field := range liability {
		for shapeName, shape := range shapes {
			t.Run(field+"/"+shapeName, func(t *testing.T) {
				body := abandonedSessionJSON(sess, cus, uid, att, map[string]any{field: shape})
				if _, err := parseCanonicalAbandonedCheckout([]byte(body)); err == nil {
					t.Fatalf("MONEY: a session carrying %s=%v (%s) parsed as canonically dead", field, shape, shapeName)
				}
			})
		}
		// Absent and null are the two shapes that legitimately mean "nothing here".
		t.Run(field+"/absent", func(t *testing.T) {
			body := abandonedSessionJSON(sess, cus, uid, att, map[string]any{field: deleteField})
			if _, err := parseCanonicalAbandonedCheckout([]byte(body)); err != nil {
				t.Fatalf("absent %s must parse: %v", field, err)
			}
		})
	}

	// The value fields: each must be present, correctly typed and non-empty.
	blocking := []struct {
		name      string
		overrides map[string]any
	}{
		{"id missing", map[string]any{"id": deleteField}},
		{"id null", map[string]any{"id": nil}},
		{"id empty", map[string]any{"id": ""}},
		{"id expanded", map[string]any{"id": map[string]any{"id": sess}}},
		{"object missing", map[string]any{"object": deleteField}},
		{"object wrong", map[string]any{"object": "payment_intent"}},
		{"customer missing", map[string]any{"customer": deleteField}},
		{"customer null", map[string]any{"customer": nil}},
		{"customer expanded", map[string]any{"customer": map[string]any{"id": cus}}},
		{"client_reference_id missing", map[string]any{"client_reference_id": deleteField}},
		{"client_reference_id null", map[string]any{"client_reference_id": nil}},
		{"status missing", map[string]any{"status": deleteField}},
		{"status null", map[string]any{"status": nil}},
		{"payment_status missing", map[string]any{"payment_status": deleteField}},
		{"mode missing", map[string]any{"mode": deleteField}},
		{"livemode missing", map[string]any{"livemode": deleteField}},
		{"livemode null", map[string]any{"livemode": nil}},
		{"livemode not boolean", map[string]any{"livemode": "true"}},
		{"metadata missing", map[string]any{"metadata": deleteField}},
		{"metadata null", map[string]any{"metadata": nil}},
		{"metadata user_id missing", map[string]any{"metadata": map[string]any{"billing_attempt_id": att}}},
		{"metadata attempt missing", map[string]any{"metadata": map[string]any{"user_id": uid}}},
		{"metadata attempt empty", map[string]any{"metadata": map[string]any{"user_id": uid, "billing_attempt_id": ""}}},
		{"created missing", map[string]any{"created": deleteField}},
		{"created null", map[string]any{"created": nil}},
		{"created zero", map[string]any{"created": 0}},
		{"created negative", map[string]any{"created": -1}},
		{"created string", map[string]any{"created": "1750000000"}},
		{"created float", map[string]any{"created": 1750000000.5}},
		{"expires_at missing", map[string]any{"expires_at": deleteField}},
		{"expires_at zero", map[string]any{"expires_at": 0}},
		{"expires_at negative", map[string]any{"expires_at": -1750086400}},
		{"expires_at string", map[string]any{"expires_at": "1750086400"}},
	}
	for _, tc := range blocking {
		t.Run(tc.name, func(t *testing.T) {
			body := abandonedSessionJSON(sess, cus, uid, att, tc.overrides)
			if _, err := parseCanonicalAbandonedCheckout([]byte(body)); err == nil {
				t.Fatalf("MONEY: %s parsed as canonically dead", tc.name)
			}
		})
	}

	t.Run("malformed json", func(t *testing.T) {
		for _, body := range []string{"", "{", "null", "[]", `"cs_test"`, `{"id":`} {
			if _, err := parseCanonicalAbandonedCheckout([]byte(body)); err == nil {
				t.Fatalf("MONEY: malformed body %q parsed as canonically dead", body)
			}
		}
	})

	t.Run("canonical", func(t *testing.T) {
		got, err := parseCanonicalAbandonedCheckout([]byte(abandonedSessionJSON(sess, cus, uid, att, nil)))
		if err != nil {
			t.Fatalf("canonical abandoned session must parse: %v", err)
		}
		want := canonicalAbandonedCheckout{
			ID: sess, Customer: cus, ClientReferenceID: uid, MetadataUserID: uid, BillingAttemptID: att,
			Status: "expired", PaymentStatus: "unpaid", Mode: "subscription",
			LiveMode: false, Created: 1750000000, ExpiresAt: 1750086400,
		}
		if got != want {
			t.Fatalf("parsed %+v, want %+v", got, want)
		}
	})
}

// absentOrNull is the hinge the liability proof hangs on, so it gets its own
// unambiguous coverage rather than only being exercised through the parser.
func TestAbsentOrNull(t *testing.T) {
	for _, raw := range []string{"", "null", " null ", "\nnull\n"} {
		if !absentOrNull(json.RawMessage(raw)) {
			t.Errorf("absentOrNull(%q) = false, want true", raw)
		}
	}
	for _, raw := range []string{`""`, `"sub_1"`, `{}`, `{"id":"sub_1"}`, `0`, `false`, `"null"`, `[]`} {
		if absentOrNull(json.RawMessage(raw)) {
			t.Errorf("MONEY: absentOrNull(%q) = true, want false", raw)
		}
	}
}

// --- fail-closed handler cases -------------------------------------------

// Every one of these is a Session shape that must NOT release the attempt. The
// assertion is the same in all of them and it is the whole point: the attempt
// stays dispatched, the authority generation does not move, entitlement does
// not move, and no second Checkout Session is created.
func TestCheckoutAbandonedReleaseFailsClosed(t *testing.T) {
	cases := []struct {
		name      string
		overrides map[string]any
		// providerStatus, when non-zero, makes the Session GET fail instead.
		providerStatus int
		// omitSession models a Session id Stripe does not know at all.
		omitSession bool
	}{
		// Not terminal: the customer can still pay these.
		{name: "still open", overrides: map[string]any{"status": "open", "expires_at": 1900000000}},
		{name: "complete", overrides: map[string]any{"status": "complete"}},
		{name: "unknown status", overrides: map[string]any{"status": "something_new"}},
		// Paid or paying.
		{name: "paid", overrides: map[string]any{"payment_status": "paid"}},
		{name: "no payment required", overrides: map[string]any{"payment_status": "no_payment_required"}},
		{name: "live payment intent", overrides: map[string]any{"payment_intent": "pi_live_1"}},
		{name: "invoice present", overrides: map[string]any{"invoice": "in_live_1"}},
		{name: "setup intent present", overrides: map[string]any{"setup_intent": "seti_live_1"}},
		{name: "subscription present", overrides: map[string]any{"subscription": "sub_live_1"}},
		{name: "expanded subscription", overrides: map[string]any{"subscription": map[string]any{"id": "sub_live_1", "status": "active"}}},
		// Recovery lineage: this Session can come back from the dead.
		{name: "after_expiration configured", overrides: map[string]any{"after_expiration": map[string]any{"recovery": map[string]any{"enabled": true, "url": "https://checkout.stripe.test/recover"}}}},
		{name: "recovered_from present", overrides: map[string]any{"recovered_from": "cs_test_ancestor"}},
		// Wrong object entirely.
		{name: "wrong mode", overrides: map[string]any{"mode": "payment"}},
		{name: "wrong object", overrides: map[string]any{"object": "payment_intent"}},
		// Ownership: the Session is terminal, but it is not OUR Session.
		{name: "wrong customer", overrides: map[string]any{"customer": "cus_someone_else"}},
		{name: "wrong client reference", overrides: map[string]any{"client_reference_id": "user_someone_else"}},
		{name: "wrong metadata user", overrides: map[string]any{"metadata": map[string]any{"user_id": "user_someone_else", "billing_attempt_id": "ATTEMPT"}}},
		{name: "wrong metadata attempt", overrides: map[string]any{"metadata": map[string]any{"user_id": "USER", "billing_attempt_id": "attempt_someone_else"}}},
		{name: "wrong session id echoed", overrides: map[string]any{"id": "cs_test_other"}},
		// Mode boundary: a test-mode Session must never retire an attempt a live
		// key dispatched, and vice versa.
		{name: "livemode mismatch", overrides: map[string]any{"livemode": true}},
		// Field shapes.
		{name: "created negative", overrides: map[string]any{"created": -1}},
		{name: "expires_at zero", overrides: map[string]any{"expires_at": 0}},
		// Provider failures: we did not learn anything, so nothing moves.
		{name: "provider 500", providerStatus: http.StatusInternalServerError},
		{name: "provider 503", providerStatus: http.StatusServiceUnavailable},
		{name: "provider 429", providerStatus: http.StatusTooManyRequests},
		{name: "provider 401", providerStatus: http.StatusUnauthorized},
		{name: "provider 404", providerStatus: http.StatusNotFound},
		{name: "session unknown to stripe", omitSession: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newReleaseFixture(t)
			attempt := f.abandon(t, "price_pro_m")
			overrides := map[string]any{}
			for k, v := range tc.overrides {
				// Late-bound ids: the fixture user/attempt ids are only known now.
				if meta, ok := v.(map[string]any); ok && k == "metadata" {
					fixed := map[string]any{}
					for mk, mv := range meta {
						switch mv {
						case "USER":
							fixed[mk] = f.userID
						case "ATTEMPT":
							fixed[mk] = attempt.ID
						default:
							fixed[mk] = mv
						}
					}
					overrides[k] = fixed
					continue
				}
				overrides[k] = v
			}
			if !tc.omitSession {
				f.stub.sessions[oldSessionID] = abandonedSessionJSON(oldSessionID, releaseCustomerID, f.userID, attempt.ID, overrides)
			}
			if tc.providerStatus != 0 {
				f.stub.sessionErr[oldSessionID] = tc.providerStatus
			}
			beforeEntitlement := f.entitlementSnapshot(t)
			beforeAuthority := f.authorityRow(t)

			// Same plan: the pre-existing behaviour is the stale URL.
			code, out := f.checkout(t, "pro", "monthly")
			if code != http.StatusOK || out["url"] != oldSessionURL {
				t.Fatalf("blocked same-plan retry: status %d url %q, want 200 with the existing %q", code, out["url"], oldSessionURL)
			}
			// Changed plan: the pre-existing behaviour is the reconciliation 409.
			code, out = f.checkout(t, "max", "yearly")
			if code != http.StatusConflict || out["error"] != "billing_reconciliation_required" {
				t.Fatalf("blocked changed-plan retry: status %d body %v, want 409 billing_reconciliation_required", code, out)
			}

			if n := f.stub.createdSessions(); n != 0 {
				t.Fatalf("MONEY: %d provider Sessions created for a blocked release, want 0", n)
			}
			got := f.attemptRow(t, attempt.ID)
			if got.State != "dispatched" || got.ProviderSessionID != oldSessionID || got.ProviderSubscriptionID != "" {
				t.Fatalf("MONEY: blocked release mutated the attempt: %+v", got)
			}
			if after := f.authorityRow(t); after != beforeAuthority {
				t.Fatalf("MONEY: blocked release advanced the authority: %+v -> %+v", beforeAuthority, after)
			}
			if after := f.entitlementSnapshot(t); after != beforeEntitlement {
				t.Fatalf("MONEY: blocked release moved entitlement: %v -> %v", beforeEntitlement, after)
			}
		})
	}
}

// --- local state that must block before any provider call ------------------

// An attempt that could never be released must not even be looked up at
// Stripe. This is not an optimisation: a provider call is a fact we would then
// have to reason about, and there is nothing to reason about here.
func TestCheckoutAbandonedReleaseSkipsProviderForUnreleasableLocalState(t *testing.T) {
	t.Run("prepared attempt", func(t *testing.T) {
		f := newReleaseFixture(t)
		ctx := context.Background()
		authority, err := f.store.AcquireBillingAuthority(ctx, BillingAuthorityRequest{UserID: f.userID, Provider: ProviderStripe, Now: 1750000000})
		if err != nil {
			t.Fatal(err)
		}
		attempt, _, err := f.store.PrepareBillingPurchase(ctx, authority, "price_pro_m", 1750000000)
		if err != nil {
			t.Fatal(err)
		}
		// A prepared attempt may have reached StoreKit/Stripe without us knowing.
		code, out := f.checkout(t, "pro", "monthly")
		if code != http.StatusConflict || out["error"] != "billing_reconciliation_required" {
			t.Fatalf("prepared attempt: status %d body %v, want 409 billing_reconciliation_required", code, out)
		}
		if got := f.stub.sessionGets(); len(got) != 0 {
			t.Fatalf("MONEY: a prepared attempt reached the provider: %v", got)
		}
		if got := f.attemptRow(t, attempt.ID); got.State != "prepared" {
			t.Fatalf("prepared attempt state = %q, want prepared", got.State)
		}
		if n := f.stub.createdSessions(); n != 0 {
			t.Fatalf("MONEY: %d Sessions created against a prepared attempt", n)
		}
	})

	t.Run("dispatched without a session", func(t *testing.T) {
		f := newReleaseFixture(t)
		ctx := context.Background()
		authority, err := f.store.AcquireBillingAuthority(ctx, BillingAuthorityRequest{UserID: f.userID, Provider: ProviderStripe, Now: 1750000000})
		if err != nil {
			t.Fatal(err)
		}
		// The dangerous shape: the provider call may have succeeded while its
		// response was lost, so there may be a live Session we cannot name.
		attempt, _, err := f.store.DispatchBillingPurchase(ctx, authority, "price_pro_m", 1750000000)
		if err != nil {
			t.Fatal(err)
		}
		code, out := f.checkout(t, "pro", "monthly")
		if code != http.StatusConflict || out["error"] != "billing_reconciliation_required" {
			t.Fatalf("session-less attempt: status %d body %v, want 409", code, out)
		}
		if got := f.stub.sessionGets(); len(got) != 0 {
			t.Fatalf("MONEY: a session-less attempt reached the provider: %v", got)
		}
		if got := f.attemptRow(t, attempt.ID); got.State != "dispatched" {
			t.Fatalf("attempt state = %q, want dispatched", got.State)
		}
		if n := f.stub.createdSessions(); n != 0 {
			t.Fatalf("MONEY: %d Sessions created against a session-less attempt", n)
		}
	})

	t.Run("attempt already bound to a subscription", func(t *testing.T) {
		f := newReleaseFixture(t)
		attempt := f.abandon(t, "price_pro_m")
		if err := f.store.BindStripePurchaseSubscription(context.Background(), f.userID, attempt.ID, oldSessionID, "sub_live_1"); err != nil {
			t.Fatal(err)
		}
		// Stripe would even report this Session as expired+unpaid if the
		// subscription came from an ordering race — the LOCAL subscription is
		// the liability, and it blocks before anything is asked.
		f.stub.sessions[oldSessionID] = abandonedSessionJSON(oldSessionID, releaseCustomerID, f.userID, attempt.ID, nil)
		code, _ := f.checkout(t, "pro", "monthly")
		if code != http.StatusOK {
			t.Fatalf("status %d, want the pre-existing 200 + stale url", code)
		}
		if got := f.stub.sessionGets(); len(got) != 0 {
			t.Fatalf("MONEY: a subscription-bound attempt reached the provider: %v", got)
		}
		got := f.attemptRow(t, attempt.ID)
		if got.State != "dispatched" || got.ProviderSubscriptionID != "sub_live_1" {
			t.Fatalf("MONEY: subscription-bound attempt mutated: %+v", got)
		}
		if n := f.stub.createdSessions(); n != 0 {
			t.Fatalf("MONEY: %d Sessions created against a subscription-bound attempt", n)
		}
	})
}

// --- the adversarial boundary --------------------------------------------

// The financial worst case: a user who ALREADY HAS a live subscription, and
// whose old attempt's Session is, by every canonical measure, safely dead.
// Releasing it would be correct in isolation and catastrophic in context — it
// would open a second parallel subscription on a paying customer. The
// already-subscribed guard must win, and must win before a single provider
// call is made.
func TestCheckoutAbandonedReleaseCannotOpenSecondSubscription(t *testing.T) {
	f := newReleaseFixture(t)
	attempt := f.abandon(t, "price_pro_m")
	f.stub.sessions[oldSessionID] = abandonedSessionJSON(oldSessionID, releaseCustomerID, f.userID, attempt.ID, nil)
	// The user pays for pro, live, right now.
	subscribeUser(t, f.store, f.userID, releaseCustomerID, "pro")
	before := f.entitlementSnapshot(t)
	beforeAuthority := f.authorityRow(t)

	for _, plan := range []struct{ id, cycle string }{{"pro", "monthly"}, {"max", "yearly"}, {"pro", "yearly"}} {
		code, out := f.checkout(t, plan.id, plan.cycle)
		if code != http.StatusConflict || out["error"] != "already_subscribed" {
			t.Fatalf("MONEY: live subscriber buying %s/%s got status %d body %v, want 409 already_subscribed", plan.id, plan.cycle, code, out)
		}
	}
	if n := f.stub.createdSessions(); n != 0 {
		t.Fatalf("MONEY: a live subscriber was sold %d additional Checkout Sessions", n)
	}
	if got := f.stub.sessionGets(); len(got) != 0 {
		t.Fatalf("MONEY: the release path ran for a live subscriber: %v", got)
	}
	if got := f.attemptRow(t, attempt.ID); got.State != "dispatched" {
		t.Fatalf("MONEY: a live subscriber's attempt was released: %+v", got)
	}
	if after := f.authorityRow(t); after != beforeAuthority {
		t.Fatalf("MONEY: authority advanced for a live subscriber: %+v -> %+v", beforeAuthority, after)
	}
	if after := f.entitlementSnapshot(t); after != before {
		t.Fatalf("MONEY: entitlement moved: %v -> %v", before, after)
	}
}

// --- concurrency ----------------------------------------------------------

// Two tabs, one abandoned Checkout. Both requests are held at the canonical
// Session read until BOTH have got there, so both have provably read the same
// pre-release state and both will run the CAS. Exactly one may win; the loser
// must not create a second Session on the generation it already lost, and —
// just as importantly — must not be handed the old URL. Both callers PROVED
// that Session expired before either ran the CAS, so serving it to the loser
// would be knowingly sending a paying user to a dead Stripe page.
func TestCheckoutAbandonedReleaseConcurrentCallersReleaseOnce(t *testing.T) {
	f := newReleaseFixture(t)
	attempt := f.abandon(t, "price_pro_m")
	f.stub.sessions[oldSessionID] = abandonedSessionJSON(oldSessionID, releaseCustomerID, f.userID, attempt.ID, nil)
	before := f.entitlementSnapshot(t)

	// checkoutRaw does not rewrite the canned price body, so set it once here:
	// two concurrent callers must not race on the stub's catalog response.
	f.stub.priceBody = planPriceJSON("price_pro_m", 900, "month")

	// Hold the first `callers` canonical reads until all of them have arrived,
	// so both requests provably observed the same pre-release state and both go
	// on to run the CAS. Later reads pass straight through, and a caller that
	// never arrives times out into the assertions below instead of hanging.
	// beforeGet is written once, before any request exists, so the stub stays
	// race-free.
	const callers = 2
	release := make(chan struct{})
	var barrierMu sync.Mutex
	var once sync.Once
	arrived := 0
	f.stub.beforeGet = func() {
		barrierMu.Lock()
		arrived++
		reached := arrived
		barrierMu.Unlock()
		if reached >= callers {
			once.Do(func() { close(release) })
		}
		select {
		case <-release:
		case <-time.After(20 * time.Second):
		}
	}

	var wg sync.WaitGroup
	codes := make([]int, callers)
	urls := make([]string, callers)
	errCodes := make([]string, callers)
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i], urls[i], errCodes[i] = f.checkoutRaw(t, "pro", "monthly")
		}(i)
	}
	wg.Wait()

	if n := f.stub.createdSessions(); n != 1 {
		t.Fatalf("MONEY: %d provider Sessions created by %d concurrent callers, want exactly 1", n, callers)
	}
	if got := len(f.stub.sessionGets()); got != callers {
		t.Fatalf("session reads = %d, want %d (the barrier did not hold both callers)", got, callers)
	}
	winners, refused := 0, 0
	for i := 0; i < callers; i++ {
		switch {
		case urls[i] == oldSessionURL:
			t.Fatalf("caller %d was handed the Session it had just proven expired (%q)", i, oldSessionURL)
		case codes[i] == http.StatusOK && urls[i] == newSessionURL:
			winners++
		case codes[i] == http.StatusConflict && errCodes[i] == "billing_reconciliation_required":
			refused++
		default:
			t.Fatalf("caller %d: status %d url %q error %q — want either 200 + the fresh url or 409 billing_reconciliation_required",
				i, codes[i], urls[i], errCodes[i])
		}
	}
	if winners != 1 {
		t.Fatalf("MONEY: %d callers received the fresh Session url, want exactly 1", winners)
	}
	if refused != callers-1 {
		t.Fatalf("%d callers were refused, want %d", refused, callers-1)
	}
	if got := f.attemptRow(t, attempt.ID); got.State != "resolved" {
		t.Fatalf("attempt state = %q, want resolved", got.State)
	}
	// Exactly one generation advance: the loser must not have advanced it again.
	if got := f.authorityRow(t); got.Epoch != attempt.Epoch+1 {
		t.Fatalf("MONEY: authority epoch = %d after a concurrent release, want exactly %d", got.Epoch, attempt.Epoch+1)
	}
	if after := f.entitlementSnapshot(t); after != before {
		t.Fatalf("MONEY: concurrent release moved entitlement: %v -> %v", before, after)
	}
	// The loser self-heals on the next click rather than staying stuck.
	code, out := f.checkout(t, "pro", "monthly")
	if code != http.StatusOK || out["url"] != newSessionURL {
		t.Fatalf("follow-up retry: status %d url %q", code, out["url"])
	}
}

// The store CAS under direct concurrent pressure, with no HTTP layer to hide
// behind: N goroutines, one dead attempt, exactly one release and exactly one
// generation advance.
func TestReleaseAbandonedStripeCheckoutStoreCASReleasesOnce(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	uid := newReleaseUser(t, store, "cas-release@example.test")
	authority, err := store.AcquireBillingAuthority(ctx, BillingAuthorityRequest{UserID: uid, Provider: ProviderStripe, Now: 1750000000})
	if err != nil {
		t.Fatal(err)
	}
	attempt, _, err := store.DispatchBillingPurchase(ctx, authority, "price_pro_m", 1750000000)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetBillingPurchaseProviderSession(ctx, uid, attempt.ID, oldSessionID, oldSessionURL); err != nil {
		t.Fatal(err)
	}
	attempt.ProviderSessionID, attempt.ProviderURL = oldSessionID, oldSessionURL

	const goroutines = 8
	start := make(chan struct{})
	var wg sync.WaitGroup
	results := make([]bool, goroutines)
	errs := make([]error, goroutines)
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			results[i], errs[i] = store.ReleaseAbandonedStripeCheckout(ctx, authority, attempt, 1750100000)
		}(i)
	}
	close(start)
	wg.Wait()

	released := 0
	for i, ok := range results {
		if errs[i] != nil {
			t.Fatalf("goroutine %d: %v", i, errs[i])
		}
		if ok {
			released++
		}
	}
	if released != 1 {
		t.Fatalf("MONEY: %d of %d concurrent CAS calls released the attempt, want exactly 1", released, goroutines)
	}
	after, ok, err := store.BillingAuthority(ctx, uid)
	if err != nil || !ok {
		t.Fatalf("BillingAuthority: ok=%v err=%v", ok, err)
	}
	if after.Epoch != authority.Epoch+1 {
		t.Fatalf("MONEY: epoch = %d after %d concurrent releases, want %d", after.Epoch, goroutines, authority.Epoch+1)
	}
	if after.IntentID == authority.IntentID {
		t.Fatal("release did not rotate the authority intent")
	}
	var state string
	if err := store.db.QueryRowContext(ctx, `SELECT state FROM billing_purchase_attempts WHERE id=?`, attempt.ID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "resolved" {
		t.Fatalf("attempt state = %q, want resolved", state)
	}
	// A replay against the now-stale authority must be refused, not repeated.
	again, err := store.ReleaseAbandonedStripeCheckout(ctx, authority, attempt, 1750200000)
	if err != nil || again {
		t.Fatalf("MONEY: replayed release returned (%v, %v), want (false, nil)", again, err)
	}
}

// The store CAS refuses every mismatch it is given, one clause at a time.
// Each of these is a row the caller thinks it proved dead and did not.
func TestReleaseAbandonedStripeCheckoutStoreCASRefusesMismatch(t *testing.T) {
	mutate := map[string]func(*BillingAuthority, *BillingPurchaseAttempt){
		"wrong attempt id": func(_ *BillingAuthority, a *BillingPurchaseAttempt) { a.ID = "attempt_other" },
		"wrong user": func(au *BillingAuthority, a *BillingPurchaseAttempt) {
			au.UserID, a.UserID = "user_other", "user_other"
		},
		"attempt user mismatch":  func(_ *BillingAuthority, a *BillingPurchaseAttempt) { a.UserID = "user_other" },
		"wrong epoch":            func(au *BillingAuthority, a *BillingPurchaseAttempt) { au.Epoch, a.Epoch = 9, 9 },
		"attempt epoch mismatch": func(_ *BillingAuthority, a *BillingPurchaseAttempt) { a.Epoch = 9 },
		"wrong product":          func(_ *BillingAuthority, a *BillingPurchaseAttempt) { a.ProductID = "price_other" },
		"wrong session":          func(_ *BillingAuthority, a *BillingPurchaseAttempt) { a.ProviderSessionID = "cs_test_other" },
		"empty session":          func(_ *BillingAuthority, a *BillingPurchaseAttempt) { a.ProviderSessionID = "" },
		"non-stripe session id":  func(_ *BillingAuthority, a *BillingPurchaseAttempt) { a.ProviderSessionID = "sub_not_a_session" },
		"apple provider": func(au *BillingAuthority, a *BillingPurchaseAttempt) {
			au.Provider, a.Provider = ProviderApple, ProviderApple
		},
		"attempt provider apple": func(_ *BillingAuthority, a *BillingPurchaseAttempt) { a.Provider = ProviderApple },
		"already resolved":       func(_ *BillingAuthority, a *BillingPurchaseAttempt) { a.State = "resolved" },
		"prepared":               func(_ *BillingAuthority, a *BillingPurchaseAttempt) { a.State = "prepared" },
		"subscription bound":     func(_ *BillingAuthority, a *BillingPurchaseAttempt) { a.ProviderSubscriptionID = "sub_live_1" },
		"stale intent":           func(au *BillingAuthority, _ *BillingPurchaseAttempt) { au.IntentID = "intent_other" },
	}
	for name, apply := range mutate {
		t.Run(name, func(t *testing.T) {
			store := newTestStore(t)
			ctx := context.Background()
			uid := newReleaseUser(t, store, "cas-mismatch@example.test")
			authority, err := store.AcquireBillingAuthority(ctx, BillingAuthorityRequest{UserID: uid, Provider: ProviderStripe, Now: 1750000000})
			if err != nil {
				t.Fatal(err)
			}
			attempt, _, err := store.DispatchBillingPurchase(ctx, authority, "price_pro_m", 1750000000)
			if err != nil {
				t.Fatal(err)
			}
			if err := store.SetBillingPurchaseProviderSession(ctx, uid, attempt.ID, oldSessionID, oldSessionURL); err != nil {
				t.Fatal(err)
			}
			attempt.ProviderSessionID = oldSessionID

			mutatedAuthority, mutatedAttempt := authority, attempt
			apply(&mutatedAuthority, &mutatedAttempt)
			released, err := store.ReleaseAbandonedStripeCheckout(ctx, mutatedAuthority, mutatedAttempt, 1750100000)
			if err != nil {
				t.Fatalf("mismatch must be a refusal, not an error: %v", err)
			}
			if released {
				t.Fatalf("MONEY: %s released the attempt", name)
			}
			var state string
			if err := store.db.QueryRowContext(ctx, `SELECT state FROM billing_purchase_attempts WHERE id=?`, attempt.ID).Scan(&state); err != nil {
				t.Fatal(err)
			}
			if state != "dispatched" {
				t.Fatalf("MONEY: %s mutated the attempt to %q", name, state)
			}
			after, _, err := store.BillingAuthority(ctx, uid)
			if err != nil {
				t.Fatal(err)
			}
			if after.Epoch != authority.Epoch || after.IntentID != authority.IntentID {
				t.Fatalf("MONEY: %s advanced the authority to epoch %d intent %s", name, after.Epoch, after.IntentID)
			}
		})
	}
}

// A frozen account is mid-deletion. Even a perfectly proven-dead attempt must
// not hand it a fresh dispatch slot.
func TestReleaseAbandonedStripeCheckoutRefusesFrozenAccount(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	uid := newReleaseUser(t, store, "cas-frozen@example.test")
	authority, err := store.AcquireBillingAuthority(ctx, BillingAuthorityRequest{UserID: uid, Provider: ProviderStripe, Now: 1750000000})
	if err != nil {
		t.Fatal(err)
	}
	attempt, _, err := store.DispatchBillingPurchase(ctx, authority, "price_pro_m", 1750000000)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetBillingPurchaseProviderSession(ctx, uid, attempt.ID, oldSessionID, oldSessionURL); err != nil {
		t.Fatal(err)
	}
	attempt.ProviderSessionID = oldSessionID
	if _, err := store.db.ExecContext(ctx, `INSERT INTO billing_deletion_holds(billing_subject_id,email_hmac,provider,created_at,expires_at,subject_released_at) VALUES(?,X'aa',?,?,?,0)`, uid, ProviderStripe, 1750000000, 1760000000); err != nil {
		t.Fatal(err)
	}

	released, err := store.ReleaseAbandonedStripeCheckout(ctx, authority, attempt, 1750100000)
	if err != nil || released {
		t.Fatalf("MONEY: frozen account release returned (%v, %v), want (false, nil)", released, err)
	}
	var state string
	if err := store.db.QueryRowContext(ctx, `SELECT state FROM billing_purchase_attempts WHERE id=?`, attempt.ID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "dispatched" {
		t.Fatalf("MONEY: a frozen account's attempt moved to %q", state)
	}
	after, _, err := store.BillingAuthority(ctx, uid)
	if err != nil {
		t.Fatal(err)
	}
	if after.Epoch != authority.Epoch {
		t.Fatalf("MONEY: a frozen account's authority advanced to epoch %d", after.Epoch)
	}
}

// --- local write failure --------------------------------------------------

// releaseFailStore is a Store whose release CAS cannot report what it did.
type releaseFailStore struct {
	Store
	err error
}

func (s releaseFailStore) BillingUserFrozen(ctx context.Context, userID string) (bool, error) {
	store, ok := s.Store.(interface {
		BillingUserFrozen(context.Context, string) (bool, error)
	})
	if !ok {
		return false, errors.New("missing billing freeze store")
	}
	return store.BillingUserFrozen(ctx, userID)
}

func (s releaseFailStore) AcquireBillingAuthority(ctx context.Context, in BillingAuthorityRequest) (BillingAuthority, error) {
	return acquireStoreBillingAuthority(ctx, s.Store, in)
}

func (s releaseFailStore) DispatchBillingPurchase(ctx context.Context, authority BillingAuthority, productID string, now int64) (BillingPurchaseAttempt, bool, error) {
	store, ok := s.Store.(interface {
		DispatchBillingPurchase(context.Context, BillingAuthority, string, int64) (BillingPurchaseAttempt, bool, error)
	})
	if !ok {
		return BillingPurchaseAttempt{}, false, errors.New("missing dispatch store")
	}
	return store.DispatchBillingPurchase(ctx, authority, productID, now)
}

func (s releaseFailStore) SetBillingPurchaseProviderSession(ctx context.Context, userID, attemptID, sessionID, checkoutURL string) error {
	store, ok := s.Store.(interface {
		SetBillingPurchaseProviderSession(context.Context, string, string, string, string) error
	})
	if !ok {
		return errors.New("missing provider session store")
	}
	return store.SetBillingPurchaseProviderSession(ctx, userID, attemptID, sessionID, checkoutURL)
}

func (s releaseFailStore) ReleaseAbandonedStripeCheckout(context.Context, BillingAuthority, BillingPurchaseAttempt, int64) (bool, error) {
	return false, s.err
}

// When the release write itself fails we cannot tell whether it applied. That
// is the one case that must NOT fall through to the ordinary retry path: a
// dispatch on top of an unknown attempt state is exactly the shape that opens a
// second Session. Fail the request closed instead.
func TestCheckoutAbandonedReleaseLocalWriteFailureFailsClosed(t *testing.T) {
	f := newReleaseFixture(t)
	attempt := f.abandon(t, "price_pro_m")
	f.stub.sessions[oldSessionID] = abandonedSessionJSON(oldSessionID, releaseCustomerID, f.userID, attempt.ID, nil)
	f.svc.store = releaseFailStore{Store: f.svc.store, err: errors.New("injected release CAS failure")}
	before := f.entitlementSnapshot(t)
	beforeAuthority := f.authorityRow(t)

	code, _ := f.checkout(t, "pro", "monthly")
	if code != http.StatusInternalServerError {
		t.Fatalf("MONEY: an unreportable release write returned %d, want 500", code)
	}
	if n := f.stub.createdSessions(); n != 0 {
		t.Fatalf("MONEY: %d Sessions created after an unreportable release write", n)
	}
	if got := f.attemptRow(t, attempt.ID); got.State != "dispatched" {
		t.Fatalf("attempt state = %q, want dispatched", got.State)
	}
	if after := f.authorityRow(t); after != beforeAuthority {
		t.Fatalf("MONEY: authority advanced: %+v -> %+v", beforeAuthority, after)
	}
	if after := f.entitlementSnapshot(t); after != before {
		t.Fatalf("MONEY: entitlement moved: %v -> %v", before, after)
	}
}

// The CAS-loss path, deterministically: canonical proof IS obtained, and then
// the store reports that the compare-and-swap did not apply. The concurrency
// test reaches this through real goroutine scheduling; this one pins the
// contract so a regression cannot hide behind a lucky interleaving.
//
// The distinction being asserted is the whole point of the three-state outcome.
// A BLOCKED release proved nothing, so the stored URL may still be live and is
// returned as before. A LOST release already proved that exact URL expired, so
// returning it would send the user to a dead Stripe page — it must refuse.
func TestCheckoutAbandonedReleaseCASLossRefusesInsteadOfServingTheDeadURL(t *testing.T) {
	f := newReleaseFixture(t)
	attempt := f.abandon(t, "price_pro_m")
	f.stub.sessions[oldSessionID] = abandonedSessionJSON(oldSessionID, releaseCustomerID, f.userID, attempt.ID, nil)
	// err nil + released false is exactly "the CAS matched no row".
	f.svc.store = releaseFailStore{Store: f.svc.store}
	before := f.entitlementSnapshot(t)
	beforeAuthority := f.authorityRow(t)

	for _, plan := range []struct{ id, cycle string }{{"pro", "monthly"}, {"max", "yearly"}} {
		code, out := f.checkout(t, plan.id, plan.cycle)
		if code != http.StatusConflict || out["error"] != "billing_reconciliation_required" {
			t.Fatalf("%s/%s after a lost CAS: status %d body %v, want 409 billing_reconciliation_required",
				plan.id, plan.cycle, code, out)
		}
		if out["url"] == oldSessionURL {
			t.Fatalf("MONEY: a lost CAS served the Session it had just proven expired (%q)", oldSessionURL)
		}
	}
	// A lost CAS is not permission to dispatch: the reason for the loss is
	// unknown, so nothing new may be created on that assumption.
	if n := f.stub.createdSessions(); n != 0 {
		t.Fatalf("MONEY: %d Sessions created after a lost CAS", n)
	}
	if got := f.attemptRow(t, attempt.ID); got.State != "dispatched" {
		t.Fatalf("attempt state = %q, want dispatched", got.State)
	}
	if after := f.authorityRow(t); after != beforeAuthority {
		t.Fatalf("MONEY: a lost CAS advanced the authority: %+v -> %+v", beforeAuthority, after)
	}
	if after := f.entitlementSnapshot(t); after != before {
		t.Fatalf("MONEY: a lost CAS moved entitlement: %v -> %v", before, after)
	}
}

// A Biller that cannot make the canonical read is never asked to guess. It
// keeps exactly the behaviour that shipped before this file existed, which is
// also why every pre-existing fakeBiller test is unaffected.
func TestCheckoutAbandonedReleaseBlocksWithoutCanonicalReader(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	fb := &fakeBiller{checkoutID: newSessionID, checkoutURL: newSessionURL}
	if _, ok := any(fb).(canonicalCheckoutReader); ok {
		t.Fatal("fakeBiller must not implement the canonical reader for this test to mean anything")
	}
	svc.biller = fb
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, PriceMonthly: 900, StripePriceMonthlyID: "price_pro_m"})
	email := "no-canonical-reader@example.com"
	cookie := loginCookie(t, ts, mail, email)
	uid := mustUserID(t, store, email)
	if err := store.SetUserStripeCustomer(context.Background(), uid, releaseCustomerID); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	authority, err := store.AcquireBillingAuthority(ctx, BillingAuthorityRequest{UserID: uid, Provider: ProviderStripe, Now: 1750000000})
	if err != nil {
		t.Fatal(err)
	}
	attempt, _, err := store.DispatchBillingPurchase(ctx, authority, "price_pro_m", 1750000000)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetBillingPurchaseProviderSession(ctx, uid, attempt.ID, oldSessionID, oldSessionURL); err != nil {
		t.Fatal(err)
	}

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/billing/checkout", strings.NewReader(`{"planId":"pro","cycle":"monthly"}`))
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out := map[string]string{}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if resp.StatusCode != http.StatusOK || out["url"] != oldSessionURL {
		t.Fatalf("status %d url %q, want the pre-existing 200 + %q", resp.StatusCode, out["url"], oldSessionURL)
	}
	if fb.checkoutCalls != 0 {
		t.Fatalf("MONEY: %d Sessions created without a canonical reader", fb.checkoutCalls)
	}
	var state string
	if err := store.db.QueryRowContext(ctx, `SELECT state FROM billing_purchase_attempts WHERE id=?`, attempt.ID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "dispatched" {
		t.Fatalf("attempt state = %q, want dispatched", state)
	}
}

// --- the predicate, clause by clause --------------------------------------

// checkoutAttemptReleasable is the last line before the CAS. Each mutation
// below is a single broken clause, and every one of them must refuse.
func TestCheckoutAttemptReleasablePredicate(t *testing.T) {
	const (
		uid = "user_predicate"
		cus = "cus_predicate"
		att = "attempt_predicate"
		ses = "cs_test_predicate"
	)
	base := canonicalAbandonedCheckout{
		ID: ses, Customer: cus, ClientReferenceID: uid, MetadataUserID: uid, BillingAttemptID: att,
		Status: "expired", PaymentStatus: "unpaid", Mode: "subscription",
		LiveMode: false, Created: 1750000000, ExpiresAt: 1750086400,
	}
	attempt := BillingPurchaseAttempt{
		ID: att, UserID: uid, Provider: ProviderStripe, ProductID: "price_pro_m",
		State: "dispatched", ProviderSessionID: ses, Epoch: 1,
	}
	if !checkoutAttemptReleasable(base, attempt, uid, cus, false) {
		t.Fatal("the canonical dead session must be releasable")
	}
	// The live-mode pairing is symmetric: a live key + a live session releases.
	live := base
	live.LiveMode = true
	if !checkoutAttemptReleasable(live, attempt, uid, cus, true) {
		t.Fatal("a live-mode session must be releasable under a live-mode key")
	}

	sessionMutations := map[string]func(*canonicalAbandonedCheckout){
		"status open":            func(s *canonicalAbandonedCheckout) { s.Status = "open" },
		"status complete":        func(s *canonicalAbandonedCheckout) { s.Status = "complete" },
		"status empty":           func(s *canonicalAbandonedCheckout) { s.Status = "" },
		"payment paid":           func(s *canonicalAbandonedCheckout) { s.PaymentStatus = "paid" },
		"payment empty":          func(s *canonicalAbandonedCheckout) { s.PaymentStatus = "" },
		"mode payment":           func(s *canonicalAbandonedCheckout) { s.Mode = "payment" },
		"mode setup":             func(s *canonicalAbandonedCheckout) { s.Mode = "setup" },
		"livemode mismatch":      func(s *canonicalAbandonedCheckout) { s.LiveMode = true },
		"other session id":       func(s *canonicalAbandonedCheckout) { s.ID = "cs_test_other" },
		"other customer":         func(s *canonicalAbandonedCheckout) { s.Customer = "cus_other" },
		"other client ref":       func(s *canonicalAbandonedCheckout) { s.ClientReferenceID = "user_other" },
		"other metadata user":    func(s *canonicalAbandonedCheckout) { s.MetadataUserID = "user_other" },
		"other metadata attempt": func(s *canonicalAbandonedCheckout) { s.BillingAttemptID = "attempt_other" },
		"created zero":           func(s *canonicalAbandonedCheckout) { s.Created = 0 },
		"created negative":       func(s *canonicalAbandonedCheckout) { s.Created = -1 },
		"expires zero":           func(s *canonicalAbandonedCheckout) { s.ExpiresAt = 0 },
		"expires negative":       func(s *canonicalAbandonedCheckout) { s.ExpiresAt = -1 },
	}
	for name, apply := range sessionMutations {
		t.Run("session/"+name, func(t *testing.T) {
			session := base
			apply(&session)
			if checkoutAttemptReleasable(session, attempt, uid, cus, false) {
				t.Fatalf("MONEY: %s was judged releasable", name)
			}
		})
	}

	attemptMutations := map[string]func(*BillingPurchaseAttempt){
		"prepared":            func(a *BillingPurchaseAttempt) { a.State = "prepared" },
		"resolved":            func(a *BillingPurchaseAttempt) { a.State = "resolved" },
		"empty state":         func(a *BillingPurchaseAttempt) { a.State = "" },
		"apple provider":      func(a *BillingPurchaseAttempt) { a.Provider = ProviderApple },
		"empty provider":      func(a *BillingPurchaseAttempt) { a.Provider = "" },
		"empty session":       func(a *BillingPurchaseAttempt) { a.ProviderSessionID = "" },
		"non-cs session":      func(a *BillingPurchaseAttempt) { a.ProviderSessionID = "sub_not_a_session" },
		"subscription bound":  func(a *BillingPurchaseAttempt) { a.ProviderSubscriptionID = "sub_live_1" },
		"other user":          func(a *BillingPurchaseAttempt) { a.UserID = "user_other" },
		"empty user":          func(a *BillingPurchaseAttempt) { a.UserID = "" },
		"empty id":            func(a *BillingPurchaseAttempt) { a.ID = "" },
		"other attempt id":    func(a *BillingPurchaseAttempt) { a.ID = "attempt_other" },
		"other session bound": func(a *BillingPurchaseAttempt) { a.ProviderSessionID = "cs_test_other" },
	}
	for name, apply := range attemptMutations {
		t.Run("attempt/"+name, func(t *testing.T) {
			mutated := attempt
			apply(&mutated)
			if checkoutAttemptReleasable(base, mutated, uid, cus, false) {
				t.Fatalf("MONEY: %s was judged releasable", name)
			}
		})
	}

	t.Run("caller/empty user", func(t *testing.T) {
		if checkoutAttemptReleasable(base, attempt, "", cus, false) {
			t.Fatal("MONEY: an empty caller user was judged releasable")
		}
	})
	t.Run("caller/empty customer", func(t *testing.T) {
		if checkoutAttemptReleasable(base, attempt, uid, "", false) {
			t.Fatal("MONEY: an empty caller customer was judged releasable")
		}
	})
}

// The recovered checkout must be a genuinely NEW dispatch — a new attempt id
// carried into Stripe's metadata at the requested price — not the old attempt
// handed back with a fresh URL. The webhook binds on that metadata, so reusing
// the retired id would bind a new subscription to a resolved attempt.
func TestCheckoutRecoveredSessionCarriesANewAttempt(t *testing.T) {
	f := newReleaseFixture(t)
	old := f.abandon(t, "price_pro_m")
	f.stub.sessions[oldSessionID] = abandonedSessionJSON(oldSessionID, releaseCustomerID, f.userID, old.ID, nil)

	if code, _ := f.checkout(t, "max", "yearly"); code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	f.stub.mu.Lock()
	forms := append([]map[string][]string(nil), f.stub.createSessionRaw...)
	f.stub.mu.Unlock()
	if len(forms) != 1 {
		t.Fatalf("created %d Sessions, want 1", len(forms))
	}
	form := url.Values(forms[0])
	newAttempt := form.Get("metadata[billing_attempt_id]")
	if newAttempt == "" || newAttempt == old.ID {
		t.Fatalf("MONEY: the recovered Session reuses the retired attempt id %q", newAttempt)
	}
	if got := form.Get("line_items[0][price]"); got != "price_max_y" {
		t.Fatalf("recovered Session price = %q, want price_max_y", got)
	}
	if got := form.Get("client_reference_id"); got != f.userID {
		t.Fatalf("recovered Session client_reference_id = %q, want %q", got, f.userID)
	}
	if got := form.Get("customer"); got != releaseCustomerID {
		t.Fatalf("recovered Session customer = %q, want %q", got, releaseCustomerID)
	}
	if got := form.Get("mode"); got != "subscription" {
		t.Fatalf("recovered Session mode = %q, want subscription", got)
	}
	// The new attempt is dispatched on the advanced generation and carries the
	// new Session; the retired one keeps its own history.
	fresh := f.attemptRow(t, newAttempt)
	if fresh.State != "dispatched" || fresh.Epoch != old.Epoch+1 || fresh.ProviderSessionID != newSessionID || fresh.ProductID != "price_max_y" {
		t.Fatalf("recovered attempt = %+v", fresh)
	}
	retired := f.attemptRow(t, old.ID)
	if retired.State != "resolved" || retired.ProviderSessionID != oldSessionID || retired.ProviderSubscriptionID != "" || retired.Epoch != old.Epoch {
		t.Fatalf("MONEY: retired attempt = %+v", retired)
	}
}

// localCheckoutAttemptReleasable is shared by the caller-side predicate and the
// store CAS guard, so it gets its own coverage rather than only being reached
// through one of them.
func TestLocalCheckoutAttemptReleasable(t *testing.T) {
	base := BillingPurchaseAttempt{
		ID: "attempt_local", UserID: "user_local", Provider: ProviderStripe,
		ProductID: "price_pro_m", State: "dispatched", ProviderSessionID: "cs_test_local", Epoch: 1,
	}
	if !localCheckoutAttemptReleasable(base, "user_local") {
		t.Fatal("a dispatched stripe attempt with a session must pass the local gate")
	}
	blocking := map[string]func(*BillingPurchaseAttempt){
		"prepared":           func(a *BillingPurchaseAttempt) { a.State = "prepared" },
		"resolved":           func(a *BillingPurchaseAttempt) { a.State = "resolved" },
		"apple":              func(a *BillingPurchaseAttempt) { a.Provider = ProviderApple },
		"no session":         func(a *BillingPurchaseAttempt) { a.ProviderSessionID = "" },
		"not a session id":   func(a *BillingPurchaseAttempt) { a.ProviderSessionID = "seti_1" },
		"subscription bound": func(a *BillingPurchaseAttempt) { a.ProviderSubscriptionID = "sub_1" },
		"other user":         func(a *BillingPurchaseAttempt) { a.UserID = "user_other" },
		"no id":              func(a *BillingPurchaseAttempt) { a.ID = "" },
	}
	for name, apply := range blocking {
		t.Run(name, func(t *testing.T) {
			mutated := base
			apply(&mutated)
			if localCheckoutAttemptReleasable(mutated, "user_local") {
				t.Fatalf("MONEY: %s passed the local gate", name)
			}
		})
	}
	if localCheckoutAttemptReleasable(base, "") {
		t.Fatal("MONEY: an empty caller user passed the local gate")
	}
}

// The caller's attempt is a SNAPSHOT. Between reading it and running the CAS a
// webhook can bind a subscription, a lifecycle event can resolve the attempt,
// or another release can retire it — and the snapshot still looks releasable.
// Every clause of the UPDATE exists for exactly that window, so each is proven
// against a row that diverged after the caller read it.
func TestReleaseAbandonedStripeCheckoutRefusesRowChangedAfterRead(t *testing.T) {
	diverge := map[string]func(t *testing.T, store *SQLiteStore, uid string, attempt BillingPurchaseAttempt){
		// The financial one: checkout.session.completed landed first.
		"subscription bound by a webhook": func(t *testing.T, store *SQLiteStore, uid string, a BillingPurchaseAttempt) {
			if err := store.BindStripePurchaseSubscription(context.Background(), uid, a.ID, a.ProviderSessionID, "sub_live_1"); err != nil {
				t.Fatal(err)
			}
		},
		"already resolved": func(t *testing.T, store *SQLiteStore, _ string, a BillingPurchaseAttempt) {
			if _, err := store.db.Exec(`UPDATE billing_purchase_attempts SET state='resolved' WHERE id=?`, a.ID); err != nil {
				t.Fatal(err)
			}
		},
		"product changed": func(t *testing.T, store *SQLiteStore, _ string, a BillingPurchaseAttempt) {
			if _, err := store.db.Exec(`UPDATE billing_purchase_attempts SET product_id='price_other' WHERE id=?`, a.ID); err != nil {
				t.Fatal(err)
			}
		},
		"session re-bound": func(t *testing.T, store *SQLiteStore, _ string, a BillingPurchaseAttempt) {
			if _, err := store.db.Exec(`UPDATE billing_purchase_attempts SET provider_session_id='cs_test_other' WHERE id=?`, a.ID); err != nil {
				t.Fatal(err)
			}
		},
		"epoch moved on": func(t *testing.T, store *SQLiteStore, _ string, a BillingPurchaseAttempt) {
			if _, err := store.db.Exec(`UPDATE billing_purchase_attempts SET epoch=epoch+1 WHERE id=?`, a.ID); err != nil {
				t.Fatal(err)
			}
		},
		"attempt reassigned": func(t *testing.T, store *SQLiteStore, _ string, a BillingPurchaseAttempt) {
			if _, err := store.db.Exec(`UPDATE billing_purchase_attempts SET user_id='user_other' WHERE id=?`, a.ID); err != nil {
				t.Fatal(err)
			}
		},
		"provider rewritten": func(t *testing.T, store *SQLiteStore, _ string, a BillingPurchaseAttempt) {
			if _, err := store.db.Exec(`UPDATE billing_purchase_attempts SET provider='apple' WHERE id=?`, a.ID); err != nil {
				t.Fatal(err)
			}
		},
	}
	for name, apply := range diverge {
		t.Run(name, func(t *testing.T) {
			store := newTestStore(t)
			ctx := context.Background()
			uid := newReleaseUser(t, store, "cas-toctou@example.test")
			authority, err := store.AcquireBillingAuthority(ctx, BillingAuthorityRequest{UserID: uid, Provider: ProviderStripe, Now: 1750000000})
			if err != nil {
				t.Fatal(err)
			}
			attempt, _, err := store.DispatchBillingPurchase(ctx, authority, "price_pro_m", 1750000000)
			if err != nil {
				t.Fatal(err)
			}
			if err := store.SetBillingPurchaseProviderSession(ctx, uid, attempt.ID, oldSessionID, oldSessionURL); err != nil {
				t.Fatal(err)
			}
			// The snapshot the caller proved dead: still dispatched, still on
			// this session, still carrying no subscription.
			attempt.ProviderSessionID = oldSessionID

			apply(t, store, uid, attempt)

			released, err := store.ReleaseAbandonedStripeCheckout(ctx, authority, attempt, 1750100000)
			if err != nil {
				t.Fatalf("a diverged row must be a refusal, not an error: %v", err)
			}
			if released {
				t.Fatalf("MONEY: the CAS released an attempt whose row had changed (%s)", name)
			}
			var state, sub string
			if err := store.db.QueryRowContext(ctx, `SELECT state,provider_subscription_id FROM billing_purchase_attempts WHERE id=?`, attempt.ID).Scan(&state, &sub); err != nil {
				t.Fatal(err)
			}
			if name == "already resolved" {
				if state != "resolved" {
					t.Fatalf("state = %q, want the pre-existing resolved", state)
				}
			} else if state != "dispatched" {
				t.Fatalf("MONEY: %s left the attempt in state %q, want dispatched", name, state)
			}
			if name == "subscription bound by a webhook" && sub != "sub_live_1" {
				t.Fatalf("MONEY: the bound subscription was lost: %q", sub)
			}
			after, _, err := store.BillingAuthority(ctx, uid)
			if err != nil {
				t.Fatal(err)
			}
			if after.Epoch != authority.Epoch || after.IntentID != authority.IntentID {
				t.Fatalf("MONEY: %s advanced the authority to epoch %d", name, after.Epoch)
			}
		})
	}
}
