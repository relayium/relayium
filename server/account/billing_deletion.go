package account

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"time"

	"github.com/relayium/relayium/authx"
)

const billingDeletionReviewDays = 400

type BillingCancellation struct {
	ID, BillingSubjectID, Provider, CustomerID, SubscriptionID, IdempotencyKey, State string
	Mode, DeletionEpoch, ParentOutboxID, CapturedSourceID, CapturedAuthorityProvider  string
	ProgressJSON, LastError                                                           string
	ClaimToken                                                                        string
	Generation, Attempts, CreatedAt, UpdatedAt, TerminalAt, ArchivedAt, NextAttemptAt int64
	Revision, CutoffAt, CapturedAuthorityEpoch                                        int64
}

const (
	billingCancellationAccountDeletion   = "account_deletion"
	billingCancellationExactCompensation = "exact_compensation"
)

type BillingDeletionResource struct {
	Kind              string `json:"kind"`
	ID                string `json:"id"`
	AttemptID         string `json:"attemptId,omitempty"`
	PaymentIntentID   string `json:"paymentIntentId,omitempty"`
	InvoiceID         string `json:"invoiceId,omitempty"`
	CustomerID        string `json:"customerId,omitempty"`
	Status            string `json:"status"`
	Terminal          bool   `json:"terminal"`
	Manual            bool   `json:"manual,omitempty"`
	ProviderCreatedAt int64  `json:"providerCreatedAt,omitempty"`
	SuccessAt         int64  `json:"successAt,omitempty"`
	AsyncFailureAt    int64  `json:"asyncFailureAt,omitempty"`
	AsyncSuccessAt    int64  `json:"asyncSuccessAt,omitempty"`
	RecoveryExpiresAt int64  `json:"recoveryExpiresAt,omitempty"`
	RecoveredFrom     string `json:"recoveredFrom,omitempty"`
}
type BillingDeletionProgress struct {
	Version                 int                                `json:"version"`
	Customers               []string                           `json:"customers,omitempty"`
	Resources               map[string]BillingDeletionResource `json:"resources,omitempty"`
	CleanSince              int64                              `json:"cleanSince,omitempty"`
	HistoricalAuditRequired bool                               `json:"historicalAuditRequired,omitempty"`
}

// ErrPaidInvoiceNeedsCanonicalEpoch means a verified paid-invoice event belongs
// to a subject with completed deletion history, but its payment chain does not
// overlap any retained epoch. The caller must retrieve the canonical invoice
// before choosing an epoch; ACKing this state could permanently lose a refund.
var ErrPaidInvoiceNeedsCanonicalEpoch = errors.New("account: paid invoice requires canonical deletion epoch")

type CanonicalStripePaidInvoice struct {
	InvoiceID, CustomerID, SubscriptionID, PaymentIntentID, ChargeID string
	CreatedAt, PaidAt                                                int64
}

const billingDeletionProgressVersion = 1

func (p BillingDeletionProgress) MarshalJSON() ([]byte, error) {
	type wire BillingDeletionProgress
	p.Version = billingDeletionProgressVersion
	return json.Marshal(wire(p))
}

func (p *BillingDeletionProgress) add(r BillingDeletionResource) {
	if p.Resources == nil {
		p.Resources = map[string]BillingDeletionResource{}
	}
	key := r.Kind + ":" + r.ID
	if old, ok := p.Resources[key]; ok {
		if old.Terminal && r.SuccessAt > old.SuccessAt && (r.Kind == "charge" || r.Kind == "payment_intent") {
			old.Terminal, old.Manual = false, false
			old.SuccessAt, old.Status = r.SuccessAt, r.Status
			p.Resources[key] = old
			p.CleanSince = 0
			return
		}
		// A later asynchronous Checkout outcome invalidates an earlier terminal
		// observation. In particular, payment success delivered after failure must
		// reopen reconciliation rather than letting deletion release its hold.
		if r.AsyncSuccessAt > old.AsyncSuccessAt || r.AsyncFailureAt > old.AsyncFailureAt {
			old.Terminal, old.Manual = false, false
			if r.Status != "" {
				old.Status = r.Status
			}
			old.AsyncSuccessAt = max(old.AsyncSuccessAt, r.AsyncSuccessAt)
			old.AsyncFailureAt = max(old.AsyncFailureAt, r.AsyncFailureAt)
			if old.AttemptID == "" {
				old.AttemptID = r.AttemptID
			}
			if old.CustomerID == "" {
				old.CustomerID = r.CustomerID
			}
			p.Resources[key] = old
			p.CleanSince = 0
			return
		}
		// Terminal and manual states are monotonic. A later provider list may
		// rediscover the same ID, but it must not erase canonical completion or
		// an audit-required payment outcome.
		if old.Terminal {
			return
		}
		if old.Manual {
			canCompleteUnknownSuccessTime := (old.Kind == "charge" || old.Kind == "payment_intent") && old.Status == "succeeded_time_unknown"
			if !canCompleteUnknownSuccessTime || r.SuccessAt <= old.SuccessAt {
				return
			}
			old.SuccessAt = r.SuccessAt
			old.Manual = false
			old.Status = "webhook_success_time"
			p.Resources[key] = old
			p.CleanSince = 0
			return
		}
		if r.AttemptID == "" {
			r.AttemptID = old.AttemptID
		}
		if r.CustomerID == "" {
			r.CustomerID = old.CustomerID
		}
		if r.PaymentIntentID == "" {
			r.PaymentIntentID = old.PaymentIntentID
		}
		if r.InvoiceID == "" {
			r.InvoiceID = old.InvoiceID
		}
		if r.RecoveryExpiresAt == 0 {
			r.RecoveryExpiresAt = old.RecoveryExpiresAt
		}
		if r.RecoveredFrom == "" {
			r.RecoveredFrom = old.RecoveredFrom
		}
		if old.SuccessAt > r.SuccessAt {
			r.SuccessAt = old.SuccessAt
		}
		if old.AsyncFailureAt > r.AsyncFailureAt {
			r.AsyncFailureAt = old.AsyncFailureAt
		}
		if old.AsyncSuccessAt > r.AsyncSuccessAt {
			r.AsyncSuccessAt = old.AsyncSuccessAt
		}
	}
	if _, ok := p.Resources[key]; !ok || !r.Terminal {
		p.CleanSince = 0
	}
	p.Resources[key] = r
}
func (p BillingDeletionProgress) terminal(now int64) bool {
	if p.HistoricalAuditRequired {
		return false
	}
	hasIdentity := p.hasIdentity()
	for _, r := range p.Resources {
		if !r.Terminal {
			return false
		}
	}
	return hasIdentity && p.CleanSince > 0 && now-p.CleanSince >= 86400
}
func (p BillingDeletionProgress) hasIdentity() bool {
	if len(p.Customers) > 0 {
		return true
	}
	for _, r := range p.Resources {
		if r.Kind == "checkout_session" && r.AttemptID != "" {
			return true
		}
		if r.Kind == "no_side_effect_proof" && r.Terminal {
			return true
		}
	}
	return false
}
func decodeDeletionProgressStrict(raw string) (BillingDeletionProgress, error) {
	var p BillingDeletionProgress
	var shape json.RawMessage
	if err := json.Unmarshal([]byte(raw), &shape); err != nil || len(shape) == 0 {
		return p, errors.New("account: invalid billing deletion progress")
	}
	if shape[0] == '[' {
		var legacy []BillingDeletionResource
		if err := json.Unmarshal(shape, &legacy); err != nil {
			return p, errors.New("account: invalid legacy billing deletion progress")
		}
		p.Version = billingDeletionProgressVersion
		p.Resources = map[string]BillingDeletionResource{}
		for _, r := range legacy {
			if r.Kind == "" || r.ID == "" {
				return BillingDeletionProgress{}, errors.New("account: invalid legacy billing deletion resource")
			}
			p.add(r)
		}
		return p, nil
	}
	if shape[0] != '{' {
		return BillingDeletionProgress{}, errors.New("account: invalid billing deletion progress")
	}
	var header struct {
		Version int `json:"version"`
	}
	if json.Unmarshal(shape, &header) != nil {
		return BillingDeletionProgress{}, errors.New("account: invalid billing deletion progress")
	}
	if header.Version == 0 {
		var legacy struct {
			Version          int                                `json:"version"`
			Customers        []string                           `json:"customers"`
			CheckoutSessions []string                           `json:"checkoutSessions"`
			Subscriptions    []string                           `json:"subscriptions"`
			Schedules        []string                           `json:"schedules"`
			InvoiceItems     []string                           `json:"invoiceItems"`
			Invoices         []string                           `json:"invoices"`
			Resources        map[string]BillingDeletionResource `json:"resources"`
			CleanSince       int64                              `json:"cleanSince"`
		}
		legacyDecoder := json.NewDecoder(bytes.NewReader(shape))
		legacyDecoder.DisallowUnknownFields()
		if legacyDecoder.Decode(&legacy) != nil {
			return BillingDeletionProgress{}, errors.New("account: invalid legacy billing deletion progress")
		}
		p = BillingDeletionProgress{Version: billingDeletionProgressVersion, Customers: legacy.Customers, Resources: map[string]BillingDeletionResource{}, CleanSince: legacy.CleanSince}
		for key, resource := range legacy.Resources {
			if resource.Kind == "" || resource.ID == "" || key != resource.Kind+":"+resource.ID {
				return BillingDeletionProgress{}, errors.New("account: invalid legacy billing deletion resource")
			}
			p.Resources[key] = resource
		}
		for kind, ids := range map[string][]string{"checkout_session": legacy.CheckoutSessions, "subscription": legacy.Subscriptions, "schedule": legacy.Schedules, "invoice_item": legacy.InvoiceItems, "invoice": legacy.Invoices} {
			for _, id := range ids {
				if id == "" {
					return BillingDeletionProgress{}, errors.New("account: invalid legacy billing deletion identity")
				}
				p.add(BillingDeletionResource{Kind: kind, ID: id, Status: "legacy_migrated"})
			}
		}
		return p, nil
	}
	decoder := json.NewDecoder(bytes.NewReader(shape))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&p); err != nil {
		return BillingDeletionProgress{}, errors.New("account: invalid billing deletion progress fields")
	}
	if p.Version != 0 && p.Version != billingDeletionProgressVersion {
		return BillingDeletionProgress{}, errors.New("account: unsupported billing deletion progress version")
	}
	p.Version = billingDeletionProgressVersion
	if p.Resources == nil {
		p.Resources = map[string]BillingDeletionResource{}
	}
	for key, r := range p.Resources {
		if r.Kind == "" || r.ID == "" || key != r.Kind+":"+r.ID {
			return BillingDeletionProgress{}, errors.New("account: invalid billing deletion resource")
		}
	}
	return p, nil
}

// decodeDeletionProgress remains a test-data convenience. Production paths use
// decodeDeletionProgressStrict and must never turn corruption into an empty,
// apparently terminal journal.
func decodeDeletionProgress(raw string) BillingDeletionProgress {
	p, _ := decodeDeletionProgressStrict(raw)
	return p
}
func appendUnique(xs []string, v string) []string {
	if v == "" {
		return xs
	}
	for _, x := range xs {
		if x == v {
			return xs
		}
	}
	return append(xs, v)
}

func (s *SQLiteStore) ConfigureBillingHoldSecret(secret string) error {
	if secret == "" {
		return errors.New("account: billing deletion hold secret is required")
	}
	key := []byte(secret)
	fingerprint := sha256.Sum256(key)
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var existing []byte
	err = tx.QueryRow(`SELECT key_fingerprint FROM billing_deletion_config WHERE id=1`).Scan(&existing)
	if errors.Is(err, sql.ErrNoRows) {
		if _, err := tx.Exec(`INSERT INTO billing_deletion_config(id,key_fingerprint) VALUES(1,?)`, fingerprint[:]); err != nil {
			return err
		}
	} else if err != nil {
		return err
	} else if !hmac.Equal(existing, fingerprint[:]) {
		var active int
		if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM billing_deletion_holds)`).Scan(&active); err != nil {
			return err
		}
		if active != 0 {
			return errors.New("account: billing deletion hold secret cannot change while holds are active")
		}
		if _, err := tx.Exec(`UPDATE billing_deletion_config SET key_fingerprint=? WHERE id=1`, fingerprint[:]); err != nil {
			return err
		}
	}
	rows, err := tx.Query(`SELECT id,email FROM users`)
	if err != nil {
		return err
	}
	type item struct{ id, email string }
	var users []item
	for rows.Next() {
		var u item
		if err := rows.Scan(&u.id, &u.email); err != nil {
			return err
		}
		users = append(users, u)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	previous := s.billingHoldSecret
	s.billingHoldSecret = key
	for _, u := range users {
		if _, err := tx.Exec(`UPDATE users SET billing_hold_hmac=? WHERE id=?`, s.billingEmailHMAC(u.email), u.id); err != nil {
			s.billingHoldSecret = previous
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		s.billingHoldSecret = previous
		return err
	}
	return nil
}

func (s *SQLiteStore) billingEmailHMAC(email string) []byte {
	if len(s.billingHoldSecret) == 0 {
		return []byte{}
	}
	m := hmac.New(sha256.New, s.billingHoldSecret)
	_, _ = m.Write([]byte(normEmail(email)))
	return m.Sum(nil)
}

func billingUserFrozenTx(ctx context.Context, tx *sql.Tx, userID string, _ int64) (bool, error) {
	var frozen int
	err := tx.QueryRowContext(ctx, `SELECT EXISTS(
 SELECT 1 FROM billing_deletion_holds h
 LEFT JOIN users u ON u.id=?
 WHERE (h.billing_subject_id=? AND h.subject_released_at=0)
    OR (h.billing_subject_id<>? AND length(u.billing_hold_hmac)>0 AND h.email_hmac=u.billing_hold_hmac)
)`, userID, userID, userID).Scan(&frozen)
	return frozen != 0, err
}

func finalizeStripeDeletionTx(ctx context.Context, tx *sql.Tx, userID string, now int64) error {
	var pending int
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM billing_cancellation_outbox WHERE billing_subject_id=? AND provider='stripe' AND state='pending' AND mode='account_deletion')`, userID).Scan(&pending); err != nil {
		return err
	}
	if pending != 0 {
		return nil
	}
	var curPlan, curSource string
	err := tx.QueryRowContext(ctx, `SELECT plan_id,plan_source FROM users WHERE id=?`, userID).Scan(&curPlan, &curSource)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if err == nil {
		if _, err := tx.ExecContext(ctx, `UPDATE subscription_sources SET plan_id='free',status='canceled',period_end=0 WHERE user_id=? AND provider='stripe'`, userID); err != nil {
			return err
		}
		eff, err := recomputeProjectionTx(ctx, tx, userID, ProviderStripe, curPlan, curSource)
		if err != nil {
			return err
		}
		if err := writeProjectionTx(ctx, tx, userID, eff, now, 0); err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, `UPDATE billing_deletion_holds SET subject_released_at=? WHERE billing_subject_id=?`, now, userID)
	return err
}

func (s *SQLiteStore) BillingUserFrozen(ctx context.Context, userID string) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	return billingUserFrozenTx(ctx, tx, userID, 0)
}

// CommitAccountDeletion makes authorization, billing freeze/outbox, recovery,
// live-data removal, and the deletion schedule one indivisible local decision.
// No provider call is permitted until this transaction commits.
func (s *SQLiteStore) CommitAccountDeletion(ctx context.Context, tokenHash string, u User, now, purgeAfter int64, reactivate EmailToken) ([]BlobRef, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback()
	var deletedAt int64
	if err := tx.QueryRowContext(ctx, `SELECT email,stripe_customer_id,stripe_subscription_id,deleted_at FROM users WHERE id=?`, u.ID).Scan(&u.Email, &u.StripeCustomerID, &u.StripeSubscriptionID, &deletedAt); err != nil {
		return nil, false, err
	}
	if deletedAt > 0 {
		return nil, true, tx.Commit()
	}
	reactivate.Email = u.Email
	res, err := tx.ExecContext(ctx, `UPDATE email_tokens SET used_at=? WHERE token_hash=? AND purpose='delete' AND used_at=0 AND expires_at>? AND user_id=?`, now, tokenHash, now, u.ID)
	if err != nil {
		return nil, false, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, false, nil
	}
	digest := s.billingEmailHMAC(u.Email)
	var provider, stripeExternalID string
	var authorityEpoch int64
	if err := tx.QueryRowContext(ctx, `SELECT provider,epoch FROM billing_authorities WHERE user_id=?`, u.ID).Scan(&provider, &authorityEpoch); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, false, err
	}
	capturedAuthorityProvider := provider
	if err := tx.QueryRowContext(ctx, `SELECT external_id FROM subscription_sources WHERE user_id=? AND provider='stripe'`, u.ID).Scan(&stripeExternalID); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, false, err
	}
	var stripeHistory bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(
		SELECT 1 FROM stripe_customer_history WHERE user_id=?
		UNION ALL SELECT 1 FROM billing_purchase_attempts WHERE user_id=? AND provider='stripe'
	)`, u.ID, u.ID).Scan(&stripeHistory); err != nil {
		return nil, false, err
	}
	hasStripe := stripeExternalID != "" || u.StripeCustomerID != "" || u.StripeSubscriptionID != "" || stripeHistory
	if provider == "" && hasStripe {
		provider = ProviderStripe
	}
	if provider == "" {
		if err := tx.QueryRowContext(ctx, `SELECT provider FROM subscription_sources WHERE user_id=? ORDER BY CASE provider WHEN 'apple' THEN 0 ELSE 1 END LIMIT 1`, u.ID).Scan(&provider); err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, false, err
		}
	}
	if provider != "" {
		if len(digest) == 0 {
			return nil, false, errors.New("account: billing deletion hold secret is unavailable")
		}
		reviewAt := now + billingDeletionReviewDays*86400
		if _, err := tx.ExecContext(ctx, `INSERT INTO billing_deletion_holds(billing_subject_id,email_hmac,provider,created_at,expires_at,review_at,subject_released_at) VALUES(?,?,?,?,?,?,0) ON CONFLICT(billing_subject_id) DO UPDATE SET review_at=MAX(review_at,excluded.review_at),subject_released_at=0`, u.ID, digest, provider, now, reviewAt, reviewAt); err != nil {
			return nil, false, err
		}
	}
	if hasStripe || provider == ProviderStripe {
		subID := u.StripeSubscriptionID
		if subID == "" {
			subID = stripeExternalID
		}
		id := authx.NewID()
		key := "relayium-account-delete-" + id
		var generation int64
		if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(generation),0)+1 FROM billing_cancellation_outbox WHERE billing_subject_id=? AND provider='stripe'`, u.ID).Scan(&generation); err != nil {
			return nil, false, err
		}
		progress := BillingDeletionProgress{Resources: map[string]BillingDeletionResource{}, HistoricalAuditRequired: true}
		rows, err := tx.QueryContext(ctx, `SELECT customer_id FROM stripe_customer_history WHERE user_id=? ORDER BY created_at,customer_id`, u.ID)
		if err != nil {
			return nil, false, err
		}
		for rows.Next() {
			var c string
			if err := rows.Scan(&c); err != nil {
				rows.Close()
				return nil, false, err
			}
			progress.Customers = appendUnique(progress.Customers, c)
		}
		if err := rows.Close(); err != nil {
			return nil, false, err
		}
		progress.Customers = appendUnique(progress.Customers, u.StripeCustomerID)
		attempts, err := tx.QueryContext(ctx, `SELECT id,provider_session_id,provider_subscription_id FROM billing_purchase_attempts WHERE user_id=? AND provider='stripe' AND (provider_session_id<>'' OR provider_subscription_id<>'')`, u.ID)
		if err != nil {
			return nil, false, err
		}
		for attempts.Next() {
			var attemptID, sid, attemptSubID string
			if err := attempts.Scan(&attemptID, &sid, &attemptSubID); err != nil {
				attempts.Close()
				return nil, false, err
			}
			if sid != "" {
				progress.add(BillingDeletionResource{Kind: "checkout_session", ID: sid, AttemptID: attemptID, CustomerID: u.StripeCustomerID, Status: "observed"})
			}
			if attemptSubID != "" {
				progress.add(BillingDeletionResource{Kind: "subscription", ID: attemptSubID, AttemptID: attemptID, CustomerID: u.StripeCustomerID, Status: "observed"})
			}
		}
		if err := attempts.Close(); err != nil {
			return nil, false, err
		}
		if subID != "" {
			progress.add(BillingDeletionResource{Kind: "subscription", ID: subID, CustomerID: u.StripeCustomerID, Status: "external_binding"})
		}
		if !hasStripe {
			progress.add(BillingDeletionResource{Kind: "no_side_effect_proof", ID: u.ID, Status: "verified_local_history_empty", Terminal: true})
			progress.CleanSince = now
		}
		encoded, _ := json.Marshal(progress)
		if _, err := tx.ExecContext(ctx, `INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,customer_id,subscription_id,idempotency_key,state,attempts,created_at,updated_at,progress_json,generation,next_attempt_at,mode,deletion_epoch,cutoff_at,captured_source_id,captured_authority_provider,captured_authority_epoch) VALUES(?,?,?,?,?,?,'pending',0,?,?,?,?,?,'account_deletion',?,?,?,?,?)`, id, u.ID, ProviderStripe, u.StripeCustomerID, subID, key, now, now, string(encoded), generation, now, id, now, stripeExternalID, capturedAuthorityProvider, authorityEpoch); err != nil {
			return nil, false, err
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO email_tokens(token_hash,user_id,email,purpose,created_at,expires_at,used_at) VALUES(?,?,?,?,?,?,0)`, reactivate.TokenHash, reactivate.UserID, normEmail(reactivate.Email), reactivate.Purpose, reactivate.CreatedAt, reactivate.ExpiresAt); err != nil {
		return nil, false, err
	}
	blobs, err := purgeTransientUserDataTx(ctx, tx, u.ID)
	if err != nil {
		return nil, false, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE users SET deleted_at=?,purge_after=?,purge_reminder_sent=0 WHERE id=? AND deleted_at=0`, now, purgeAfter, u.ID); err != nil {
		return nil, false, err
	}
	if err := tx.Commit(); err != nil {
		return nil, false, err
	}
	return blobs, true, nil
}

func (s *SQLiteStore) PendingBillingCancellations(ctx context.Context, limit int) ([]BillingCancellation, error) {
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	now := time.Now().Unix()
	rows, err := tx.QueryContext(ctx, `SELECT id,billing_subject_id,provider,customer_id,subscription_id,idempotency_key,state,progress_json,last_error,generation,attempts,created_at,updated_at,terminal_at,archived_at,next_attempt_at,revision,mode,deletion_epoch,cutoff_at,parent_outbox_id,captured_source_id,captured_authority_provider,captured_authority_epoch FROM billing_cancellation_outbox WHERE state='pending' AND next_attempt_at<=? AND claim_until<=? ORDER BY next_attempt_at,updated_at,id LIMIT ?`, now, now, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []BillingCancellation
	for rows.Next() {
		var c BillingCancellation
		if err := rows.Scan(&c.ID, &c.BillingSubjectID, &c.Provider, &c.CustomerID, &c.SubscriptionID, &c.IdempotencyKey, &c.State, &c.ProgressJSON, &c.LastError, &c.Generation, &c.Attempts, &c.CreatedAt, &c.UpdatedAt, &c.TerminalAt, &c.ArchivedAt, &c.NextAttemptAt, &c.Revision, &c.Mode, &c.DeletionEpoch, &c.CutoffAt, &c.ParentOutboxID, &c.CapturedSourceID, &c.CapturedAuthorityProvider, &c.CapturedAuthorityEpoch); err != nil {
			return nil, err
		}
		c.ClaimToken = authx.NewID()
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for i := range out {
		res, err := tx.ExecContext(ctx, `UPDATE billing_cancellation_outbox SET claim_token=?,claim_until=? WHERE id=? AND state='pending' AND revision=? AND claim_until<=?`, out[i].ClaimToken, now+300, out[i].ID, out[i].Revision, now)
		if err != nil {
			return nil, err
		}
		if n, _ := res.RowsAffected(); n != 1 {
			return nil, errors.New("account: billing cancellation claim lost")
		}
	}
	return out, tx.Commit()
}

func (s *SQLiteStore) FinishBillingCancellation(ctx context.Context, id, claim string, generation, revision int64, progress, lastError string, terminal bool, attempts, now int64) error {
	state := "pending"
	if terminal {
		state = "terminal"
	}
	terminalAt := int64(0)
	if terminal {
		terminalAt = now
	}
	next := now
	if !terminal {
		delay := int64(60)
		for i := int64(0); i < attempts && delay < 21600; i++ {
			delay *= 2
		}
		if delay > 21600 {
			delay = 21600
		}
		next = now + delay
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var finishRow BillingCancellation
	if terminal {
		if err := tx.QueryRowContext(ctx, `SELECT billing_subject_id,mode,captured_source_id,captured_authority_provider,captured_authority_epoch FROM billing_cancellation_outbox WHERE id=?`, id).Scan(&finishRow.BillingSubjectID, &finishRow.Mode, &finishRow.CapturedSourceID, &finishRow.CapturedAuthorityProvider, &finishRow.CapturedAuthorityEpoch); err != nil {
			return err
		}
		if finishRow.Mode != billingCancellationExactCompensation {
			current, err := billingDeletionSnapshotCurrentTx(ctx, tx, finishRow)
			if err != nil {
				return err
			}
			if !current {
				terminal = false
				state = "pending"
				terminalAt = 0
				next = now + 21600
				lastError = "billing source changed during deletion"
			}
		}
	}
	if err := persistDeletionCustomersTx(ctx, tx, id, progress); err != nil {
		return err
	}
	res, err := tx.ExecContext(ctx, `UPDATE billing_cancellation_outbox SET state=?,progress_json=?,last_error=?,attempts=attempts+1,updated_at=?,terminal_at=?,next_attempt_at=?,claim_token='',claim_until=0,revision=revision+1 WHERE id=? AND generation=? AND revision=? AND claim_token=? AND state='pending'`, state, progress, lastError, now, terminalAt, next, id, generation, revision, claim)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return errors.New("account: stale billing cancellation finish")
	}
	if terminal {
		if finishRow.Mode != billingCancellationExactCompensation {
			if err := finalizeStripeDeletionTx(ctx, tx, finishRow.BillingSubjectID, now); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

func billingDeletionSnapshotCurrentTx(ctx context.Context, tx *sql.Tx, row BillingCancellation) (bool, error) {
	if row.CapturedSourceID == "" && row.CapturedAuthorityProvider == "" && row.CapturedAuthorityEpoch == 0 {
		return true, nil
	}
	if row.CapturedSourceID != "" {
		var sourceID string
		if err := tx.QueryRowContext(ctx, `SELECT external_id FROM subscription_sources WHERE user_id=? AND provider='stripe'`, row.BillingSubjectID).Scan(&sourceID); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return false, nil
			}
			return false, err
		}
		if sourceID != row.CapturedSourceID {
			return false, nil
		}
	}
	if row.CapturedAuthorityProvider != "" || row.CapturedAuthorityEpoch != 0 {
		var provider string
		var epoch int64
		if err := tx.QueryRowContext(ctx, `SELECT provider,epoch FROM billing_authorities WHERE user_id=?`, row.BillingSubjectID).Scan(&provider, &epoch); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return false, nil
			}
			return false, err
		}
		if provider != row.CapturedAuthorityProvider || epoch != row.CapturedAuthorityEpoch {
			return false, nil
		}
	}
	return true, nil
}

func (s *SQLiteStore) SaveBillingCancellationProgress(ctx context.Context, id, claim string, generation, revision int64, progress string, now int64) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return revision, err
	}
	defer tx.Rollback()
	if err := persistDeletionCustomersTx(ctx, tx, id, progress); err != nil {
		return revision, err
	}
	res, err := tx.ExecContext(ctx, `UPDATE billing_cancellation_outbox SET progress_json=?,updated_at=?,revision=revision+1 WHERE id=? AND generation=? AND revision=? AND claim_token=? AND claim_until>? AND state='pending'`, progress, now, id, generation, revision, claim, now)
	if err != nil {
		return revision, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return revision, errors.New("account: stale billing cancellation progress")
	}
	return revision + 1, tx.Commit()
}

func persistDeletionCustomersTx(ctx context.Context, tx *sql.Tx, outboxID, raw string) error {
	p, err := decodeDeletionProgressStrict(raw)
	if err != nil {
		return err
	}
	for _, customerID := range p.Customers {
		if customerID == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO stripe_customer_history(user_id,customer_id,created_at)
			SELECT billing_subject_id,?,unixepoch() FROM billing_cancellation_outbox WHERE id=?`, customerID, outboxID); err != nil {
			return err
		}
	}
	return nil
}

func (s *SQLiteStore) CompactBillingCancellations(ctx context.Context, before, now int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Hosted checkout URLs are bearer-like browser destinations and have no
	// tombstone value. Keep only provider object IDs/customer history needed to
	// attribute late events, and compact evidence after the review window.
	if _, err := tx.ExecContext(ctx, `UPDATE billing_purchase_attempts SET provider_ref=''
		WHERE provider='stripe' AND user_id IN (SELECT billing_subject_id FROM billing_cancellation_outbox WHERE state='terminal' AND terminal_at>0 AND terminal_at<=?)`, before); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE billing_cancellation_outbox SET customer_id='',subscription_id='',progress_json='{}',archived_at=? WHERE state='terminal' AND terminal_at>0 AND terminal_at<=? AND archived_at=0`, now, before); err != nil {
		return err
	}
	return tx.Commit()
}

// AppendStripeDeletionHazard durably joins a webhook-observed provider object
// to every pending deletion generation before the webhook may ACK. Bumping the
// revision invalidates any worker that read the older journal.
func (s *SQLiteStore) AppendStripeDeletionHazard(ctx context.Context, userID string, r BillingDeletionResource) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := appendStripeDeletionHazardsTx(ctx, tx, userID, []BillingDeletionResource{r}); err != nil {
		return err
	}
	return tx.Commit()
}

// AppendStripeActiveAccountDeletionHazard records Checkout lifecycle only for
// a deletion that is still actively inventorying the whole account. Once that
// deletion is terminal, Checkout is audit context rather than an exact refund
// target; the authenticated invoice/payment-intent/charge chain is journaled
// separately and must not be blocked by this non-payment observation.
func (s *SQLiteStore) AppendStripeActiveAccountDeletionHazard(ctx context.Context, userID string, r BillingDeletionResource) error {
	if r.ID == "" {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT id,progress_json FROM billing_cancellation_outbox WHERE billing_subject_id=? AND provider='stripe' AND state='pending' AND mode='account_deletion'`, userID)
	if err != nil {
		return err
	}
	type pending struct{ id, raw string }
	var pendingRows []pending
	for rows.Next() {
		var row pending
		if err := rows.Scan(&row.id, &row.raw); err != nil {
			rows.Close()
			return err
		}
		pendingRows = append(pendingRows, row)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, row := range pendingRows {
		p, err := decodeDeletionProgressStrict(row.raw)
		if err != nil {
			return err
		}
		p.add(r)
		encoded, err := json.Marshal(p)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE billing_cancellation_outbox SET progress_json=?,revision=revision+1,updated_at=unixepoch() WHERE id=? AND state='pending' AND mode='account_deletion'`, string(encoded), row.id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// AppendStripeActiveAccountDeletionHazardForCustomer resolves an active
// deletion through durable Stripe customer history before current billing
// authority acquisition. This lets a frozen/deleting account retain signed
// Checkout failure/expiry evidence without reopening billing authority.
func (s *SQLiteStore) AppendStripeActiveAccountDeletionHazardForCustomer(ctx context.Context, customerID, userHint string, r BillingDeletionResource) (bool, error) {
	if customerID == "" || r.ID == "" {
		return false, nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT DISTINCT o.billing_subject_id FROM billing_cancellation_outbox o JOIN stripe_customer_history h ON h.user_id=o.billing_subject_id AND h.customer_id=? WHERE o.provider='stripe' AND o.state='pending' AND o.mode='account_deletion' ORDER BY o.billing_subject_id LIMIT 2`, customerID)
	if err != nil {
		return false, err
	}
	var subjects []string
	for rows.Next() {
		var subject string
		if err := rows.Scan(&subject); err != nil {
			rows.Close()
			return false, err
		}
		subjects = append(subjects, subject)
	}
	if err := rows.Close(); err != nil {
		return false, err
	}
	if len(subjects) == 0 {
		return false, nil
	}
	if len(subjects) != 1 || (userHint != "" && userHint != subjects[0]) {
		return false, errors.New("account: active deletion Checkout ownership is ambiguous")
	}
	rows, err = tx.QueryContext(ctx, `SELECT id,progress_json FROM billing_cancellation_outbox WHERE billing_subject_id=? AND provider='stripe' AND state='pending' AND mode='account_deletion'`, subjects[0])
	if err != nil {
		return false, err
	}
	type pending struct{ id, raw string }
	var pendingRows []pending
	for rows.Next() {
		var row pending
		if err := rows.Scan(&row.id, &row.raw); err != nil {
			rows.Close()
			return false, err
		}
		pendingRows = append(pendingRows, row)
	}
	if err := rows.Close(); err != nil {
		return false, err
	}
	for _, row := range pendingRows {
		p, err := decodeDeletionProgressStrict(row.raw)
		if err != nil {
			return false, err
		}
		p.add(r)
		encoded, err := json.Marshal(p)
		if err != nil {
			return false, err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE billing_cancellation_outbox SET progress_json=?,revision=revision+1,updated_at=unixepoch() WHERE id=? AND state='pending' AND mode='account_deletion'`, string(encoded), row.id); err != nil {
			return false, err
		}
	}
	return true, tx.Commit()
}

func appendStripeDeletionHazardsTx(ctx context.Context, tx *sql.Tx, userID string, resources []BillingDeletionResource) (bool, error) {
	valid := resources[:0]
	for _, r := range resources {
		if r.ID != "" {
			valid = append(valid, r)
		}
	}
	resources = valid
	if len(resources) == 0 {
		return false, nil
	}
	rows, err := tx.QueryContext(ctx, `SELECT id,progress_json,mode FROM billing_cancellation_outbox WHERE billing_subject_id=? AND provider='stripe' AND state='pending'`, userID)
	if err != nil {
		return false, err
	}
	type pending struct{ id, raw, mode string }
	var all []pending
	for rows.Next() {
		var v pending
		if err := rows.Scan(&v.id, &v.raw, &v.mode); err != nil {
			rows.Close()
			return false, err
		}
		all = append(all, v)
	}
	if err := rows.Close(); err != nil {
		return false, err
	}
	exactEligible := validateExactPaymentResources(resources) == nil
	if exactEligible {
		if handled, err := appendExactStripeCompensationTx(ctx, tx, userID, "", resources); err != nil || handled {
			return handled, err
		}
	}
	hasAccountDeletion := false
	for _, v := range all {
		hasAccountDeletion = hasAccountDeletion || v.mode == billingCancellationAccountDeletion
	}
	if !exactEligible && !hasAccountDeletion {
		// Subscription and Checkout observations are meaningful only while a
		// customer-wide account deletion is pending. They are not exact refund
		// targets and therefore must fail closed after a deletion has completed.
		// In the overwhelmingly common case where no deletion exists at all, this
		// remains a deliberate no-op so normal subscription lifecycle can apply.
		var completedDeletion int
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM billing_cancellation_outbox WHERE billing_subject_id=? AND provider='stripe' AND state='terminal' AND mode='account_deletion')`, userID).Scan(&completedDeletion); err != nil {
			return false, err
		}
		if completedDeletion != 0 {
			return false, errors.New("account: non-payment hazard cannot reopen completed deletion")
		}
		return false, nil
	}
	for _, v := range all {
		if v.mode == billingCancellationExactCompensation {
			continue
		}
		p, err := decodeDeletionProgressStrict(v.raw)
		if err != nil {
			return false, err
		}
		for _, r := range resources {
			if r.ID != "" {
				p.add(r)
			}
		}
		encoded, _ := json.Marshal(p)
		if _, err := tx.ExecContext(ctx, `UPDATE billing_cancellation_outbox SET progress_json=?,revision=revision+1,updated_at=unixepoch() WHERE id=? AND state='pending'`, string(encoded), v.id); err != nil {
			return false, err
		}
	}
	return hasAccountDeletion, nil
}

// appendExactStripeCompensationTx creates a payment-chain-only task for money
// that arrived after an account-deletion epoch had already converged. It never
// reopens the subject-wide hold and never admits resources that can mutate a
// current Checkout Session, Subscription, Schedule, or Customer inventory.
func appendExactStripeCompensationTx(ctx context.Context, tx *sql.Tx, userID, preferredOutboxID string, resources []BillingDeletionResource) (bool, error) {
	if err := validateExactPaymentResources(resources); err != nil {
		return false, err
	}
	type match struct {
		row      BillingCancellation
		progress BillingDeletionProgress
	}
	var pendingMatch, terminalMatch *match
	matchedEpoch := ""
	setEpoch := func(epoch string) error {
		if epoch == "" {
			return errors.New("account: late Stripe payment has no deletion epoch")
		}
		if matchedEpoch != "" && matchedEpoch != epoch {
			return errors.New("account: late Stripe payment matches multiple deletion epochs")
		}
		matchedEpoch = epoch
		return nil
	}
	rows, err := tx.QueryContext(ctx, `SELECT id,customer_id,subscription_id,generation,created_at,progress_json,deletion_epoch,cutoff_at,parent_outbox_id,captured_source_id,captured_authority_provider,captured_authority_epoch,state,mode FROM billing_cancellation_outbox WHERE billing_subject_id=? AND provider='stripe' AND (state='terminal' OR mode='exact_compensation') ORDER BY generation DESC`, userID)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var candidate BillingCancellation
		var raw string
		if err := rows.Scan(&candidate.ID, &candidate.CustomerID, &candidate.SubscriptionID, &candidate.Generation, &candidate.CreatedAt, &raw, &candidate.DeletionEpoch, &candidate.CutoffAt, &candidate.ParentOutboxID, &candidate.CapturedSourceID, &candidate.CapturedAuthorityProvider, &candidate.CapturedAuthorityEpoch, &candidate.State, &candidate.Mode); err != nil {
			return false, err
		}
		p, err := decodeDeletionProgressStrict(raw)
		if err != nil {
			return false, err
		}
		preferred := preferredOutboxID != "" && (candidate.ID == preferredOutboxID || candidate.ParentOutboxID == preferredOutboxID)
		if preferredOutboxID != "" && !preferred {
			continue
		}
		if !preferred && !progressMatchesPaymentChain(p, resources) {
			continue
		}
		epoch := candidate.DeletionEpoch
		if epoch == "" {
			epoch = candidate.ID
		}
		if err := setEpoch(epoch); err != nil {
			return false, err
		}
		m := &match{row: candidate, progress: p}
		if candidate.State == "pending" && candidate.Mode == billingCancellationExactCompensation {
			if pendingMatch != nil && pendingMatch.row.ID != candidate.ID {
				return false, errors.New("account: duplicate pending exact compensation")
			}
			pendingMatch = m
		} else if candidate.State == "terminal" && terminalMatch == nil {
			terminalMatch = m
		}
	}
	if err := rows.Err(); err != nil {
		return false, err
	}
	if pendingMatch != nil {
		p := pendingMatch.progress
		for _, r := range resources {
			p.add(r)
		}
		p.CleanSince = 0
		encoded, err := json.Marshal(p)
		if err != nil {
			return false, err
		}
		_, err = tx.ExecContext(ctx, `UPDATE billing_cancellation_outbox SET progress_json=?,revision=revision+1,updated_at=unixepoch() WHERE id=? AND state='pending' AND mode='exact_compensation'`, string(encoded), pendingMatch.row.ID)
		return err == nil, err
	}
	if terminalMatch == nil {
		return false, nil
	}
	matched := terminalMatch.row
	p := exactPaymentProgress(terminalMatch.progress, resources)
	p.Customers = appendUnique(p.Customers, matched.CustomerID)
	for _, r := range resources {
		p.Resources[r.Kind+":"+r.ID] = r
	}
	encoded, err := json.Marshal(p)
	if err != nil {
		return false, err
	}
	id := authx.NewID()
	now := time.Now().Unix()
	var generation int64
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(generation),0)+1 FROM billing_cancellation_outbox WHERE billing_subject_id=? AND provider='stripe'`, userID).Scan(&generation); err != nil {
		return false, err
	}
	epoch, cutoff := matched.DeletionEpoch, matched.CutoffAt
	if epoch == "" {
		epoch = matched.ID
	}
	if cutoff == 0 {
		cutoff = matched.CreatedAt
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,customer_id,subscription_id,idempotency_key,state,attempts,created_at,updated_at,progress_json,generation,next_attempt_at,mode,deletion_epoch,cutoff_at,parent_outbox_id,captured_source_id,captured_authority_provider,captured_authority_epoch) VALUES(?,?,?,?,?,?,'pending',0,?,?,?,?,?,'exact_compensation',?,?,?,?,?,?)`, id, userID, ProviderStripe, matched.CustomerID, matched.SubscriptionID, "relayium-exact-compensation-"+id, now, now, string(encoded), generation, now, epoch, cutoff, matched.ID, matched.CapturedSourceID, matched.CapturedAuthorityProvider, matched.CapturedAuthorityEpoch)
	return err == nil, err
}

func validateExactPaymentResources(resources []BillingDeletionResource) error {
	for _, r := range resources {
		if r.Kind != "invoice" && r.Kind != "payment_intent" && r.Kind != "charge" {
			return errors.New("account: exact compensation rejected non-payment resource")
		}
	}
	return nil
}

func progressMatchesPaymentChain(p BillingDeletionProgress, resources []BillingDeletionResource) bool {
	for _, incoming := range resources {
		for _, old := range p.Resources {
			if incoming.ID != "" && (incoming.ID == old.ID || incoming.ID == old.PaymentIntentID || incoming.ID == old.InvoiceID) {
				return true
			}
			if incoming.PaymentIntentID != "" && (incoming.PaymentIntentID == old.ID || incoming.PaymentIntentID == old.PaymentIntentID) {
				return true
			}
		}
	}
	return false
}

func exactPaymentProgress(old BillingDeletionProgress, incoming []BillingDeletionResource) BillingDeletionProgress {
	out := BillingDeletionProgress{Resources: map[string]BillingDeletionResource{}}
	for _, r := range old.Resources {
		if r.Kind != "invoice" && r.Kind != "payment_intent" && r.Kind != "charge" {
			continue
		}
		one := BillingDeletionProgress{Resources: map[string]BillingDeletionResource{r.Kind + ":" + r.ID: r}}
		if progressMatchesPaymentChain(one, incoming) {
			out.add(r)
		}
	}
	return out
}

func (s *SQLiteStore) AppendStripeCustomerDeletionHazards(ctx context.Context, customerID string, resources []BillingDeletionResource) error {
	return s.appendStripeCustomerDeletionHazards(ctx, customerID, resources, false)
}

// AppendStripePaidInvoiceDeletionHazards is the strict pre-projection path for
// a verified invoice.paid webhook. An invoice that cannot be attributed through
// durable customer history must be retried: ACKing and only later discovering
// that it belonged to a deleted billing subject would lose the exact refund
// chain. Ordinary customer hazard observations retain their historical no-op
// behavior through AppendStripeCustomerDeletionHazards.
func (s *SQLiteStore) AppendStripePaidInvoiceDeletionHazards(ctx context.Context, customerID string, resources []BillingDeletionResource) error {
	if customerID == "" || len(resources) == 0 {
		return errors.New("account: paid invoice deletion attribution is incomplete")
	}
	return s.appendStripeCustomerDeletionHazards(ctx, customerID, resources, true)
}

func (s *SQLiteStore) appendStripeCustomerDeletionHazards(ctx context.Context, customerID string, resources []BillingDeletionResource, requireSubject bool) error {
	if customerID == "" || len(resources) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT DISTINCT user_id FROM stripe_customer_history WHERE customer_id=? LIMIT 2`, customerID)
	if err != nil {
		return err
	}
	var subjects []string
	for rows.Next() {
		var subject string
		if err := rows.Scan(&subject); err != nil {
			rows.Close()
			return err
		}
		subjects = append(subjects, subject)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if len(subjects) == 0 {
		if requireSubject {
			return errors.New("account: paid invoice customer has no durable billing subject")
		}
		return nil
	}
	if len(subjects) != 1 {
		return errors.New("account: Stripe customer billing subject is ambiguous")
	}
	for i := range resources {
		resources[i].CustomerID = customerID
	}
	handled, err := appendStripeDeletionHazardsTx(ctx, tx, subjects[0], resources)
	if err != nil {
		return err
	}
	if requireSubject && !handled {
		var completedDeletion int
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM billing_cancellation_outbox WHERE billing_subject_id=? AND provider='stripe' AND state='terminal' AND mode='account_deletion')`, subjects[0]).Scan(&completedDeletion); err != nil {
			return err
		}
		if completedDeletion != 0 {
			return ErrPaidInvoiceNeedsCanonicalEpoch
		}
	}
	return tx.Commit()
}

// AppendCanonicalStripePaidInvoiceDeletionHazards attaches a canonical paid
// invoice to exactly one completed deletion epoch. paid_at, not invoice.created,
// is the money boundary: equality with a second-granularity cutoff is ambiguous.
func (s *SQLiteStore) AppendCanonicalStripePaidInvoiceDeletionHazards(ctx context.Context, invoice CanonicalStripePaidInvoice, resources []BillingDeletionResource) error {
	if invoice.InvoiceID == "" || invoice.CustomerID == "" || invoice.CreatedAt <= 0 || invoice.PaidAt <= 0 || invoice.CreatedAt > invoice.PaidAt {
		return errors.New("account: canonical paid invoice evidence is incomplete")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT DISTINCT user_id FROM stripe_customer_history WHERE customer_id=? LIMIT 2`, invoice.CustomerID)
	if err != nil {
		return err
	}
	var subjects []string
	for rows.Next() {
		var subject string
		if err := rows.Scan(&subject); err != nil {
			rows.Close()
			return err
		}
		subjects = append(subjects, subject)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if len(subjects) != 1 {
		return errors.New("account: canonical paid invoice billing subject is not unique")
	}
	rows, err = tx.QueryContext(ctx, `SELECT id,customer_id,subscription_id,captured_source_id,created_at,cutoff_at,progress_json FROM billing_cancellation_outbox WHERE billing_subject_id=? AND provider='stripe' AND state='terminal' AND mode='account_deletion' ORDER BY generation DESC`, subjects[0])
	if err != nil {
		return err
	}
	var matches []string
	for rows.Next() {
		var id, customerID, subscriptionID, capturedSourceID, raw string
		var createdAt, cutoffAt int64
		if err := rows.Scan(&id, &customerID, &subscriptionID, &capturedSourceID, &createdAt, &cutoffAt, &raw); err != nil {
			rows.Close()
			return err
		}
		p, err := decodeDeletionProgressStrict(raw)
		if err != nil {
			rows.Close()
			return err
		}
		customerMatches := customerID == invoice.CustomerID
		for _, known := range p.Customers {
			customerMatches = customerMatches || known == invoice.CustomerID
		}
		if !customerMatches {
			continue
		}
		if cutoffAt == 0 {
			cutoffAt = createdAt
		}
		if invoice.PaidAt <= cutoffAt {
			continue
		}
		if invoice.SubscriptionID != "" {
			subscriptionMatches := subscriptionID == invoice.SubscriptionID || capturedSourceID == invoice.SubscriptionID
			for _, known := range p.Resources {
				subscriptionMatches = subscriptionMatches || (known.Kind == "subscription" && known.ID == invoice.SubscriptionID)
			}
			if !subscriptionMatches {
				continue
			}
		}
		matches = append(matches, id)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if len(matches) != 1 {
		return errors.New("account: canonical paid invoice does not identify one deletion epoch")
	}
	for i := range resources {
		resources[i].CustomerID = invoice.CustomerID
	}
	handled, err := appendExactStripeCompensationTx(ctx, tx, subjects[0], matches[0], resources)
	if err != nil {
		return err
	}
	if !handled {
		return errors.New("account: canonical paid invoice deletion epoch was not retained")
	}
	return tx.Commit()
}

type deletionStripeProvider interface {
	DiscoverDeletionHazards(context.Context, BillingCancellation, BillingDeletionProgress) (BillingDeletionProgress, error)
	ReconcileDeletionHazards(context.Context, BillingCancellation, BillingDeletionProgress) (BillingDeletionProgress, error)
}

func (s *Service) ReconcileBillingCancellations(ctx context.Context) {
	store, ok := s.Store().(interface {
		PendingBillingCancellations(context.Context, int) ([]BillingCancellation, error)
		SaveBillingCancellationProgress(context.Context, string, string, int64, int64, string, int64) (int64, error)
		FinishBillingCancellation(context.Context, string, string, int64, int64, string, string, bool, int64, int64) error
		CompactBillingCancellations(context.Context, int64, int64) error
	})
	provider, configured := s.biller.(deletionStripeProvider)
	if !ok || !configured {
		return
	}
	rows, err := store.PendingBillingCancellations(ctx, 100)
	if err != nil {
		log.Printf("billing deletion: listing cancellation outbox failed")
		return
	}
	for _, row := range rows {
		progress, discoverErr := decodeDeletionProgressStrict(row.ProgressJSON)
		exact := row.Mode == billingCancellationExactCompensation
		if discoverErr == nil && exact {
			for _, r := range progress.Resources {
				if r.Kind != "invoice" && r.Kind != "payment_intent" && r.Kind != "charge" {
					discoverErr = errors.New("account: exact compensation contains non-payment resource")
					break
				}
			}
		}
		if discoverErr == nil && !exact {
			progress, discoverErr = provider.DiscoverDeletionHazards(ctx, row, progress)
		}
		encoded, _ := json.Marshal(progress)
		if discoverErr == nil {
			row.Revision, discoverErr = store.SaveBillingCancellationProgress(ctx, row.ID, row.ClaimToken, row.Generation, row.Revision, string(encoded), s.now().Unix())
		}
		if discoverErr == nil {
			progress, discoverErr = provider.ReconcileDeletionHazards(ctx, row, progress)
			encoded, _ = json.Marshal(progress)
		}
		terminal := false
		if discoverErr == nil {
			if !exact {
				progress, discoverErr = provider.DiscoverDeletionHazards(ctx, row, progress)
			}
			encoded, _ = json.Marshal(progress)
			if discoverErr == nil {
				allTerminal := progress.hasIdentity()
				for _, r := range progress.Resources {
					if !r.Terminal {
						allTerminal = false
						break
					}
				}
				if allTerminal && progress.CleanSince == 0 {
					progress.CleanSince = s.now().Unix()
					encoded, _ = json.Marshal(progress)
				} else if !allTerminal {
					progress.CleanSince = 0
					encoded, _ = json.Marshal(progress)
				}
				terminal = progress.terminal(s.now().Unix())
			}
		}
		lastError := ""
		if discoverErr != nil {
			lastError = "reconciliation_failed"
		}
		if finishErr := store.FinishBillingCancellation(ctx, row.ID, row.ClaimToken, row.Generation, row.Revision, string(encoded), lastError, discoverErr == nil && terminal, row.Attempts, s.now().Unix()); finishErr != nil {
			log.Printf("billing deletion: recording cancellation attempt failed")
		}
		if discoverErr != nil && row.Attempts >= 4 {
			log.Printf("billing deletion: reconciliation remains pending subject=%s generation=%d attempts=%d", row.BillingSubjectID, row.Generation, row.Attempts+1)
		}
	}
	now := s.now().Unix()
	if err := store.CompactBillingCancellations(ctx, now-billingDeletionReviewDays*86400, now); err != nil {
		log.Printf("billing deletion: compacting terminal cancellation records failed")
	}
}
