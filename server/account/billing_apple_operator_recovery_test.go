package account

import (
	"context"
	"strings"
	"testing"
)

const legacyRecoveryToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const failedRecoveryInstance = "11111111-1111-4111-8111-111111111111"
const failedRecoveryArm = "22222222-2222-4222-8222-222222222222"

func seedLegacyAppleRecovery(t *testing.T) (*SQLiteStore, User, BillingAuthority, BillingPurchaseAttempt) {
	t.Helper()
	store := newTestStore(t)
	u, err := store.UpsertUserByEmail(context.Background(), "legacy-recovery@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	authority, err := store.AcquireBillingAuthority(context.Background(), BillingAuthorityRequest{
		UserID: u.ID, Provider: ProviderApple, ExternalScope: testBundleMac,
		AppleAccountToken: legacyRecoveryToken, Now: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	attempt, created, err := store.DispatchAppleBillingPurchase(context.Background(), authority, "com.relayium.mac.plus.monthly", legacyRecoveryToken, 101)
	if err != nil || !created {
		t.Fatalf("dispatch created=%t err=%v", created, err)
	}
	return store, u, authority, attempt
}

func seedLockedFailedAppleRecovery(t *testing.T) (*SQLiteStore, User, BillingAuthority, BillingPurchaseAttempt) {
	t.Helper()
	store := newTestStore(t)
	u, err := store.UpsertUserByEmail(context.Background(), "locked-failed-recovery@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	authority, err := store.AcquireBillingAuthority(context.Background(), BillingAuthorityRequest{
		UserID: u.ID, Provider: ProviderApple, ExternalScope: testBundleMac,
		AppleAccountToken: legacyRecoveryToken, Now: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	secret := testContinuationSecret(0x71)
	out, err := store.ArmAppleBillingPurchase(context.Background(), authority, AppleDispatchRequest{
		ProductID: "com.relayium.mac.plus.monthly", CandidateToken: legacyRecoveryToken,
		ContinuationProtocol: appleContinuationProtocolAttemptIDV2,
		AppInstanceID:        failedRecoveryInstance, ContinuationSecret: secret,
		ArmRequestID: failedRecoveryArm, Now: 101,
	})
	if err != nil || !out.Armed {
		t.Fatalf("arm=%+v err=%v", out, err)
	}
	recorded, err := store.RecordAppleBillingPurchaseOutcome(context.Background(), AppleOutcomeRequest{
		UserID: u.ID, AttemptID: out.Attempt.ID, BundleID: testBundleMac,
		AppInstanceID: failedRecoveryInstance, ContinuationSecret: secret,
		ArmRequestID: failedRecoveryArm, Outcome: appleOutcomeFailed, Now: 102,
	})
	if err != nil || !recorded.Accepted || recorded.Resumable {
		t.Fatalf("outcome=%+v err=%v", recorded, err)
	}
	return store, u, authority, out.Attempt
}

func TestAppleLegacyPurchaseRecoveryListsBoundedEvidence(t *testing.T) {
	store, _, authority, attempt := seedLegacyAppleRecovery(t)
	evidence, err := ListAppleLegacyPurchaseRecoveryEvidence(context.Background(), store, "legacy-recovery@example.test")
	if err != nil {
		t.Fatal(err)
	}
	if !evidence.Eligible || evidence.AttemptID != attempt.ID || evidence.AuthorityEpoch != authority.Epoch || len(evidence.Digest) != 64 {
		t.Fatalf("evidence=%+v", evidence)
	}
	raw := evidence.Digest + strings.Join(evidence.Blockers, ",")
	if strings.Contains(raw, legacyRecoveryToken) {
		t.Fatal("evidence exposed the Apple account token")
	}
}

func TestAppleLegacyPurchaseRecoveryResolvesAndPreservesAttribution(t *testing.T) {
	store, _, authority, attempt := seedLegacyAppleRecovery(t)
	evidence, err := ListAppleLegacyPurchaseRecoveryEvidence(context.Background(), store, attempt.ID)
	if err != nil {
		t.Fatal(err)
	}
	result, err := ReleaseAppleLegacyPurchase(context.Background(), store, attempt.ID, "owner", "confirmed no completed purchase", evidence.Digest)
	if err != nil {
		t.Fatal(err)
	}
	if result.AttemptID != attempt.ID || result.Epoch != authority.Epoch+1 {
		t.Fatalf("result=%+v", result)
	}
	if result.Shape != "legacy_one_shot" {
		t.Fatalf("recovery shape=%q", result.Shape)
	}
	var state string
	if err := store.db.QueryRow(`SELECT state FROM billing_purchase_attempts WHERE id=?`, attempt.ID).Scan(&state); err != nil || state != "resolved" {
		t.Fatalf("state=%q err=%v", state, err)
	}
	if got, ok, err := store.AppleBillingSubjectByToken(context.Background(), legacyRecoveryToken); err != nil || !ok || got.AttemptID != attempt.ID {
		t.Fatalf("subject=%+v ok=%t err=%v", got, ok, err)
	}
	var action, target string
	if err := store.db.QueryRow(`SELECT action,target FROM admin_audit ORDER BY id DESC LIMIT 1`).Scan(&action, &target); err != nil || action != AuditAppleLegacyRelease || target != "apple-attempt:"+attempt.ID {
		t.Fatalf("audit action=%q target=%q err=%v", action, target, err)
	}
}

func TestApplePurchaseRecoveryReleasesOnlyAnAuditedLockedFailedContinuation(t *testing.T) {
	store, _, authority, attempt := seedLockedFailedAppleRecovery(t)
	evidence, err := ListAppleLegacyPurchaseRecoveryEvidence(context.Background(), store, attempt.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !evidence.Eligible || evidence.RecoveryShape != "locked_failed_continuation" ||
		!evidence.AppInstanceBound || !evidence.ArmBound {
		t.Fatalf("evidence=%+v", evidence)
	}
	result, err := ReleaseAppleLegacyPurchase(context.Background(), store, attempt.ID,
		"owner", "observed explicit StoreKit cancellation on affected client", evidence.Digest)
	if err != nil {
		t.Fatal(err)
	}
	if result.AttemptID != attempt.ID || result.Epoch != authority.Epoch+1 {
		t.Fatalf("result=%+v", result)
	}
	if result.Shape != "locked_failed_continuation" {
		t.Fatalf("recovery shape=%q", result.Shape)
	}
	var state string
	if err := store.db.QueryRow(`SELECT state FROM billing_purchase_attempts WHERE id=?`, attempt.ID).Scan(&state); err != nil || state != "resolved" {
		t.Fatalf("state=%q err=%v", state, err)
	}
	if got, ok, err := store.AppleBillingSubjectByToken(context.Background(), legacyRecoveryToken); err != nil || !ok || got.AttemptID != attempt.ID {
		t.Fatalf("subject=%+v ok=%t err=%v", got, ok, err)
	}
}

func TestApplePurchaseRecoveryStillRefusesPendingContinuation(t *testing.T) {
	store, _, _, attempt := seedLockedFailedAppleRecovery(t)
	if _, err := store.db.Exec(`UPDATE billing_purchase_attempts SET client_outcome=? WHERE id=?`, appleOutcomePending, attempt.ID); err != nil {
		t.Fatal(err)
	}
	evidence, err := ListAppleLegacyPurchaseRecoveryEvidence(context.Background(), store, attempt.ID)
	if err != nil {
		t.Fatal(err)
	}
	if evidence.Eligible || !strings.Contains(strings.Join(evidence.Blockers, ","), "unsupported_recovery_shape") {
		t.Fatalf("evidence=%+v", evidence)
	}
}

func TestApplePurchaseRecoveryStillRefusesSuccessfulContinuation(t *testing.T) {
	store, _, _, attempt := seedLockedFailedAppleRecovery(t)
	if _, err := store.db.Exec(`UPDATE billing_purchase_attempts SET client_outcome=? WHERE id=?`, appleOutcomeSuccess, attempt.ID); err != nil {
		t.Fatal(err)
	}
	evidence, err := ListAppleLegacyPurchaseRecoveryEvidence(context.Background(), store, attempt.ID)
	if err != nil {
		t.Fatal(err)
	}
	if evidence.Eligible || !strings.Contains(strings.Join(evidence.Blockers, ","), "unsupported_recovery_shape") {
		t.Fatalf("evidence=%+v", evidence)
	}
}

func TestApplePurchaseRecoveryPreservesLateSignedTransactionConvergence(t *testing.T) {
	store, u, _, attempt := seedLockedFailedAppleRecovery(t)
	evidence, err := ListAppleLegacyPurchaseRecoveryEvidence(context.Background(), store, attempt.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ReleaseAppleLegacyPurchase(context.Background(), store, attempt.ID,
		"owner", "observed explicit StoreKit cancellation on affected client", evidence.Digest); err != nil {
		t.Fatal(err)
	}
	event := SourceEvent{
		UserID: u.ID, Provider: ProviderApple, PlanID: "plus", Status: "active", Cycle: "monthly",
		PeriodEnd: 10_000, ExternalID: "sandbox:late-original", ExternalScope: testBundleMac,
		BillingProductID: "com.relayium.mac.plus.monthly", EventAt: 200, Now: 200,
	}
	result, err := store.ApplyAuthorizedAppleSource(context.Background(), event,
		legacyRecoveryToken, appleEnvSandbox, event.BillingProductID)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Applied || !result.PurchaseAttemptResolved ||
		result.PurchaseAttemptResolvedID != attempt.ID || result.Effective.PlanID != "plus" {
		t.Fatalf("late transaction result=%+v", result)
	}
	source, ok, err := store.GetSubscriptionSource(context.Background(), u.ID, ProviderApple)
	if err != nil || !ok || source.PlanID != "plus" || source.ExternalID != event.ExternalID {
		t.Fatalf("source=%+v ok=%t err=%v", source, ok, err)
	}
}

func TestApplePurchaseRecoveryRefusesEvidenceChangedAfterListing(t *testing.T) {
	store, _, _, attempt := seedLockedFailedAppleRecovery(t)
	evidence, err := ListAppleLegacyPurchaseRecoveryEvidence(context.Background(), store, attempt.ID)
	if err != nil || !evidence.Eligible {
		t.Fatalf("evidence=%+v err=%v", evidence, err)
	}
	if _, err := store.db.Exec(`UPDATE billing_purchase_attempts SET client_outcome=? WHERE id=?`, appleOutcomePending, attempt.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := ReleaseAppleLegacyPurchase(context.Background(), store, attempt.ID,
		"owner", "stale operator observation", evidence.Digest); err == nil || !strings.Contains(err.Error(), "evidence changed") {
		t.Fatalf("err=%v", err)
	}
	var state string
	_ = store.db.QueryRow(`SELECT state FROM billing_purchase_attempts WHERE id=?`, attempt.ID).Scan(&state)
	if state != "dispatched" {
		t.Fatalf("stale evidence changed attempt to %q", state)
	}
}

func TestAppleLegacyPurchaseRecoveryAuditActionIsFilterable(t *testing.T) {
	for _, action := range auditActions {
		if action == AuditAppleLegacyRelease {
			return
		}
	}
	t.Fatalf("%s is missing from the audit filter list", AuditAppleLegacyRelease)
}

func TestAppleLegacyPurchaseRecoveryRefusesStaleEvidence(t *testing.T) {
	store, _, _, attempt := seedLegacyAppleRecovery(t)
	if _, err := ReleaseAppleLegacyPurchase(context.Background(), store, attempt.ID, "owner", "confirmed", strings.Repeat("0", 64)); err == nil || !strings.Contains(err.Error(), "evidence changed") {
		t.Fatalf("err=%v", err)
	}
	var state string
	_ = store.db.QueryRow(`SELECT state FROM billing_purchase_attempts WHERE id=?`, attempt.ID).Scan(&state)
	if state != "dispatched" {
		t.Fatalf("stale evidence changed attempt to %q", state)
	}
}

func TestAppleLegacyPurchaseRecoveryRefusesVerifiedAppleEvidence(t *testing.T) {
	store, u, _, attempt := seedLegacyAppleRecovery(t)
	if _, err := store.db.Exec(`UPDATE billing_authorities SET apple_environment=? WHERE user_id=?`, appleEnvSandbox, u.ID); err != nil {
		t.Fatal(err)
	}
	evidence, err := ListAppleLegacyPurchaseRecoveryEvidence(context.Background(), store, attempt.ID)
	if err != nil {
		t.Fatal(err)
	}
	if evidence.Eligible || !strings.Contains(strings.Join(evidence.Blockers, ","), "verified_environment_present") {
		t.Fatalf("evidence=%+v", evidence)
	}
	if _, err := ReleaseAppleLegacyPurchase(context.Background(), store, attempt.ID, "owner", "confirmed", evidence.Digest); err == nil || !strings.Contains(err.Error(), "not releasable") {
		t.Fatalf("err=%v", err)
	}
}

func TestAppleLegacyPurchaseRecoveryRefusesArmedContinuationAttempt(t *testing.T) {
	store := newTestStore(t)
	u, _ := store.UpsertUserByEmail(context.Background(), "new-protocol@example.test", "")
	authority, _ := store.AcquireBillingAuthority(context.Background(), BillingAuthorityRequest{UserID: u.ID, Provider: ProviderApple, ExternalScope: testBundleMac, AppleAccountToken: legacyRecoveryToken, Now: 100})
	out, err := store.ArmAppleBillingPurchase(context.Background(), authority, AppleDispatchRequest{
		ProductID: "com.relayium.mac.plus.monthly", CandidateToken: legacyRecoveryToken,
		ContinuationProtocol: appleContinuationProtocolAttemptIDV2,
		AppInstanceID:        "11111111-1111-4111-8111-111111111111",
		ContinuationSecret:   testContinuationSecret(0x52),
		ArmRequestID:         "22222222-2222-4222-8222-222222222222", Now: 101,
	})
	if err != nil || !out.Armed {
		t.Fatalf("arm=%+v err=%v", out, err)
	}
	evidence, err := ListAppleLegacyPurchaseRecoveryEvidence(context.Background(), store, out.Attempt.ID)
	if err != nil {
		t.Fatal(err)
	}
	if evidence.Eligible || !strings.Contains(strings.Join(evidence.Blockers, ","), "unsupported_recovery_shape") {
		t.Fatalf("evidence=%+v", evidence)
	}
}
