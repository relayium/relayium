package account

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// The Apple purchase-attempt state machine.
//
// The defect this covers: purchase dispatch created a permanent `dispatched`
// attempt BEFORE StoreKit ran, so a genuine `.userCancelled` — which creates no
// transaction at all — left the account permanently unable to buy, having been
// charged nothing.
//
// Everything below is written against the trust boundary rather than the happy
// path: Apple signs transactions and never their absence, so a client's
// cancellation report is an assertion by a bound capability holder, not proof.
// What must therefore be true is that the capability, and ONLY the capability,
// can re-open a sheet — never the account session and never possession of the
// appAccountToken.

const testContinuationInstanceA = "instance-A-6f1c9d2e"
const testContinuationInstanceB = "instance-B-0a7b4e15"

func testContinuationSecret(fill byte) string {
	return base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{fill}, appleContinuationSecretBytes))
}

type appleContinuationFixture struct {
	*appleTxFixture
}

// newAppleContinuationFixture is newAppleTxFixture with purchases enabled and
// NO seeded legacy token, so the attribution token under test is the one the
// dispatch itself mints.
func newAppleContinuationFixture(t *testing.T) *appleContinuationFixture {
	t.Helper()
	ts, svc, store, mail := newBillingServer(t)
	seedTiers(t, store)
	if err := store.SetSetting(context.Background(), SettingApplePurchasesEnabled, 1, 1); err != nil {
		t.Fatalf("enable Apple purchases: %v", err)
	}
	chain := newAppleTestChain(t)
	verifier := testVerifier(t, chain)
	svc.SetAppleTransactionVerifier(verifier)
	svc.SetAppleSubscriptionReconciler(appleReconcilerFunc(func(_ context.Context, tx VerifiedAppleTransaction, now time.Time) (AppleSubscriptionCanonical, error) {
		return AppleSubscriptionCanonical{Transaction: tx, Renewal: VerifiedAppleRenewalInfo{
			OriginalTransactionID: tx.OriginalTransactionID, AutoRenewProductID: tx.ProductID,
			AppAccountToken: tx.AppAccountToken, Environment: tx.Environment, AutoRenewEnabled: true,
			RenewalDateMS: tx.ExpiresDateMS, SignedDateMS: now.UnixMilli(),
		}}, nil
	}))
	mustAppleProduct(t, store, AppleProduct{BundleID: testBundleIOS, ProductID: testAppleProduct, PlanID: "pro", Cycle: "monthly", Active: true})
	email := "apple-continuation@example.com"
	cookie := loginCookie(t, ts, mail, email)
	return &appleContinuationFixture{&appleTxFixture{
		ts: ts, svc: svc, store: store, mail: mail, chain: chain, verifier: verifier,
		cookie: cookie, userID: mustUserID(t, store, email),
	}}
}

type dispatchBody struct {
	AppAccountToken    string `json:"appAccountToken"`
	AttemptID          string `json:"attemptId"`
	ContinuationSecret string `json:"continuationSecret"`
	Error              string `json:"error"`
}

func (f *appleContinuationFixture) dispatchRawAs(t *testing.T, cookie *http.Cookie, in map[string]string) (int, dispatchBody) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, f.ts.URL+"/api/billing/apple/purchase-dispatch", bytes.NewReader(mustJSON(t, in)))
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
	defer resp.Body.Close()
	var out dispatchBody
	raw, _ := io.ReadAll(resp.Body)
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("decode dispatch body %q: %v", raw, err)
	}
	return resp.StatusCode, out
}

func (f *appleContinuationFixture) dispatchAs(t *testing.T, cookie *http.Cookie, in map[string]string) (int, dispatchBody) {
	t.Helper()
	current := make(map[string]string, len(in)+1)
	for key, value := range in {
		current[key] = value
	}
	if current["appInstanceId"] != "" && current["continuationProtocol"] == "" {
		current["continuationProtocol"] = appleContinuationProtocolAttemptIDV2
	}
	return f.dispatchRawAs(t, cookie, current)
}

func (f *appleContinuationFixture) dispatchWithoutProtocol(t *testing.T, in map[string]string) (int, dispatchBody) {
	t.Helper()
	return f.dispatchRawAs(t, f.cookie, in)
}

func (f *appleContinuationFixture) dispatch(t *testing.T, in map[string]string) (int, dispatchBody) {
	t.Helper()
	return f.dispatchAs(t, f.cookie, in)
}

// initialArmID is the arm identity this fixture gives an instance's FIRST arm.
//
// Every new-protocol dispatch must name its arm, the initial one included, and a
// later outcome report must present that same name. Deriving the initial one
// keeps the ordinary case readable; a test that cares about WHICH arm it is
// talking to names it explicitly through armWith/reportArm.
func initialArmID(instance string) string { return "arm-initial-" + instance }

// arm performs the initial new-protocol dispatch and returns the attempt id and
// the one-time secret.
func (f *appleContinuationFixture) arm(t *testing.T, instance string) (string, string) {
	t.Helper()
	return f.armWith(t, instance, initialArmID(instance))
}

func (f *appleContinuationFixture) armWith(t *testing.T, instance, armRequestID string) (string, string) {
	t.Helper()
	status, body := f.dispatch(t, map[string]string{
		"bundleId": testBundleIOS, "productId": testAppleProduct, "appInstanceId": instance,
		"armRequestId": armRequestID,
	})
	if status != http.StatusOK || body.AttemptID == "" || body.ContinuationSecret == "" {
		t.Fatalf("arm: status=%d body=%+v", status, body)
	}
	return body.AttemptID, body.ContinuationSecret
}

func (f *appleContinuationFixture) reportAs(t *testing.T, cookie *http.Cookie, in map[string]string) (int, map[string]any) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, f.ts.URL+"/api/billing/apple/purchase-outcome", bytes.NewReader(mustJSON(t, in)))
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
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("decode outcome body %q: %v", raw, err)
	}
	return resp.StatusCode, out
}

// report reports against the instance's INITIAL arm, which is the arm still open
// in every test that has not resumed.
func (f *appleContinuationFixture) report(t *testing.T, attemptID, instance, secret, outcome string) (int, map[string]any) {
	t.Helper()
	return f.reportArm(t, attemptID, instance, secret, initialArmID(instance), outcome)
}

func (f *appleContinuationFixture) reportArm(t *testing.T, attemptID, instance, secret, armRequestID, outcome string) (int, map[string]any) {
	t.Helper()
	return f.reportAs(t, f.cookie, map[string]string{
		"bundleId": testBundleIOS, "attemptId": attemptID, "appInstanceId": instance,
		"continuationSecret": secret, "armRequestId": armRequestID, "outcome": outcome,
	})
}

func (f *appleContinuationFixture) attemptState(t *testing.T, attemptID string) (state, continuation, outcome string) {
	t.Helper()
	if err := f.store.db.QueryRow(`SELECT state,continuation_state,client_outcome FROM billing_purchase_attempts WHERE id=?`, attemptID).
		Scan(&state, &continuation, &outcome); err != nil {
		t.Fatalf("read attempt %s: %v", attemptID, err)
	}
	return state, continuation, outcome
}

// currentArmID reads the arm identity a StoreKit outcome must now present.
func (f *appleContinuationFixture) currentArmID(t *testing.T, attemptID string) string {
	t.Helper()
	var armID string
	if err := f.store.db.QueryRow(`SELECT arm_request_id FROM billing_purchase_attempts WHERE id=?`, attemptID).Scan(&armID); err != nil {
		t.Fatalf("read arm id %s: %v", attemptID, err)
	}
	return armID
}

func (f *appleContinuationFixture) countAttempts(t *testing.T) int {
	t.Helper()
	var n int
	if err := f.store.db.QueryRow(`SELECT COUNT(*) FROM billing_purchase_attempts WHERE user_id=?`, f.userID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func (f *appleContinuationFixture) countSubjects(t *testing.T) int {
	t.Helper()
	var n int
	if err := f.store.db.QueryRow(`SELECT COUNT(*) FROM apple_billing_subjects WHERE user_id=?`, f.userID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func (f *appleContinuationFixture) countAuthorities(t *testing.T) int {
	t.Helper()
	var n int
	if err := f.store.db.QueryRow(`SELECT COUNT(*) FROM billing_authorities WHERE user_id=?`, f.userID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// ---------------------------------------------------------------------------
// The deadlock itself
// ---------------------------------------------------------------------------

// A cancelled sheet must be recoverable without creating a second financial
// identity, and must leave no charge behind.
func TestUserCancelledSheetResumesWithoutCreatingANewFinancialIdentity(t *testing.T) {
	f := newAppleContinuationFixture(t)
	attemptID, secret := f.arm(t, testContinuationInstanceA)
	if state, continuation, _ := f.attemptState(t, attemptID); state != "dispatched" || continuation != appleContinuationArmed {
		t.Fatalf("armed attempt state=%q continuation=%q", state, continuation)
	}

	status, body := f.report(t, attemptID, testContinuationInstanceA, secret, appleOutcomeUserCancelled)
	if status != http.StatusOK || body["resumable"] != true {
		t.Fatalf("cancel report: status=%d body=%v", status, body)
	}
	if _, continuation, outcome := f.attemptState(t, attemptID); continuation != appleContinuationCancelled || outcome != appleOutcomeUserCancelled {
		t.Fatalf("after cancel report continuation=%q outcome=%q", continuation, outcome)
	}

	before, subjectsBefore := f.countAttempts(t), f.countSubjects(t)
	status, resumed := f.dispatch(t, map[string]string{
		"bundleId": testBundleIOS, "productId": testAppleProduct,
		"appInstanceId": testContinuationInstanceA, "continuationSecret": secret,
		"armRequestId": "resume-1",
	})
	if status != http.StatusOK {
		t.Fatalf("resume: status=%d body=%+v", status, resumed)
	}
	if resumed.AttemptID != attemptID {
		t.Fatalf("resume minted a fresh attempt: %q want %q", resumed.AttemptID, attemptID)
	}
	if resumed.ContinuationSecret != "" {
		t.Fatal("resume re-issued the one-time continuation secret")
	}
	if after, subjectsAfter := f.countAttempts(t), f.countSubjects(t); after != before || subjectsAfter != subjectsBefore {
		t.Fatalf("resume created rows: attempts %d->%d subjects %d->%d", before, after, subjectsBefore, subjectsAfter)
	}
	// No fresh attribution token, either: a second token would be a second
	// identity Apple could attribute a charge to.
	var token string
	if err := f.store.db.QueryRow(`SELECT apple_account_token FROM billing_purchase_attempts WHERE id=?`, attemptID).Scan(&token); err != nil {
		t.Fatal(err)
	}
	if resumed.AppAccountToken != token {
		t.Fatalf("resume changed the attribution token: %q want %q", resumed.AppAccountToken, token)
	}
	if _, continuation, _ := f.attemptState(t, attemptID); continuation != appleContinuationArmed {
		t.Fatalf("resume did not re-arm: %q", continuation)
	}
}

// Production regression: one installation cancelled, then the same Relayium
// account tried to buy from another installation. A cancellation has no
// transaction and no remaining sheet, so pinning that zero-charge state to the
// first device forever is a lockout, not a financial safeguard.
//
// The takeover is still a money boundary: it must replace the capability and
// arm atomically, preserve the attempt and attribution token, make every delayed
// report from the old device inert, and permit the old client to take over again
// only after the new arm is itself explicitly cancelled.
func TestCancelledAttemptCanMoveBetweenInstallationsWithoutOpeningTwoSheets(t *testing.T) {
	f := newAppleContinuationFixture(t)
	// Match the continuation client shipped in 1.3.3 and the internal 1.3.4
	// candidate: it persists and presents its own secret
	// before the initial request rather than relying on the compatibility shape
	// that asks the server to mint one in the response.
	secretA := testContinuationSecret(0x41)
	status, initial := f.dispatch(t, map[string]string{
		"bundleId": testBundleIOS, "productId": testAppleProduct,
		"appInstanceId": testContinuationInstanceA, "continuationSecret": secretA,
		"armRequestId": initialArmID(testContinuationInstanceA),
	})
	if status != http.StatusOK || initial.AttemptID == "" || initial.ContinuationSecret != "" {
		t.Fatalf("client-secret initial arm: status=%d body=%+v", status, initial)
	}
	attemptID := initial.AttemptID
	oldArm := initialArmID(testContinuationInstanceA)
	if status, body := f.reportArm(t, attemptID, testContinuationInstanceA, secretA, oldArm, appleOutcomeUserCancelled); status != http.StatusOK || body["resumable"] != true {
		t.Fatalf("instance A cancel: status=%d body=%v", status, body)
	}

	var originalToken string
	if err := f.store.db.QueryRow(`SELECT apple_account_token FROM billing_purchase_attempts WHERE id=?`, attemptID).Scan(&originalToken); err != nil {
		t.Fatal(err)
	}
	secretB := testContinuationSecret(0x42)
	const armB = "arm-installation-B"
	status, moved := f.dispatch(t, map[string]string{
		"bundleId": testBundleIOS, "productId": testAppleProduct,
		"appInstanceId": testContinuationInstanceB, "continuationSecret": secretB,
		"armRequestId": armB,
	})
	if status != http.StatusOK || moved.AttemptID != attemptID || moved.AppAccountToken != originalToken {
		t.Fatalf("cross-install takeover: status=%d body=%+v", status, moved)
	}
	if moved.ContinuationSecret != "" {
		t.Fatal("takeover echoed a client-persisted continuation secret")
	}
	// Losing the takeover's 200 cannot create another logical arm. The existing
	// continuation client persisted this exact intent before sending it, so replaying the
	// same fields must read the same authorization back.
	replayStatus, replayed := f.dispatch(t, map[string]string{
		"bundleId": testBundleIOS, "productId": testAppleProduct,
		"appInstanceId": testContinuationInstanceB, "continuationSecret": secretB,
		"armRequestId": armB,
	})
	if replayStatus != http.StatusOK || replayed.AttemptID != attemptID || replayed.AppAccountToken != originalToken {
		t.Fatalf("lost takeover response was not replayed: status=%d body=%+v", replayStatus, replayed)
	}
	if f.countAttempts(t) != 1 || f.countSubjects(t) != 1 {
		t.Fatalf("takeover created financial identity: attempts=%d subjects=%d", f.countAttempts(t), f.countSubjects(t))
	}
	var instance, arm string
	var verifier []byte
	if err := f.store.db.QueryRow(`SELECT app_instance_id,continuation_verifier,arm_request_id FROM billing_purchase_attempts WHERE id=?`, attemptID).
		Scan(&instance, &verifier, &arm); err != nil {
		t.Fatal(err)
	}
	if instance != testContinuationInstanceB || arm != armB || !bytes.Equal(verifier, appleContinuationVerifier(secretB)) {
		t.Fatalf("takeover binding instance=%q arm=%q verifierMatches=%v", instance, arm, bytes.Equal(verifier, appleContinuationVerifier(secretB)))
	}

	// Delayed output from A names both the old capability and the old arm. It may
	// not cancel B's live sheet or authorize a third one.
	if status, _ := f.reportArm(t, attemptID, testContinuationInstanceA, secretA, oldArm, appleOutcomeUserCancelled); status != http.StatusForbidden {
		t.Fatalf("stale A cancellation status=%d, want 403", status)
	}
	if _, continuation, _ := f.attemptState(t, attemptID); continuation != appleContinuationArmed {
		t.Fatalf("stale A cancellation released B's sheet: %q", continuation)
	}
	if status, body := f.dispatch(t, map[string]string{
		"bundleId": testBundleIOS, "productId": testAppleProduct,
		"appInstanceId": testContinuationInstanceA, "continuationSecret": secretA,
		"armRequestId": "arm-A-too-early",
	}); status != http.StatusForbidden || body.Error != appleRefusalCapabilityCode {
		t.Fatalf("A opened alongside B: status=%d body=%+v", status, body)
	}

	if status, body := f.reportArm(t, attemptID, testContinuationInstanceB, secretB, armB, appleOutcomeUserCancelled); status != http.StatusOK || body["resumable"] != true {
		t.Fatalf("instance B cancel: status=%d body=%v", status, body)
	}
	status, returned := f.dispatch(t, map[string]string{
		"bundleId": testBundleIOS, "productId": testAppleProduct,
		"appInstanceId": testContinuationInstanceA, "continuationSecret": secretA,
		"armRequestId": "arm-installation-A-return",
	})
	if status != http.StatusOK || returned.AttemptID != attemptID || returned.AppAccountToken != originalToken {
		t.Fatalf("return takeover: status=%d body=%+v", status, returned)
	}
}

// A client that does not promise to adopt an authoritative replacement attempt
// id may replay or resume its own existing attempt, but it may neither take over
// another installation nor create a fresh continuation attempt. Both refusals
// happen before any new financial identity or live arm exists.
func TestPreAttemptIDV2ClientCannotEnterAReplacementAttemptPath(t *testing.T) {
	f := newAppleContinuationFixture(t)
	oldSecret := testContinuationSecret(0x51)
	status, denied := f.dispatchWithoutProtocol(t, map[string]string{
		"bundleId": testBundleIOS, "productId": testAppleProduct,
		"appInstanceId": testContinuationInstanceA, "continuationSecret": oldSecret,
		"armRequestId": "old-client-initial",
	})
	if status != http.StatusForbidden || denied.Error != appleRefusalCapabilityCode || f.countAttempts(t) != 0 || f.countAuthorities(t) != 0 {
		t.Fatalf("old client created durable billing identity: status=%d body=%+v attempts=%d authorities=%d", status, denied, f.countAttempts(t), f.countAuthorities(t))
	}

	attemptID, secretA := f.arm(t, testContinuationInstanceA)
	if status, body := f.report(t, attemptID, testContinuationInstanceA, secretA, appleOutcomeUserCancelled); status != http.StatusOK || body["resumable"] != true {
		t.Fatalf("cancel current attempt: status=%d body=%v", status, body)
	}
	status, denied = f.dispatchWithoutProtocol(t, map[string]string{
		"bundleId": testBundleIOS, "productId": testAppleProduct,
		"appInstanceId":      testContinuationInstanceB,
		"continuationSecret": testContinuationSecret(0x52),
		"armRequestId":       "old-client-takeover",
	})
	if status != http.StatusForbidden || denied.Error != appleRefusalCapabilityCode {
		t.Fatalf("old client took over: status=%d body=%+v", status, denied)
	}
	if _, continuation, _ := f.attemptState(t, attemptID); continuation != appleContinuationCancelled {
		t.Fatalf("old client moved the cancelled attempt: %q", continuation)
	}
	if f.countAttempts(t) != 1 || f.countSubjects(t) != 1 || f.countAuthorities(t) != 1 {
		t.Fatalf("old-client refusals created identities: attempts=%d subjects=%d authorities=%d", f.countAttempts(t), f.countSubjects(t), f.countAuthorities(t))
	}
}

func TestStoreReplayRejectsAnUnknownContinuationProtocol(t *testing.T) {
	store, authority, ctx := newArmFixture(t)
	secret := testContinuationSecret(0x53)
	armed, err := store.ArmAppleBillingPurchase(ctx, authority, AppleDispatchRequest{
		ProductID: "plus.monthly", CandidateToken: testArmToken,
		ContinuationProtocol: appleContinuationProtocolAttemptIDV2,
		AppInstanceID:        testContinuationInstanceA, ContinuationSecret: secret,
		ArmRequestID: "arm-replay-protocol", Now: 101,
	})
	if err != nil || !armed.Armed {
		t.Fatalf("arm=%+v err=%v", armed, err)
	}
	if out, replayed, err := store.ReplayAppleBillingPurchase(ctx, authority, AppleDispatchRequest{
		ProductID: "plus.monthly", ContinuationProtocol: "attempt-id-v999",
		AppInstanceID: testContinuationInstanceA, ContinuationSecret: secret,
		ArmRequestID: "arm-replay-protocol",
	}); err != nil || replayed {
		t.Fatalf("unknown protocol replayed: out=%+v replayed=%v err=%v", out, replayed, err)
	}
}

// Old released clients are strict one-shot clients and this batch does not
// change them. This is the server-first compatibility the design depends on.
func TestLegacyAppleDispatchRetryStaysStrictOneShot(t *testing.T) {
	f := newAppleContinuationFixture(t)
	status, first := f.dispatch(t, map[string]string{"bundleId": testBundleIOS, "productId": testAppleProduct})
	if status != http.StatusOK || first.AttemptID == "" {
		t.Fatalf("legacy dispatch: status=%d body=%+v", status, first)
	}
	if first.ContinuationSecret != "" {
		t.Fatal("a legacy dispatch was issued a continuation secret")
	}
	if _, continuation, _ := f.attemptState(t, first.AttemptID); continuation != appleContinuationLegacy {
		t.Fatalf("legacy attempt bound a capability: %q", continuation)
	}
	status, retry := f.dispatch(t, map[string]string{"bundleId": testBundleIOS, "productId": testAppleProduct})
	if status != http.StatusConflict || retry.Error != appleRefusalReconcile {
		t.Fatalf("legacy retry: status=%d body=%+v", status, retry)
	}
	// And a new-protocol client cannot adopt an attempt armed before the protocol
	// existed: there is no capability to present or to check.
	status, adopt := f.dispatch(t, map[string]string{
		"bundleId": testBundleIOS, "productId": testAppleProduct,
		"appInstanceId": testContinuationInstanceA, "armRequestId": "arm-adopt",
	})
	if status != http.StatusConflict || adopt.Error != appleRefusalReconcile {
		t.Fatalf("capability adoption of a legacy attempt: status=%d body=%+v", status, adopt)
	}
}

// ---------------------------------------------------------------------------
// The mandatory adversarial schedule: two instances, two Apple IDs equivalent
// ---------------------------------------------------------------------------

// Instance A arms. Before it reports cancellation, instance B — the
// server-visible equivalent of a second device signed into a DIFFERENT Apple ID
// — must not receive concurrent charge authority by any route. After A's exact
// current arm is cancelled, B may atomically take over. Two distinct valid paid
// subscriptions can still produce exactly one entitlement.
func TestSecondInstanceWaitsForCancellationAndASecondPaidSubscriptionIsRefused(t *testing.T) {
	f := newAppleContinuationFixture(t)
	attemptID, secretA := f.arm(t, testContinuationInstanceA)
	secretB := testContinuationSecret(0x43)

	// Every way instance B can ask while A's sheet is still open is refused.
	for _, tc := range []struct {
		name       string
		body       map[string]string
		wantStatus int
		wantError  string
	}{
		{"account-only legacy retry", map[string]string{
			"bundleId": testBundleIOS, "productId": testAppleProduct,
		}, http.StatusConflict, appleRefusalReconcile},
		{"own instance, no secret", map[string]string{
			"bundleId": testBundleIOS, "productId": testAppleProduct,
			"appInstanceId": testContinuationInstanceB, "armRequestId": "resume-B0",
		}, http.StatusForbidden, appleRefusalCapabilityCode},
		{"own persisted capability", map[string]string{
			"bundleId": testBundleIOS, "productId": testAppleProduct,
			"appInstanceId": testContinuationInstanceB, "continuationSecret": secretB,
			"armRequestId": "resume-B",
		}, http.StatusForbidden, appleRefusalCapabilityCode},
		{"stolen secret, own instance", map[string]string{
			"bundleId": testBundleIOS, "productId": testAppleProduct,
			"appInstanceId": testContinuationInstanceB, "continuationSecret": secretA,
			"armRequestId": "resume-stolen-secret",
		}, http.StatusForbidden, appleRefusalCapabilityCode},
		{"impersonating instance A with a guessed secret", map[string]string{
			"bundleId": testBundleIOS, "productId": testAppleProduct,
			"appInstanceId": testContinuationInstanceA, "continuationSecret": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
			"armRequestId": "resume-B2",
		}, http.StatusForbidden, appleRefusalCapabilityCode},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, got := f.dispatch(t, tc.body)
			if status != tc.wantStatus || got.Error != tc.wantError {
				t.Fatalf("status=%d body=%+v want %d/%s", status, got, tc.wantStatus, tc.wantError)
			}
			if got.AttemptID != "" || got.ContinuationSecret != "" || got.AppAccountToken != "" {
				t.Fatalf("a refused caller received purchase identity: %+v", got)
			}
		})
	}
	// The attempt is untouched by any of it and remains armed under A.
	if _, continuation, outcome := f.attemptState(t, attemptID); continuation != appleContinuationArmed || outcome != "" {
		t.Fatalf("instance B moved the attempt: continuation=%q outcome=%q", continuation, outcome)
	}
	if n := f.countAttempts(t); n != 1 {
		t.Fatalf("instance B created attempts: %d", n)
	}

	if status, body := f.report(t, attemptID, testContinuationInstanceA, secretA, appleOutcomeUserCancelled); status != http.StatusOK || body["resumable"] != true {
		t.Fatalf("instance A cancel report: status=%d body=%v", status, body)
	}
	const armB = "resume-B-after-cancel"
	if status, body := f.dispatch(t, map[string]string{
		"bundleId": testBundleIOS, "productId": testAppleProduct,
		"appInstanceId": testContinuationInstanceB, "continuationSecret": secretB,
		"armRequestId": armB,
	}); status != http.StatusOK || body.AttemptID != attemptID {
		t.Fatalf("instance B takeover: status=%d body=%+v", status, body)
	}
	if status, body := f.reportArm(t, attemptID, testContinuationInstanceB, secretB, armB, appleOutcomeSuccess); status != http.StatusOK || body["resumable"] != false {
		t.Fatalf("instance B success report: status=%d body=%v", status, body)
	}

	// Now inject two DISTINCT valid paid subscriptions for this one account.
	var dispatchToken string
	if err := f.store.db.QueryRow(`SELECT apple_account_token FROM billing_purchase_attempts WHERE id=?`, attemptID).Scan(&dispatchToken); err != nil {
		t.Fatal(err)
	}
	first, _ := f.mustAccept(t, f.chain.sign(t, applePayload(func(p map[string]any) {
		p["appAccountToken"] = dispatchToken
		p["productId"] = testAppleProduct
		p["transactionId"] = "2000000000000001"
		p["originalTransactionId"] = "2000000000000001"
	})))
	if !first.Applied || first.PlanID != "pro" {
		t.Fatalf("first paid subscription did not grant: %+v", first)
	}
	// It also converged the dispatch it belonged to.
	if state, _, _ := f.attemptState(t, attemptID); state != "resolved" {
		t.Fatalf("first accepted transaction did not resolve its dispatch: %q", state)
	}

	source, _, err := f.store.GetSubscriptionSource(context.Background(), f.userID, ProviderApple)
	if err != nil {
		t.Fatal(err)
	}
	f.mustReject(t, f.chain.sign(t, applePayload(func(p map[string]any) {
		p["appAccountToken"] = dispatchToken
		p["productId"] = testAppleProduct
		p["transactionId"] = "2000000000000099"
		p["originalTransactionId"] = "2000000000000099"
	})), http.StatusConflict, "apple_subscription_conflict")

	// Entitlement unchanged, and the second subscription is left UNFINISHED: a
	// 409 is not a decoded server acceptance, so no client may finish it.
	after, ok, err := f.store.GetSubscriptionSource(context.Background(), f.userID, ProviderApple)
	if err != nil || !ok {
		t.Fatalf("source after conflict: ok=%v err=%v", ok, err)
	}
	if after.ExternalID != source.ExternalID || after.PlanID != source.PlanID || after.PeriodEnd != source.PeriodEnd {
		t.Fatalf("the second subscription changed entitlement: %+v -> %+v", source, after)
	}

	// Durable, non-secret incident evidence exists. It is NOT a claim that
	// Relayium reversed or prevented Apple's charge.
	incidents, err := f.store.AppleBillingIncidents(context.Background(), f.userID)
	if err != nil {
		t.Fatal(err)
	}
	if len(incidents) != 1 {
		t.Fatalf("want exactly one incident, got %d (%+v)", len(incidents), incidents)
	}
	inc := incidents[0]
	if inc.Kind != appleIncidentSecondSubscription || inc.BundleID != testBundleIOS ||
		inc.IncomingExternalID == "" || inc.ExistingExternalID == "" ||
		inc.IncomingExternalID == inc.ExistingExternalID {
		t.Fatalf("incident does not identify two distinct subscriptions: %+v", inc)
	}
	if strings.Contains(fmt.Sprint(inc), secretA) || strings.Contains(fmt.Sprint(inc), secretB) || strings.Contains(fmt.Sprint(inc), dispatchToken) {
		t.Fatalf("incident evidence carries a secret or a raw attribution token: %+v", inc)
	}
	// A redelivery is counted, not duplicated.
	f.mustReject(t, f.chain.sign(t, applePayload(func(p map[string]any) {
		p["appAccountToken"] = dispatchToken
		p["productId"] = testAppleProduct
		p["transactionId"] = "2000000000000099"
		p["originalTransactionId"] = "2000000000000099"
	})), http.StatusConflict, "apple_subscription_conflict")
	again, err := f.store.AppleBillingIncidents(context.Background(), f.userID)
	if err != nil || len(again) != 1 || again[0].Observations != 2 {
		t.Fatalf("incident redelivery: %+v err=%v", again, err)
	}
}

// ---------------------------------------------------------------------------
// Only an explicit cancellation is resumable
// ---------------------------------------------------------------------------

// Ask-to-Buy, an error and an unknown result may all still become a real
// charge. A valid capability does not make them resumable, and neither does
// reporting nothing at all.
func TestOnlyExplicitCancellationIsResumableEvenWithAValidCapability(t *testing.T) {
	for _, outcome := range []string{appleOutcomePending, appleOutcomeFailed, appleOutcomeSuccess} {
		t.Run(outcome, func(t *testing.T) {
			f := newAppleContinuationFixture(t)
			attemptID, secret := f.arm(t, testContinuationInstanceA)
			status, body := f.report(t, attemptID, testContinuationInstanceA, secret, outcome)
			if status != http.StatusOK || body["resumable"] != false {
				t.Fatalf("%s report: status=%d body=%v", outcome, status, body)
			}
			if _, continuation, got := f.attemptState(t, attemptID); continuation != appleContinuationLocked || got != outcome {
				t.Fatalf("%s did not lock: continuation=%q outcome=%q", outcome, continuation, got)
			}
			status, refused := f.dispatch(t, map[string]string{
				"bundleId": testBundleIOS, "productId": testAppleProduct,
				"appInstanceId": testContinuationInstanceA, "continuationSecret": secret,
				"armRequestId": "resume-locked",
			})
			if status != http.StatusConflict || refused.Error != appleRefusalReconcile {
				t.Fatalf("locked attempt was resumable: status=%d body=%+v", status, refused)
			}
			status, crossInstall := f.dispatch(t, map[string]string{
				"bundleId": testBundleIOS, "productId": testAppleProduct,
				"appInstanceId":      testContinuationInstanceB,
				"continuationSecret": testContinuationSecret(0x44),
				"armRequestId":       "cross-install-locked",
			})
			if status != http.StatusForbidden || crossInstall.Error != appleRefusalCapabilityCode {
				t.Fatalf("another installation took over a locked attempt: status=%d body=%+v", status, crossInstall)
			}
			// Locked is TERMINAL: a later cancellation report cannot unlock it.
			status, relock := f.report(t, attemptID, testContinuationInstanceA, secret, appleOutcomeUserCancelled)
			if status != http.StatusOK || relock["resumable"] != false {
				t.Fatalf("late cancel unlocked a locked attempt: status=%d body=%v", status, relock)
			}
			if _, continuation, _ := f.attemptState(t, attemptID); continuation != appleContinuationLocked {
				t.Fatalf("late cancel moved a locked attempt: %q", continuation)
			}
		})
	}
}

// A crash, process death or lost network reports nothing. Silence is not a
// cancellation, so the sheet stays authorized and unresumable.
func TestNoOutcomeReportLeavesTheAttemptUnresumable(t *testing.T) {
	f := newAppleContinuationFixture(t)
	attemptID, secret := f.arm(t, testContinuationInstanceA)
	status, refused := f.dispatch(t, map[string]string{
		"bundleId": testBundleIOS, "productId": testAppleProduct,
		"appInstanceId": testContinuationInstanceA, "continuationSecret": secret,
		"armRequestId": "resume-silent",
	})
	if status != http.StatusConflict || refused.Error != appleRefusalOutcome {
		t.Fatalf("silence was treated as a cancellation: status=%d body=%+v", status, refused)
	}
	// The refusal must not describe a zero-charge attempt as a subscription.
	if strings.Contains(refused.Error, "subscription") {
		t.Fatalf("refusal vocabulary claims a subscription: %q", refused.Error)
	}
	if _, continuation, outcome := f.attemptState(t, attemptID); continuation != appleContinuationArmed || outcome != "" {
		t.Fatalf("refused resume moved the attempt: continuation=%q outcome=%q", continuation, outcome)
	}
}

// ---------------------------------------------------------------------------
// Idempotency, replay and concurrency
// ---------------------------------------------------------------------------

// A lost successful resume response must be readable back without arming twice,
// and a DIFFERENT request id against an already-armed attempt must not be a
// second sheet.
func TestResumeIsIdempotentForALostResponseAndRefusesASecondArm(t *testing.T) {
	f := newAppleContinuationFixture(t)
	attemptID, secret := f.arm(t, testContinuationInstanceA)
	f.report(t, attemptID, testContinuationInstanceA, secret, appleOutcomeUserCancelled)

	resume := map[string]string{
		"bundleId": testBundleIOS, "productId": testAppleProduct,
		"appInstanceId": testContinuationInstanceA, "continuationSecret": secret,
		"armRequestId": "resume-lost",
	}
	status, first := f.dispatch(t, resume)
	if status != http.StatusOK || first.AttemptID != attemptID {
		t.Fatalf("first resume: status=%d body=%+v", status, first)
	}
	var resumeCount int64
	if err := f.store.db.QueryRow(`SELECT resume_count FROM billing_purchase_attempts WHERE id=?`, attemptID).Scan(&resumeCount); err != nil {
		t.Fatal(err)
	}
	status, replay := f.dispatch(t, resume)
	if status != http.StatusOK || replay.AttemptID != attemptID || replay.AppAccountToken != first.AppAccountToken {
		t.Fatalf("lost-response replay: status=%d body=%+v", status, replay)
	}
	if replay.ContinuationSecret != "" {
		t.Fatal("replay re-issued the one-time secret")
	}
	var after int64
	if err := f.store.db.QueryRow(`SELECT resume_count FROM billing_purchase_attempts WHERE id=?`, attemptID).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != resumeCount {
		t.Fatalf("replay armed a second time: resume_count %d -> %d", resumeCount, after)
	}

	resume["armRequestId"] = "resume-second"
	status, second := f.dispatch(t, resume)
	if status != http.StatusConflict || second.Error != appleRefusalOutcome {
		t.Fatalf("a second logical arm was authorized: status=%d body=%+v", status, second)
	}
}

// An arm request id arms exactly once. Replaying a spent id after a later
// cancellation must fail closed rather than silently re-arm.
func TestArmRequestIDIsSpentExactlyOnce(t *testing.T) {
	f := newAppleContinuationFixture(t)
	attemptID, secret := f.arm(t, testContinuationInstanceA)
	f.report(t, attemptID, testContinuationInstanceA, secret, appleOutcomeUserCancelled)
	resume := map[string]string{
		"bundleId": testBundleIOS, "productId": testAppleProduct,
		"appInstanceId": testContinuationInstanceA, "continuationSecret": secret,
		"armRequestId": "resume-once",
	}
	if status, _ := f.dispatch(t, resume); status != http.StatusOK {
		t.Fatalf("first resume status=%d", status)
	}
	// The resume made "resume-once" the CURRENT arm, so the sheet it opened
	// reports under that name -- not under the initial arm's.
	if got := f.currentArmID(t, attemptID); got != "resume-once" {
		t.Fatalf("resume did not become the current arm: %q", got)
	}
	f.reportArm(t, attemptID, testContinuationInstanceA, secret, "resume-once", appleOutcomeUserCancelled)
	status, replayed := f.dispatch(t, resume)
	if status != http.StatusForbidden || replayed.Error != appleRefusalCapabilityCode {
		t.Fatalf("a spent arm id armed again: status=%d body=%+v", status, replayed)
	}
	if _, continuation, _ := f.attemptState(t, attemptID); continuation != appleContinuationCancelled {
		t.Fatalf("a spent arm id moved the attempt: %q", continuation)
	}
}

// Two honest sheets can never be concurrently authorized.
func TestConcurrentResumeAuthorizesExactlyOneSheet(t *testing.T) {
	f := newAppleContinuationFixture(t)
	attemptID, secret := f.arm(t, testContinuationInstanceA)
	f.report(t, attemptID, testContinuationInstanceA, secret, appleOutcomeUserCancelled)

	start := make(chan struct{})
	results := make(chan int, 2)
	var wg sync.WaitGroup
	for i := range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			status, _ := f.dispatch(t, map[string]string{
				"bundleId": testBundleIOS, "productId": testAppleProduct,
				"appInstanceId": testContinuationInstanceA, "continuationSecret": secret,
				"armRequestId": fmt.Sprintf("resume-race-%d", i),
			})
			results <- status
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	counts := map[int]int{}
	for status := range results {
		counts[status]++
	}
	if counts[http.StatusOK] != 1 {
		t.Fatalf("want exactly one authorized sheet, got %v", counts)
	}
	var resumeCount int64
	if err := f.store.db.QueryRow(`SELECT resume_count FROM billing_purchase_attempts WHERE id=?`, attemptID).Scan(&resumeCount); err != nil {
		t.Fatal(err)
	}
	if resumeCount != 1 {
		t.Fatalf("concurrent resume armed %d times", resumeCount)
	}
}

// Different installations racing to take over the same explicit cancellation
// are a stronger schedule than two arm ids under one capability: the winner
// replaces both the arm and the capability binding. Exactly one complete tuple
// may commit, every loser must receive no purchase identity, and the old
// installation's delayed report must remain inert afterward.
func TestConcurrentCrossInstallationTakeoverAuthorizesExactlyOneSheet(t *testing.T) {
	f := newAppleContinuationFixture(t)
	attemptID, oldSecret := f.arm(t, testContinuationInstanceA)
	if status, _ := f.report(t, attemptID, testContinuationInstanceA, oldSecret, appleOutcomeUserCancelled); status != http.StatusOK {
		t.Fatalf("cancel report: status=%d", status)
	}

	type takeover struct {
		instance, secret, arm string
		status                int
		body                  dispatchBody
	}
	results := make(chan takeover, 4)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			candidate := takeover{
				instance: fmt.Sprintf("takeover-instance-%d", i),
				secret:   testContinuationSecret(byte(0x50 + i)),
				arm:      fmt.Sprintf("takeover-arm-%d", i),
			}
			<-start
			candidate.status, candidate.body = f.dispatch(t, map[string]string{
				"bundleId": testBundleIOS, "productId": testAppleProduct,
				"appInstanceId": candidate.instance, "continuationSecret": candidate.secret,
				"armRequestId": candidate.arm,
			})
			results <- candidate
		}()
	}
	close(start)
	wg.Wait()
	close(results)

	var winner takeover
	wins := 0
	for candidate := range results {
		if candidate.status == http.StatusOK {
			wins++
			winner = candidate
			if candidate.body.AttemptID != attemptID || candidate.body.AppAccountToken == "" {
				t.Fatalf("winner received wrong identity: %+v", candidate)
			}
			continue
		}
		if candidate.status != http.StatusForbidden || candidate.body.Error != appleRefusalCapabilityCode {
			t.Fatalf("loser was not uniformly refused: %+v", candidate)
		}
		if candidate.body.AttemptID != "" || candidate.body.AppAccountToken != "" || candidate.body.ContinuationSecret != "" {
			t.Fatalf("loser received purchase identity: %+v", candidate)
		}
	}
	if wins != 1 {
		t.Fatalf("cross-install takeover authorized %d sheets, want 1", wins)
	}
	var instance, arm string
	var verifier []byte
	if err := f.store.db.QueryRow(`SELECT app_instance_id,continuation_verifier,arm_request_id FROM billing_purchase_attempts WHERE id=?`, attemptID).
		Scan(&instance, &verifier, &arm); err != nil {
		t.Fatal(err)
	}
	if instance != winner.instance || arm != winner.arm || !bytes.Equal(verifier, appleContinuationVerifier(winner.secret)) {
		t.Fatalf("persisted tuple is not the winner: instance=%q arm=%q verifierMatches=%v winnerInstance=%q winnerArm=%q", instance, arm, bytes.Equal(verifier, appleContinuationVerifier(winner.secret)), winner.instance, winner.arm)
	}
	if got := f.resumeCount(t, attemptID); got != 1 {
		t.Fatalf("cross-install race armed %d times", got)
	}
	if got := f.armHistory(t, attemptID); len(got) != 2 {
		t.Fatalf("cross-install losers burned arm identities: %v", got)
	}
	if status, _ := f.report(t, attemptID, testContinuationInstanceA, oldSecret, appleOutcomeUserCancelled); status != http.StatusForbidden {
		t.Fatalf("old installation moved the winner's sheet: status=%d", status)
	}
}

// Two new-protocol dispatches racing must still produce exactly one attempt and
// exactly one secret.
func TestConcurrentInitialArmEmitsExactlyOneAttemptAndOneSecret(t *testing.T) {
	f := newAppleContinuationFixture(t)
	start := make(chan struct{})
	type outcome struct {
		status int
		body   dispatchBody
	}
	results := make(chan outcome, 2)
	var wg sync.WaitGroup
	for i := range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			status, body := f.dispatch(t, map[string]string{
				"bundleId": testBundleIOS, "productId": testAppleProduct,
				"appInstanceId": fmt.Sprintf("instance-race-%d", i), "armRequestId": fmt.Sprintf("arm-race-%d", i),
			})
			results <- outcome{status, body}
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	var armed, secrets int
	for got := range results {
		if got.status == http.StatusOK {
			armed++
		}
		if got.body.ContinuationSecret != "" {
			secrets++
		}
	}
	if armed != 1 || secrets != 1 {
		t.Fatalf("concurrent arm: armed=%d secrets=%d", armed, secrets)
	}
	if n := f.countAttempts(t); n != 1 {
		t.Fatalf("concurrent arm created %d attempts", n)
	}
}

// ---------------------------------------------------------------------------
// The secret itself
// ---------------------------------------------------------------------------

// The raw secret exists in exactly one response and nowhere at rest.
func TestContinuationSecretIsNeverStoredOrLoggedInTheClear(t *testing.T) {
	var logs bytes.Buffer
	previous := log.Writer()
	log.SetOutput(io.MultiWriter(&logs, os.Stderr))
	t.Cleanup(func() { log.SetOutput(previous) })

	f := newAppleContinuationFixture(t)
	attemptID, secret := f.arm(t, testContinuationInstanceA)
	f.report(t, attemptID, testContinuationInstanceA, secret, appleOutcomeUserCancelled)
	f.dispatch(t, map[string]string{
		"bundleId": testBundleIOS, "productId": testAppleProduct,
		"appInstanceId": testContinuationInstanceA, "continuationSecret": secret,
		"armRequestId": "resume-secrecy",
	})

	// What is at rest is the digest, and only the digest.
	var verifier []byte
	if err := f.store.db.QueryRow(`SELECT continuation_verifier FROM billing_purchase_attempts WHERE id=?`, attemptID).Scan(&verifier); err != nil {
		t.Fatal(err)
	}
	want := sha256.Sum256([]byte(secret))
	if !bytes.Equal(verifier, want[:]) {
		t.Fatalf("stored verifier is not sha256(secret): %x", verifier)
	}
	assertAbsentFromEveryTable(t, f.store, secret)
	if strings.Contains(logs.String(), secret) {
		t.Fatal("the continuation secret reached the log")
	}
}

// findValueAtRest sweeps every table in the database for a value and reports
// where it was found. Separated from the assertion so the sweep itself can be
// proved capable of failing.
func findValueAtRest(t *testing.T, store *SQLiteStore, needle string) (string, int, bool) {
	t.Helper()
	if needle == "" {
		t.Fatal("refusing to sweep for an empty needle")
	}
	rows, err := store.db.Query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
	if err != nil {
		t.Fatal(err)
	}
	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		tables = append(tables, name)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	for _, table := range tables {
		data, err := store.db.Query(`SELECT * FROM "` + table + `"`)
		if err != nil {
			t.Fatalf("scan %s: %v", table, err)
		}
		cols, err := data.Columns()
		if err != nil {
			data.Close()
			t.Fatal(err)
		}
		for data.Next() {
			cells := make([]any, len(cols))
			for i := range cells {
				cells[i] = new(any)
			}
			if err := data.Scan(cells...); err != nil {
				data.Close()
				t.Fatal(err)
			}
			for i, cell := range cells {
				if strings.Contains(fmt.Sprint(*(cell.(*any))), needle) {
					data.Close()
					return table + "." + cols[i], len(tables), true
				}
			}
		}
		data.Close()
		if err := data.Err(); err != nil {
			t.Fatal(err)
		}
	}
	return "", len(tables), false
}

// assertAbsentFromEveryTable requires that a value was never persisted anywhere
// -- not in the attempt row, not in an audit trail, not in an incident record.
func assertAbsentFromEveryTable(t *testing.T, store *SQLiteStore, needle string) {
	t.Helper()
	where, swept, found := findValueAtRest(t, store, needle)
	if swept == 0 {
		t.Fatal("swept no tables; the sweep would be vacuous")
	}
	if found {
		t.Fatalf("value found at rest in %s", where)
	}
}

// The sweep above must be capable of failing. Without this control a typo in the
// table query would make every secrecy assertion vacuously green.
func TestTheAtRestSweepCanActuallyFail(t *testing.T) {
	f := newAppleContinuationFixture(t)
	attemptID, _ := f.arm(t, testContinuationInstanceA)
	where, swept, found := findValueAtRest(t, f.store, attemptID)
	if !found {
		t.Fatalf("the at-rest sweep did not detect a value that IS stored (swept %d tables)", swept)
	}
	if !strings.HasPrefix(where, "billing_purchase_attempts.") {
		t.Fatalf("the sweep found the attempt id somewhere unexpected: %s", where)
	}
	if swept < 10 {
		t.Fatalf("the sweep only covered %d tables; it is too narrow to be evidence", swept)
	}
}

// The verifier is compared in constant time and never used to locate a row,
// so the comparison is not an oracle and neither is the lookup.
func TestContinuationVerifierIsComparedInConstantTimeAndNeverQueried(t *testing.T) {
	source, err := os.ReadFile("billing_apple_attempt.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(source)
	if !strings.Contains(body, "subtle.ConstantTimeCompare(appleContinuationVerifier(secret), a.ContinuationVerifier)") {
		t.Fatal("the continuation verifier is no longer compared with crypto/subtle")
	}
	// The verifier is legitimately written in INSERT/UPDATE SET clauses. Inspect
	// only the predicate half of every raw SQL literal so adding a required
	// rotation cannot weaken this guard or force formatting tricks to satisfy it.
	for _, sqlText := range strings.Split(body, "`") {
		whereAt := strings.Index(sqlText, "WHERE")
		if whereAt < 0 {
			continue
		}
		if strings.Contains(sqlText[whereAt:], "continuation_verifier") {
			t.Fatalf("the verifier is used as a SQL predicate, which is neither constant-time nor free of an enumeration oracle: %s", sqlText[whereAt:])
		}
	}
}

// ---------------------------------------------------------------------------
// Resolution: the dispatch must not be stranded by a fact that proves it
// ---------------------------------------------------------------------------

// armAndBuy arms a dispatch and returns its attempt id and attribution token.
func (f *appleContinuationFixture) armAndBuy(t *testing.T) (string, string) {
	t.Helper()
	attemptID, _ := f.arm(t, testContinuationInstanceA)
	var token string
	if err := f.store.db.QueryRow(`SELECT apple_account_token FROM billing_purchase_attempts WHERE id=?`, attemptID).Scan(&token); err != nil {
		t.Fatal(err)
	}
	return attemptID, token
}

// armAndBuyWithSecret arms a dispatch and returns its attempt id and the
// one-time capability secret.
func (f *appleContinuationFixture) armAndBuyWithSecret(t *testing.T) (string, string) {
	t.Helper()
	return f.arm(t, testContinuationInstanceA)
}

// A RESTORE AFTER A RENEWAL carries transactionReason=RENEWAL. It used to apply
// the entitlement and leave the dispatch pending forever.
func TestRestoreAfterRenewalResolvesTheDispatchItBelongsTo(t *testing.T) {
	f := newAppleContinuationFixture(t)
	attemptID, token := f.armAndBuy(t)
	result, _ := f.mustAccept(t, f.chain.sign(t, applePayload(func(p map[string]any) {
		p["appAccountToken"] = token
		p["productId"] = testAppleProduct
		p["transactionReason"] = "RENEWAL"
	})))
	if !result.Applied || result.DispatchPending || !result.DispatchResolved {
		t.Fatalf("restore after renewal: %+v", result)
	}
	if state, _, _ := f.attemptState(t, attemptID); state != "resolved" {
		t.Fatalf("restore after renewal left the dispatch pending: %q", state)
	}
}

// An ALREADY-ACCOUNTED duplicate submission applies nothing — and "nothing left
// to apply" is exactly the evidence that this account already owns it.
func TestAlreadyAccountedDuplicateSubmissionStillResolvesTheDispatch(t *testing.T) {
	f := newAppleContinuationFixture(t)
	attemptID, token := f.armAndBuy(t)
	jws := f.chain.sign(t, applePayload(func(p map[string]any) {
		p["appAccountToken"] = token
		p["productId"] = testAppleProduct
	}))
	first, _ := f.mustAccept(t, jws)
	if !first.Applied {
		t.Fatalf("first submission did not apply: %+v", first)
	}
	if !first.DispatchResolved || first.DispatchResolvedAttemptID != attemptID {
		t.Fatalf("first submission omitted resolved attempt identity: %+v", first)
	}
	if state, _, _ := f.attemptState(t, attemptID); state != "resolved" {
		t.Fatalf("first submission left the dispatch pending: %q", state)
	}
	// The duplicate is idempotent and must not resurrect or double-grant.
	second, _ := f.mustAccept(t, jws)
	if second.DispatchPending || !second.DispatchResolved || second.DispatchResolvedAttemptID != attemptID {
		t.Fatalf("duplicate submission lost sticky resolution: %+v", second)
	}
	if n := f.countAttempts(t); n != 1 {
		t.Fatalf("duplicate submission created attempts: %d", n)
	}
}

// The stale-accounted convergence case in its own right: an OPEN dispatch that
// receives an already-recorded, strictly older fact carrying its OWN token and
// product must converge rather than stay stranded forever. Driven at the store
// level because reaching a second dispatch generation through HTTP would first
// be refused as a next-renewal change, which is a different rule.
func TestStaleAccountedSubmissionConvergesAnOpenDispatch(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "stale-convergence@example.test", "")
	firstToken := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	authority, err := store.AcquireBillingAuthority(ctx, BillingAuthorityRequest{
		UserID: u.ID, Provider: ProviderApple, ExternalScope: testBundleIOS,
		AppleAccountToken: firstToken, Now: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, created, err := store.DispatchAppleBillingPurchase(ctx, authority, "plus.monthly", firstToken, 101); err != nil || !created {
		t.Fatalf("first dispatch created=%v err=%v", created, err)
	}
	purchase := SourceEvent{
		UserID: u.ID, Provider: ProviderApple, PlanID: "plus", Status: "active", Cycle: "monthly",
		PeriodEnd: 1000, ExternalID: "production:original", ExternalScope: testBundleIOS,
		BillingProductID: "plus.monthly", EventAt: 200, Now: 102,
	}
	if result, err := store.ApplyAuthorizedAppleSource(ctx, purchase, firstToken, appleEnvProduction, purchase.BillingProductID); err != nil || !result.Applied || !result.PurchaseAttemptResolved {
		t.Fatalf("first purchase result=%+v err=%v", result, err)
	}
	// The subscription then renews, advancing the recorded provider clock.
	renewal := purchase
	renewal.EventAt, renewal.Now, renewal.PeriodEnd = 300, 103, 2000
	if result, err := store.ApplyAuthorizedAppleSource(ctx, renewal, firstToken, appleEnvProduction, renewal.BillingProductID); err != nil || !result.Applied {
		t.Fatalf("renewal result=%+v err=%v", result, err)
	}

	// A second dispatch generation, for the same product, with its own token.
	authority, _, _ = store.BillingAuthority(ctx, u.ID)
	secondToken := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	second, created, err := store.DispatchAppleBillingPurchase(ctx, authority, "plus.monthly", secondToken, 104)
	if err != nil || !created {
		t.Fatalf("second dispatch created=%v err=%v", created, err)
	}
	// A STRICTLY OLDER fact arrives carrying the SECOND dispatch's own token:
	// Apple attributed it to that dispatch, and there is nothing left to apply
	// because this account already owns the subscription.
	stale := purchase
	stale.Now = 105
	result, err := store.ApplyAuthorizedAppleSource(ctx, stale, secondToken, appleEnvProduction, stale.BillingProductID)
	if err != nil {
		t.Fatal(err)
	}
	if result.Applied {
		t.Fatalf("a strictly older fact applied: %+v", result)
	}
	if !result.PurchaseAttemptResolved || result.PurchaseAttemptPending {
		t.Fatalf("stale but converged fact left the dispatch pending: %+v", result)
	}
	var state string
	if err := store.db.QueryRowContext(ctx, `SELECT state FROM billing_purchase_attempts WHERE id=?`, second.ID).Scan(&state); err != nil || state != "resolved" {
		t.Fatalf("stale-accounted convergence: state=%q err=%v", state, err)
	}
	// The entitlement itself is untouched by the stale fact.
	if src, ok, err := store.GetSubscriptionSource(ctx, u.ID, ProviderApple); err != nil || !ok || src.PeriodEnd != 2000 {
		t.Fatalf("a stale fact moved entitlement: source=%+v ok=%v err=%v", src, ok, err)
	}
}

// A LATE verified transaction after a cancellation report is still attributed:
// the client said it cancelled, Apple says otherwise, and Apple is the one that
// signs. The attribution subject is retained forever precisely for this.
func TestLateVerifiedTransactionOverridesACancellationReport(t *testing.T) {
	f := newAppleContinuationFixture(t)
	attemptID, secret := f.armAndBuyWithSecret(t)
	// The client reports a cancellation. Apple then delivers a signed
	// transaction anyway -- a same-device Apple-ID switch, a race, or simply a
	// client that was wrong. Apple is the one that signs.
	if status, body := f.report(t, attemptID, testContinuationInstanceA, secret, appleOutcomeUserCancelled); status != http.StatusOK || body["resumable"] != true {
		t.Fatalf("cancel report: status=%d body=%v", status, body)
	}
	var token string
	if err := f.store.db.QueryRow(`SELECT apple_account_token FROM billing_purchase_attempts WHERE id=?`, attemptID).Scan(&token); err != nil {
		t.Fatal(err)
	}
	result, _ := f.mustAccept(t, f.chain.sign(t, applePayload(func(p map[string]any) {
		p["appAccountToken"] = token
		p["productId"] = testAppleProduct
	})))
	if !result.Applied || result.PlanID != "pro" {
		t.Fatalf("late transaction did not grant: %+v", result)
	}
	if state, _, _ := f.attemptState(t, attemptID); state != "resolved" {
		t.Fatalf("late transaction did not resolve: %q", state)
	}
}

// A NOTIFICATION-FIRST delivery — Apple routinely beats the purchasing client's
// own round trip — used to apply the entitlement and leave the dispatch pending
// forever, because the notification path never set the dispatch fields at all.
func TestNotificationFirstDeliveryResolvesTheDispatch(t *testing.T) {
	f := newAppleContinuationFixture(t)
	attemptID, token := f.armAndBuy(t)
	tx := VerifiedAppleTransaction{
		BundleID: testBundleIOS, ProductID: testAppleProduct,
		OriginalTransactionID: "4000000000000001", Environment: appleEnvProduction,
		AppAccountToken: token, TransactionReason: "PURCHASE",
		PurchaseDateMS: 300_000, ExpiresDateMS: 400_000,
	}
	status, state, reason := f.svc.applyAppleNotification(context.Background(), VerifiedAppleNotification{
		UUID: appleNotifyUUID(71), Type: "SUBSCRIBED", Supported: true,
		HasTransaction: true, Transaction: tx,
	}, time.Unix(300, 0))
	if status != http.StatusOK || state != appleNotificationApplied {
		t.Fatalf("notification-first delivery: status=%d state=%q reason=%q", status, state, reason)
	}
	if got, _, _ := f.attemptState(t, attemptID); got != "resolved" {
		t.Fatalf("notification-first delivery left the dispatch pending: %q", got)
	}
	// And it granted the entitlement it was carrying.
	if src, ok, err := f.store.GetSubscriptionSource(context.Background(), f.userID, ProviderApple); err != nil || !ok || src.PlanID != "pro" {
		t.Fatalf("notification-first entitlement: source=%+v ok=%v err=%v", src, ok, err)
	}
}

// A capability is bound to one account, one app and one generation. None of
// those may be substituted, and a second authenticated Relayium account holding
// the secret is still not the capability holder.
func TestCapabilityIsRefusedAcrossUserAppAndGeneration(t *testing.T) {
	t.Run("cross user", func(t *testing.T) {
		f := newAppleContinuationFixture(t)
		attemptID, secret := f.arm(t, testContinuationInstanceA)
		intruder := loginCookie(t, f.ts, f.mail, "apple-intruder@example.com")
		status, body := f.reportAs(t, intruder, map[string]string{
			"bundleId": testBundleIOS, "attemptId": attemptID,
			"appInstanceId": testContinuationInstanceA, "continuationSecret": secret,
			"armRequestId": initialArmID(testContinuationInstanceA),
			"outcome":      appleOutcomeUserCancelled,
		})
		if status != http.StatusForbidden || body["error"] != appleRefusalCapabilityCode {
			t.Fatalf("another account reported an outcome: status=%d body=%v", status, body)
		}
		if _, continuation, _ := f.attemptState(t, attemptID); continuation != appleContinuationArmed {
			t.Fatalf("another account moved the attempt: %q", continuation)
		}
	})

	t.Run("cross app", func(t *testing.T) {
		f := newAppleContinuationFixture(t)
		attemptID, secret := f.arm(t, testContinuationInstanceA)
		status, body := f.reportAs(t, f.cookie, map[string]string{
			"bundleId": testBundleMac, "attemptId": attemptID,
			"appInstanceId": testContinuationInstanceA, "continuationSecret": secret,
			"armRequestId": initialArmID(testContinuationInstanceA),
			"outcome":      appleOutcomeUserCancelled,
		})
		if status != http.StatusForbidden || body["error"] != appleRefusalCapabilityCode {
			t.Fatalf("a capability crossed into another app: status=%d body=%v", status, body)
		}
		if _, continuation, _ := f.attemptState(t, attemptID); continuation != appleContinuationArmed {
			t.Fatalf("a cross-app report moved the attempt: %q", continuation)
		}
	})

	t.Run("stale generation", func(t *testing.T) {
		f := newAppleContinuationFixture(t)
		attemptID, secret := f.arm(t, testContinuationInstanceA)
		var token string
		if err := f.store.db.QueryRow(`SELECT apple_account_token FROM billing_purchase_attempts WHERE id=?`, attemptID).Scan(&token); err != nil {
			t.Fatal(err)
		}
		// The purchase completes, which resolves the attempt and advances the
		// authority generation. The capability is now spent.
		f.mustAccept(t, f.chain.sign(t, applePayload(func(p map[string]any) {
			p["appAccountToken"] = token
			p["productId"] = testAppleProduct
		})))
		if state, _, _ := f.attemptState(t, attemptID); state != "resolved" {
			t.Fatalf("purchase did not resolve the attempt: %q", state)
		}
		status, body := f.report(t, attemptID, testContinuationInstanceA, secret, appleOutcomeUserCancelled)
		if status != http.StatusForbidden || body["error"] != appleRefusalCapabilityCode {
			t.Fatalf("a resolved attempt accepted an outcome report: status=%d body=%v", status, body)
		}
		if state, _, _ := f.attemptState(t, attemptID); state != "resolved" {
			t.Fatalf("a stale-generation report moved a resolved attempt: %q", state)
		}
	})
}

// The outcome endpoint refuses a malformed or unmodelled StoreKit result rather
// than treating it as one of the outcomes it does model.
func TestOutcomeEndpointRefusesAnUnmodelledResult(t *testing.T) {
	f := newAppleContinuationFixture(t)
	attemptID, secret := f.arm(t, testContinuationInstanceA)
	for _, outcome := range []string{"", "cancelled", "userCancelled ", "USERCANCELLED", "success;pending"} {
		status, _ := f.report(t, attemptID, testContinuationInstanceA, secret, outcome)
		if status != http.StatusBadRequest {
			t.Fatalf("outcome %q was accepted: status=%d", outcome, status)
		}
	}
	if _, continuation, got := f.attemptState(t, attemptID); continuation != appleContinuationArmed || got != "" {
		t.Fatalf("a refused outcome moved the attempt: continuation=%q outcome=%q", continuation, got)
	}
}

// Incident evidence is user-attributed by construction, so a HARD purge must
// take it. Leaving it would orphan a purged account's billing identity forever,
// which is the same privacy failure the purge set already guards for
// subscription_sources and usage_periods.
func TestHardPurgeRemovesAppleFinancialIncidentEvidence(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	u, err := store.UpsertUserByEmail(ctx, "incident-purge@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := recordAppleBillingIncidentTx(ctx, tx, AppleBillingIncident{
		ID: "incident-1", UserID: u.ID, Kind: appleIncidentSecondSubscription,
		BundleID: testBundleIOS, Environment: appleEnvProduction,
		IncomingExternalID: "production:second", ExistingExternalID: "production:first",
		IncomingProductID: testAppleProduct, DetectedAt: 100,
	}); err != nil {
		tx.Rollback()
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if got, err := store.AppleBillingIncidents(ctx, u.ID); err != nil || len(got) != 1 {
		t.Fatalf("incident not recorded: %+v err=%v", got, err)
	}
	if err := store.SetAccountDeletion(ctx, u.ID, 1, 2); err != nil {
		t.Fatal(err)
	}
	if err := store.ArchiveAndPurgeUser(ctx, u.ID, 300); err != nil {
		t.Fatalf("purge: %v", err)
	}
	var remaining int
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM apple_billing_incidents WHERE user_id=?`, u.ID).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 0 {
		t.Fatalf("hard purge left %d incident rows attributable to a deleted account", remaining)
	}
}

// capabilityMatches is the Go-level half of the capability check. It is tested
// directly because the SQL CAS beneath it independently re-checks the instance
// id, so an end-to-end test alone cannot prove this half is doing anything —
// a mutation battery showed exactly that.
func TestCapabilityMatchesRequiresBothInstanceAndSecret(t *testing.T) {
	const secret = "Zm9vYmFyLXNlY3JldC12YWx1ZS1mb3ItdGVzdGluZw"
	bound := appleAttemptRow{
		AppInstanceID:        testContinuationInstanceA,
		ContinuationVerifier: appleContinuationVerifier(secret),
	}
	for _, tc := range []struct {
		name     string
		row      appleAttemptRow
		instance string
		secret   string
		want     bool
	}{
		{"exact capability", bound, testContinuationInstanceA, secret, true},
		{"wrong instance", bound, testContinuationInstanceB, secret, false},
		{"wrong secret", bound, testContinuationInstanceA, secret + "x", false},
		{"empty secret", bound, testContinuationInstanceA, "", false},
		{"empty instance", bound, "", secret, false},
		{"unbound instance", appleAttemptRow{ContinuationVerifier: appleContinuationVerifier(secret)}, "", secret, false},
		{"unbound verifier", appleAttemptRow{AppInstanceID: testContinuationInstanceA}, testContinuationInstanceA, secret, false},
		{"truncated verifier", appleAttemptRow{
			AppInstanceID:        testContinuationInstanceA,
			ContinuationVerifier: appleContinuationVerifier(secret)[:16],
		}, testContinuationInstanceA, secret, false},
	} {
		if got := tc.row.capabilityMatches(tc.instance, tc.secret); got != tc.want {
			t.Fatalf("%s: capabilityMatches=%v want %v", tc.name, got, tc.want)
		}
	}
}

// ---------------------------------------------------------------------------
// Arm identity: which SHEET an outcome is about
// ---------------------------------------------------------------------------

// THE ADVERSARIAL SCHEDULE this correction exists for.
//
// (attempt, instance, secret) authenticate a CLIENT, and all three survive a
// resume unchanged. On their own they therefore cannot tell a report about the
// live sheet from a duplicate of one issued an arm ago. The schedule that
// exploits it:
//
//	arm A            -> armed
//	report A cancel  -> cancelled          (a duplicate stays in flight)
//	resume R1        -> armed              (sheet R1 is open and MAY CHARGE)
//	stale A cancel   -> must NOT move R1
//	resume R2        -> must be refused
//
// Without the arm-identity binding the stale report is accepted, R1's armed
// state is dragged back to cancelled, and R2 opens a SECOND StoreKit sheet while
// R1 can still charge -- a double charge from two concurrently authorized
// sheets. Every step here is a sequential HTTP call, so the schedule is exact
// rather than probabilistic.
func TestStaleCancellationFromAPreviousArmCannotOpenASecondSheet(t *testing.T) {
	f := newAppleContinuationFixture(t)
	attemptID, secret := f.arm(t, testContinuationInstanceA)
	armA := initialArmID(testContinuationInstanceA)

	if status, body := f.reportArm(t, attemptID, testContinuationInstanceA, secret, armA, appleOutcomeUserCancelled); status != http.StatusOK || body["resumable"] != true {
		t.Fatalf("arm A cancel report: status=%d body=%v", status, body)
	}
	resume := map[string]string{
		"bundleId": testBundleIOS, "productId": testAppleProduct,
		"appInstanceId": testContinuationInstanceA, "continuationSecret": secret,
		"armRequestId": "arm-R1",
	}
	if status, body := f.dispatch(t, resume); status != http.StatusOK || body.AttemptID != attemptID {
		t.Fatalf("resume R1: status=%d body=%+v", status, body)
	}
	if got := f.currentArmID(t, attemptID); got != "arm-R1" {
		t.Fatalf("resume did not atomically take over the arm identity: %q", got)
	}

	// Sheet R1 is open and may still charge. The in-flight duplicate from arm A
	// now lands. It authenticates perfectly -- same attempt, same instance, same
	// secret -- and must still be refused, with the SAME answer as a wrong secret.
	status, body := f.reportArm(t, attemptID, testContinuationInstanceA, secret, armA, appleOutcomeUserCancelled)
	if status != http.StatusForbidden || body["error"] != appleRefusalCapabilityCode {
		t.Fatalf("a stale arm-A report was accepted against live arm R1: status=%d body=%v", status, body)
	}
	if _, continuation, _ := f.attemptState(t, attemptID); continuation != appleContinuationArmed {
		t.Fatalf("a stale arm-A report moved live arm R1 to %q", continuation)
	}
	if got := f.currentArmID(t, attemptID); got != "arm-R1" {
		t.Fatalf("a stale report changed the arm identity: %q", got)
	}

	// So no second sheet can be bought. R1 is still the open arm and has reported
	// nothing, which is `purchase_outcome_required`, not a capability failure.
	resume["armRequestId"] = "arm-R2"
	status2, second := f.dispatch(t, resume)
	if status2 == http.StatusOK {
		t.Fatalf("a SECOND concurrent StoreKit sheet was authorized while R1 may charge: %+v", second)
	}
	if status2 != http.StatusConflict || second.Error != appleRefusalOutcome {
		t.Fatalf("resume R2: status=%d body=%+v", status2, second)
	}
	if n := f.countAttempts(t); n != 1 {
		t.Fatalf("the schedule created %d attempts", n)
	}
	var resumeCount int64
	if err := f.store.db.QueryRow(`SELECT resume_count FROM billing_purchase_attempts WHERE id=?`, attemptID).Scan(&resumeCount); err != nil {
		t.Fatal(err)
	}
	if resumeCount != 1 {
		t.Fatalf("the schedule armed %d times, want exactly 1 re-arm", resumeCount)
	}

	// And the honest continuation still works: R1's OWN report is accepted.
	if status, body := f.reportArm(t, attemptID, testContinuationInstanceA, secret, "arm-R1", appleOutcomeUserCancelled); status != http.StatusOK || body["resumable"] != true {
		t.Fatalf("arm R1's own report was refused: status=%d body=%v", status, body)
	}
}

// The initial arm is bound too, not only resumes. If the FIRST arm were
// nameless, its cancellation report would carry no identity and could be
// replayed across a later resume -- the same defect, one cycle earlier.
func TestInitialArmIsBoundToItsOwnArmIdentity(t *testing.T) {
	f := newAppleContinuationFixture(t)
	attemptID, secret := f.armWith(t, testContinuationInstanceA, "arm-first")
	if got := f.currentArmID(t, attemptID); got != "arm-first" {
		t.Fatalf("the initial arm stored %q as its arm identity", got)
	}
	// A report naming any other arm is refused, even on the very first sheet.
	status, body := f.reportArm(t, attemptID, testContinuationInstanceA, secret, "arm-second", appleOutcomeUserCancelled)
	if status != http.StatusForbidden || body["error"] != appleRefusalCapabilityCode {
		t.Fatalf("the initial arm accepted a foreign identity: status=%d body=%v", status, body)
	}
	if _, continuation, outcome := f.attemptState(t, attemptID); continuation != appleContinuationArmed || outcome != "" {
		t.Fatalf("a foreign identity moved the initial arm: continuation=%q outcome=%q", continuation, outcome)
	}
	if status, _ := f.reportArm(t, attemptID, testContinuationInstanceA, secret, "arm-first", appleOutcomeUserCancelled); status != http.StatusOK {
		t.Fatalf("the initial arm refused its OWN identity: status=%d", status)
	}
}

// A new-protocol dispatch must name its arm. A legacy one must name neither half
// of a capability, so half a capability is malformed rather than a silent
// downgrade to a one-shot dispatch.
func TestArmIdentityIsRequiredAndBounded(t *testing.T) {
	longID := strings.Repeat("a", appleContinuationIDMaxLen+1)
	for _, tc := range []struct {
		name string
		body map[string]string
	}{
		{"new protocol without an arm id", map[string]string{
			"bundleId": testBundleIOS, "productId": testAppleProduct,
			"appInstanceId": testContinuationInstanceA,
		}},
		{"arm id over the length bound", map[string]string{
			"bundleId": testBundleIOS, "productId": testAppleProduct,
			"appInstanceId": testContinuationInstanceA, "armRequestId": longID,
		}},
		{"arm id with a space", map[string]string{
			"bundleId": testBundleIOS, "productId": testAppleProduct,
			"appInstanceId": testContinuationInstanceA, "armRequestId": "arm one",
		}},
		{"arm id without an instance", map[string]string{
			"bundleId": testBundleIOS, "productId": testAppleProduct,
			"armRequestId": "arm-orphan",
		}},
		{"secret without an instance", map[string]string{
			"bundleId": testBundleIOS, "productId": testAppleProduct,
			"continuationSecret": "orphan-secret",
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newAppleContinuationFixture(t)
			status, body := f.dispatch(t, tc.body)
			if status != http.StatusBadRequest || body.Error != "invalid_request" {
				t.Fatalf("status=%d body=%+v want 400/invalid_request", status, body)
			}
			if n := f.countAttempts(t); n != 0 {
				t.Fatalf("a malformed dispatch created %d attempts", n)
			}
		})
	}
}

// Every WRONG arm identity gets the identical refusal, so the endpoint is not an
// oracle for which fact failed. A MISSING one is a 400, exactly as a missing
// secret or instance already is: that is a client-side shape error the client
// can see for itself, not a fact about the capability.
func TestOutcomeRefusesEveryNonCurrentArmIdentityUniformly(t *testing.T) {
	f := newAppleContinuationFixture(t)
	attemptID, secret := f.arm(t, testContinuationInstanceA)
	armA := initialArmID(testContinuationInstanceA)
	f.reportArm(t, attemptID, testContinuationInstanceA, secret, armA, appleOutcomeUserCancelled)
	if status, _ := f.dispatch(t, map[string]string{
		"bundleId": testBundleIOS, "productId": testAppleProduct,
		"appInstanceId": testContinuationInstanceA, "continuationSecret": secret,
		"armRequestId": "arm-current",
	}); status != http.StatusOK {
		t.Fatalf("resume: status=%d", status)
	}

	// A prior arm, an arm that never existed, and a wrong secret must be
	// indistinguishable to the caller.
	for _, tc := range []struct{ name, armID, secret string }{
		{"the prior arm", armA, secret},
		{"an arm that never existed", "arm-never", secret},
		{"a wrong secret with the right arm", "arm-current", "not-the-secret"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, body := f.reportArm(t, attemptID, testContinuationInstanceA, tc.secret, tc.armID, appleOutcomeUserCancelled)
			if status != http.StatusForbidden || body["error"] != appleRefusalCapabilityCode {
				t.Fatalf("status=%d body=%v want 403/%s", status, body, appleRefusalCapabilityCode)
			}
			if _, continuation, outcome := f.attemptState(t, attemptID); continuation != appleContinuationArmed || outcome != "" {
				t.Fatalf("a refused report moved the attempt: continuation=%q outcome=%q", continuation, outcome)
			}
		})
	}

	t.Run("a missing arm id is malformed", func(t *testing.T) {
		status, body := f.reportAs(t, f.cookie, map[string]string{
			"bundleId": testBundleIOS, "attemptId": attemptID,
			"appInstanceId": testContinuationInstanceA, "continuationSecret": secret,
			"outcome": appleOutcomeUserCancelled,
		})
		if status != http.StatusBadRequest || body["error"] != "invalid_request" {
			t.Fatalf("status=%d body=%v want 400/invalid_request", status, body)
		}
		if _, continuation, _ := f.attemptState(t, attemptID); continuation != appleContinuationArmed {
			t.Fatalf("a malformed report moved the attempt: %q", continuation)
		}
	})
}

// A current client persists its secret before the INITIAL request. Repeating
// that request after either the request or response was lost reads the same
// attempt/token back and never authorizes a second sheet.
func TestRepeatingTheInitialArmIdentityIsIdempotent(t *testing.T) {
	f := newAppleContinuationFixture(t)
	const secret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	status, first := f.dispatch(t, map[string]string{
		"bundleId": testBundleIOS, "productId": testAppleProduct,
		"appInstanceId": testContinuationInstanceA, "continuationSecret": secret,
		"armRequestId": "arm-first",
	})
	if status != http.StatusOK || first.AttemptID == "" || first.ContinuationSecret != "" {
		t.Fatalf("client-secret initial arm: status=%d body=%+v", status, first)
	}
	attemptID := first.AttemptID
	status, replay := f.dispatch(t, map[string]string{
		"bundleId": testBundleIOS, "productId": testAppleProduct,
		"appInstanceId": testContinuationInstanceA, "continuationSecret": secret,
		"armRequestId": "arm-first",
	})
	if status != http.StatusOK || replay.AttemptID != attemptID {
		t.Fatalf("initial-arm replay: status=%d body=%+v", status, replay)
	}
	if replay.ContinuationSecret != "" {
		t.Fatal("initial-arm replay re-issued the one-time secret")
	}
	if n := f.countAttempts(t); n != 1 {
		t.Fatalf("initial-arm replay created %d attempts", n)
	}
	var resumeCount int64
	if err := f.store.db.QueryRow(`SELECT resume_count FROM billing_purchase_attempts WHERE id=?`, attemptID).Scan(&resumeCount); err != nil {
		t.Fatal(err)
	}
	if resumeCount != 0 {
		t.Fatalf("initial-arm replay armed again: resume_count=%d", resumeCount)
	}
	// Omitting the prepared secret cannot read the response back.
	status, noSecret := f.dispatch(t, map[string]string{
		"bundleId": testBundleIOS, "productId": testAppleProduct,
		"appInstanceId": testContinuationInstanceA, "armRequestId": "arm-first",
	})
	if status != http.StatusForbidden || noSecret.Error != appleRefusalCapabilityCode {
		t.Fatalf("a lost initial response was recovered without the secret: status=%d body=%+v", status, noSecret)
	}
	// A gate changing after the first 200 must not hide that 200 from an exact
	// replay. Otherwise the client cannot distinguish "never armed" from "armed,
	// response lost" and cannot safely recover its prepared identity.
	removeApplePurchaseGate(t, f.store)
	status, gatedReplay := f.dispatch(t, map[string]string{
		"bundleId": testBundleIOS, "productId": testAppleProduct,
		"appInstanceId": testContinuationInstanceA, "continuationSecret": secret,
		"armRequestId": "arm-first",
	})
	if status != http.StatusOK || gatedReplay.AttemptID != attemptID {
		t.Fatalf("gate hid exact initial replay: status=%d body=%+v", status, gatedReplay)
	}
}

// A resume racing the stale report it supersedes must never leave two sheets
// authorized. Whichever order the two land in, the attempt ends in exactly one
// state and at most one re-arm happened.
func TestResumeRacingAStaleReportNeverAuthorizesTwoSheets(t *testing.T) {
	for range 24 {
		f := newAppleContinuationFixture(t)
		attemptID, secret := f.arm(t, testContinuationInstanceA)
		armA := initialArmID(testContinuationInstanceA)
		f.reportArm(t, attemptID, testContinuationInstanceA, secret, armA, appleOutcomeUserCancelled)

		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			f.dispatch(t, map[string]string{
				"bundleId": testBundleIOS, "productId": testAppleProduct,
				"appInstanceId": testContinuationInstanceA, "continuationSecret": secret,
				"armRequestId": "arm-R1",
			})
		}()
		go func() {
			defer wg.Done()
			<-start
			f.reportArm(t, attemptID, testContinuationInstanceA, secret, armA, appleOutcomeUserCancelled)
		}()
		close(start)
		wg.Wait()

		// Whoever won, a second distinct resume must never be authorized while an
		// arm is open, and the arm identity must be EXACTLY the one the winning
		// transition wrote. Only two end states are admissible, and each pins one
		// identity -- there is no ordering that produces any other pair.
		//
		// The single writer of a new arm identity is the CAS that also moves
		// cancelled -> armed; it writes both or neither. So `cancelled` while the
		// row carries "arm-R1" is not a benign ordering: it is precisely the
		// defect end state -- resume R1 armed, and the stale report from arm A
		// then dragged the live R1 arm back to cancelled, freeing a resume R2 to
		// open a second sheet while R1 could still charge. This assertion used to
		// tolerate it, which meant the assertion blessed the very end state the
		// test exists to reject.
		//
		// HONEST LIMIT, measured rather than assumed: the cancelled branch is not
		// currently reachable. Over 72 instrumented iterations this race resolved
		// armed/arm-R1 72 times and cancelled ZERO times -- the resume does
		// strictly more work than the outcome report, so the report effectively
		// always commits first. Reintroducing the defect therefore does NOT fail
		// this test, in either the loose or the tightened form. Do not treat it as
		// the arm-binding guard's proof: that is
		// TestStaleCancellationFromAPreviousArmCannotOpenASecondSheet,
		// TestOutcomeRefusesEveryNonCurrentArmIdentityUniformly and
		// TestStoreOutcomeRequiresTheCurrentArmIdentity, all deterministic and all
		// of which do fail. See design record residual 11.
		_, continuation, _ := f.attemptState(t, attemptID)
		armID := f.currentArmID(t, attemptID)
		switch continuation {
		case appleContinuationArmed:
			// The resume won. It armed under its own identity, and the stale report
			// from arm A that arrived after it was refused and moved nothing.
			if armID != "arm-R1" {
				t.Fatalf("armed under an unexpected identity %q, want %q", armID, "arm-R1")
			}
		case appleContinuationCancelled:
			// The resume did not commit, so nothing ever wrote a new identity: the
			// row must still carry arm A exactly as the pre-race report left it.
			if armID != armA {
				t.Fatalf("cancelled under an unexpected identity %q, want the untouched %q -- a cancelled row carrying the resume's identity is the stale report undoing a live arm", armID, armA)
			}
		default:
			t.Fatalf("unexpected continuation state %q", continuation)
		}
		var resumeCount int64
		if err := f.store.db.QueryRow(`SELECT resume_count FROM billing_purchase_attempts WHERE id=?`, attemptID).Scan(&resumeCount); err != nil {
			t.Fatal(err)
		}
		if resumeCount > 1 {
			t.Fatalf("the race armed %d times", resumeCount)
		}
		if n := f.countAttempts(t); n != 1 {
			t.Fatalf("the race created %d attempts", n)
		}
	}
}

// Every failure path in recordAppleSecondSubscriptionIncident logs, and every
// log is sanitized.
//
// This matters more than an ordinary error log. The incident row is the durable
// evidence that a SECOND distinct live Apple subscription reached one account --
// a customer may have been charged twice -- and the function is deliberately
// best-effort: it cannot return an error, because the transaction that
// discovered the conflict is already being rolled back on purpose. So when a
// failure path stays silent, the incident leaves NO trace anywhere and an
// operator has nothing to act on. Two paths used to return silently.
//
// The second half of the assertion is the standing rule for this file: the log
// line is the one artifact that survives the hard purge which removes the row,
// so it must carry the account and the kind and nothing else -- no subscription
// identity, no product, no signed payload, no capability material.
func TestSecondSubscriptionIncidentLogsEveryFailurePathSanitized(t *testing.T) {
	// Sentinels chosen so that a future edit that "helpfully" logs %+v of the
	// event, or the subscription it conflicts with, fails this test loudly.
	const sentinelSubscription = "production:SENTINEL-SUBSCRIPTION-DO-NOT-LOG"
	const sentinelProduct = "SENTINEL-PRODUCT-DO-NOT-LOG"

	event := func(userID string) SourceEvent {
		return SourceEvent{
			UserID: userID, Provider: ProviderApple, ExternalID: sentinelSubscription,
			ExternalScope: testBundleIOS, BillingProductID: sentinelProduct, Now: 500,
		}
	}
	assertSanitized := func(t *testing.T, logged, userID string) {
		t.Helper()
		if !strings.Contains(logged, "apple financial incident") || !strings.Contains(logged, userID) {
			t.Fatalf("the failure was dropped silently or without the account: %q", logged)
		}
		for _, forbidden := range []string{sentinelSubscription, sentinelProduct} {
			if strings.Contains(logged, forbidden) {
				t.Fatalf("the sanitized log leaked %q: %q", forbidden, logged)
			}
		}
	}

	// Path 1: the pre-transaction read of the existing binding fails.
	t.Run("reading the existing binding fails", func(t *testing.T) {
		store := newTestStore(t)
		ctx := context.Background()
		u, _ := store.UpsertUserByEmail(ctx, "incident-read-fail@example.test", "")
		if _, err := store.db.ExecContext(ctx, `DROP TABLE subscription_sources`); err != nil {
			t.Fatal(err)
		}
		logged := captureLog(t, func() {
			store.recordAppleSecondSubscriptionIncident(ctx, event(u.ID), appleEnvProduction, "attempt-read-fail")
		})
		assertSanitized(t, logged, u.ID)
		if !strings.Contains(logged, "reading the existing apple subscription binding failed") {
			t.Fatalf("the read failure was not identified: %q", logged)
		}
	})

	// Path 2: opening the evidence transaction fails.
	//
	// This needs the READER to succeed while the WRITER fails, which the
	// in-memory test store cannot express: for ':memory:' OpenSQLite keeps a
	// single connection and reader() returns s.db, so anything that breaks the
	// writer breaks the read first and path 1 fires instead. Rather than adding a
	// production-only fault seam, the injection uses the FILE-BACKED
	// configuration -- which is what production actually runs -- where OpenSQLite
	// opens a separate read-only pool. Closing only the writer pool is then a
	// faithful, non-invasive reproduction.
	t.Run("opening the evidence transaction fails", func(t *testing.T) {
		store, err := OpenSQLite(t.TempDir() + "/incident.db")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { store.Close() })
		ctx := context.Background()
		u, _ := store.UpsertUserByEmail(ctx, "incident-begin-fail@example.test", "")
		if store.rdb == nil {
			t.Fatal("the file-backed store has no separate reader pool; this injection would hit path 1 instead")
		}
		if err := store.db.Close(); err != nil {
			t.Fatal(err)
		}
		logged := captureLog(t, func() {
			store.recordAppleSecondSubscriptionIncident(ctx, event(u.ID), appleEnvProduction, "attempt-begin-fail")
		})
		assertSanitized(t, logged, u.ID)
		if !strings.Contains(logged, "opening the evidence transaction failed") {
			t.Fatalf("the BeginTx failure was not identified: %q", logged)
		}
	})

	// Path 3: writing the evidence row fails. This path already logged; it is
	// covered here so all three share one sanitization assertion.
	t.Run("writing the evidence row fails", func(t *testing.T) {
		store := newTestStore(t)
		ctx := context.Background()
		u, _ := store.UpsertUserByEmail(ctx, "incident-write-fail@example.test", "")
		if _, err := store.db.ExecContext(ctx, `DROP TABLE apple_billing_incidents`); err != nil {
			t.Fatal(err)
		}
		logged := captureLog(t, func() {
			store.recordAppleSecondSubscriptionIncident(ctx, event(u.ID), appleEnvProduction, "attempt-write-fail")
		})
		assertSanitized(t, logged, u.ID)
		if !strings.Contains(logged, "writing the evidence row failed") {
			t.Fatalf("the insert failure was not identified: %q", logged)
		}
	})

	// Path 4 -- Commit() failing after a successful insert -- is NOT separately
	// injectable without a production-only seam: every way to make the commit
	// fail (closing the pool, revoking the file, corrupting the journal) also
	// fails the BeginTx or the INSERT that must precede it, so the earlier
	// branch returns first. It is left uncovered deliberately and recorded here
	// rather than faked, and it is the one path whose log line this change did
	// not add -- only reworded to name its step, like the other three.
}

// captureLog runs fn with the standard logger redirected and returns what it
// wrote. stderr is kept so a failing run is still readable.
func captureLog(t *testing.T, fn func()) string {
	t.Helper()
	var buf bytes.Buffer
	previous := log.Writer()
	log.SetOutput(io.MultiWriter(&buf, os.Stderr))
	defer log.SetOutput(previous)
	fn()
	return buf.String()
}

// A hard account purge scrubs the continuation protocol's DEVICE AND CAPABILITY
// material while the financial attempt ledger survives.
//
// Both halves are load-bearing and they pull in opposite directions, which is why
// they are asserted together in one test:
//
//   - the attempt row must SURVIVE. A late Ask-to-Buy approval or renewal can
//     still arrive for a purged account, and it is resolved against the attempt's
//     id, product, epoch and attribution token. Deleting the row would not make
//     that fact go away, only make it unattributable;
//   - the app instance id, the continuation verifier, the arm identity and the
//     capability's bookkeeping must NOT survive. None of them answers any
//     money question and none is read by any late-fact path; retaining a deleted
//     account's device identity forever is exactly what the purge exists to
//     prevent.
//
// The post-purge continuation state is the EMPTY legacy value, and that choice is
// fail-closed rather than merely default: capabilityMatches needs a non-empty
// instance id AND a 32-byte verifier, armMatches needs a non-empty stored arm id,
// and the resume predicate matches only the armed and cancelled states. A
// scrubbed row is refused by each of those independently.
func TestHardPurgeScrubsContinuationMaterialAndKeepsTheAttemptLedger(t *testing.T) {
	f := newAppleContinuationFixture(t)
	ctx := context.Background()

	// Drive the REAL protocol so every column is populated the way production
	// populates it: initial arm, a cancellation outcome, then a resume -- which is
	// what makes resume_count and a second arm identity nonzero.
	attemptID, secret := f.arm(t, testContinuationInstanceA)
	f.report(t, attemptID, testContinuationInstanceA, secret, appleOutcomeUserCancelled)
	if status, body := f.dispatch(t, map[string]string{
		"bundleId": testBundleIOS, "productId": testAppleProduct,
		"appInstanceId": testContinuationInstanceA, "continuationSecret": secret,
		"armRequestId": "arm-before-purge",
	}); status != http.StatusOK || body.AttemptID != attemptID {
		t.Fatalf("resume before purge: status=%d body=%+v", status, body)
	}
	f.reportArm(t, attemptID, testContinuationInstanceA, secret, "arm-before-purge", appleOutcomeUserCancelled)

	type attemptRow struct {
		state, continuation, instance, armID, outcome, product, token string
		verifier                                                      []byte
		outcomeAt, resumeCount, epoch                                 int64
		userID                                                        string
	}
	read := func() attemptRow {
		t.Helper()
		var r attemptRow
		if err := f.store.db.QueryRowContext(ctx, `SELECT state,continuation_state,app_instance_id,arm_request_id,
 client_outcome,product_id,apple_account_token,continuation_verifier,outcome_at,resume_count,epoch,user_id
 FROM billing_purchase_attempts WHERE id=?`, attemptID).Scan(&r.state, &r.continuation, &r.instance, &r.armID,
			&r.outcome, &r.product, &r.token, &r.verifier, &r.outcomeAt, &r.resumeCount, &r.epoch, &r.userID); err != nil {
			t.Fatalf("read attempt %s: %v", attemptID, err)
		}
		return r
	}

	// The fixture must actually have seeded every field this test claims to scrub.
	// Without this the whole test would pass vacuously the day the protocol stops
	// writing one of them.
	before := read()
	for _, seeded := range []struct {
		name string
		got  string
	}{
		{"continuation_state", before.continuation},
		{"app_instance_id", before.instance},
		{"arm_request_id", before.armID},
		{"client_outcome", before.outcome},
		{"product_id", before.product},
		{"apple_account_token", before.token},
		{"user_id", before.userID},
	} {
		if seeded.got == "" {
			t.Fatalf("fixture did not seed %s; this test would prove nothing: %+v", seeded.name, before)
		}
	}
	if len(before.verifier) != sha256.Size {
		t.Fatalf("fixture did not seed a %d-byte continuation_verifier: got %d", sha256.Size, len(before.verifier))
	}
	if before.outcomeAt == 0 || before.resumeCount == 0 {
		t.Fatalf("fixture did not seed the continuation bookkeeping: outcome_at=%d resume_count=%d", before.outcomeAt, before.resumeCount)
	}

	if err := f.store.SetAccountDeletion(ctx, f.userID, 1, 100); err != nil {
		t.Fatal(err)
	}
	if err := f.store.ArchiveAndPurgeUser(ctx, f.userID, 200); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.GetUserByID(ctx, f.userID); err == nil {
		t.Fatal("the users row survived the hard purge")
	}

	after := read()

	// Scrubbed.
	if after.continuation != appleContinuationLegacy {
		t.Fatalf("continuation_state survived the purge as %q, want the fail-closed %q", after.continuation, appleContinuationLegacy)
	}
	if after.instance != "" {
		t.Fatalf("the app instance id survived the hard purge: %q", after.instance)
	}
	if after.armID != "" {
		t.Fatalf("the arm identity survived the hard purge: %q", after.armID)
	}
	if len(after.verifier) != 0 {
		t.Fatalf("the continuation verifier survived the hard purge: %d bytes", len(after.verifier))
	}
	if after.outcome != "" || after.outcomeAt != 0 || after.resumeCount != 0 {
		t.Fatalf("continuation bookkeeping survived the hard purge: outcome=%q outcome_at=%d resume_count=%d", after.outcome, after.outcomeAt, after.resumeCount)
	}

	// Preserved: the financial ledger and the attribution a late Apple fact needs.
	if after.state != before.state || after.product != before.product ||
		after.token != before.token || after.epoch != before.epoch || after.userID != before.userID {
		t.Fatalf("the hard purge destroyed financial attempt evidence: before=%+v after=%+v", before, after)
	}

	// Preserved: the tombstone that quarantines a late Apple fact for this
	// account. The scrub must not have taken it with the device material.
	var tombDeleted int64
	if err := f.store.db.QueryRowContext(ctx, `SELECT deleted_at FROM apple_billing_subjects WHERE user_id=?`, f.userID).Scan(&tombDeleted); err != nil || tombDeleted != 200 {
		t.Fatalf("apple_billing_subjects tombstone deleted_at=%d err=%v", tombDeleted, err)
	}

	// And the scrubbed row genuinely fails closed: every capability guard refuses
	// it independently, so the refusal does not rest on the state column alone.
	scrubbed := appleAttemptRow{
		ContinuationState:    after.continuation,
		ContinuationVerifier: after.verifier,
		AppInstanceID:        after.instance,
		ArmRequestID:         after.armID,
	}
	if scrubbed.capabilityMatches(testContinuationInstanceA, secret) {
		t.Fatal("a scrubbed attempt still matched the capability it was armed with")
	}
	if scrubbed.armMatches("arm-before-purge") {
		t.Fatal("a scrubbed attempt still matched its pre-purge arm identity")
	}
}

// armMatches is the guard itself, exercised directly at its own granularity so a
// mutation cannot hide behind capabilityMatches absorbing it.
func TestArmMatchesRequiresAnExactCurrentIdentity(t *testing.T) {
	for _, tc := range []struct {
		name      string
		stored    string
		presented string
		want      bool
	}{
		{"exact", "arm-1", "arm-1", true},
		{"different", "arm-1", "arm-2", false},
		{"prefix of stored", "arm-12", "arm-1", false},
		{"stored is a prefix", "arm-1", "arm-12", false},
		{"presented empty", "arm-1", "", false},
		{"stored empty is legacy and matches nothing", "", "arm-1", false},
		{"both empty still matches nothing", "", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			row := appleAttemptRow{ArmRequestID: tc.stored}
			if got := row.armMatches(tc.presented); got != tc.want {
				t.Fatalf("armMatches(%q) with stored %q = %v, want %v", tc.presented, tc.stored, got, tc.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// The store's own guards
// ---------------------------------------------------------------------------

// newArmFixture builds an Apple billing authority directly, so the store's
// exported arming API can be tested WITHOUT the HTTP handler in front of it.
//
// This matters beyond convenience: ArmAppleBillingPurchase and
// RecordAppleBillingPurchaseOutcome are exported, and the handler is only one
// caller. A guard that exists solely in the handler would leave the store
// unsafe for the next caller, so each layer is proved at its own granularity
// rather than through the other.
func newArmFixture(t *testing.T) (*SQLiteStore, BillingAuthority, context.Context) {
	t.Helper()
	store := newTestStore(t)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "arm-store@example.test", "")
	authority, err := store.AcquireBillingAuthority(ctx, BillingAuthorityRequest{
		UserID: u.ID, Provider: ProviderApple, ExternalScope: testBundleIOS,
		AppleAccountToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Now: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	return store, authority, ctx
}

const testArmToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

// The store refuses a malformed capability shape on its own, without relying on
// the handler having screened it first.
func TestStoreArmRejectsAMalformedCapabilityShape(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   AppleDispatchRequest
	}{
		{"new protocol without an arm id", AppleDispatchRequest{
			ProductID: "plus.monthly", CandidateToken: testArmToken,
			AppInstanceID: testContinuationInstanceA, Now: 101,
		}},
		{"arm id over the length bound", AppleDispatchRequest{
			ProductID: "plus.monthly", CandidateToken: testArmToken,
			AppInstanceID: testContinuationInstanceA,
			ArmRequestID:  strings.Repeat("a", appleContinuationIDMaxLen+1), Now: 101,
		}},
		{"legacy request carrying an arm id", AppleDispatchRequest{
			ProductID: "plus.monthly", CandidateToken: testArmToken,
			ArmRequestID: "arm-orphan", Now: 101,
		}},
		{"legacy request carrying a secret", AppleDispatchRequest{
			ProductID: "plus.monthly", CandidateToken: testArmToken,
			ContinuationSecret: "orphan-secret", Now: 101,
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store, authority, ctx := newArmFixture(t)
			if _, err := store.ArmAppleBillingPurchase(ctx, authority, tc.in); !errors.Is(err, ErrBillingAuthorityConflict) {
				t.Fatalf("err=%v want ErrBillingAuthorityConflict", err)
			}
			var n int
			if err := store.db.QueryRow(`SELECT COUNT(*) FROM billing_purchase_attempts WHERE user_id=?`, authority.UserID).Scan(&n); err != nil {
				t.Fatal(err)
			}
			if n != 0 {
				t.Fatalf("a malformed request created %d attempts", n)
			}
		})
	}
}

// The store binds and enforces the arm identity itself, including the whole
// stale-report-after-resume schedule, with no HTTP layer involved.
func TestStoreOutcomeRequiresTheCurrentArmIdentity(t *testing.T) {
	store, authority, ctx := newArmFixture(t)
	secret := testContinuationSecret(0x51)
	armed, err := store.ArmAppleBillingPurchase(ctx, authority, AppleDispatchRequest{
		ProductID: "plus.monthly", CandidateToken: testArmToken,
		ContinuationProtocol: appleContinuationProtocolAttemptIDV2,
		AppInstanceID:        testContinuationInstanceA, ContinuationSecret: secret,
		ArmRequestID: "arm-A", Now: 101,
	})
	if err != nil || !armed.Armed || armed.Secret != "" {
		t.Fatalf("initial arm: %+v err=%v", armed, err)
	}
	report := AppleOutcomeRequest{
		UserID: authority.UserID, AttemptID: armed.Attempt.ID, BundleID: testBundleIOS,
		AppInstanceID: testContinuationInstanceA, ContinuationSecret: secret,
		ArmRequestID: "arm-A", Outcome: appleOutcomeUserCancelled, Now: 102,
	}
	// A syntactically absent identity is refused before anything else happens.
	missing := report
	missing.ArmRequestID = ""
	if res, err := store.RecordAppleBillingPurchaseOutcome(ctx, missing); err != nil || res.Accepted {
		t.Fatalf("an outcome with no arm id was accepted: %+v err=%v", res, err)
	}
	// Arm A's own report is accepted.
	if res, err := store.RecordAppleBillingPurchaseOutcome(ctx, report); err != nil || !res.Accepted || !res.Resumable {
		t.Fatalf("arm A report: %+v err=%v", res, err)
	}
	// Resume takes the identity over atomically.
	resumed, err := store.ArmAppleBillingPurchase(ctx, authority, AppleDispatchRequest{
		ProductID: "plus.monthly", CandidateToken: testArmToken,
		ContinuationProtocol: appleContinuationProtocolAttemptIDV2,
		AppInstanceID:        testContinuationInstanceA, ContinuationSecret: secret,
		ArmRequestID: "arm-R1", Now: 103,
	})
	if err != nil || !resumed.Resumed || resumed.Secret != "" {
		t.Fatalf("resume: %+v err=%v", resumed, err)
	}
	var armID, continuation string
	if err := store.db.QueryRow(`SELECT arm_request_id,continuation_state FROM billing_purchase_attempts WHERE id=?`, armed.Attempt.ID).Scan(&armID, &continuation); err != nil {
		t.Fatal(err)
	}
	if armID != "arm-R1" || continuation != appleContinuationArmed {
		t.Fatalf("after resume arm_request_id=%q continuation=%q", armID, continuation)
	}
	// The stale duplicate from arm A must now move nothing.
	stale := report
	stale.Now = 104
	if res, err := store.RecordAppleBillingPurchaseOutcome(ctx, stale); err != nil || res.Accepted || res.Resumable {
		t.Fatalf("a stale arm-A report was accepted: %+v err=%v", res, err)
	}
	if err := store.db.QueryRow(`SELECT arm_request_id,continuation_state FROM billing_purchase_attempts WHERE id=?`, armed.Attempt.ID).Scan(&armID, &continuation); err != nil {
		t.Fatal(err)
	}
	if armID != "arm-R1" || continuation != appleContinuationArmed {
		t.Fatalf("a stale report moved the row: arm_request_id=%q continuation=%q", armID, continuation)
	}
	// And no second sheet can follow.
	second, err := store.ArmAppleBillingPurchase(ctx, authority, AppleDispatchRequest{
		ProductID: "plus.monthly", CandidateToken: testArmToken,
		ContinuationProtocol: appleContinuationProtocolAttemptIDV2,
		AppInstanceID:        testContinuationInstanceA, ContinuationSecret: secret,
		ArmRequestID: "arm-R2", Now: 105,
	})
	if err != nil {
		t.Fatal(err)
	}
	if second.Armed || second.Resumed || second.Replayed || second.Refusal != appleRefusalOutcome {
		t.Fatalf("a second sheet was authorized: %+v", second)
	}
}

// ---------------------------------------------------------------------------
// Global arm-identity non-reuse
// ---------------------------------------------------------------------------
//
// The blocking finding these cover. Spending an arm id only against the arm
// that is open NOW refuses a replay of the current id and nothing else: an id
// from two or more arms ago compares unequal and was accepted again. That is a
// money-loss path, because re-arming under a resurrected id makes the ORIGINAL
// arm's delayed report match the CURRENT sheet, so a live armed sheet is dragged
// back to cancelled and another sheet is authorized while the first can still
// charge. The capability holder being genuine is not mitigation: the ids are
// client-generated, so non-reuse has to be stored rather than assumed.

// armHistory reads every arm identity this attempt has ever spent, oldest first.
func (f *appleContinuationFixture) armHistory(t *testing.T, attemptID string) []string {
	t.Helper()
	rows, err := f.store.db.Query(`SELECT arm_request_id FROM apple_purchase_arm_ids
 WHERE attempt_id=? ORDER BY armed_at,arm_request_id`, attemptID)
	if err != nil {
		t.Fatalf("read arm history %s: %v", attemptID, err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// resumeWith attempts a resume under an explicit arm identity and returns what
// the endpoint answered, without asserting success.
func (f *appleContinuationFixture) resumeWith(t *testing.T, instance, secret, armRequestID string) (int, dispatchBody) {
	t.Helper()
	return f.dispatch(t, map[string]string{
		"bundleId": testBundleIOS, "productId": testAppleProduct,
		"appInstanceId": instance, "continuationSecret": secret,
		"armRequestId": armRequestID,
	})
}

func (f *appleContinuationFixture) resumeCount(t *testing.T, attemptID string) int64 {
	t.Helper()
	var n int64
	if err := f.store.db.QueryRow(`SELECT resume_count FROM billing_purchase_attempts WHERE id=?`, attemptID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// Mandatory test 1: the exact money-loss schedule, deterministically.
//
// A=X cancel -> B=Y cancel -> C attempts X. X must be refused, the attempt must
// stay cancelled on Y, a genuinely fresh C=Z must still be able to arm, and the
// original arm A's delayed report -- which still names X -- must not be able to
// move it.
func TestAnArmIdentityFromAnyEarlierArmCanNeverBeReused(t *testing.T) {
	f := newAppleContinuationFixture(t)
	const instance = testContinuationInstanceA
	const armX, armY, armZ = "arm-A-X", "arm-B-Y", "arm-C-Z"

	// 1. Initial arm A under X, explicitly cancelled.
	attemptID, secret := f.armWith(t, instance, armX)
	// The INITIAL arm must be in the history immediately, before any resume has
	// had a chance to backfill it. Asserted as state rather than only through
	// behaviour on purpose: the resume path backfills the attempt's current arm
	// id, which MASKS a missing initial reservation in every end-to-end schedule
	// -- removing the initial reserveAppleArmIDTx call is invisible to every
	// behavioural assertion in this file. This is the one assertion that fails
	// when it is removed, and it is why the requirement says "including the
	// initial arm".
	if got := f.armHistory(t, attemptID); len(got) != 1 || got[0] != armX {
		t.Fatalf("the initial arm did not spend its identity: history=%v, want [%s]", got, armX)
	}
	if status, _ := f.reportArm(t, attemptID, instance, secret, armX, appleOutcomeUserCancelled); status != http.StatusOK {
		t.Fatalf("cancel arm A: status=%d", status)
	}

	// 2. Resume B under Y, explicitly cancelled.
	if status, body := f.resumeWith(t, instance, secret, armY); status != http.StatusOK || body.AttemptID != attemptID {
		t.Fatalf("resume B: status=%d body=%+v", status, body)
	}
	if status, _ := f.reportArm(t, attemptID, instance, secret, armY, appleOutcomeUserCancelled); status != http.StatusOK {
		t.Fatalf("cancel arm B: status=%d", status)
	}

	// The fixture must actually have reached the state this test is about, or
	// every assertion below would pass vacuously.
	if _, continuation, _ := f.attemptState(t, attemptID); continuation != appleContinuationCancelled {
		t.Fatalf("precondition: want a cancelled attempt, got %q", continuation)
	}
	if got := f.currentArmID(t, attemptID); got != armY {
		t.Fatalf("precondition: current arm %q, want %q", got, armY)
	}
	if got := f.armHistory(t, attemptID); len(got) != 2 {
		t.Fatalf("precondition: want X and Y spent, got %v", got)
	}
	countBefore := f.resumeCount(t, attemptID)

	// 3. Resume C tries to reuse X -- an id from TWO arms ago. Before the fix
	// this was accepted, because X <> the current arm Y.
	status, refused := f.resumeWith(t, instance, secret, armX)
	if status != http.StatusForbidden || refused.Error != appleRefusalCapabilityCode {
		t.Fatalf("an arm id from two arms ago was reusable: status=%d body=%+v", status, refused)
	}
	// The uniform capability refusal, specifically: not a 500 (this is a
	// well-formed request being correctly refused) and not
	// purchase_outcome_required (which would imply an open sheet awaiting a
	// report, and would single out the arm id as the interesting fact).
	if refused.Error == appleRefusalOutcome || refused.Error == appleRefusalReconcile {
		t.Fatalf("reuse leaked which fact was wrong: %q", refused.Error)
	}
	if refused.AttemptID != "" || refused.ContinuationSecret != "" {
		t.Fatalf("a refused reuse returned capability material: %+v", refused)
	}

	// Nothing moved, and the refusal burned nothing.
	if _, continuation, _ := f.attemptState(t, attemptID); continuation != appleContinuationCancelled {
		t.Fatalf("a refused reuse moved the attempt to %q", continuation)
	}
	if got := f.currentArmID(t, attemptID); got != armY {
		t.Fatalf("a refused reuse replaced the current arm with %q", got)
	}
	if got := f.resumeCount(t, attemptID); got != countBefore {
		t.Fatalf("a refused reuse armed: resume_count %d -> %d", countBefore, got)
	}

	// 4. A genuinely fresh id still works: this is a correction to reuse, not a
	// lockout of legitimate recovery.
	if status, body := f.resumeWith(t, instance, secret, armZ); status != http.StatusOK || body.AttemptID != attemptID {
		t.Fatalf("a fresh arm id was refused: status=%d body=%+v", status, body)
	}
	if _, continuation, _ := f.attemptState(t, attemptID); continuation != appleContinuationArmed {
		t.Fatalf("the fresh resume did not arm: %q", continuation)
	}
	if got := f.currentArmID(t, attemptID); got != armZ {
		t.Fatalf("current arm %q, want %q", got, armZ)
	}

	// 5. The delayed duplicate .userCancelled from the ORIGINAL arm A, still
	// naming X, arrives now. It must not touch the live sheet C.
	status, _ = f.reportArm(t, attemptID, instance, secret, armX, appleOutcomeUserCancelled)
	if status != http.StatusForbidden {
		t.Fatalf("arm A's delayed report was accepted against sheet C: status=%d", status)
	}
	if _, continuation, _ := f.attemptState(t, attemptID); continuation != appleContinuationArmed {
		t.Fatalf("a stale report from arm A moved live sheet C to %q", continuation)
	}
	if got := f.currentArmID(t, attemptID); got != armZ {
		t.Fatalf("a stale report from arm A replaced the current arm with %q", got)
	}
	// One sheet, ever: three arms happened, and exactly two of them were resumes.
	if got := f.resumeCount(t, attemptID); got != 2 {
		t.Fatalf("resume_count=%d, want 2 (B and C)", got)
	}
	if got := f.countAttempts(t); got != 1 {
		t.Fatalf("the schedule created %d attempts, want 1", got)
	}
}

// Mandatory test 2: the mutation control.
//
// This proves the test above is not vacuous. It deletes the ONE history row that
// refuses the reuse -- the exact bypass a mutation of the global-history guard
// would produce -- and shows the same schedule then reaches the double-sheet
// path: X arms again, arm A's delayed report matches the now-current arm and
// cancels a live sheet, and a further resume is authorized while that sheet can
// still charge. If the reservation in resumeAppleAttemptTx is ever removed, the
// test above fails and this one explains what it was holding shut.
func TestDeletingTheArmHistoryGuardReopensTheDoubleSheetPath(t *testing.T) {
	f := newAppleContinuationFixture(t)
	const instance = testContinuationInstanceA
	const armX, armY = "arm-A-X", "arm-B-Y"

	attemptID, secret := f.armWith(t, instance, armX)
	f.reportArm(t, attemptID, instance, secret, armX, appleOutcomeUserCancelled)
	if status, _ := f.resumeWith(t, instance, secret, armY); status != http.StatusOK {
		t.Fatalf("resume B: status=%d", status)
	}
	f.reportArm(t, attemptID, instance, secret, armY, appleOutcomeUserCancelled)

	// With the guard intact, X is refused. Asserted here too so this test fails
	// loudly if the schedule stops reproducing rather than silently proving
	// nothing.
	if status, _ := f.resumeWith(t, instance, secret, armX); status != http.StatusForbidden {
		t.Fatalf("precondition: reuse of X should be refused, got status=%d", status)
	}

	// The mutation: bypass the global history for X only. Every other guard --
	// the capability, the instance binding, the generation, and the
	// current-arm CAS predicate -- is left exactly as it is, so what follows is
	// attributable to the history and to nothing else.
	res, err := f.store.db.Exec(`DELETE FROM apple_purchase_arm_ids WHERE attempt_id=? AND arm_request_id=?`, attemptID, armX)
	if err != nil {
		t.Fatal(err)
	}
	if n, err := res.RowsAffected(); err != nil || n != 1 {
		t.Fatalf("the mutation removed %d rows (err=%v); the guard is not where this test thinks it is", n, err)
	}

	// Pre-fix behaviour, reproduced exactly: X <> the current arm Y, so the
	// current-arm comparison alone lets a two-arms-old id open a real sheet.
	status, body := f.resumeWith(t, instance, secret, armX)
	if status != http.StatusOK {
		t.Fatalf("without the history guard the reuse should succeed, proving the guard is load-bearing; got status=%d body=%+v", status, body)
	}
	if got := f.currentArmID(t, attemptID); got != armX {
		t.Fatalf("the resurrected id did not become the current arm: %q", got)
	}
	if _, continuation, _ := f.attemptState(t, attemptID); continuation != appleContinuationArmed {
		t.Fatalf("sheet C is not armed: %q", continuation)
	}

	// And now the loss itself: arm A's delayed duplicate report still names X,
	// which is once again the CURRENT arm, so it cancels a sheet that is live.
	if status, _ := f.reportArm(t, attemptID, instance, secret, armX, appleOutcomeUserCancelled); status != http.StatusOK {
		t.Fatalf("arm A's stale report should now be accepted against live sheet C: status=%d", status)
	}
	if _, continuation, _ := f.attemptState(t, attemptID); continuation != appleContinuationCancelled {
		t.Fatalf("the stale report did not cancel the live sheet: %q", continuation)
	}
	// A further sheet is authorized while sheet C may still charge. Two sheets.
	if status, _ := f.resumeWith(t, instance, secret, "arm-D-W"); status != http.StatusOK {
		t.Fatalf("the double-sheet path did not complete: status=%d", status)
	}
}

// Mandatory test 3: the lost-response replay is untouched by the correction.
//
// Reserving the id must not break the one case that legitimately repeats an id:
// the SAME client re-sending the request that already armed, because it never
// saw the response. That stays 200 and idempotent, arms nothing, and spends no
// new history.
func TestCurrentArmReplayStaysIdempotentAndSpendsNoNewHistory(t *testing.T) {
	f := newAppleContinuationFixture(t)
	const instance = testContinuationInstanceA
	attemptID, secret := f.armWith(t, instance, "arm-initial")
	f.reportArm(t, attemptID, instance, secret, "arm-initial", appleOutcomeUserCancelled)

	status, first := f.resumeWith(t, instance, secret, "arm-resume")
	if status != http.StatusOK || first.AttemptID != attemptID {
		t.Fatalf("first resume: status=%d body=%+v", status, first)
	}
	countBefore := f.resumeCount(t, attemptID)
	historyBefore := f.armHistory(t, attemptID)

	// The lost response, re-sent verbatim.
	status, replay := f.resumeWith(t, instance, secret, "arm-resume")
	if status != http.StatusOK || replay.AttemptID != attemptID || replay.AppAccountToken != first.AppAccountToken {
		t.Fatalf("lost-response replay was refused: status=%d body=%+v", status, replay)
	}
	if replay.ContinuationSecret != "" {
		t.Fatal("the replay re-issued the one-time secret")
	}
	if got := f.resumeCount(t, attemptID); got != countBefore {
		t.Fatalf("the replay armed again: resume_count %d -> %d", countBefore, got)
	}
	if got := f.armHistory(t, attemptID); len(got) != len(historyBefore) {
		t.Fatalf("the replay spent a new arm identity: %v -> %v", historyBefore, got)
	}
	if _, continuation, _ := f.attemptState(t, attemptID); continuation != appleContinuationArmed {
		t.Fatalf("the replay moved the attempt to %q", continuation)
	}

	// While a sheet is OPEN, any id that is not the current arm answers
	// purchase_outcome_required, and the history is deliberately not consulted to
	// reach that answer. This is the correct order, not an exception to the
	// uniform-refusal rule: in the armed state nothing can arm, so a historical
	// id and an id the server has never seen must be indistinguishable. Answering
	// 403 for the historical one would ADD an oracle that tells a caller whether
	// an id was ever spent. The reuse refusal belongs to the cancelled path,
	// where an arm decision is actually made -- asserted immediately below.
	if status, open := f.resumeWith(t, instance, secret, "arm-initial"); status != http.StatusConflict || open.Error != appleRefusalOutcome {
		t.Fatalf("a non-current id against an open sheet: status=%d body=%+v", status, open)
	}
	if status, unseen := f.resumeWith(t, instance, secret, "arm-never-seen"); status != http.StatusConflict || unseen.Error != appleRefusalOutcome {
		t.Fatalf("an unseen id against an open sheet answered differently from a historical one: status=%d body=%+v", status, unseen)
	}
	if got := f.resumeCount(t, attemptID); got != countBefore {
		t.Fatalf("a refusal against an open sheet armed: resume_count %d -> %d", countBefore, got)
	}

	// Cancel the open sheet. NOW the resume path is live, and the initial arm's
	// spent id must fail closed with the uniform capability refusal.
	f.reportArm(t, attemptID, instance, secret, "arm-resume", appleOutcomeUserCancelled)
	if status, reused := f.resumeWith(t, instance, secret, "arm-initial"); status != http.StatusForbidden || reused.Error != appleRefusalCapabilityCode {
		t.Fatalf("the initial arm id was reusable after a resume: status=%d body=%+v", status, reused)
	}
	if got := f.armHistory(t, attemptID); len(got) != 2 {
		t.Fatalf("the refused reuse changed the history: %v", got)
	}
}

// Mandatory test 4: concurrency, for both shapes.
//
// Same historical id concurrently: every one of them must be refused, because
// the id is spent. Distinct fresh ids concurrently: at most one may arm. The
// reservation is an INSERT against a PRIMARY KEY inside the same transaction as
// the cancelled->armed replacement, so neither shape can interleave into two
// sheets.
func TestConcurrentArmIdentitiesNeverAuthorizeTwoSheets(t *testing.T) {
	t.Run("same historical id", func(t *testing.T) {
		f := newAppleContinuationFixture(t)
		const instance = testContinuationInstanceA
		const armX = "arm-A-X"
		attemptID, secret := f.armWith(t, instance, armX)
		f.reportArm(t, attemptID, instance, secret, armX, appleOutcomeUserCancelled)
		if status, _ := f.resumeWith(t, instance, secret, "arm-B-Y"); status != http.StatusOK {
			t.Fatalf("resume B: status=%d", status)
		}
		f.reportArm(t, attemptID, instance, secret, "arm-B-Y", appleOutcomeUserCancelled)
		countBefore := f.resumeCount(t, attemptID)

		statuses := runConcurrentResumes(t, f, instance, secret, func(int) string { return armX })
		if statuses[http.StatusOK] != 0 {
			t.Fatalf("a spent arm id armed under concurrency: %v", statuses)
		}
		if statuses[http.StatusForbidden] != 4 {
			t.Fatalf("want four uniform capability refusals, got %v", statuses)
		}
		if got := f.resumeCount(t, attemptID); got != countBefore {
			t.Fatalf("concurrent reuse armed: resume_count %d -> %d", countBefore, got)
		}
		if _, continuation, _ := f.attemptState(t, attemptID); continuation != appleContinuationCancelled {
			t.Fatalf("concurrent reuse moved the attempt to %q", continuation)
		}
	})

	t.Run("distinct fresh ids", func(t *testing.T) {
		f := newAppleContinuationFixture(t)
		const instance = testContinuationInstanceA
		attemptID, secret := f.armWith(t, instance, "arm-A-X")
		f.reportArm(t, attemptID, instance, secret, "arm-A-X", appleOutcomeUserCancelled)

		statuses := runConcurrentResumes(t, f, instance, secret, func(i int) string {
			return fmt.Sprintf("arm-fresh-%d", i)
		})
		if statuses[http.StatusOK] != 1 {
			t.Fatalf("want exactly one authorized sheet, got %v", statuses)
		}
		if got := f.resumeCount(t, attemptID); got != 1 {
			t.Fatalf("concurrent distinct ids armed %d times", got)
		}
		// Every loser rolled its reservation back, so exactly one fresh id was
		// spent -- alongside the initial arm's.
		if got := f.armHistory(t, attemptID); len(got) != 2 {
			t.Fatalf("concurrent losers burned arm identities: %v", got)
		}
		if got := f.countAttempts(t); got != 1 {
			t.Fatalf("concurrency created %d attempts, want 1", got)
		}
	})
}

// runConcurrentResumes fires four simultaneous resumes and tallies the answers.
func runConcurrentResumes(t *testing.T, f *appleContinuationFixture, instance, secret string, armID func(int) string) map[int]int {
	t.Helper()
	start := make(chan struct{})
	results := make(chan int, 4)
	var wg sync.WaitGroup
	for i := range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			status, _ := f.resumeWith(t, instance, secret, armID(i))
			results <- status
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	counts := map[int]int{}
	for status := range results {
		counts[status]++
	}
	return counts
}

// Mandatory test 5: durability.
//
// Non-reuse is only worth anything if it outlives the process. This uses a real
// file-backed database, commits the reservation, CLOSES the store, reopens it
// and re-runs the migration set, then proves the history is still there and
// still refuses. A bounded last-N window or an in-memory set would fail this.
func TestArmIdentityHistorySurvivesCommitAndReopen(t *testing.T) {
	ctx := context.Background()
	path := t.TempDir() + "/arm-history.db"

	store, err := OpenSQLite(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	const attemptID, userID = "attempt-durable", "user-durable"

	// Spend two ids in one committed transaction, exactly as an arm and a resume
	// would.
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"arm-A-X", "arm-B-Y"} {
		fresh, err := reserveAppleArmIDTx(ctx, tx, attemptID, userID, id, 100)
		if err != nil {
			t.Fatal(err)
		}
		if !fresh {
			t.Fatalf("%s was reported as already spent on a fresh attempt", id)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	// A reservation that LOSES must leave nothing behind when its transaction
	// rolls back, which is what lets a refused caller retry with a fresh id.
	rollback, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if fresh, err := reserveAppleArmIDTx(ctx, rollback, attemptID, userID, "arm-C-Z", 200); err != nil || !fresh {
		t.Fatalf("reserve Z: fresh=%v err=%v", fresh, err)
	}
	if err := rollback.Rollback(); err != nil {
		t.Fatal(err)
	}

	if err := store.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	// Reopen the same file. The migration set must be idempotent over an existing
	// history table, and the committed rows must still be there.
	reopened, err := OpenSQLite(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	t.Cleanup(func() { reopened.Close() })

	var n int
	if err := reopened.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM apple_purchase_arm_ids WHERE attempt_id=?`, attemptID).Scan(&n); err != nil {
		t.Fatalf("read the history after reopen: %v", err)
	}
	if n != 2 {
		t.Fatalf("after reopen the history holds %d ids, want the 2 committed ones", n)
	}

	after, err := reopened.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer after.Rollback()
	// Both committed ids are still refused across the restart.
	for _, id := range []string{"arm-A-X", "arm-B-Y"} {
		fresh, err := reserveAppleArmIDTx(ctx, after, attemptID, userID, id, 300)
		if err != nil {
			t.Fatal(err)
		}
		if fresh {
			t.Fatalf("%s was reusable after a restart; the history is not durable", id)
		}
	}
	// The rolled-back one was never spent.
	if fresh, err := reserveAppleArmIDTx(ctx, after, attemptID, userID, "arm-C-Z", 300); err != nil || !fresh {
		t.Fatalf("a rolled-back reservation burned its id: fresh=%v err=%v", fresh, err)
	}
	// Non-reuse is per ATTEMPT: a different attempt is a different history.
	if fresh, err := reserveAppleArmIDTx(ctx, after, "attempt-other", userID, "arm-A-X", 300); err != nil || !fresh {
		t.Fatalf("the history leaked across attempts: fresh=%v err=%v", fresh, err)
	}
}

// Mandatory test 6: the hard purge takes the history and leaves the ledger.
//
// An arm id is a client-authored identity for one StoreKit sheet on one app
// install, so it is device/capability material and must not outlive the account.
// The financial attempt row and the appAccountToken tombstone are the opposite:
// a late Apple fact still has to be attributable, so they survive on purpose.
func TestHardPurgeRemovesTheArmIdentityHistoryAndKeepsTheLedger(t *testing.T) {
	f := newAppleContinuationFixture(t)
	ctx := context.Background()
	const instance = testContinuationInstanceA

	attemptID, secret := f.armWith(t, instance, "arm-A-X")
	f.reportArm(t, attemptID, instance, secret, "arm-A-X", appleOutcomeUserCancelled)
	if status, _ := f.resumeWith(t, instance, secret, "arm-B-Y"); status != http.StatusOK {
		t.Fatalf("resume before purge: status=%d", status)
	}

	// The fixture must have seeded a real multi-arm history, or the purge
	// assertion below would pass vacuously.
	if got := f.armHistory(t, attemptID); len(got) != 2 {
		t.Fatalf("fixture did not seed a two-arm history: %v", got)
	}
	var product, token string
	var epoch int64
	if err := f.store.db.QueryRowContext(ctx, `SELECT product_id,apple_account_token,epoch FROM billing_purchase_attempts WHERE id=?`, attemptID).
		Scan(&product, &token, &epoch); err != nil {
		t.Fatal(err)
	}

	if err := f.store.SetAccountDeletion(ctx, f.userID, 1, 100); err != nil {
		t.Fatal(err)
	}
	if err := f.store.ArchiveAndPurgeUser(ctx, f.userID, 200); err != nil {
		t.Fatal(err)
	}

	// Removed: every spent arm identity, by row and not merely blanked.
	if got := f.armHistory(t, attemptID); len(got) != 0 {
		t.Fatalf("arm identities survived the hard purge: %v", got)
	}
	var anyForUser int
	if err := f.store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM apple_purchase_arm_ids WHERE user_id=?`, f.userID).Scan(&anyForUser); err != nil {
		t.Fatal(err)
	}
	if anyForUser != 0 {
		t.Fatalf("%d arm identities remain attributable to the purged account", anyForUser)
	}

	// Preserved: the financial attempt ledger a late Apple fact is resolved
	// against, and the tombstone that quarantines it.
	var afterProduct, afterToken, afterState, afterContinuation string
	var afterEpoch int64
	if err := f.store.db.QueryRowContext(ctx, `SELECT product_id,apple_account_token,epoch,state,continuation_state
 FROM billing_purchase_attempts WHERE id=?`, attemptID).
		Scan(&afterProduct, &afterToken, &afterEpoch, &afterState, &afterContinuation); err != nil {
		t.Fatalf("the hard purge destroyed the financial attempt ledger: %v", err)
	}
	if afterProduct != product || afterToken != token || afterEpoch != epoch {
		t.Fatalf("the hard purge altered financial attribution: product %q->%q token %q->%q epoch %d->%d",
			product, afterProduct, token, afterToken, epoch, afterEpoch)
	}
	// The scrubbed attempt is independently unusable, which is why deleting the
	// history cannot reopen the reuse hole: no id can be spent against it again.
	if afterContinuation != appleContinuationLegacy {
		t.Fatalf("continuation_state after purge is %q, want the fail-closed %q", afterContinuation, appleContinuationLegacy)
	}
	var deletedAt int64
	if err := f.store.db.QueryRowContext(ctx, `SELECT deleted_at FROM apple_billing_subjects WHERE app_account_token=?`, token).Scan(&deletedAt); err != nil {
		t.Fatalf("the appAccountToken tombstone did not survive the hard purge: %v", err)
	}
	if deletedAt == 0 {
		t.Fatal("the appAccountToken tombstone was not marked deleted")
	}
}

// The rolling-upgrade path: an attempt armed by a binary older than
// apple_purchase_arm_ids has a current arm id but NO history, so its current id
// would look unspent. The resume path backfills that id before reserving the new
// one, which is what makes the new table additive rather than a data migration.
//
// The pre-history row is simulated by deleting the attempt's history, because no
// end-to-end schedule can produce one -- every arm now reserves. That is also
// why this test exists: without it, deleting the backfill fails nothing.
func TestAnAttemptArmedBeforeTheHistoryExistedHealsOnFirstResume(t *testing.T) {
	f := newAppleContinuationFixture(t)
	const instance = testContinuationInstanceA
	const armX, armY = "arm-old-binary-X", "arm-new-Y"

	attemptID, secret := f.armWith(t, instance, armX)
	f.reportArm(t, attemptID, instance, secret, armX, appleOutcomeUserCancelled)

	// Simulate the pre-history row: the attempt keeps arm_request_id=X, but the
	// history the older binary never wrote is gone.
	if _, err := f.store.db.Exec(`DELETE FROM apple_purchase_arm_ids WHERE attempt_id=?`, attemptID); err != nil {
		t.Fatal(err)
	}
	if got := f.armHistory(t, attemptID); len(got) != 0 {
		t.Fatalf("precondition: the simulated pre-history attempt still has history %v", got)
	}
	if got := f.currentArmID(t, attemptID); got != armX {
		t.Fatalf("precondition: current arm %q, want %q", got, armX)
	}

	// A legitimate resume must still succeed: an upgrade must not lock out an
	// attempt that was armed before the table existed.
	if status, body := f.resumeWith(t, instance, secret, armY); status != http.StatusOK || body.AttemptID != attemptID {
		t.Fatalf("the upgrade locked out a pre-history attempt: status=%d body=%+v", status, body)
	}

	// Healed: the old binary's arm id is now recorded, alongside the new one.
	got := f.armHistory(t, attemptID)
	if len(got) != 2 {
		t.Fatalf("the resume did not backfill the pre-history arm id: %v", got)
	}
	seen := map[string]bool{}
	for _, id := range got {
		seen[id] = true
	}
	if !seen[armX] || !seen[armY] {
		t.Fatalf("history %v does not hold both %s and %s", got, armX, armY)
	}

	// And the healed id is genuinely non-reusable from here on.
	f.reportArm(t, attemptID, instance, secret, armY, appleOutcomeUserCancelled)
	if status, reused := f.resumeWith(t, instance, secret, armX); status != http.StatusForbidden || reused.Error != appleRefusalCapabilityCode {
		t.Fatalf("the backfilled id was still reusable: status=%d body=%+v", status, reused)
	}
}

// ---------------------------------------------------------------------------
// Cross-product resume convergence
// ---------------------------------------------------------------------------

// The defect these cover: resumeAppleAttemptTx ignored the request's ProductID,
// so a cancelled Pro sheet that the user replaced with Plus kept a Pro-labelled
// attempt. Convergence is EXACT on product, so the Plus purchase charged and
// granted correctly and then never resolved -- /transaction answered 409
// purchase_reconciliation_required forever, StoreKit redelivered, and the
// authority generation never advanced. A wedged account AFTER a real charge is
// strictly worse than the zero-charge deadlock the batch was written to fix.

// testAppleProductPlus is a SECOND currently sellable product in the same
// bundle. It has to be a different PLAN, not merely a different product id: the
// honest path this covers is the user changing their mind about what to buy.
const testAppleProductPlus = "com.relayium.app.plus.monthly"

// sellPlusProduct maps the second product into the catalog. Without it the
// handler refuses the resume with product_unavailable long before the store is
// reached, which would make every assertion below vacuous.
func (f *appleContinuationFixture) sellPlusProduct(t *testing.T) {
	t.Helper()
	mustAppleProduct(t, f.store, AppleProduct{
		BundleID: testBundleIOS, ProductID: testAppleProductPlus,
		PlanID: "plus", Cycle: "monthly", Active: true,
	})
}

// resumeProduct resumes under an explicit arm identity AND an explicit product,
// without asserting success.
func (f *appleContinuationFixture) resumeProduct(t *testing.T, instance, secret, armRequestID, productID string) (int, dispatchBody) {
	t.Helper()
	return f.dispatch(t, map[string]string{
		"bundleId": testBundleIOS, "productId": productID,
		"appInstanceId": instance, "continuationSecret": secret,
		"armRequestId": armRequestID,
	})
}

// attemptProduct reads the product the attempt currently claims to be for. This
// is the exact value ApplyAuthorizedAppleSource compares against.
func (f *appleContinuationFixture) attemptProduct(t *testing.T, attemptID string) string {
	t.Helper()
	var productID string
	if err := f.store.db.QueryRow(`SELECT product_id FROM billing_purchase_attempts WHERE id=?`, attemptID).Scan(&productID); err != nil {
		t.Fatalf("read attempt product %s: %v", attemptID, err)
	}
	return productID
}

func (f *appleContinuationFixture) attemptToken(t *testing.T, attemptID string) string {
	t.Helper()
	var token string
	if err := f.store.db.QueryRow(`SELECT apple_account_token FROM billing_purchase_attempts WHERE id=?`, attemptID).Scan(&token); err != nil {
		t.Fatalf("read attempt token %s: %v", attemptID, err)
	}
	return token
}

// cancelledThenResumedOnPlus is the shared setup: arm Pro, report an explicit
// .userCancelled, then re-arm on Plus. It returns the attempt id, the secret and
// the attribution token, and asserts the re-arm actually happened.
func (f *appleContinuationFixture) cancelledThenResumedOnPlus(t *testing.T, armID string) (attemptID, secret, token string) {
	t.Helper()
	f.sellPlusProduct(t)
	attemptID, secret = f.arm(t, testContinuationInstanceA)
	if got := f.attemptProduct(t, attemptID); got != testAppleProduct {
		t.Fatalf("initial arm product: %q", got)
	}
	if status, body := f.report(t, attemptID, testContinuationInstanceA, secret, appleOutcomeUserCancelled); status != http.StatusOK || body["resumable"] != true {
		t.Fatalf("cancel report: status=%d body=%v", status, body)
	}
	status, resumed := f.resumeProduct(t, testContinuationInstanceA, secret, armID, testAppleProductPlus)
	if status != http.StatusOK || resumed.AttemptID != attemptID {
		t.Fatalf("cross-product resume: status=%d body=%+v", status, resumed)
	}
	if resumed.ContinuationSecret != "" {
		t.Fatal("a resume re-issued the one-time secret")
	}
	return attemptID, secret, f.attemptToken(t, attemptID)
}

// Mandatory test 1: the re-arm moves the product, and the NEW product's verified
// transaction then converges and finishes the attempt.
//
// Every part of the move is asserted together, because they are one fact: an
// attempt whose product and arm identity disagree is an attempt a delayed report
// for the abandoned product could still resolve.
func TestCrossProductResumeMovesTheAttemptAndConverges(t *testing.T) {
	f := newAppleContinuationFixture(t)
	attemptID, _, token := f.cancelledThenResumedOnPlus(t, "arm-plus")

	if got := f.attemptProduct(t, attemptID); got != testAppleProductPlus {
		t.Fatalf("the re-arm left the attempt on the abandoned product: %q", got)
	}
	if got := f.currentArmID(t, attemptID); got != "arm-plus" {
		t.Fatalf("current arm: %q", got)
	}
	if got := f.resumeCount(t, attemptID); got != 1 {
		t.Fatalf("resume_count: %d", got)
	}
	if state, continuation, outcome := f.attemptState(t, attemptID); state != "dispatched" || continuation != appleContinuationArmed || outcome != "" {
		t.Fatalf("re-armed attempt: state=%q continuation=%q outcome=%q", state, continuation, outcome)
	}
	if history := f.armHistory(t, attemptID); len(history) != 2 {
		t.Fatalf("arm history after one resume: %v", history)
	}
	if n := f.countAttempts(t); n != 1 {
		t.Fatalf("the resume created %d attempts", n)
	}

	// The user buys what they actually selected. This is the assertion the
	// defect broke: before the correction it charged, granted, and never resolved.
	result, _ := f.mustAccept(t, f.chain.sign(t, applePayload(func(p map[string]any) {
		p["appAccountToken"] = token
		p["productId"] = testAppleProductPlus
	})))
	if !result.Applied || result.PlanID != "plus" {
		t.Fatalf("the new product did not grant: %+v", result)
	}
	if result.DispatchPending || !result.DispatchResolved {
		t.Fatalf("the new product did not converge: %+v", result)
	}
	if state, _, _ := f.attemptState(t, attemptID); state != "resolved" {
		t.Fatalf("the new product left the dispatch pending: %q", state)
	}
}

// Mandatory test 2: the exact-product guard is still load-bearing in the other
// direction. A delayed transaction for the ABANDONED product must not resolve
// the newly armed one.
//
// This is the half that makes the correction safe rather than merely convenient:
// if moving the product also made the old product resolve, a late Pro charge
// would release a Plus sheet that may still be open.
func TestADelayedOldProductFactCannotResolveTheNewArm(t *testing.T) {
	f := newAppleContinuationFixture(t)
	attemptID, _, token := f.cancelledThenResumedOnPlus(t, "arm-plus")

	ctx := context.Background()
	before, ok, err := f.store.BillingAuthority(ctx, f.userID)
	if err != nil || !ok {
		t.Fatalf("read authority: ok=%v err=%v", ok, err)
	}

	// Apple delivers a signed transaction for the product the user ABANDONED.
	// It is genuine and it is attributed to this attempt's token, so it grants --
	// but it says nothing about the Plus sheet that is open now, and the endpoint
	// must say so rather than release the dispatch.
	f.mustReject(t, f.chain.sign(t, applePayload(func(p map[string]any) {
		p["appAccountToken"] = token
		p["productId"] = testAppleProduct
	})), http.StatusConflict, "purchase_reconciliation_required")

	if state, continuation, _ := f.attemptState(t, attemptID); state != "dispatched" || continuation != appleContinuationArmed {
		t.Fatalf("the old product resolved the new arm: state=%q continuation=%q", state, continuation)
	}
	if got := f.attemptProduct(t, attemptID); got != testAppleProductPlus {
		t.Fatalf("the old product rewrote the attempt: %q", got)
	}
	if got := f.currentArmID(t, attemptID); got != "arm-plus" {
		t.Fatalf("the old product moved the current arm: %q", got)
	}

	// The generation must not advance: advancing is what frees the account to
	// arm a THIRD sheet, and nothing here proved the Plus sheet is finished.
	after, ok, err := f.store.BillingAuthority(ctx, f.userID)
	if err != nil || !ok {
		t.Fatalf("re-read authority: ok=%v err=%v", ok, err)
	}
	if after.Epoch != before.Epoch || after.IntentID != before.IntentID {
		t.Fatalf("an unconverged fact advanced the authority: before=%d/%s after=%d/%s",
			before.Epoch, before.IntentID, after.Epoch, after.IntentID)
	}

	// And the attempt is still genuinely OPEN rather than merely unresolved: the
	// product the user actually selected still converges on the very next
	// delivery. The ids are left at the payload default on purpose, so this is
	// the SAME subscription moving Pro -> Plus within its group. Minting a second
	// originalTransactionId here would be a second distinct live subscription,
	// which this server refuses on its own separate grounds and would prove
	// nothing about the product guard.
	result, _ := f.mustAccept(t, f.chain.sign(t, applePayload(func(p map[string]any) {
		p["appAccountToken"] = token
		p["productId"] = testAppleProductPlus
	})))
	if !result.DispatchResolved {
		t.Fatalf("the armed product stopped converging: %+v", result)
	}
	if state, _, _ := f.attemptState(t, attemptID); state != "resolved" {
		t.Fatalf("the armed product left the dispatch pending: %q", state)
	}
}

// Mandatory test 3: the lost-RESUME-response replay still works for the same
// product, and the same id under a DIFFERENT product is refused without
// touching anything.
func TestCurrentArmReplayIsBoundToItsProduct(t *testing.T) {
	f := newAppleContinuationFixture(t)
	attemptID, secret, _ := f.cancelledThenResumedOnPlus(t, "arm-plus")
	historyBefore := f.armHistory(t, attemptID)

	// Same arm, same product: the lost response, re-sent verbatim.
	status, replay := f.resumeProduct(t, testContinuationInstanceA, secret, "arm-plus", testAppleProductPlus)
	if status != http.StatusOK || replay.AttemptID != attemptID {
		t.Fatalf("same-product replay was refused: status=%d body=%+v", status, replay)
	}
	if replay.ContinuationSecret != "" {
		t.Fatal("a replay re-issued the one-time secret")
	}
	if got := f.resumeCount(t, attemptID); got != 1 {
		t.Fatalf("a replay armed again: resume_count=%d", got)
	}

	// Same arm, DIFFERENT product: not a replay at all. It asks to repoint a
	// sheet that is already open, and must change nothing.
	status, mismatch := f.resumeProduct(t, testContinuationInstanceA, secret, "arm-plus", testAppleProduct)
	if status != http.StatusConflict || mismatch.Error != appleRefusalOutcome {
		t.Fatalf("same arm with a different product was not refused: status=%d body=%+v", status, mismatch)
	}
	if mismatch.AttemptID != "" || mismatch.AppAccountToken != "" || mismatch.ContinuationSecret != "" {
		t.Fatalf("a refusal leaked dispatch material: %+v", mismatch)
	}
	if got := f.attemptProduct(t, attemptID); got != testAppleProductPlus {
		t.Fatalf("the refused request repointed the attempt: %q", got)
	}
	if got := f.currentArmID(t, attemptID); got != "arm-plus" {
		t.Fatalf("the refused request moved the current arm: %q", got)
	}
	if got := f.resumeCount(t, attemptID); got != 1 {
		t.Fatalf("the refused request incremented resume_count: %d", got)
	}
	if got := f.armHistory(t, attemptID); len(got) != len(historyBefore) {
		t.Fatalf("the refused request spent history: before=%v after=%v", historyBefore, got)
	}
	if state, continuation, outcome := f.attemptState(t, attemptID); state != "dispatched" || continuation != appleContinuationArmed || outcome != "" {
		t.Fatalf("the refused request moved the attempt: state=%q continuation=%q outcome=%q", state, continuation, outcome)
	}
}

// Mandatory test 4: concurrent resumes for DIFFERENT products and different
// fresh ids authorize at most one sheet, the stored product is the winner's own
// request, and the losers burn nothing.
func TestConcurrentCrossProductResumesAuthorizeExactlyOneSheet(t *testing.T) {
	f := newAppleContinuationFixture(t)
	f.sellPlusProduct(t)
	attemptID, secret := f.arm(t, testContinuationInstanceA)
	if status, _ := f.report(t, attemptID, testContinuationInstanceA, secret, appleOutcomeUserCancelled); status != http.StatusOK {
		t.Fatalf("cancel report: %d", status)
	}

	type resumeAttempt struct {
		armID, productID string
		status           int
	}
	products := []string{testAppleProduct, testAppleProductPlus}
	results := make(chan resumeAttempt, 4)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			a := resumeAttempt{armID: fmt.Sprintf("arm-concurrent-%d", i), productID: products[i%2]}
			<-start
			a.status, _ = f.resumeProduct(t, testContinuationInstanceA, secret, a.armID, a.productID)
			results <- a
		}()
	}
	close(start)
	wg.Wait()
	close(results)

	var winner resumeAttempt
	var losers []resumeAttempt
	won := 0
	for a := range results {
		if a.status == http.StatusOK {
			won++
			winner = a
			continue
		}
		if a.status != http.StatusConflict && a.status != http.StatusForbidden {
			t.Fatalf("a losing resume neither armed nor failed closed: %+v", a)
		}
		losers = append(losers, a)
	}
	if won != 1 {
		t.Fatalf("concurrent cross-product resumes authorized %d sheets", won)
	}
	if got := f.attemptProduct(t, attemptID); got != winner.productID {
		t.Fatalf("stored product %q is not the winning request's %q", got, winner.productID)
	}
	if got := f.currentArmID(t, attemptID); got != winner.armID {
		t.Fatalf("current arm %q is not the winner's %q", got, winner.armID)
	}
	if got := f.resumeCount(t, attemptID); got != 1 {
		t.Fatalf("more than one re-arm committed: resume_count=%d", got)
	}
	// The losers' ids must be unspent. Only the initial arm and the winner's id
	// may appear in the history at all.
	history := f.armHistory(t, attemptID)
	if len(history) != 2 {
		t.Fatalf("a refused resume burned its arm id: %v", history)
	}
	for _, l := range losers {
		for _, spent := range history {
			if spent == l.armID {
				t.Fatalf("loser %q was spent: %v", l.armID, history)
			}
		}
	}
	// The strong form: cancel the winner's sheet and a loser's id still works.
	if status, _ := f.reportArm(t, attemptID, testContinuationInstanceA, secret, winner.armID, appleOutcomeUserCancelled); status != http.StatusOK {
		t.Fatalf("cancelling the winner: %d", status)
	}
	loser := losers[0]
	status, retry := f.resumeProduct(t, testContinuationInstanceA, secret, loser.armID, loser.productID)
	if status != http.StatusOK || retry.AttemptID != attemptID {
		t.Fatalf("a loser's unspent id was refused: status=%d body=%+v", status, retry)
	}
	if got := f.attemptProduct(t, attemptID); got != loser.productID {
		t.Fatalf("the loser's retry did not move the product: %q", got)
	}
}
