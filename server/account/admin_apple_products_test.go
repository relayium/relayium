package account

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// Tests for the operator-managed App Store product catalog.
//
// The property under test throughout is not "the form works". It is that the
// one table standing between an Apple-signed, already-paid transaction — not
// yet accepted by this server, and so not yet finished on the device — and a
// granted tier can only be changed by an authenticated operator who was shown
// the true current row, confirmed the exact diff, and satisfied a second factor
// — and that nothing written here can make an unconfigured deployment start
// accepting purchases.

// appleCatalogNow is the fixed clock every server below runs on, so a
// server-stamped updated_at is an assertable value rather than "recent".
const appleCatalogNow = int64(1770000000)

// newAppleCatalogServer mounts the admin console AND the API. Both surfaces are
// needed because one test's claim spans them: writing catalog rows through the
// console must NOT make POST /api/billing/apple/transaction start accepting
// anything on a deployment with no verifier configured.
func newAppleCatalogServer(t *testing.T) (*httptest.Server, *Service, *SQLiteStore, *capturingMailer) {
	t.Helper()
	store := newTestStore(t)
	mail := &capturingMailer{}
	svc := NewService(store, mail, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour, MagicTTL: 15 * time.Minute,
		EnableMagic: true,
		AdminUser:   "admin", AdminPassword: "secret123",
	})
	svc.now = func() time.Time { return time.Unix(appleCatalogNow, 0) }
	mux := http.NewServeMux()
	svc.RegisterAdmin(mux)
	mux.Handle("/api/", svc.Routes())
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts, svc, store, mail
}

// appleForm builds a catalog-edit form exactly as the console's row form and
// add form submit one (an unchecked 启用 box submits no value at all).
func appleForm(bundleID, productID, planID, cycle string, active bool) url.Values {
	f := url.Values{
		"bundle_id":  {bundleID},
		"product_id": {productID},
		"plan_id":    {planID},
		"cycle":      {cycle},
	}
	if active {
		f.Set("active", "1")
	}
	return f
}

// rawAppleRow reads the raw catalog row, or reports that there is none. It
// deliberately does NOT go through AppleProductPlan: a test asserting "nothing
// was written" must not be satisfied by a row the live projection hides.
func rawAppleRow(t *testing.T, store *SQLiteStore, bundleID, productID string) (AppleProduct, bool) {
	t.Helper()
	p, ok, err := store.GetAppleProduct(context.Background(), bundleID, productID)
	if err != nil {
		t.Fatalf("GetAppleProduct(%s/%s): %v", bundleID, productID, err)
	}
	return p, ok
}

func appleAuditEntries(t *testing.T, store *SQLiteStore) []AuditEntry {
	t.Helper()
	entries, err := store.ListAudit(context.Background(), 50, 0, AuditAppleProduct)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	return entries
}

// seedAppleTiers gives every test the same three tiers: two on sale and one
// withdrawn, which is the state that makes the interesting cases reachable.
func seedAppleTiers(t *testing.T, store *SQLiteStore) {
	t.Helper()
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, UpdatedAt: 1})
	mustPlan(t, store, Plan{ID: "max", Name: "Max", Active: true, UpdatedAt: 1})
	mustPlan(t, store, Plan{ID: "legacy", Name: "Legacy", Active: false, UpdatedAt: 1})
}

// seedMappingOnWithdrawnTier produces a LIVE mapping whose tier is off sale.
//
// It has to be done in this order — tier on sale, mapping written, tier
// withdrawn — because that is the only order in which the state can arise, and
// UpsertAppleProduct refuses to create it any other way. That refusal is the
// point: this state is never authored, it ACCUMULATES, when someone retires a
// tier and nothing revisits the mappings pointing at it.
func seedMappingOnWithdrawnTier(t *testing.T, store *SQLiteStore, bundleID, productID, planID, cycle string) {
	t.Helper()
	ctx := context.Background()
	plan, ok, err := store.GetPlan(ctx, planID)
	if err != nil || !ok {
		t.Fatalf("GetPlan(%s): ok=%v err=%v", planID, ok, err)
	}
	plan.Active = true
	mustPlan(t, store, plan)
	if err := store.UpsertAppleProduct(ctx, AppleProduct{
		BundleID: bundleID, ProductID: productID,
		PlanID: planID, Cycle: cycle, Active: true, UpdatedAt: 5,
	}); err != nil {
		t.Fatalf("seed live mapping %s/%s: %v", bundleID, productID, err)
	}
	plan.Active = false
	mustPlan(t, store, plan)
}

// ---- no write before confirmation --------------------------------------------

// The route's whole security value: the POST that carries the operator's
// intended change must produce a confirmation page and NOTHING ELSE.
//
// MUTATION PROOF: drop RequireStepUp from the /admin/apple-products
// registration (leaving CSRFGuard) and this fails twice over — the response
// becomes a 302 and the row exists.
func TestAppleCatalogPostDoesNotWriteBeforeConfirmation(t *testing.T) {
	ts, _, store, _ := newAppleCatalogServer(t)
	seedAppleTiers(t, store)
	cookie := adminLoginCookie(t, ts)

	resp := postAdminForm(t, ts, cookie, "/admin/apple-products",
		appleForm("com.relayium.ios", "pro.monthly", "pro", "monthly", true))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want a 200 confirmation page, got %d", resp.StatusCode)
	}
	body := readAll(t, resp)
	if !strings.Contains(body, "confirm_token") {
		t.Fatal("the confirmation page carries no pending-action token")
	}
	if _, ok := rawAppleRow(t, store, "com.relayium.ios", "pro.monthly"); ok {
		t.Fatal("SECURITY: the catalog row was written without confirmation")
	}
	// And the page must name what it is about to do, not merely ask.
	for _, want := range []string{"apple.product", "apple-product:com.relayium.ios/pro.monthly", "plan_id", "pro", "monthly"} {
		if !strings.Contains(body, want) {
			t.Errorf("confirmation page does not mention %q", want)
		}
	}
}

// ---- the confirmed write, its stamp and its audit record ---------------------

func TestAppleCatalogConfirmedWriteAppliesStampsAndAudits(t *testing.T) {
	ts, _, store, _ := newAppleCatalogServer(t)
	seedAppleTiers(t, store)
	cookie := adminLoginCookie(t, ts)

	resp := confirmAction(t, ts, cookie, "/admin/apple-products",
		appleForm("com.relayium.mac", "max.yearly", "max", "yearly", true))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("confirmed catalog write: want 302, got %d", resp.StatusCode)
	}

	got, ok := rawAppleRow(t, store, "com.relayium.mac", "max.yearly")
	if !ok {
		t.Fatal("the confirmed write did not land")
	}
	if got.PlanID != "max" || got.Cycle != "yearly" || !got.Active {
		t.Fatalf("row not as confirmed: %+v", got)
	}
	// Server-stamped, from the service clock — never a form field. A form that
	// tried to supply one could otherwise backdate the record of when an
	// operator last touched a money mapping.
	if got.UpdatedAt != appleCatalogNow {
		t.Fatalf("updated_at = %d, want the server clock %d", got.UpdatedAt, appleCatalogNow)
	}

	entries := appleAuditEntries(t, store)
	if len(entries) != 1 {
		t.Fatalf("want exactly 1 %s audit entry, got %d", AuditAppleProduct, len(entries))
	}
	e := entries[0]
	if e.Target != "apple-product:com.relayium.mac/max.yearly" {
		t.Fatalf("audit target = %q", e.Target)
	}
	// The audit's changes come from the SAME parser the write came from, so
	// they must name the values actually stored.
	for _, want := range []string{`"plan_id"`, `"max"`, `"cycle"`, `"yearly"`, `"active"`} {
		if !strings.Contains(e.Changes, want) {
			t.Errorf("audit changes %s missing %s", e.Changes, want)
		}
	}
	// updated_at is deliberately not a diff row: the confirmation page renders
	// before the stamp exists, so showing one would be a prediction.
	if strings.Contains(e.Changes, "updated_at") {
		t.Errorf("updated_at must not appear as an operator-facing change: %s", e.Changes)
	}
	if e.StepUp != StepUpPassword {
		t.Errorf("audit step-up factor = %q, want %q", e.StepUp, StepUpPassword)
	}
}

// A form field named updated_at must be ignored, not trusted.
func TestAppleCatalogIgnoresClientSuppliedUpdatedAt(t *testing.T) {
	ts, _, store, _ := newAppleCatalogServer(t)
	seedAppleTiers(t, store)
	cookie := adminLoginCookie(t, ts)

	form := appleForm("com.relayium.ios", "pro.monthly", "pro", "monthly", true)
	form.Set("updated_at", "1") // a backdated stamp, if anything read it
	resp := confirmAction(t, ts, cookie, "/admin/apple-products", form)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("want 302, got %d", resp.StatusCode)
	}
	got, _ := rawAppleRow(t, store, "com.relayium.ios", "pro.monthly")
	if got.UpdatedAt != appleCatalogNow {
		t.Fatalf("updated_at = %d, want the server clock %d", got.UpdatedAt, appleCatalogNow)
	}
}

// ---- authentication / factor / session / CSRF boundaries ---------------------

func TestAppleCatalogRejectsUnauthenticatedPost(t *testing.T) {
	ts, _, store, _ := newAppleCatalogServer(t)
	seedAppleTiers(t, store)

	req, err := http.NewRequest(http.MethodPost, ts.URL+"/admin/apple-products",
		strings.NewReader(appleForm("com.relayium.ios", "pro.monthly", "pro", "monthly", true).Encode()))
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
	// A 302 here is the login redirect, not an applied write — which is exactly
	// why the row check below, not the status code, is the assertion that
	// matters.
	if loc := resp.Header.Get("Location"); loc != "/admin" {
		t.Fatalf("anonymous POST location = %q, want the login redirect", loc)
	}
	if _, ok := rawAppleRow(t, store, "com.relayium.ios", "pro.monthly"); ok {
		t.Fatal("SECURITY: an anonymous POST wrote a catalog row")
	}
	if n := len(appleAuditEntries(t, store)); n != 0 {
		t.Fatalf("anonymous POST produced %d audit entries", n)
	}
}

func TestAppleCatalogRejectsCrossOriginPost(t *testing.T) {
	ts, _, store, _ := newAppleCatalogServer(t)
	seedAppleTiers(t, store)
	cookie := adminLoginCookie(t, ts)

	req, err := http.NewRequest(http.MethodPost, ts.URL+"/admin/apple-products",
		strings.NewReader(appleForm("com.relayium.ios", "pro.monthly", "pro", "monthly", true).Encode()))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", "http://evil.example")
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-origin catalog POST = %d, want 403", resp.StatusCode)
	}
	if _, ok := rawAppleRow(t, store, "com.relayium.ios", "pro.monthly"); ok {
		t.Fatal("SECURITY: a cross-origin POST wrote a catalog row")
	}
}

// Holding the session cookie is not enough: /admin/confirm must refuse to apply
// a pending catalog write with no second factor. This is the XSS/stolen-cookie
// case the confirmation page exists for.
func TestAppleCatalogConfirmWithoutFactorDoesNotWrite(t *testing.T) {
	ts, _, store, _ := newAppleCatalogServer(t)
	seedAppleTiers(t, store)
	cookie := adminLoginCookie(t, ts)

	resp := postAdminForm(t, ts, cookie, "/admin/apple-products",
		appleForm("com.relayium.ios", "pro.monthly", "pro", "monthly", true))
	body := readAll(t, resp)
	resp.Body.Close()
	tok := extractConfirmToken(t, body)

	// No factor_code at all.
	confirmResp := postAdminForm(t, ts, cookie, "/admin/confirm", url.Values{"confirm_token": {tok}})
	defer confirmResp.Body.Close()
	if confirmResp.StatusCode == http.StatusFound {
		t.Fatal("SECURITY: /admin/confirm applied a catalog write with no second factor")
	}
	if _, ok := rawAppleRow(t, store, "com.relayium.ios", "pro.monthly"); ok {
		t.Fatal("SECURITY: a catalog row was written without factor verification")
	}
}

// A pending confirmation belongs to the session that minted it, and it is
// spendable once. Both halves are asserted here because they fail the same way
// — a token that travels or a token that survives is a high-risk write anyone
// holding the page can replay.
func TestAppleCatalogConfirmTokenIsSessionBoundAndSingleUse(t *testing.T) {
	ts, _, store, _ := newAppleCatalogServer(t)
	seedAppleTiers(t, store)
	sessionA := adminLoginCookie(t, ts)
	sessionB := adminLoginCookie(t, ts)
	if sessionA.Value == sessionB.Value {
		t.Fatal("the two logins share a session token; this test proves nothing")
	}

	resp := postAdminForm(t, ts, sessionA, "/admin/apple-products",
		appleForm("com.relayium.ios", "pro.monthly", "pro", "monthly", true))
	body := readAll(t, resp)
	resp.Body.Close()
	tok := extractConfirmToken(t, body)

	// Session B is a fully authenticated admin with the correct factor. It still
	// must not be able to spend A's pending action.
	foreign := postAdminForm(t, ts, sessionB, "/admin/confirm", url.Values{
		"confirm_token": {tok}, "factor_code": {"secret123"},
	})
	defer foreign.Body.Close()
	if foreign.StatusCode == http.StatusFound {
		t.Fatal("SECURITY: a pending catalog write was redeemed by a different session")
	}
	if _, ok := rawAppleRow(t, store, "com.relayium.ios", "pro.monthly"); ok {
		t.Fatal("SECURITY: a foreign session's confirmation wrote a catalog row")
	}

	// And the failed attempt burned the token, so the minting session cannot
	// use it either — a mismatched session must not get free retries.
	replay := postAdminForm(t, ts, sessionA, "/admin/confirm", url.Values{
		"confirm_token": {tok}, "factor_code": {"secret123"},
	})
	defer replay.Body.Close()
	if replay.StatusCode == http.StatusFound {
		t.Fatal("SECURITY: a pending token survived a foreign redemption attempt")
	}
	if _, ok := rawAppleRow(t, store, "com.relayium.ios", "pro.monthly"); ok {
		t.Fatal("SECURITY: a replayed token wrote a catalog row")
	}
}

// ---- the before-image reads the RAW row ---------------------------------------

// The confirmation page's "before" half must come from the raw catalog row, not
// from the live-only projection.
//
// MUTATION PROOF: point beforeImageFor's AuditAppleProduct case at
// s.store.AppleProductPlan instead of GetAppleProduct. Both sub-cases below
// then show an empty before-image — the page would announce a CREATION while
// the write silently overwrote an existing mapping — and both assertions fail.
func TestAppleCatalogConfirmationShowsTheRawExistingRow(t *testing.T) {
	ts, _, store, _ := newAppleCatalogServer(t)
	seedAppleTiers(t, store)
	cookie := adminLoginCookie(t, ts)
	ctx := context.Background()

	// (a) A RETIRED mapping. AppleProductPlan hides it (active = 0).
	if err := store.UpsertAppleProduct(ctx, AppleProduct{
		BundleID: "com.relayium.ios", ProductID: "pro.monthly",
		PlanID: "pro", Cycle: "monthly", Active: false, UpdatedAt: 5,
	}); err != nil {
		t.Fatal(err)
	}
	// (b) A LIVE mapping whose tier has since been withdrawn. AppleProductPlan
	// hides this one too (the plans join requires an active tier), and it is the
	// state an operator is most likely to be editing: they are here to fix it.
	seedMappingOnWithdrawnTier(t, store, "com.relayium.mac", "legacy.yearly", "legacy", "yearly")

	// Sanity: the live projection really does hide both, so the assertions
	// below are about the fix and not about a lucky read.
	for _, k := range [][2]string{{"com.relayium.ios", "pro.monthly"}, {"com.relayium.mac", "legacy.yearly"}} {
		if _, ok, err := store.AppleProductPlan(ctx, k[0], k[1]); err != nil || ok {
			t.Fatalf("precondition: AppleProductPlan(%s/%s) ok=%v err=%v, want hidden", k[0], k[1], ok, err)
		}
	}

	// (a) Re-enabling the retired mapping on a different tier: the page must show
	// the old plan AND the old active=false as the "before".
	respA := postAdminForm(t, ts, cookie, "/admin/apple-products",
		appleForm("com.relayium.ios", "pro.monthly", "max", "monthly", true))
	bodyA := readAll(t, respA)
	respA.Body.Close()
	if !strings.Contains(bodyA, `<td class="old">pro</td>`) {
		t.Errorf("confirmation page does not show the retired row's real plan as the before value:\n%s", bodyA)
	}
	if !strings.Contains(bodyA, `<td class="old">false</td>`) {
		t.Errorf("confirmation page does not show the retired row's real active flag:\n%s", bodyA)
	}
	// cycle is unchanged, so it must not appear as a change at all.
	if strings.Contains(bodyA, "<td>cycle</td>") {
		t.Errorf("an unchanged field was rendered as a change:\n%s", bodyA)
	}

	// (b) Retiring the mapping whose tier was withdrawn.
	respB := postAdminForm(t, ts, cookie, "/admin/apple-products",
		appleForm("com.relayium.mac", "legacy.yearly", "legacy", "yearly", false))
	bodyB := readAll(t, respB)
	respB.Body.Close()
	if !strings.Contains(bodyB, `<td class="old">true</td>`) || !strings.Contains(bodyB, `<td class="new">false</td>`) {
		t.Errorf("confirmation page does not show the withdrawn-tier row being switched off:\n%s", bodyB)
	}
}

// ---- retirement must survive its tier being withdrawn ------------------------

// The mapping most in need of retiring is the one whose tier was just taken off
// sale. If retirement required an active tier, a live App Store product would
// stay wired to a dead tier with no way to switch it off from the console.
//
// MUTATION PROOF: drop the `if p.Active` guard around the handler's plan check
// (making it unconditional) and this returns 400 with the row still live.
func TestAppleCatalogRetirementWorksWhenTheTierIsInactive(t *testing.T) {
	ts, _, store, _ := newAppleCatalogServer(t)
	seedAppleTiers(t, store)
	cookie := adminLoginCookie(t, ts)
	ctx := context.Background()

	seedMappingOnWithdrawnTier(t, store, "com.relayium.mac", "legacy.yearly", "legacy", "yearly")
	if p, ok, err := store.GetPlan(ctx, "legacy"); err != nil || !ok || p.Active {
		t.Fatalf("precondition: tier legacy should exist and be off sale (ok=%v err=%v)", ok, err)
	}

	resp := confirmAction(t, ts, cookie, "/admin/apple-products",
		appleForm("com.relayium.mac", "legacy.yearly", "legacy", "yearly", false))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("retiring a mapping whose tier is off sale = %d, want 302", resp.StatusCode)
	}
	got, ok := rawAppleRow(t, store, "com.relayium.mac", "legacy.yearly")
	if !ok || got.Active {
		t.Fatalf("mapping was not retired: %+v (found=%v)", got, ok)
	}
	if got.UpdatedAt != appleCatalogNow {
		t.Fatalf("retirement did not stamp updated_at: %+v", got)
	}
}

// ---- a LIVE mapping must point at a tier that is on sale ---------------------

func TestAppleCatalogLiveMappingRejectsUnknownAndWithdrawnTiers(t *testing.T) {
	ts, _, store, _ := newAppleCatalogServer(t)
	seedAppleTiers(t, store)
	cookie := adminLoginCookie(t, ts)

	cases := map[string]struct{ plan, product string }{
		"unknown tier":   {"ghost", "ghost.monthly"},
		"withdrawn tier": {"legacy", "legacy.monthly"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			resp := confirmAction(t, ts, cookie, "/admin/apple-products",
				appleForm("com.relayium.ios", c.product, c.plan, "monthly", true))
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("live mapping on a %s = %d, want 400", name, resp.StatusCode)
			}
			if _, ok := rawAppleRow(t, store, "com.relayium.ios", c.product); ok {
				t.Fatal("a refused live mapping was written anyway")
			}
		})
	}
	// A rejected write must leave no audit entry claiming it happened.
	if n := len(appleAuditEntries(t, store)); n != 0 {
		t.Fatalf("AUDIT INTEGRITY: %d entries for writes that were refused", n)
	}
}

// A malformed cycle is refused, and refused before anything is written.
func TestAppleCatalogRejectsUnsupportedCycle(t *testing.T) {
	ts, _, store, _ := newAppleCatalogServer(t)
	seedAppleTiers(t, store)
	cookie := adminLoginCookie(t, ts)

	resp := postAdminForm(t, ts, cookie, "/admin/apple-products",
		appleForm("com.relayium.ios", "weird", "pro", "weekly", true))
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusFound {
		t.Fatal("an unsupported cycle produced an applied write")
	}
	if _, ok := rawAppleRow(t, store, "com.relayium.ios", "weird"); ok {
		t.Fatal("an unsupported cycle was written to the catalog")
	}
}

// ---- trimming: one pasted key addresses one row ------------------------------

// A bundle id pasted with surrounding whitespace must address the row that is
// already there — not create a second row that nothing will ever match, and not
// leave the audit naming a key the store did not write.
//
// MUTATION PROOF: remove the TrimSpace calls from parseAppleProductForm and
// this fails at the write (400: the untrimmed plan id matches no tier), as does
// TestParseAppleProductFormTrimsAndValidates. The property being defended is
// broader than that 400, which is why the audit assertion below exists too: the
// store trims the key it writes, so an untrimmed parser makes the confirmation
// page, the audit target and the row that actually changed three different
// answers to "which mapping is this" — and only the last one is true.
func TestAppleCatalogTrimsKeysToASingleRow(t *testing.T) {
	ts, _, store, _ := newAppleCatalogServer(t)
	seedAppleTiers(t, store)
	cookie := adminLoginCookie(t, ts)
	ctx := context.Background()

	if err := store.UpsertAppleProduct(ctx, AppleProduct{
		BundleID: "com.relayium.ios", ProductID: "pro.monthly",
		PlanID: "pro", Cycle: "monthly", Active: true, UpdatedAt: 5,
	}); err != nil {
		t.Fatal(err)
	}

	// The same keys as a careless paste would produce.
	resp := confirmAction(t, ts, cookie, "/admin/apple-products",
		appleForm("  com.relayium.ios\n", "\tpro.monthly ", " max ", " monthly ", true))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("padded keys = %d, want 302", resp.StatusCode)
	}

	rows, err := store.ListAppleProducts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("padded keys created a second row: %+v", rows)
	}
	if rows[0].PlanID != "max" {
		t.Fatalf("the existing row was not updated: %+v", rows[0])
	}
	entries := appleAuditEntries(t, store)
	if len(entries) != 1 {
		t.Fatalf("want 1 audit entry, got %d", len(entries))
	}
	if entries[0].Target != "apple-product:com.relayium.ios/pro.monthly" {
		t.Fatalf("audit names an untrimmed key: %q", entries[0].Target)
	}
}

// ---- the list: every row, stable order, truthful status ----------------------

// seedOrphanAppleProduct inserts a catalog row pointing at a tier that does not
// exist.
//
// It has to bypass the foreign key, because the foreign key is exactly what
// makes this row unreachable through every current write path — which is also
// why the console's handling of it needs a test rather than an assumption. The
// one place it must be visible is the console that could fix it. The pragma is
// per-connection and the write pool is MaxOpenConns(1), so toggling it here
// reaches the connection this INSERT runs on.
func seedOrphanAppleProduct(t *testing.T, store *SQLiteStore, bundleID, productID, planID string) {
	t.Helper()
	ctx := context.Background()
	if _, err := store.db.ExecContext(ctx, `PRAGMA foreign_keys = OFF`); err != nil {
		t.Fatalf("disable foreign keys: %v", err)
	}
	defer func() {
		if _, err := store.db.ExecContext(ctx, `PRAGMA foreign_keys = ON`); err != nil {
			t.Fatalf("re-enable foreign keys: %v", err)
		}
	}()
	if _, err := store.db.ExecContext(ctx,
		`INSERT INTO apple_products (bundle_id, product_id, plan_id, cycle, active, updated_at)
		 VALUES (?, ?, ?, 'monthly', 1, 7)`, bundleID, productID, planID); err != nil {
		t.Fatalf("insert orphan row: %v", err)
	}
}

func TestAppleCatalogListShowsEveryRowInAStableOrder(t *testing.T) {
	_, _, store, _ := newAppleCatalogServer(t)
	seedAppleTiers(t, store)
	ctx := context.Background()

	// Inserted out of order on purpose: the list's order must come from the
	// query, not from insertion history.
	for _, p := range []AppleProduct{
		{BundleID: "com.relayium.mac", ProductID: "pro.monthly", PlanID: "pro", Cycle: "monthly", Active: true},
		{BundleID: "com.relayium.ios", ProductID: "pro.yearly", PlanID: "pro", Cycle: "yearly", Active: false},
		{BundleID: "com.relayium.ios", ProductID: "legacy.monthly", PlanID: "legacy", Cycle: "monthly", Active: false},
	} {
		if err := store.UpsertAppleProduct(ctx, p); err != nil {
			t.Fatalf("seed %s/%s: %v", p.BundleID, p.ProductID, err)
		}
	}
	// A live mapping whose tier was withdrawn AFTER it was written: the row the
	// live projection refuses and nobody edited.
	if err := store.UpsertAppleProduct(ctx, AppleProduct{
		BundleID: "com.relayium.ios", ProductID: "max.monthly", PlanID: "max", Cycle: "monthly", Active: true,
	}); err != nil {
		t.Fatal(err)
	}
	mustPlan(t, store, Plan{ID: "max", Name: "Max", Active: false, UpdatedAt: 2})
	seedOrphanAppleProduct(t, store, "com.relayium.ios", "gone.monthly", "vanished")

	rows, err := store.ListAppleProducts(ctx)
	if err != nil {
		t.Fatalf("ListAppleProducts: %v", err)
	}
	views := appleProductViews(rows)
	type want struct{ bundle, product, status string }
	expect := []want{
		{"com.relayium.ios", "gone.monthly", appleProductPlanMissing},
		{"com.relayium.ios", "legacy.monthly", appleProductRetired},
		{"com.relayium.ios", "max.monthly", appleProductPlanInactive},
		{"com.relayium.ios", "pro.yearly", appleProductRetired},
		{"com.relayium.mac", "pro.monthly", appleProductLive},
	}
	if len(views) != len(expect) {
		t.Fatalf("got %d rows, want %d: %+v", len(views), len(expect), views)
	}
	for i, w := range expect {
		got := views[i]
		if got.BundleID != w.bundle || got.ProductID != w.product {
			t.Fatalf("row %d = %s/%s, want %s/%s (order is not the primary key's)",
				i, got.BundleID, got.ProductID, w.bundle, w.product)
		}
		if got.Status != w.status {
			t.Errorf("row %s/%s status = %q, want %q", got.BundleID, got.ProductID, got.Status, w.status)
		}
	}
	// A second read returns the same order.
	again, err := store.ListAppleProducts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for i := range again {
		if again[i].ProductID != rows[i].ProductID || again[i].BundleID != rows[i].BundleID {
			t.Fatalf("the list order is not stable between reads: %+v vs %+v", rows, again)
		}
	}
}

// The status column's precedence, stated as a table because it is the rule an
// operator acts on: an off mapping reads "retired" even when its tier is also
// broken, because an off mapping grants nothing either way — and "retired with
// a withdrawn tier" is the CORRECT resting state after retiring a withdrawn
// product, not a fault to flag.
func TestAppleProductStatusPrecedence(t *testing.T) {
	cases := map[string]struct {
		row  AppleProductRow
		want string
	}{
		"live":                     {AppleProductRow{AppleProduct: AppleProduct{Active: true}, PlanFound: true, PlanActive: true}, appleProductLive},
		"retired":                  {AppleProductRow{AppleProduct: AppleProduct{Active: false}, PlanFound: true, PlanActive: true}, appleProductRetired},
		"retired, tier withdrawn":  {AppleProductRow{AppleProduct: AppleProduct{Active: false}, PlanFound: true, PlanActive: false}, appleProductRetired},
		"retired, tier missing":    {AppleProductRow{AppleProduct: AppleProduct{Active: false}, PlanFound: false}, appleProductRetired},
		"live, tier withdrawn":     {AppleProductRow{AppleProduct: AppleProduct{Active: true}, PlanFound: true, PlanActive: false}, appleProductPlanInactive},
		"live, tier missing":       {AppleProductRow{AppleProduct: AppleProduct{Active: true}, PlanFound: false}, appleProductPlanMissing},
		"live, missing beats sale": {AppleProductRow{AppleProduct: AppleProduct{Active: true}, PlanFound: false, PlanActive: true}, appleProductPlanMissing},
	}
	for name, c := range cases {
		if got := appleProductStatusOf(c.row); got != c.want {
			t.Errorf("%s: status = %q, want %q", name, got, c.want)
		}
	}
}

// The dashboard must render the rows an operator needs to act on, including the
// two that cannot grant anything.
func TestAppleCatalogDashboardRendersBrokenRows(t *testing.T) {
	ts, _, store, _ := newAppleCatalogServer(t)
	seedAppleTiers(t, store)
	cookie := adminLoginCookie(t, ts)
	ctx := context.Background()

	if err := store.UpsertAppleProduct(ctx, AppleProduct{
		BundleID: "com.relayium.mac", ProductID: "legacy.yearly",
		PlanID: "legacy", Cycle: "yearly", Active: false, UpdatedAt: 5,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertAppleProduct(ctx, AppleProduct{
		BundleID: "com.relayium.ios", ProductID: "max.monthly",
		PlanID: "max", Cycle: "monthly", Active: true, UpdatedAt: 5,
	}); err != nil {
		t.Fatal(err)
	}
	mustPlan(t, store, Plan{ID: "max", Name: "Max", Active: false, UpdatedAt: 2})
	seedOrphanAppleProduct(t, store, "com.relayium.ios", "gone.monthly", "vanished")

	body := getAdminPathHTML(t, ts, ts.URL, "/admin/users", cookie)
	for _, want := range []string{
		"legacy.yearly", "max.monthly", "gone.monthly", // every row is reachable
		"已停用",          // retired
		"套餐已下架，购买会被拒绝", // the row that looks fine and is not
		"套餐不存在",        // the broken row
	} {
		if !strings.Contains(body, want) {
			t.Errorf("dashboard does not show %q", want)
		}
	}
}

// A row whose tier no longer exists must carry its own value in the tier
// dropdown. Without it no option matches, the browser pre-selects the first
// tier, and an operator who opened the broken row only to retire it would
// silently repoint it at whichever tier sorts first — turning the row this
// feature exists to surface into a wrong mapping.
//
// MUTATION PROOF: delete the `{{if not .PlanFound}}` option from the row form
// and the selected-option assertion fails.
func TestAppleCatalogBrokenRowKeepsItsOwnTierSelected(t *testing.T) {
	ts, _, store, _ := newAppleCatalogServer(t)
	seedAppleTiers(t, store)
	cookie := adminLoginCookie(t, ts)
	seedOrphanAppleProduct(t, store, "com.relayium.ios", "gone.monthly", "vanished")

	body := getAdminPathHTML(t, ts, ts.URL, "/admin/users", cookie)
	if !strings.Contains(body, `<option value="vanished" selected>vanished`) {
		t.Errorf("the broken row's own tier is not the selected option; a save would repoint it:\n%s",
			appleSection(body))
	}
}

// appleSection trims a rendered dashboard to the catalog section, so a failure
// message is readable rather than a whole page.
func appleSection(body string) string {
	i := strings.Index(body, `<section class="apple-products">`)
	if i < 0 {
		return body
	}
	rest := body[i:]
	if j := strings.Index(rest, "</section>"); j >= 0 {
		return rest[:j]
	}
	return rest
}

// A failed catalog read must render as a failure. An empty catalog is a
// legitimate and ordinary state (nothing seeds the table), so "could not read"
// shown as an empty table is a confident wrong answer that invites an operator
// to re-create a mapping that is already there.
func TestAppleCatalogReadFailureIsNotRenderedAsEmpty(t *testing.T) {
	ts, _, store, _ := newAppleCatalogServer(t)
	seedAppleTiers(t, store)
	cookie := adminLoginCookie(t, ts)

	if _, err := store.db.ExecContext(context.Background(), `DROP TABLE apple_products`); err != nil {
		t.Fatalf("drop table: %v", err)
	}

	body := getAdminPathHTML(t, ts, ts.URL, "/admin/users", cookie)
	if !strings.Contains(body, "商品目录读取失败") {
		t.Error("a failed catalog read does not surface as an error on the dashboard")
	}
	if strings.Contains(body, "尚未配置任何 App Store 商品映射") {
		t.Error("a failed catalog read rendered as the empty-catalog state")
	}
	// The rest of the dashboard still renders: one broken read must not take
	// down the console an operator is using to diagnose it.
	if !strings.Contains(body, "注册用户（") {
		t.Error("a failed catalog read took the rest of the dashboard with it")
	}
}

// A failed catalog read must also withdraw every WRITE path in the section, not
// just the table.
//
// The table is the obvious half. The add form is the dangerous one: the write is
// an upsert, and the only thing that can answer "does this key already have a
// row" is the catalog read that just failed. So an add form rendered over a
// failed read offers exactly one operation — a blind write — on a page that
// shows no rows, which reads as "there are none here". An operator who fills it
// in believing they are creating a mapping can silently repoint a live one at
// another tier, and the rows they would have needed to see to know better are
// the ones the failure hid.
//
// Adversarial by construction: it does not look for the absence of a friendly
// string, it asserts that the section contains NO form posting to the write
// route and no submit button at all, so a form that survives under different
// markup still fails this.
//
// MUTATION PROOF: move the add form back outside the {{if .AppleProductsErr}}
// branch (its position before this fix) and every assertion below fails —
// action count 1, a <form> in the section, a submit button present.
func TestAppleCatalogReadFailureOffersNoWriteForm(t *testing.T) {
	ts, _, store, _ := newAppleCatalogServer(t)
	seedAppleTiers(t, store)
	cookie := adminLoginCookie(t, ts)

	// A live mapping exists FIRST, so this is the real hazard and not a vacuous
	// one: there is a row that a blind add-form write could overwrite.
	resp := confirmAction(t, ts, cookie, "/admin/apple-products",
		appleForm("com.relayium.ios", "pro.monthly", "pro", "monthly", true))
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("seeding the mapping = %d", resp.StatusCode)
	}
	if _, ok := rawAppleRow(t, store, "com.relayium.ios", "pro.monthly"); !ok {
		t.Fatal("precondition: the mapping should be in the table")
	}

	if _, err := store.db.ExecContext(context.Background(), `DROP TABLE apple_products`); err != nil {
		t.Fatalf("drop table: %v", err)
	}

	body := getAdminPathHTML(t, ts, ts.URL, "/admin/users", cookie)
	sec := appleSection(body)
	if !strings.Contains(sec, "商品目录读取失败") {
		t.Fatalf("precondition: the section should be in its read-failure state:\n%s", sec)
	}
	// No form targeting the write route — neither the add form nor a row form.
	if n := strings.Count(sec, `action="/admin/apple-products"`); n != 0 {
		t.Errorf("the read-failure section still offers %d form(s) posting to /admin/apple-products; "+
			"a write here is an upsert and nothing can tell whether the key already has a row:\n%s", n, sec)
	}
	// And no form element or submit control of any kind, so the claim does not
	// depend on that one attribute spelling.
	for _, forbidden := range []string{"<form", "<button", "<input", "<select"} {
		if strings.Contains(sec, forbidden) {
			t.Errorf("the read-failure section still renders %q — it must offer no write controls:\n%s",
				forbidden, sec)
		}
	}
	// The operator-facing strings of both forms are gone too, in both languages:
	// the add button and the row form's save button.
	for _, gone := range []string{"新增映射", "Add mapping", "保存"} {
		if strings.Contains(sec, gone) {
			t.Errorf("the read-failure section still shows the write control %q:\n%s", gone, sec)
		}
	}
}

// ---- the catalog cannot switch verification on -------------------------------

// The two truth sources are separate on purpose: configuration decides whether
// this deployment can verify an Apple signature at all, the database decides
// which product means which tier. A fully populated catalog on a deployment
// with no verifier configured must still answer 503 — there is no combination
// of rows that turns purchase acceptance on.
//
// MUTATION PROOF: make handleAppleTransaction fall through to the catalog when
// s.appleTx is nil and this returns something other than 503.
func TestAppleCatalogRowsCannotEnableAnUnconfiguredVerifier(t *testing.T) {
	ts, svc, store, mail := newAppleCatalogServer(t)
	seedAppleTiers(t, store)
	admin := adminLoginCookie(t, ts)

	// A live mapping, written through the real confirmed console path.
	resp := confirmAction(t, ts, admin, "/admin/apple-products",
		appleForm("com.relayium.ios", "pro.monthly", "pro", "monthly", true))
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("seeding the mapping through the console = %d", resp.StatusCode)
	}
	if _, ok, err := store.AppleProductPlan(context.Background(), "com.relayium.ios", "pro.monthly"); err != nil || !ok {
		t.Fatalf("precondition: the mapping should resolve in the catalog (ok=%v err=%v)", ok, err)
	}
	// This deployment configured no verifier — the shipping default.
	if svc.appleTx != nil {
		t.Fatal("precondition: the test server must have no Apple verifier")
	}

	user := loginCookie(t, ts, mail, "apple-catalog@example.com")
	req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/billing/apple/transaction",
		strings.NewReader(`{"signedTransactionInfo":"not-a-real-jws"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(user)
	txResp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer txResp.Body.Close()
	if txResp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("intake with a populated catalog and no verifier = %d, want 503", txResp.StatusCode)
	}
	if body := readAll(t, txResp); !strings.Contains(body, "verifier_unavailable") {
		t.Fatalf("want verifier_unavailable, got %s", body)
	}
}

// ---- the parser both callers share -------------------------------------------

func TestParseAppleProductFormTrimsAndValidates(t *testing.T) {
	got, err := parseAppleProductForm(url.Values{
		"bundle_id":  {"  com.relayium.ios \n"},
		"product_id": {"\tpro.monthly "},
		"plan_id":    {" pro "},
		"cycle":      {" monthly "},
		"active":     {"1"},
		"updated_at": {"1"}, // not a form field; must be ignored
	})
	if err != nil {
		t.Fatalf("valid form: %v", err)
	}
	want := AppleProduct{
		BundleID: "com.relayium.ios", ProductID: "pro.monthly",
		PlanID: "pro", Cycle: "monthly", Active: true,
	}
	if got != want {
		t.Fatalf("parsed = %+v, want %+v (UpdatedAt must stay 0 — the handler stamps it)", got, want)
	}

	// An absent checkbox is a retirement, not a missing field.
	off, err := parseAppleProductForm(appleForm("com.relayium.ios", "pro.monthly", "pro", "monthly", false))
	if err != nil {
		t.Fatalf("retirement form: %v", err)
	}
	if off.Active {
		t.Fatal("an unchecked 启用 box must parse as a retirement")
	}

	bad := map[string]url.Values{
		"no bundle id":     appleForm("   ", "pro.monthly", "pro", "monthly", true),
		"no product id":    appleForm("com.relayium.ios", "", "pro", "monthly", true),
		"no plan":          appleForm("com.relayium.ios", "pro.monthly", " ", "monthly", true),
		"no cycle":         appleForm("com.relayium.ios", "pro.monthly", "pro", "", true),
		"unknown cycle":    appleForm("com.relayium.ios", "pro.monthly", "pro", "weekly", true),
		"stripe-ish cycle": appleForm("com.relayium.ios", "pro.monthly", "pro", "unknown", true),
	}
	for name, form := range bad {
		if _, err := parseAppleProductForm(form); err == nil {
			t.Errorf("%s: parser accepted it", name)
		}
	}
}

// ---- the key length bound is the verifier's own ------------------------------

// The catalog's key bound must BE the purchase verifier's bound, not a number
// that happens to match it today. A row keyed longer than the verifier accepts
// is unreachable by construction — Verify refuses the payload before any catalog
// lookup — so it is a mapping that grants nothing while looking healthy on the
// dashboard.
//
// MUTATION PROOF: replace `const appleProductKeyMaxLen = appleMaxProductIDLen`
// with a literal that differs from appleMaxProductIDLen and this fails.
func TestAppleProductKeyBoundIsTheVerifierBound(t *testing.T) {
	if appleProductKeyMaxLen != appleMaxProductIDLen {
		t.Fatalf("catalog key bound %d != verifier bound %d: the console can write mappings "+
			"no accepted transaction can reach", appleProductKeyMaxLen, appleMaxProductIDLen)
	}
}

// appleKey builds an identifier of exactly n bytes.
func appleKey(n int) string { return strings.Repeat("a", n) }

// Both the parser the console shares and the authoritative store method must
// refuse an over-long key, and both must accept one exactly at the bound.
//
// Two boundaries rather than one because they have different callers. The parser
// is what stops the confirmation page from describing a write that would be
// refused; the store is what stops any OTHER caller — a migration, a future
// adapter, a test — from writing a row no purchase can reach. Removing either
// check leaves a hole the other cannot cover.
//
// MUTATION PROOF: delete the length check in parseAppleProductForm and the
// parser sub-tests fail; delete the one in UpsertAppleProduct and the store
// sub-tests fail. Change either `>` to `>=` and the at-the-bound cases fail.
func TestAppleProductRejectsOverlongKeys(t *testing.T) {
	const over = appleProductKeyMaxLen + 1
	atMax, tooLong := appleKey(appleProductKeyMaxLen), appleKey(over)

	// The parser: refused, with the bound named so the operator can act on it.
	for name, form := range map[string]url.Values{
		"bundle id one byte over":  appleForm(tooLong, "pro.monthly", "pro", "monthly", true),
		"product id one byte over": appleForm("com.relayium.ios", tooLong, "pro", "monthly", true),
		"both over":                appleForm(tooLong, tooLong, "pro", "monthly", true),
		// A retirement is not a way around the bound: the row it would write is
		// just as unreachable, and writing it is not the repair it looks like.
		"retirement with an over-long key": appleForm(tooLong, "pro.monthly", "pro", "monthly", false),
	} {
		if _, err := parseAppleProductForm(form); err == nil {
			t.Errorf("%s: the parser accepted a key longer than the verifier's %d bytes",
				name, appleProductKeyMaxLen)
		}
	}
	// Exactly at the bound is legal: the bound is the verifier's, and the
	// verifier accepts a payload of exactly this length.
	if _, err := parseAppleProductForm(
		appleForm(atMax, atMax, "pro", "monthly", true)); err != nil {
		t.Errorf("a key of exactly %d bytes must parse (the verifier accepts it): %v",
			appleProductKeyMaxLen, err)
	}
	// The bound is measured AFTER trimming, so surrounding whitespace on a key
	// that fits is not what pushes it over — the same ordering the store uses,
	// and the reason the confirmation target, the audit target and the written
	// row stay one string.
	if got, err := parseAppleProductForm(
		appleForm(" "+atMax+" ", "pro.monthly", "pro", "monthly", true)); err != nil {
		t.Errorf("a key that fits after trimming must be accepted: %v", err)
	} else if got.BundleID != atMax {
		t.Errorf("parsed bundle id = %d bytes, want the trimmed %d", len(got.BundleID), len(atMax))
	}

	// The store: the authority, reached directly so the parser cannot be what is
	// under test.
	store := newTestStore(t)
	seedAppleTiers(t, store)
	ctx := context.Background()
	for name, p := range map[string]AppleProduct{
		"bundle id one byte over":           {BundleID: tooLong, ProductID: "pro.monthly", PlanID: "pro", Cycle: "monthly", Active: true},
		"product id one byte over":          {BundleID: "com.relayium.ios", ProductID: tooLong, PlanID: "pro", Cycle: "monthly", Active: true},
		"retired row with over-long key":    {BundleID: tooLong, ProductID: "pro.monthly", PlanID: "pro", Cycle: "monthly"},
		"over-long key on a withdrawn tier": {BundleID: tooLong, ProductID: "pro.monthly", PlanID: "legacy", Cycle: "monthly"},
	} {
		if err := store.UpsertAppleProduct(ctx, p); err == nil {
			t.Errorf("%s: the store wrote a row no accepted transaction could ever reach", name)
		}
		if _, ok := rawAppleRow(t, store, p.BundleID, p.ProductID); ok {
			t.Errorf("%s: a refused write left a row behind", name)
		}
	}
	if err := store.UpsertAppleProduct(ctx, AppleProduct{
		BundleID: atMax, ProductID: atMax, PlanID: "pro", Cycle: "monthly",
		Active: true, UpdatedAt: appleCatalogNow,
	}); err != nil {
		t.Fatalf("a key of exactly %d bytes must be writable: %v", appleProductKeyMaxLen, err)
	}
	if _, ok := rawAppleRow(t, store, atMax, atMax); !ok {
		t.Error("the at-the-bound row was not written")
	}
}

// The console's own boundary, end to end: an over-long key must never produce a
// confirmation page, and nothing may reach the table or the audit log.
//
// The assertion is deliberately about the OUTCOME rather than a status code, for
// the same reason TestAppleCatalogRejectsUnsupportedCycle is: the refusal comes
// out of beforeImageFor (which shares parseAppleProductForm), so it surfaces as
// the step-up wrapper's generic error rather than the handler's 400 — the same
// path any malformed field takes. What matters is that no pending confirmation
// is minted: the confirmation page exists so that what an operator confirms is
// what happens, and offering a diff for a write that will be refused is offering
// a diff for nothing.
func TestAppleCatalogConsoleRefusesOverlongKeyBeforeConfirmation(t *testing.T) {
	ts, _, store, _ := newAppleCatalogServer(t)
	seedAppleTiers(t, store)
	cookie := adminLoginCookie(t, ts)

	tooLong := appleKey(appleProductKeyMaxLen + 1)
	resp := postAdminForm(t, ts, cookie, "/admin/apple-products",
		appleForm(tooLong, "pro.monthly", "pro", "monthly", true))
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusFound {
		t.Error("an over-long bundle id produced an applied write")
	}
	if body := readAll(t, resp); strings.Contains(body, "confirm_token") {
		t.Error("an over-long bundle id was offered a confirmation page: an operator would " +
			"confirm a diff for a write the store then refuses")
	}
	if _, ok := rawAppleRow(t, store, tooLong, "pro.monthly"); ok {
		t.Error("an over-long key reached the catalog table")
	}
	if entries := appleAuditEntries(t, store); len(entries) != 0 {
		t.Errorf("a refused write produced %d audit entries", len(entries))
	}
}

// The image the confirmation page and the audit log are built from carries the
// operator-decided values and nothing else.
func TestAppleProductImageOmitsTheServerStamp(t *testing.T) {
	img := appleProductImage(AppleProduct{
		BundleID: "com.relayium.ios", ProductID: "pro.monthly",
		PlanID: "pro", Cycle: "monthly", Active: true, UpdatedAt: 99,
	})
	if _, ok := img["updated_at"]; ok {
		t.Error("updated_at must not be in the confirmation diff: the page renders before the stamp exists")
	}
	for _, k := range []string{"plan_id", "cycle", "active"} {
		if _, ok := img[k]; !ok {
			t.Errorf("image is missing the operator-decided field %q", k)
		}
	}
}

// The catalog action must be filterable in the audit UI. A new action that is
// written but not listed is simply unreachable in the one view built for
// answering "who changed this".
func TestAppleCatalogActionIsFilterable(t *testing.T) {
	found := false
	for _, a := range auditActions {
		if a == AuditAppleProduct {
			found = true
		}
	}
	if !found {
		t.Fatalf("%s is missing from the audit filter list", AuditAppleProduct)
	}
	if _, ok := (&Service{}).confirmHandlerFor(AuditAppleProduct); !ok {
		t.Fatalf("%s has no confirm handler: its pending token would 500 on confirmation", AuditAppleProduct)
	}
}
