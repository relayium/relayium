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
	Liabilities                                                          []DuplicateRefundLiability
}

type DuplicateRefundLiability struct {
	InvoiceID    string                          `json:"invoiceId"`
	Status       string                          `json:"status"`
	AmountPaid   int64                           `json:"amountPaid"`
	Payments     []CanonicalStripeInvoicePayment `json:"payments"`
	ManualReason string                          `json:"manualReason,omitempty"`
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
	Generation, JobRevision, Revision                                   int64
}

var errDuplicateRefundProviderFailed = errors.New("stripe: duplicate refund provider reported a terminal failed refund")
var errDuplicateRefundPending = errors.New("stripe: duplicate refund remains pending")
var errDuplicateRefundReopened = errors.New("account: duplicate refund failure reopened operator reconciliation")

type duplicateRefundObservation struct {
	RefundID, InvoicePaymentID, PaymentIntentID, Status string
	Amount                                              int64
}

type duplicateRefundProof struct {
	Digest  string                       `json:"digest"`
	Refunds []duplicateRefundObservation `json:"refunds"`
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
	liabilityRows, err := s.reader().QueryContext(ctx, `SELECT i.invoice_id,i.status,i.amount_paid,i.manual_reason,l.invoice_payment_id,l.payment_type,l.payment_intent_id,l.payment_record_id,l.charge_id,l.amount_paid,l.charge_amount,l.paid_at
 FROM billing_duplicate_refund_invoices i LEFT JOIN billing_duplicate_refund_liabilities l ON l.job_id=i.job_id AND l.invoice_id=i.invoice_id
 WHERE i.job_id=? ORDER BY i.invoice_id,l.invoice_payment_id`, row.ID)
	if err != nil {
		return DuplicateRefundJob{}, false, err
	}
	var current *DuplicateRefundLiability
	for liabilityRows.Next() {
		var invoiceID, status, manualReason string
		var invoiceAmountPaid int64
		var invoicePaymentID, paymentType, paymentIntentID, paymentRecordID, chargeID sql.NullString
		var amountPaid, chargeAmount, paidAt sql.NullInt64
		if err := liabilityRows.Scan(&invoiceID, &status, &invoiceAmountPaid, &manualReason, &invoicePaymentID, &paymentType, &paymentIntentID, &paymentRecordID, &chargeID, &amountPaid, &chargeAmount, &paidAt); err != nil {
			liabilityRows.Close()
			return DuplicateRefundJob{}, false, err
		}
		if current == nil || current.InvoiceID != invoiceID {
			row.Liabilities = append(row.Liabilities, DuplicateRefundLiability{InvoiceID: invoiceID, Status: status, AmountPaid: invoiceAmountPaid, ManualReason: manualReason})
			current = &row.Liabilities[len(row.Liabilities)-1]
		}
		if invoicePaymentID.Valid {
			current.Payments = append(current.Payments, CanonicalStripeInvoicePayment{InvoicePaymentID: invoicePaymentID.String, PaymentType: paymentType.String, PaymentIntentID: paymentIntentID.String, PaymentRecordID: paymentRecordID.String, ChargeID: chargeID.String, AmountPaid: amountPaid.Int64, ChargeAmount: chargeAmount.Int64, PaidAt: paidAt.Int64})
		}
	}
	if err := liabilityRows.Close(); err != nil {
		return DuplicateRefundJob{}, false, err
	}
	if len(row.Liabilities) == 1 {
		row.InvoiceID, row.Payments = row.Liabilities[0].InvoiceID, row.Liabilities[0].Payments
	}
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
	snapshot, err := json.Marshal(job.Liabilities)
	if err != nil {
		return duplicateRefundAction{}, err
	}
	var previous duplicateRefundAction
	err = store.reader().QueryRowContext(ctx, `SELECT id,job_id,generation,job_revision,actor,reason,state,snapshot_json,proof_json,last_error,revision FROM billing_duplicate_refund_actions WHERE job_id=? ORDER BY generation DESC LIMIT 1`, job.ID).
		Scan(&previous.ID, &previous.JobID, &previous.Generation, &previous.JobRevision, &previous.Actor, &previous.Reason, &previous.State, &previous.SnapshotJSON, &previous.ProofJSON, &previous.LastError, &previous.Revision)
	generation := int64(1)
	if err == nil {
		if previous.Actor != actor || previous.Reason != reason {
			return duplicateRefundAction{}, errors.New("account: duplicate refund action ownership conflict")
		}
		if previous.SnapshotJSON != string(snapshot) {
			if previous.State != "succeeded" && previous.State != "failed" {
				return duplicateRefundAction{}, errors.New("account: duplicate refund liability changed during an active action")
			}
			generation = previous.Generation + 1
		} else if previous.State != "blocked" || previous.LastError != errDuplicateRefundProviderFailed.Error() {
			return previous, nil
		} else {
			generation = previous.Generation + 1
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return duplicateRefundAction{}, err
	}
	id := duplicateRefundActionID(job.ID, generation)
	if _, err := store.db.ExecContext(ctx, `INSERT OR IGNORE INTO billing_duplicate_refund_actions(id,job_id,generation,job_revision,actor,reason,state,snapshot_json,created_at,updated_at) VALUES(?,?,?,?,?,?,'prepared',?,?,?)`, id, job.ID, generation, job.Revision, actor, reason, string(snapshot), now, now); err != nil {
		return duplicateRefundAction{}, err
	}
	var action duplicateRefundAction
	if err := store.reader().QueryRowContext(ctx, `SELECT id,job_id,generation,job_revision,actor,reason,state,snapshot_json,proof_json,last_error,revision FROM billing_duplicate_refund_actions WHERE job_id=? AND generation=?`, job.ID, generation).
		Scan(&action.ID, &action.JobID, &action.Generation, &action.JobRevision, &action.Actor, &action.Reason, &action.State, &action.SnapshotJSON, &action.ProofJSON, &action.LastError, &action.Revision); err != nil {
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

func (c *stripeClient) canonicalDuplicateRefundObservations(ctx context.Context, payment CanonicalStripeInvoicePayment) ([]duplicateRefundObservation, error) {
	query := url.Values{"payment_intent": {payment.PaymentIntentID}, "limit": {"100"}}
	seen := map[string]bool{}
	var observations []duplicateRefundObservation
	var succeeded int64
	for {
		body, err := c.request(ctx, http.MethodGet, "/v1/refunds?"+query.Encode(), nil)
		if err != nil {
			return nil, err
		}
		var page struct {
			Data []struct {
				ID            string `json:"id"`
				Status        string `json:"status"`
				PaymentIntent string `json:"payment_intent"`
				Amount        int64  `json:"amount"`
			} `json:"data"`
			HasMore bool `json:"has_more"`
		}
		if json.Unmarshal(body, &page) != nil {
			return nil, errors.New("stripe: duplicate refund list is invalid")
		}
		if page.HasMore && len(page.Data) == 0 {
			return nil, errors.New("stripe: duplicate refund pagination made no progress")
		}
		for _, listed := range page.Data {
			if listed.ID == "" || seen[listed.ID] {
				return nil, errors.New("stripe: duplicate refund list identity is invalid")
			}
			seen[listed.ID] = true
			detailBody, err := c.request(ctx, http.MethodGet, "/v1/refunds/"+url.PathEscape(listed.ID), nil)
			if err != nil {
				return nil, err
			}
			var detail struct {
				ID            string `json:"id"`
				Status        string `json:"status"`
				PaymentIntent string `json:"payment_intent"`
				Amount        int64  `json:"amount"`
			}
			if json.Unmarshal(detailBody, &detail) != nil || detail.ID != listed.ID || detail.ID == "" || detail.Status != listed.Status || detail.PaymentIntent != payment.PaymentIntentID || detail.Amount != listed.Amount || detail.Amount <= 0 {
				return nil, errors.New("stripe: duplicate refund detail is invalid")
			}
			switch detail.Status {
			case "succeeded":
				if detail.Amount > payment.AmountRefunded-succeeded {
					return nil, errors.New("stripe: duplicate refund succeeded amount exceeds canonical total")
				}
				succeeded += detail.Amount
			case "pending", "requires_action", "failed", "canceled":
			default:
				return nil, errors.New("stripe: duplicate refund status is unsupported")
			}
			observations = append(observations, duplicateRefundObservation{detail.ID, payment.InvoicePaymentID, payment.PaymentIntentID, detail.Status, detail.Amount})
		}
		if !page.HasMore {
			break
		}
		last := page.Data[len(page.Data)-1].ID
		if last == query.Get("starting_after") {
			return nil, errors.New("stripe: duplicate refund pagination cursor did not advance")
		}
		query.Set("starting_after", last)
	}
	if succeeded != payment.AmountRefunded {
		return nil, errors.New("stripe: duplicate refund list does not equal canonical refunded amount")
	}
	sort.Slice(observations, func(i, j int) bool { return observations[i].RefundID < observations[j].RefundID })
	return observations, nil
}

func makeDuplicateRefundProof(observations []duplicateRefundObservation) (string, error) {
	observations = append([]duplicateRefundObservation(nil), observations...)
	sort.Slice(observations, func(i, j int) bool {
		if observations[i].RefundID != observations[j].RefundID {
			return observations[i].RefundID < observations[j].RefundID
		}
		return observations[i].InvoicePaymentID < observations[j].InvoicePaymentID
	})
	raw, err := json.Marshal(observations)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(raw)
	proof, err := json.Marshal(duplicateRefundProof{Digest: hex.EncodeToString(digest[:]), Refunds: observations})
	return string(proof), err
}

func decodeDuplicateRefundProof(raw string) (duplicateRefundProof, error) {
	var proof duplicateRefundProof
	if raw == "" || json.Unmarshal([]byte(raw), &proof) != nil || proof.Digest == "" || len(proof.Refunds) == 0 {
		return proof, errors.New("account: duplicate refund proof is invalid")
	}
	want, err := makeDuplicateRefundProof(proof.Refunds)
	if err != nil {
		return proof, err
	}
	var canonical duplicateRefundProof
	if json.Unmarshal([]byte(want), &canonical) != nil || canonical.Digest != proof.Digest {
		return proof, errors.New("account: duplicate refund proof digest does not match")
	}
	return canonical, nil
}

func recordDuplicateRefundFailuresTx(ctx context.Context, tx *sql.Tx, refundID string, failedAt int64) (bool, error) {
	rows, err := tx.QueryContext(ctx, `SELECT DISTINCT job_id FROM billing_duplicate_refund_constituents WHERE refund_id=? ORDER BY job_id`, refundID)
	if err != nil {
		return false, err
	}
	var jobs []string
	for rows.Next() {
		var jobID string
		if err := rows.Scan(&jobID); err != nil {
			rows.Close()
			return false, err
		}
		jobs = append(jobs, jobID)
	}
	if err := rows.Close(); err != nil {
		return false, err
	}
	rotated := false
	for _, jobID := range jobs {
		res, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO billing_duplicate_refund_failures(refund_id,job_id,failed_at) VALUES(?,?,?)`, refundID, jobID, failedAt)
		if err != nil {
			return false, err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			continue
		}
		var action duplicateRefundAction
		if err := tx.QueryRowContext(ctx, `SELECT id,job_id,generation,job_revision,actor,reason,state,snapshot_json,proof_json,last_error,revision FROM billing_duplicate_refund_actions WHERE job_id=? ORDER BY generation DESC LIMIT 1`, jobID).
			Scan(&action.ID, &action.JobID, &action.Generation, &action.JobRevision, &action.Actor, &action.Reason, &action.State, &action.SnapshotJSON, &action.ProofJSON, &action.LastError, &action.Revision); err != nil {
			return false, err
		}
		res, err = tx.ExecContext(ctx, `UPDATE billing_duplicate_refund_actions SET state='failed',last_error=?,revision=revision+1,updated_at=? WHERE id=? AND state IN ('prepared','blocked','succeeded')`, errDuplicateRefundProviderFailed.Error(), failedAt, action.ID)
		if err != nil {
			return false, err
		}
		if n, _ := res.RowsAffected(); n != 1 {
			return false, errors.New("account: duplicate refund failure lost action ownership")
		}
		nextGeneration := action.Generation + 1
		nextID := duplicateRefundActionID(jobID, nextGeneration)
		if _, err := tx.ExecContext(ctx, `UPDATE billing_duplicate_refunds SET state='manual',manual_reason='provider_refund_failed',refund_complete=0,last_error='provider refund failed',revision=revision+1,next_audit_at=0,updated_at=? WHERE id=?`, failedAt, jobID); err != nil {
			return false, err
		}
		var jobRevision int64
		if err := tx.QueryRowContext(ctx, `SELECT revision FROM billing_duplicate_refunds WHERE id=?`, jobID).Scan(&jobRevision); err != nil {
			return false, err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO billing_duplicate_refund_actions(id,job_id,generation,job_revision,actor,reason,state,snapshot_json,created_at,updated_at) VALUES(?,?,?,?,?,?,'prepared',?,?,?)`, nextID, jobID, nextGeneration, jobRevision, action.Actor, action.Reason, action.SnapshotJSON, failedAt, failedAt); err != nil {
			return false, err
		}
		rotated = true
	}
	return rotated, nil
}

func bindDuplicateRefundObservations(ctx context.Context, store *SQLiteStore, action duplicateRefundAction, job DuplicateRefundJob, observations []duplicateRefundObservation, eventAt int64) error {
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	reopened := false
	for _, observation := range observations {
		if observation.RefundID == "" || observation.InvoicePaymentID == "" || observation.PaymentIntentID == "" || observation.Amount <= 0 {
			return errors.New("account: duplicate refund observation identity is incomplete")
		}
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO billing_duplicate_refund_constituents(action_id,job_id,generation,invoice_payment_id,payment_intent_id,refund_id,amount,status,event_at) VALUES(?,?,?,?,?,?,?,?,?)`, action.ID, job.ID, action.Generation, observation.InvoicePaymentID, observation.PaymentIntentID, observation.RefundID, observation.Amount, observation.Status, eventAt); err != nil {
			return err
		}
		var gotJob, gotInvoicePayment, gotPI, gotStatus string
		var gotGeneration, gotAmount int64
		if err := tx.QueryRowContext(ctx, `SELECT job_id,generation,invoice_payment_id,payment_intent_id,amount,status FROM billing_duplicate_refund_constituents WHERE action_id=? AND generation=? AND refund_id=?`, action.ID, action.Generation, observation.RefundID).
			Scan(&gotJob, &gotGeneration, &gotInvoicePayment, &gotPI, &gotAmount, &gotStatus); err != nil {
			return err
		}
		if gotJob != job.ID || gotGeneration != action.Generation || gotInvoicePayment != observation.InvoicePaymentID || gotPI != observation.PaymentIntentID || gotAmount != observation.Amount {
			return errors.New("account: duplicate refund constituent ownership conflict")
		}
		status := observation.Status
		if status == "canceled" {
			status = "failed"
		}
		if gotStatus == "failed" {
			status = "failed"
		}
		if _, err := tx.ExecContext(ctx, `UPDATE billing_duplicate_refund_constituents SET status=?,event_at=MAX(event_at,?) WHERE action_id=? AND generation=? AND refund_id=?`, status, eventAt, action.ID, action.Generation, observation.RefundID); err != nil {
			return err
		}
		var inboxStatus string
		inboxErr := tx.QueryRowContext(ctx, `SELECT status FROM billing_deletion_refund_inbox WHERE refund_id=?`, observation.RefundID).Scan(&inboxStatus)
		if inboxErr != nil && !errors.Is(inboxErr, sql.ErrNoRows) {
			return inboxErr
		}
		if observation.Status == "failed" || observation.Status == "canceled" {
			if _, err := tx.ExecContext(ctx, `INSERT INTO billing_deletion_refund_inbox(refund_id,action_id,payment_intent_id,status,event_at) VALUES(?,?,?,'failed',?) ON CONFLICT(refund_id) DO UPDATE SET status='failed',event_at=MAX(event_at,excluded.event_at)`, observation.RefundID, "", observation.PaymentIntentID, eventAt); err != nil {
				return err
			}
			inboxStatus = "failed"
		}
		if inboxStatus == "failed" {
			rotated, err := recordDuplicateRefundFailuresTx(ctx, tx, observation.RefundID, eventAt)
			if err != nil {
				return err
			}
			reopened = reopened || rotated
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if reopened {
		return errDuplicateRefundReopened
	}
	return nil
}

func executeDuplicateRefundAction(ctx context.Context, store *SQLiteStore, client *stripeClient, job DuplicateRefundJob, action duplicateRefundAction) (string, error) {
	if len(job.Liabilities) == 0 {
		return "", errors.New("stripe: duplicate refund has no canonical invoice payment identity")
	}
	var allObservations []duplicateRefundObservation
	for _, liability := range job.Liabilities {
		expected := normalizeInvoicePayments(liability.Payments)
		if liability.InvoiceID == "" || len(expected) == 0 || liability.ManualReason != "" {
			return "", errors.New("stripe: duplicate refund constituent is shared or unsupported")
		}
		for _, payment := range expected {
			if payment.PaymentType != "payment_intent" || payment.PaymentIntentID == "" || payment.ChargeID == "" || payment.ChargeAmount != payment.AmountPaid {
				return "", errors.New("stripe: duplicate refund constituent is shared or unsupported")
			}
		}
		for _, expectedPayment := range expected {
			invoice, err := client.canonicalInvoicePayments(ctx, liability.InvoiceID, job.CustomerID, job.DuplicateSubscriptionID, true)
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
			observations, err := client.canonicalDuplicateRefundObservations(ctx, current)
			if err != nil {
				return "", err
			}
			if err := bindDuplicateRefundObservations(ctx, store, action, job, observations, time.Now().Unix()); err != nil {
				return "", err
			}
			allObservations = append(allObservations, observations...)
			for _, observation := range observations {
				if observation.Status == "pending" || observation.Status == "requires_action" {
					return "", errDuplicateRefundPending
				}
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
				ID            string `json:"id"`
				Status        string `json:"status"`
				PaymentIntent string `json:"payment_intent"`
				Amount        int64  `json:"amount"`
			}
			if json.Unmarshal(body, &created) != nil || created.ID == "" || created.PaymentIntent != current.PaymentIntentID || created.Amount != remaining {
				return "", errors.New("stripe: duplicate refund response is invalid")
			}
			createdObservation := duplicateRefundObservation{created.ID, current.InvoicePaymentID, current.PaymentIntentID, created.Status, created.Amount}
			if err := bindDuplicateRefundObservations(ctx, store, action, job, []duplicateRefundObservation{createdObservation}, time.Now().Unix()); err != nil {
				return "", err
			}
			if created.Status == "pending" || created.Status == "requires_action" {
				return "", errDuplicateRefundPending
			}
			if created.Status == "failed" || created.Status == "canceled" {
				return "", errDuplicateRefundReopened
			}
			if created.Status != "succeeded" {
				return "", errors.New("stripe: duplicate refund response status is unsupported")
			}
			verified, err := client.canonicalInvoicePayments(ctx, liability.InvoiceID, job.CustomerID, job.DuplicateSubscriptionID, true)
			if err != nil {
				return "", err
			}
			got, ok := findCanonicalInvoicePayment(verified, current.InvoicePaymentID)
			if !ok || !duplicatePaymentIdentitiesEqual(verified.Payments, expected) || got.AmountRefunded != got.AmountPaid {
				return "", errors.New("stripe: duplicate refund constituent is not canonically complete")
			}
			observations, err = client.canonicalDuplicateRefundObservations(ctx, got)
			if err != nil {
				return "", err
			}
			if err := bindDuplicateRefundObservations(ctx, store, action, job, observations, time.Now().Unix()); err != nil {
				return "", err
			}
			allObservations = append(allObservations, observations...)
		}
		invoice, err := client.canonicalInvoicePayments(ctx, liability.InvoiceID, job.CustomerID, job.DuplicateSubscriptionID, true)
		if err != nil {
			return "", err
		}
		if !duplicatePaymentIdentitiesEqual(invoice.Payments, expected) {
			return "", errors.New("stripe: duplicate refund final identity changed")
		}
		for _, payment := range normalizeInvoicePayments(invoice.Payments) {
			if payment.AmountRefunded != payment.AmountPaid {
				return "", errors.New("stripe: duplicate refund final proof is incomplete")
			}
			observations, err := client.canonicalDuplicateRefundObservations(ctx, payment)
			if err != nil {
				return "", err
			}
			if err := bindDuplicateRefundObservations(ctx, store, action, job, observations, time.Now().Unix()); err != nil {
				return "", err
			}
			for _, observation := range observations {
				if observation.Status == "pending" || observation.Status == "requires_action" {
					return "", errDuplicateRefundPending
				}
			}
			allObservations = append(allObservations, observations...)
		}
	}
	deduped := make(map[string]duplicateRefundObservation)
	for _, observation := range allObservations {
		key := observation.InvoicePaymentID + "\x00" + observation.RefundID
		if previous, ok := deduped[key]; ok && previous != observation {
			return "", errors.New("stripe: duplicate refund proof identity changed")
		}
		deduped[key] = observation
	}
	allObservations = allObservations[:0]
	for _, observation := range deduped {
		allObservations = append(allObservations, observation)
	}
	return makeDuplicateRefundProof(allObservations)
}

func finishDuplicateRefundAction(ctx context.Context, store *SQLiteStore, job DuplicateRefundJob, action duplicateRefundAction, proof string, now int64) error {
	decoded, err := decodeDuplicateRefundProof(proof)
	if err != nil {
		return err
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
	var failedRefund string
	err = tx.QueryRowContext(ctx, `SELECT c.refund_id FROM billing_duplicate_refund_constituents c JOIN billing_deletion_refund_inbox i ON i.refund_id=c.refund_id AND i.status='failed' WHERE c.action_id=? AND c.generation=? LIMIT 1`, action.ID, action.Generation).Scan(&failedRefund)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if failedRefund != "" {
		rotated, err := recordDuplicateRefundFailuresTx(ctx, tx, failedRefund, now)
		if err != nil {
			return err
		}
		if rotated {
			if err := tx.Commit(); err != nil {
				return err
			}
			return errDuplicateRefundReopened
		}
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
	if jobRevision != action.JobRevision {
		return errors.New("account: duplicate refund action liability snapshot is stale")
	}
	rows, err := tx.QueryContext(ctx, `SELECT refund_id,invoice_payment_id,payment_intent_id,status,amount FROM billing_duplicate_refund_constituents WHERE action_id=? AND generation=? ORDER BY refund_id,invoice_payment_id`, action.ID, action.Generation)
	if err != nil {
		return err
	}
	var stored []duplicateRefundObservation
	for rows.Next() {
		var observation duplicateRefundObservation
		if err := rows.Scan(&observation.RefundID, &observation.InvoicePaymentID, &observation.PaymentIntentID, &observation.Status, &observation.Amount); err != nil {
			rows.Close()
			return err
		}
		stored = append(stored, observation)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	storedProof, err := makeDuplicateRefundProof(stored)
	if err != nil {
		return err
	}
	var canonicalStored duplicateRefundProof
	if json.Unmarshal([]byte(storedProof), &canonicalStored) != nil || canonicalStored.Digest != decoded.Digest {
		return errors.New("account: duplicate refund durable proof does not match provider proof")
	}
	res, err := tx.ExecContext(ctx, `UPDATE billing_duplicate_refund_actions SET state='succeeded',proof_json=?,last_error='',revision=revision+1,updated_at=? WHERE id=? AND state='prepared' AND revision=?`, proof, now, action.ID, actionRevision)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return errors.New("account: stale duplicate refund action")
	}
	res, err = tx.ExecContext(ctx, `UPDATE billing_duplicate_refunds SET state='terminal',manual_reason='',refund_complete=1,last_error='',revision=revision+1,next_audit_at=?,updated_at=? WHERE id=? AND state='manual' AND revision=?`, now+6*60*60, now, job.ID, action.JobRevision)
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
	proof, err := executeDuplicateRefundAction(ctx, store, client, job, action)
	if err != nil {
		if errors.Is(err, errDuplicateRefundReopened) {
			return DuplicateRefundOperatorResult{ActionID: action.ID, State: "failed"}, err
		}
		blocked := len(job.Liabilities) == 0 || errors.Is(err, errDuplicateRefundProviderFailed) || strings.Contains(err.Error(), "shared or unsupported") || strings.Contains(err.Error(), "identity drifted")
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
	if len(plan.Liabilities) == 0 && plan.InvoiceID != "" {
		plan.Liabilities = []DuplicateRefundLiability{{InvoiceID: plan.InvoiceID, Payments: plan.Payments, ManualReason: plan.ManualReason}}
	}
	for i := range plan.Liabilities {
		plan.Liabilities[i].Payments = normalizeInvoicePayments(plan.Liabilities[i].Payments)
		for j := range plan.Liabilities[i].Payments {
			plan.Liabilities[i].Payments[j].AmountRefunded = 0
		}
	}
	plan.Payments = normalizeInvoicePayments(plan.Payments)
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
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO billing_duplicate_refunds(id,user_id,customer_id,canonical_subscription_id,duplicate_subscription_id,state,manual_reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`, id, plan.UserID, plan.CustomerID, plan.CanonicalSubscriptionID, plan.DuplicateSubscriptionID, state, plan.ManualReason, now, now); err != nil {
		return DuplicateRefundJob{}, err
	}
	insertedLiability := false
	for _, liability := range plan.Liabilities {
		res, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO billing_duplicate_refund_invoices(job_id,invoice_id,status,amount_paid,manual_reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`, id, liability.InvoiceID, liability.Status, liability.AmountPaid, liability.ManualReason, now, now)
		if err != nil {
			return DuplicateRefundJob{}, err
		}
		if n, _ := res.RowsAffected(); n == 1 {
			insertedLiability = true
		}
		var gotStatus, gotReason string
		var gotAmountPaid int64
		if err := tx.QueryRowContext(ctx, `SELECT status,amount_paid,manual_reason FROM billing_duplicate_refund_invoices WHERE job_id=? AND invoice_id=?`, id, liability.InvoiceID).Scan(&gotStatus, &gotAmountPaid, &gotReason); err != nil {
			return DuplicateRefundJob{}, err
		}
		if liability.AmountPaid < gotAmountPaid {
			return DuplicateRefundJob{}, errors.New("account: duplicate refund invoice amount regressed")
		}
		if liability.Status != gotStatus || liability.AmountPaid != gotAmountPaid || liability.ManualReason != gotReason {
			if _, err := tx.ExecContext(ctx, `UPDATE billing_duplicate_refund_invoices SET status=?,amount_paid=?,manual_reason=?,updated_at=? WHERE job_id=? AND invoice_id=?`, liability.Status, liability.AmountPaid, liability.ManualReason, now, id, liability.InvoiceID); err != nil {
				return DuplicateRefundJob{}, err
			}
			insertedLiability = true
		}
		for _, payment := range liability.Payments {
			res, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO billing_duplicate_refund_liabilities(job_id,invoice_id,invoice_payment_id,payment_type,payment_intent_id,payment_record_id,charge_id,amount_paid,charge_amount,paid_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, id, liability.InvoiceID, payment.InvoicePaymentID, payment.PaymentType, payment.PaymentIntentID, payment.PaymentRecordID, payment.ChargeID, payment.AmountPaid, payment.ChargeAmount, payment.PaidAt, now)
			if err != nil {
				return DuplicateRefundJob{}, err
			}
			if n, _ := res.RowsAffected(); n == 1 {
				insertedLiability = true
			}
			var got CanonicalStripeInvoicePayment
			if err := tx.QueryRowContext(ctx, `SELECT invoice_payment_id,payment_type,payment_intent_id,payment_record_id,charge_id,amount_paid,charge_amount,paid_at FROM billing_duplicate_refund_liabilities WHERE job_id=? AND invoice_id=? AND invoice_payment_id=?`, id, liability.InvoiceID, payment.InvoicePaymentID).
				Scan(&got.InvoicePaymentID, &got.PaymentType, &got.PaymentIntentID, &got.PaymentRecordID, &got.ChargeID, &got.AmountPaid, &got.ChargeAmount, &got.PaidAt); err != nil || got != payment {
				return DuplicateRefundJob{}, errors.New("account: duplicate refund payment liability identity conflict")
			}
		}
	}
	if insertedLiability {
		manual := plan.ManualReason
		if manual == "" {
			manual = "new_invoice_liability"
		}
		if _, err := tx.ExecContext(ctx, `UPDATE billing_duplicate_refunds SET state=CASE WHEN subscription_canceled=1 THEN 'manual' ELSE 'pending' END,manual_reason=CASE WHEN subscription_canceled=1 THEN ? ELSE manual_reason END,refund_complete=0,revision=revision+1,next_audit_at=0,updated_at=? WHERE id=?`, manual, now, id); err != nil {
			return DuplicateRefundJob{}, err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE billing_duplicate_refund_actions SET state='failed',last_error='liability set expanded',revision=revision+1,updated_at=? WHERE job_id=? AND state='prepared'`, now, id); err != nil {
			return DuplicateRefundJob{}, err
		}
	} else if plan.ManualReason != "" {
		if _, err := tx.ExecContext(ctx, `UPDATE billing_duplicate_refunds SET state=CASE WHEN state='terminal' THEN state ELSE 'manual' END,manual_reason=CASE WHEN state='terminal' THEN manual_reason ELSE ? END,updated_at=? WHERE id=?`, plan.ManualReason, now, id); err != nil {
			return DuplicateRefundJob{}, err
		}
	} else {
		// A due terminal audit that found no new liability moves to the back of
		// the bounded scan. This preserves perpetual late-payment detection without
		// letting the oldest 100 clean tombstones starve newer responsibilities.
		if _, err := tx.ExecContext(ctx, `UPDATE billing_duplicate_refunds SET next_audit_at=? WHERE id=? AND state='terminal'`, now+6*60*60, id); err != nil {
			return DuplicateRefundJob{}, err
		}
	}
	var got DuplicateRefundJob
	var gotRaw string
	var canceled, refunded int
	if err := tx.QueryRowContext(ctx, `SELECT id,user_id,customer_id,canonical_subscription_id,duplicate_subscription_id,invoice_id,constituents_json,state,manual_reason,subscription_canceled,refund_complete,attempts,revision,last_error,created_at,updated_at FROM billing_duplicate_refunds WHERE duplicate_subscription_id=?`, plan.DuplicateSubscriptionID).
		Scan(&got.ID, &got.UserID, &got.CustomerID, &got.CanonicalSubscriptionID, &got.DuplicateSubscriptionID, &got.InvoiceID, &gotRaw, &got.State, &got.ManualReason, &canceled, &refunded, &got.Attempts, &got.Revision, &got.LastError, &got.CreatedAt, &got.UpdatedAt); err != nil {
		return DuplicateRefundJob{}, err
	}
	if got.UserID != plan.UserID || got.CustomerID != plan.CustomerID || got.CanonicalSubscriptionID != plan.CanonicalSubscriptionID {
		return DuplicateRefundJob{}, errors.New("account: duplicate refund responsibility conflicts with existing row")
	}
	got.Payments, got.SubscriptionCanceled, got.RefundComplete = plan.Payments, canceled != 0, refunded != 0
	if err := tx.Commit(); err != nil {
		return DuplicateRefundJob{}, err
	}
	loaded, ok, err := s.DuplicateRefundBySubscription(ctx, plan.DuplicateSubscriptionID)
	if err != nil {
		return DuplicateRefundJob{}, err
	}
	if !ok {
		return DuplicateRefundJob{}, errors.New("account: duplicate refund responsibility disappeared")
	}
	return loaded, nil
}

// AppendCanonicalDuplicatePaidInvoice records a verified late payment against an
// existing duplicate-subscription responsibility without consulting the users
// table. That keeps the operator liability alive after account purge and before
// entitlement/provider authority checks in the webhook handler.
func (s *SQLiteStore) AppendCanonicalDuplicatePaidInvoice(ctx context.Context, invoice CanonicalStripePaidInvoice, now int64) error {
	if invoice.InvoiceID == "" || invoice.CustomerID == "" || invoice.SubscriptionID == "" || invoice.AmountPaid <= 0 {
		return errors.New("account: canonical duplicate paid invoice identity is incomplete")
	}
	job, ok, err := s.DuplicateRefundBySubscription(ctx, invoice.SubscriptionID)
	if err != nil || !ok {
		return err
	}
	if job.CustomerID != invoice.CustomerID {
		return errors.New("account: canonical duplicate paid invoice customer changed")
	}
	_, err = s.PutDuplicateRefund(ctx, DuplicateRefundPlan{
		UserID: job.UserID, CustomerID: job.CustomerID, CanonicalSubscriptionID: job.CanonicalSubscriptionID, DuplicateSubscriptionID: job.DuplicateSubscriptionID,
		Liabilities: []DuplicateRefundLiability{{InvoiceID: invoice.InvoiceID, Status: "paid", AmountPaid: invoice.AmountPaid, Payments: invoice.Payments, ManualReason: duplicateRefundManualReason(invoice)}},
	}, now)
	return err
}

func (s *SQLiteStore) HasDuplicateRefundSubscription(ctx context.Context, subscriptionID string) (bool, error) {
	if subscriptionID == "" {
		return false, nil
	}
	var present int
	err := s.reader().QueryRowContext(ctx, `SELECT 1 FROM billing_duplicate_refunds WHERE duplicate_subscription_id=?`, subscriptionID).Scan(&present)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (s *SQLiteStore) SaveDuplicateRefund(ctx context.Context, job DuplicateRefundJob, result DuplicateRefundResult, providerErr error, now int64) error {
	state, manual, lastError := "pending", result.ManualReason, ""
	if manual != "" {
		state = "manual"
	}
	if result.SubscriptionCanceled && result.RefundComplete && manual == "" {
		state = "terminal"
	} else if result.SubscriptionCanceled {
		state = "manual"
		if manual == "" {
			manual = "refund_operator_required"
		}
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
	rows, err := s.reader().QueryContext(ctx, `SELECT duplicate_subscription_id FROM billing_duplicate_refunds WHERE state<>'terminal' OR next_audit_at<=? ORDER BY CASE WHEN state='terminal' THEN 1 ELSE 0 END,next_audit_at,updated_at,id LIMIT ?`, time.Now().Unix(), limit)
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
	plan, err := provider.InspectDuplicateSubscription(ctx, job.UserID, job.CustomerID, job.CanonicalSubscriptionID, job.DuplicateSubscriptionID)
	if err != nil {
		return err
	}
	job, err = store.PutDuplicateRefund(ctx, plan, s.Now().Unix())
	if err != nil {
		return err
	}
	result, providerErr := provider.ReconcileDuplicateSubscription(ctx, job)
	if err := store.SaveDuplicateRefund(ctx, job, result, providerErr, s.Now().Unix()); err != nil {
		return err
	}
	if providerErr != nil {
		return providerErr
	}
	plan, err = provider.InspectDuplicateSubscription(ctx, job.UserID, job.CustomerID, job.CanonicalSubscriptionID, job.DuplicateSubscriptionID)
	if err != nil {
		return err
	}
	job, err = store.PutDuplicateRefund(ctx, plan, s.Now().Unix())
	if err != nil {
		return err
	}
	// Refunds are an operator-only action. The background worker's authority is
	// deliberately limited to discovering durable liabilities and stopping the
	// duplicate subscription from creating another charge. A paid liability stays
	// manual until ResolveDuplicateRefund is explicitly invoked with an actor and
	// reason and its provider proof is durably committed.
	return nil
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
	if len(invoice.Payments) == 0 {
		return "unsupported_invoice_payments"
	}
	for _, payment := range invoice.Payments {
		if payment.PaymentType != "payment_intent" || payment.PaymentIntentID == "" || payment.ChargeID == "" || payment.ChargeAmount != payment.AmountPaid {
			return "shared_or_unsupported_invoice_payment"
		}
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
