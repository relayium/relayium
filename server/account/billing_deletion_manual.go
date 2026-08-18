package account

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

type BillingDeletionManualResult struct {
	ActionID, RefundID, Status string
}

var ErrBillingDeletionRefundReconciliationRequired = errors.New("account: refund reconciliation requires a new operator generation")

// ResolveBillingDeletionMetered is the explicit legacy escape hatch for a
// metered subscription. It deliberately discards pending usage billing during
// account deletion: pending invoice items are removed, cancellation requests
// no final invoice and no proration, and canonical canceled state is required.
func ResolveBillingDeletionMetered(ctx context.Context, store *SQLiteStore, biller Biller, outboxID, resourceKey, actor, reason string) error {
	c, ok := biller.(*stripeClient)
	if !ok || store == nil || outboxID == "" || resourceKey == "" || strings.TrimSpace(actor) == "" || strings.TrimSpace(reason) == "" {
		return errors.New("account: metered deletion operator input is incomplete")
	}
	var raw, state string
	if err := store.db.QueryRowContext(ctx, `SELECT progress_json,state FROM billing_cancellation_outbox WHERE id=?`, outboxID).Scan(&raw, &state); err != nil {
		return err
	}
	p, err := decodeDeletionProgressStrict(raw)
	if err != nil {
		return err
	}
	r, ok := p.Resources[resourceKey]
	if !ok || r.Kind != "subscription" || r.Status != "metered_usage_requires_operator" || state != "pending" {
		return errors.New("account: selected resource is not a pending metered subscription")
	}
	now := time.Now().Unix()
	actionID := "bdm_" + outboxID + "_" + r.ID
	if _, err := store.db.ExecContext(ctx, `INSERT OR IGNORE INTO billing_deletion_metered_actions(id,outbox_id,resource_key,actor,reason,state,created_at,updated_at) VALUES(?,?,?,?,?,'prepared',?,?)`, actionID, outboxID, resourceKey, strings.TrimSpace(actor), strings.TrimSpace(reason), now, now); err != nil {
		return err
	}
	var savedActor, savedReason, actionState string
	if err := store.db.QueryRowContext(ctx, `SELECT actor,reason,state FROM billing_deletion_metered_actions WHERE outbox_id=? AND resource_key=?`, outboxID, resourceKey).Scan(&savedActor, &savedReason, &actionState); err != nil {
		return err
	}
	if savedActor != strings.TrimSpace(actor) || savedReason != strings.TrimSpace(reason) {
		return errors.New("account: metered deletion actor/reason conflict")
	}
	if actionState == "succeeded" {
		return nil
	}
	body, err := c.request(ctx, http.MethodGet, "/v1/subscriptions/"+url.PathEscape(r.ID), nil)
	subGone := stripeDeletionObjectGone(err)
	if err != nil && !subGone {
		return err
	}
	var sub struct {
		ID, Customer, Status string
		Items                struct {
			Data []struct {
				Price struct {
					Recurring *struct {
						UsageType string `json:"usage_type"`
					} `json:"recurring"`
				} `json:"price"`
			} `json:"data"`
		} `json:"items"`
	}
	customerID := r.CustomerID
	subTerminal := subGone
	if !subGone {
		if json.Unmarshal(body, &sub) != nil || sub.ID != r.ID || sub.Customer == "" || (r.CustomerID != "" && r.CustomerID != sub.Customer) {
			return errors.New("stripe: metered subscription canonical identity is invalid")
		}
		customerID = sub.Customer
		subTerminal = sub.Status == "canceled" || sub.Status == "incomplete_expired"
		if !subTerminal {
			if len(sub.Items.Data) == 0 {
				return errors.New("stripe: metered subscription has no canonical items")
			}
			hasMetered := false
			for _, item := range sub.Items.Data {
				if item.Price.Recurring == nil {
					return errors.New("stripe: subscription charge model is unknown")
				}
				if item.Price.Recurring.UsageType == "metered" {
					hasMetered = true
				} else if item.Price.Recurring.UsageType != "licensed" {
					return errors.New("stripe: subscription charge model is unsupported")
				}
			}
			if !hasMetered {
				return errors.New("stripe: operator path requires a metered item")
			}
		}
	}
	customers := appendUnique(append([]string(nil), p.Customers...), customerID)
	for _, candidateCustomer := range customers {
		ids, err := c.deletionList(ctx, "/v1/invoiceitems", url.Values{"customer": {candidateCustomer}, "pending": {"true"}})
		if err != nil {
			return err
		}
		for _, id := range ids {
			if _, err := c.request(ctx, http.MethodDelete, "/v1/invoiceitems/"+url.PathEscape(id), nil); err != nil && !stripeDeletionObjectGone(err) {
				return err
			}
		}
	}
	if !subTerminal {
		form := url.Values{"invoice_now": {"false"}, "prorate": {"false"}}
		if _, err := c.request(ctx, http.MethodDelete, "/v1/subscriptions/"+url.PathEscape(r.ID), form); err != nil && !stripeDeletionObjectGone(err) {
			return err
		}
	}
	body, err = c.request(ctx, http.MethodGet, "/v1/subscriptions/"+url.PathEscape(r.ID), nil)
	if err != nil && !stripeDeletionObjectGone(err) {
		return err
	}
	if err == nil {
		var canonical struct {
			Status string `json:"status"`
		}
		if json.Unmarshal(body, &canonical) != nil || (canonical.Status != "canceled" && canonical.Status != "incomplete_expired") {
			return errors.New("stripe: metered subscription cancellation is not canonical terminal")
		}
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := tx.QueryRowContext(ctx, `SELECT progress_json FROM billing_cancellation_outbox WHERE id=? AND state='pending'`, outboxID).Scan(&raw); err != nil {
		return err
	}
	p, err = decodeDeletionProgressStrict(raw)
	if err != nil {
		return err
	}
	r = p.Resources[resourceKey]
	r.Manual, r.Terminal, r.Status = false, true, "metered_usage_discarded_and_canceled"
	p.Resources[resourceKey] = r
	encoded, _ := json.Marshal(p)
	if _, err := tx.ExecContext(ctx, `UPDATE billing_cancellation_outbox SET progress_json=?,revision=revision+1,updated_at=? WHERE id=? AND state='pending'`, string(encoded), now, outboxID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE billing_deletion_metered_actions SET state='succeeded',updated_at=? WHERE id=?`, now, actionID); err != nil {
		return err
	}
	return tx.Commit()
}

type BillingDeletionManualEvidence struct {
	OutboxID, SubjectID, State string
	Generation, CreatedAt      int64
	Resources                  []BillingDeletionResource
}

// RecordStripeDeletionRefundFailure converts a verified provider failure into
// durable, retryable operator work. It never releases the deletion hold.
func (store *SQLiteStore) RecordStripeDeletionRefundLifecycle(ctx context.Context, eventID, refundID, actionID, paymentIntentID, status string, eventAt int64) error {
	if refundID == "" {
		return nil
	}
	if status == "canceled" {
		status = "failed"
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if eventID != "" {
		if err := insertRefundEventTx(ctx, tx, eventID, refundID, actionID, paymentIntentID, status, eventAt); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO billing_deletion_refund_inbox(refund_id,action_id,payment_intent_id,status,event_at) VALUES(?,?,?,?,?)
 ON CONFLICT(refund_id) DO UPDATE SET action_id=CASE WHEN excluded.action_id<>'' THEN excluded.action_id ELSE action_id END,payment_intent_id=CASE WHEN excluded.payment_intent_id<>'' THEN excluded.payment_intent_id ELSE payment_intent_id END,status=CASE WHEN status='failed' OR excluded.status='failed' THEN 'failed' WHEN excluded.event_at>=event_at THEN excluded.status ELSE status END,event_at=MAX(event_at,excluded.event_at)`, refundID, actionID, paymentIntentID, status, eventAt); err != nil {
		return err
	}
	if status == "failed" {
		if err := recordStripeDeletionRefundFailuresTx(ctx, tx, refundID, actionID, eventAt); err != nil {
			return err
		}
		if _, err := recordDuplicateRefundFailuresTx(ctx, tx, refundID, eventAt); err != nil {
			return err
		}
		return tx.Commit()
	}
	if actionID != "" {
		if _, err := tx.ExecContext(ctx, `UPDATE billing_deletion_manual_actions
 SET refund_id=CASE WHEN refund_id='' OR refund_id=? THEN ? ELSE refund_id END,
     provider_status=?,updated_at=MAX(updated_at,?) WHERE id=? AND state='prepared'`, refundID, refundID, status, eventAt, actionID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (store *SQLiteStore) RecordStripeDeletionRefundFailure(ctx context.Context, refundID, actionID string, failedAt int64) error {
	if refundID == "" && actionID == "" {
		return nil
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := insertRefundEventTx(ctx, tx, fmt.Sprintf("manual:%s:%s:%d", refundID, actionID, failedAt), refundID, actionID, "", "failed", failedAt); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO billing_deletion_refund_inbox(refund_id,action_id,status,event_at) VALUES(?,?,'failed',?)
 ON CONFLICT(refund_id) DO UPDATE SET action_id=CASE WHEN excluded.action_id<>'' THEN excluded.action_id ELSE action_id END,status='failed',event_at=MAX(event_at,excluded.event_at)`, refundID, actionID, failedAt); err != nil {
		return err
	}
	if err := recordStripeDeletionRefundFailuresTx(ctx, tx, refundID, actionID, failedAt); err != nil {
		return err
	}
	return tx.Commit()
}

func insertRefundEventTx(ctx context.Context, tx *sql.Tx, eventID, refundID, actionID, paymentIntentID, status string, eventAt int64) error {
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO billing_deletion_refund_events(event_id,refund_id,action_id,payment_intent_id,status,event_at) VALUES(?,?,?,?,?,?)`, eventID, refundID, actionID, paymentIntentID, status, eventAt); err != nil {
		return err
	}
	var gotRefund, gotAction, gotPI, gotStatus string
	var gotAt int64
	if err := tx.QueryRowContext(ctx, `SELECT refund_id,action_id,payment_intent_id,status,event_at FROM billing_deletion_refund_events WHERE event_id=?`, eventID).Scan(&gotRefund, &gotAction, &gotPI, &gotStatus, &gotAt); err != nil {
		return err
	}
	if gotRefund != refundID || gotAction != actionID || gotPI != paymentIntentID || gotStatus != status || gotAt != eventAt {
		return errors.New("account: refund event identity conflict")
	}
	return nil
}

func recordStripeDeletionRefundFailuresTx(ctx context.Context, tx *sql.Tx, refundID, actionID string, failedAt int64) error {
	rows, err := tx.QueryContext(ctx, `SELECT DISTINCT a.id FROM billing_deletion_manual_actions a WHERE (a.refund_id<>'' AND a.refund_id=?) OR a.id=? OR EXISTS(SELECT 1 FROM billing_deletion_refund_constituents c WHERE c.action_id=a.id AND c.refund_id=? AND c.status='succeeded') ORDER BY a.id`, refundID, actionID, refundID)
	if err != nil {
		return err
	}
	var actions []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		actions = append(actions, id)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, id := range actions {
		if err := recordStripeDeletionRefundActionFailureTx(ctx, tx, refundID, id, failedAt); err != nil {
			return err
		}
	}
	return nil
}

func recordStripeDeletionRefundActionFailureTx(ctx context.Context, tx *sql.Tx, refundID, savedAction string, failedAt int64) error {
	var outboxID, resourceKey, paymentIntentID, actor, reason, actionState, state, raw string
	var generation int64
	err := tx.QueryRowContext(ctx, `SELECT a.outbox_id,a.resource_key,a.payment_intent_id,a.actor,a.reason,a.state,o.state,o.progress_json,a.retry_generation
 FROM billing_deletion_manual_actions a JOIN billing_cancellation_outbox o ON o.id=a.outbox_id
	 WHERE a.id=?`, savedAction).
		Scan(&outboxID, &resourceKey, &paymentIntentID, &actor, &reason, &actionState, &state, &raw, &generation)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE billing_deletion_refund_inbox SET action_id=?,payment_intent_id=? WHERE refund_id=?`, savedAction, paymentIntentID, refundID); err != nil {
		return err
	}
	if refundID == "" {
		return errors.New("account: failed Stripe refund has no refund identity")
	}
	if actionState == "failed" {
		return nil
	}
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO billing_deletion_refund_failures(refund_id,action_id,outbox_id,payment_intent_id,failed_at) VALUES(?,?,?,?,?)`, refundID, savedAction, outboxID, paymentIntentID, failedAt); err != nil {
		return err
	}
	generation++
	sum := sha256.Sum256([]byte("relayium:billing-deletion-refund:v3\x00" + outboxID + "\x00" + paymentIntentID + "\x00" + fmt.Sprint(generation)))
	newAction := "bdr_" + hex.EncodeToString(sum[:16])
	res, err := tx.ExecContext(ctx, `UPDATE billing_deletion_manual_actions SET state='failed',provider_status='failed',updated_at=? WHERE id=? AND state IN ('prepared','succeeded')`, failedAt, savedAction)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return errors.New("account: stale failed refund action")
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO billing_deletion_manual_actions(id,outbox_id,resource_key,actor,reason,payment_intent_id,refund_id,state,retry_generation,provider_status,created_at,updated_at)
 VALUES(?,?,?,?,?,?,'','prepared',?,'',?,?)`, newAction, outboxID, resourceKey, actor, reason, paymentIntentID, generation, failedAt, failedAt); err != nil {
		return err
	}
	hazard := BillingDeletionResource{Kind: "payment_intent", ID: paymentIntentID, PaymentIntentID: paymentIntentID, Status: "refund_failed", Manual: true}
	if state == "terminal" {
		var subject string
		if err := tx.QueryRowContext(ctx, `SELECT billing_subject_id FROM billing_cancellation_outbox WHERE id=?`, outboxID).Scan(&subject); err != nil {
			return err
		}
		handled, err := appendExactStripeCompensationTx(ctx, tx, subject, outboxID, []BillingDeletionResource{hazard})
		if err != nil {
			return err
		}
		if !handled {
			return errors.New("account: failed refund lost its deletion epoch")
		}
		var exactOutboxID string
		if err := tx.QueryRowContext(ctx, `SELECT id FROM billing_cancellation_outbox WHERE parent_outbox_id=? AND mode='exact_compensation' AND state='pending' ORDER BY generation DESC LIMIT 1`, outboxID).Scan(&exactOutboxID); err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `UPDATE billing_deletion_manual_actions SET outbox_id=? WHERE id=? AND outbox_id=? AND state='prepared'`, exactOutboxID, newAction, outboxID)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n != 1 {
			return errors.New("account: failed refund action rebind lost")
		}
		return nil
	}
	p, err := decodeDeletionProgressStrict(raw)
	if err != nil {
		return err
	}
	p.Resources[hazard.Kind+":"+hazard.ID] = hazard
	p.CleanSince = 0
	encoded, err := json.Marshal(p)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE billing_cancellation_outbox SET progress_json=?,revision=revision+1,last_error='provider refund failed',next_attempt_at=0,updated_at=? WHERE id=? AND state='pending'`, string(encoded), failedAt, outboxID); err != nil {
		return err
	}
	var subject string
	if err := tx.QueryRowContext(ctx, `SELECT billing_subject_id FROM billing_cancellation_outbox WHERE id=?`, outboxID).Scan(&subject); err != nil {
		return err
	}
	res, err = tx.ExecContext(ctx, `UPDATE billing_deletion_holds SET subject_released_at=0 WHERE billing_subject_id=?`, subject)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return errors.New("account: failed refund has no durable deletion hold")
	}
	return nil
}

func ListBillingDeletionManualEvidence(ctx context.Context, store *SQLiteStore, outboxID string) (BillingDeletionManualEvidence, error) {
	var out BillingDeletionManualEvidence
	var raw string
	if store == nil || outboxID == "" {
		return out, errors.New("account: cancellation outbox id is required")
	}
	if err := store.db.QueryRowContext(ctx, `SELECT id,billing_subject_id,state,generation,created_at,progress_json FROM billing_cancellation_outbox WHERE id=?`, outboxID).
		Scan(&out.OutboxID, &out.SubjectID, &out.State, &out.Generation, &out.CreatedAt, &raw); err != nil {
		return out, err
	}
	p, err := decodeDeletionProgressStrict(raw)
	if err != nil {
		return out, err
	}
	keys := make([]string, 0, len(p.Resources))
	for key := range p.Resources {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		out.Resources = append(out.Resources, p.Resources[key])
	}
	return out, nil
}

// ResolveBillingDeletionRefund is an explicit operator action. It never guesses
// whether a payment deserves a refund: actor and reason are mandatory, the
// selected journal resource must already be manual, and canonical Stripe Refund
// status must be succeeded before the local hazard becomes terminal.
func ResolveBillingDeletionRefund(ctx context.Context, store *SQLiteStore, biller Biller, outboxID, resourceKey, actor, reason string) (BillingDeletionManualResult, error) {
	c, ok := biller.(*stripeClient)
	if !ok || store == nil {
		return BillingDeletionManualResult{}, errors.New("account: Stripe refund operator is unavailable")
	}
	if outboxID == "" || resourceKey == "" || strings.TrimSpace(actor) == "" || strings.TrimSpace(reason) == "" {
		return BillingDeletionManualResult{}, errors.New("account: outbox, resource, actor, and reason are required")
	}
	var raw, state string
	var outboxRevision int64
	if err := store.db.QueryRowContext(ctx, `SELECT progress_json,state,revision FROM billing_cancellation_outbox WHERE id=?`, outboxID).Scan(&raw, &state, &outboxRevision); err != nil {
		return BillingDeletionManualResult{}, err
	}
	p, err := decodeDeletionProgressStrict(raw)
	if err != nil {
		return BillingDeletionManualResult{}, err
	}
	r, exists := p.Resources[resourceKey]
	if !exists {
		return BillingDeletionManualResult{}, errors.New("account: selected deletion resource does not exist")
	}
	paymentIntentID, err := c.deletionPaymentIntent(ctx, r)
	if err != nil {
		return BillingDeletionManualResult{}, err
	}
	sum := sha256.Sum256([]byte("relayium:billing-deletion-refund:v2\x00" + outboxID + "\x00" + paymentIntentID))
	actionID := "bdr_" + hex.EncodeToString(sum[:16])
	now := time.Now().Unix()
	var savedID, savedActor, savedReason, refundID, actionState, providerStatus, refundProof string
	var retryGeneration int64
	err = store.db.QueryRowContext(ctx, `SELECT id,actor,reason,refund_id,state,retry_generation,provider_status,refund_proof FROM billing_deletion_manual_actions WHERE outbox_id=? AND payment_intent_id=? ORDER BY retry_generation DESC LIMIT 1`, outboxID, paymentIntentID).Scan(&savedID, &savedActor, &savedReason, &refundID, &actionState, &retryGeneration, &providerStatus, &refundProof)
	if errors.Is(err, sql.ErrNoRows) {
		if !r.Manual || r.Terminal || state != "pending" {
			return BillingDeletionManualResult{}, errors.New("account: selected deletion resource is not pending manual reconciliation")
		}
		if _, err := store.db.ExecContext(ctx, `INSERT OR IGNORE INTO billing_deletion_manual_actions(id,outbox_id,resource_key,actor,reason,payment_intent_id,state,created_at,updated_at)
			VALUES(?,?,?,?,?,?,'prepared',?,?)`, actionID, outboxID, resourceKey, strings.TrimSpace(actor), strings.TrimSpace(reason), paymentIntentID, now, now); err != nil {
			return BillingDeletionManualResult{}, err
		}
		err = store.db.QueryRowContext(ctx, `SELECT id,actor,reason,refund_id,state,retry_generation,provider_status,refund_proof FROM billing_deletion_manual_actions WHERE outbox_id=? AND payment_intent_id=? ORDER BY retry_generation DESC LIMIT 1`, outboxID, paymentIntentID).Scan(&savedID, &savedActor, &savedReason, &refundID, &actionState, &retryGeneration, &providerStatus, &refundProof)
	}
	if err != nil {
		return BillingDeletionManualResult{}, err
	}
	actionID = savedID
	savedRefundProof := refundProof
	if savedActor != strings.TrimSpace(actor) || savedReason != strings.TrimSpace(reason) {
		return BillingDeletionManualResult{}, errors.New("account: refund action actor/reason conflict")
	}
	wasSucceeded := actionState == "succeeded"
	if !wasSucceeded && (!r.Manual || r.Terminal || state != "pending") {
		return BillingDeletionManualResult{}, errors.New("account: selected deletion resource is not pending manual reconciliation")
	}
	_, amount, refunded, err := c.deletionRefundTotals(ctx, paymentIntentID)
	if err != nil {
		return BillingDeletionManualResult{}, err
	}
	remaining := amount - refunded
	adoptedExternal := providerStatus == "adopted_external"
	if refundID == "" {
		if remaining <= 0 {
			refundID, refundProof, err = c.canonicalRefundProof(ctx, paymentIntentID, amount, refunded)
			adoptedExternal = true
		} else {
			refundID, err = c.findDeletionRefund(ctx, paymentIntentID, actionID)
		}
		if err != nil {
			return BillingDeletionManualResult{}, err
		}
		if refundID == "" && remaining > 0 {
			form := url.Values{"payment_intent": {paymentIntentID}, "amount": {fmt.Sprint(remaining)}, "metadata[relayium_deletion_action_id]": {actionID}}
			body, err := c.requestKeyed(ctx, http.MethodPost, "/v1/refunds", form, "acct-delete-refund:"+actionID)
			if err != nil {
				return BillingDeletionManualResult{}, err
			}
			var created struct {
				ID string `json:"id"`
			}
			if json.Unmarshal(body, &created) != nil || !strings.HasPrefix(created.ID, "re_") {
				return BillingDeletionManualResult{}, errors.New("stripe: refund response is incomplete")
			}
			refundID = created.ID
		}
		res, err := store.db.ExecContext(ctx, `UPDATE billing_deletion_manual_actions SET refund_id=?,refund_proof=CASE WHEN ?<>'' THEN ? ELSE refund_proof END,provider_status=CASE WHEN ? THEN 'adopted_external' ELSE provider_status END,updated_at=? WHERE id=? AND state='prepared' AND retry_generation=? AND provider_status=? AND (refund_id='' OR refund_id=?)`, refundID, refundProof, refundProof, adoptedExternal, now, actionID, retryGeneration, providerStatus, refundID)
		if err != nil {
			return BillingDeletionManualResult{}, err
		}
		if n, _ := res.RowsAffected(); n != 1 {
			return BillingDeletionManualResult{}, errors.New("account: stale refund action before provider reference bind")
		}
		if adoptedExternal {
			providerStatus = "adopted_external"
		}
	}
	body, err := c.request(ctx, http.MethodGet, "/v1/refunds/"+url.PathEscape(refundID), nil)
	if err != nil {
		return BillingDeletionManualResult{}, err
	}
	var canonical struct {
		ID            string `json:"id"`
		Status        string `json:"status"`
		PaymentIntent string `json:"payment_intent"`
		Metadata      struct {
			ActionID string `json:"relayium_deletion_action_id"`
		} `json:"metadata"`
	}
	if json.Unmarshal(body, &canonical) != nil || canonical.ID != refundID || canonical.Status != "succeeded" || canonical.PaymentIntent != paymentIntentID || (!adoptedExternal && canonical.Metadata.ActionID != actionID) {
		return BillingDeletionManualResult{}, errors.New("stripe: canonical refund is not safely complete")
	}
	_, amount, refunded, err = c.deletionRefundTotals(ctx, paymentIntentID)
	if err != nil || refunded != amount {
		if err != nil {
			return BillingDeletionManualResult{}, err
		}
		return BillingDeletionManualResult{}, errors.New("stripe: canonical payment remains partially unrefunded")
	}
	canonicalRefundID, canonicalProof, err := c.canonicalRefundProof(ctx, paymentIntentID, amount, refunded)
	if err != nil {
		return BillingDeletionManualResult{}, err
	}
	if refundProof != "" && refundProof != canonicalProof {
		return BillingDeletionManualResult{}, errors.New("stripe: canonical refund set changed after audit")
	}
	if adoptedExternal && canonicalRefundID != refundID {
		return BillingDeletionManualResult{}, errors.New("stripe: canonical external refund identity changed")
	}
	refundProof = canonicalProof
	if wasSucceeded {
		if savedRefundProof == "" || savedRefundProof != canonicalProof {
			return BillingDeletionManualResult{}, errors.New("stripe: succeeded refund lacks its durable canonical proof")
		}
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return BillingDeletionManualResult{}, err
	}
	defer tx.Rollback()
	proofSet, err := decodeCanonicalRefundProof(refundProof)
	if err != nil {
		return BillingDeletionManualResult{}, err
	}
	for _, item := range proofSet.Refunds {
		if err := bindRefundConstituentTx(ctx, tx, actionID, outboxID, paymentIntentID, retryGeneration, item.ID, item.Amount, "succeeded"); err != nil {
			return BillingDeletionManualResult{}, err
		}
	}
	for _, item := range proofSet.NonSucceeded {
		if err := bindRefundConstituentTx(ctx, tx, actionID, outboxID, paymentIntentID, retryGeneration, item.ID, item.Amount, item.Status); err != nil {
			return BillingDeletionManualResult{}, err
		}
	}
	var failedRefund string
	if err := tx.QueryRowContext(ctx, `SELECT i.refund_id FROM billing_deletion_refund_inbox i JOIN billing_deletion_refund_constituents c ON c.refund_id=i.refund_id WHERE c.action_id=? AND c.proof_generation=? AND c.status='succeeded' AND i.status='failed' LIMIT 1`, actionID, retryGeneration).Scan(&failedRefund); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return BillingDeletionManualResult{}, err
	} else if err == nil {
		if err := recordStripeDeletionRefundFailuresTx(ctx, tx, failedRefund, "", now); err != nil {
			return BillingDeletionManualResult{}, err
		}
		if err := tx.Commit(); err != nil {
			return BillingDeletionManualResult{}, err
		}
		return BillingDeletionManualResult{}, ErrBillingDeletionRefundReconciliationRequired
	}
	var currentState string
	var currentRevision int64
	if err := tx.QueryRowContext(ctx, `SELECT progress_json,state,revision FROM billing_cancellation_outbox WHERE id=?`, outboxID).Scan(&raw, &currentState, &currentRevision); err != nil {
		return BillingDeletionManualResult{}, err
	}
	if currentRevision != outboxRevision {
		return BillingDeletionManualResult{}, errors.New("account: stale deletion journal during refund finalize")
	}
	if currentState == "terminal" {
		if err := tx.Commit(); err != nil {
			return BillingDeletionManualResult{}, err
		}
		return BillingDeletionManualResult{ActionID: actionID, RefundID: refundID, Status: "succeeded"}, nil
	}
	p, err = decodeDeletionProgressStrict(raw)
	if err != nil {
		return BillingDeletionManualResult{}, err
	}
	r = p.Resources[resourceKey]
	if !wasSucceeded && (!r.Manual || r.Terminal) {
		return BillingDeletionManualResult{}, errors.New("account: manual resource changed during refund")
	}
	r.PaymentIntentID = paymentIntentID
	p.Resources[resourceKey] = r
	invoiceIDs := map[string]bool{}
	for _, item := range p.Resources {
		if item.PaymentIntentID == paymentIntentID {
			if item.InvoiceID != "" {
				invoiceIDs[item.InvoiceID] = true
			}
			if item.Kind == "invoice" {
				invoiceIDs[item.ID] = true
			}
		}
	}
	for key, item := range p.Resources {
		if key == resourceKey || item.PaymentIntentID == paymentIntentID || (item.Kind == "payment_intent" && item.ID == paymentIntentID) || (item.Kind == "checkout_session" && item.InvoiceID != "" && invoiceIDs[item.InvoiceID]) {
			item.PaymentIntentID = paymentIntentID
			item.Manual, item.Terminal, item.Status = false, true, "refunded"
			p.Resources[key] = item
		}
	}
	encoded, _ := json.Marshal(p)
	if !wasSucceeded {
		res, err := tx.ExecContext(ctx, `UPDATE billing_deletion_manual_actions SET state='succeeded',refund_id=?,refund_proof=?,provider_status=CASE WHEN provider_status='' THEN 'succeeded' ELSE provider_status END,updated_at=? WHERE id=? AND state='prepared' AND refund_id=? AND retry_generation=? AND provider_status=?`, refundID, refundProof, now, actionID, refundID, retryGeneration, providerStatus)
		if err != nil {
			return BillingDeletionManualResult{}, err
		}
		if n, _ := res.RowsAffected(); n != 1 {
			return BillingDeletionManualResult{}, errors.New("account: stale refund action during finalize")
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE billing_deletion_refund_inbox SET processed_at=? WHERE refund_id IN (SELECT refund_id FROM billing_deletion_refund_constituents WHERE action_id=? AND proof_generation=?)`, now, actionID, retryGeneration); err != nil {
		return BillingDeletionManualResult{}, err
	}
	res, err := tx.ExecContext(ctx, `UPDATE billing_cancellation_outbox SET progress_json=?,revision=revision+1,updated_at=? WHERE id=? AND state='pending' AND revision=?`, string(encoded), now, outboxID, outboxRevision)
	if err != nil {
		return BillingDeletionManualResult{}, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return BillingDeletionManualResult{}, errors.New("account: stale deletion journal during refund finalize")
	}
	if err := tx.Commit(); err != nil {
		return BillingDeletionManualResult{}, err
	}
	return BillingDeletionManualResult{ActionID: actionID, RefundID: refundID, Status: "succeeded"}, nil
}

func bindRefundConstituentTx(ctx context.Context, tx *sql.Tx, actionID, outboxID, paymentIntentID string, generation int64, refundID string, amount int64, status string) error {
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO billing_deletion_refund_constituents(action_id,outbox_id,payment_intent_id,proof_generation,refund_id,amount,status) VALUES(?,?,?,?,?,?,?)`, actionID, outboxID, paymentIntentID, generation, refundID, amount, status); err != nil {
		return err
	}
	var gotOutbox, gotPI, gotStatus string
	var gotAmount int64
	if err := tx.QueryRowContext(ctx, `SELECT outbox_id,payment_intent_id,amount,status FROM billing_deletion_refund_constituents WHERE action_id=? AND proof_generation=? AND refund_id=?`, actionID, generation, refundID).Scan(&gotOutbox, &gotPI, &gotAmount, &gotStatus); err != nil {
		return err
	}
	if gotOutbox != outboxID || gotPI != paymentIntentID || gotAmount != amount || gotStatus != status {
		return errors.New("account: refund constituent ownership conflict")
	}
	return nil
}

func (c *stripeClient) deletionRefundTotals(ctx context.Context, paymentIntentID string) (string, int64, int64, error) {
	body, err := c.request(ctx, http.MethodGet, "/v1/payment_intents/"+url.PathEscape(paymentIntentID), nil)
	if err != nil {
		return "", 0, 0, err
	}
	var pi struct {
		LatestCharge string `json:"latest_charge"`
	}
	if json.Unmarshal(body, &pi) != nil || !strings.HasPrefix(pi.LatestCharge, "ch_") {
		return "", 0, 0, errors.New("stripe: payment intent latest charge is unavailable")
	}
	body, err = c.request(ctx, http.MethodGet, "/v1/charges/"+url.PathEscape(pi.LatestCharge), nil)
	if err != nil {
		return "", 0, 0, err
	}
	var charge struct {
		ID             string `json:"id"`
		PaymentIntent  string `json:"payment_intent"`
		Amount         int64  `json:"amount"`
		AmountRefunded int64  `json:"amount_refunded"`
		Refunded       bool   `json:"refunded"`
	}
	if err := json.Unmarshal(body, &charge); err != nil {
		return "", 0, 0, err
	}
	if charge.ID != pi.LatestCharge || charge.PaymentIntent != paymentIntentID || charge.Amount <= 0 || charge.AmountRefunded < 0 || charge.AmountRefunded > charge.Amount || (charge.Refunded && charge.AmountRefunded != charge.Amount) {
		return "", 0, 0, errors.New("stripe: canonical charge refund totals are invalid")
	}
	return charge.ID, charge.Amount, charge.AmountRefunded, nil
}

func (c *stripeClient) deletionPaymentIntent(ctx context.Context, r BillingDeletionResource) (string, error) {
	if r.Kind == "invoice" || r.Kind == "checkout_session" || r.InvoiceID != "" {
		invoiceID := r.InvoiceID
		if r.Kind == "invoice" {
			invoiceID = r.ID
		}
		if r.Kind == "checkout_session" {
			body, err := c.request(ctx, http.MethodGet, "/v1/checkout/sessions/"+url.PathEscape(r.ID), nil)
			if err != nil {
				return "", err
			}
			var session struct{ Invoice, Customer, Subscription string }
			if json.Unmarshal(body, &session) != nil || session.Invoice == "" || (r.CustomerID != "" && session.Customer != r.CustomerID) {
				return "", errors.New("stripe: checkout invoice identity is unavailable")
			}
			invoiceID = session.Invoice
		}
		invoice, err := c.canonicalInvoicePayments(ctx, invoiceID, r.CustomerID, "", true)
		if err != nil {
			return "", err
		}
		if !invoiceHasOneExclusivePaymentIntent(invoice) {
			return "", errors.New("stripe: invoice has multiple, shared, or unsupported payment constituents")
		}
		if r.PaymentIntentID != "" && r.PaymentIntentID != invoice.Payments[0].PaymentIntentID {
			return "", errors.New("stripe: deletion payment intent changed")
		}
		return invoice.Payments[0].PaymentIntentID, nil
	}
	if r.Kind == "payment_intent" && strings.HasPrefix(r.ID, "pi_") {
		return "", errors.New("stripe: payment intent lacks canonical invoice allocation")
	}
	if r.Kind == "charge" {
		return "", errors.New("stripe: charge lacks canonical invoice allocation")
	}
	return "", fmt.Errorf("account: %s is not a refundable deletion resource", r.Kind)
}

func (c *stripeClient) findDeletionRefund(ctx context.Context, paymentIntentID, actionID string) (string, error) {
	query := url.Values{"payment_intent": {paymentIntentID}, "limit": {"100"}}
	for {
		body, err := c.request(ctx, http.MethodGet, "/v1/refunds?"+query.Encode(), nil)
		if err != nil {
			return "", err
		}
		var list struct {
			Data []struct {
				ID       string `json:"id"`
				Metadata struct {
					ActionID string `json:"relayium_deletion_action_id"`
				} `json:"metadata"`
			} `json:"data"`
			HasMore bool `json:"has_more"`
		}
		if err := json.Unmarshal(body, &list); err != nil {
			return "", err
		}
		for _, r := range list.Data {
			if r.Metadata.ActionID == actionID {
				return r.ID, nil
			}
		}
		if !list.HasMore || len(list.Data) == 0 {
			return "", nil
		}
		query.Set("starting_after", list.Data[len(list.Data)-1].ID)
	}
}

type canonicalDeletionRefund struct {
	ID     string `json:"id"`
	Amount int64  `json:"amount"`
}

type canonicalDeletionRefundObservation struct {
	ID     string `json:"id"`
	Status string `json:"status"`
	Amount int64  `json:"amount,omitempty"`
}

type canonicalRefundProofWire struct {
	Digest       string                               `json:"digest"`
	Refunds      []canonicalDeletionRefund            `json:"refunds"`
	NonSucceeded []canonicalDeletionRefundObservation `json:"nonSucceeded,omitempty"`
}

func decodeCanonicalRefundProof(raw string) (canonicalRefundProofWire, error) {
	var proof canonicalRefundProofWire
	if json.Unmarshal([]byte(raw), &proof) != nil || proof.Digest == "" || len(proof.Refunds) == 0 {
		return proof, errors.New("account: invalid canonical refund proof")
	}
	payload, _ := json.Marshal(struct {
		Refunds      []canonicalDeletionRefund            `json:"refunds"`
		NonSucceeded []canonicalDeletionRefundObservation `json:"nonSucceeded,omitempty"`
	}{proof.Refunds, proof.NonSucceeded})
	digest := sha256.Sum256(payload)
	if proof.Digest != hex.EncodeToString(digest[:]) {
		return proof, errors.New("account: canonical refund proof digest mismatch")
	}
	return proof, nil
}

func (c *stripeClient) canonicalRefundProof(ctx context.Context, paymentIntentID string, chargeAmount, amountRefunded int64) (string, string, error) {
	if chargeAmount <= 0 || amountRefunded != chargeAmount {
		return "", "", errors.New("stripe: payment is not canonically fully refunded")
	}
	query := url.Values{"payment_intent": {paymentIntentID}, "limit": {"100"}}
	var refunds []canonicalDeletionRefund
	var nonSucceeded []canonicalDeletionRefundObservation
	seen := map[string]bool{}
	for {
		body, err := c.request(ctx, http.MethodGet, "/v1/refunds?"+query.Encode(), nil)
		if err != nil {
			return "", "", err
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
		if err := json.Unmarshal(body, &page); err != nil {
			return "", "", err
		}
		for _, item := range page.Data {
			if !strings.HasPrefix(item.ID, "re_") || seen[item.ID] || item.PaymentIntent != paymentIntentID {
				return "", "", errors.New("stripe: canonical refund list is invalid")
			}
			seen[item.ID] = true
			switch item.Status {
			case "succeeded":
				if item.Amount <= 0 {
					return "", "", errors.New("stripe: canonical succeeded refund amount is missing")
				}
				refunds = append(refunds, canonicalDeletionRefund{ID: item.ID, Amount: item.Amount})
			case "failed", "canceled":
				if item.Amount <= 0 {
					return "", "", errors.New("stripe: canonical refund audit amount is missing")
				}
				nonSucceeded = append(nonSucceeded, canonicalDeletionRefundObservation{item.ID, item.Status, item.Amount})
			default:
				return "", "", errors.New("stripe: canonical refund remains pending")
			}
		}
		if !page.HasMore {
			break
		}
		if len(page.Data) == 0 {
			return "", "", errors.New("stripe: refund pagination made no progress")
		}
		query.Set("starting_after", page.Data[len(page.Data)-1].ID)
	}
	if len(refunds) == 0 {
		return "", "", errors.New("stripe: canonical full refund set is empty")
	}
	sort.Slice(refunds, func(i, j int) bool { return refunds[i].ID < refunds[j].ID })
	sort.Slice(nonSucceeded, func(i, j int) bool { return nonSucceeded[i].ID < nonSucceeded[j].ID })
	var total int64
	for _, expected := range refunds {
		body, err := c.request(ctx, http.MethodGet, "/v1/refunds/"+url.PathEscape(expected.ID), nil)
		if err != nil {
			return "", "", err
		}
		var item struct {
			ID            string `json:"id"`
			Status        string `json:"status"`
			PaymentIntent string `json:"payment_intent"`
			Amount        int64  `json:"amount"`
		}
		if json.Unmarshal(body, &item) != nil || item.ID != expected.ID || item.Status != "succeeded" || item.PaymentIntent != paymentIntentID || item.Amount != expected.Amount {
			return "", "", errors.New("stripe: canonical refund detail does not match refund list")
		}
		total += item.Amount
	}
	if total != amountRefunded || total != chargeAmount {
		return "", "", errors.New("stripe: canonical refund amounts do not equal the charge")
	}
	payload, _ := json.Marshal(struct {
		Refunds      []canonicalDeletionRefund            `json:"refunds"`
		NonSucceeded []canonicalDeletionRefundObservation `json:"nonSucceeded,omitempty"`
	}{refunds, nonSucceeded})
	digest := sha256.Sum256(payload)
	proof, _ := json.Marshal(canonicalRefundProofWire{hex.EncodeToString(digest[:]), refunds, nonSucceeded})
	return refunds[0].ID, string(proof), nil
}
