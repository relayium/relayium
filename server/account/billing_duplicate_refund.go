package account

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sort"
)

type DuplicateRefundPlan struct {
	UserID, CustomerID, CanonicalSubscriptionID, DuplicateSubscriptionID string
	InvoiceID, ManualReason                                              string
	Payments                                                             []CanonicalStripeInvoicePayment
}

type DuplicateRefundJob struct {
	DuplicateRefundPlan
	ID                                   string
	State, LastError                     string
	SubscriptionCanceled, RefundComplete bool
	Attempts, CreatedAt, UpdatedAt       int64
}

type DuplicateRefundResult struct {
	SubscriptionCanceled, RefundComplete bool
	ManualReason                         string
}

type duplicateSubscriptionProvider interface {
	InspectDuplicateSubscription(context.Context, string, string, string, string) (DuplicateRefundPlan, error)
	ReconcileDuplicateSubscription(context.Context, DuplicateRefundJob) (DuplicateRefundResult, error)
}

type duplicateRefundStore interface {
	DuplicateRefundBySubscription(context.Context, string) (DuplicateRefundJob, bool, error)
	PutDuplicateRefund(context.Context, DuplicateRefundPlan, int64) (DuplicateRefundJob, error)
	SaveDuplicateRefund(context.Context, DuplicateRefundJob, DuplicateRefundResult, error, int64) error
	ListDuplicateRefunds(context.Context, int) ([]DuplicateRefundJob, error)
}

func duplicateRefundID(subscriptionID string) string {
	sum := sha256.Sum256([]byte("relayium:duplicate-refund:v1\x00" + subscriptionID))
	return "bdup_" + hex.EncodeToString(sum[:16])
}

func normalizeInvoicePayments(payments []CanonicalStripeInvoicePayment) []CanonicalStripeInvoicePayment {
	out := append([]CanonicalStripeInvoicePayment(nil), payments...)
	sort.Slice(out, func(i, j int) bool { return out[i].InvoicePaymentID < out[j].InvoicePaymentID })
	return out
}

func (s *SQLiteStore) DuplicateRefundBySubscription(ctx context.Context, subscriptionID string) (DuplicateRefundJob, bool, error) {
	var row DuplicateRefundJob
	var raw string
	var canceled, refunded int
	err := s.reader().QueryRowContext(ctx, `SELECT id,user_id,customer_id,canonical_subscription_id,duplicate_subscription_id,invoice_id,constituents_json,state,manual_reason,subscription_canceled,refund_complete,attempts,last_error,created_at,updated_at FROM billing_duplicate_refunds WHERE duplicate_subscription_id=?`, subscriptionID).
		Scan(&row.ID, &row.UserID, &row.CustomerID, &row.CanonicalSubscriptionID, &row.DuplicateSubscriptionID, &row.InvoiceID, &raw, &row.State, &row.ManualReason, &canceled, &refunded, &row.Attempts, &row.LastError, &row.CreatedAt, &row.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return DuplicateRefundJob{}, false, nil
	}
	if err != nil {
		return DuplicateRefundJob{}, false, err
	}
	if err := json.Unmarshal([]byte(raw), &row.Payments); err != nil {
		return DuplicateRefundJob{}, false, fmt.Errorf("account: decode duplicate refund constituents: %w", err)
	}
	row.SubscriptionCanceled, row.RefundComplete = canceled != 0, refunded != 0
	return row, true, nil
}

func (s *SQLiteStore) PutDuplicateRefund(ctx context.Context, plan DuplicateRefundPlan, now int64) (DuplicateRefundJob, error) {
	if plan.UserID == "" || plan.CustomerID == "" || plan.CanonicalSubscriptionID == "" || plan.DuplicateSubscriptionID == "" || plan.CanonicalSubscriptionID == plan.DuplicateSubscriptionID {
		return DuplicateRefundJob{}, errors.New("account: duplicate refund identity is incomplete")
	}
	plan.Payments = normalizeInvoicePayments(plan.Payments)
	raw, err := json.Marshal(plan.Payments)
	if err != nil {
		return DuplicateRefundJob{}, err
	}
	state := "pending"
	if plan.ManualReason != "" {
		state = "manual"
	}
	id := duplicateRefundID(plan.DuplicateSubscriptionID)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return DuplicateRefundJob{}, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO billing_duplicate_refunds(id,user_id,customer_id,canonical_subscription_id,duplicate_subscription_id,invoice_id,constituents_json,state,manual_reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, id, plan.UserID, plan.CustomerID, plan.CanonicalSubscriptionID, plan.DuplicateSubscriptionID, plan.InvoiceID, string(raw), state, plan.ManualReason, now, now); err != nil {
		return DuplicateRefundJob{}, err
	}
	var got DuplicateRefundJob
	var gotRaw string
	var canceled, refunded int
	if err := tx.QueryRowContext(ctx, `SELECT id,user_id,customer_id,canonical_subscription_id,duplicate_subscription_id,invoice_id,constituents_json,state,manual_reason,subscription_canceled,refund_complete,attempts,last_error,created_at,updated_at FROM billing_duplicate_refunds WHERE duplicate_subscription_id=?`, plan.DuplicateSubscriptionID).
		Scan(&got.ID, &got.UserID, &got.CustomerID, &got.CanonicalSubscriptionID, &got.DuplicateSubscriptionID, &got.InvoiceID, &gotRaw, &got.State, &got.ManualReason, &canceled, &refunded, &got.Attempts, &got.LastError, &got.CreatedAt, &got.UpdatedAt); err != nil {
		return DuplicateRefundJob{}, err
	}
	if got.UserID != plan.UserID || got.CustomerID != plan.CustomerID || got.CanonicalSubscriptionID != plan.CanonicalSubscriptionID || got.InvoiceID != plan.InvoiceID || gotRaw != string(raw) {
		return DuplicateRefundJob{}, errors.New("account: duplicate refund responsibility conflicts with existing row")
	}
	got.Payments, got.SubscriptionCanceled, got.RefundComplete = plan.Payments, canceled != 0, refunded != 0
	if err := tx.Commit(); err != nil {
		return DuplicateRefundJob{}, err
	}
	return got, nil
}

func (s *SQLiteStore) SaveDuplicateRefund(ctx context.Context, job DuplicateRefundJob, result DuplicateRefundResult, providerErr error, now int64) error {
	state, manual, lastError := "pending", result.ManualReason, ""
	if manual != "" {
		state = "manual"
	}
	if result.SubscriptionCanceled && result.RefundComplete && manual == "" {
		state = "terminal"
	}
	if providerErr != nil {
		lastError = providerErr.Error()
	}
	res, err := s.db.ExecContext(ctx, `UPDATE billing_duplicate_refunds SET state=?,manual_reason=?,subscription_canceled=?,refund_complete=?,attempts=attempts+1,last_error=?,updated_at=? WHERE id=? AND state<>'terminal'`, state, manual, b2i(result.SubscriptionCanceled), b2i(result.RefundComplete), lastError, now, job.ID)
	if err != nil {
		return err
	}
	if n, err := res.RowsAffected(); err != nil || n != 1 {
		if err != nil {
			return err
		}
		var state string
		if err := s.reader().QueryRowContext(ctx, `SELECT state FROM billing_duplicate_refunds WHERE id=?`, job.ID).Scan(&state); err == nil && state == "terminal" {
			return nil
		}
		return errors.New("account: duplicate refund update lost ownership")
	}
	return nil
}

func (s *SQLiteStore) ListDuplicateRefunds(ctx context.Context, limit int) ([]DuplicateRefundJob, error) {
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	rows, err := s.reader().QueryContext(ctx, `SELECT duplicate_subscription_id FROM billing_duplicate_refunds WHERE state='pending' OR (state='manual' AND subscription_canceled=0) ORDER BY updated_at,id LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]DuplicateRefundJob, 0, len(ids))
	for _, id := range ids {
		row, ok, err := s.DuplicateRefundBySubscription(ctx, id)
		if err != nil {
			return nil, err
		}
		if ok {
			out = append(out, row)
		}
	}
	return out, nil
}

func (s *Service) reconcileDuplicateSubscription(ctx context.Context, user User, canonicalID, duplicateID string) error {
	store, ok := s.Store().(duplicateRefundStore)
	if !ok {
		return errors.New("billing: duplicate refund store is unavailable")
	}
	provider, ok := s.biller.(duplicateSubscriptionProvider)
	if !ok {
		return errors.New("billing: duplicate refund provider is unavailable")
	}
	job, exists, err := store.DuplicateRefundBySubscription(ctx, duplicateID)
	if err != nil {
		return err
	}
	if !exists {
		plan, err := provider.InspectDuplicateSubscription(ctx, user.ID, user.StripeCustomerID, canonicalID, duplicateID)
		if err != nil {
			return err
		}
		job, err = store.PutDuplicateRefund(ctx, plan, s.Now().Unix())
		if err != nil {
			return err
		}
	}
	return s.runDuplicateRefund(ctx, store, provider, job)
}

func (s *Service) runDuplicateRefund(ctx context.Context, store duplicateRefundStore, provider duplicateSubscriptionProvider, job DuplicateRefundJob) error {
	result, providerErr := provider.ReconcileDuplicateSubscription(ctx, job)
	if err := store.SaveDuplicateRefund(ctx, job, result, providerErr, s.Now().Unix()); err != nil {
		return err
	}
	return providerErr
}

func (s *Service) ReconcileDuplicateRefunds(ctx context.Context) {
	store, ok := s.Store().(duplicateRefundStore)
	provider, providerOK := s.biller.(duplicateSubscriptionProvider)
	if !ok || !providerOK {
		return
	}
	jobs, err := store.ListDuplicateRefunds(ctx, 100)
	if err != nil {
		log.Printf("billing: list duplicate refund responsibilities: %v", err)
		return
	}
	for _, job := range jobs {
		if err := s.runDuplicateRefund(ctx, store, provider, job); err != nil {
			log.Printf("billing: reconcile duplicate refund %s: %v", job.ID, err)
		}
	}
}

func duplicateRefundManualReason(invoice CanonicalStripePaidInvoice) string {
	if invoice.AmountPaid == 0 {
		return ""
	}
	if !invoiceHasOneExclusivePaymentIntent(invoice) {
		return "multiple_or_unsupported_invoice_payments"
	}
	return ""
}

func duplicatePaymentIdentitiesEqual(a, b []CanonicalStripeInvoicePayment) bool {
	aa, bb := normalizeInvoicePayments(a), normalizeInvoicePayments(b)
	if len(aa) != len(bb) {
		return false
	}
	for i := range aa {
		aa[i].AmountRefunded, bb[i].AmountRefunded = 0, 0
		if aa[i] != bb[i] {
			return false
		}
	}
	return true
}
