package account

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"log"

	"github.com/relayium/relayium/authx"
)

const billingDeletionReviewDays = 400

type BillingCancellation struct {
	ID, BillingSubjectID, Provider, CustomerID, SubscriptionID, IdempotencyKey, State string
	ProgressJSON                                                                      string
	Attempts, CreatedAt, UpdatedAt, TerminalAt, ArchivedAt                            int64
}

type BillingDeletionProgress struct {
	CheckoutSessions []string `json:"checkoutSessions,omitempty"`
	Subscriptions    []string `json:"subscriptions,omitempty"`
	Schedules        []string `json:"schedules,omitempty"`
	InvoiceItems     []string `json:"invoiceItems,omitempty"`
	Invoices         []string `json:"invoices,omitempty"`
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
		if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM billing_deletion_holds WHERE subject_released_at=0)`).Scan(&active); err != nil {
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
	if err := tx.QueryRowContext(ctx, `SELECT provider FROM billing_authorities WHERE user_id=?`, u.ID).Scan(&provider); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, false, err
	}
	if err := tx.QueryRowContext(ctx, `SELECT external_id FROM subscription_sources WHERE user_id=? AND provider='stripe'`, u.ID).Scan(&stripeExternalID); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, false, err
	}
	hasStripe := stripeExternalID != "" || u.StripeCustomerID != "" || u.StripeSubscriptionID != ""
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
	if hasStripe {
		subID := u.StripeSubscriptionID
		if subID == "" {
			subID = stripeExternalID
		}
		id := authx.NewID()
		key := "relayium-account-delete-" + id
		if _, err := tx.ExecContext(ctx, `INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,customer_id,subscription_id,idempotency_key,state,attempts,created_at,updated_at,progress_json) VALUES(?,?,?,?,?,?,'pending',0,?,?,'{}') ON CONFLICT(billing_subject_id,provider) DO NOTHING`, id, u.ID, ProviderStripe, u.StripeCustomerID, subID, key, now, now); err != nil {
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
	rows, err := s.reader().QueryContext(ctx, `SELECT id,billing_subject_id,provider,customer_id,subscription_id,idempotency_key,state,progress_json,attempts,created_at,updated_at,terminal_at,archived_at FROM billing_cancellation_outbox WHERE state='pending' ORDER BY created_at,id LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []BillingCancellation
	for rows.Next() {
		var c BillingCancellation
		if err := rows.Scan(&c.ID, &c.BillingSubjectID, &c.Provider, &c.CustomerID, &c.SubscriptionID, &c.IdempotencyKey, &c.State, &c.ProgressJSON, &c.Attempts, &c.CreatedAt, &c.UpdatedAt, &c.TerminalAt, &c.ArchivedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *SQLiteStore) FinishBillingCancellation(ctx context.Context, id, progress string, terminal bool, now int64) error {
	state := "pending"
	if terminal {
		state = "terminal"
	}
	terminalAt := int64(0)
	if terminal {
		terminalAt = now
	}
	_, err := s.db.ExecContext(ctx, `UPDATE billing_cancellation_outbox SET state=?,progress_json=?,attempts=attempts+1,updated_at=?,terminal_at=? WHERE id=? AND state='pending'`, state, progress, now, terminalAt, id)
	return err
}

func (s *SQLiteStore) SaveBillingCancellationProgress(ctx context.Context, id, progress string, now int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE billing_cancellation_outbox SET progress_json=?,updated_at=? WHERE id=? AND state='pending'`, progress, now, id)
	return err
}

func (s *SQLiteStore) CompactBillingCancellations(ctx context.Context, before, now int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE billing_cancellation_outbox SET customer_id='',subscription_id='',progress_json='{}',archived_at=? WHERE state='terminal' AND terminal_at>0 AND terminal_at<=? AND archived_at=0`, now, before)
	return err
}

type deletionStripeProvider interface {
	DiscoverDeletionHazards(context.Context, string) (BillingDeletionProgress, error)
	ReconcileDeletionHazards(context.Context, BillingCancellation, BillingDeletionProgress) error
}

func (s *Service) ReconcileBillingCancellations(ctx context.Context) {
	store, ok := s.Store().(interface {
		PendingBillingCancellations(context.Context, int) ([]BillingCancellation, error)
		SaveBillingCancellationProgress(context.Context, string, string, int64) error
		FinishBillingCancellation(context.Context, string, string, bool, int64) error
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
		progress, discoverErr := provider.DiscoverDeletionHazards(ctx, row.CustomerID)
		encoded, _ := json.Marshal(progress)
		if discoverErr == nil {
			discoverErr = store.SaveBillingCancellationProgress(ctx, row.ID, string(encoded), s.now().Unix())
		}
		if discoverErr == nil {
			discoverErr = provider.ReconcileDeletionHazards(ctx, row, progress)
		}
		terminal := false
		if discoverErr == nil {
			progress, discoverErr = provider.DiscoverDeletionHazards(ctx, row.CustomerID)
			encoded, _ = json.Marshal(progress)
			terminal = len(progress.CheckoutSessions)+len(progress.Subscriptions)+len(progress.Schedules)+len(progress.InvoiceItems)+len(progress.Invoices) == 0
		}
		if finishErr := store.FinishBillingCancellation(ctx, row.ID, string(encoded), discoverErr == nil && terminal, s.now().Unix()); finishErr != nil {
			log.Printf("billing deletion: recording cancellation attempt failed")
		}
	}
	now := s.now().Unix()
	if err := store.CompactBillingCancellations(ctx, now-billingDeletionReviewDays*86400, now); err != nil {
		log.Printf("billing deletion: compacting terminal cancellation records failed")
	}
}
