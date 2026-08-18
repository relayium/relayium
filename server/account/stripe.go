package account

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// stripeAPIVersion is the audited server-side REST contract. Pinning every
// request prevents account deletion and subscription logic from silently
// switching object shapes when Stripe changes an account default version.
const stripeAPIVersion = "2026-06-24.dahlia"

// Biller abstracts Stripe so handlers/tests never touch the network directly.
// A thin hand-rolled client (stripeClient) is the only implementation; nil
// means billing is unconfigured (RELAYIUM_STRIPE_SECRET_KEY empty).
type Biller interface {
	// EnsureCustomer returns a Stripe customer id for the user, creating one
	// idempotently (keyed on userID) so concurrent first-time checkouts collapse
	// to a single customer instead of minting one each.
	EnsureCustomer(ctx context.Context, email, userID string) (customerID string, err error)
	// ListActiveSubscriptions returns a customer's active/trialing subscriptions,
	// so the webhook can detect a double-checkout (>1) and keep the earliest.
	ListActiveSubscriptions(ctx context.Context, customerID string) ([]SubscriptionInfo, error)
	// CancelSubscription cancels a subscription immediately; refund=true also fully
	// refunds its latest invoice. Used to reap a duplicate subscription.
	CancelSubscription(ctx context.Context, subID string, refund bool) error
	CreateCheckoutSession(ctx context.Context, in CheckoutInput) (CheckoutSession, error)
	CreatePortalSession(ctx context.Context, customerID, returnURL string) (url string, err error)
	// ChangeSubscriptionPlan switches the customer's existing active subscription
	// to newPriceID in place, immediately and prorated — used for UPGRADES, where
	// the customer wants the higher tier now and is charged the difference. The
	// resulting customer.subscription.updated webhook reassigns the plan (by price).
	ChangeSubscriptionPlan(ctx context.Context, customerID, newPriceID string) error
	// ScheduleDowngrade switches the subscription to newPriceID at the END of the
	// current billing period (not now), via a subscription schedule — used for
	// DOWNGRADES, so the customer keeps the tier they already paid for until it
	// lapses, with no refund and no proration credit. The plan_id only changes
	// when the phase transition fires customer.subscription.updated at period end.
	ScheduleDowngrade(ctx context.Context, customerID, newPriceID string) error
	// ReleaseSchedule cancels any pending subscription schedule (e.g. a scheduled
	// downgrade), detaching it so the subscription continues on its CURRENT price.
	// No-op when the subscription has no schedule. Used to cancel a pending
	// downgrade and to clear the way before another in-app plan change.
	ReleaseSchedule(ctx context.Context, customerID string) error
	// PreviewChange projects what switching the customer's live subscription to
	// newPriceID would do right now, via a Stripe upcoming-invoice preview with
	// the same always_invoice proration the real change uses. Used by the
	// confirmation modal so the operator sees the real numbers AND the real
	// post-change renewal date before committing.
	PreviewChange(ctx context.Context, customerID, newPriceID string) (ChangePreview, error)
	VerifyWebhook(payload []byte, sigHeader string, now int64) (WebhookEvent, error)
}

// ChangePreview is Stripe's projection of an immediate plan change, as read from
// the proration preview invoice.
//
// AmountDueCents and TotalCents are deliberately BOTH here, because they answer
// different questions and only one of them can be negative. Stripe floors
// amount_due at zero: when a change nets out in the customer's favour the
// invoice total goes negative and the difference lands on their customer balance
// instead of being charged. Reporting amount_due alone therefore renders a real
// credit as "$0.00 due now", which reads as "this change costs nothing" when the
// truth is "you are owed money". Callers must render the signed total, not just
// the charge.
type ChangePreview struct {
	// AmountDueCents is invoice.amount_due — what the card is actually charged
	// now. Never negative.
	AmountDueCents int64
	// TotalCents is invoice.total, the SIGNED proration adjustment: positive is a
	// charge, negative is a credit applied to the customer's Stripe balance.
	TotalCents int64
	// PeriodEnd is the post-change renewal date (unix secs) projected from the
	// preview invoice's line periods — the date the subscription next bills once
	// this change is applied. This is NOT necessarily the current
	// users.subscription_end: switching to a price with a different interval
	// resets the billing anchor, so an upgrade from monthly to yearly renews a
	// year out, not at the old monthly boundary. 0 when Stripe's preview carries
	// no usable period, which the caller must treat as "unknown" rather than as
	// an epoch date.
	PeriodEnd int64
}

// CheckoutInput describes a subscription-mode Checkout Session to create.
// Exactly one of CustomerID / CustomerEmail should be set: CustomerID reuses
// an existing Stripe customer, CustomerEmail lets Stripe create one (and the
// webhook binds it back via ClientRefUserID).
type CheckoutInput struct {
	PriceID, CustomerID, CustomerEmail, ClientRefUserID, BillingAttemptID, SuccessURL, CancelURL, IdempotencyKey string
}

type CheckoutSession struct {
	ID  string
	URL string
}

// WebhookEvent is the minimal projection of a verified Stripe event that
// handlers act on. See VerifyWebhook's doc comment for how each field is
// populated per event type — in particular PriceID is empty on
// checkout.session.completed (the plan is assigned by the subsequent
// customer.subscription.* event Stripe always sends).
type WebhookEvent struct {
	EventID                                     string
	Type                                        string // "checkout.session.completed" | "customer.subscription.updated" | "customer.subscription.deleted" | ...
	CustomerID, SubscriptionID, PriceID, Status string
	ClientRefUserID                             string
	// MetadataUserID is data.object.metadata.user_id, present on
	// customer.subscription.* events because CreateCheckoutSession sets
	// subscription_data[metadata][user_id] at checkout time. It lets the
	// handler bind customer->user itself when a subscription event arrives
	// before (or without) the checkout.session.completed event that normally
	// does the binding — Stripe does not guarantee delivery order. Empty when
	// metadata is absent (e.g. checkout.session.completed itself).
	MetadataUserID, MetadataBillingAttemptID, MetadataDeletionActionID     string
	CheckoutSessionID, InvoiceID, PaymentIntentID, ChargeID, PaymentStatus string
	RefundID                                                               string
	CurrentPeriodEnd                                                       int64
	// Created is the Stripe event's top-level `created` (unix secs) — the event
	// emission time, used by the webhook's ordering guard to drop a stale
	// (re)delivered event that would otherwise revert newer subscription state.
	// Stripe does not guarantee delivery order and retries 500'd events for days.
	Created int64
	// LiveMode is the event's top-level `livemode`. The webhook rejects any event
	// whose mode doesn't match the configured key (see wantLive), so a test-mode
	// event can never assign a real plan on a live deployment and vice versa.
	LiveMode bool
}

// ErrWebhookWrongMode is returned by VerifyWebhook for a correctly-signed event
// whose livemode does not match the configured Stripe key (test vs live). The
// handler ACKs it (200) so Stripe stops retrying, but takes no action.
var ErrWebhookWrongMode = errors.New("stripe webhook: livemode does not match configured key")

// stripeClient is the real Biller: a thin hand-rolled HTTP client making
// form-POSTs to api.stripe.com (no SDK dependency — see spec rationale).
type stripeClient struct {
	secretKey     string
	webhookSecret string
	portalConfig  string
	http          *http.Client
	base          string
	// wantLive is the mode the configured secret key implies (sk_live_* => true).
	// VerifyWebhook rejects any event whose livemode differs, so a stray test-mode
	// event can't be processed by a live deployment (or vice versa).
	wantLive bool
	// idemRetryDelay is the base backoff before re-issuing a request whose
	// Idempotency-Key Stripe reports as still in flight (see requestIdempotent).
	// A field rather than a constant only so tests don't have to sleep.
	idemRetryDelay          time.Duration
	canonicalWebhookRefresh bool
	now                     func() time.Time
}

// NewStripeClient builds the real Biller. secretKey/webhookSecret/portalConfig
// come from RELAYIUM_STRIPE_{SECRET_KEY,WEBHOOK_SECRET,PORTAL_CONFIG}. Portal
// creation fails closed when its dedicated configuration is absent.
func NewStripeClient(secretKey, webhookSecret, portalConfig string) *stripeClient {
	return &stripeClient{
		secretKey:     secretKey,
		webhookSecret: webhookSecret,
		portalConfig:  portalConfig,
		wantLive:      strings.HasPrefix(secretKey, "sk_live_"),
		// These are quick, non-streaming REST calls (unlike blob transfers
		// elsewhere in this package), so a total timeout is safe and desirable.
		http:                    &http.Client{Timeout: 20 * time.Second},
		base:                    "https://api.stripe.com",
		idemRetryDelay:          250 * time.Millisecond,
		canonicalWebhookRefresh: true,
		now:                     time.Now,
	}
}

// ValidateStripeCatalog is a startup gate: Relayium only supports licensed
// recurring prices. A metered or non-recurring Price would introduce usage
// billing paths that account deletion cannot safely settle automatically.
func (s *Service) ValidateStripeCatalog(ctx context.Context) error {
	if _, ok := s.biller.(*stripeClient); !ok {
		return nil
	}
	plans, err := s.Store().ListPlans(ctx)
	if err != nil {
		return err
	}
	for _, plan := range plans {
		for _, cycle := range []string{"monthly", "yearly"} {
			if err := s.validateStripePlanPrice(ctx, plan, cycle); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Service) validateStripePlanPrice(ctx context.Context, plan Plan, cycle string) error {
	c, ok := s.biller.(*stripeClient)
	priceID := priceIDForCycle(plan, cycle)
	if priceID == "" {
		return nil
	}
	if !ok {
		return nil
	}
	body, err := c.request(ctx, http.MethodGet, "/v1/prices/"+url.PathEscape(priceID), nil)
	if err != nil {
		return fmt.Errorf("stripe: validate configured price: %w", err)
	}
	var price struct {
		ID         string `json:"id"`
		Type       string `json:"type"`
		Currency   string `json:"currency"`
		Active     bool   `json:"active"`
		Livemode   bool   `json:"livemode"`
		UnitAmount int64  `json:"unit_amount"`
		Recurring  *struct {
			UsageType     string `json:"usage_type"`
			Interval      string `json:"interval"`
			IntervalCount int64  `json:"interval_count"`
		} `json:"recurring"`
	}
	if err := json.Unmarshal(body, &price); err != nil {
		return errors.New("stripe: configured price response is invalid")
	}
	wantInterval, wantAmount := "month", plan.PriceMonthly
	if cycle == "yearly" {
		wantInterval, wantAmount = "year", plan.PriceYearly
	}
	if price.ID != priceID || price.Livemode != c.wantLive || !price.Active || price.Type != "recurring" || price.Currency != "usd" || price.UnitAmount != wantAmount || price.Recurring == nil || price.Recurring.UsageType != "licensed" || price.Recurring.Interval != wantInterval || price.Recurring.IntervalCount != 1 {
		return errors.New("stripe: configured price does not match the local licensed plan contract")
	}
	return nil
}

// liveSubStatus reports whether a Stripe subscription status is one we treat as
// a changeable live subscription. It must include every status the webhook
// grants a plan for (active, trialing — see handleStripeWebhook) plus past_due,
// so that a user shown as subscribed can always reach the change/schedule/
// release paths. A status=active-only query silently 500'd trialing users.
func liveSubStatus(status string) bool {
	switch status {
	case "active", "trialing", "past_due":
		return true
	default:
		return false
	}
}

// replayWindowSecs bounds how stale a webhook timestamp may be, mirroring
// Stripe's own default tolerance and mitigating replay of a captured payload.
const replayWindowSecs = 300

// VerifyWebhook validates a Stripe-Signature header
// ("t=<unix>,v1=<hex>[,v1=<hex2>...]") against payload using HMAC-SHA256 with
// the configured webhook secret, in constant time, and rejects timestamps
// more than replayWindowSecs away from now. Only once the signature is
// verified does it JSON-parse payload into a WebhookEvent projection.
//
// Field provenance:
//   - Type, CustomerID, SubscriptionID, Status, ClientRefUserID,
//     CurrentPeriodEnd all come straight from data.object.* when present;
//     absent fields decode to their zero value (never a panic — see the
//     pointer-free, all-optional envelope struct below).
//   - PriceID comes from data.object.items.data[0].price.id, which only
//     exists on customer.subscription.* events. checkout.session.completed
//     has no line price on the session itself, so PriceID is always "" for
//     that event type; the handler must treat completion as "bind
//     customer+user, active" and wait for the accompanying
//     customer.subscription.created/updated event (which Stripe always
//     sends) to assign the actual plan.
//   - MetadataUserID comes from data.object.metadata.user_id. CreateCheckoutSession
//     sets subscription_data[metadata][user_id], so every subscription created
//     from our checkout carries it — the handler uses it as a fallback bind
//     when a subscription event races ahead of checkout.session.completed.
//   - CurrentPeriodEnd first tries data.object.current_period_end (pre-2025
//     Stripe API versions put it on the subscription object); if that's 0/absent
//     it falls back to data.object.items.data[0].current_period_end, where
//     newer API versions moved it. Display-only field, never used for
//     enforcement, so a best-effort fallback is safe.
func (c *stripeClient) VerifyWebhook(payload []byte, sigHeader string, now int64) (WebhookEvent, error) {
	var ts int64
	var haveTS bool
	var v1s []string
	for _, part := range strings.Split(sigHeader, ",") {
		kv := strings.SplitN(part, "=", 2)
		if len(kv) != 2 {
			continue
		}
		key, val := kv[0], kv[1]
		switch key {
		case "t":
			parsed, err := strconv.ParseInt(val, 10, 64)
			if err != nil {
				return WebhookEvent{}, fmt.Errorf("stripe webhook: invalid timestamp %q: %w", val, err)
			}
			ts = parsed
			haveTS = true
		case "v1":
			v1s = append(v1s, val)
		}
	}
	if !haveTS {
		return WebhookEvent{}, errors.New("stripe webhook: missing t in Stripe-Signature")
	}
	if len(v1s) == 0 {
		return WebhookEvent{}, errors.New("stripe webhook: missing v1 in Stripe-Signature")
	}

	diff := now - ts
	if diff < 0 {
		diff = -diff
	}
	if diff > replayWindowSecs {
		return WebhookEvent{}, errors.New("stripe webhook: timestamp outside tolerance")
	}

	signedPayload := strconv.FormatInt(ts, 10) + "." + string(payload)
	mac := hmac.New(sha256.New, []byte(c.webhookSecret))
	mac.Write([]byte(signedPayload))
	expected := hex.EncodeToString(mac.Sum(nil))

	matched := false
	for _, v1 := range v1s {
		if hmac.Equal([]byte(v1), []byte(expected)) {
			matched = true
			break
		}
	}
	if !matched {
		return WebhookEvent{}, errors.New("stripe webhook: signature mismatch")
	}

	var envelope struct {
		ID       string `json:"id"`
		Type     string `json:"type"`
		Created  int64  `json:"created"`
		Livemode bool   `json:"livemode"`
		Data     struct {
			Object struct {
				// ID + Object discriminate the two event shapes: on a
				// customer.subscription.* event data.object IS the subscription
				// (object=="subscription", its id at data.object.id, and NO
				// "subscription" key); on checkout.session.completed data.object
				// is the session (object=="checkout.session") which references
				// its subscription at data.object.subscription. Parsing only the
				// latter left SubscriptionID empty for every real subscription
				// event — see the resolution below.
				ID            string `json:"id"`
				Object        string `json:"object"`
				Customer      string `json:"customer"`
				Subscription  string `json:"subscription"`
				PaymentIntent string `json:"payment_intent"`
				Charge        string `json:"charge"`
				LatestCharge  string `json:"latest_charge"`
				Invoice       string `json:"invoice"`
				Parent        *struct {
					SubscriptionDetails *struct {
						Subscription string `json:"subscription"`
					} `json:"subscription_details"`
				} `json:"parent"`
				ClientReferenceID string `json:"client_reference_id"`
				Status            string `json:"status"`
				PaymentStatus     string `json:"payment_status"`
				CurrentPeriodEnd  int64  `json:"current_period_end"`
				Metadata          *struct {
					UserID           string `json:"user_id"`
					BillingAttemptID string `json:"billing_attempt_id"`
					DeletionActionID string `json:"relayium_deletion_action_id"`
				} `json:"metadata"`
				Items *struct {
					Data []struct {
						Price *struct {
							ID string `json:"id"`
						} `json:"price"`
						CurrentPeriodEnd int64 `json:"current_period_end"`
					} `json:"data"`
				} `json:"items"`
			} `json:"object"`
		} `json:"data"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return WebhookEvent{}, fmt.Errorf("stripe webhook: parse payload: %w", err)
	}

	// Reject a correctly-signed event whose mode doesn't match the configured key
	// (test vs live). Different modes use different signing secrets, so this is
	// defense-in-depth against a misconfiguration that shares a secret across
	// modes — a test-mode event must never grant a real plan and vice versa.
	if envelope.Livemode != c.wantLive {
		return WebhookEvent{}, ErrWebhookWrongMode
	}

	ev := WebhookEvent{
		EventID:          envelope.ID,
		Type:             envelope.Type,
		Created:          envelope.Created,
		LiveMode:         envelope.Livemode,
		CustomerID:       envelope.Data.Object.Customer,
		SubscriptionID:   envelope.Data.Object.Subscription,
		Status:           envelope.Data.Object.Status,
		PaymentStatus:    envelope.Data.Object.PaymentStatus,
		ClientRefUserID:  envelope.Data.Object.ClientReferenceID,
		CurrentPeriodEnd: envelope.Data.Object.CurrentPeriodEnd,
	}
	if ev.SubscriptionID == "" && envelope.Data.Object.Parent != nil && envelope.Data.Object.Parent.SubscriptionDetails != nil {
		ev.SubscriptionID = envelope.Data.Object.Parent.SubscriptionDetails.Subscription
	}
	// On a customer.subscription.* event the object is the subscription itself,
	// so its id lives at data.object.id (data.object.subscription is absent).
	// Fall back to data.object.subscription for a checkout.session object, whose
	// subscription is a reference field. Without this the double-checkout dedup
	// and duplicate-deletion guard (which compare SubscriptionID to the canonical)
	// were dead code in production — SubscriptionID was always "".
	if envelope.Data.Object.Object == "subscription" && envelope.Data.Object.ID != "" {
		ev.SubscriptionID = envelope.Data.Object.ID
	}
	if md := envelope.Data.Object.Metadata; md != nil {
		ev.MetadataUserID = md.UserID
		ev.MetadataBillingAttemptID = md.BillingAttemptID
		ev.MetadataDeletionActionID = md.DeletionActionID
	}
	if envelope.Data.Object.Object == "checkout.session" {
		ev.CheckoutSessionID = envelope.Data.Object.ID
	}
	switch envelope.Data.Object.Object {
	case "invoice":
		ev.InvoiceID = envelope.Data.Object.ID
	case "payment_intent":
		ev.PaymentIntentID = envelope.Data.Object.ID
	case "charge":
		ev.ChargeID = envelope.Data.Object.ID
	case "refund":
		ev.RefundID = envelope.Data.Object.ID
	}
	if ev.PaymentIntentID == "" {
		ev.PaymentIntentID = envelope.Data.Object.PaymentIntent
	}
	if ev.ChargeID == "" {
		ev.ChargeID = envelope.Data.Object.Charge
	}
	if ev.ChargeID == "" {
		ev.ChargeID = envelope.Data.Object.LatestCharge
	}
	if ev.InvoiceID == "" {
		ev.InvoiceID = envelope.Data.Object.Invoice
	}
	if items := envelope.Data.Object.Items; items != nil && len(items.Data) > 0 {
		if items.Data[0].Price != nil {
			ev.PriceID = items.Data[0].Price.ID
		}
		if ev.CurrentPeriodEnd == 0 {
			ev.CurrentPeriodEnd = items.Data[0].CurrentPeriodEnd
		}
	}
	return ev, nil
}

type stripeCheckoutPaymentChain struct {
	CustomerID, UserID, BillingAttemptID, SubscriptionID, InvoiceID, PaymentIntentID, ChargeID string
}

func (c *stripeClient) canonicalCheckoutPaymentChain(ctx context.Context, sessionID string) (stripeCheckoutPaymentChain, error) {
	if sessionID == "" {
		return stripeCheckoutPaymentChain{}, errors.New("stripe: checkout payment chain has no session")
	}
	body, err := c.request(ctx, http.MethodGet, "/v1/checkout/sessions/"+url.PathEscape(sessionID), nil)
	if err != nil {
		return stripeCheckoutPaymentChain{}, err
	}
	var session struct {
		Customer      string `json:"customer"`
		Subscription  string `json:"subscription"`
		Invoice       string `json:"invoice"`
		PaymentIntent string `json:"payment_intent"`
		PaymentStatus string `json:"payment_status"`
		ClientRef     string `json:"client_reference_id"`
		Metadata      struct {
			BillingAttemptID string `json:"billing_attempt_id"`
			UserID           string `json:"user_id"`
		} `json:"metadata"`
	}
	if err := json.Unmarshal(body, &session); err != nil {
		return stripeCheckoutPaymentChain{}, fmt.Errorf("stripe: read checkout payment chain: %w", err)
	}
	chain := stripeCheckoutPaymentChain{CustomerID: session.Customer, UserID: session.ClientRef, BillingAttemptID: session.Metadata.BillingAttemptID, SubscriptionID: session.Subscription, InvoiceID: session.Invoice, PaymentIntentID: session.PaymentIntent}
	if chain.InvoiceID != "" {
		body, err = c.request(ctx, http.MethodGet, "/v1/invoices/"+url.PathEscape(chain.InvoiceID), nil)
		if err != nil {
			return stripeCheckoutPaymentChain{}, err
		}
		var invoice struct {
			PaymentIntent string `json:"payment_intent"`
			Charge        string `json:"charge"`
		}
		if err := json.Unmarshal(body, &invoice); err != nil {
			return stripeCheckoutPaymentChain{}, fmt.Errorf("stripe: read checkout invoice chain: %w", err)
		}
		if chain.PaymentIntentID == "" {
			chain.PaymentIntentID = invoice.PaymentIntent
		}
		chain.ChargeID = invoice.Charge
	}
	if chain.PaymentIntentID != "" && chain.ChargeID == "" {
		body, err = c.request(ctx, http.MethodGet, "/v1/payment_intents/"+url.PathEscape(chain.PaymentIntentID), nil)
		if err != nil {
			return stripeCheckoutPaymentChain{}, err
		}
		var payment struct {
			LatestCharge string `json:"latest_charge"`
		}
		if err := json.Unmarshal(body, &payment); err != nil {
			return stripeCheckoutPaymentChain{}, fmt.Errorf("stripe: read checkout payment intent chain: %w", err)
		}
		chain.ChargeID = payment.LatestCharge
	}
	if chain.InvoiceID == "" && chain.PaymentIntentID == "" && chain.ChargeID == "" {
		return stripeCheckoutPaymentChain{}, errors.New("stripe: checkout success has no canonical payment chain")
	}
	return chain, nil
}

func (c *stripeClient) canonicalSubscription(ctx context.Context, subID string) (SubscriptionInfo, bool, error) {
	if !c.canonicalWebhookRefresh || subID == "" {
		return SubscriptionInfo{}, false, nil
	}
	body, err := c.request(ctx, http.MethodGet, "/v1/subscriptions/"+url.PathEscape(subID), nil)
	if err != nil {
		var apiErr *stripeAPIError
		if errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound {
			return SubscriptionInfo{}, true, nil
		}
		return SubscriptionInfo{}, false, err
	}
	var sub struct {
		ID               string `json:"id"`
		Status           string `json:"status"`
		CurrentPeriodEnd int64  `json:"current_period_end"`
		Metadata         struct {
			BillingAttemptID string `json:"billing_attempt_id"`
			UserID           string `json:"user_id"`
		} `json:"metadata"`
		Items struct {
			Data []struct {
				Price struct {
					ID string `json:"id"`
				} `json:"price"`
				CurrentPeriodEnd int64 `json:"current_period_end"`
			} `json:"data"`
		} `json:"items"`
	}
	if err := json.Unmarshal(body, &sub); err != nil {
		return SubscriptionInfo{}, false, err
	}
	info := SubscriptionInfo{ID: sub.ID, Status: sub.Status, CurrentPeriodEnd: sub.CurrentPeriodEnd, BillingAttemptID: sub.Metadata.BillingAttemptID, MetadataUserID: sub.Metadata.UserID}
	if len(sub.Items.Data) > 0 {
		info.PriceID = sub.Items.Data[0].Price.ID
		if info.CurrentPeriodEnd == 0 {
			info.CurrentPeriodEnd = sub.Items.Data[0].CurrentPeriodEnd
		}
	}
	return info, false, nil
}

var ErrPaymentPending = errors.New("stripe: payment incomplete; subscription change is pending")

// CreateCheckoutSession creates a subscription-mode Stripe Checkout Session
// and returns its hosted URL for the browser to redirect to.
func (c *stripeClient) CreateCheckoutSession(ctx context.Context, in CheckoutInput) (CheckoutSession, error) {
	if in.BillingAttemptID == "" {
		return CheckoutSession{}, errors.New("stripe: billing attempt id is required")
	}
	form := url.Values{}
	form.Set("mode", "subscription")
	form.Set("line_items[0][price]", in.PriceID)
	form.Set("line_items[0][quantity]", "1")
	form.Set("success_url", in.SuccessURL)
	form.Set("cancel_url", in.CancelURL)
	form.Set("client_reference_id", in.ClientRefUserID)
	form.Set("metadata[billing_attempt_id]", in.BillingAttemptID)
	form.Set("metadata[user_id]", in.ClientRefUserID)
	form.Set("subscription_data[metadata][user_id]", in.ClientRefUserID)
	form.Set("subscription_data[metadata][billing_attempt_id]", in.BillingAttemptID)
	if in.CustomerID != "" {
		form.Set("customer", in.CustomerID)
	} else {
		// subscription-mode Checkout always creates a Customer on its own, so we
		// only prefill the email; sending customer_creation here is invalid
		// (Stripe: "customer_creation can only be used in payment mode") and
		// would 400 every first-time subscriber's checkout.
		form.Set("customer_email", in.CustomerEmail)
	}
	body, err := c.requestKeyed(ctx, http.MethodPost, "/v1/checkout/sessions", form, in.IdempotencyKey)
	if err != nil {
		return CheckoutSession{}, err
	}
	var out CheckoutSession
	if err := json.Unmarshal(body, &out); err != nil {
		return CheckoutSession{}, fmt.Errorf("stripe: create checkout session: parse response: %w", err)
	}
	if !strings.HasPrefix(out.ID, "cs_") || out.URL == "" {
		return CheckoutSession{}, errors.New("stripe: checkout session response is incomplete")
	}
	return out, nil
}

// SubscriptionInfo is a live subscription's identity for the webhook dedup:
// which subscriptions a customer has, so it can keep the earliest and cancel the
// rest. Created is the Stripe subscription creation time (the "earliest" key).
type SubscriptionInfo struct {
	ID               string
	Created          int64
	PriceID          string
	Status           string
	CurrentPeriodEnd int64
	BillingAttemptID string
	MetadataUserID   string
}

// ListActiveSubscriptions returns the customer's active/trialing subscriptions
// (oldest key = Created). The webhook uses it to detect a double-checkout: more
// than one active subscription on one customer means keep the earliest, cancel
// the rest.
func (c *stripeClient) ListActiveSubscriptions(ctx context.Context, customerID string) ([]SubscriptionInfo, error) {
	q := url.Values{}
	q.Set("customer", customerID)
	q.Set("status", "all")
	q.Set("limit", "100")
	body, err := c.request(ctx, http.MethodGet, "/v1/subscriptions?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	var list struct {
		Data []struct {
			ID               string `json:"id"`
			Status           string `json:"status"`
			Created          int64  `json:"created"`
			CurrentPeriodEnd int64  `json:"current_period_end"`
			Items            struct {
				Data []struct {
					Price struct {
						ID string `json:"id"`
					} `json:"price"`
				} `json:"data"`
			} `json:"items"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &list); err != nil {
		return nil, fmt.Errorf("stripe: list subscriptions: parse response: %w", err)
	}
	out := make([]SubscriptionInfo, 0, len(list.Data))
	for _, s := range list.Data {
		if !liveSubStatus(s.Status) {
			continue
		}
		price := ""
		if len(s.Items.Data) > 0 {
			price = s.Items.Data[0].Price.ID
		}
		out = append(out, SubscriptionInfo{
			ID: s.ID, Created: s.Created, PriceID: price,
			Status: s.Status, CurrentPeriodEnd: s.CurrentPeriodEnd,
		})
	}
	return out, nil
}

// CancelSubscription cancels a subscription immediately and, when refund is set,
// fully refunds its latest invoice's payment. Cancellation is done first — the
// critical outcome is that a duplicate stops billing; a refund failure surfaces
// as an error (the caller logs it) but never leaves the subscription active.
func (c *stripeClient) CancelSubscription(ctx context.Context, subID string, refund bool) error {
	var invoiceID string
	if refund {
		invoiceID, _ = c.latestInvoiceID(ctx, subID) // best-effort read before cancel
	}
	if _, err := c.request(ctx, http.MethodDelete, "/v1/subscriptions/"+subID, nil); err != nil {
		// Already canceled / gone ⇒ idempotent success; still try the refund.
		if !strings.Contains(err.Error(), "No such subscription") &&
			!strings.Contains(err.Error(), "canceled") {
			return err
		}
	}
	if refund && invoiceID != "" {
		if err := c.refundInvoice(ctx, subID, invoiceID); err != nil {
			return fmt.Errorf("stripe: canceled sub %s but refund failed: %w", subID, err)
		}
	}
	return nil
}

type stripeDeletionList struct {
	Data     []struct{ ID, Status string } `json:"data"`
	HasMore  bool                          `json:"has_more"`
	NextPage string                        `json:"next_page"`
}

func (c *stripeClient) deletionList(ctx context.Context, path string, query url.Values) ([]string, error) {
	var ids []string
	for {
		query.Set("limit", "100")
		body, err := c.request(ctx, http.MethodGet, path+"?"+query.Encode(), nil)
		if err != nil {
			return nil, err
		}
		var page stripeDeletionList
		if err := json.Unmarshal(body, &page); err != nil {
			return nil, fmt.Errorf("stripe: parse deletion inventory: %w", err)
		}
		for _, v := range page.Data {
			if path == "/v1/subscriptions" && (v.Status == "canceled" || v.Status == "incomplete_expired") {
				continue
			}
			if path == "/v1/subscription_schedules" && (v.Status == "canceled" || v.Status == "completed" || v.Status == "released") {
				continue
			}
			ids = append(ids, v.ID)
		}
		if !page.HasMore {
			return ids, nil
		}
		if len(page.Data) == 0 {
			return nil, errors.New("stripe: deletion inventory pagination made no progress")
		}
		next := page.Data[len(page.Data)-1].ID
		if next == "" || next == query.Get("starting_after") {
			return nil, errors.New("stripe: deletion inventory cursor did not advance")
		}
		query.Set("starting_after", next)
	}
}

func (c *stripeClient) DiscoverDeletionHazards(ctx context.Context, row BillingCancellation, p BillingDeletionProgress) (BillingDeletionProgress, error) {
	p.Customers = appendUnique(p.Customers, row.CustomerID)
	if len(p.Customers) == 0 {
		if proof, ok := p.Resources["no_side_effect_proof:"+row.BillingSubjectID]; ok && proof.Terminal && len(p.Resources) == 1 {
			p.HistoricalAuditRequired = false
			return p, nil
		}
	}
	if len(p.Customers) == 0 {
		// A first Checkout can be durably attributed before Stripe creates its
		// Customer. Its exact session is safe to reconcile only when the GET
		// response proves the locally journaled attempt and billing subject.
		hasAttributedSession := false
		for _, r := range p.Resources {
			if (r.Kind == "checkout_session" && r.AttemptID != "") ||
				(r.Kind == "subscription" && (r.Status == "external_binding" || r.AttemptID != "")) {
				hasAttributedSession = true
				break
			}
		}
		if !hasAttributedSession {
			return p, errors.New("stripe: no canonical customer identity for deletion")
		}
	}
	completedHistoricalInventory := !p.HistoricalAuditRequired
	for _, customerID := range p.Customers {
		if p.HistoricalAuditRequired {
			completedHistoricalInventory = true
		}
		base := url.Values{"customer": {customerID}}
		copyQ := func(extra ...string) url.Values {
			q := url.Values{}
			for k, v := range base {
				q[k] = append([]string(nil), v...)
			}
			for i := 0; i+1 < len(extra); i += 2 {
				q.Set(extra[i], extra[i+1])
			}
			return q
		}
		createdFilter := fmt.Sprint(row.CreatedAt)
		if p.HistoricalAuditRequired {
			createdFilter = ""
		}
		kinds := []struct {
			kind, path string
			q          url.Values
		}{{"checkout_session", "/v1/checkout/sessions", copyQ("status", "open")}, {"checkout_session", "/v1/checkout/sessions", copyQ("status", "complete")}, {"checkout_session", "/v1/checkout/sessions", copyQ("status", "expired")}, {"subscription", "/v1/subscriptions", copyQ("status", "all")}, {"schedule", "/v1/subscription_schedules", copyQ()}, {"invoice_item", "/v1/invoiceitems", copyQ("pending", "true")}, {"invoice", "/v1/invoices", copyQ("status", "draft")}, {"invoice", "/v1/invoices", copyQ("status", "open")}}
		for _, kind := range []string{"invoice", "payment_intent", "charge"} {
			q := copyQ()
			if createdFilter != "" {
				q.Set("created[gte]", createdFilter)
			}
			path := "/v1/" + kind + "s"
			if kind == "payment_intent" {
				path = "/v1/payment_intents"
			}
			kinds = append(kinds, struct {
				kind, path string
				q          url.Values
			}{kind, path, q})
		}
		for _, k := range kinds {
			ids, err := c.deletionList(ctx, k.path, k.q)
			if err != nil {
				return p, err
			}
			for _, id := range ids {
				p.add(BillingDeletionResource{Kind: k.kind, ID: id, CustomerID: customerID, Status: "discovered"})
			}
		}
	}
	if completedHistoricalInventory {
		p.HistoricalAuditRequired = false
	}
	return p, nil
}

func (c *stripeClient) ReconcileDeletionHazards(ctx context.Context, row BillingCancellation, p BillingDeletionProgress) (BillingDeletionProgress, error) {
	cutoffAt := row.CreatedAt
	if row.CutoffAt > 0 {
		cutoffAt = row.CutoffAt
	}
	key := func(kind, id string) string {
		sum := sha256.Sum256([]byte(row.IdempotencyKey + "\x00" + kind + "\x00" + id))
		return "acct-delete:" + hex.EncodeToString(sum[:16])
	}
	allowed := func(customer string) bool {
		for _, v := range p.Customers {
			if v == customer {
				return true
			}
		}
		return false
	}
	var pendingRecovery error
	for resourceKey, r := range p.Resources {
		if r.Terminal || r.Manual {
			continue
		}
		path := "/v1/"
		switch r.Kind {
		case "checkout_session":
			path += "checkout/sessions/"
		case "subscription":
			path += "subscriptions/"
		case "schedule":
			path += "subscription_schedules/"
		case "invoice_item":
			path += "invoiceitems/"
		case "invoice":
			path += "invoices/"
		case "payment_intent":
			path += "payment_intents/"
		case "charge":
			path += "charges/"
		case "no_side_effect_proof":
			continue
		default:
			r.Manual = true
			r.Status = "unknown_resource"
			p.Resources[resourceKey] = r
			continue
		}
		body, err := c.request(ctx, http.MethodGet, path+url.PathEscape(r.ID), nil)
		if stripeDeletionObjectGone(err) {
			r.Terminal = true
			r.Status = "gone"
			p.Resources[resourceKey] = r
			continue
		}
		if err != nil {
			return p, err
		}
		var obj struct {
			ID              string `json:"id"`
			Status          string `json:"status"`
			Customer        string `json:"customer"`
			PaymentStatus   string `json:"payment_status"`
			Subscription    string `json:"subscription"`
			PaymentIntent   string `json:"payment_intent"`
			Invoice         string `json:"invoice"`
			RecoveredFrom   string `json:"recovered_from"`
			Created         int64  `json:"created"`
			ExpiresAt       int64  `json:"expires_at"`
			AfterExpiration *struct {
				Recovery *struct {
					Enabled   bool  `json:"enabled"`
					ExpiresAt int64 `json:"expires_at"`
				} `json:"recovery"`
			} `json:"after_expiration"`
			LatestCharge      string `json:"latest_charge"`
			Charge            string `json:"charge"`
			Paid              bool   `json:"paid"`
			StatusTransitions struct {
				PaidAt int64 `json:"paid_at"`
			} `json:"status_transitions"`
			ClientReferenceID string `json:"client_reference_id"`
			Metadata          struct {
				BillingAttemptID string `json:"billing_attempt_id"`
				UserID           string `json:"user_id"`
			} `json:"metadata"`
			Items struct {
				Data []struct {
					Price struct {
						Recurring *struct {
							UsageType string `json:"usage_type"`
						} `json:"recurring"`
					} `json:"price"`
				} `json:"data"`
			}
		}
		if err := json.Unmarshal(body, &obj); err != nil {
			return p, err
		}
		if r.Kind == "checkout_session" && r.AttemptID != "" {
			if obj.ClientReferenceID != row.BillingSubjectID || obj.Metadata.UserID != row.BillingSubjectID || obj.Metadata.BillingAttemptID != r.AttemptID {
				r.Manual = true
				r.Status = "attempt_attribution_mismatch"
				p.Resources[resourceKey] = r
				return p, errors.New("stripe: checkout deletion attribution mismatch")
			}
			if obj.Customer != "" {
				p.Customers = appendUnique(p.Customers, obj.Customer)
				r.CustomerID = obj.Customer
			}
		}
		if r.Kind == "subscription" && r.CustomerID == "" {
			boundExternal := r.Status == "external_binding"
			boundAttempt := r.AttemptID != "" && obj.Metadata.UserID == row.BillingSubjectID && obj.Metadata.BillingAttemptID == r.AttemptID
			if (!boundExternal && !boundAttempt) || obj.Customer == "" {
				r.Manual = true
				r.Status = "subscription_attribution_mismatch"
				p.Resources[resourceKey] = r
				return p, errors.New("stripe: subscription deletion attribution mismatch")
			}
			p.Customers = appendUnique(p.Customers, obj.Customer)
			r.CustomerID = obj.Customer
			p.Resources[resourceKey] = r
			return p, errors.New("stripe: canonical customer derived; inventory required before mutation")
		}
		if obj.Customer != "" && !allowed(obj.Customer) {
			r.Manual = true
			r.Status = "customer_mismatch"
			p.Resources[resourceKey] = r
			return p, errors.New("stripe: deletion object customer mismatch")
		}
		switch r.Kind {
		case "checkout_session":
			observedAsyncFailure := r.AsyncFailureAt > r.AsyncSuccessAt
			r.ProviderCreatedAt = obj.Created
			r.PaymentIntentID = obj.PaymentIntent
			r.InvoiceID = obj.Invoice
			r.RecoveredFrom = obj.RecoveredFrom
			if obj.RecoveredFrom != "" {
				parentKey := "checkout_session:" + obj.RecoveredFrom
				if _, exists := p.Resources[parentKey]; !exists {
					p.add(BillingDeletionResource{Kind: "checkout_session", ID: obj.RecoveredFrom, CustomerID: obj.Customer, Status: "recovery_parent"})
				}
			}
			recoveryEnabled := obj.AfterExpiration != nil && obj.AfterExpiration.Recovery != nil && obj.AfterExpiration.Recovery.Enabled
			if obj.Subscription != "" {
				p.add(BillingDeletionResource{Kind: "subscription", ID: obj.Subscription, CustomerID: obj.Customer, Status: "session_link"})
			}
			if obj.PaymentIntent != "" {
				p.add(BillingDeletionResource{Kind: "payment_intent", ID: obj.PaymentIntent, PaymentIntentID: obj.PaymentIntent, CustomerID: obj.Customer, Status: "session_link", AsyncFailureAt: r.AsyncFailureAt, AsyncSuccessAt: r.AsyncSuccessAt})
			}
			if obj.Invoice != "" {
				p.add(BillingDeletionResource{Kind: "invoice", ID: obj.Invoice, InvoiceID: obj.Invoice, CustomerID: obj.Customer, Status: "session_link"})
			}
			if recoveryEnabled {
				if obj.AfterExpiration.Recovery.ExpiresAt > 0 {
					r.RecoveryExpiresAt = obj.AfterExpiration.Recovery.ExpiresAt
				}
				if obj.Status != "expired" || r.RecoveryExpiresAt == 0 || c.now().Unix() < r.RecoveryExpiresAt {
					r.Status = "recovery_lineage_pending"
					p.Resources[resourceKey] = r
					pendingRecovery = errors.New("stripe: checkout recovery lineage requires canonical expiry")
					continue
				}
				if obj.Subscription != "" || obj.Invoice != "" || obj.PaymentIntent != "" || obj.PaymentStatus == "paid" {
					r.Terminal = true
					r.Status = "recovery_delegated_to_payment_objects"
					break
				}
				r.Status = "recovery_window_elapsed_verify_lineage"
				p.Resources[resourceKey] = r
				continue
			}
			if obj.Status == "expired" {
				r.Terminal = true
				r.Status = "expired"
				break
			}
			if observedAsyncFailure && obj.PaymentStatus == "unpaid" {
				r.Terminal = true
				if obj.Subscription != "" || obj.Invoice != "" || obj.PaymentIntent != "" {
					r.Status = "async_failure_delegated_to_payment_objects"
				} else {
					r.Status = "canonical_async_payment_failed"
				}
				break
			}
			if obj.PaymentStatus == "paid" {
				if obj.Subscription == "" && obj.Invoice == "" && obj.PaymentIntent == "" {
					r.Manual = true
					r.Status = "paid_without_canonical_payment_object"
					p.Resources[resourceKey] = r
					return p, errors.New("stripe: paid checkout lacks a canonical payment object")
				}
				r.Terminal = true
				r.Status = "delegated_to_payment_objects"
				break
			}
			if obj.Status == "complete" {
				r.Status = "complete_payment_pending"
				p.Resources[resourceKey] = r
				return p, errors.New("stripe: completed checkout payment remains unresolved")
			}
			if _, err := c.requestKeyed(ctx, http.MethodPost, path+url.PathEscape(r.ID)+"/expire", nil, key("session", r.ID)); err != nil && !stripeDeletionObjectGone(err) {
				return p, err
			}
		case "schedule":
			if obj.Status == "canceled" || obj.Status == "completed" || obj.Status == "released" {
				r.Terminal = true
				r.Status = obj.Status
				break
			}
			form := url.Values{"invoice_now": {"false"}, "prorate": {"false"}}
			if _, err := c.requestKeyed(ctx, http.MethodPost, path+url.PathEscape(r.ID)+"/cancel", form, key("schedule", r.ID)); err != nil && !stripeDeletionObjectGone(err) {
				return p, err
			}
		case "subscription":
			if obj.Status == "canceled" || obj.Status == "incomplete_expired" {
				r.Terminal = true
				r.Status = obj.Status
				break
			}
			if len(obj.Items.Data) == 0 && obj.Status != "canceled" && obj.Status != "incomplete_expired" {
				r.Status = "metering_unknown"
				p.Resources[resourceKey] = r
				return p, errors.New("stripe: subscription charge model unavailable")
			}
			for _, item := range obj.Items.Data {
				if item.Price.Recurring == nil || item.Price.Recurring.UsageType != "licensed" {
					r.Status = "metered_usage_requires_operator"
					p.Resources[resourceKey] = r
					return p, errors.New("stripe: metered subscription deletion requires explicit usage reconciliation")
				}
			}
			form := url.Values{"invoice_now": {"false"}, "prorate": {"false"}}
			if _, err := c.request(ctx, http.MethodDelete, path+url.PathEscape(r.ID), form); err != nil && !stripeDeletionObjectGone(err) {
				return p, err
			}
		case "invoice_item":
			if _, err := c.request(ctx, http.MethodDelete, path+url.PathEscape(r.ID), nil); err != nil && !stripeDeletionObjectGone(err) {
				return p, err
			}
		case "invoice":
			r.ProviderCreatedAt = obj.Created
			r.PaymentIntentID = obj.PaymentIntent
			r.InvoiceID = r.ID
			if obj.PaymentIntent != "" {
				p.add(BillingDeletionResource{Kind: "payment_intent", ID: obj.PaymentIntent, PaymentIntentID: obj.PaymentIntent, InvoiceID: r.ID, CustomerID: r.CustomerID, Status: "invoice_link", SuccessAt: obj.StatusTransitions.PaidAt})
			}
			if obj.Charge != "" {
				p.add(BillingDeletionResource{Kind: "charge", ID: obj.Charge, PaymentIntentID: obj.PaymentIntent, InvoiceID: r.ID, CustomerID: r.CustomerID, Status: "invoice_link", SuccessAt: obj.StatusTransitions.PaidAt})
			}
			if obj.Status == "paid" {
				if obj.StatusTransitions.PaidAt > 0 && obj.StatusTransitions.PaidAt < cutoffAt {
					r.Terminal = true
					r.Status = "paid_before_deletion"
					break
				}
				r.Manual = true
				if obj.StatusTransitions.PaidAt > cutoffAt {
					r.Status = "paid_after_deletion"
				} else if obj.StatusTransitions.PaidAt == cutoffAt {
					r.Status = "paid_at_deletion_time_unknown"
				} else {
					r.Status = "paid_time_unknown"
				}
				p.Resources[resourceKey] = r
				return p, errors.New("stripe: paid invoice requires audited refund")
			}
			method, suffix := http.MethodPost, "/void"
			if obj.Status == "draft" {
				method = http.MethodDelete
				suffix = ""
			}
			if obj.Status == "void" || obj.Status == "uncollectible" {
				r.Terminal = true
				r.Status = obj.Status
				break
			}
			if _, err := c.requestKeyed(ctx, method, path+url.PathEscape(r.ID)+suffix, nil, key("invoice", r.ID)); err != nil && !stripeDeletionObjectGone(err) {
				return p, err
			}
		case "payment_intent":
			r.ProviderCreatedAt = obj.Created
			r.PaymentIntentID = r.ID
			if obj.Status == "canceled" {
				r.Terminal = true
				r.Status = "canceled"
				break
			}
			if obj.Status == "succeeded" {
				if obj.LatestCharge != "" {
					p.add(BillingDeletionResource{Kind: "charge", ID: obj.LatestCharge, PaymentIntentID: r.ID, InvoiceID: r.InvoiceID, CustomerID: r.CustomerID, Status: "payment_intent_link", SuccessAt: r.SuccessAt})
					r.Terminal = true
					r.Status = "delegated_to_charge"
					break
				}
				r.Manual = true
				r.Status = "succeeded_time_unknown"
				p.Resources[resourceKey] = r
				return p, errors.New("stripe: succeeded payment lacks canonical charge time")
			}
			if obj.Status == "processing" {
				r.Status = "processing"
				p.Resources[resourceKey] = r
				return p, errors.New("stripe: payment remains processing")
			}
			if obj.Status == "requires_payment_method" && r.AsyncFailureAt > r.AsyncSuccessAt {
				r.Terminal = true
				r.Status = "canonical_async_payment_failed"
				break
			}
			// Subscription Checkout owns its PaymentIntent through the invoice.
			// Observe it here; canceling the PI directly is not a supported safety
			// boundary for this flow.
			r.Status = "observed_nonterminal"
			p.Resources[resourceKey] = r
			return p, errors.New("stripe: checkout payment intent remains provider-managed")
		case "charge":
			r.ProviderCreatedAt = obj.Created
			r.PaymentIntentID = obj.PaymentIntent
			r.InvoiceID = obj.Invoice
			if obj.PaymentIntent != "" {
				p.add(BillingDeletionResource{Kind: "payment_intent", ID: obj.PaymentIntent, CustomerID: r.CustomerID, Status: "charge_link"})
			}
			if obj.Invoice != "" {
				p.add(BillingDeletionResource{Kind: "invoice", ID: obj.Invoice, CustomerID: r.CustomerID, Status: "charge_link"})
			}
			if obj.Paid || obj.Status == "succeeded" {
				if r.SuccessAt > 0 && r.SuccessAt < cutoffAt {
					r.Terminal = true
					r.Status = "succeeded_before_deletion"
					break
				}
				r.Manual = true
				if r.SuccessAt > cutoffAt {
					r.Status = "succeeded_after_deletion"
				} else if r.SuccessAt == cutoffAt {
					r.Status = "succeeded_at_deletion_time_unknown"
				} else {
					r.Status = "succeeded_time_unknown"
				}
				p.Resources[resourceKey] = r
				return p, errors.New("stripe: charge succeeded after deletion")
			}
			if obj.Status == "failed" {
				r.Terminal = true
				r.Status = "canonical_failed"
				break
			}
			r.Status = "canonical_payment_pending"
			p.Resources[resourceKey] = r
			return p, errors.New("stripe: charge remains nonterminal")
		}
		p.Resources[resourceKey] = r
	}
	for key, parent := range p.Resources {
		if parent.Kind != "checkout_session" || parent.Status != "recovery_window_elapsed_verify_lineage" {
			continue
		}
		hasDescendant, descendantPending := false, false
		for _, child := range p.Resources {
			if child.Kind == "checkout_session" && child.RecoveredFrom == parent.ID {
				hasDescendant = true
				descendantPending = descendantPending || !child.Terminal
			}
		}
		if descendantPending {
			parent.Status = "recovery_descendant_pending"
			p.Resources[key] = parent
			pendingRecovery = errors.New("stripe: checkout recovery descendant remains pending")
			continue
		}
		parent.Terminal = true
		if hasDescendant {
			parent.Status = "recovery_descendants_terminal"
		} else {
			parent.Status = "recovery_window_closed"
		}
		p.Resources[key] = parent
	}
	for _, r := range p.Resources {
		if r.Manual {
			return p, errors.New("stripe: deletion requires manual reconciliation")
		}
		if !r.Terminal {
			if pendingRecovery != nil {
				return p, pendingRecovery
			}
			return p, errors.New("stripe: deletion hazards remain pending")
		}
	}
	return p, nil
}

func stripeDeletionObjectGone(err error) bool {
	var apiErr *stripeAPIError
	return errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound
}

// latestInvoiceID reads a subscription's latest_invoice id.
func (c *stripeClient) latestInvoiceID(ctx context.Context, subID string) (string, error) {
	body, err := c.request(ctx, http.MethodGet, "/v1/subscriptions/"+subID, nil)
	if err != nil {
		return "", err
	}
	var sub struct {
		LatestInvoice string `json:"latest_invoice"`
	}
	if err := json.Unmarshal(body, &sub); err != nil {
		return "", fmt.Errorf("stripe: read subscription %s: %w", subID, err)
	}
	return sub.LatestInvoice, nil
}

// refundInvoice issues a full refund of an invoice's payment, if it was paid.
// Idempotency-Key = "refund:<subID>" so a re-run (or a racing reconcile) never
// double-refunds.
func (c *stripeClient) refundInvoice(ctx context.Context, subID, invoiceID string) error {
	body, err := c.request(ctx, http.MethodGet, "/v1/invoices/"+invoiceID, nil)
	if err != nil {
		return err
	}
	var inv struct {
		PaymentIntent string `json:"payment_intent"`
		AmountPaid    int64  `json:"amount_paid"`
	}
	if err := json.Unmarshal(body, &inv); err != nil {
		return fmt.Errorf("stripe: read invoice %s: %w", invoiceID, err)
	}
	if inv.PaymentIntent == "" || inv.AmountPaid <= 0 {
		return nil // nothing was charged — nothing to refund
	}
	form := url.Values{}
	form.Set("payment_intent", inv.PaymentIntent)
	_, err = c.requestKeyed(ctx, http.MethodPost, "/v1/refunds", form, "refund:"+subID)
	return err
}

// EnsureCustomer returns a Stripe customer id for the user, creating one if
// needed. The Idempotency-Key = "customer:<userID>" makes two concurrent
// first-time checkouts (double tab / retry) resolve to the SAME customer instead
// of each minting its own, which is what let a user end up with two customers and
// two parallel subscriptions (the second invisible in the Billing Portal). The
// user_id metadata ties the customer back to the account for reconciliation.
func (c *stripeClient) EnsureCustomer(ctx context.Context, email, userID string) (string, error) {
	form := url.Values{}
	if email != "" {
		form.Set("email", email)
	}
	form.Set("metadata[user_id]", userID)
	body, err := c.requestKeyed(ctx, http.MethodPost, "/v1/customers", form, "customer:"+userID)
	if err != nil {
		return "", err
	}
	var out struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", fmt.Errorf("stripe: create customer: parse response: %w", err)
	}
	if out.ID == "" {
		return "", fmt.Errorf("stripe: create customer: empty id")
	}
	return out.ID, nil
}

// CreatePortalSession creates a Stripe Billing Portal Session for an existing
// customer and returns its hosted URL.
func (c *stripeClient) CreatePortalSession(ctx context.Context, customerID, returnURL string) (string, error) {
	if c.portalConfig == "" {
		return "", errors.New("stripe: dedicated billing portal configuration is required")
	}
	form := url.Values{}
	form.Set("customer", customerID)
	form.Set("return_url", returnURL)
	form.Set("configuration", c.portalConfig)
	return c.postForSessionURL(ctx, "/v1/billing_portal/sessions", form)
}

// liveSub is the customer's live subscription as the change/preview paths need
// it: which subscription and item to act on, what price it is on now, and the
// generation token below.
type liveSub struct {
	ID, ItemID, PriceID string
	// LatestInvoiceID is the subscription's latest_invoice. It is not used to
	// bill anything — it is the state generation the idempotency key needs.
	// Every always_invoice plan change writes a new invoice, so this value
	// changes exactly when a change is APPLIED, which is what lets one key
	// collapse concurrent duplicates of one intent while still letting a later,
	// genuine change through. Empty is tolerated (see planChangeIdemKey).
	LatestInvoiceID string
}

// liveSubscription finds the customer's live subscription (the first one whose
// status passes liveSubStatus, scanning newest-first). Shared by
// ChangeSubscriptionPlan and PreviewChange so there is one copy of the
// status=all + liveSubStatus scan.
func (c *stripeClient) liveSubscription(ctx context.Context, customerID string) (liveSub, error) {
	q := url.Values{}
	q.Set("customer", customerID)
	q.Set("status", "all")
	// status=all can return several subscriptions (e.g. an older live one plus
	// a newer canceled one); Stripe returns them newest-first, so a limit of 1
	// could hand back a non-live subscription while the live one goes
	// unseen. 100 is Stripe's max page size — a customer never has that many
	// subscriptions, so no pagination is needed, and the loop below still
	// scans for the first live one.
	q.Set("limit", "100")
	body, err := c.request(ctx, http.MethodGet, "/v1/subscriptions?"+q.Encode(), nil)
	if err != nil {
		return liveSub{}, err
	}
	var list struct {
		Data []struct {
			ID            string `json:"id"`
			Status        string `json:"status"`
			LatestInvoice string `json:"latest_invoice"`
			Items         struct {
				Data []struct {
					ID    string `json:"id"`
					Price struct {
						ID string `json:"id"`
					} `json:"price"`
				} `json:"data"`
			} `json:"items"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &list); err != nil {
		return liveSub{}, fmt.Errorf("stripe: list subscriptions: parse response: %w", err)
	}
	for _, sub := range list.Data {
		if liveSubStatus(sub.Status) && len(sub.Items.Data) > 0 {
			return liveSub{
				ID:              sub.ID,
				ItemID:          sub.Items.Data[0].ID,
				PriceID:         sub.Items.Data[0].Price.ID,
				LatestInvoiceID: sub.LatestInvoice,
			}, nil
		}
	}
	return liveSub{}, fmt.Errorf("stripe: no live subscription for customer %s", customerID)
}

// planChangeIdemKey is the deterministic Idempotency-Key for one in-place plan
// change. Two requests share a key exactly when they are the same change, from
// the same starting state, on the same subscription — which is what makes a
// retried or concurrently-submitted change-plan collapse into ONE charge.
//
// The generation token (the subscription's latest_invoice at read time) is what
// keeps the scope tight enough. Without it the key would be a pure function of
// (subscription, from-price, to-price), so a user who moved pro-monthly →
// pro-yearly, back to monthly, then to yearly again within Stripe's 24h key
// window would replay the FIRST response: Stripe would return the original
// subscription object and apply nothing, silently swallowing a legitimate paid
// change. always_invoice writes a new invoice on every applied change, so the
// token advances exactly once per applied change and the third request gets its
// own key.
//
// An empty latest_invoice (a subscription that has not invoiced yet) degrades
// this to the from-price/to-price scope, which is still correct for the case
// that matters — concurrent duplicates of one intent — because a subscription
// with no invoice has no earlier change to replay.
func planChangeIdemKey(sub liveSub, newPriceID string) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{
		"relayium:planchange:v1", sub.ID, sub.ItemID, sub.PriceID, newPriceID, sub.LatestInvoiceID,
	}, "\x00")))
	return "planchange_" + hex.EncodeToString(sum[:])
}

// ChangeSubscriptionPlan switches the customer's active subscription to
// newPriceID in place, for in-app upgrade/downgrade. It looks the
// subscription up by customer (we don't persist subscription ids), then updates
// its single item's price with always_invoice proration so the customer is
// charged the prorated difference immediately (rather than it silently
// accruing as a credit/debit on the next regular invoice) — see PreviewChange,
// which previews this same charge before the operator confirms. Stripe emits
// customer.subscription.updated, which the webhook turns into the plan
// reassignment — so this method never touches the DB.
// The update carries a deterministic Idempotency-Key (see planChangeIdemKey) so
// a retried or concurrently-submitted copy of the SAME change collapses into one
// charge instead of prorating twice.
func (c *stripeClient) ChangeSubscriptionPlan(ctx context.Context, customerID, newPriceID string) error {
	sub, err := c.liveSubscription(ctx, customerID)
	if err != nil {
		return err
	}
	if sub.PriceID == newPriceID {
		return nil // already on this price — nothing to do (idempotent)
	}

	// Point the item at the new price, invoicing the proration now.
	form := url.Values{}
	form.Set("items[0][id]", sub.ItemID)
	form.Set("items[0][price]", newPriceID)
	form.Set("proration_behavior", "always_invoice")
	form.Set("payment_behavior", "pending_if_incomplete")
	body, err := c.requestIdempotent(ctx, http.MethodPost, "/v1/subscriptions/"+sub.ID, form,
		planChangeIdemKey(sub, newPriceID))
	if err != nil {
		return err
	}
	var changed struct {
		PendingUpdate json.RawMessage `json:"pending_update"`
	}
	if err := json.Unmarshal(body, &changed); err != nil {
		return fmt.Errorf("stripe: parse changed subscription: %w", err)
	}
	if len(changed.PendingUpdate) > 0 && string(changed.PendingUpdate) != "null" {
		return ErrPaymentPending
	}
	return nil
}

// PreviewChange previews an upcoming invoice for switching the customer's live
// subscription to newPriceID with always_invoice proration — the same proration
// ChangeSubscriptionPlan actually charges — and projects it into a ChangePreview
// (signed adjustment, charge, post-change renewal date) so a confirmation UI can
// show the operator the real numbers before they commit to them.
func (c *stripeClient) PreviewChange(ctx context.Context, customerID, newPriceID string) (ChangePreview, error) {
	sub, err := c.liveSubscription(ctx, customerID)
	if err != nil {
		return ChangePreview{}, err
	}
	// Stripe's Basil API versions (2025+) removed GET /v1/invoices/upcoming in
	// favour of POST /v1/invoices/create_preview. We pin no API version, so the
	// account's default decides which one exists — try the current endpoint first,
	// then fall back to the legacy one, so the preview works on either version.
	if pv, cpErr := c.previewCreatePreview(ctx, sub.ID, sub.ItemID, newPriceID); cpErr == nil {
		return pv, nil
	} else if pv, upErr := c.previewUpcoming(ctx, customerID, sub.ID, sub.ItemID, newPriceID); upErr == nil {
		return pv, nil
	} else {
		return ChangePreview{}, fmt.Errorf("stripe: preview change: create_preview failed (%v) and upcoming fallback failed (%v)", cpErr, upErr)
	}
}

// previewCreatePreview uses the current POST /v1/invoices/create_preview endpoint.
func (c *stripeClient) previewCreatePreview(ctx context.Context, subID, itemID, newPriceID string) (ChangePreview, error) {
	form := url.Values{}
	form.Set("subscription", subID)
	form.Set("subscription_details[items][0][id]", itemID)
	form.Set("subscription_details[items][0][price]", newPriceID)
	form.Set("subscription_details[proration_behavior]", "always_invoice")
	body, err := c.request(ctx, http.MethodPost, "/v1/invoices/create_preview", form)
	if err != nil {
		return ChangePreview{}, err
	}
	return parseChangePreview(body)
}

// previewUpcoming uses the legacy GET /v1/invoices/upcoming endpoint (older API
// versions where create_preview does not yet exist).
func (c *stripeClient) previewUpcoming(ctx context.Context, customerID, subID, itemID, newPriceID string) (ChangePreview, error) {
	q := url.Values{}
	q.Set("customer", customerID)
	q.Set("subscription", subID)
	q.Set("subscription_items[0][id]", itemID)
	q.Set("subscription_items[0][price]", newPriceID)
	q.Set("subscription_proration_behavior", "always_invoice")
	body, err := c.request(ctx, http.MethodGet, "/v1/invoices/upcoming?"+q.Encode(), nil)
	if err != nil {
		return ChangePreview{}, err
	}
	return parseChangePreview(body)
}

// parseChangePreview projects a Stripe preview invoice into a ChangePreview.
//
// PeriodEnd comes from the LATEST line period rather than the invoice's own
// period_end, because that is the only place the post-change anchor shows up: an
// always_invoice proration invoice carries a credit line spanning the OLD period
// and a charge line spanning the NEW one, so on a monthly→yearly switch the two
// lines end a month and a year out respectively, and only the later one is the
// date the subscription actually renews on. Falling back to the top-level
// period_end covers previews with no usable lines; both being absent leaves 0,
// which the caller must read as "unknown" and not as an epoch date.
func parseChangePreview(body []byte) (ChangePreview, error) {
	var inv struct {
		AmountDue int64 `json:"amount_due"`
		Total     int64 `json:"total"`
		PeriodEnd int64 `json:"period_end"`
		Lines     struct {
			Data []struct {
				Period struct {
					End int64 `json:"end"`
				} `json:"period"`
			} `json:"data"`
		} `json:"lines"`
	}
	if err := json.Unmarshal(body, &inv); err != nil {
		return ChangePreview{}, fmt.Errorf("stripe: preview invoice: parse response: %w", err)
	}
	pv := ChangePreview{AmountDueCents: inv.AmountDue, TotalCents: inv.Total}
	for _, line := range inv.Lines.Data {
		if line.Period.End > pv.PeriodEnd {
			pv.PeriodEnd = line.Period.End
		}
	}
	if pv.PeriodEnd == 0 {
		pv.PeriodEnd = inv.PeriodEnd
	}
	return pv, nil
}

type stripeSchedule struct {
	ID           string `json:"id"`
	Status       string `json:"status"`
	CurrentPhase struct {
		StartDate int64 `json:"start_date"`
		EndDate   int64 `json:"end_date"`
	} `json:"current_phase"`
	Phases []struct {
		StartDate int64 `json:"start_date"`
		EndDate   int64 `json:"end_date"`
		Items     []struct {
			Price string `json:"price"`
		} `json:"items"`
	} `json:"phases"`
}

func (c *stripeClient) schedule(ctx context.Context, id string) (stripeSchedule, error) {
	body, err := c.request(ctx, http.MethodGet, "/v1/subscription_schedules/"+url.PathEscape(id), nil)
	if err != nil {
		return stripeSchedule{}, err
	}
	var sched stripeSchedule
	if err := json.Unmarshal(body, &sched); err != nil {
		return stripeSchedule{}, fmt.Errorf("stripe: schedule %s: parse response: %w", id, err)
	}
	if sched.ID == "" {
		return stripeSchedule{}, fmt.Errorf("stripe: schedule response has no id")
	}
	return sched, nil
}

func terminalSchedule(status string) bool {
	switch status {
	case "released", "canceled", "completed":
		return true
	default:
		return false
	}
}

func scheduleTargets(s stripeSchedule, price string) bool {
	return len(s.Phases) > 1 && len(s.Phases[1].Items) > 0 &&
		s.Phases[1].Items[0].Price == price
}

func (c *stripeClient) releaseSchedule(ctx context.Context, id string) error {
	key := stableStripeIntentKey("schedule-release", id)
	_, releaseErr := c.requestIdempotent(ctx, http.MethodPost,
		"/v1/subscription_schedules/"+url.PathEscape(id)+"/release", url.Values{}, key)
	canonical, getErr := c.schedule(ctx, id)
	if getErr == nil && terminalSchedule(canonical.Status) {
		return nil
	}
	if releaseErr != nil {
		return releaseErr
	}
	if getErr != nil {
		return getErr
	}
	return fmt.Errorf("stripe: schedule %s release postcondition is %q", id, canonical.Status)
}

// ScheduleDowngrade defers a plan change to the end of the current billing
// period using a subscription schedule: phase 0 keeps the current price until
// the period ends, phase 1 switches to newPriceID, then the schedule releases
// the subscription to continue on the new price. No proration, no credit — the
// customer just keeps what they paid for until it lapses.
func (c *stripeClient) ScheduleDowngrade(ctx context.Context, customerID, newPriceID string) error {
	// 1. Find the live subscription (and whether it's already schedule-managed).
	q := url.Values{}
	q.Set("customer", customerID)
	q.Set("status", "all")
	// See ChangeSubscriptionPlan's comment: limit must be wide enough to
	// contain the live subscription even when a newer non-live one exists.
	q.Set("limit", "100")
	body, err := c.request(ctx, http.MethodGet, "/v1/subscriptions?"+q.Encode(), nil)
	if err != nil {
		return err
	}
	var subs struct {
		Data []struct {
			ID               string `json:"id"`
			Status           string `json:"status"`
			Schedule         string `json:"schedule"`
			LatestInvoice    string `json:"latest_invoice"`
			CurrentPeriodEnd int64  `json:"current_period_end"`
			Items            struct {
				Data []struct {
					Price struct {
						ID string `json:"id"`
					} `json:"price"`
				} `json:"data"`
			} `json:"items"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &subs); err != nil {
		return fmt.Errorf("stripe: list subscriptions: parse response: %w", err)
	}
	idx := -1
	for i, s := range subs.Data {
		if liveSubStatus(s.Status) {
			idx = i
			break
		}
	}
	if idx == -1 {
		return fmt.Errorf("stripe: no live subscription for customer %s", customerID)
	}
	sub := subs.Data[idx]
	if len(sub.Items.Data) == 0 || sub.Items.Data[0].Price.ID == "" {
		return fmt.Errorf("stripe: live subscription %s has no priced item", sub.ID)
	}
	if len(sub.Items.Data) > 0 && sub.Items.Data[0].Price.ID == newPriceID {
		return nil // already on the target price — nothing to schedule
	}
	// 2. Seed a schedule from the subscription; its single phase mirrors the
	//    current price and spans the current billing period.
	seed := url.Values{}
	seed.Set("from_subscription", sub.ID)
	createSchedule := func() (stripeSchedule, error) {
		generation := []string{"schedule-create", sub.ID, sub.Items.Data[0].Price.ID,
			strconv.FormatInt(sub.CurrentPeriodEnd, 10), sub.LatestInvoice, newPriceID}
		for attempts := 0; attempts < 8; attempts++ {
			created, err := c.requestIdempotent(ctx, http.MethodPost, "/v1/subscription_schedules", seed,
				stableStripeIntentKey(generation...))
			if err != nil {
				return stripeSchedule{}, err
			}
			var identity struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal(created, &identity); err != nil {
				return stripeSchedule{}, fmt.Errorf("stripe: create schedule: parse identity: %w", err)
			}
			if identity.ID == "" {
				return stripeSchedule{}, fmt.Errorf("stripe: created schedule has no id")
			}
			canonical, err := c.schedule(ctx, identity.ID)
			if err != nil {
				return stripeSchedule{}, err
			}
			if terminalSchedule(canonical.Status) {
				// Each terminal replay becomes the durable generation for the next
				// intent. This handles release -> reschedule repeatedly within Stripe's
				// 24-hour idempotency cache while keeping every network retry stable.
				generation = append(generation, "terminal-replay", canonical.ID, canonical.Status)
				continue
			}
			return canonical, nil
		}
		return stripeSchedule{}, fmt.Errorf("stripe: schedule create replay chain did not converge")
	}
	createdSchedule := sub.Schedule == ""
	var sched stripeSchedule
	if sub.Schedule != "" {
		sched, err = c.schedule(ctx, sub.Schedule)
	} else {
		sched, err = createSchedule()
	}
	if err != nil {
		return err
	}
	if len(sched.Phases) == 0 || len(sched.Phases[0].Items) == 0 {
		return fmt.Errorf("stripe: schedule %s has no seed phase", sched.ID)
	}
	if !createdSchedule && len(sched.Phases) > 1 && sched.Phases[0].EndDate > 0 &&
		(sched.CurrentPhase.StartDate >= sched.Phases[0].EndDate || c.now().Unix() >= sched.Phases[0].EndDate) {
		// The first waiting phase is over. Rewriting phase 0 now would rewrite
		// history/current service rather than schedule a future transition.
		if err := c.releaseSchedule(ctx, sched.ID); err != nil {
			return err
		}
		sched, err = createSchedule()
		if err != nil {
			return err
		}
		if len(sched.Phases) == 0 || len(sched.Phases[0].Items) == 0 {
			return fmt.Errorf("stripe: recreated schedule %s has no seed phase", sched.ID)
		}
	}
	p0 := sched.Phases[0]

	// 3. Append the downgrade as phase 1: current price until period end, then the
	//    new price. With end_behavior=release the trailing phase is open-ended
	//    (Stripe rejects a phases[n][iterations] on it), so the subscription
	//    switches to the new price at period end and then continues on it.
	upd := url.Values{}
	upd.Set("end_behavior", "release")
	upd.Set("phases[0][items][0][price]", p0.Items[0].Price)
	upd.Set("phases[0][start_date]", strconv.FormatInt(p0.StartDate, 10))
	upd.Set("phases[0][end_date]", strconv.FormatInt(p0.EndDate, 10))
	upd.Set("phases[1][items][0][price]", newPriceID)
	_, updateErr := c.request(ctx, http.MethodPost, "/v1/subscription_schedules/"+sched.ID, upd)
	canonical, getErr := c.schedule(ctx, sched.ID)
	if getErr == nil && scheduleTargets(canonical, newPriceID) {
		return nil
	}
	if updateErr != nil {
		return updateErr
	}
	if getErr != nil {
		return getErr
	}
	return fmt.Errorf("stripe: schedule %s update postcondition does not target %s", sched.ID, newPriceID)
}

// ReleaseSchedule detaches any subscription schedule from the customer's live
// subscription, so it continues on its current price (canceling a pending
// downgrade). No-op if there is no live subscription or no schedule.
func (c *stripeClient) ReleaseSchedule(ctx context.Context, customerID string) error {
	q := url.Values{}
	q.Set("customer", customerID)
	q.Set("status", "all")
	// See ChangeSubscriptionPlan's comment: limit must be wide enough to
	// contain the live subscription even when a newer non-live one exists.
	q.Set("limit", "100")
	body, err := c.request(ctx, http.MethodGet, "/v1/subscriptions?"+q.Encode(), nil)
	if err != nil {
		return err
	}
	var subs struct {
		Data []struct {
			ID       string `json:"id"`
			Status   string `json:"status"`
			Schedule string `json:"schedule"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &subs); err != nil {
		return fmt.Errorf("stripe: list subscriptions: parse response: %w", err)
	}
	schedule := ""
	for _, s := range subs.Data {
		if liveSubStatus(s.Status) {
			schedule = s.Schedule
			break
		}
	}
	if schedule == "" {
		return nil // no live subscription, or nothing scheduled — nothing to release
	}
	return c.releaseSchedule(ctx, schedule)
}

func stableStripeIntentKey(parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return "relayium_" + hex.EncodeToString(sum[:])
}

// request performs an authenticated Stripe REST call and returns the raw body,
// erroring on any non-2xx. form==nil means a bodyless GET.
func (c *stripeClient) request(ctx context.Context, method, path string, form url.Values) ([]byte, error) {
	return c.requestKeyed(ctx, method, path, form, "")
}

func (c *stripeClient) canonicalPaidInvoice(ctx context.Context, invoiceID string) (CanonicalStripePaidInvoice, error) {
	if invoiceID == "" {
		return CanonicalStripePaidInvoice{}, errors.New("stripe: canonical paid invoice id is empty")
	}
	body, err := c.request(ctx, http.MethodGet, "/v1/invoices/"+url.PathEscape(invoiceID), nil)
	if err != nil {
		return CanonicalStripePaidInvoice{}, err
	}
	var obj struct {
		ID                string `json:"id"`
		Status            string `json:"status"`
		Customer          string `json:"customer"`
		Subscription      string `json:"subscription"`
		PaymentIntent     string `json:"payment_intent"`
		Charge            string `json:"charge"`
		Created           int64  `json:"created"`
		StatusTransitions struct {
			PaidAt int64 `json:"paid_at"`
		} `json:"status_transitions"`
		Parent struct {
			SubscriptionDetails *struct {
				Subscription string `json:"subscription"`
			} `json:"subscription_details"`
		} `json:"parent"`
	}
	if err := json.Unmarshal(body, &obj); err != nil {
		return CanonicalStripePaidInvoice{}, err
	}
	nestedSubscription := ""
	if obj.Parent.SubscriptionDetails != nil {
		nestedSubscription = obj.Parent.SubscriptionDetails.Subscription
	}
	if obj.Subscription != "" && nestedSubscription != "" && obj.Subscription != nestedSubscription {
		return CanonicalStripePaidInvoice{}, errors.New("stripe: canonical paid invoice subscription identities conflict")
	}
	subscriptionID := obj.Subscription
	if subscriptionID == "" {
		subscriptionID = nestedSubscription
	}
	if obj.ID != invoiceID || obj.Status != "paid" || obj.Customer == "" || subscriptionID == "" || obj.Created <= 0 || obj.StatusTransitions.PaidAt <= 0 || obj.Created > obj.StatusTransitions.PaidAt {
		return CanonicalStripePaidInvoice{}, errors.New("stripe: canonical paid invoice evidence is invalid")
	}
	return CanonicalStripePaidInvoice{
		InvoiceID: obj.ID, CustomerID: obj.Customer, SubscriptionID: subscriptionID,
		PaymentIntentID: obj.PaymentIntent, ChargeID: obj.Charge,
		CreatedAt: obj.Created, PaidAt: obj.StatusTransitions.PaidAt,
	}, nil
}

// requestKeyed is request with an optional Stripe Idempotency-Key: retrying (or
// racing) the same key returns the SAME result object instead of creating a
// second one — the basis for one-customer-per-user under concurrent checkout.
func (c *stripeClient) requestKeyed(ctx context.Context, method, path string, form url.Values, idemKey string) ([]byte, error) {
	var bodyReader io.Reader
	if form != nil {
		bodyReader = strings.NewReader(form.Encode())
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, bodyReader)
	if err != nil {
		return nil, err
	}
	if form != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	req.Header.Set("Authorization", "Bearer "+c.secretKey)
	req.Header.Set("Stripe-Version", stripeAPIVersion)
	if idemKey != "" {
		req.Header.Set("Idempotency-Key", idemKey)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &stripeAPIError{Method: method, Path: path, Status: resp.StatusCode, Body: string(body)}
	}
	return body, nil
}

// stripeAPIError is a non-2xx Stripe response, carrying the status and raw body
// so a caller can branch on a SPECIFIC failure instead of string-matching a
// formatted message. Error() reproduces the exact text this used to format, so
// the existing substring checks (CancelSubscription's "No such subscription")
// keep working unchanged.
type stripeAPIError struct {
	Method, Path string
	Status       int
	Body         string
}

func (e *stripeAPIError) Error() string {
	return fmt.Sprintf("stripe: %s %s: status %d: %s", e.Method, e.Path, e.Status, e.Body)
}

// idempotencyKeyInFlight reports whether err is Stripe's refusal of a request
// whose Idempotency-Key is currently being processed by ANOTHER request (409).
// That is the expected outcome when two change-plan requests for the same intent
// race, and it is the one Stripe failure worth retrying: the winner is applying
// exactly the change we want, and re-issuing the same key once it lands returns
// that same result rather than performing a second one.
func idempotencyKeyInFlight(err error) bool {
	var apiErr *stripeAPIError
	if !errors.As(err, &apiErr) {
		return false
	}
	return apiErr.Status == http.StatusConflict &&
		strings.Contains(strings.ToLower(apiErr.Body), "idempotency")
}

// idemRetryAttempts is the total number of times requestIdempotent issues a
// keyed request, counting the first. Two retries is enough to outlast the
// in-flight window of a racing duplicate without holding the HTTP handler open.
const idemRetryAttempts = 3

// requestIdempotent is requestKeyed plus the one retry that idempotency makes
// safe: when Stripe reports the key as still in flight, wait and re-issue THE
// SAME key. Re-issuing is not a second operation — Stripe replays the original
// response — so the losing request of a race reports the truth (the change
// applied) instead of a 500 over a change that actually succeeded.
//
// Any other error is returned immediately: a retry loop over unclassified
// failures is how a transient network blip turns into repeated charges.
func (c *stripeClient) requestIdempotent(ctx context.Context, method, path string, form url.Values, idemKey string) ([]byte, error) {
	var err error
	for attempt := 0; attempt < idemRetryAttempts; attempt++ {
		if attempt > 0 {
			delay := c.idemRetryDelay * time.Duration(1<<(attempt-1))
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(delay):
			}
		}
		var body []byte
		body, err = c.requestKeyed(ctx, method, path, form, idemKey)
		if err == nil {
			return body, nil
		}
		if !idempotencyKeyInFlight(err) {
			return nil, err
		}
	}
	return nil, err
}

// postForSessionURL performs the shared form-POST + {"url":"..."} decode used
// by both Checkout and Billing Portal session creation.
func (c *stripeClient) postForSessionURL(ctx context.Context, path string, form url.Values) (string, error) {
	return c.postForSessionURLKeyed(ctx, path, form, "")
}

func (c *stripeClient) postForSessionURLKeyed(ctx context.Context, path string, form url.Values, idemKey string) (string, error) {
	if path == "/v1/billing_portal/sessions" && c.portalConfig == "" {
		return "", errors.New("stripe: explicit Billing Portal configuration is required")
	}
	body, err := c.requestKeyed(ctx, http.MethodPost, path, form, idemKey)
	if err != nil {
		return "", err
	}
	var out struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", fmt.Errorf("stripe: %s %s: parse response: %w", http.MethodPost, path, err)
	}
	return out.URL, nil
}
