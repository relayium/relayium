package account

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"net/http"
	"strings"
	"testing"
	"time"
)

// One deployment, both signed App Store environments.
//
// TestFlight and App Review purchases are always SANDBOX; customers are always
// PRODUCTION. A single production deployment therefore has to accept both, and
// the whole hazard is that Apple numbers transactions per store: the same
// `originalTransactionId` names two unrelated subscriptions, one of which is
// free. Every case below measures one of the four ways that could go wrong —
// collide, steal ownership, drain the other's deferred deliveries, or revoke
// what somebody paid for — plus the configuration that turns the mode on.

const (
	// A synthetic App Store record id. Deliberately NOT either real Relayium
	// record: nothing in the test suite should be mistakable for deployment
	// configuration.
	testAppleStoreID = 6001234567
	// The originalTransactionId every fixture payload carries, and the two
	// identities it becomes. The Production spelling is the bare id, byte for
	// byte, because every binding recorded before this feature is one.
	testAppleOriginalTxID       = "2000000000000001"
	testAppleSandboxExternalID  = appleSandboxExternalPrefix + testAppleOriginalTxID
	testAppleProductionExternal = testAppleOriginalTxID
)

// dualVerifierApps is the app allowlist a dual-environment deployment needs:
// accepting Production means every app must name its real App Store record.
func dualVerifierApps() []AppleAppConfig {
	return []AppleAppConfig{
		{BundleID: testBundleIOS, AppAppleID: testAppleStoreID},
		{BundleID: testBundleMac, AppAppleID: testAppleStoreID + 1},
	}
}

func mustDualVerifier(t *testing.T, c *appleTestChain) *AppleTransactionVerifier {
	t.Helper()
	v, err := NewAppleTransactionVerifier(AppleStoreConfig{
		Environments: []string{appleEnvProduction, appleEnvSandbox},
		Apps:         dualVerifierApps(),
		RootCertsPEM: c.rootPEM,
	})
	if err != nil {
		t.Fatalf("dual-environment verifier: %v", err)
	}
	return v
}

// newAppleDualFixture is the ordinary intake/notification fixture with a
// verifier that accepts both environments.
func newAppleDualFixture(t *testing.T) *appleTxFixture {
	t.Helper()
	f := newAppleTxFixture(t)
	f.svc.SetAppleTransactionVerifier(mustDualVerifier(t, f.chain))
	return f
}

// inEnv stamps a payload's environment.
func inEnv(env string) func(map[string]any) {
	return func(p map[string]any) { p["environment"] = env }
}

// payloadIn builds one of this fixture's transactions in a named environment.
func (f *appleTxFixture) payloadIn(env string, mut ...func(map[string]any)) map[string]any {
	return f.payload(append([]func(map[string]any){inEnv(env)}, mut...)...)
}

// envelopeIn wraps one of this fixture's transactions in an envelope for the
// SAME environment — including the appAppleId a Production envelope must carry.
func (f *appleTxFixture) envelopeIn(t *testing.T, uuid, env string, txMut ...func(map[string]any)) string {
	t.Helper()
	tx := f.chain.sign(t, f.payloadIn(env, txMut...))
	return f.chain.notify(t, tx, func(p map[string]any) {
		p["notificationUUID"] = uuid
		d := p["data"].(map[string]any)
		d["environment"] = env
		if env == appleEnvProduction {
			d["appAppleId"] = testAppleStoreID
		}
	})
}

func (f *appleTxFixture) sourceOf(t *testing.T, userID string) SubscriptionSource {
	t.Helper()
	src, ok, err := f.store.GetSubscriptionSource(context.Background(), userID, ProviderApple)
	if err != nil || !ok {
		t.Fatalf("no apple source row for %s (ok=%v err=%v)", userID, ok, err)
	}
	return src
}

func (f *appleTxFixture) ownerOf(t *testing.T, externalID string) string {
	t.Helper()
	owner, _, err := f.store.UserByExternalSubscription(context.Background(), ProviderApple, externalID)
	if err != nil {
		t.Fatal(err)
	}
	return owner
}

// ── The configured set ───────────────────────────────────────────────────────

// The accepted/refused matrix, at the trust boundary. A verifier accepts
// exactly the environments it was configured with: no wildcard, no fallback
// that retries a refused payload under the other rule.
func TestAppleVerifierEnvironmentMatrix(t *testing.T) {
	c := newAppleTestChain(t)
	build := func(envs ...string) *AppleTransactionVerifier {
		t.Helper()
		v, err := NewAppleTransactionVerifier(AppleStoreConfig{
			Environments: envs, Apps: dualVerifierApps(), RootCertsPEM: c.rootPEM,
		})
		if err != nil {
			t.Fatalf("verifier for %v: %v", envs, err)
		}
		return v
	}
	for _, tc := range []struct {
		name       string
		configured []string
		accepts    map[string]bool
	}{
		{"sandbox only", []string{appleEnvSandbox}, map[string]bool{
			appleEnvSandbox: true, appleEnvProduction: false, "Xcode": false, "": false,
		}},
		{"production only", []string{appleEnvProduction}, map[string]bool{
			appleEnvSandbox: false, appleEnvProduction: true, "Xcode": false, "": false,
		}},
		{"both", []string{appleEnvProduction, appleEnvSandbox}, map[string]bool{
			appleEnvSandbox: true, appleEnvProduction: true, "Xcode": false, "": false,
			// Case is not a spelling Apple emits, and the closed set is compared
			// exactly. Accepting these would mean a payload could choose its own
			// normalization.
			"sandbox": false, "PRODUCTION": false, " Sandbox": false,
		}},
	} {
		v := build(tc.configured...)
		for env, want := range tc.accepts {
			jws := c.sign(t, applePayload(func(p map[string]any) {
				if env == "" {
					delete(p, "environment")
					return
				}
				p["environment"] = env
			}))
			_, err := v.Verify(jws, time.Now())
			if want && err != nil {
				t.Fatalf("%s: environment %q was refused: %v", tc.name, env, err)
			}
			if !want {
				if err == nil {
					t.Fatalf("%s: environment %q was accepted", tc.name, env)
				}
				if code := appleRejectionCode(err); code != "environment" {
					t.Fatalf("%s: environment %q refused as %q, want \"environment\"", tc.name, env, code)
				}
			}
		}
	}
}

// The configuration file's two ways of naming environments, and every way of
// getting them wrong. All of these are startup refusals: a deployment that
// cannot say which App Stores it verifies must not verify any.
func TestAppleStoreConfigEnvironments(t *testing.T) {
	c := newAppleTestChain(t)
	f := newAppleStoreFiles(t, c.rootPEM)
	// Every app names an App Store record, so Production is configurable and the
	// only variable below is the environment key itself.
	apps := fmt.Sprintf(`[{"bundleId":%q,"appAppleId":%d}]`, testBundleIOS, testAppleStoreID)
	doc := func(envKeys string) string {
		return fmt.Sprintf(`{%s"rootCertsFile":%q,"apps":%s}`, envKeys, f.rootsPath, apps)
	}

	// ACCEPTED, and each for a stated reason.
	for _, tc := range []struct {
		name    string
		envKeys string
		want    []string
	}{
		// The legacy singular key is exactly a one-element set, unchanged.
		{"legacy singular", `"environment":"Sandbox",`, []string{appleEnvSandbox}},
		{"legacy production", `"environment":"Production",`, []string{appleEnvProduction}},
		// Surrounding whitespace has always been trimmed by the singular reader;
		// the plural key is read under the same rule rather than a second one.
		{"legacy whitespace", `"environment":" Sandbox ",`, []string{appleEnvSandbox}},
		{"plural one", `"environments":["Sandbox"],`, []string{appleEnvSandbox}},
		{"plural both", `"environments":["Production","Sandbox"],`, []string{appleEnvProduction, appleEnvSandbox}},
		{"plural order kept", `"environments":["Sandbox","Production"],`, []string{appleEnvSandbox, appleEnvProduction}},
		{"plural whitespace", `"environments":[" Production "],`, []string{appleEnvProduction}},
	} {
		v, err := loadAppleStoreVerifier(f.config(t, doc(tc.envKeys)))
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if got := v.Environments(); strings.Join(got, ",") != strings.Join(tc.want, ",") {
			t.Fatalf("%s: configured %v, want %v", tc.name, got, tc.want)
		}
	}

	// REFUSED.
	for _, tc := range []struct{ name, envKeys string }{
		// The ambiguous document. encoding/json would take whichever key it read;
		// a file that says both has to be corrected by a human, not resolved here.
		{"both keys", `"environment":"Sandbox","environments":["Production"],`},
		{"both keys, agreeing", `"environment":"Sandbox","environments":["Sandbox"],`},
		{"both keys, empty singular", `"environment":"","environments":["Sandbox"],`},
		{"both keys, null singular", `"environment":null,"environments":["Sandbox"],`},
		{"both keys, null plural", `"environment":"Sandbox","environments":null,`},
		// No default App Store, in either spelling.
		{"neither key", ``},
		{"empty array", `"environments":[],`},
		{"empty string", `"environment":"",`},
		{"null singular", `"environment":null,`},
		// Not a set the deployment could have meant.
		{"duplicate", `"environments":["Sandbox","Sandbox"],`},
		{"three", `"environments":["Sandbox","Production","Sandbox"],`},
		{"case", `"environments":["sandbox"],`},
		{"case singular", `"environment":"production",`},
		{"unknown value", `"environments":["Xcode"],`},
		{"unknown singular", `"environment":"Xcode",`},
		{"empty element", `"environments":["Production",""],`},
		// Shape errors: a set is a list of strings and nothing else.
		{"scalar plural", `"environments":"Sandbox",`},
		{"nested", `"environments":[["Sandbox"]],`},
		{"object element", `"environments":[{"name":"Sandbox"}],`},
		{"array singular", `"environment":["Sandbox"],`},
		// The duplicate-key and unknown-field rules the file always had, restated
		// against the NEW key so the plural shape did not quietly widen them.
		{"duplicate plural key", `"environments":["Sandbox"],"environments":["Production"],`},
		{"unknown neighbour", `"environments":["Sandbox"],"environmnets":["Production"],`},
	} {
		mustNotLoad(t, f.config(t, doc(tc.envKeys)), tc.name)
	}

	// The size bound, asserted directly. Any three-element list is ALSO refused
	// by the value or duplicate rule — there are only two legal values — so a
	// file-level case cannot distinguish it. Stating it here is what keeps the
	// bound from being removed unnoticed on the day a third environment spelling
	// makes it load-bearing.
	if _, _, err := appleEnvironmentSet([]string{appleEnvSandbox, appleEnvProduction, appleEnvSandbox}); err == nil ||
		!strings.Contains(err.Error(), "max 2") {
		t.Fatalf("three environments must be refused by the stated bound, got %v", err)
	}
}

// Accepting Production is what requires a real App Store record id — whether or
// not Sandbox is accepted beside it. A dual-environment deployment verifies
// real money and owes the same answer to "which app is this" that a
// Production-only one does.
func TestAppleDualEnvironmentRequiresProductionAppAppleID(t *testing.T) {
	c := newAppleTestChain(t)
	build := func(envs []string, apps []AppleAppConfig) error {
		_, err := NewAppleTransactionVerifier(AppleStoreConfig{
			Environments: envs, Apps: apps, RootCertsPEM: c.rootPEM,
		})
		return err
	}
	both := []string{appleEnvProduction, appleEnvSandbox}
	withoutID := []AppleAppConfig{{BundleID: testBundleIOS}}
	// One app missing its id is enough: the requirement is per app, not "at
	// least one app has one".
	oneMissing := []AppleAppConfig{
		{BundleID: testBundleIOS, AppAppleID: testAppleStoreID},
		{BundleID: testBundleMac},
	}
	if err := build(both, withoutID); err == nil {
		t.Fatal("a dual-environment verifier was built without an appAppleId")
	}
	if err := build(both, oneMissing); err == nil {
		t.Fatal("a dual-environment verifier was built with one app missing its appAppleId")
	}
	if err := build(both, dualVerifierApps()); err != nil {
		t.Fatalf("a complete dual-environment configuration was refused: %v", err)
	}
	// Sandbox alone still declares none, which is the state every existing
	// sandbox deployment is in.
	if err := build([]string{appleEnvSandbox}, withoutID); err != nil {
		t.Fatalf("a sandbox-only configuration now requires an appAppleId: %v", err)
	}
}

// ── The identity ─────────────────────────────────────────────────────────────

// The qualified subscription identity, at the unit it is decided in.
func TestAppleSubscriptionKeyQualification(t *testing.T) {
	for _, tc := range []struct {
		name    string
		key     appleSubscriptionKey
		want    string
		wantErr bool
	}{
		// Production is unchanged, byte for byte. Every binding a
		// single-environment deployment ever recorded is one of these, and a scheme
		// that renamed them would orphan all of them.
		{"production", appleSubscriptionKey{"2000000000000001", appleEnvProduction}, "2000000000000001", false},
		{"sandbox", appleSubscriptionKey{"2000000000000001", appleEnvSandbox}, "sandbox:2000000000000001", false},
		// No environment is an honest unknown, not a default.
		{"no environment", appleSubscriptionKey{"2000000000000001", ""}, "", true},
		{"unknown environment", appleSubscriptionKey{"2000000000000001", "Xcode"}, "", true},
		{"case", appleSubscriptionKey{"2000000000000001", "sandbox"}, "", true},
		{"no id", appleSubscriptionKey{"", appleEnvProduction}, "", true},
		// The separator inside an id is what would let one namespace be spelled
		// from the other. The verifier refuses such an id, and so does this.
		{"separator in id", appleSubscriptionKey{"sandbox:2000000000000001", appleEnvProduction}, "", true},
		{"separator in sandbox id", appleSubscriptionKey{"20:01", appleEnvSandbox}, "", true},
	} {
		got, ok := tc.key.externalID()
		if tc.wantErr {
			if ok || got != "" {
				t.Fatalf("%s: want no external id, got %q (ok=%v)", tc.name, got, ok)
			}
			continue
		}
		if !ok || got != tc.want {
			t.Fatalf("%s: got %q (ok=%v), want %q", tc.name, got, ok, tc.want)
		}
	}
	// The two namespaces are disjoint for the same digits — the whole point.
	prod, _ := appleSubscriptionKey{"2000000000000001", appleEnvProduction}.externalID()
	sand, _ := appleSubscriptionKey{"2000000000000001", appleEnvSandbox}.externalID()
	if prod == sand {
		t.Fatal("the same originalTransactionId produced one identity in two environments")
	}
	if !appleExternalIDIsSandbox(sand) || appleExternalIDIsSandbox(prod) {
		t.Fatalf("namespace predicate disagrees with the encoding: %q %q", sand, prod)
	}
}

// An Apple id carrying the namespace separator is refused by the verifier. That
// refusal is what turns a naming convention into a partition: without it a
// Sandbox purchase could present `sandbox:<id>` and land on another Sandbox
// subscription's qualified identity.
func TestAppleVerifierRejectsSeparatorInTransactionIDs(t *testing.T) {
	c := newAppleTestChain(t)
	v := testVerifier(t, c)
	for _, tc := range []struct{ name, field, value string }{
		{"original, namespace spelling", "originalTransactionId", "sandbox:2000000000000001"},
		{"original, bare separator", "originalTransactionId", "2000000:000001"},
		{"original, trailing", "originalTransactionId", "2000000000000001:"},
		{"transaction id", "transactionId", "sandbox:2000000000000001"},
	} {
		jws := c.sign(t, applePayload(func(p map[string]any) { p[tc.field] = tc.value }))
		_, err := v.Verify(jws, time.Now())
		if err == nil {
			t.Fatalf("%s: %s=%q was accepted", tc.name, tc.field, tc.value)
		}
		if code := appleRejectionCode(err); code != "transaction_ids" {
			t.Fatalf("%s: refused as %q, want \"transaction_ids\"", tc.name, code)
		}
	}
	// The ordinary id still verifies, so the check above is not simply refusing
	// everything.
	if _, err := v.Verify(c.sign(t, applePayload()), time.Now()); err != nil {
		t.Fatalf("an ordinary transaction id was refused: %v", err)
	}
}

// ── Cross-layer identity, with both environments allowed ─────────────────────

// The case that only becomes reachable when both environments are configured: a
// genuine Production envelope carrying a genuine Sandbox transaction. Both
// layers verify, both environments are allowed, and only the cross-layer
// comparison can refuse it. Without that refusal a free Sandbox purchase would
// be applied as the Production subscription it names.
func TestAppleNotificationCrossEnvironmentLayerMismatch(t *testing.T) {
	c := newAppleTestChain(t)
	v := mustDualVerifier(t, c)

	sandboxTx := c.sign(t, applePayload())
	productionTx := c.sign(t, applePayload(inEnv(appleEnvProduction)))
	productionEnvelope := func(txJWS string) string {
		return c.notify(t, txJWS, withAppleNotificationData(func(d map[string]any) {
			d["environment"] = appleEnvProduction
			d["appAppleId"] = testAppleStoreID
		}))
	}

	// Each half is individually acceptable to this verifier...
	if _, err := v.Verify(sandboxTx, time.Now()); err != nil {
		t.Fatalf("the sandbox transaction must be valid on its own: %v", err)
	}
	if _, err := v.Verify(productionTx, time.Now()); err != nil {
		t.Fatalf("the production transaction must be valid on its own: %v", err)
	}
	mustVerifyNotification(t, v, c.notify(t, sandboxTx))
	mustVerifyNotification(t, v, productionEnvelope(productionTx))

	// ...and the two crossed are refused, in both directions.
	mustRejectNotification(t, v, productionEnvelope(sandboxTx), "notification_layer_mismatch")
	mustRejectNotification(t, v, c.notify(t, productionTx), "notification_layer_mismatch")
}

// appAppleId identity is decided per delivery rather than per deployment.
// Production must carry and match the configured record; Sandbox ignores the
// field exactly as Apple's official verifier does, even when Production is also
// accepted by this process.
func TestAppleNotificationAppAppleIDUnderBothEnvironments(t *testing.T) {
	c := newAppleTestChain(t)
	v := mustDualVerifier(t, c)
	sandboxTx := c.sign(t, applePayload())
	productionTx := c.sign(t, applePayload(inEnv(appleEnvProduction)))
	production := func(mut func(map[string]any)) string {
		return c.notify(t, productionTx, withAppleNotificationData(func(d map[string]any) {
			d["environment"] = appleEnvProduction
			mut(d)
		}))
	}
	sandbox := func(mut func(map[string]any)) string {
		return c.notify(t, sandboxTx, withAppleNotificationData(mut))
	}

	// Production: required, and matched.
	mustRejectNotification(t, v, production(func(d map[string]any) {}), "app_apple_id")
	mustRejectNotification(t, v, production(func(d map[string]any) {
		d["appAppleId"] = testAppleStoreID + 5
	}), "app_apple_id")
	// The OTHER configured app's record is the sharpest miss: it is a real id
	// this deployment knows, just not this bundle's.
	mustRejectNotification(t, v, production(func(d map[string]any) {
		d["appAppleId"] = testAppleStoreID + 1
	}), "app_apple_id")
	mustVerifyNotification(t, v, production(func(d map[string]any) {
		d["appAppleId"] = testAppleStoreID
	}))

	// Sandbox: absent or present is ignored. bundleId remains the app identity.
	mustVerifyNotification(t, v, sandbox(func(d map[string]any) {}))
	mustVerifyNotification(t, v, sandbox(func(d map[string]any) {
		d["appAppleId"] = testAppleStoreID
	}))
	mustVerifyNotification(t, v, sandbox(func(d map[string]any) {
		d["appAppleId"] = testAppleStoreID + 1
	}))

	// A Sandbox-only deployment keeps the same behavior.
	sandboxOnly := testVerifier(t, c)
	mustVerifyNotification(t, sandboxOnly, sandbox(func(d map[string]any) {
		d["appAppleId"] = testAppleStoreID
	}))
}

// ── Two stores, one deployment: the entitlement paths ────────────────────────

// Different users, same originalTransactionId. Neither subscription may reach
// the other: not to steal its owner, not to conflict with it, not to change it.
func TestAppleDualEnvironmentSeparatesIdenticalTransactionIDs(t *testing.T) {
	f := newAppleDualFixture(t)
	// A second account with its own attribution token, purchasing in Sandbox.
	sandboxCookie := loginCookie(t, f.ts, f.mail, "apple-sandbox@example.com")
	sandboxID := mustUserID(t, f.store, "apple-sandbox@example.com")
	sandboxToken := postAppleToken(t, f.ts, sandboxCookie)

	// The paying customer, in Production.
	f.mustAccept(t, f.chain.sign(t, f.payloadIn(appleEnvProduction)))

	// The tester, in Sandbox, on the SAME originalTransactionId. It must not be
	// refused as somebody else's subscription — it is a different one.
	resp := f.submitAs(t, sandboxCookie, f.chain.sign(t, applePayload(func(p map[string]any) {
		p["appAccountToken"] = sandboxToken
		p["productId"] = testAppleProduct
	})))
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("the sandbox purchase was refused as a collision: %d", resp.StatusCode)
	}

	// Two subscriptions, two identities, two owners.
	if got := f.sourceOf(t, f.userID).ExternalID; got != testAppleProductionExternal {
		t.Fatalf("the production binding must be the bare id, got %q", got)
	}
	if got := f.sourceOf(t, sandboxID).ExternalID; got != testAppleSandboxExternalID {
		t.Fatalf("the sandbox binding must be namespaced, got %q", got)
	}
	if owner := f.ownerOf(t, testAppleProductionExternal); owner != f.userID {
		t.Fatalf("production ownership moved to %q", owner)
	}
	if owner := f.ownerOf(t, testAppleSandboxExternalID); owner != sandboxID {
		t.Fatalf("sandbox ownership resolved to %q", owner)
	}
	// Both hold their own entitlement; neither was disturbed by the other.
	if u := f.user(t); u.PlanID != "pro" || u.PlanSource != ProviderApple {
		t.Fatalf("the paying customer's entitlement moved: %+v", u)
	}
	tester, err := f.store.GetUserByID(context.Background(), sandboxID)
	if err != nil {
		t.Fatal(err)
	}
	if tester.PlanID != "pro" {
		t.Fatalf("the sandbox purchase granted nothing: %+v", tester)
	}
}

// The revocation half of the same separation, and the one that costs money when
// it is wrong: a Sandbox subscription ending must not end the Production
// subscription that shares its digits.
func TestAppleDualEnvironmentSandboxRevokeLeavesProductionAlone(t *testing.T) {
	f := newAppleDualFixture(t)
	sandboxCookie := loginCookie(t, f.ts, f.mail, "apple-sandbox-revoke@example.com")
	sandboxID := mustUserID(t, f.store, "apple-sandbox-revoke@example.com")
	sandboxToken := postAppleToken(t, f.ts, sandboxCookie)

	f.mustAccept(t, f.chain.sign(t, f.payloadIn(appleEnvProduction)))
	sandboxPayload := func(mut ...func(map[string]any)) map[string]any {
		return applePayload(append([]func(map[string]any){func(p map[string]any) {
			p["appAccountToken"] = sandboxToken
			p["productId"] = testAppleProduct
		}}, mut...)...)
	}
	resp := f.submitAs(t, sandboxCookie, f.chain.sign(t, sandboxPayload()))
	resp.Body.Close()

	// The sandbox subscription is refunded — a LATER event on the same digits.
	now := time.Now().UnixMilli()
	revoke := f.chain.notify(t, f.chain.sign(t, sandboxPayload(func(p map[string]any) {
		p["revocationDate"] = now
		p["purchaseDate"] = now
	})), func(p map[string]any) { p["notificationUUID"] = appleNotifyUUID(0x5a1) })
	f.mustNotify(t, revoke, http.StatusOK)

	// The tester loses access...
	tester, err := f.store.GetUserByID(context.Background(), sandboxID)
	if err != nil {
		t.Fatal(err)
	}
	if tester.PlanID != freePlanID {
		t.Fatalf("the revoked sandbox subscription still grants: %+v", tester)
	}
	// ...and the customer does not.
	if u := f.user(t); u.PlanID != "pro" || u.PlanSource != ProviderApple {
		t.Fatalf("a sandbox revocation revoked a production entitlement: %+v", u)
	}
	if got := f.sourceOf(t, f.userID).ExternalID; got != testAppleProductionExternal {
		t.Fatalf("the production binding was rewritten: %q", got)
	}
}

// The same user in both stores. One account holds ONE row per provider, so the
// qualified identity alone cannot keep these apart — the store refuses the
// displacement instead. The reachable case is a developer on TestFlight who is
// also a paying customer: a sandbox purchase is signed today, so its clock
// outranks the production one it would otherwise replace, and it expires in
// minutes.
func TestAppleDualEnvironmentSandboxCannotDisplaceProductionForOneUser(t *testing.T) {
	f := newAppleDualFixture(t)
	f.mustAccept(t, f.chain.sign(t, f.payloadIn(appleEnvProduction)))

	// A LATER sandbox purchase by the same account, in every sense newer.
	now := time.Now().UnixMilli()
	got, _ := f.mustAccept(t, f.chain.sign(t, f.payloadIn(appleEnvSandbox, func(p map[string]any) {
		p["purchaseDate"] = now
		p["expiresDate"] = now + 5*60*1000
	})))
	if got.Applied {
		t.Fatal("a sandbox purchase displaced a production subscription")
	}
	src := f.sourceOf(t, f.userID)
	if src.ExternalID != testAppleProductionExternal {
		t.Fatalf("the production binding was replaced by the sandbox one: %q", src.ExternalID)
	}
	if u := f.user(t); u.PlanID != "pro" || u.PlanSource != ProviderApple {
		t.Fatalf("the production entitlement moved: %+v", u)
	}

	// And the sandbox subscription ending afterwards changes nothing either.
	f.mustNotify(t, f.envelopeIn(t, appleNotifyUUID(0x5a2), appleEnvSandbox, func(p map[string]any) {
		p["revocationDate"] = now + 1000
		p["purchaseDate"] = now + 1000
	}), http.StatusOK)
	if u := f.user(t); u.PlanID != "pro" {
		t.Fatalf("a sandbox revocation revoked this account's production plan: %+v", u)
	}
	if got := f.sourceOf(t, f.userID).ExternalID; got != testAppleProductionExternal {
		t.Fatalf("the production binding was rewritten by a sandbox revocation: %q", got)
	}
}

// The opposite direction is deliberately allowed even when the paid purchase is
// older: a long-lived Production subscription restored after a fresh TestFlight
// purchase must take the binding, and the later Sandbox expiry must not undo it.
func TestAppleDualEnvironmentProductionSupersedesSandbox(t *testing.T) {
	f := newAppleDualFixture(t)
	now := time.Now().UnixMilli()
	f.mustAccept(t, f.chain.sign(t, f.payloadIn(appleEnvSandbox, func(p map[string]any) {
		p["purchaseDate"] = now
	})))
	if got := f.sourceOf(t, f.userID).ExternalID; got != testAppleSandboxExternalID {
		t.Fatalf("the sandbox binding was not recorded: %q", got)
	}
	got, _ := f.mustAccept(t, f.chain.sign(t, f.payloadIn(appleEnvProduction, func(p map[string]any) {
		p["purchaseDate"] = now - 30*24*60*60*1000
	})))
	if !got.Applied {
		t.Fatal("a production purchase was refused after a sandbox one")
	}
	if id := f.sourceOf(t, f.userID).ExternalID; id != testAppleProductionExternal {
		t.Fatalf("the production purchase did not take the binding: %q", id)
	}

	// The newer Sandbox subscription expires after Production took over. It may
	// not reclaim the row or revoke the paid entitlement.
	f.mustNotify(t, f.envelopeIn(t, appleNotifyUUID(0x5a5), appleEnvSandbox, func(p map[string]any) {
		p["purchaseDate"] = now + 1000
		p["revocationDate"] = now + 1000
	}), http.StatusOK)
	if u := f.user(t); u.PlanID != "pro" || u.PlanSource != ProviderApple {
		t.Fatalf("the sandbox expiry revoked the restored production plan: %+v", u)
	}
	if id := f.sourceOf(t, f.userID).ExternalID; id != testAppleProductionExternal {
		t.Fatalf("the sandbox expiry reclaimed the production binding: %q", id)
	}
}

// ── Deferred deliveries ──────────────────────────────────────────────────────

// A drain is per SUBSCRIPTION, and the environment is half of which one. A
// Production purchase must not consume the deferred deliveries of the Sandbox
// subscription that shares its digits — they belong to a different account and
// describe a different (free) subscription.
func TestAppleDualEnvironmentPendingDrainIsolation(t *testing.T) {
	f := newAppleDualFixture(t)
	stranger := "3f2504e0-4f89-41d3-9a0c-0305e82c3399"

	// A Sandbox notification for a subscription nobody owns yet.
	uuid := appleNotifyUUID(0x5a3)
	f.mustNotify(t, f.envelopeIn(t, uuid, appleEnvSandbox, func(p map[string]any) {
		p["appAccountToken"] = stranger
	}), http.StatusOK)
	if got := f.ledger(t, uuid).State; got != appleNotificationPending {
		t.Fatalf("want pending, got %q", got)
	}
	if got := f.ledger(t, uuid).Projection.Environment; got != appleEnvSandbox {
		t.Fatalf("the pending row must record its environment, got %q", got)
	}

	// A PRODUCTION purchase on the same digits drains nothing of the sandbox
	// subscription's.
	f.mustAccept(t, f.chain.sign(t, f.payloadIn(appleEnvProduction)))
	if got := f.ledger(t, uuid).State; got != appleNotificationPending {
		t.Fatalf("a production purchase drained a sandbox deferred delivery: %q", got)
	}

	// The sandbox subscription's own owner appearing does drain it.
	f.mustAccept(t, f.chain.sign(t, f.payloadIn(appleEnvSandbox)))
	if got := f.ledger(t, uuid).State; got != appleNotificationApplied {
		t.Fatalf("the sandbox drain did not run: %q", got)
	}
}

// A pending row written before the environment column exists carries no
// environment. It is UNKNOWABLE which store it came from — guessing Production
// would let an old Sandbox event reach a paid binding, guessing Sandbox would
// strand a real one — so it is skipped, and saying so is the only thing that
// makes an undrainable row distinguishable from an absent one.
func TestApplePendingNotificationWithoutEnvironmentIsSkippedAndLogged(t *testing.T) {
	f := newAppleDualFixture(t)
	ctx := context.Background()
	uuid := appleNotifyUUID(0x5a4)

	// Exactly the row an older binary wrote: the raw id, no environment.
	legacy := AppleNotificationRecord{
		UUID: uuid, Type: "DID_RENEW", ReceivedAt: time.Now().Unix(), Supported: true,
		Projection: AppleNotificationProjection{
			BundleID: testBundleIOS, ProductID: testAppleProduct,
			OriginalTransactionID: testAppleOriginalTxID,
			AppAccountToken:       f.token,
			PurchaseDateMS:        time.Now().UnixMilli() - 1000,
			ExpiresDateMS:         time.Now().Add(30 * 24 * time.Hour).UnixMilli(),
		},
	}
	if _, _, err := f.store.ClaimAppleNotification(ctx, legacy); err != nil {
		t.Fatal(err)
	}
	if err := f.store.SetAppleNotificationState(ctx, uuid, appleNotificationPending, time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	if got := f.ledger(t, uuid).Projection.Environment; got != "" {
		t.Fatalf("the legacy row must have no environment, got %q", got)
	}

	var logged bytes.Buffer
	original := log.Writer()
	log.SetOutput(&logged)
	defer log.SetOutput(original)

	// A purchase for the same digits, in each store. Neither may replay it.
	f.mustAccept(t, f.chain.sign(t, f.payloadIn(appleEnvProduction)))
	f.mustAccept(t, f.chain.sign(t, f.payloadIn(appleEnvSandbox)))

	if got := f.ledger(t, uuid).State; got != appleNotificationPending {
		t.Fatalf("a row with no recorded environment was replayed as %q", got)
	}
	out := logged.String()
	if !strings.Contains(out, uuid) || !strings.Contains(out, "unknown environment") {
		t.Fatalf("the skip was not observable in the log:\n%s", out)
	}

	// The other way the same row can be reached: Apple REDELIVERS it. The first
	// verified body is authoritative, so the replayed projection is the one with
	// no environment — and it must be answered honestly (durable, non-terminal,
	// named) rather than granted or reported as merely unattributable.
	logged.Reset()
	f.mustNotify(t, f.envelopeIn(t, uuid, appleEnvSandbox), http.StatusOK)
	if got := f.ledger(t, uuid).State; got != appleNotificationPending {
		t.Fatalf("a redelivered environment-less row became %q", got)
	}
	if !strings.Contains(logged.String(), "unknown_environment") {
		t.Fatalf("the redelivery did not name its reason:\n%s", logged.String())
	}
	if u := f.user(t); u.PlanID != "pro" || f.sourceOf(t, f.userID).ExternalID != testAppleProductionExternal {
		t.Fatalf("the replay disturbed the account's real subscription: %+v", u)
	}
}

// ── The client's request is unchanged ────────────────────────────────────────

// Nothing about accepting two environments gives the client a say in which one
// it is. The request body still holds exactly one field, and the environment
// comes from inside Apple's signature.
func TestAppleDualEnvironmentClientRequestShapeUnchanged(t *testing.T) {
	f := newAppleDualFixture(t)
	jws := f.chain.sign(t, f.payloadIn(appleEnvProduction))
	for _, body := range []string{
		`{"signedTransactionInfo":%q,"environment":"Sandbox"}`,
		`{"signedTransactionInfo":%q,"environments":["Sandbox"]}`,
	} {
		resp := f.post(t, f.cookie, fmt.Sprintf(body, jws))
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("a client-supplied environment was tolerated: %d (%s)", resp.StatusCode, body)
		}
	}
	// The unchanged shape still works, and still lands in the environment the
	// SIGNATURE names.
	f.mustAccept(t, jws)
	if got := f.sourceOf(t, f.userID).ExternalID; got != testAppleProductionExternal {
		t.Fatalf("the signed environment did not decide the identity: %q", got)
	}
}
