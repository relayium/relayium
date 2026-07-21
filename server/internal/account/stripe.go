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

// Biller abstracts Stripe so handlers/tests never touch the network directly.
// A thin hand-rolled client (stripeClient) is the only implementation; nil
// means billing is unconfigured (RELAYIUM_STRIPE_SECRET_KEY empty).
type Biller interface {
	CreateCheckoutSession(ctx context.Context, in CheckoutInput) (url string, err error)
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
	VerifyWebhook(payload []byte, sigHeader string, now int64) (WebhookEvent, error)
}

// CheckoutInput describes a subscription-mode Checkout Session to create.
// Exactly one of CustomerID / CustomerEmail should be set: CustomerID reuses
// an existing Stripe customer, CustomerEmail lets Stripe create one (and the
// webhook binds it back via ClientRefUserID).
type CheckoutInput struct {
	PriceID, CustomerID, CustomerEmail, ClientRefUserID, SuccessURL, CancelURL string
}

// WebhookEvent is the minimal projection of a verified Stripe event that
// handlers act on. See VerifyWebhook's doc comment for how each field is
// populated per event type — in particular PriceID is empty on
// checkout.session.completed (the plan is assigned by the subsequent
// customer.subscription.* event Stripe always sends).
type WebhookEvent struct {
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
	MetadataUserID   string
	CurrentPeriodEnd int64
}

// stripeClient is the real Biller: a thin hand-rolled HTTP client making
// form-POSTs to api.stripe.com (no SDK dependency — see spec rationale).
type stripeClient struct {
	secretKey     string
	webhookSecret string
	portalConfig  string
	http          *http.Client
	base          string
}

// NewStripeClient builds the real Biller. secretKey/webhookSecret/portalConfig
// come from RELAYIUM_STRIPE_{SECRET_KEY,WEBHOOK_SECRET,PORTAL_CONFIG}; an empty
// portalConfig uses the Stripe account's default Billing Portal configuration.
func NewStripeClient(secretKey, webhookSecret, portalConfig string) *stripeClient {
	return &stripeClient{
		secretKey:     secretKey,
		webhookSecret: webhookSecret,
		portalConfig:  portalConfig,
		// These are quick, non-streaming REST calls (unlike blob transfers
		// elsewhere in this package), so a total timeout is safe and desirable.
		http: &http.Client{Timeout: 20 * time.Second},
		base: "https://api.stripe.com",
	}
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
		Type string `json:"type"`
		Data struct {
			Object struct {
				Customer          string `json:"customer"`
				Subscription      string `json:"subscription"`
				ClientReferenceID string `json:"client_reference_id"`
				Status            string `json:"status"`
				CurrentPeriodEnd  int64  `json:"current_period_end"`
				Metadata          *struct {
					UserID string `json:"user_id"`
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

	ev := WebhookEvent{
		Type:             envelope.Type,
		CustomerID:       envelope.Data.Object.Customer,
		SubscriptionID:   envelope.Data.Object.Subscription,
		Status:           envelope.Data.Object.Status,
		ClientRefUserID:  envelope.Data.Object.ClientReferenceID,
		CurrentPeriodEnd: envelope.Data.Object.CurrentPeriodEnd,
	}
	if md := envelope.Data.Object.Metadata; md != nil {
		ev.MetadataUserID = md.UserID
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

// CreateCheckoutSession creates a subscription-mode Stripe Checkout Session
// and returns its hosted URL for the browser to redirect to.
func (c *stripeClient) CreateCheckoutSession(ctx context.Context, in CheckoutInput) (string, error) {
	form := url.Values{}
	form.Set("mode", "subscription")
	form.Set("line_items[0][price]", in.PriceID)
	form.Set("line_items[0][quantity]", "1")
	form.Set("success_url", in.SuccessURL)
	form.Set("cancel_url", in.CancelURL)
	form.Set("client_reference_id", in.ClientRefUserID)
	form.Set("subscription_data[metadata][user_id]", in.ClientRefUserID)
	if in.CustomerID != "" {
		form.Set("customer", in.CustomerID)
	} else {
		// subscription-mode Checkout always creates a Customer on its own, so we
		// only prefill the email; sending customer_creation here is invalid
		// (Stripe: "customer_creation can only be used in payment mode") and
		// would 400 every first-time subscriber's checkout.
		form.Set("customer_email", in.CustomerEmail)
	}
	return c.postForSessionURL(ctx, "/v1/checkout/sessions", form)
}

// CreatePortalSession creates a Stripe Billing Portal Session for an existing
// customer and returns its hosted URL.
func (c *stripeClient) CreatePortalSession(ctx context.Context, customerID, returnURL string) (string, error) {
	form := url.Values{}
	form.Set("customer", customerID)
	form.Set("return_url", returnURL)
	if c.portalConfig != "" {
		form.Set("configuration", c.portalConfig)
	}
	return c.postForSessionURL(ctx, "/v1/billing_portal/sessions", form)
}

// ChangeSubscriptionPlan switches the customer's active subscription to
// newPriceID in place (prorated), for in-app upgrade/downgrade. It looks the
// subscription up by customer (we don't persist subscription ids), then updates
// its single item's price. Stripe emits customer.subscription.updated, which the
// webhook turns into the plan reassignment — so this method never touches the DB.
func (c *stripeClient) ChangeSubscriptionPlan(ctx context.Context, customerID, newPriceID string) error {
	// 1. Find the customer's live subscription and its item id.
	q := url.Values{}
	q.Set("customer", customerID)
	q.Set("status", "all")
	q.Set("limit", "1")
	body, err := c.request(ctx, http.MethodGet, "/v1/subscriptions?"+q.Encode(), nil)
	if err != nil {
		return err
	}
	var list struct {
		Data []struct {
			ID     string `json:"id"`
			Status string `json:"status"`
			Items  struct {
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
		return fmt.Errorf("stripe: list subscriptions: parse response: %w", err)
	}
	var subID string
	var item struct {
		ID    string `json:"id"`
		Price struct {
			ID string `json:"id"`
		} `json:"price"`
	}
	found := false
	for _, sub := range list.Data {
		if liveSubStatus(sub.Status) && len(sub.Items.Data) > 0 {
			subID = sub.ID
			item = sub.Items.Data[0]
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("stripe: no live subscription for customer %s", customerID)
	}
	if item.Price.ID == newPriceID {
		return nil // already on this price — nothing to do (idempotent)
	}

	// 2. Point the item at the new price, prorating the difference.
	form := url.Values{}
	form.Set("items[0][id]", item.ID)
	form.Set("items[0][price]", newPriceID)
	form.Set("proration_behavior", "create_prorations")
	if _, err := c.request(ctx, http.MethodPost, "/v1/subscriptions/"+subID, form); err != nil {
		return err
	}
	return nil
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
	q.Set("limit", "1")
	body, err := c.request(ctx, http.MethodGet, "/v1/subscriptions?"+q.Encode(), nil)
	if err != nil {
		return err
	}
	var subs struct {
		Data []struct {
			ID       string `json:"id"`
			Status   string `json:"status"`
			Schedule string `json:"schedule"`
			Items    struct {
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
	if len(sub.Items.Data) > 0 && sub.Items.Data[0].Price.ID == newPriceID {
		return nil // already on the target price — nothing to schedule
	}
	if sub.Schedule != "" {
		// A schedule already governs this subscription (e.g. a prior pending
		// downgrade). Don't stack schedules; surface an error so the caller can
		// 500 and the user retries or uses the portal. (Followup: amend in place.)
		return fmt.Errorf("stripe: subscription %s already has a pending schedule", sub.ID)
	}

	// 2. Seed a schedule from the subscription; its single phase mirrors the
	//    current price and spans the current billing period.
	seed := url.Values{}
	seed.Set("from_subscription", sub.ID)
	body, err = c.request(ctx, http.MethodPost, "/v1/subscription_schedules", seed)
	if err != nil {
		return err
	}
	var sched struct {
		ID     string `json:"id"`
		Phases []struct {
			StartDate int64 `json:"start_date"`
			EndDate   int64 `json:"end_date"`
			Items     []struct {
				Price string `json:"price"`
			} `json:"items"`
		} `json:"phases"`
	}
	if err := json.Unmarshal(body, &sched); err != nil {
		return fmt.Errorf("stripe: create schedule: parse response: %w", err)
	}
	if len(sched.Phases) == 0 || len(sched.Phases[0].Items) == 0 {
		return fmt.Errorf("stripe: schedule %s has no seed phase", sched.ID)
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
	if _, err := c.request(ctx, http.MethodPost, "/v1/subscription_schedules/"+sched.ID, upd); err != nil {
		return err
	}
	return nil
}

// ReleaseSchedule detaches any subscription schedule from the customer's live
// subscription, so it continues on its current price (canceling a pending
// downgrade). No-op if there is no live subscription or no schedule.
func (c *stripeClient) ReleaseSchedule(ctx context.Context, customerID string) error {
	q := url.Values{}
	q.Set("customer", customerID)
	q.Set("status", "all")
	q.Set("limit", "1")
	body, err := c.request(ctx, http.MethodGet, "/v1/subscriptions?"+q.Encode(), nil)
	if err != nil {
		return err
	}
	var subs struct {
		Data []struct {
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
	_, err = c.request(ctx, http.MethodPost, "/v1/subscription_schedules/"+schedule+"/release", url.Values{})
	return err
}

// request performs an authenticated Stripe REST call and returns the raw body,
// erroring on any non-2xx. form==nil means a bodyless GET.
func (c *stripeClient) request(ctx context.Context, method, path string, form url.Values) ([]byte, error) {
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
		return nil, fmt.Errorf("stripe: %s %s: status %d: %s", method, path, resp.StatusCode, string(body))
	}
	return body, nil
}

// postForSessionURL performs the shared form-POST + {"url":"..."} decode used
// by both Checkout and Billing Portal session creation.
func (c *stripeClient) postForSessionURL(ctx context.Context, path string, form url.Values) (string, error) {
	body, err := c.request(ctx, http.MethodPost, path, form)
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
