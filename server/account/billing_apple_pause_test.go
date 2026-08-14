package account

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

// The global App Store new-purchase gate.
//
// The property under test throughout is a pair, and neither half is worth
// anything without the other:
//
//   - CLOSED, this deployment offers nothing, so a build that is already in the
//     App Store — which can only start a purchase from an identifier this
//     server named — cannot start one; and
//   - CLOSED, this deployment still accepts every transaction Apple has already
//     charged for. A pause on SELLING that became a pause on HONOURING would
//     take money from a customer and give them nothing, which is strictly worse
//     than the incident the pause was reached for.

// applePurchaseGateForm builds the one-field form each button posts.
func applePurchaseGateForm(enabled bool) url.Values {
	if enabled {
		return url.Values{"enabled": {"1"}}
	}
	return url.Values{"enabled": {"0"}}
}

// pauseApplePurchases writes the gate directly, as an operator's confirmed
// action would leave it. Used by the API-side tests, which are about what a
// closed gate DOES rather than about how it gets closed.
func pauseApplePurchases(t *testing.T, store *SQLiteStore, enabled bool) {
	t.Helper()
	value := int64(0)
	if enabled {
		value = 1
	}
	if err := store.SetSetting(context.Background(), SettingApplePurchasesEnabled, value, 1); err != nil {
		t.Fatalf("SetSetting(%s, %d): %v", SettingApplePurchasesEnabled, value, err)
	}
}

func applePurchaseGateAudit(t *testing.T, store *SQLiteStore) []AuditEntry {
	t.Helper()
	entries, err := store.ListAudit(context.Background(), 50, 0, AuditApplePurchases)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	return entries
}

// ---- the default ------------------------------------------------------------

// **A deployment that has never touched this row is SELLING.**
//
// Absent must mean enabled, and this is the assertion that pins it: every
// deployment in the world has no such row today, and a gate that read absence
// as "closed" would stop every App Store sale everywhere the moment it shipped.
func TestAppleGateDefaultsToEnabledOnAFreshDeployment(t *testing.T) {
	f := newAppleCatalogFixture(t)
	if _, ok, err := f.store.GetSetting(context.Background(), SettingApplePurchasesEnabled); err != nil || ok {
		t.Fatalf("a fresh store already carries the gate row: ok=%v err=%v", ok, err)
	}
	enabled, err := f.svc.applePurchasesEnabled(context.Background())
	if err != nil {
		t.Fatalf("applePurchasesEnabled: %v", err)
	}
	if !enabled {
		t.Fatal("SECURITY/REVENUE: a deployment with no gate row reads as paused")
	}
}

// And the default reaches the wire: an untouched deployment describes its
// products and says the gate is open, so a client can tell "open" from "this
// server has no gate at all" without a version negotiation.
func TestAppleGateDefaultAnswersEnabledWithTheProducts(t *testing.T) {
	f := newAppleCatalogFixture(t)
	mustAppleProduct(t, f.store, AppleProduct{
		BundleID: testBundleMac, ProductID: "com.relayium.mac.pro.monthly",
		PlanID: "pro", Cycle: "monthly", Active: true,
	})

	resp := f.get(t, macQuery)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}
	body := f.decode(t, resp)
	if !body.Purchases.Enabled || body.Purchases.Reason != "" {
		t.Fatalf("default gate = %+v, want enabled with no reason", body.Purchases)
	}
	if len(body.Products) != 1 {
		t.Fatalf("want the mapped product described, got %d", len(body.Products))
	}
}

// ---- paused: nothing to sell -------------------------------------------------

// **The already-shipped build's only lever.** A purchase starts from a product
// identifier the server named; paused, it names none — whatever the catalog
// table holds, and for every configured bundle.
func TestAppleGatePausedDescribesNoProduct(t *testing.T) {
	f := newAppleCatalogFixture(t)
	for _, p := range []AppleProduct{
		{BundleID: testBundleMac, ProductID: "com.relayium.mac.pro.monthly", PlanID: "pro", Cycle: "monthly", Active: true},
		{BundleID: testBundleMac, ProductID: "com.relayium.mac.max.yearly", PlanID: "max", Cycle: "yearly", Active: true},
		{BundleID: testBundleIOS, ProductID: "com.relayium.ios.pro.monthly", PlanID: "pro", Cycle: "monthly", Active: true},
	} {
		mustAppleProduct(t, f.store, p)
	}
	if ids := f.productIDs(t, macQuery); len(ids) != 2 {
		t.Fatalf("precondition: want 2 live mac products, got %v", ids)
	}

	pauseApplePurchases(t, f.store, false)

	for _, query := range []string{macQuery, "?bundleId=" + testBundleIOS} {
		resp := f.get(t, query)
		body := f.decode(t, resp)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s: want 200 while paused, got %d", query, resp.StatusCode)
		}
		if len(body.Products) != 0 {
			t.Fatalf("SECURITY: %s described %d products while paused", query, len(body.Products))
		}
		if body.Purchases.Enabled || body.Purchases.Reason != applePurchasesReasonPaused {
			t.Fatalf("%s: gate = %+v, want disabled/paused", query, body.Purchases)
		}
	}
}

// The empty list encodes as `[]`, never `null`. A client that told the two
// apart must not be able to mistake a paused deployment for a broken response.
func TestAppleGatePausedEncodesAnEmptyArrayNotNull(t *testing.T) {
	f := newAppleCatalogFixture(t)
	mustAppleProduct(t, f.store, AppleProduct{
		BundleID: testBundleMac, ProductID: "com.relayium.mac.pro.monthly",
		PlanID: "pro", Cycle: "monthly", Active: true,
	})
	pauseApplePurchases(t, f.store, false)

	resp := f.get(t, macQuery)
	defer resp.Body.Close()
	raw := readAll(t, resp)
	if !strings.Contains(raw, `"products":[]`) {
		t.Fatalf("paused body does not carry an empty product array: %s", raw)
	}
	if !strings.Contains(raw, `"purchases":{"enabled":false,"reason":"paused"}`) {
		t.Fatalf("paused body does not carry the gate: %s", raw)
	}
}

// **A pause is not a statement about any account.** The per-account eligibility
// answer stays the true one, so a Stripe subscriber still reads "your
// subscription is managed on relayium.com" rather than being told, falsely,
// that somebody else owns their subscription.
func TestAppleGatePausedLeavesPerAccountEligibilityAlone(t *testing.T) {
	f := newAppleCatalogFixture(t)
	if _, err := f.store.ApplySubscriptionSource(context.Background(), SourceEvent{
		UserID: f.userID, Provider: ProviderStripe, PlanID: "pro", Status: "active",
		Cycle: "monthly", PeriodEnd: 1_900_000_000, EventAt: 100, Now: time.Now().Unix(),
	}); err != nil {
		t.Fatalf("seed a live stripe source: %v", err)
	}
	pauseApplePurchases(t, f.store, false)

	resp := f.get(t, macQuery)
	defer resp.Body.Close()
	body := f.decode(t, resp)
	if body.Purchase.Allowed {
		t.Fatal("a stripe-owned account reads as allowed")
	}
	if body.Purchase.BlockedBy != ProviderStripe {
		t.Fatalf("blockedBy = %q, want %q — the pause overwrote the account's own answer",
			body.Purchase.BlockedBy, ProviderStripe)
	}
}

// Resuming restores exactly the catalog that was there. The gate changes no
// mapping, so there is nothing to rebuild.
func TestAppleGateResumeRestoresTheSameCatalog(t *testing.T) {
	f := newAppleCatalogFixture(t)
	mustAppleProduct(t, f.store, AppleProduct{
		BundleID: testBundleMac, ProductID: "com.relayium.mac.pro.monthly",
		PlanID: "pro", Cycle: "monthly", Active: true,
	})
	before := f.productIDs(t, macQuery)

	pauseApplePurchases(t, f.store, false)
	if ids := f.productIDs(t, macQuery); len(ids) != 0 {
		t.Fatalf("paused still describes %v", ids)
	}
	pauseApplePurchases(t, f.store, true)

	after := f.productIDs(t, macQuery)
	if len(after) != len(before) || (len(after) > 0 && after[0] != before[0]) {
		t.Fatalf("resume changed the catalog: %v -> %v", before, after)
	}
}

// The gate is the LAST guard, not the first: an unconfigured verifier and an
// unknown bundle still answer as themselves while paused, so a client cannot
// use the pause to learn what the deployment would otherwise have refused.
func TestAppleGatePausedKeepsTheEarlierRefusalsIntact(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	seedTiers(t, store)
	pauseApplePurchases(t, store, false)
	f := &appleCatalogFixture{ts: ts, svc: svc, store: store, mail: mail,
		cookie: loginCookie(t, ts, mail, "apple-gate-unconfigured@example.com")}

	resp := f.get(t, macQuery)
	resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("paused + no verifier: want the 503 the verifier check gives, got %d", resp.StatusCode)
	}

	svc.SetAppleTransactionVerifier(testVerifier(t, newAppleTestChain(t)))
	resp = f.get(t, "?bundleId=com.example.not-configured")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("paused + unknown bundle: want 400, got %d", resp.StatusCode)
	}
	if code := decodeErrBody(t, resp)["error"]; code != "unknown_bundle" {
		t.Fatalf("want unknown_bundle, got %q", code)
	}
}

// ---- CRITICAL: the paid side is untouched ------------------------------------

// **The one that matters most.** A customer Apple has already charged submits
// their signed transaction while the gate is closed, and it must be accepted
// and applied exactly as it would have been with the gate open.
//
// This is the shape of the race the gate creates: an old client loaded the
// catalog, the operator paused, the user completed the purchase, and the money
// has moved. The transaction is unfinished on the device, and the ONLY thing
// that can turn it into an entitlement is this endpoint saying yes.
//
// MUTATION PROOF: add a gate check to handleAppleTransaction — the single most
// plausible way to "make the pause thorough" — and this fails.
func TestAppleGatePausedStillAppliesAValidTransaction(t *testing.T) {
	f := newAppleTxFixture(t)
	pauseApplePurchases(t, f.store, false)

	result, raw := f.mustAccept(t, f.chain.sign(t, f.payload()))
	if !result.Applied {
		t.Fatalf("a paid transaction was not applied while paused: %s", raw)
	}
	if result.PlanID != "pro" {
		t.Fatalf("planId = %q, want pro: %s", result.PlanID, raw)
	}
	if result.Provider != ProviderApple {
		t.Fatalf("provider = %q, want apple: %s", result.Provider, raw)
	}
	// And the entitlement is really on the account, not merely reported.
	if u := f.user(t); u.PlanID != "pro" || u.PlanSource != ProviderApple {
		t.Fatalf("the account did not receive what it paid for: plan=%q source=%q",
			u.PlanID, u.PlanSource)
	}
}

// The account-token endpoint is on the same paid path — a purchase already in
// flight fetches it — and is likewise not gated.
func TestAppleGatePausedStillMintsTheAccountToken(t *testing.T) {
	f := newAppleTxFixture(t)
	pauseApplePurchases(t, f.store, false)
	if got := postAppleToken(t, f.ts, f.cookie); got != f.token {
		t.Fatalf("account token changed while paused: %q vs %q", got, f.token)
	}
}

// ---- the admin control -------------------------------------------------------

// The route's security value: the POST that carries the operator's intent
// produces a confirmation page and changes NOTHING.
//
// MUTATION PROOF: drop RequireStepUp from the /admin/apple-purchases
// registration and this fails twice — the response becomes a 302 and the row
// exists.
func TestApplePurchaseGatePostDoesNotWriteBeforeConfirmation(t *testing.T) {
	ts, _, store, _ := newAppleCatalogServer(t)
	seedAppleTiers(t, store)
	cookie := adminLoginCookie(t, ts)

	resp := postAdminForm(t, ts, cookie, "/admin/apple-purchases", applePurchaseGateForm(false))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want a 200 confirmation page, got %d", resp.StatusCode)
	}
	body := readAll(t, resp)
	if !strings.Contains(body, "confirm_token") {
		t.Fatal("the confirmation page carries no pending-action token")
	}
	if _, ok, _ := store.GetSetting(context.Background(), SettingApplePurchasesEnabled); ok {
		t.Fatal("SECURITY: the gate was written without confirmation")
	}
	// And the page must state what it is about to do — the action, the one
	// thing it touches, and the exact before → after transition, as one diff
	// row rather than as two values that happen to appear somewhere on it.
	for _, want := range []string{
		AuditApplePurchases,
		applePurchaseGateTarget,
		`<td>` + SettingApplePurchasesEnabled + `</td><td class="old">true</td><td class="new">false</td>`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("confirmation page does not mention %q", want)
		}
	}
}

// The confirmed pause lands, and it is audited as its own action with the
// before/after values and the factor that was satisfied.
func TestApplePurchaseGateConfirmedPauseAppliesAndAudits(t *testing.T) {
	ts, svc, store, _ := newAppleCatalogServer(t)
	seedAppleTiers(t, store)
	cookie := adminLoginCookie(t, ts)

	resp := confirmAction(t, ts, cookie, "/admin/apple-purchases", applePurchaseGateForm(false))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("confirmed pause: want 302, got %d", resp.StatusCode)
	}

	enabled, err := svc.applePurchasesEnabled(context.Background())
	if err != nil {
		t.Fatalf("applePurchasesEnabled: %v", err)
	}
	if enabled {
		t.Fatal("the confirmed pause did not land")
	}

	entries := applePurchaseGateAudit(t, store)
	if len(entries) != 1 {
		t.Fatalf("want exactly 1 %s audit entry, got %d", AuditApplePurchases, len(entries))
	}
	e := entries[0]
	if e.Target != applePurchaseGateTarget {
		t.Fatalf("audit target = %q, want %q", e.Target, applePurchaseGateTarget)
	}
	want := `[{"field":"` + SettingApplePurchasesEnabled + `","old":true,"new":false}]`
	if e.Changes != want {
		t.Errorf("audit changes = %s, want %s", e.Changes, want)
	}
	if e.StepUp != StepUpPassword {
		t.Errorf("audit step-up factor = %q, want %q", e.StepUp, StepUpPassword)
	}
}

// Resuming is a confirmed, audited action of its own — not an unguarded
// shortcut. Re-opening sales is the click that starts charging customers again
// for whatever the pause was called for.
func TestApplePurchaseGateResumeIsAlsoConfirmedAndAudited(t *testing.T) {
	ts, svc, store, _ := newAppleCatalogServer(t)
	seedAppleTiers(t, store)
	cookie := adminLoginCookie(t, ts)
	pauseApplePurchases(t, store, false)

	// Unconfirmed first: it must still only render a page.
	resp := postAdminForm(t, ts, cookie, "/admin/apple-purchases", applePurchaseGateForm(true))
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("unconfirmed resume: want a 200 confirmation page, got %d", resp.StatusCode)
	}
	if enabled, _ := svc.applePurchasesEnabled(context.Background()); enabled {
		t.Fatal("SECURITY: an unconfirmed resume re-opened sales")
	}

	resp = confirmAction(t, ts, cookie, "/admin/apple-purchases", applePurchaseGateForm(true))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("confirmed resume: want 302, got %d", resp.StatusCode)
	}
	if enabled, _ := svc.applePurchasesEnabled(context.Background()); !enabled {
		t.Fatal("the confirmed resume did not land")
	}
	if n := len(applePurchaseGateAudit(t, store)); n != 1 {
		t.Fatalf("want 1 audit entry for the resume, got %d", n)
	}
}

// The written row survives a restart: it is a database row, not process state.
// A brake that came back off at the next deploy is not a brake.
func TestApplePurchaseGateSurvivesARestart(t *testing.T) {
	ts, _, store, _ := newAppleCatalogServer(t)
	seedAppleTiers(t, store)
	cookie := adminLoginCookie(t, ts)

	resp := confirmAction(t, ts, cookie, "/admin/apple-purchases", applePurchaseGateForm(false))
	resp.Body.Close()

	// A second Service over the SAME store is what a restarted process is.
	// SeedSettings runs on every boot; it must not resurrect the gate.
	fresh := NewService(store, &capturingMailer{}, Config{BaseURL: "http://example.test"})
	if err := fresh.SeedSettings(context.Background()); err != nil {
		t.Fatalf("SeedSettings: %v", err)
	}
	enabled, err := fresh.applePurchasesEnabled(context.Background())
	if err != nil {
		t.Fatalf("applePurchasesEnabled: %v", err)
	}
	if enabled {
		t.Fatal("the pause did not survive a restart")
	}
}

// Only the two spellings the buttons post are accepted. An absent or
// unrecognised value is refused rather than read as either state — the shape a
// checkbox would have, where "unchecked" and "not submitted" are the same wire
// fact.
func TestApplePurchaseGateRefusesAnythingButTheTwoStates(t *testing.T) {
	for _, form := range []url.Values{
		{}, {"enabled": {""}}, {"enabled": {"true"}}, {"enabled": {"2"}},
		{"enabled": {"on"}}, {"enabled": {"0", "1"}},
	} {
		if _, err := parseApplePurchaseGateForm(form); err == nil {
			t.Errorf("form %v was accepted", form)
		}
	}
	for value, want := range map[string]bool{"1": true, " 1 ": true, "0": false, "0\n": false} {
		got, err := parseApplePurchaseGateForm(url.Values{"enabled": {value}})
		if err != nil || got != want {
			t.Errorf("parse(%q) = %v, %v; want %v, nil", value, got, err, want)
		}
	}
}

// An unauthenticated POST changes nothing and logs nothing.
func TestApplePurchaseGateRejectsUnauthenticatedPost(t *testing.T) {
	ts, _, store, _ := newAppleCatalogServer(t)
	seedAppleTiers(t, store)

	req, err := http.NewRequest(http.MethodPost, ts.URL+"/admin/apple-purchases",
		strings.NewReader(applePurchaseGateForm(false).Encode()))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if loc := resp.Header.Get("Location"); loc != "/admin" {
		t.Fatalf("anonymous POST location = %q, want the login redirect", loc)
	}
	if _, ok, _ := store.GetSetting(context.Background(), SettingApplePurchasesEnabled); ok {
		t.Fatal("SECURITY: an anonymous POST wrote the gate")
	}
	if n := len(applePurchaseGateAudit(t, store)); n != 0 {
		t.Fatalf("anonymous POST produced %d audit entries", n)
	}
}

// A cross-origin POST is refused by CSRFGuard before anything else runs.
func TestApplePurchaseGateRejectsCrossOriginPost(t *testing.T) {
	ts, _, store, _ := newAppleCatalogServer(t)
	seedAppleTiers(t, store)
	cookie := adminLoginCookie(t, ts)

	req, err := http.NewRequest(http.MethodPost, ts.URL+"/admin/apple-purchases",
		strings.NewReader(applePurchaseGateForm(false).Encode()))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", "https://evil.example")
	req.AddCookie(cookie)
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 400 {
		t.Fatalf("cross-origin POST was not refused: %d", resp.StatusCode)
	}
	if _, ok, _ := store.GetSetting(context.Background(), SettingApplePurchasesEnabled); ok {
		t.Fatal("SECURITY: a cross-origin POST wrote the gate")
	}
}

// The dashboard offers exactly one direction at a time, and the button it
// offers is the one that changes the live state. A panel that rendered both
// would make "pause" a coin flip during an incident.
func TestApplePurchaseGatePanelOffersTheOppositeOfTheLiveState(t *testing.T) {
	ts, _, store, _ := newAppleCatalogServer(t)
	seedAppleTiers(t, store)
	cookie := adminLoginCookie(t, ts)

	open := getAdminHome(t, ts, cookie)
	if !strings.Contains(open, `action="/admin/apple-purchases"`) {
		t.Fatal("the dashboard offers no gate control at all")
	}
	if !strings.Contains(open, `name="enabled" value="0"`) {
		t.Error("a selling deployment does not offer the pause button")
	}
	if strings.Contains(open, `name="enabled" value="1"`) {
		t.Error("a selling deployment offers a resume button too")
	}

	pauseApplePurchases(t, store, false)
	paused := getAdminHome(t, ts, cookie)
	if !strings.Contains(paused, `name="enabled" value="1"`) {
		t.Error("a paused deployment does not offer the resume button")
	}
	if strings.Contains(paused, `name="enabled" value="0"`) {
		t.Error("a paused deployment offers a pause button too")
	}
}

// ---- what the catalog says a tier grants -------------------------------------

// The purchase surface has to be able to describe the tier, and the figures
// must be the deployment's own — a client carrying its own copy would print a
// quantity this server does not grant, beside Apple's real price.
func TestAppleCatalogDescribesWhatEachTierGrants(t *testing.T) {
	f := newAppleCatalogFixture(t)
	mustAppleProduct(t, f.store, AppleProduct{
		BundleID: testBundleMac, ProductID: "com.relayium.mac.pro.monthly",
		PlanID: "pro", Cycle: "monthly", Active: true,
	})
	plan, ok, err := f.store.GetPlan(context.Background(), "pro")
	if err != nil || !ok {
		t.Fatalf("GetPlan(pro): ok=%v err=%v", ok, err)
	}

	resp := f.get(t, macQuery)
	defer resp.Body.Close()
	body := f.decode(t, resp)
	if len(body.Products) != 1 {
		t.Fatalf("want 1 product, got %d", len(body.Products))
	}
	got := body.Products[0]
	if got.StorageBytes != plan.StorageBytes || got.TrafficBytes != plan.TrafficBytes {
		t.Fatalf("catalog describes %d/%d, the plans row says %d/%d",
			got.StorageBytes, got.TrafficBytes, plan.StorageBytes, plan.TrafficBytes)
	}
	// An admin edit moves the described figure with it — there is one authority.
	plan.StorageBytes = 42 << 30
	plan.UpdatedAt = 2
	if err := f.store.UpsertPlan(context.Background(), plan); err != nil {
		t.Fatalf("UpsertPlan: %v", err)
	}
	resp2 := f.get(t, macQuery)
	defer resp2.Body.Close()
	if got := f.decode(t, resp2).Products[0].StorageBytes; got != 42<<30 {
		t.Fatalf("after the plan edit the catalog still says %d", got)
	}
}

// "Unlimited" is spelled 0 on the wire, the same convention /api/me/usage uses.
// A negative internal cap must never reach a client, where it would be read as
// a quota of minus one byte.
func TestAppleCatalogNormalizesAnUnlimitedCapToZero(t *testing.T) {
	f := newAppleCatalogFixture(t)
	ctx := context.Background()
	plan, _, err := f.store.GetPlan(ctx, "max")
	if err != nil {
		t.Fatalf("GetPlan(max): %v", err)
	}
	plan.StorageBytes, plan.TrafficBytes = -1, -1
	plan.UpdatedAt = 2
	if err := f.store.UpsertPlan(ctx, plan); err != nil {
		t.Fatalf("UpsertPlan: %v", err)
	}
	mustAppleProduct(t, f.store, AppleProduct{
		BundleID: testBundleMac, ProductID: "com.relayium.mac.max.yearly",
		PlanID: "max", Cycle: "yearly", Active: true,
	})

	resp := f.get(t, macQuery)
	defer resp.Body.Close()
	got := f.decode(t, resp).Products[0]
	if got.StorageBytes != 0 || got.TrafficBytes != 0 {
		t.Fatalf("unlimited reached the wire as %d/%d, want 0/0",
			got.StorageBytes, got.TrafficBytes)
	}
}
