package account

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// AppleLegacyPurchaseRecoveryEvidence is the non-secret snapshot an operator
// must inspect before releasing one purchase attempt created by a legacy client.
// Digest binds the later mutation to this exact snapshot.
type AppleLegacyPurchaseRecoveryEvidence struct {
	AttemptID            string   `json:"attemptId"`
	BundleID             string   `json:"bundleId"`
	ProductID            string   `json:"productId"`
	AttemptState         string   `json:"attemptState"`
	ContinuationState    string   `json:"continuationState"`
	AuthorityEnvironment string   `json:"authorityEnvironment"`
	AuthorityEpoch       int64    `json:"authorityEpoch"`
	SubjectCount         int      `json:"subjectCount"`
	SourceCount          int      `json:"sourceCount"`
	RenewalCount         int      `json:"renewalCount"`
	ExternalSubjectCount int      `json:"externalSubjectCount"`
	IncidentCount        int      `json:"incidentCount"`
	Eligible             bool     `json:"eligible"`
	Blockers             []string `json:"blockers"`
	Digest               string   `json:"digest"`

	userID       string
	authority    BillingAuthority
	attemptToken string
}

type appleLegacyRecoveryScanner interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func loadAppleLegacyPurchaseRecoveryEvidence(ctx context.Context, q appleLegacyRecoveryScanner, selector string) (AppleLegacyPurchaseRecoveryEvidence, error) {
	selector = strings.TrimSpace(selector)
	if selector == "" {
		return AppleLegacyPurchaseRecoveryEvidence{}, errors.New("account: Apple legacy purchase attempt id or account email is required")
	}

	var out AppleLegacyPurchaseRecoveryEvidence
	var provider, authorityScope, authorityToken, planID, planSource, appInstanceID, clientOutcome string
	err := q.QueryRowContext(ctx, `SELECT a.id,a.user_id,a.external_scope,a.product_id,a.state,
 a.continuation_state,a.app_instance_id,a.client_outcome,a.apple_account_token,a.epoch,
 ba.provider,ba.external_scope,ba.apple_environment,ba.apple_account_token,ba.intent_id,
 ba.created_at,ba.updated_at,u.plan_id,u.plan_source
 FROM billing_purchase_attempts a
 JOIN users u ON u.id=a.user_id
 JOIN billing_authorities ba ON ba.user_id=a.user_id AND ba.epoch=a.epoch
 WHERE a.provider=? AND a.state='dispatched'
   AND (a.id=? OR lower(u.email)=lower(?))
 ORDER BY CASE WHEN a.id=? THEN 0 ELSE 1 END,a.created_at DESC
 LIMIT 1`, ProviderApple, selector, selector, selector).Scan(
		&out.AttemptID, &out.userID, &out.BundleID, &out.ProductID, &out.AttemptState,
		&out.ContinuationState, &appInstanceID, &clientOutcome, &out.attemptToken, &out.AuthorityEpoch,
		&provider, &authorityScope, &out.AuthorityEnvironment, &authorityToken, &out.authority.IntentID,
		&out.authority.CreatedAt, &out.authority.UpdatedAt, &planID, &planSource)
	if err != nil {
		return AppleLegacyPurchaseRecoveryEvidence{}, err
	}
	out.authority.UserID = out.userID
	out.authority.Provider = provider
	out.authority.ExternalScope = authorityScope
	out.authority.AppleEnvironment = out.AuthorityEnvironment
	out.authority.AppleAccountToken = authorityToken
	out.authority.Epoch = out.AuthorityEpoch

	var exactSubjects, subjectWithEnvironment, deletedSubjects int
	if err := q.QueryRowContext(ctx, `SELECT count(*),
 COALESCE(sum(CASE WHEN app_account_token=? THEN 1 ELSE 0 END),0),
 COALESCE(sum(CASE WHEN environment<>'' THEN 1 ELSE 0 END),0),
 COALESCE(sum(CASE WHEN deleted_at<>0 THEN 1 ELSE 0 END),0)
 FROM apple_billing_subjects WHERE attempt_id=?`, out.attemptToken, out.AttemptID).
		Scan(&out.SubjectCount, &exactSubjects, &subjectWithEnvironment, &deletedSubjects); err != nil {
		return AppleLegacyPurchaseRecoveryEvidence{}, err
	}
	if err := q.QueryRowContext(ctx, `SELECT count(*) FROM subscription_sources WHERE user_id=? AND provider=?`, out.userID, ProviderApple).Scan(&out.SourceCount); err != nil {
		return AppleLegacyPurchaseRecoveryEvidence{}, err
	}
	if err := q.QueryRowContext(ctx, `SELECT count(*) FROM apple_renewal_states WHERE user_id=?`, out.userID).Scan(&out.RenewalCount); err != nil {
		return AppleLegacyPurchaseRecoveryEvidence{}, err
	}
	if err := q.QueryRowContext(ctx, `SELECT count(*) FROM apple_billing_external_subjects WHERE user_id=? AND deleted_at=0`, out.userID).Scan(&out.ExternalSubjectCount); err != nil {
		return AppleLegacyPurchaseRecoveryEvidence{}, err
	}
	if err := q.QueryRowContext(ctx, `SELECT count(*) FROM apple_billing_incidents WHERE user_id=?`, out.userID).Scan(&out.IncidentCount); err != nil {
		return AppleLegacyPurchaseRecoveryEvidence{}, err
	}

	addBlocker := func(condition bool, name string) {
		if condition {
			out.Blockers = append(out.Blockers, name)
		}
	}
	addBlocker(out.AttemptState != "dispatched", "attempt_not_dispatched")
	addBlocker(out.ContinuationState != "" || appInstanceID != "" || clientOutcome != "", "not_legacy_one_shot")
	addBlocker(provider != ProviderApple || authorityScope != out.BundleID, "authority_mismatch")
	addBlocker(out.AuthorityEnvironment != "", "verified_environment_present")
	addBlocker(out.attemptToken == "" || out.SubjectCount != 1 || exactSubjects != 1 || subjectWithEnvironment != 0 || deletedSubjects != 0, "attribution_subject_not_pristine")
	addBlocker(out.SourceCount != 0, "apple_source_present")
	addBlocker(out.RenewalCount != 0, "apple_renewal_present")
	addBlocker(out.ExternalSubjectCount != 0, "apple_external_subject_present")
	addBlocker(out.IncidentCount != 0, "apple_billing_incident_present")
	addBlocker(planID != freePlanID || planSource == ProviderApple || planSource == SourceAdmin, "account_entitlement_not_free")
	out.Eligible = len(out.Blockers) == 0
	if out.Blockers == nil {
		out.Blockers = []string{}
	}
	digestInput := out
	digestInput.Digest = ""
	raw, err := json.Marshal(digestInput)
	if err != nil {
		return AppleLegacyPurchaseRecoveryEvidence{}, err
	}
	sum := sha256.Sum256(append([]byte("relayium:apple-legacy-purchase-recovery:v1\x00"), raw...))
	out.Digest = hex.EncodeToString(sum[:])
	return out, nil
}

func ListAppleLegacyPurchaseRecoveryEvidence(ctx context.Context, store *SQLiteStore, selector string) (AppleLegacyPurchaseRecoveryEvidence, error) {
	if store == nil {
		return AppleLegacyPurchaseRecoveryEvidence{}, errors.New("account: Apple legacy purchase recovery store is unavailable")
	}
	tx, err := store.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return AppleLegacyPurchaseRecoveryEvidence{}, err
	}
	defer tx.Rollback()
	out, err := loadAppleLegacyPurchaseRecoveryEvidence(ctx, tx, selector)
	if err != nil {
		return AppleLegacyPurchaseRecoveryEvidence{}, err
	}
	return out, tx.Commit()
}

type AppleLegacyPurchaseRecoveryResult struct {
	AttemptID string
	Epoch     int64
}

// ReleaseAppleLegacyPurchase is an owner-audited escape hatch for attempts made
// by pre-continuation clients. Apple exposes no lookup by appAccountToken, so the
// absence of a transaction can never be inferred from time. This operation is
// intentionally manual, evidence-bound, and preserves both the attempt ledger
// and its attribution subject for any transaction that arrives later.
func ReleaseAppleLegacyPurchase(ctx context.Context, store *SQLiteStore, selector, actor, reason, expectedDigest string) (AppleLegacyPurchaseRecoveryResult, error) {
	if store == nil {
		return AppleLegacyPurchaseRecoveryResult{}, errors.New("account: Apple legacy purchase recovery store is unavailable")
	}
	actor, reason, expectedDigest = strings.TrimSpace(actor), strings.TrimSpace(reason), strings.TrimSpace(expectedDigest)
	if actor == "" || reason == "" || len(actor) > 256 || len(reason) > 1024 {
		return AppleLegacyPurchaseRecoveryResult{}, errors.New("account: Apple legacy purchase recovery actor and reason are required and bounded")
	}
	if decoded, err := hex.DecodeString(expectedDigest); err != nil || len(decoded) != sha256.Size {
		return AppleLegacyPurchaseRecoveryResult{}, errors.New("account: Apple legacy purchase recovery requires the exact listed digest")
	}

	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return AppleLegacyPurchaseRecoveryResult{}, err
	}
	defer tx.Rollback()
	// Acquire SQLite's writer before reading the evidence snapshot. The no-op is
	// scoped to the selected current authority and prevents a provider delivery
	// from changing evidence between the digest check and the CAS below.
	if _, err := tx.ExecContext(ctx, `UPDATE billing_authorities SET updated_at=updated_at
 WHERE user_id=(SELECT a.user_id FROM billing_purchase_attempts a
                JOIN users u ON u.id=a.user_id
                WHERE a.provider=? AND a.state='dispatched'
                  AND (a.id=? OR lower(u.email)=lower(?))
                ORDER BY CASE WHEN a.id=? THEN 0 ELSE 1 END,a.created_at DESC LIMIT 1)`,
		ProviderApple, strings.TrimSpace(selector), strings.TrimSpace(selector), strings.TrimSpace(selector)); err != nil {
		return AppleLegacyPurchaseRecoveryResult{}, err
	}
	evidence, err := loadAppleLegacyPurchaseRecoveryEvidence(ctx, tx, selector)
	if err != nil {
		return AppleLegacyPurchaseRecoveryResult{}, err
	}
	if !strings.EqualFold(evidence.Digest, expectedDigest) {
		return AppleLegacyPurchaseRecoveryResult{}, errors.New("account: Apple legacy purchase recovery evidence changed; list evidence again")
	}
	if !evidence.Eligible {
		return AppleLegacyPurchaseRecoveryResult{}, fmt.Errorf("account: Apple legacy purchase is not releasable: %s", strings.Join(evidence.Blockers, ","))
	}

	res, err := tx.ExecContext(ctx, `UPDATE billing_purchase_attempts SET state='resolved'
 WHERE id=? AND user_id=? AND provider=? AND epoch=? AND state='dispatched'
   AND continuation_state='' AND app_instance_id='' AND client_outcome=''`,
		evidence.AttemptID, evidence.userID, ProviderApple, evidence.AuthorityEpoch)
	if err != nil {
		return AppleLegacyPurchaseRecoveryResult{}, err
	}
	if n, err := res.RowsAffected(); err != nil || n != 1 {
		if err != nil {
			return AppleLegacyPurchaseRecoveryResult{}, err
		}
		return AppleLegacyPurchaseRecoveryResult{}, errors.New("account: Apple legacy purchase recovery lost its compare-and-swap")
	}
	now := time.Now().Unix()
	if err := advanceBillingAuthorityGenerationTx(ctx, tx, evidence.authority, now); err != nil {
		return AppleLegacyPurchaseRecoveryResult{}, err
	}
	changes := encodeChanges([]ChangeField{
		{Field: "attempt_state", Old: "dispatched", New: "resolved"},
		{Field: "authority_epoch", Old: evidence.AuthorityEpoch, New: evidence.AuthorityEpoch + 1},
		{Field: "evidence_digest", Old: "", New: evidence.Digest},
		{Field: "reason", Old: "", New: reason},
	})
	if _, err := tx.ExecContext(ctx, `INSERT INTO admin_audit(at,actor,ip,auth,action,target,changes,step_up)
 VALUES(?,?,?,'operator',?,?,?,'')`, now, actor, "local", AuditAppleLegacyRelease,
		"apple-attempt:"+evidence.AttemptID, changes); err != nil {
		return AppleLegacyPurchaseRecoveryResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return AppleLegacyPurchaseRecoveryResult{}, err
	}
	return AppleLegacyPurchaseRecoveryResult{AttemptID: evidence.AttemptID, Epoch: evidence.AuthorityEpoch + 1}, nil
}
