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
func (store *SQLiteStore) RecordStripeDeletionRefundLifecycle(ctx context.Context, refundID, actionID, status string, eventAt int64) error {
	if status == "failed" {
		return store.RecordStripeDeletionRefundFailure(ctx, refundID, actionID, eventAt)
	}
	if refundID == "" || actionID == "" {
		return nil
	}
	_, err := store.db.ExecContext(ctx, `UPDATE billing_deletion_manual_actions
 SET refund_id=CASE WHEN refund_id='' OR refund_id=? THEN ? ELSE refund_id END,
     provider_status=?,updated_at=MAX(updated_at,?)
 WHERE id=? AND state='prepared'`, refundID, refundID, status, eventAt, actionID)
	return err
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
	var savedAction, outboxID, resourceKey, paymentIntentID, actor, reason, actionState, state, raw string
	var generation int64
	err = tx.QueryRowContext(ctx, `SELECT a.id,a.outbox_id,a.resource_key,a.payment_intent_id,a.actor,a.reason,a.state,o.state,o.progress_json,a.retry_generation
 FROM billing_deletion_manual_actions a JOIN billing_cancellation_outbox o ON o.id=a.outbox_id
 WHERE (a.refund_id<>'' AND a.refund_id=?) OR (a.id=?) LIMIT 1`, refundID, actionID).
		Scan(&savedAction, &outboxID, &resourceKey, &paymentIntentID, &actor, &reason, &actionState, &state, &raw, &generation)
	if errors.Is(err, sql.ErrNoRows) {
		return tx.Commit()
	}
	if err != nil {
		return err
	}
	if refundID == "" {
		return errors.New("account: failed Stripe refund has no refund identity")
	}
	if actionState == "failed" {
		return tx.Commit()
	}
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO billing_deletion_refund_failures(refund_id,action_id,outbox_id,payment_intent_id,failed_at) VALUES(?,?,?,?,?)`, refundID, savedAction, outboxID, paymentIntentID, failedAt); err != nil {
		return err
	}
	generation++
	sum := sha256.Sum256([]byte("relayium:billing-deletion-refund:v3\x00" + outboxID + "\x00" + paymentIntentID + "\x00" + fmt.Sprint(generation)))
	newAction := "bdr_" + hex.EncodeToString(sum[:16])
	res, err := tx.ExecContext(ctx, `UPDATE billing_deletion_manual_actions SET state='failed',provider_status='failed',updated_at=? WHERE id=? AND refund_id=? AND state IN ('prepared','succeeded')`, failedAt, savedAction, refundID)
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
		if err := appendStripeDeletionHazardsTx(ctx, tx, subject, []BillingDeletionResource{hazard}); err != nil {
			return err
		}
		return tx.Commit()
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
	if _, err := tx.ExecContext(ctx, `UPDATE billing_deletion_holds SET subject_released_at=0 WHERE billing_subject_id=?`, subject); err != nil {
		return err
	}
	return tx.Commit()
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
	paymentIntentID := r.PaymentIntentID
	if paymentIntentID == "" {
		var err error
		paymentIntentID, err = c.deletionPaymentIntent(ctx, r)
		if err != nil {
			return BillingDeletionManualResult{}, err
		}
	}
	sum := sha256.Sum256([]byte("relayium:billing-deletion-refund:v2\x00" + outboxID + "\x00" + paymentIntentID))
	actionID := "bdr_" + hex.EncodeToString(sum[:16])
	now := time.Now().Unix()
	var savedID, savedActor, savedReason, refundID, actionState, providerStatus string
	var retryGeneration int64
	err = store.db.QueryRowContext(ctx, `SELECT id,actor,reason,refund_id,state,retry_generation,provider_status FROM billing_deletion_manual_actions WHERE outbox_id=? AND payment_intent_id=? ORDER BY retry_generation DESC LIMIT 1`, outboxID, paymentIntentID).Scan(&savedID, &savedActor, &savedReason, &refundID, &actionState, &retryGeneration, &providerStatus)
	if errors.Is(err, sql.ErrNoRows) {
		if !r.Manual || r.Terminal || state != "pending" {
			return BillingDeletionManualResult{}, errors.New("account: selected deletion resource is not pending manual reconciliation")
		}
		if _, err := store.db.ExecContext(ctx, `INSERT OR IGNORE INTO billing_deletion_manual_actions(id,outbox_id,resource_key,actor,reason,payment_intent_id,state,created_at,updated_at)
			VALUES(?,?,?,?,?,?,'prepared',?,?)`, actionID, outboxID, resourceKey, strings.TrimSpace(actor), strings.TrimSpace(reason), paymentIntentID, now, now); err != nil {
			return BillingDeletionManualResult{}, err
		}
		err = store.db.QueryRowContext(ctx, `SELECT id,actor,reason,refund_id,state,retry_generation,provider_status FROM billing_deletion_manual_actions WHERE outbox_id=? AND payment_intent_id=? ORDER BY retry_generation DESC LIMIT 1`, outboxID, paymentIntentID).Scan(&savedID, &savedActor, &savedReason, &refundID, &actionState, &retryGeneration, &providerStatus)
	}
	if err != nil {
		return BillingDeletionManualResult{}, err
	}
	actionID = savedID
	if savedActor != strings.TrimSpace(actor) || savedReason != strings.TrimSpace(reason) {
		return BillingDeletionManualResult{}, errors.New("account: refund action actor/reason conflict")
	}
	wasSucceeded := actionState == "succeeded"
	if !wasSucceeded && (!r.Manual || r.Terminal || state != "pending") {
		return BillingDeletionManualResult{}, errors.New("account: selected deletion resource is not pending manual reconciliation")
	}
	_, remaining, err := c.deletionRefundRemaining(ctx, paymentIntentID)
	if err != nil {
		return BillingDeletionManualResult{}, err
	}
	adoptedExternal := providerStatus == "adopted_external"
	if refundID == "" {
		if remaining <= 0 {
			refundID, err = c.findCanonicalFullRefund(ctx, paymentIntentID)
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
		res, err := store.db.ExecContext(ctx, `UPDATE billing_deletion_manual_actions SET refund_id=?,provider_status=CASE WHEN ? THEN 'adopted_external' ELSE provider_status END,updated_at=? WHERE id=? AND state='prepared' AND retry_generation=? AND provider_status=? AND (refund_id='' OR refund_id=?)`, refundID, adoptedExternal, now, actionID, retryGeneration, providerStatus, refundID)
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
	if _, remaining, err = c.deletionRefundRemaining(ctx, paymentIntentID); err != nil || remaining != 0 {
		if err != nil {
			return BillingDeletionManualResult{}, err
		}
		return BillingDeletionManualResult{}, errors.New("stripe: canonical payment remains partially unrefunded")
	}
	if wasSucceeded {
		return BillingDeletionManualResult{ActionID: actionID, RefundID: refundID, Status: "succeeded"}, nil
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return BillingDeletionManualResult{}, err
	}
	defer tx.Rollback()
	if err := tx.QueryRowContext(ctx, `SELECT progress_json FROM billing_cancellation_outbox WHERE id=? AND state='pending' AND revision=?`, outboxID, outboxRevision).Scan(&raw); err != nil {
		return BillingDeletionManualResult{}, err
	}
	p, err = decodeDeletionProgressStrict(raw)
	if err != nil {
		return BillingDeletionManualResult{}, err
	}
	r = p.Resources[resourceKey]
	if !r.Manual || r.Terminal {
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
	res, err := tx.ExecContext(ctx, `UPDATE billing_deletion_manual_actions SET state='succeeded',refund_id=?,provider_status=CASE WHEN provider_status='' THEN 'succeeded' ELSE provider_status END,updated_at=? WHERE id=? AND state='prepared' AND refund_id=? AND retry_generation=? AND provider_status=?`, refundID, now, actionID, refundID, retryGeneration, providerStatus)
	if err != nil {
		return BillingDeletionManualResult{}, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return BillingDeletionManualResult{}, errors.New("account: stale refund action during finalize")
	}
	res, err = tx.ExecContext(ctx, `UPDATE billing_cancellation_outbox SET progress_json=?,revision=revision+1,updated_at=? WHERE id=? AND state='pending' AND revision=?`, string(encoded), now, outboxID, outboxRevision)
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

func (c *stripeClient) deletionRefundRemaining(ctx context.Context, paymentIntentID string) (string, int64, error) {
	body, err := c.request(ctx, http.MethodGet, "/v1/payment_intents/"+url.PathEscape(paymentIntentID), nil)
	if err != nil {
		return "", 0, err
	}
	var pi struct {
		LatestCharge string `json:"latest_charge"`
	}
	if json.Unmarshal(body, &pi) != nil || !strings.HasPrefix(pi.LatestCharge, "ch_") {
		return "", 0, errors.New("stripe: payment intent latest charge is unavailable")
	}
	body, err = c.request(ctx, http.MethodGet, "/v1/charges/"+url.PathEscape(pi.LatestCharge), nil)
	if err != nil {
		return "", 0, err
	}
	var charge struct {
		ID             string `json:"id"`
		PaymentIntent  string `json:"payment_intent"`
		Amount         int64  `json:"amount"`
		AmountRefunded int64  `json:"amount_refunded"`
		Refunded       bool   `json:"refunded"`
	}
	if err := json.Unmarshal(body, &charge); err != nil {
		return "", 0, err
	}
	if charge.ID != pi.LatestCharge || charge.PaymentIntent != paymentIntentID || charge.Amount <= 0 || charge.AmountRefunded < 0 || charge.AmountRefunded > charge.Amount || (charge.Refunded && charge.AmountRefunded != charge.Amount) {
		return "", 0, errors.New("stripe: canonical charge refund totals are invalid")
	}
	return charge.ID, charge.Amount - charge.AmountRefunded, nil
}

func (c *stripeClient) deletionPaymentIntent(ctx context.Context, r BillingDeletionResource) (string, error) {
	if r.Kind == "payment_intent" && strings.HasPrefix(r.ID, "pi_") {
		return r.ID, nil
	}
	path := ""
	if r.Kind == "checkout_session" {
		path = "/v1/checkout/sessions/" + url.PathEscape(r.ID)
	} else if r.Kind == "invoice" {
		path = "/v1/invoices/" + url.PathEscape(r.ID)
	} else if r.Kind == "charge" {
		path = "/v1/charges/" + url.PathEscape(r.ID)
	} else {
		return "", fmt.Errorf("account: %s is not a refundable deletion resource", r.Kind)
	}
	body, err := c.request(ctx, http.MethodGet, path, nil)
	if err != nil {
		return "", err
	}
	var obj struct {
		PaymentIntent string `json:"payment_intent"`
		Invoice       string `json:"invoice"`
		Customer      string `json:"customer"`
		Subscription  string `json:"subscription"`
	}
	if err := json.Unmarshal(body, &obj); err != nil {
		return "", err
	}
	if obj.PaymentIntent == "" && obj.Invoice == "" && obj.Subscription != "" {
		obj.Invoice, err = c.latestInvoiceID(ctx, obj.Subscription)
		if err != nil {
			return "", err
		}
	}
	if obj.PaymentIntent == "" && obj.Invoice != "" {
		body, err = c.request(ctx, http.MethodGet, "/v1/invoices/"+url.PathEscape(obj.Invoice), nil)
		if err != nil {
			return "", err
		}
		if err := json.Unmarshal(body, &obj); err != nil {
			return "", err
		}
	}
	if !strings.HasPrefix(obj.PaymentIntent, "pi_") {
		return "", errors.New("stripe: refundable payment intent is unavailable")
	}
	if r.CustomerID != "" && obj.Customer != "" && obj.Customer != r.CustomerID {
		return "", errors.New("stripe: refundable object customer mismatch")
	}
	return obj.PaymentIntent, nil
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

func (c *stripeClient) findCanonicalFullRefund(ctx context.Context, paymentIntentID string) (string, error) {
	body, err := c.request(ctx, http.MethodGet, "/v1/refunds?"+url.Values{"payment_intent": {paymentIntentID}, "limit": {"100"}}.Encode(), nil)
	if err != nil {
		return "", err
	}
	var list struct {
		Data []struct {
			ID            string `json:"id"`
			Status        string `json:"status"`
			PaymentIntent string `json:"payment_intent"`
		} `json:"data"`
		HasMore bool `json:"has_more"`
	}
	if json.Unmarshal(body, &list) != nil || list.HasMore || len(list.Data) != 1 || list.Data[0].Status != "succeeded" || list.Data[0].PaymentIntent != paymentIntentID {
		return "", errors.New("stripe: fully refunded payment lacks one unambiguous canonical refund")
	}
	return list.Data[0].ID, nil
}
