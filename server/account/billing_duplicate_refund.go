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
	ID                                   string
	State, LastError                     string
	SubscriptionCanceled, RefundComplete bool
	// Attempts counts CONSECUTIVE failures: RecordDuplicateRefundError adds
	// one, and any successful outcome (Save, or a clean terminal audit) resets it
	// to 0. The repeated_failures alert reads it.
	Attempts, Revision, LiabilityRevision, CreatedAt, UpdatedAt int64
	// DiscoveredAt is 0 while the liability set is UNKNOWN: only a Put that
	// follows one complete inspection of the duplicate may set it. A job can
	// become terminal or refund_complete, and an operator refund can start, only
	// once it is non-zero.
	DiscoveredAt int64
	// CancelHold, when non-empty, forbids automatic cancellation. Put and Save
	// never clear it; only the documented operator procedure does.
	CancelHold   string
	HoldEvidence string
	NextAuditAt  int64
	// PostCancelInspected is set only by a complete inspection that STARTED
	// after the cancellation was durably recorded (the caller's pre-inspection
	// read of the row already showed subscription_canceled=1). A canceled job
	// can become terminal or refund_complete only once it is set.
	PostCancelInspected bool
	// CancelContradictions counts runs whose provider read found the duplicate
	// live while the row already recorded it canceled. CancelReconfirmed is the
	// count at the last FRESH provider confirmation of cancellation. While
	// CancelContradictions > CancelReconfirmed the stored cancellation proves
	// nothing: no inspection can count as post-cancel and the job cannot finish.
	//
	// Contradictions are counted in COMMIT order, not observation order: a
	// delayed write can invalidate newer evidence, which only costs one more
	// fresh confirmation and inspection. A terminal row with CC>CR keeps its
	// state, liabilities and refund/action proofs, but post_cancel_inspected is
	// cleared, so Resolve and any refund POST are refused. It is not stuck: the
	// next audit that freshly confirms the cancellation closes
	// the contradiction (ReconfirmDuplicateCancellation, fenced on the count read
	// before the provider call), re-inspects, and only then restores the
	// post-cancel evidence. CC>CR therefore persists only while Stripe keeps
	// reporting the duplicate live, the confirmation keeps failing, or newer
	// contradictions keep arriving -- and it stays visible as the
	// cancel_contradiction alert reason, never cleared as a clean audit.
	CancelContradictions, CancelReconfirmed int64
}

type DuplicateRefundResult struct {
	SubscriptionCanceled, RefundComplete bool
	ManualReason                         string
	// HoldReason is set when cancellation authority was refused (no DELETE).
	HoldReason string
	// CancelSkipped is set when automatic cancellation is disabled by
	// configuration (no DELETE, no hold).
	CancelSkipped bool
	// ObservedLive is set when this call's first read of the duplicate found it
	// NOT canceled. With a stored cancellation that is a contradiction.
	ObservedLive bool
}

// duplicateInspectionStart is what a read of the job row, made BEFORE an
// inspection began, said about the cancellation. Canceled is the durable flag;
// Contradictions is the count of recorded "stored canceled, Stripe live"
// observations, which fences the claim against a contradiction recorded after
// the read.
type duplicateInspectionStart struct {
	Canceled       bool
	Contradictions int64
}

// inspectionStartFrom derives the claim from a pre-inspection read. A
// cancellation with an open (unreconfirmed) contradiction proves nothing.
func inspectionStartFrom(job DuplicateRefundJob) duplicateInspectionStart {
	return duplicateInspectionStart{Canceled: job.SubscriptionCanceled && job.CancelContradictions == job.CancelReconfirmed, Contradictions: job.CancelContradictions}
}

type DuplicateRefundEvidence struct {
	JobID, DuplicateSubscriptionID, CanonicalSubscriptionID, InvoiceID string
	State, ManualReason, Resolution                                    string
	LiabilityDigest                                                    string
	SubscriptionCanceled, RefundComplete                               bool
	HasError                                                           bool
	Attempts, Revision, LiabilityRevision                              int64
	Payments                                                           []CanonicalStripeInvoicePayment
	Liabilities                                                        []DuplicateRefundLiability
	ActionID, ActionState                                              string
	ActionGeneration                                                   int64
	// LiabilitiesUnknown is true while no complete inspection has been recorded
	// (DiscoveredAt == 0): an empty Liabilities list then means "unknown", never
	// "nothing is owed".
	LiabilitiesUnknown  bool
	DiscoveredAt        int64
	PostCancelInspected bool
	CancelHold          string
	HoldEvidence        string
	// CancelContradictions > CancelReconfirmed: Stripe reported the duplicate
	// live after it was recorded canceled, and no fresh confirmation followed.
	CancelContradictions, CancelReconfirmed int64
}

type DuplicateRefundOperatorResult struct {
	ActionID string
	State    string
}

type duplicateRefundAction struct {
	ID, JobID, Actor, Reason, State, SnapshotJSON, ProofJSON, LastError string
	Generation, LiabilityRevision, Revision                             int64
}

type duplicateRefundLiabilityQueryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

var errDuplicateRefundProviderFailed = errors.New("stripe: duplicate refund provider reported a terminal failed refund")

// The charge's AmountRefunded and the refund list are two separate provider
// reads; a legitimate concurrent refund landing between them makes them
// disagree without any money being wrong. That disagreement is a retryable
// read conflict -- the operator relists evidence and the next command reads a
// consistent pair -- and must stay distinguishable from a real over-refund,
// which is measured against the immutable AmountPaid, never the snapshot.
var errDuplicateRefundCanonicalSnapshotStale = errors.New("stripe: duplicate refund canonical charge snapshot is stale; list evidence again")
var errDuplicateRefundPending = errors.New("stripe: duplicate refund remains pending")
var errDuplicateRefundReopened = errors.New("account: duplicate refund failure reopened operator reconciliation")

// errDuplicateAutoCancelDisabled is returned by the cancellation authorizer when
// -billing-duplicate-auto-cancel is off. The provider skips the DELETE without
// treating it as a failure; inspection continues.
var errDuplicateAutoCancelDisabled = errors.New("billing: duplicate auto-cancel is disabled")

// Cancellation hold reason codes (billing_duplicate_refunds.cancel_hold).
const (
	duplicateHoldCanonicalPastDue  = "canonical_past_due"
	duplicateHoldCanonicalNotLive  = "canonical_not_live"
	duplicateHoldCanonicalReplaced = "canonical_replaced"
	duplicateHoldCustomerChanged   = "customer_changed"
	duplicateHoldAdminComp         = "admin_comp"
	duplicateHoldAccountMissing    = "account_missing"
	duplicateHoldAccountDeleting   = "account_deleting"
	// canonical_conflict: an existing responsibility for this duplicate names a
	// different canonical than the one a later reconciliation selected.
	duplicateHoldCanonicalConflict = "canonical_conflict"
)

// duplicateResponsibilityAlert is the fixed log prefix operators alert on.
const duplicateResponsibilityAlert = "billing: duplicate responsibility needs attention"

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
	ReconcileDuplicateSubscription(context.Context, DuplicateRefundJob, func(context.Context) (string, error)) (DuplicateRefundResult, error)
	DuplicateCanonicalSubscription(context.Context, string) (SubscriptionInfo, bool, error)
}

type duplicateRefundStore interface {
	DuplicateRefundBySubscription(context.Context, string) (DuplicateRefundJob, bool, error)
	PutDuplicateRefund(context.Context, DuplicateRefundPlan, bool, int64) (DuplicateRefundJob, error)
	PutDuplicateRefundInspection(context.Context, DuplicateRefundPlan, duplicateInspectionStart, int64) (DuplicateRefundJob, error)
	RecordDuplicateCancelContradiction(context.Context, DuplicateRefundJob, error, int64) error
	ReconfirmDuplicateCancellation(context.Context, DuplicateRefundJob, int64) error
	SaveDuplicateRefund(context.Context, DuplicateRefundJob, DuplicateRefundResult, error, int64) error
	SaveDuplicateRefundBeforeReinspection(context.Context, DuplicateRefundJob, DuplicateRefundResult, int64) error
	RecordDuplicateRefundError(context.Context, DuplicateRefundJob, error, int64) error
	ListDuplicateRefunds(context.Context, int, int64) ([]DuplicateRefundJob, error)
	DuplicateCancelAuthority(context.Context, string) (duplicateCancelAuthority, error)
	HoldDuplicateRefundCancellation(context.Context, string, duplicateHoldEvidence) (string, error)
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

func duplicateRefundLiabilitySnapshot(liabilities []DuplicateRefundLiability) ([]byte, string, error) {
	canonical := append([]DuplicateRefundLiability(nil), liabilities...)
	for i := range canonical {
		canonical[i].Payments = normalizeInvoicePayments(canonical[i].Payments)
	}
	sort.Slice(canonical, func(i, j int) bool { return canonical[i].InvoiceID < canonical[j].InvoiceID })
	raw, err := json.Marshal(canonical)
	if err != nil {
		return nil, "", err
	}
	digest := sha256.Sum256(raw)
	return raw, hex.EncodeToString(digest[:]), nil
}

func loadDuplicateRefundLiabilities(ctx context.Context, q duplicateRefundLiabilityQueryer, jobID string) ([]DuplicateRefundLiability, error) {
	rows, err := q.QueryContext(ctx, `SELECT i.invoice_id,i.status,i.amount_paid,i.manual_reason,l.invoice_payment_id,l.payment_type,l.payment_intent_id,l.payment_record_id,l.charge_id,l.amount_paid,l.charge_amount,l.paid_at
 FROM billing_duplicate_refund_invoices i LEFT JOIN billing_duplicate_refund_liabilities l ON l.job_id=i.job_id AND l.invoice_id=i.invoice_id
 WHERE i.job_id=? ORDER BY i.invoice_id,l.invoice_payment_id`, jobID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var liabilities []DuplicateRefundLiability
	var current *DuplicateRefundLiability
	for rows.Next() {
		var invoiceID, status, manualReason string
		var invoiceAmountPaid int64
		var invoicePaymentID, paymentType, paymentIntentID, paymentRecordID, chargeID sql.NullString
		var amountPaid, chargeAmount, paidAt sql.NullInt64
		if err := rows.Scan(&invoiceID, &status, &invoiceAmountPaid, &manualReason, &invoicePaymentID, &paymentType, &paymentIntentID, &paymentRecordID, &chargeID, &amountPaid, &chargeAmount, &paidAt); err != nil {
			return nil, err
		}
		if current == nil || current.InvoiceID != invoiceID {
			liabilities = append(liabilities, DuplicateRefundLiability{InvoiceID: invoiceID, Status: status, AmountPaid: invoiceAmountPaid, ManualReason: manualReason})
			current = &liabilities[len(liabilities)-1]
		}
		if invoicePaymentID.Valid {
			current.Payments = append(current.Payments, CanonicalStripeInvoicePayment{InvoicePaymentID: invoicePaymentID.String, PaymentType: paymentType.String, PaymentIntentID: paymentIntentID.String, PaymentRecordID: paymentRecordID.String, ChargeID: chargeID.String, AmountPaid: amountPaid.Int64, ChargeAmount: chargeAmount.Int64, PaidAt: paidAt.Int64})
		}
	}
	return liabilities, rows.Err()
}

func (s *SQLiteStore) DuplicateRefundBySubscription(ctx context.Context, subscriptionID string) (DuplicateRefundJob, bool, error) {
	var row DuplicateRefundJob
	var raw string
	var canceled, refunded, postCancel int
	err := s.reader().QueryRowContext(ctx, `SELECT id,user_id,customer_id,canonical_subscription_id,duplicate_subscription_id,invoice_id,constituents_json,state,manual_reason,subscription_canceled,refund_complete,attempts,revision,liability_revision,last_error,created_at,updated_at,discovered_at,cancel_hold,hold_evidence,next_audit_at,post_cancel_inspected,cancel_contradictions,cancel_reconfirmed FROM billing_duplicate_refunds WHERE duplicate_subscription_id=?`, subscriptionID).
		Scan(&row.ID, &row.UserID, &row.CustomerID, &row.CanonicalSubscriptionID, &row.DuplicateSubscriptionID, &row.InvoiceID, &raw, &row.State, &row.ManualReason, &canceled, &refunded, &row.Attempts, &row.Revision, &row.LiabilityRevision, &row.LastError, &row.CreatedAt, &row.UpdatedAt, &row.DiscoveredAt, &row.CancelHold, &row.HoldEvidence, &row.NextAuditAt, &postCancel, &row.CancelContradictions, &row.CancelReconfirmed)
	if errors.Is(err, sql.ErrNoRows) {
		return DuplicateRefundJob{}, false, nil
	}
	if err != nil {
		return DuplicateRefundJob{}, false, err
	}
	if err := json.Unmarshal([]byte(raw), &row.Payments); err != nil {
		return DuplicateRefundJob{}, false, fmt.Errorf("account: decode duplicate refund constituents: %w", err)
	}
	row.SubscriptionCanceled, row.RefundComplete, row.PostCancelInspected = canceled != 0, refunded != 0, postCancel != 0
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
	if err := liabilityRows.Err(); err != nil {
		liabilityRows.Close()
		return DuplicateRefundJob{}, false, err
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
	out.Attempts, out.Revision, out.LiabilityRevision, out.Liabilities = job.Attempts, job.Revision, job.LiabilityRevision, job.Liabilities
	out.DiscoveredAt, out.LiabilitiesUnknown = job.DiscoveredAt, job.DiscoveredAt == 0
	out.CancelHold, out.HoldEvidence, out.PostCancelInspected = job.CancelHold, job.HoldEvidence, job.PostCancelInspected
	out.CancelContradictions, out.CancelReconfirmed = job.CancelContradictions, job.CancelReconfirmed
	for _, liability := range job.Liabilities {
		out.Payments = append(out.Payments, liability.Payments...)
	}
	out.Payments = normalizeInvoicePayments(out.Payments)
	_, out.LiabilityDigest, err = duplicateRefundLiabilitySnapshot(job.Liabilities)
	if err != nil {
		return DuplicateRefundEvidence{}, err
	}
	err = store.reader().QueryRowContext(ctx, `SELECT id,state,generation FROM billing_duplicate_refund_actions WHERE job_id=? ORDER BY generation DESC LIMIT 1`, job.ID).
		Scan(&out.ActionID, &out.ActionState, &out.ActionGeneration)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return DuplicateRefundEvidence{}, err
	}
	switch {
	case job.DiscoveredAt == 0:
		out.Resolution = "liabilities_unknown"
	case job.State == "terminal" && job.ManualReason == "no_refund_needed":
		out.Resolution = "no_refund_needed"
	case job.State == "terminal" && out.ActionState == "succeeded":
		out.Resolution = "operator_refund_completed"
	default:
		out.Resolution = "action_required"
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
	expectedSnapshot, expectedDigest, err := duplicateRefundLiabilitySnapshot(job.Liabilities)
	if err != nil {
		return duplicateRefundAction{}, err
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return duplicateRefundAction{}, err
	}
	defer tx.Rollback()
	// Acquire SQLite's sole writer before reading the authority snapshot. A
	// concurrent Put must complete before this point or wait until the action row
	// is committed; it cannot slip between the checked snapshot and INSERT.
	if _, err := tx.ExecContext(ctx, `UPDATE billing_duplicate_refunds SET liability_revision=liability_revision WHERE id=?`, job.ID); err != nil {
		return duplicateRefundAction{}, err
	}
	var liveLiabilityRevision int64
	if err := tx.QueryRowContext(ctx, `SELECT liability_revision FROM billing_duplicate_refunds WHERE id=?`, job.ID).Scan(&liveLiabilityRevision); err != nil {
		return duplicateRefundAction{}, err
	}
	live, err := loadDuplicateRefundLiabilities(ctx, tx, job.ID)
	if err != nil {
		return duplicateRefundAction{}, err
	}
	liveSnapshot, liveDigest, err := duplicateRefundLiabilitySnapshot(live)
	if err != nil {
		return duplicateRefundAction{}, err
	}
	if liveLiabilityRevision != job.LiabilityRevision || liveDigest != expectedDigest || string(liveSnapshot) != string(expectedSnapshot) {
		return duplicateRefundAction{}, errors.New("account: duplicate refund evidence changed before action creation; list evidence again")
	}
	var previous duplicateRefundAction
	err = tx.QueryRowContext(ctx, `SELECT id,job_id,generation,liability_revision,actor,reason,state,snapshot_json,proof_json,last_error,revision FROM billing_duplicate_refund_actions WHERE job_id=? ORDER BY generation DESC LIMIT 1`, job.ID).
		Scan(&previous.ID, &previous.JobID, &previous.Generation, &previous.LiabilityRevision, &previous.Actor, &previous.Reason, &previous.State, &previous.SnapshotJSON, &previous.ProofJSON, &previous.LastError, &previous.Revision)
	generation := int64(1)
	if err == nil {
		snapshotChanged := previous.SnapshotJSON != string(liveSnapshot)
		liabilityGenerationChanged := snapshotChanged && liveLiabilityRevision > previous.LiabilityRevision && (previous.State == "succeeded" || previous.State == "failed")
		automaticFailureRecovery := previous.State == "prepared" && previous.LastError == errDuplicateRefundProviderFailed.Error()
		if !liabilityGenerationChanged && !automaticFailureRecovery && (previous.Actor != actor || previous.Reason != reason) {
			return duplicateRefundAction{}, errors.New("account: duplicate refund action ownership conflict")
		}
		if snapshotChanged {
			if previous.State != "succeeded" && previous.State != "failed" {
				return duplicateRefundAction{}, errors.New("account: duplicate refund liability changed during an active action")
			}
			generation = previous.Generation + 1
		} else if automaticFailureRecovery {
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
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO billing_duplicate_refund_actions(id,job_id,generation,liability_revision,actor,reason,state,snapshot_json,created_at,updated_at) VALUES(?,?,?,?,?,?,'prepared',?,?,?)`, id, job.ID, generation, liveLiabilityRevision, actor, reason, string(liveSnapshot), now, now); err != nil {
		return duplicateRefundAction{}, err
	}
	var action duplicateRefundAction
	if err := tx.QueryRowContext(ctx, `SELECT id,job_id,generation,liability_revision,actor,reason,state,snapshot_json,proof_json,last_error,revision FROM billing_duplicate_refund_actions WHERE job_id=? AND generation=?`, job.ID, generation).
		Scan(&action.ID, &action.JobID, &action.Generation, &action.LiabilityRevision, &action.Actor, &action.Reason, &action.State, &action.SnapshotJSON, &action.ProofJSON, &action.LastError, &action.Revision); err != nil {
		return duplicateRefundAction{}, err
	}
	if action.ID != id || action.Actor != actor || action.Reason != reason || action.SnapshotJSON != string(liveSnapshot) || action.LiabilityRevision != liveLiabilityRevision {
		return duplicateRefundAction{}, errors.New("account: duplicate refund action ownership conflict")
	}
	if err := tx.Commit(); err != nil {
		return duplicateRefundAction{}, err
	}
	return action, nil
}

func beginDuplicateRefundProviderMutation(ctx context.Context, store *SQLiteStore, action duplicateRefundAction) (*sql.Tx, error) {
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*sql.Tx, error) {
		tx.Rollback()
		return nil, err
	}
	// Hold SQLite's writer lock across the provider mutation. Liability discovery
	// cannot cross this approval boundary; a provider ambiguity is still replayed
	// with the action's stable idempotency key and canonical readback.
	if _, err := tx.ExecContext(ctx, `UPDATE billing_duplicate_refund_actions SET revision=revision WHERE id=?`, action.ID); err != nil {
		return fail(err)
	}
	var jobLiabilityRevision, actionLiabilityRevision, actionRevision int64
	var state, snapshot string
	var completionEvidence int
	if err := tx.QueryRowContext(ctx, `SELECT state,revision,liability_revision,snapshot_json FROM billing_duplicate_refund_actions WHERE id=?`, action.ID).
		Scan(&state, &actionRevision, &actionLiabilityRevision, &snapshot); err != nil {
		return fail(err)
	}
	// The same completion gate as Save and finish, on the CURRENT row under the
	// writer lock, immediately before money moves: a cancellation recorded after
	// the action was prepared (it does not change liability_revision) without a
	// following inspection must stop the refund here, not after it.
	if err := tx.QueryRowContext(ctx, `SELECT liability_revision,discovered_at>0 AND (subscription_canceled=0 OR post_cancel_inspected=1) FROM billing_duplicate_refunds WHERE id=?`, action.JobID).Scan(&jobLiabilityRevision, &completionEvidence); err != nil {
		return fail(err)
	}
	if completionEvidence == 0 {
		return fail(errors.New("account: duplicate refund liabilities are incomplete (no inspection after the recorded cancellation); list evidence again after the worker re-inspects"))
	}
	liabilities, err := loadDuplicateRefundLiabilities(ctx, tx, action.JobID)
	if err != nil {
		return fail(err)
	}
	liveSnapshot, _, err := duplicateRefundLiabilitySnapshot(liabilities)
	if err != nil {
		return fail(err)
	}
	if state != "prepared" || actionRevision != action.Revision || actionLiabilityRevision != action.LiabilityRevision || jobLiabilityRevision != action.LiabilityRevision || snapshot != action.SnapshotJSON || string(liveSnapshot) != action.SnapshotJSON {
		return fail(errors.New("account: duplicate refund action liability snapshot is stale"))
	}
	return tx, nil
}

func markDuplicateRefundActionError(ctx context.Context, store *SQLiteStore, action duplicateRefundAction, message string, blocked bool, now int64) error {
	state := "prepared"
	if blocked {
		state = "blocked"
	}
	res, err := store.db.ExecContext(ctx, `UPDATE billing_duplicate_refund_actions SET state=?,last_error=?,revision=revision+1,updated_at=? WHERE id=? AND state='prepared' AND revision=?`, state, message, now, action.ID, action.Revision)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return errors.New("account: stale duplicate refund action error")
	}
	return nil
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
				if detail.Amount > payment.AmountPaid-succeeded {
					return nil, errors.New("stripe: duplicate refund succeeded amount exceeds amount paid")
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
		return nil, errDuplicateRefundCanonicalSnapshotStale
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
	if err := rows.Err(); err != nil {
		rows.Close()
		return false, err
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
		if err := tx.QueryRowContext(ctx, `SELECT id,job_id,generation,liability_revision,actor,reason,state,snapshot_json,proof_json,last_error,revision FROM billing_duplicate_refund_actions WHERE job_id=? ORDER BY generation DESC LIMIT 1`, jobID).
			Scan(&action.ID, &action.JobID, &action.Generation, &action.LiabilityRevision, &action.Actor, &action.Reason, &action.State, &action.SnapshotJSON, &action.ProofJSON, &action.LastError, &action.Revision); err != nil {
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
		var liabilityRevision int64
		if err := tx.QueryRowContext(ctx, `SELECT liability_revision FROM billing_duplicate_refunds WHERE id=?`, jobID).Scan(&liabilityRevision); err != nil {
			return false, err
		}
		liabilities, err := loadDuplicateRefundLiabilities(ctx, tx, jobID)
		if err != nil {
			return false, err
		}
		currentSnapshot, currentDigest, err := duplicateRefundLiabilitySnapshot(liabilities)
		if err != nil || currentDigest == "" {
			if err == nil {
				err = errors.New("account: duplicate refund current liability digest is empty")
			}
			return false, err
		}
		if liabilityRevision < action.LiabilityRevision || (liabilityRevision == action.LiabilityRevision) != (string(currentSnapshot) == action.SnapshotJSON) {
			return false, errors.New("account: duplicate refund liability revision and snapshot are inconsistent")
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO billing_duplicate_refund_actions(id,job_id,generation,liability_revision,actor,reason,state,snapshot_json,last_error,created_at,updated_at) VALUES(?,?,?,?,?,?,'prepared',?,?,?,?)`, nextID, jobID, nextGeneration, liabilityRevision, action.Actor, action.Reason, string(currentSnapshot), errDuplicateRefundProviderFailed.Error(), failedAt, failedAt); err != nil {
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
			guard, err := beginDuplicateRefundProviderMutation(ctx, store, action)
			if err != nil {
				return "", err
			}
			form := url.Values{"payment_intent": {current.PaymentIntentID}, "amount": {fmt.Sprint(remaining)}, "metadata[relayium_duplicate_refund_action_id]": {action.ID}, "metadata[relayium_invoice_payment_id]": {current.InvoicePaymentID}}
			body, err := client.requestKeyed(ctx, http.MethodPost, "/v1/refunds", form, "duplicate-refund:"+action.ID+":"+current.InvoicePaymentID)
			if err != nil {
				guard.Rollback()
				return "", err
			}
			if err := guard.Commit(); err != nil {
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
	var jobLiabilityRevision, actionRevision int64
	if err := tx.QueryRowContext(ctx, `SELECT state,liability_revision FROM billing_duplicate_refunds WHERE id=?`, job.ID).Scan(&jobState, &jobLiabilityRevision); err != nil {
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
	if jobLiabilityRevision != action.LiabilityRevision {
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
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
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
	res, err = tx.ExecContext(ctx, `UPDATE billing_duplicate_refunds SET state='terminal',manual_reason='',refund_complete=1,last_error='',revision=revision+1,next_audit_at=?,updated_at=? WHERE id=? AND state='manual' AND liability_revision=? AND discovered_at>0 AND (subscription_canceled=0 OR post_cancel_inspected=1)`, now+6*60*60, now, job.ID, action.LiabilityRevision)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return errors.New("account: stale duplicate refund job")
	}
	return tx.Commit()
}

func ResolveDuplicateRefund(ctx context.Context, store *SQLiteStore, biller Biller, selector, actor, reason string, expectedLiabilityRevision int64, expectedDigest string) (DuplicateRefundOperatorResult, error) {
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
	if job.DiscoveredAt == 0 {
		return DuplicateRefundOperatorResult{}, errors.New("account: duplicate refund liabilities are unknown until one complete inspection is recorded")
	}
	if job.SubscriptionCanceled && !job.PostCancelInspected {
		return DuplicateRefundOperatorResult{}, errors.New("account: duplicate refund liabilities are incomplete until an inspection after cancellation is recorded")
	}
	_, currentDigest, err := duplicateRefundLiabilitySnapshot(job.Liabilities)
	if err != nil {
		return DuplicateRefundOperatorResult{}, err
	}
	if expectedLiabilityRevision < 0 || strings.TrimSpace(expectedDigest) == "" {
		return DuplicateRefundOperatorResult{}, errors.New("account: duplicate refund expected liability revision and digest are required; list evidence again")
	}
	if job.LiabilityRevision != expectedLiabilityRevision || !strings.EqualFold(currentDigest, strings.TrimSpace(expectedDigest)) {
		return DuplicateRefundOperatorResult{}, errors.New("account: duplicate refund evidence is stale; list evidence again")
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

// PutDuplicateRefund appends plan's liabilities to the responsibility for its
// duplicate subscription, creating it when absent. fullInspection must be true
// only when plan is the result of one COMPLETE inspection of the duplicate's
// invoice history; it is what turns an unknown liability set (discovered_at=0)
// into a known one. A single observed invoice passes false.
func (s *SQLiteStore) PutDuplicateRefund(ctx context.Context, plan DuplicateRefundPlan, fullInspection bool, now int64) (DuplicateRefundJob, error) {
	return s.putDuplicateRefund(ctx, plan, fullInspection, duplicateInspectionStart{}, now)
}

// PutDuplicateRefundInspection records one COMPLETE inspection.
// startedAfterCancel must come from a read of the job row made BEFORE the
// inspection began that already showed subscription_canceled=1: only then can
// the inspection have seen every invoice the duplicate could create before it
// stopped. That fact is recorded durably (post_cancel_inspected) in the same
// transaction as the liabilities, and completion is fenced on it in SQL; no
// later in-memory judgement can stand in for it.
func (s *SQLiteStore) PutDuplicateRefundInspection(ctx context.Context, plan DuplicateRefundPlan, start duplicateInspectionStart, now int64) (DuplicateRefundJob, error) {
	return s.putDuplicateRefund(ctx, plan, true, start, now)
}

func (s *SQLiteStore) putDuplicateRefund(ctx context.Context, plan DuplicateRefundPlan, fullInspection bool, start duplicateInspectionStart, now int64) (DuplicateRefundJob, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return DuplicateRefundJob{}, err
	}
	defer tx.Rollback()
	if err := putDuplicateResponsibilityTx(ctx, tx, plan, fullInspection, start, now); err != nil {
		return DuplicateRefundJob{}, err
	}
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

// putDuplicateResponsibilityTx is the single insert/append path for a
// duplicate-subscription responsibility, run inside the caller's transaction:
// PutDuplicateRefund's own, or the Bind transaction that records placeholders
// (recordDuplicateResponsibilitiesTx). It never commits.
func putDuplicateResponsibilityTx(ctx context.Context, tx *sql.Tx, plan DuplicateRefundPlan, fullInspection bool, start duplicateInspectionStart, now int64) error {
	startedAfterCancel := start.Canceled
	if startedAfterCancel && !fullInspection {
		return errors.New("account: only a complete inspection can follow a cancellation")
	}
	if fullInspection && now <= 0 {
		return errors.New("account: duplicate refund inspection time is required")
	}
	if plan.UserID == "" || plan.CustomerID == "" || plan.CanonicalSubscriptionID == "" || plan.DuplicateSubscriptionID == "" || plan.CanonicalSubscriptionID == plan.DuplicateSubscriptionID {
		return errors.New("account: duplicate refund identity is incomplete")
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
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO billing_duplicate_refunds(id,user_id,customer_id,canonical_subscription_id,duplicate_subscription_id,state,manual_reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`, id, plan.UserID, plan.CustomerID, plan.CanonicalSubscriptionID, plan.DuplicateSubscriptionID, state, plan.ManualReason, now, now); err != nil {
		return err
	}
	insertedLiability := false
	for _, liability := range plan.Liabilities {
		res, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO billing_duplicate_refund_invoices(job_id,invoice_id,status,amount_paid,manual_reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`, id, liability.InvoiceID, liability.Status, liability.AmountPaid, liability.ManualReason, now, now)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 1 {
			insertedLiability = true
		}
		var gotStatus, gotReason string
		var gotAmountPaid int64
		if err := tx.QueryRowContext(ctx, `SELECT status,amount_paid,manual_reason FROM billing_duplicate_refund_invoices WHERE job_id=? AND invoice_id=?`, id, liability.InvoiceID).Scan(&gotStatus, &gotAmountPaid, &gotReason); err != nil {
			return err
		}
		if liability.AmountPaid < gotAmountPaid {
			return errors.New("account: duplicate refund invoice amount regressed")
		}
		if liability.Status != gotStatus || liability.AmountPaid != gotAmountPaid || liability.ManualReason != gotReason {
			if _, err := tx.ExecContext(ctx, `UPDATE billing_duplicate_refund_invoices SET status=?,amount_paid=?,manual_reason=?,updated_at=? WHERE job_id=? AND invoice_id=?`, liability.Status, liability.AmountPaid, liability.ManualReason, now, id, liability.InvoiceID); err != nil {
				return err
			}
			insertedLiability = true
		}
		for _, payment := range liability.Payments {
			res, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO billing_duplicate_refund_liabilities(job_id,invoice_id,invoice_payment_id,payment_type,payment_intent_id,payment_record_id,charge_id,amount_paid,charge_amount,paid_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, id, liability.InvoiceID, payment.InvoicePaymentID, payment.PaymentType, payment.PaymentIntentID, payment.PaymentRecordID, payment.ChargeID, payment.AmountPaid, payment.ChargeAmount, payment.PaidAt, now)
			if err != nil {
				return err
			}
			if n, _ := res.RowsAffected(); n == 1 {
				insertedLiability = true
			}
			var got CanonicalStripeInvoicePayment
			if err := tx.QueryRowContext(ctx, `SELECT invoice_payment_id,payment_type,payment_intent_id,payment_record_id,charge_id,amount_paid,charge_amount,paid_at FROM billing_duplicate_refund_liabilities WHERE job_id=? AND invoice_id=? AND invoice_payment_id=?`, id, liability.InvoiceID, payment.InvoicePaymentID).
				Scan(&got.InvoicePaymentID, &got.PaymentType, &got.PaymentIntentID, &got.PaymentRecordID, &got.ChargeID, &got.AmountPaid, &got.ChargeAmount, &got.PaidAt); err != nil || got != payment {
				return errors.New("account: duplicate refund payment liability identity conflict")
			}
		}
	}
	if insertedLiability {
		manual := plan.ManualReason
		if manual == "" {
			manual = "new_invoice_liability"
		}
		if _, err := tx.ExecContext(ctx, `UPDATE billing_duplicate_refunds SET state=CASE WHEN subscription_canceled=1 THEN 'manual' ELSE 'pending' END,manual_reason=CASE WHEN subscription_canceled=1 THEN ? ELSE manual_reason END,refund_complete=0,revision=revision+1,liability_revision=liability_revision+1,next_audit_at=0,updated_at=? WHERE id=?`, manual, now, id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE billing_duplicate_refund_actions SET state='failed',last_error='liability set expanded',revision=revision+1,updated_at=? WHERE job_id=? AND state='prepared'`, now, id); err != nil {
			return err
		}
	} else if plan.ManualReason != "" {
		if _, err := tx.ExecContext(ctx, `UPDATE billing_duplicate_refunds SET state=CASE WHEN state='terminal' THEN state ELSE 'manual' END,manual_reason=CASE WHEN state='terminal' THEN manual_reason ELSE ? END,updated_at=? WHERE id=?`, plan.ManualReason, now, id); err != nil {
			return err
		}
	} else {
		// A due terminal audit that found no new liability moves to the back of
		// the bounded scan. This preserves perpetual late-payment detection without
		// letting the oldest 100 clean tombstones starve newer responsibilities.
		if _, err := tx.ExecContext(ctx, `UPDATE billing_duplicate_refunds SET next_audit_at=? WHERE id=? AND state='terminal'`, now+6*60*60, id); err != nil {
			return err
		}
	}
	if fullInspection {
		// Monotonic: a later full inspection can only move the evidence time
		// forward, and nothing but this branch ever makes it non-zero.
		if _, err := tx.ExecContext(ctx, `UPDATE billing_duplicate_refunds SET discovered_at=MAX(discovered_at,?) WHERE id=?`, now, id); err != nil {
			return err
		}
	}
	if startedAfterCancel {
		// Monotonic. The row must still say canceled: the caller's claim is about
		// a read of this same durable flag, which is never cleared.
		// ...and no contradiction may have been recorded since that read, nor be
		// open now.
		if _, err := tx.ExecContext(ctx, `UPDATE billing_duplicate_refunds SET post_cancel_inspected=1 WHERE id=? AND subscription_canceled=1 AND cancel_contradictions=? AND cancel_reconfirmed=cancel_contradictions`, id, start.Contradictions); err != nil {
			return err
		}
	}
	var gotUser, gotCustomer, gotCanonical string
	if err := tx.QueryRowContext(ctx, `SELECT user_id,customer_id,canonical_subscription_id FROM billing_duplicate_refunds WHERE duplicate_subscription_id=?`, plan.DuplicateSubscriptionID).
		Scan(&gotUser, &gotCustomer, &gotCanonical); err != nil {
		return err
	}
	if gotUser != plan.UserID || gotCustomer != plan.CustomerID || gotCanonical != plan.CanonicalSubscriptionID {
		return errors.New("account: duplicate refund responsibility conflicts with existing row")
	}
	return nil
}

// DuplicateResponsibilityRef names one duplicate subscription a complete
// reconciliation list discovered, recorded atomically with the Bind of its
// canonical subscription.
type DuplicateResponsibilityRef struct {
	UserID, CustomerID, CanonicalSubscriptionID, DuplicateSubscriptionID string
}

// DuplicateResponsibilityOwnershipConflict aborts a Bind: an existing
// responsibility for this duplicate belongs to another user or customer.
// Nothing in the Bind transaction commits and the other row is not touched.
type DuplicateResponsibilityOwnershipConflict struct {
	Ref                                DuplicateResponsibilityRef
	ExistingUserID, ExistingCustomerID string
}

func (e *DuplicateResponsibilityOwnershipConflict) Error() string {
	return fmt.Sprintf("account: duplicate responsibility for %s is owned by user %s customer %s, not user %s customer %s", e.Ref.DuplicateSubscriptionID, e.ExistingUserID, e.ExistingCustomerID, e.Ref.UserID, e.Ref.CustomerID)
}

// canonicalConflictAlreadyRecorded reports whether the latest canonical_conflict
// evidence entry -- not undone by a later operator clear -- already names this
// canonical, whatever hold is in force (another hold, e.g. admin_comp, keeps
// precedence). Recording it again would only add evidence and revision churn (a
// revision bump also defeats the operator's revision-fenced hold clear).
func canonicalConflictAlreadyRecorded(_ /* hold */, evidence, canonical string) bool {
	var entries []map[string]any
	if json.Unmarshal([]byte(evidence), &entries) != nil {
		return false
	}
	for i := len(entries) - 1; i >= 0; i-- {
		if _, cleared := entries[i]["cleared"]; cleared {
			return false
		}
		if reason, _ := entries[i]["reason"].(string); reason == duplicateHoldCanonicalConflict {
			seen, _ := entries[i]["canonical_seen"].(string)
			return seen == canonical
		}
	}
	return false
}

// duplicateResponsibilityOwnershipLog is the fixed prefix of the diagnostic
// logged OUTSIDE the rolled-back Bind transaction.
const duplicateResponsibilityOwnershipLog = "billing: duplicate responsibility ownership conflict"

// recordDuplicateResponsibilitiesTx runs inside the Bind transaction (FINAL
// §4.1-4.2). For each discovered duplicate:
//   - no row: a placeholder through putDuplicateResponsibilityTx in the
//     step-1 "unknown" state (pending, discovered_at=0, no liabilities,
//     post_cancel_inspected=0), so every step-1 gate applies to it unchanged;
//   - same user, customer and canonical: nothing;
//   - same user and customer, other canonical: its canonical and history are
//     kept; cancel_hold='canonical_conflict' is set if empty and evidence
//     naming the new canonical is appended;
//   - other user or customer: *DuplicateResponsibilityOwnershipConflict, and
//     the caller rolls the whole Bind back.
func recordDuplicateResponsibilitiesTx(ctx context.Context, tx *sql.Tx, refs []DuplicateResponsibilityRef, now int64) error {
	for _, ref := range refs {
		var id, user, customer, canonical string
		err := tx.QueryRowContext(ctx, `SELECT id,user_id,customer_id,canonical_subscription_id FROM billing_duplicate_refunds WHERE duplicate_subscription_id=?`, ref.DuplicateSubscriptionID).Scan(&id, &user, &customer, &canonical)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			if err := putDuplicateResponsibilityTx(ctx, tx, DuplicateRefundPlan{UserID: ref.UserID, CustomerID: ref.CustomerID, CanonicalSubscriptionID: ref.CanonicalSubscriptionID, DuplicateSubscriptionID: ref.DuplicateSubscriptionID}, false, duplicateInspectionStart{}, now); err != nil {
				return err
			}
		case err != nil:
			return err
		case user != ref.UserID || customer != ref.CustomerID:
			return &DuplicateResponsibilityOwnershipConflict{Ref: ref, ExistingUserID: user, ExistingCustomerID: customer}
		case canonical != ref.CanonicalSubscriptionID:
			var hold, evidence string
			if err := tx.QueryRowContext(ctx, `SELECT cancel_hold,hold_evidence FROM billing_duplicate_refunds WHERE id=?`, id).Scan(&hold, &evidence); err != nil {
				return err
			}
			if canonicalConflictAlreadyRecorded(hold, evidence, ref.CanonicalSubscriptionID) {
				continue // no evidence or revision churn on every reconcile
			}
			if _, err := holdDuplicateRefundCancellationTx(ctx, tx, id, duplicateHoldEvidence{At: now, Reason: duplicateHoldCanonicalConflict, Path: "bind", Actor: "system", CanonicalSeen: ref.CanonicalSubscriptionID, BindingSeen: ref.CanonicalSubscriptionID, CustomerSeen: ref.CustomerID}); err != nil {
				return err
			}
		}
	}
	return nil
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
	// One invoice is not a complete inspection: an unknown placeholder must
	// stay unknown (fullInspection=false).
	_, err = s.PutDuplicateRefund(ctx, DuplicateRefundPlan{
		UserID: job.UserID, CustomerID: job.CustomerID, CanonicalSubscriptionID: job.CanonicalSubscriptionID, DuplicateSubscriptionID: job.DuplicateSubscriptionID,
		Liabilities: []DuplicateRefundLiability{{InvoiceID: invoice.InvoiceID, Status: "paid", AmountPaid: invoice.AmountPaid, Payments: invoice.Payments, ManualReason: duplicateRefundManualReason(invoice)}},
	}, false, now)
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
	return s.saveDuplicateRefund(ctx, job, result, providerErr, now, true)
}

// SaveDuplicateRefundBeforeReinspection persists a cancellation observed in
// this run BEFORE the post-cancel inspection has re-read the liabilities. It can
// never make the job terminal or refund_complete: a liability can still appear
// between the pre-cancel inspection and the DELETE, and a failed re-inspection
// must leave the job for the next worker run instead of ending it.
func (s *SQLiteStore) SaveDuplicateRefundBeforeReinspection(ctx context.Context, job DuplicateRefundJob, result DuplicateRefundResult, now int64) error {
	return s.saveDuplicateRefund(ctx, job, result, nil, now, false)
}

func (s *SQLiteStore) saveDuplicateRefund(ctx context.Context, job DuplicateRefundJob, result DuplicateRefundResult, providerErr error, now int64, allowTerminal bool) error {
	// The pre-reinspection save is only ever made on THIS run's fresh provider
	// confirmation of cancellation; it closes an open contradiction, but only
	// if no further contradiction was recorded since job was read (before the
	// provider call).
	reconfirm := !allowTerminal && result.SubscriptionCanceled && providerErr == nil
	// A successful FINAL save is a clean outcome that resets the failure
	// bookkeeping; it is fenced on the CURRENT row having no open
	// contradiction (one may be recorded after this run's snapshot). The
	// pre-reinspection save stays unfenced: it is the reconfirmation path.
	cleanOutcome := allowTerminal && providerErr == nil
	if !allowTerminal {
		result.RefundComplete = false
	}
	state, manual, lastError := "pending", result.ManualReason, ""
	if result.SubscriptionCanceled && result.RefundComplete && len(job.Liabilities) == 0 {
		manual = "no_refund_needed"
	}
	if manual != "" {
		state = "manual"
	}
	if result.SubscriptionCanceled && result.RefundComplete && manual == "no_refund_needed" {
		state = "terminal"
	} else if result.SubscriptionCanceled {
		state = "manual"
		if manual == "" {
			manual = "refund_operator_required"
		}
	}
	if !allowTerminal && state == "manual" && manual == "refund_operator_required" && result.ManualReason == "" && len(job.Liabilities) == 0 {
		// Canceled, nothing known to be owed yet, re-inspection pending: keep the
		// job ordinary pending work rather than claiming operator action.
		state, manual = "pending", ""
	}
	if providerErr != nil {
		lastError = providerErr.Error()
	}
	// terminal and refund_complete require durable discovery evidence
	// (discovered_at>0), checked in the same fenced UPDATE that writes them: an
	// unknown liability set is at most manual/liabilities_unknown. Cancellation is
	// a monotonic fact, and a successful outcome resets the consecutive-failure
	// counter the alert reads. cancel_hold and hold_evidence are never written.
	res, err := s.db.ExecContext(ctx, `UPDATE billing_duplicate_refunds SET
 state=CASE WHEN ?='terminal' AND discovered_at=0 THEN 'manual' WHEN ?='terminal' AND post_cancel_inspected=0 THEN 'pending' ELSE ? END,
 manual_reason=CASE WHEN ?='terminal' AND discovered_at=0 THEN 'liabilities_unknown' WHEN ?='terminal' AND post_cancel_inspected=0 THEN '' ELSE ? END,
 refund_complete=CASE WHEN discovered_at>0 AND (MAX(subscription_canceled,?)=0 OR post_cancel_inspected=1) THEN ? ELSE 0 END,
 subscription_canceled=MAX(subscription_canceled,?),
 cancel_reconfirmed=CASE WHEN ?=1 AND cancel_contradictions=? THEN cancel_contradictions ELSE cancel_reconfirmed END,
 attempts=CASE WHEN ?<>'' THEN attempts+1 ELSE 0 END,
 revision=revision+1,last_error=?,updated_at=?
 WHERE id=? AND state<>'terminal' AND liability_revision=? AND (?=0 OR cancel_contradictions=cancel_reconfirmed)`, state, state, state, state, state, manual, b2i(result.SubscriptionCanceled), b2i(result.RefundComplete), b2i(result.SubscriptionCanceled), b2i(reconfirm), job.CancelContradictions, lastError, lastError, now, job.ID, job.LiabilityRevision, b2i(cleanOutcome))
	if err != nil {
		return err
	}
	if n, err := res.RowsAffected(); err != nil || n != 1 {
		if err != nil {
			return err
		}
		if providerErr == nil {
			// A successful audit of a terminal job whose liabilities did not change
			// ends any run of consecutive failures. Fenced on terminal state and the
			// same liability revision; state, liabilities, discovery, cancellation
			// and holds are untouched.
			cleared, err := s.db.ExecContext(ctx, `UPDATE billing_duplicate_refunds SET attempts=0,last_error='' WHERE id=? AND state='terminal' AND liability_revision=? AND cancel_contradictions=cancel_reconfirmed`, job.ID, job.LiabilityRevision)
			if err != nil {
				return err
			}
			if n, _ := cleared.RowsAffected(); n == 1 {
				return nil
			}
		} else {
			var currentState string
			var currentLiabilityRevision int64
			if err := s.reader().QueryRowContext(ctx, `SELECT state,liability_revision FROM billing_duplicate_refunds WHERE id=?`, job.ID).Scan(&currentState, &currentLiabilityRevision); err == nil && currentState == "terminal" && currentLiabilityRevision == job.LiabilityRevision {
				return nil
			}
		}
		if result.SubscriptionCanceled {
			// Cancellation is monotonic and remains useful even when a concurrent
			// payment expanded the liability set. Merge only that safe fact; never
			// copy the stale snapshot's no-refund conclusion over the new liability.
			if _, mergeErr := s.db.ExecContext(ctx, `UPDATE billing_duplicate_refunds SET subscription_canceled=1,state='manual',manual_reason='refund_operator_required',refund_complete=0,revision=revision+1,updated_at=? WHERE id=? AND state<>'terminal' AND liability_revision<>? AND EXISTS(SELECT 1 FROM billing_duplicate_refund_invoices WHERE job_id=?)`, now, job.ID, job.LiabilityRevision, job.ID); mergeErr != nil {
				return mergeErr
			}
		}
		var open int
		if err := s.reader().QueryRowContext(ctx, `SELECT cancel_contradictions>cancel_reconfirmed FROM billing_duplicate_refunds WHERE id=?`, job.ID).Scan(&open); err == nil && open != 0 {
			return errors.New("account: duplicate refund cancellation contradiction is open; not saved as a clean outcome")
		}
		return errors.New("account: duplicate refund update is stale")
	}
	return nil
}

// RecordDuplicateRefundError records a failed inspection, authorization read or
// provider call. It moves the job to the back of its scheduling class --
// updated_at for open work, next_audit_at for a terminal audit -- so a
// permanently failing job cannot monopolise the bounded worker scan. It never
// touches the cancellation flags, liabilities, discovered_at or cancel_hold.
func (s *SQLiteStore) RecordDuplicateRefundError(ctx context.Context, job DuplicateRefundJob, cause error, now int64) error {
	message := "unknown duplicate refund failure"
	if cause != nil {
		message = cause.Error()
	}
	if len(message) > 1024 {
		message = message[:1024]
	}
	res, err := s.db.ExecContext(ctx, `UPDATE billing_duplicate_refunds SET attempts=attempts+1,last_error=?,updated_at=?,next_audit_at=CASE WHEN state='terminal' THEN ? ELSE next_audit_at END,revision=revision+1 WHERE id=?`, message, now, now+6*60*60, job.ID)
	if err != nil {
		return err
	}
	if n, err := res.RowsAffected(); err != nil || n != 1 {
		if err != nil {
			return err
		}
		return errors.New("account: duplicate refund responsibility disappeared")
	}
	return nil
}

// RecordDuplicateCancelContradiction records a provider read that found the
// duplicate live while the row records it canceled. It voids post-cancel
// evidence and opens a contradiction (cancel_contradictions > cancel_reconfirmed)
// that only a later fresh confirmation can close. It is failure bookkeeping
// too: attempts+1, last_error, and the scheduling key advances. Cancellation,
// liabilities, discovery and holds are untouched.
func (s *SQLiteStore) RecordDuplicateCancelContradiction(ctx context.Context, job DuplicateRefundJob, cause error, now int64) error {
	message := cause.Error()
	if len(message) > 1024 {
		message = message[:1024]
	}
	res, err := s.db.ExecContext(ctx, `UPDATE billing_duplicate_refunds SET cancel_contradictions=cancel_contradictions+1,post_cancel_inspected=0,attempts=attempts+1,last_error=?,updated_at=?,next_audit_at=CASE WHEN state='terminal' THEN ? ELSE next_audit_at END,revision=revision+1 WHERE id=?`, message, now, now+6*60*60, job.ID)
	if err != nil {
		return err
	}
	if n, err := res.RowsAffected(); err != nil || n != 1 {
		if err != nil {
			return err
		}
		return errors.New("account: duplicate refund responsibility disappeared")
	}
	return nil
}

// ReconfirmDuplicateCancellation closes an open contradiction after THIS run's
// provider read freshly confirmed the duplicate canceled. Fenced on the
// contradiction count in job, which was read before the provider call: a
// contradiction recorded since then stays open. Works for terminal rows and
// touches nothing else (state, liabilities, refund/action proofs, holds); the
// post-cancel inspection that follows is what can re-set post_cancel_inspected.
// A fence miss is not an error: the contradiction simply stays open.
func (s *SQLiteStore) ReconfirmDuplicateCancellation(ctx context.Context, job DuplicateRefundJob, now int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE billing_duplicate_refunds SET cancel_reconfirmed=cancel_contradictions,revision=revision+1,updated_at=? WHERE id=? AND subscription_canceled=1 AND cancel_contradictions=? AND cancel_reconfirmed<cancel_contradictions`, now, job.ID, job.CancelContradictions)
	return err
}

// duplicateCancelAuthority is the CURRENT persisted local state a duplicate
// cancellation depends on, read in one statement immediately before DELETE.
type duplicateCancelAuthority struct {
	State, CancelHold                                                    string
	UserID, CustomerID, CanonicalSubscriptionID, DuplicateSubscriptionID string
	UserExists, DeletionPending                                          bool
	UserCustomerID, UserSubscriptionID, UserPlanSource                   string
	UserDeletedAt                                                        int64
}

// DuplicateCancelAuthority reads the job row and its user's billing binding in
// one statement (one snapshot). "Account deletion in progress" is represented
// by users.deleted_at>0 (CommitAccountDeletion) OR a pending account_deletion
// row in billing_cancellation_outbox for the user -- the record
// ReconcileBillingCancellations drives. The outbox is checked separately
// because ClearAccountDeletion can zero deleted_at while that saga is still
// pending. A purged account has no users row.
func (s *SQLiteStore) DuplicateCancelAuthority(ctx context.Context, jobID string) (duplicateCancelAuthority, error) {
	var a duplicateCancelAuthority
	var exists, pending int
	err := s.reader().QueryRowContext(ctx, `SELECT r.state,r.cancel_hold,r.user_id,r.customer_id,r.canonical_subscription_id,r.duplicate_subscription_id,
 u.id IS NOT NULL,COALESCE(u.stripe_customer_id,''),COALESCE(u.stripe_subscription_id,''),COALESCE(u.plan_source,''),COALESCE(u.deleted_at,0),
 EXISTS(SELECT 1 FROM billing_cancellation_outbox o WHERE o.billing_subject_id=r.user_id AND o.provider='stripe' AND o.state='pending' AND o.mode='account_deletion')
 FROM billing_duplicate_refunds r LEFT JOIN users u ON u.id=r.user_id WHERE r.id=?`, jobID).
		Scan(&a.State, &a.CancelHold, &a.UserID, &a.CustomerID, &a.CanonicalSubscriptionID, &a.DuplicateSubscriptionID, &exists, &a.UserCustomerID, &a.UserSubscriptionID, &a.UserPlanSource, &a.UserDeletedAt, &pending)
	if err != nil {
		return duplicateCancelAuthority{}, err
	}
	a.UserExists, a.DeletionPending = exists != 0, pending != 0
	return a, nil
}

// duplicateHoldEvidence is one append-only entry of hold_evidence.
type duplicateHoldEvidence struct {
	At            int64  `json:"at"`
	Reason        string `json:"reason"`
	Path          string `json:"path"`
	Actor         string `json:"actor"`
	CanonicalSeen string `json:"canonical_seen"`
	BindingSeen   string `json:"binding_seen"`
	// CustomerSeen is the LOCAL user's Stripe customer; CanonicalCustomerSeen is
	// the customer Stripe reports on the canonical subscription.
	CustomerSeen          string `json:"customer_seen"`
	CanonicalCustomerSeen string `json:"canonical_customer_seen,omitempty"`
}

// HoldDuplicateRefundCancellation sets cancel_hold when it is empty (an existing
// hold is preserved) and appends one evidence entry, atomically. It returns the
// hold now in force.
func (s *SQLiteStore) HoldDuplicateRefundCancellation(ctx context.Context, jobID string, evidence duplicateHoldEvidence) (string, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	hold, err := holdDuplicateRefundCancellationTx(ctx, tx, jobID, evidence)
	if err != nil {
		return "", err
	}
	return hold, tx.Commit()
}

func holdDuplicateRefundCancellationTx(ctx context.Context, tx *sql.Tx, jobID string, evidence duplicateHoldEvidence) (string, error) {
	if evidence.Reason == "" {
		return "", errors.New("account: duplicate cancellation hold reason is required")
	}
	raw, err := json.Marshal(evidence)
	if err != nil {
		return "", err
	}
	res, err := tx.ExecContext(ctx, `UPDATE billing_duplicate_refunds SET cancel_hold=CASE WHEN cancel_hold='' THEN ? ELSE cancel_hold END,hold_evidence=json_insert(hold_evidence,'$[#]',json(?)),revision=revision+1 WHERE id=?`, evidence.Reason, string(raw), jobID)
	if err != nil {
		return "", err
	}
	if n, err := res.RowsAffected(); err != nil || n != 1 {
		if err != nil {
			return "", err
		}
		return "", errors.New("account: duplicate refund responsibility disappeared")
	}
	var hold string
	if err := tx.QueryRowContext(ctx, `SELECT cancel_hold FROM billing_duplicate_refunds WHERE id=?`, jobID).Scan(&hold); err != nil {
		return "", err
	}
	if hold == "" {
		return "", errors.New("account: duplicate cancellation hold was not recorded")
	}
	return hold, nil
}

// ListDuplicateRefunds selects one bounded worker batch with a quota per class
// so neither can starve the other: at most limit*3/4 open (non-terminal) jobs,
// oldest updated_at first, and at most limit/4 due terminal audits, earliest
// next_audit_at first. A class that does not use its quota lends it to the
// other; the total never exceeds limit. Every run outcome advances the
// ordering key (Save/RecordDuplicateRefundError/Put), so the batch rotates.
func (s *SQLiteStore) ListDuplicateRefunds(ctx context.Context, limit int, now int64) ([]DuplicateRefundJob, error) {
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	openQuota := limit - limit/4
	scan := func(query string, args ...any) ([]string, error) {
		rows, err := s.reader().QueryContext(ctx, query, args...)
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
		return ids, rows.Err()
	}
	open, err := scan(`SELECT duplicate_subscription_id FROM billing_duplicate_refunds WHERE state<>'terminal' ORDER BY updated_at,id LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	due, err := scan(`SELECT duplicate_subscription_id FROM billing_duplicate_refunds WHERE state='terminal' AND next_audit_at<=? ORDER BY next_audit_at,id LIMIT ?`, now, limit)
	if err != nil {
		return nil, err
	}
	takeOpen := len(open)
	if takeOpen > openQuota && takeOpen > limit-len(due) {
		takeOpen = openQuota
		if limit-len(due) > takeOpen {
			takeOpen = limit - len(due)
		}
	}
	takeDue := len(due)
	if takeDue > limit-takeOpen {
		takeDue = limit - takeOpen
	}
	selected := append(append([]string(nil), open[:takeOpen]...), due[:takeDue]...)
	seen := map[string]bool{}
	out := make([]DuplicateRefundJob, 0, len(selected))
	for _, id := range selected {
		if seen[id] {
			continue
		}
		seen[id] = true
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
	if exists {
		// The same comparison the Bind transaction makes (FINAL §4.2): never act
		// for another identity; a different canonical is held, never rewritten.
		ref := DuplicateResponsibilityRef{UserID: user.ID, CustomerID: user.StripeCustomerID, CanonicalSubscriptionID: canonicalID, DuplicateSubscriptionID: duplicateID}
		switch {
		case job.UserID != user.ID || job.CustomerID != user.StripeCustomerID:
			conflict := &DuplicateResponsibilityOwnershipConflict{Ref: ref, ExistingUserID: job.UserID, ExistingCustomerID: job.CustomerID}
			log.Printf("%s: user=%s customer=%s canonical=%s duplicate=%s existing_user=%s existing_customer=%s (inline attempt refused)", duplicateResponsibilityOwnershipLog, user.ID, user.StripeCustomerID, canonicalID, duplicateID, job.UserID, job.CustomerID)
			return conflict
		case job.CanonicalSubscriptionID != canonicalID && canonicalConflictAlreadyRecorded(job.CancelHold, job.HoldEvidence, canonicalID):
			// Already held for this conflict (typically by the Bind transaction
			// that just ran): nothing to append.
		case job.CanonicalSubscriptionID != canonicalID:
			if _, err := store.HoldDuplicateRefundCancellation(ctx, job.ID, duplicateHoldEvidence{At: s.Now().Unix(), Reason: duplicateHoldCanonicalConflict, Path: "inline", Actor: "system", CanonicalSeen: canonicalID, BindingSeen: canonicalID, CustomerSeen: user.StripeCustomerID}); err != nil {
				return err
			}
			if job, _, err = store.DuplicateRefundBySubscription(ctx, duplicateID); err != nil {
				return err
			}
		}
	}
	if !exists {
		plan, err := provider.InspectDuplicateSubscription(ctx, user.ID, user.StripeCustomerID, canonicalID, duplicateID)
		if err != nil {
			return err
		}
		job, err = store.PutDuplicateRefund(ctx, plan, true, s.Now().Unix())
		if err != nil {
			return err
		}
	}
	return s.runDuplicateRefund(ctx, store, provider, job)
}

// duplicateCancelAuthorizer returns the check the provider runs after reading
// the duplicate and immediately before DELETE. It re-reads the CURRENT persisted
// job and user rows (never the caller's snapshot), then Stripe's canonical
// subscription. Any refusal becomes a durable cancel_hold with evidence; an
// unreadable input is a retryable error. Neither issues a DELETE.
//
// Residual, documented rather than claimed away: Stripe (the canonical being
// canceled) and the local rows (binding, comp, deletion, hold) can still change
// in the milliseconds between this check and the DELETE.
func (s *Service) duplicateCancelAuthorizer(store duplicateRefundStore, provider duplicateSubscriptionProvider, job DuplicateRefundJob) func(context.Context) (string, error) {
	return func(ctx context.Context) (string, error) {
		if s.cfg.DisableBillingDuplicateAutoCancel {
			return "", errDuplicateAutoCancelDisabled
		}
		if job.CanonicalSubscriptionID == "" || job.CanonicalSubscriptionID == job.DuplicateSubscriptionID {
			return "", errors.New("billing: duplicate cancellation has no distinct canonical subscription")
		}
		current, err := store.DuplicateCancelAuthority(ctx, job.ID)
		if err != nil {
			return "", fmt.Errorf("billing: read duplicate cancellation authority: %w", err)
		}
		if current.CancelHold != "" {
			return current.CancelHold, nil
		}
		if current.State == "terminal" {
			return "", errors.New("billing: duplicate refund job is terminal; cancellation is not authorized")
		}
		if current.UserID != job.UserID || current.CustomerID != job.CustomerID || current.CanonicalSubscriptionID != job.CanonicalSubscriptionID || current.DuplicateSubscriptionID != job.DuplicateSubscriptionID {
			return "", errors.New("billing: duplicate refund responsibility identity changed")
		}
		evidence := duplicateHoldEvidence{At: s.Now().Unix(), Actor: "system", Path: "duplicate_cancel_authorization", BindingSeen: current.UserSubscriptionID, CustomerSeen: current.UserCustomerID}
		switch {
		case !current.UserExists:
			evidence.Reason = duplicateHoldAccountMissing
		case current.UserDeletedAt > 0 || current.DeletionPending:
			evidence.Reason = duplicateHoldAccountDeleting
		case current.UserPlanSource == "admin":
			evidence.Reason = duplicateHoldAdminComp
		case current.UserCustomerID != job.CustomerID:
			evidence.Reason = duplicateHoldCustomerChanged
		case current.UserSubscriptionID != job.CanonicalSubscriptionID:
			evidence.Reason = duplicateHoldCanonicalReplaced
		}
		if evidence.Reason == "" {
			canonical, missing, err := provider.DuplicateCanonicalSubscription(ctx, job.CanonicalSubscriptionID)
			if err != nil {
				return "", fmt.Errorf("billing: read canonical subscription: %w", err)
			}
			evidence.CanonicalSeen = "missing"
			if !missing {
				evidence.CanonicalSeen, evidence.CanonicalCustomerSeen = canonical.Status, canonical.CustomerID
			}
			switch {
			case missing:
				evidence.Reason = duplicateHoldCanonicalNotLive
			case canonical.CustomerID != job.CustomerID:
				evidence.Reason = duplicateHoldCustomerChanged
			case canonical.Status == "active" || canonical.Status == "trialing":
				return "", nil
			case canonical.Status == "past_due":
				// Deliberately stricter than liveSubStatus: canceling a paying
				// duplicate while the canonical is failing to charge could leave the
				// customer with only a failing subscription.
				evidence.Reason = duplicateHoldCanonicalPastDue
			default:
				evidence.Reason = duplicateHoldCanonicalNotLive
			}
		}
		hold, err := store.HoldDuplicateRefundCancellation(ctx, job.ID, evidence)
		if err != nil {
			return "", fmt.Errorf("billing: persist duplicate cancellation hold: %w", err)
		}
		log.Printf("billing: duplicate cancellation held job=%s duplicate=%s reason=%s", job.ID, job.DuplicateSubscriptionID, hold)
		return hold, nil
	}
}

func (s *Service) runDuplicateRefund(ctx context.Context, store duplicateRefundStore, provider duplicateSubscriptionProvider, job DuplicateRefundJob) error {
	fail := func(stage string, cause error) error {
		if err := store.RecordDuplicateRefundError(ctx, job, fmt.Errorf("%s: %w", stage, cause), s.Now().Unix()); err != nil {
			log.Printf("%s: job=%s duplicate=%s reason=persistence_failed stage=record_error cause=%q err=%v", duplicateResponsibilityAlert, job.ID, job.DuplicateSubscriptionID, cause.Error(), err)
		}
		return cause
	}
	persistFail := func(stage string, cause error) error {
		log.Printf("%s: job=%s duplicate=%s reason=persistence_failed stage=%s err=%v", duplicateResponsibilityAlert, job.ID, job.DuplicateSubscriptionID, stage, cause)
		return fail(stage, cause)
	}
	plan, err := provider.InspectDuplicateSubscription(ctx, job.UserID, job.CustomerID, job.CanonicalSubscriptionID, job.DuplicateSubscriptionID)
	if err != nil {
		return fail("inspect", err)
	}
	// job was read from the store before this inspection started, so its
	// cancellation state is a durable happened-before fact.
	current, err := store.PutDuplicateRefundInspection(ctx, plan, inspectionStartFrom(job), s.Now().Unix())
	if err != nil {
		return persistFail("put_inspection", err)
	}
	job = current
	result, providerErr := provider.ReconcileDuplicateSubscription(ctx, job, s.duplicateCancelAuthorizer(store, provider, job))
	if job.SubscriptionCanceled && result.ObservedLive {
		// The row (read before this provider call) records the duplicate
		// canceled, but Stripe just reported it live. Fail closed: void any
		// post-cancel evidence and keep the job from finishing until a later
		// FRESH confirmation of cancellation is followed by a new inspection.
		// Whatever the provider did after that read (hold, skip, or an
		// authorized DELETE) is not completion evidence for this run.
		cause := errors.New("billing: duplicate subscription recorded canceled but Stripe reports it live")
		if providerErr != nil {
			cause = fmt.Errorf("%w; provider: %v", cause, providerErr)
		}
		log.Printf("%s: job=%s duplicate=%s reason=cancel_contradiction hold=%s skipped=%t canceled_now=%t", duplicateResponsibilityAlert, job.ID, job.DuplicateSubscriptionID, result.HoldReason, result.CancelSkipped, result.SubscriptionCanceled)
		if err := store.RecordDuplicateCancelContradiction(ctx, job, cause, s.Now().Unix()); err != nil {
			log.Printf("%s: job=%s duplicate=%s reason=persistence_failed stage=record_contradiction err=%v", duplicateResponsibilityAlert, job.ID, job.DuplicateSubscriptionID, err)
		}
		return cause
	}
	if providerErr != nil {
		return fail("cancel", providerErr)
	}
	if result.SubscriptionCanceled && !job.PostCancelInspected {
		// No recorded inspection started after the cancellation was durable.
		// Persist the cancellation fact, re-read it, then re-inspect; only that
		// later inspection may conclude there is nothing to refund. The SQL
		// completion gate (post_cancel_inspected) enforces this even if another
		// run interleaves.
		if job.State != "terminal" {
			if err := store.SaveDuplicateRefundBeforeReinspection(ctx, job, result, s.Now().Unix()); err != nil {
				return persistFail("save_canceled", err)
			}
		}
		if job.CancelContradictions > job.CancelReconfirmed {
			// This run freshly confirmed the cancellation. Close the open
			// contradiction -- for terminal rows too, which the save above cannot
			// touch -- but only if no newer contradiction was recorded since job
			// was read (before the provider call).
			if err := store.ReconfirmDuplicateCancellation(ctx, job, s.Now().Unix()); err != nil {
				return persistFail("reconfirm_canceled", err)
			}
		}
		persisted, found, err := store.DuplicateRefundBySubscription(ctx, job.DuplicateSubscriptionID)
		if err != nil || !found {
			if err == nil {
				err = errors.New("account: duplicate refund responsibility disappeared")
			}
			return persistFail("reload_canceled", err)
		}
		plan, err = provider.InspectDuplicateSubscription(ctx, job.UserID, job.CustomerID, job.CanonicalSubscriptionID, job.DuplicateSubscriptionID)
		if err != nil {
			return fail("post_cancel_inspect", err)
		}
		current, err = store.PutDuplicateRefundInspection(ctx, plan, inspectionStartFrom(persisted), s.Now().Unix())
		if err != nil {
			return persistFail("put_post_cancel_inspection", err)
		}
		job = current
		result.RefundComplete = len(job.Liabilities) == 0
		result.ManualReason = job.ManualReason
	}
	if job.CancelContradictions > job.CancelReconfirmed {
		// Still open (a newer contradiction was recorded during this run): not a
		// clean outcome. Keep it visible as a failure instead of saving.
		log.Printf("%s: job=%s duplicate=%s reason=cancel_contradiction contradictions=%d reconfirmed=%d", duplicateResponsibilityAlert, job.ID, job.DuplicateSubscriptionID, job.CancelContradictions, job.CancelReconfirmed)
		return fail("cancel_contradiction_open", errors.New("billing: duplicate cancellation contradiction is still open"))
	}
	if err := store.SaveDuplicateRefund(ctx, job, result, nil, s.Now().Unix()); err != nil {
		return persistFail("save", err)
	}
	// Refunds are an operator-only action. The background worker's authority is
	// deliberately limited to discovering durable liabilities and stopping the
	// duplicate subscription from creating another charge. A paid liability stays
	// manual until ResolveDuplicateRefund is explicitly invoked with an actor and
	// reason and its provider proof is durably committed.
	return nil
}

// duplicateHoldSince returns when the hold now in force was set, from the last
// hold_evidence entry that records it (operator clears carry "cleared").
func duplicateHoldSince(job DuplicateRefundJob) int64 {
	var entries []map[string]any
	if json.Unmarshal([]byte(job.HoldEvidence), &entries) != nil {
		return 0
	}
	for i := len(entries) - 1; i >= 0; i-- {
		if _, cleared := entries[i]["cleared"]; cleared {
			continue
		}
		reason, _ := entries[i]["reason"].(string)
		at, _ := entries[i]["at"].(float64)
		if reason == job.CancelHold && at > 0 {
			return int64(at)
		}
	}
	return 0
}

// duplicateResponsibilityAttention lists why a job needs an operator: about a
// day of consecutive failures, liabilities still unknown after a day, or a
// cancellation hold older than three days.
func duplicateResponsibilityAttention(job DuplicateRefundJob, now int64) []string {
	var reasons []string
	if job.Attempts >= 4 {
		reasons = append(reasons, "repeated_failures")
	}
	if job.CancelContradictions > job.CancelReconfirmed {
		reasons = append(reasons, "cancel_contradiction")
	}
	if job.State == "terminal" && job.SubscriptionCanceled && !job.PostCancelInspected {
		// Visibility only: a terminal job whose post-cancel evidence was voided
		// (or a legacy terminal row a failing audit cannot re-inspect).
		reasons = append(reasons, "post_cancel_evidence_missing")
	}
	if job.DiscoveredAt == 0 && now-job.CreatedAt > 24*60*60 {
		reasons = append(reasons, "liabilities_unknown")
	}
	if job.CancelHold != "" {
		since := duplicateHoldSince(job)
		if since == 0 {
			since = job.CreatedAt
		}
		if now-since > 72*60*60 {
			reasons = append(reasons, "cancel_hold")
		}
	}
	return reasons
}

func (s *Service) ReconcileDuplicateRefunds(ctx context.Context) {
	store, ok := s.Store().(duplicateRefundStore)
	provider, providerOK := s.biller.(duplicateSubscriptionProvider)
	if !ok || !providerOK {
		return
	}
	jobs, err := store.ListDuplicateRefunds(ctx, 100, s.Now().Unix())
	if err != nil {
		log.Printf("billing: list duplicate refund responsibilities: %v", err)
		return
	}
	for _, job := range jobs {
		if err := ctx.Err(); err != nil {
			return
		}
		if err := s.runDuplicateRefund(ctx, store, provider, job); err != nil {
			log.Printf("billing: reconcile duplicate refund %s: %v", job.ID, err)
		}
		after, found, err := store.DuplicateRefundBySubscription(ctx, job.DuplicateSubscriptionID)
		if err != nil || !found {
			log.Printf("%s: job=%s duplicate=%s reason=persistence_failed stage=reload found=%t err=%v", duplicateResponsibilityAlert, job.ID, job.DuplicateSubscriptionID, found, err)
			continue
		}
		if reasons := duplicateResponsibilityAttention(after, s.Now().Unix()); len(reasons) > 0 {
			log.Printf("%s: job=%s duplicate=%s reason=%s state=%s attempts=%d discovered_at=%d cancel_hold=%s last_error=%q", duplicateResponsibilityAlert, after.ID, after.DuplicateSubscriptionID, strings.Join(reasons, ","), after.State, after.Attempts, after.DiscoveredAt, after.CancelHold, after.LastError)
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

// migrateDuplicateRefundResponsibility adds the discovery-evidence and
// cancellation-hold columns (N-0930-1). Additive with defaults, so an older
// binary keeps reading and writing rows. Existing rows were always written
// after a complete inspection, so their discovered_at is backfilled from
// created_at -- in the SAME migrateOnce transaction as the ALTER, and only when
// this migration added the column, so a crash cannot leave legacy rows unknown
// and a later boot can never mistake a genuine unknown row for a legacy one.
//
// Mixed-version note: rows an OLDER binary inserts after this migration carry
// discovered_at=0 (unknown) until this binary's next complete inspection -- the
// conservative direction. An older binary does not honour cancel_hold or the
// discovered_at terminal gate at all; rollout must not run one alongside this
// binary (see TestN0930_1LegacyBinarySQLIgnoresHoldAndDiscovery).
func migrateDuplicateRefundResponsibility(db *sql.DB) error {
	if err := migrateDuplicateRefundDiscovery(db); err != nil {
		return err
	}
	// post_cancel_inspected: no backfill. 0 on an existing canceled,
	// non-terminal row forces one more inspection that starts after the
	// recorded cancellation -- the conservative direction. Terminal rows are not
	// re-gated unless a new liability reopens them.
	if err := migrateOnce(db, "billing_duplicate_refund_post_cancel_inspection_v1", func(tx *sql.Tx) error {
		exists, err := columnExistsTx(tx, "billing_duplicate_refunds", "post_cancel_inspected")
		if err != nil || exists {
			return err
		}
		_, err = tx.ExecContext(context.Background(), `ALTER TABLE billing_duplicate_refunds ADD COLUMN post_cancel_inspected INTEGER NOT NULL DEFAULT 0`)
		return err
	}); err != nil {
		return err
	}
	// Contradiction counters: 0/0 is "no contradiction ever recorded".
	return migrateOnce(db, "billing_duplicate_refund_cancel_contradiction_v1", func(tx *sql.Tx) error {
		for _, column := range []struct{ name, ddl string }{
			{"cancel_contradictions", `ALTER TABLE billing_duplicate_refunds ADD COLUMN cancel_contradictions INTEGER NOT NULL DEFAULT 0`},
			{"cancel_reconfirmed", `ALTER TABLE billing_duplicate_refunds ADD COLUMN cancel_reconfirmed INTEGER NOT NULL DEFAULT 0`},
		} {
			exists, err := columnExistsTx(tx, "billing_duplicate_refunds", column.name)
			if err != nil {
				return err
			}
			if !exists {
				if _, err := tx.ExecContext(context.Background(), column.ddl); err != nil {
					return err
				}
			}
		}
		return nil
	})
}

func migrateDuplicateRefundDiscovery(db *sql.DB) error {
	return migrateOnce(db, "billing_duplicate_refund_responsibility_v1", func(tx *sql.Tx) error {
		addedDiscovery := false
		for _, column := range []struct{ name, ddl string }{
			{"discovered_at", `ALTER TABLE billing_duplicate_refunds ADD COLUMN discovered_at INTEGER NOT NULL DEFAULT 0`},
			{"cancel_hold", `ALTER TABLE billing_duplicate_refunds ADD COLUMN cancel_hold TEXT NOT NULL DEFAULT ''`},
			{"hold_evidence", `ALTER TABLE billing_duplicate_refunds ADD COLUMN hold_evidence TEXT NOT NULL DEFAULT '[]'`},
		} {
			exists, err := columnExistsTx(tx, "billing_duplicate_refunds", column.name)
			if err != nil {
				return err
			}
			if exists {
				continue
			}
			if _, err := tx.ExecContext(context.Background(), column.ddl); err != nil {
				return err
			}
			if column.name == "discovered_at" {
				addedDiscovery = true
			}
		}
		if addedDiscovery {
			if _, err := tx.ExecContext(context.Background(), `UPDATE billing_duplicate_refunds SET discovered_at=MAX(created_at,1) WHERE discovered_at=0`); err != nil {
				return err
			}
		}
		return nil
	})
}
