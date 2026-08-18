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

type BillingDeletionManualEvidence struct {
	OutboxID, SubjectID, State string
	Generation, CreatedAt      int64
	Resources                  []BillingDeletionResource
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
	p := decodeDeletionProgress(raw)
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
	if err := store.db.QueryRowContext(ctx, `SELECT progress_json,state FROM billing_cancellation_outbox WHERE id=?`, outboxID).Scan(&raw, &state); err != nil {
		return BillingDeletionManualResult{}, err
	}
	p := decodeDeletionProgress(raw)
	r, exists := p.Resources[resourceKey]
	sum := sha256.Sum256([]byte("relayium:billing-deletion-refund:v1\x00" + outboxID + "\x00" + resourceKey))
	actionID := "bdr_" + hex.EncodeToString(sum[:16])
	now := time.Now().Unix()
	var savedActor, savedReason, paymentIntentID, refundID, actionState string
	err := store.db.QueryRowContext(ctx, `SELECT actor,reason,payment_intent_id,refund_id,state FROM billing_deletion_manual_actions WHERE id=?`, actionID).Scan(&savedActor, &savedReason, &paymentIntentID, &refundID, &actionState)
	if err == nil && actionState == "succeeded" {
		if savedActor != strings.TrimSpace(actor) || savedReason != strings.TrimSpace(reason) {
			return BillingDeletionManualResult{}, errors.New("account: refund action actor/reason conflict")
		}
		return BillingDeletionManualResult{ActionID: actionID, RefundID: refundID, Status: "succeeded"}, nil
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return BillingDeletionManualResult{}, err
	}
	if !exists || !r.Manual || r.Terminal || state != "pending" {
		return BillingDeletionManualResult{}, errors.New("account: selected deletion resource is not pending manual reconciliation")
	}
	if _, err := store.db.ExecContext(ctx, `INSERT INTO billing_deletion_manual_actions(id,outbox_id,resource_key,actor,reason,state,created_at,updated_at)
		VALUES(?,?,?,?,?,'prepared',?,?) ON CONFLICT(outbox_id,resource_key) DO NOTHING`, actionID, outboxID, resourceKey, strings.TrimSpace(actor), strings.TrimSpace(reason), now, now); err != nil {
		return BillingDeletionManualResult{}, err
	}
	if err := store.db.QueryRowContext(ctx, `SELECT actor,reason,payment_intent_id,refund_id,state FROM billing_deletion_manual_actions WHERE id=?`, actionID).Scan(&savedActor, &savedReason, &paymentIntentID, &refundID, &actionState); err != nil {
		return BillingDeletionManualResult{}, err
	}
	if savedActor != strings.TrimSpace(actor) || savedReason != strings.TrimSpace(reason) {
		return BillingDeletionManualResult{}, errors.New("account: refund action actor/reason conflict")
	}
	if paymentIntentID == "" {
		var err error
		paymentIntentID, err = c.deletionPaymentIntent(ctx, r)
		if err != nil {
			return BillingDeletionManualResult{}, err
		}
		if _, err := store.db.ExecContext(ctx, `UPDATE billing_deletion_manual_actions SET payment_intent_id=?,updated_at=? WHERE id=? AND state='prepared' AND payment_intent_id=''`, paymentIntentID, now, actionID); err != nil {
			return BillingDeletionManualResult{}, err
		}
	}
	if refundID == "" {
		var err error
		refundID, err = c.findDeletionRefund(ctx, paymentIntentID, actionID)
		if err != nil {
			return BillingDeletionManualResult{}, err
		}
		if refundID == "" {
			form := url.Values{"payment_intent": {paymentIntentID}, "metadata[relayium_deletion_action_id]": {actionID}}
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
		if _, err := store.db.ExecContext(ctx, `UPDATE billing_deletion_manual_actions SET refund_id=?,updated_at=? WHERE id=? AND state='prepared' AND (refund_id='' OR refund_id=?)`, refundID, now, actionID, refundID); err != nil {
			return BillingDeletionManualResult{}, err
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
	if json.Unmarshal(body, &canonical) != nil || canonical.ID != refundID || canonical.Status != "succeeded" || canonical.PaymentIntent != paymentIntentID || canonical.Metadata.ActionID != actionID {
		return BillingDeletionManualResult{}, errors.New("stripe: canonical refund is not safely complete")
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return BillingDeletionManualResult{}, err
	}
	defer tx.Rollback()
	if err := tx.QueryRowContext(ctx, `SELECT progress_json FROM billing_cancellation_outbox WHERE id=? AND state='pending'`, outboxID).Scan(&raw); err != nil {
		return BillingDeletionManualResult{}, err
	}
	p = decodeDeletionProgress(raw)
	r = p.Resources[resourceKey]
	if !r.Manual || r.Terminal {
		return BillingDeletionManualResult{}, errors.New("account: manual resource changed during refund")
	}
	r.Manual, r.Terminal, r.Status = false, true, "refunded"
	p.Resources[resourceKey] = r
	encoded, _ := json.Marshal(p)
	if _, err := tx.ExecContext(ctx, `UPDATE billing_deletion_manual_actions SET state='succeeded',refund_id=?,updated_at=? WHERE id=? AND state='prepared'`, refundID, now, actionID); err != nil {
		return BillingDeletionManualResult{}, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE billing_cancellation_outbox SET progress_json=?,revision=revision+1,updated_at=? WHERE id=? AND state='pending'`, string(encoded), now, outboxID); err != nil {
		return BillingDeletionManualResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return BillingDeletionManualResult{}, err
	}
	return BillingDeletionManualResult{ActionID: actionID, RefundID: refundID, Status: "succeeded"}, nil
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
	}
	if err := json.Unmarshal(body, &obj); err != nil {
		return "", err
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
