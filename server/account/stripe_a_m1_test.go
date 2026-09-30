package account

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"
)

// Audit 2026-09-28 A-M1: with an empty webhook secret the HMAC key is the
// empty string, which anyone can compute. A payload "signed" that way must be
// refused, both by the verifier and end to end by the webhook handler.
func TestVerifyWebhookRefusesEmptySecret(t *testing.T) {
	c := NewStripeClient("sk_test", "", "bpc_dedicated")
	body := `{"id":"evt_forged","type":"checkout.session.completed","data":{"object":{"customer":"cus_1"}}}`
	sig := signStripe("", body, 1000)
	_, err := c.VerifyWebhook([]byte(body), sig, 1000)
	if !errors.Is(err, ErrWebhookSecretUnset) {
		t.Fatalf("empty-secret signature: err=%v, want ErrWebhookSecretUnset", err)
	}
}

// The adversarial path: a forger who knows only that the deployment has no
// webhook secret signs a paid-subscription event for a victim-chosen account.
// It must neither bind a customer nor grant the plan.
func TestStripeWebhookRefusesEmptySecretForgedPaidGrant(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	svc.biller = newWebhookFixtureClient("")
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
	_ = loginCookie(t, ts, mail, "forged-grant@example.com")
	uid := mustUserID(t, store, "forged-grant@example.com")

	for _, body := range []string{
		webhookEnv("checkout.session.completed", "cus_forged", "", uid, "", "", 0),
		webhookEnv("customer.subscription.updated", "cus_forged", "sub_forged", uid, "active", "price_pro_m", time.Now().Add(30*24*time.Hour).Unix()),
	} {
		resp := postWebhook(t, ts, "", body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("forged empty-secret webhook: status %d, want 400", resp.StatusCode)
		}
	}
	if _, ok, err := store.GetUserByStripeCustomer(context.Background(), "cus_forged"); err != nil || ok {
		t.Fatalf("forged event bound a Stripe customer: ok=%v err=%v", ok, err)
	}
	u, err := store.GetUserByID(context.Background(), uid)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if u.PlanID != "" && u.PlanID != "free" {
		t.Fatalf("forged event granted plan %q", u.PlanID)
	}
}
