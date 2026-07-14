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
	CurrentPeriodEnd                            int64
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
				Items             *struct {
					Data []struct {
						Price *struct {
							ID string `json:"id"`
						} `json:"price"`
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
	if items := envelope.Data.Object.Items; items != nil && len(items.Data) > 0 && items.Data[0].Price != nil {
		ev.PriceID = items.Data[0].Price.ID
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
		form.Set("customer_email", in.CustomerEmail)
		form.Set("customer_creation", "always")
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

// postForSessionURL performs the shared form-POST + {"url":"..."} decode used
// by both Checkout and Billing Portal session creation.
func (c *stripeClient) postForSessionURL(ctx context.Context, path string, form url.Values) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+path, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Authorization", "Bearer "+c.secretKey)

	resp, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("stripe: %s %s: status %d: %s", http.MethodPost, path, resp.StatusCode, string(body))
	}
	var out struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", fmt.Errorf("stripe: %s %s: parse response: %w", http.MethodPost, path, err)
	}
	return out.URL, nil
}
