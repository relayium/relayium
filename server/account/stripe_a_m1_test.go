package account

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// Audit 2026-09-28 A-M1: with an empty (or whitespace-only) webhook secret the
// HMAC key is predictable, so anyone can "sign" an event. Such a signature must
// be refused by the verifier and, end to end, by the webhook handler, before any
// event claim, customer binding, entitlement change or Stripe API call.

func TestVerifyWebhookRefusesUnsetSecret(t *testing.T) {
	body := `{"id":"evt_forged","type":"checkout.session.completed","data":{"object":{"customer":"cus_1"}}}`
	for _, secret := range []string{"", " ", "\t\n"} {
		c := NewStripeClient("sk_test", secret, "bpc_dedicated")
		sig := signStripe(secret, body, 1000)
		// A second v1 signed with the empty key must not help either.
		sig += "," + signStripe("", body, 1000)[len("t=1000,"):]
		if _, err := c.VerifyWebhook([]byte(body), sig, 1000); !errors.Is(err, ErrWebhookSecretUnset) {
			t.Fatalf("secret %q: err=%v, want ErrWebhookSecretUnset", secret, err)
		}
	}
}

// forgedGrantCase is one forged event sequence against a fresh server. With
// the configured secret the same sequence MUST reach a paid grant (positive
// control), so a refusal in the other cases is evidence, not an accident of
// fixture shape.
type forgedGrantCase struct {
	name     string
	prebind  bool // account already bound to the Stripe customer
	body     func(uid string) string
	customer string
}

var forgedGrantCases = []forgedGrantCase{
	{
		name:     "subscription update on a bound customer",
		prebind:  true,
		customer: "cus_forged_bound",
		body: func(string) string {
			return webhookEnv("customer.subscription.updated", "cus_forged_bound", "sub_forged_1", "", "active", "price_pro_m", 1700000000)
		},
	},
	{
		name:     "subscription update naming the account in metadata",
		customer: "cus_forged_meta",
		body: func(uid string) string {
			return webhookEnvWithMetadata("customer.subscription.updated", "cus_forged_meta", "sub_forged_2", "", "active", "price_pro_m", 1700000000, uid)
		},
	},
}

func runForgedGrant(t *testing.T, tc forgedGrantCase, secret string) (status int, planID string, bound bool) {
	t.Helper()
	ts, svc, store, mail := newBillingServer(t)
	svc.biller = newWebhookFixtureClient(secret)
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
	_ = loginCookie(t, ts, mail, "forged-grant@example.com")
	uid := mustUserID(t, store, "forged-grant@example.com")
	if tc.prebind {
		if err := store.SetUserStripeCustomer(context.Background(), uid, tc.customer); err != nil {
			t.Fatal(err)
		}
	}
	resp := postWebhook(t, ts, secret, tc.body(uid))
	resp.Body.Close()
	u, err := store.GetUserByID(context.Background(), uid)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	_, bound, err = store.GetUserByStripeCustomer(context.Background(), tc.customer)
	if err != nil {
		t.Fatalf("GetUserByStripeCustomer: %v", err)
	}
	return resp.StatusCode, u.PlanID, bound
}

func TestStripeWebhookForgedGrantPositiveControl(t *testing.T) {
	for _, tc := range forgedGrantCases {
		t.Run(tc.name, func(t *testing.T) {
			status, plan, bound := runForgedGrant(t, tc, "whsec_configured")
			if status != http.StatusOK || plan != "pro" || !bound {
				t.Fatalf("configured secret: status=%d plan=%q bound=%v, want 200/pro/bound — the fixture no longer reaches a grant, so the refusal tests prove nothing", status, plan, bound)
			}
		})
	}
}

func TestStripeWebhookRefusesUnsetSecretForgedGrant(t *testing.T) {
	for _, secret := range []string{"", " "} {
		for _, tc := range forgedGrantCases {
			t.Run(tc.name+"/secret="+secret, func(t *testing.T) {
				status, plan, bound := runForgedGrant(t, tc, secret)
				if status != http.StatusBadRequest {
					t.Fatalf("forged webhook: status %d, want 400", status)
				}
				if plan == "pro" {
					t.Fatal("forged webhook granted the paid plan")
				}
				if bound != tc.prebind {
					t.Fatalf("forged webhook changed the customer binding: bound=%v, want %v", bound, tc.prebind)
				}
			})
		}
	}
}

// The production-configured client (canonical refresh on) must refuse before
// it asks Stripe anything: a forged event may not even cause API traffic.
func TestStripeWebhookUnsetSecretMakesNoStripeCalls(t *testing.T) {
	var calls atomic.Int64
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		http.Error(w, "unexpected", http.StatusInternalServerError)
	}))
	defer api.Close()
	ts, svc, store, mail := newBillingServer(t)
	client := NewStripeClient("sk_test", "", "bpc_dedicated")
	client.base = api.URL
	svc.biller = client
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
	_ = loginCookie(t, ts, mail, "forged-nocall@example.com")
	uid := mustUserID(t, store, "forged-nocall@example.com")
	resp := postWebhook(t, ts, "", webhookEnv("checkout.session.completed", "cus_forged_nocall", "", uid, "", "", 0))
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("forged webhook: status %d, want 400", resp.StatusCode)
	}
	if n := calls.Load(); n != 0 {
		t.Fatalf("forged webhook caused %d Stripe API call(s), want 0", n)
	}
}
