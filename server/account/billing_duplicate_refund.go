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
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

type DuplicateRefundPlan struct {
	UserID, CustomerID, CanonicalSubscriptionID, DuplicateSubscriptionID string
	InvoiceID, ManualReason                                              string
	Payments                                                             []CanonicalStripeInvoicePayment
}

type DuplicateRefundJob struct {
	DuplicateRefundPlan
	ID                                       string
	State, LastError                         string
	SubscriptionCanceled, RefundComplete     bool
	Attempts, Revision, CreatedAt, UpdatedAt int64
}

type DuplicateRefundResult struct {
	SubscriptionCanceled, RefundComplete bool
	ManualReason                         string
}

type DuplicateRefundEvidence struct {
	JobID, DuplicateSubscriptionID, CanonicalSubscriptionID, InvoiceID string
	State, ManualReason                                                string
	SubscriptionCanceled, RefundComplete                               bool
	HasError                                                           bool
	Attempts, Revision                                                 int64
	Payments                                                           []CanonicalStripeInvoicePayment
	ActionID, ActionState                                              string
	ActionGeneration                                                   int64
}

type DuplicateRefundOperatorResult struct {
	ActionID string
	State    string
}

type duplicateRefundAction struct {
	ID, JobID, Actor, Reason, State, SnapshotJSON, ProofJSON, LastError string
	Generation, Revision                                                int64
}

var errDuplicateRefundProviderFailed = errors.New("stripe: duplicate refund provider reported a terminal failed refund")

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
	err := s.reader().QueryRowContext(ctx, `SELECT id,user_id,customer_id,canonical_subscription_id,duplicate_subscription_id,invoice_id,constituents_json,state,manual_reason,subscription_canceled,refund_complete,attempts,revision,last_error,created_at,updated_at FROM billing_duplicate_refunds WHERE duplicate_subscription_id=?`, subscriptionID).
		Scan(&row.ID, &row.UserID, &row.CustomerID, &row.CanonicalSubscriptionID, &row.DuplicateSubscriptionID, &row.InvoiceID, &raw, &row.State, &row.ManualReason, &canceled, &refunded, &row.Attempts, &row.Revision, &row.LastError, &row.CreatedAt, &row.UpdatedAt)
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

func (s *SQLiteStore) duplicateRefundBySelector(ctx context.Context, selector string) (DuplicateRefundJob, bool, error) {
	var subscriptionID string
	err := s.reader().QueryRowContext(ctx, `SELECT duplicate_subscription_id FROM billing_duplicate_refunds WHERE id=? OR duplicate_subscription_id=? LIMIT 1`, selector, selector).Scan(&subscriptionID)
	if errors.Is(err, sql.ErrNoRows) {
		return DuplicateRefundJob{}, false, nil
	}
	if err != nil {
		return DuplicateRefundJob{}, false, err
	}
	return s.DuplicateRefundBySubscription(ctx, subscriptionID)
}

func ListDuplicateRefundEvidence(ctx context.Context, store *SQLiteStore, selector string) (DuplicateRefundEvidence, error) {
	var out DuplicateRefundEvidence
	if store == nil || strings.TrimSpace(selector) == "" {
		return out, errors.New("account: duplicate refund job or subscription id is required")
	}
	job, ok, err := store.duplicateRefundBySelector(ctx, strings.TrimSpace(selector))
	if err != nil || !ok {
		if err == nil {
			err = sql.ErrNoRows
		}
		return out, err
	}
	out.JobID, out.DuplicateSubscriptionID, out.CanonicalSubscriptionID, out.InvoiceID = job.ID, job.DuplicateSubscriptionID, job.CanonicalSubscriptionID, job.InvoiceID
	out.State, out.ManualReason, out.HasError = job.State, job.ManualReason, job.LastError != ""
	out.SubscriptionCanceled, out.RefundComplete = job.SubscriptionCanceled, job.RefundComplete
	out.Attempts, out.Revision, out.Payments = job.Attempts, job.Revision, normalizeInvoicePayments(job.Payments)
	err = store.reader().QueryRowContext(ctx, `SELECT id,state,generation FROM billing_duplicate_refund_actions WHERE job_id=? ORDER BY generation DESC LIMIT 1`, job.ID).
		Scan(&out.ActionID, &out.ActionState, &out.ActionGeneration)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return DuplicateRefundEvidence{}, err
	}
	return out, nil
}

func duplicateRefundActionID(jobID string, generation int64) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("relayium:duplicate-refund-action:v1\x00%s\x00%d", jobID, generation)))
	return "bdra_" + hex.EncodeToString(sum[:16])
}

func prepareDuplicateRefundAction(ctx context.Context, store *SQLiteStore, job DuplicateRefundJob, actor, reason string, now int64) (duplicateRefundAction, error) {
	actor, reason = strings.TrimSpace(actor), strings.TrimSpace(reason)
	if actor == "" || reason == "" || len(actor) > 256 || len(reason) > 1024 {
		return duplicateRefundAction{}, errors.New("account: duplicate refund actor and reason are required and bounded")
	}
	snapshot, err := json.Marshal(normalizeInvoicePayments(job.Payments))
	if err != nil {
		return duplicateRefundAction{}, err
	}
	var previous duplicateRefundAction
	err = store.reader().QueryRowContext(ctx, `SELECT id,job_id,generation,actor,reason,state,snapshot_json,proof_json,last_error,revision FROM billing_duplicate_refund_actions WHERE job_id=? ORDER BY generation DESC LIMIT 1`, job.ID).
		Scan(&previous.ID, &previous.JobID, &previous.Generation, &previous.Actor, &previous.Reason, &previous.State, &previous.SnapshotJSON, &previous.ProofJSON, &previous.LastError, &previous.Revision)
	generation := int64(1)
	if err == nil {
		if previous.Actor != actor || previous.Reason != reason || previous.SnapshotJSON != string(snapshot) {
			return duplicateRefundAction{}, errors.New("account: duplicate refund action ownership conflict")
		}
		if previous.State != "blocked" || previous.LastError != errDuplicateRefundProviderFailed.Error() {
			return previous, nil
		}
		generation = previous.Generation + 1
	} else if !errors.Is(err, sql.ErrNoRows) {
		return duplicateRefundAction{}, err
	}
	id := duplicateRefundActionID(job.ID, generation)
	if _, err := store.db.ExecContext(ctx, `INSERT OR IGNORE INTO billing_duplicate_refund_actions(id,job_id,generation,actor,reason,state,snapshot_json,created_at,updated_at) VALUES(?,?,?,?,?,'prepared',?,?,?)`, id, job.ID, generation, actor, reason, string(snapshot), now, now); err != nil {
		return duplicateRefundAction{}, err
	}
	var action duplicateRefundAction
	if err := store.reader().QueryRowContext(ctx, `SELECT id,job_id,generation,actor,reason,state,snapshot_json,proof_json,last_error,revision FROM billing_duplicate_refund_actions WHERE job_id=? AND generation=?`, job.ID, generation).
		Scan(&action.ID, &action.JobID, &action.Generation, &action.Actor, &action.Reason, &action.State, &action.SnapshotJSON, &action.ProofJSON, &action.LastError, &action.Revision); err != nil {
		return duplicateRefundAction{}, err
	}
	if action.ID != id || action.Actor != actor || action.Reason != reason || action.SnapshotJSON != string(snapshot) {
		return duplicateRefundAction{}, errors.New("account: duplicate refund action ownership conflict")
	}
	return action, nil
}

func markDuplicateRefundActionError(ctx context.Context, store *SQLiteStore, action duplicateRefundAction, message string, blocked bool, now int64) error {
	state := "prepared"
	if blocked {
		state = "blocked"
	}
	_, err := store.db.ExecContext(ctx, `UPDATE billing_duplicate_refund_actions SET state=?,last_error=?,revision=revision+1,updated_at=? WHERE id=? AND state<>'succeeded'`, state, message, now, action.ID)
	return err
}

func findCanonicalInvoicePayment(invoice CanonicalStripePaidInvoice, id string) (CanonicalStripeInvoicePayment, bool) {
	for _, payment := range invoice.Payments {
		if payment.InvoicePaymentID == id {
			return payment, true
		}
	}
	return CanonicalStripeInvoicePayment{}, false
}

func executeDuplicateRefundAction(ctx context.Context, client *stripeClient, job DuplicateRefundJob, action duplicateRefundAction) (string, error) {
	if job.InvoiceID == "" || len(job.Payments) == 0 {
		return "", errors.New("stripe: duplicate refund has no canonical invoice payment identity")
	}
	expected := normalizeInvoicePayments(job.Payments)
	for _, payment := range expected {
		if payment.PaymentType != "payment_intent" || payment.PaymentIntentID == "" || payment.ChargeID == "" || payment.ChargeAmount != payment.AmountPaid {
			return "", errors.New("stripe: duplicate refund constituent is shared or unsupported")
		}
	}
	for _, expectedPayment := range expected {
		invoice, err := client.canonicalInvoicePayments(ctx, job.InvoiceID, job.CustomerID, job.DuplicateSubscriptionID, true)
		if err != nil {
			return "", err
		}
		if !duplicatePaymentIdentitiesEqual(invoice.Payments, expected) {
			return "", errors.New("stripe: duplicate refund payment identity drifted")
		}
		current, ok := findCanonicalInvoicePayment(invoice, expectedPayment.InvoicePaymentID)
		if !ok || current.AmountRefunded < 0 || current.AmountRefunded > current.AmountPaid {
			return "", errors.New("stripe: duplicate refund constituent is not canonical")
		}
		remaining := current.AmountPaid - current.AmountRefunded
		if remaining == 0 {
			continue
		}
		form := url.Values{"payment_intent": {current.PaymentIntentID}, "amount": {fmt.Sprint(remaining)}, "metadata[relayium_duplicate_refund_action_id]": {action.ID}, "metadata[relayium_invoice_payment_id]": {current.InvoicePaymentID}}
		body, err := client.requestKeyed(ctx, http.MethodPost, "/v1/refunds", form, "duplicate-refund:"+action.ID+":"+current.InvoicePaymentID)
		if err != nil {
			return "", err
		}
		var created struct {
			ID, Status string
		}
		if json.Unmarshal(body, &created) != nil || created.ID == "" {
			return "", errors.New("stripe: duplicate refund response is invalid")
		}
		if created.Status == "failed" || created.Status == "canceled" {
			return "", errDuplicateRefundProviderFailed
		}
		verified, err := client.canonicalInvoicePayments(ctx, job.InvoiceID, job.CustomerID, job.DuplicateSubscriptionID, true)
		if err != nil {
			return "", err
		}
		got, ok := findCanonicalInvoicePayment(verified, current.InvoicePaymentID)
		if !ok || !duplicatePaymentIdentitiesEqual(verified.Payments, expected) || got.AmountRefunded != got.AmountPaid {
			return "", errors.New("stripe: duplicate refund constituent is not canonically complete")
		}
	}
	invoice, err := client.canonicalInvoicePayments(ctx, job.InvoiceID, job.CustomerID, job.DuplicateSubscriptionID, true)
	if err != nil {
		return "", err
	}
	if !duplicatePaymentIdentitiesEqual(invoice.Payments, expected) {
		return "", errors.New("stripe: duplicate refund final identity changed")
	}
	proofPayments := normalizeInvoicePayments(invoice.Payments)
	for _, payment := range proofPayments {
		if payment.AmountRefunded != payment.AmountPaid {
			return "", errors.New("stripe: duplicate refund final proof is incomplete")
		}
	}
	proof, err := json.Marshal(struct {
		InvoiceID string                          `json:"invoiceId"`
		Payments  []CanonicalStripeInvoicePayment `json:"payments"`
	}{job.InvoiceID, proofPayments})
	return string(proof), err
}

func finishDuplicateRefundAction(ctx context.Context, store *SQLiteStore, job DuplicateRefundJob, action duplicateRefundAction, proof string, now int64) error {
	if proof == "" {
		return errors.New("account: duplicate refund proof is empty")
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var jobState, actionState, savedProof string
	var jobRevision, actionRevision int64
	if err := tx.QueryRowContext(ctx, `SELECT state,revision FROM billing_duplicate_refunds WHERE id=?`, job.ID).Scan(&jobState, &jobRevision); err != nil {
		return err
	}
	if err := tx.QueryRowContext(ctx, `SELECT state,revision,proof_json FROM billing_duplicate_refund_actions WHERE id=?`, action.ID).Scan(&actionState, &actionRevision, &savedProof); err != nil {
		return err
	}
	if jobState == "terminal" && actionState == "succeeded" {
		if savedProof != proof {
			return errors.New("account: duplicate refund terminal proof changed")
		}
		return nil
	}
	if jobState != "manual" || actionState != "prepared" || !job.SubscriptionCanceled {
		return errors.New("account: duplicate refund action is not finalizable")
	}
	res, err := tx.ExecContext(ctx, `UPDATE billing_duplicate_refund_actions SET state='succeeded',proof_json=?,last_error='',revision=revision+1,updated_at=? WHERE id=? AND state='prepared' AND revision=?`, proof, now, action.ID, actionRevision)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return errors.New("account: stale duplicate refund action")
	}
	res, err = tx.ExecContext(ctx, `UPDATE billing_duplicate_refunds SET state='terminal',manual_reason='',refund_complete=1,last_error='',revision=revision+1,updated_at=? WHERE id=? AND state='manual' AND revision=?`, now, job.ID, jobRevision)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return errors.New("account: stale duplicate refund job")
	}
	return tx.Commit()
}

func ResolveDuplicateRefund(ctx context.Context, store *SQLiteStore, biller Biller, selector, actor, reason string) (DuplicateRefundOperatorResult, error) {
	client, ok := biller.(*stripeClient)
	if !ok || store == nil {
		return DuplicateRefundOperatorResult{}, errors.New("account: duplicate refund operator is unavailable")
	}
	job, found, err := store.duplicateRefundBySelector(ctx, strings.TrimSpace(selector))
	if err != nil || !found {
		if err == nil {
			err = sql.ErrNoRows
		}
		return DuplicateRefundOperatorResult{}, err
	}
	if job.State != "manual" && job.State != "terminal" {
		return DuplicateRefundOperatorResult{}, errors.New("account: duplicate refund job is not manual")
	}
	action, err := prepareDuplicateRefundAction(ctx, store, job, actor, reason, time.Now().Unix())
	if err != nil {
		return DuplicateRefundOperatorResult{}, err
	}
	if action.State == "blocked" {
		return DuplicateRefundOperatorResult{ActionID: action.ID, State: action.State}, errors.New("account: duplicate refund action is blocked on missing canonical identity")
	}
	proof, err := executeDuplicateRefundAction(ctx, client, job, action)
	if err != nil {
		blocked := job.InvoiceID == "" || len(job.Payments) == 0 || errors.Is(err, errDuplicateRefundProviderFailed) || strings.Contains(err.Error(), "shared or unsupported") || strings.Contains(err.Error(), "identity drifted")
		if saveErr := markDuplicateRefundActionError(ctx, store, action, err.Error(), blocked, time.Now().Unix()); saveErr != nil {
			return DuplicateRefundOperatorResult{ActionID: action.ID, State: "prepared"}, fmt.Errorf("%w; persist operator evidence: %v", err, saveErr)
		}
		state := "prepared"
		if blocked {
			state = "blocked"
		}
		return DuplicateRefundOperatorResult{ActionID: action.ID, State: state}, err
	}
	if err := finishDuplicateRefundAction(ctx, store, job, action, proof, time.Now().Unix()); err != nil {
		return DuplicateRefundOperatorResult{ActionID: action.ID, State: "prepared"}, err
	}
	return DuplicateRefundOperatorResult{ActionID: action.ID, State: "succeeded"}, nil
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
	if err := tx.QueryRowContext(ctx, `SELECT id,user_id,customer_id,canonical_subscription_id,duplicate_subscription_id,invoice_id,constituents_json,state,manual_reason,subscription_canceled,refund_complete,attempts,revision,last_error,created_at,updated_at FROM billing_duplicate_refunds WHERE duplicate_subscription_id=?`, plan.DuplicateSubscriptionID).
		Scan(&got.ID, &got.UserID, &got.CustomerID, &got.CanonicalSubscriptionID, &got.DuplicateSubscriptionID, &got.InvoiceID, &gotRaw, &got.State, &got.ManualReason, &canceled, &refunded, &got.Attempts, &got.Revision, &got.LastError, &got.CreatedAt, &got.UpdatedAt); err != nil {
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
	res, err := s.db.ExecContext(ctx, `UPDATE billing_duplicate_refunds SET state=?,manual_reason=?,subscription_canceled=?,refund_complete=?,attempts=attempts+1,revision=revision+1,last_error=?,updated_at=? WHERE id=? AND state<>'terminal'`, state, manual, b2i(result.SubscriptionCanceled), b2i(result.RefundComplete), lastError, now, job.ID)
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
