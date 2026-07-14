package account

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"testing"
)

func signStripe(secret, payload string, ts int64) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(fmt.Sprintf("%d.%s", ts, payload)))
	return fmt.Sprintf("t=%d,v1=%s", ts, hex.EncodeToString(mac.Sum(nil)))
}

func TestVerifyWebhookAcceptsValidRejectsTampered(t *testing.T) {
	c := NewStripeClient("sk_test", "whsec_abc", "")
	body := `{"type":"checkout.session.completed","data":{"object":{"customer":"cus_1"}}}`
	sig := signStripe("whsec_abc", body, 1000)
	if _, err := c.VerifyWebhook([]byte(body), sig, 1000); err != nil {
		t.Fatalf("valid sig rejected: %v", err)
	}
	// tampered body
	if _, err := c.VerifyWebhook([]byte(body+" "), sig, 1000); err == nil {
		t.Fatal("tampered payload accepted")
	}
	// expired (>300s)
	if _, err := c.VerifyWebhook([]byte(body), sig, 1000+301); err == nil {
		t.Fatal("stale timestamp accepted")
	}
	// wrong secret
	bad := NewStripeClient("sk_test", "whsec_other", "")
	if _, err := bad.VerifyWebhook([]byte(body), sig, 1000); err == nil {
		t.Fatal("wrong-secret sig accepted")
	}
}

func TestVerifyWebhookMultipleV1OneValid(t *testing.T) {
	c := NewStripeClient("sk_test", "whsec_abc", "")
	body := `{"type":"customer.subscription.deleted","data":{"object":{"customer":"cus_9","status":"canceled"}}}`
	good := signStripe("whsec_abc", body, 2000) // "t=2000,v1=<good>"
	multi := good + ",v1=deadbeef"
	if _, err := c.VerifyWebhook([]byte(body), multi, 2000); err != nil {
		t.Fatalf("one valid v1 among many should pass: %v", err)
	}
}

func TestVerifyWebhookParsesEventProjection(t *testing.T) {
	c := NewStripeClient("sk_test", "whsec_abc", "")
	body := `{"type":"checkout.session.completed","data":{"object":{"customer":"cus_1","subscription":"sub_1","client_reference_id":"user_42"}}}`
	ev, err := c.VerifyWebhook([]byte(body), signStripe("whsec_abc", body, 3000), 3000)
	if err != nil {
		t.Fatal(err)
	}
	if ev.Type != "checkout.session.completed" || ev.CustomerID != "cus_1" || ev.ClientRefUserID != "user_42" {
		t.Fatalf("bad projection: %+v", ev)
	}
}

func TestVerifyWebhookMissingHeaderRejected(t *testing.T) {
	c := NewStripeClient("sk_test", "whsec_abc", "")
	body := `{"type":"checkout.session.completed","data":{"object":{"customer":"cus_1"}}}`
	if _, err := c.VerifyWebhook([]byte(body), "", 1000); err == nil {
		t.Fatal("missing header accepted")
	}
	if _, err := c.VerifyWebhook([]byte(body), "t=1000", 1000); err == nil {
		t.Fatal("missing v1 accepted")
	}
	if _, err := c.VerifyWebhook([]byte(body), "v1=deadbeef", 1000); err == nil {
		t.Fatal("missing t accepted")
	}
	if _, err := c.VerifyWebhook([]byte(body), "t=notanumber,v1=deadbeef", 1000); err == nil {
		t.Fatal("non-numeric t accepted")
	}
}

func TestVerifyWebhookSubscriptionProjection(t *testing.T) {
	c := NewStripeClient("sk_test", "whsec_abc", "")
	body := `{"type":"customer.subscription.updated","data":{"object":{"customer":"cus_5","status":"active","current_period_end":1700000000,"items":{"data":[{"price":{"id":"price_pro_monthly"}}]}}}}`
	ev, err := c.VerifyWebhook([]byte(body), signStripe("whsec_abc", body, 4000), 4000)
	if err != nil {
		t.Fatal(err)
	}
	if ev.Type != "customer.subscription.updated" || ev.CustomerID != "cus_5" || ev.Status != "active" ||
		ev.PriceID != "price_pro_monthly" || ev.CurrentPeriodEnd != 1700000000 {
		t.Fatalf("bad subscription projection: %+v", ev)
	}
	// client_reference_id absent on subscription events must not panic and stays zero value.
	if ev.ClientRefUserID != "" {
		t.Fatalf("unexpected ClientRefUserID: %q", ev.ClientRefUserID)
	}
}

func TestVerifyWebhookNoItemsNoPanic(t *testing.T) {
	c := NewStripeClient("sk_test", "whsec_abc", "")
	// checkout.session has no items at all -- must not panic, PriceID stays "".
	body := `{"type":"checkout.session.completed","data":{"object":{"customer":"cus_1"}}}`
	ev, err := c.VerifyWebhook([]byte(body), signStripe("whsec_abc", body, 5000), 5000)
	if err != nil {
		t.Fatal(err)
	}
	if ev.PriceID != "" {
		t.Fatalf("expected empty PriceID, got %q", ev.PriceID)
	}
}
