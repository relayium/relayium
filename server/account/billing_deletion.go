package account

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"log"

	"github.com/relayium/relayium/authx"
)

const billingDeletionHoldDays = 400

type BillingCancellation struct {
	ID, BillingSubjectID, Provider, CustomerID, SubscriptionID, IdempotencyKey, State string
	Attempts, CreatedAt, UpdatedAt                                                    int64
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
		if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM billing_deletion_holds WHERE expires_at>unixepoch())`).Scan(&active); err != nil {
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

func billingUserFrozenTx(ctx context.Context, tx *sql.Tx, userID string, now int64) (bool, error) {
	var frozen int
	err := tx.QueryRowContext(ctx, `SELECT EXISTS(
 SELECT 1 FROM billing_deletion_holds h
 LEFT JOIN users u ON u.id=?
 WHERE h.expires_at>? AND (h.billing_subject_id=? OR (length(u.billing_hold_hmac)>0 AND h.email_hmac=u.billing_hold_hmac))
)`, userID, now, userID).Scan(&frozen)
	return frozen != 0, err
}

func (s *SQLiteStore) PrepareBillingDeletion(ctx context.Context, u User, now int64) (BillingCancellation, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return BillingCancellation{}, false, err
	}
	defer tx.Rollback()
	var provider string
	_ = tx.QueryRowContext(ctx, `SELECT provider FROM billing_authorities WHERE user_id=?`, u.ID).Scan(&provider)
	var stripeExternalID string
	stripeErr := tx.QueryRowContext(ctx, `SELECT external_id FROM subscription_sources WHERE user_id=? AND provider=?`, u.ID, ProviderStripe).Scan(&stripeExternalID)
	if stripeErr != nil && !errors.Is(stripeErr, sql.ErrNoRows) {
		return BillingCancellation{}, false, stripeErr
	}
	hasStripe := stripeErr == nil || u.StripeCustomerID != "" || u.StripeSubscriptionID != ""
	if provider == "" {
		_ = tx.QueryRowContext(ctx, `SELECT provider FROM subscription_sources WHERE user_id=? ORDER BY CASE provider WHEN 'stripe' THEN 0 ELSE 1 END LIMIT 1`, u.ID).Scan(&provider)
	}
	if provider == "" && hasStripe {
		provider = ProviderStripe
	}
	if provider == "" {
		return BillingCancellation{}, false, tx.Commit()
	}
	digest := s.billingEmailHMAC(u.Email)
	if len(digest) == 0 {
		return BillingCancellation{}, false, errors.New("account: billing deletion hold secret is unavailable")
	}
	expires := now + billingDeletionHoldDays*86400
	if _, err := tx.ExecContext(ctx, `INSERT INTO billing_deletion_holds(billing_subject_id,email_hmac,provider,created_at,expires_at)
 VALUES(?,?,?,?,?) ON CONFLICT(billing_subject_id) DO UPDATE SET expires_at=MAX(expires_at,excluded.expires_at)`, u.ID, digest, provider, now, expires); err != nil {
		return BillingCancellation{}, false, err
	}
	if !hasStripe {
		return BillingCancellation{}, false, tx.Commit()
	}
	subscriptionID := u.StripeSubscriptionID
	if subscriptionID == "" {
		subscriptionID = stripeExternalID
	}
	out := BillingCancellation{ID: authx.NewID(), BillingSubjectID: u.ID, Provider: ProviderStripe, CustomerID: u.StripeCustomerID, SubscriptionID: subscriptionID, State: "pending", CreatedAt: now, UpdatedAt: now}
	out.IdempotencyKey = "relayium-account-delete-" + out.ID
	_, err = tx.ExecContext(ctx, `INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,customer_id,subscription_id,idempotency_key,state,attempts,created_at,updated_at)
 VALUES(?,?,?,?,?,?,?,0,?,?) ON CONFLICT(billing_subject_id,provider) DO NOTHING`, out.ID, out.BillingSubjectID, out.Provider, out.CustomerID, out.SubscriptionID, out.IdempotencyKey, out.State, now, now)
	if err != nil {
		return BillingCancellation{}, false, err
	}
	if err := tx.QueryRowContext(ctx, `SELECT id,billing_subject_id,provider,customer_id,subscription_id,idempotency_key,state,attempts,created_at,updated_at FROM billing_cancellation_outbox WHERE billing_subject_id=? AND provider=?`, u.ID, ProviderStripe).
		Scan(&out.ID, &out.BillingSubjectID, &out.Provider, &out.CustomerID, &out.SubscriptionID, &out.IdempotencyKey, &out.State, &out.Attempts, &out.CreatedAt, &out.UpdatedAt); err != nil {
		return BillingCancellation{}, false, err
	}
	return out, true, tx.Commit()
}

func (s *SQLiteStore) PendingBillingCancellations(ctx context.Context, limit int) ([]BillingCancellation, error) {
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	rows, err := s.reader().QueryContext(ctx, `SELECT id,billing_subject_id,provider,customer_id,subscription_id,idempotency_key,state,attempts,created_at,updated_at FROM billing_cancellation_outbox WHERE state='pending' ORDER BY created_at,id LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []BillingCancellation
	for rows.Next() {
		var c BillingCancellation
		if err := rows.Scan(&c.ID, &c.BillingSubjectID, &c.Provider, &c.CustomerID, &c.SubscriptionID, &c.IdempotencyKey, &c.State, &c.Attempts, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *SQLiteStore) FinishBillingCancellation(ctx context.Context, id string, terminal bool, now int64) error {
	state := "pending"
	if terminal {
		state = "terminal"
	}
	_, err := s.db.ExecContext(ctx, `UPDATE billing_cancellation_outbox SET state=?,attempts=attempts+1,updated_at=? WHERE id=? AND state='pending'`, state, now, id)
	return err
}

type deletionStripeProvider interface {
	CancelSubscriptionForDeletion(context.Context, string, string) (bool, error)
}

func (s *Service) ReconcileBillingCancellations(ctx context.Context) {
	store, ok := s.Store().(interface {
		PendingBillingCancellations(context.Context, int) ([]BillingCancellation, error)
		FinishBillingCancellation(context.Context, string, bool, int64) error
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
		terminal := false
		if row.SubscriptionID != "" {
			terminal, err = provider.CancelSubscriptionForDeletion(ctx, row.SubscriptionID, row.IdempotencyKey)
		} else {
			err = fmt.Errorf("canonical subscription id unavailable")
		}
		if finishErr := store.FinishBillingCancellation(ctx, row.ID, err == nil && terminal, s.now().Unix()); finishErr != nil {
			log.Printf("billing deletion: recording cancellation attempt failed")
		}
	}
}
