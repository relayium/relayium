package account

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func eventIDFromBody(t *testing.T, body string) string {
	t.Helper()
	var envelope struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal([]byte(body), &envelope); err != nil {
		t.Fatal(err)
	}
	return envelope.ID
}

func TestWebhookRejectsEmptyEventID(t *testing.T) {
	ts, svc, _, _ := newBillingServer(t)
	secret := "whsec_empty_id"
	svc.biller = NewStripeClient("sk_test", secret, "")
	body := strings.Replace(webhookEnv("checkout.session.completed", "cus_x", "", "", "", "", 0),
		`"id":"`+eventIDFromBody(t, webhookEnv("checkout.session.completed", "cus_x", "", "", "", "", 0))+`",`, "", 1)
	resp := postWebhook(t, ts, secret, body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("empty event id = %d, want 400", resp.StatusCode)
	}
}

func TestWebhookInFlightReturnsRetryableStatus(t *testing.T) {
	ts, svc, store, _ := newBillingServer(t)
	secret := "whsec_inflight"
	svc.biller = NewStripeClient("sk_test", secret, "")
	body := webhookEnv("checkout.session.completed", "cus_x", "", "", "", "", 0)
	if claim, err := store.ClaimStripeWebhookEvent(context.Background(), eventIDFromBody(t, body),
		"checkout.session.completed", time.Now().Unix()); err != nil || claim.State != StripeWebhookClaimed {
		t.Fatalf("preclaim = %v, %v", claim, err)
	}
	resp := postWebhook(t, ts, secret, body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("in-flight delivery = %d, want 503", resp.StatusCode)
	}
}

type finishFailStore struct{ Store }

func (finishFailStore) FinishStripeWebhookEvent(context.Context, string, int64, bool, string, int64) error {
	return errors.New("injected finish failure")
}

func TestWebhookDoesNotFlushSuccessBeforeLedgerFinish(t *testing.T) {
	ts, svc, _, _ := newBillingServer(t)
	secret := "whsec_finish"
	svc.biller = NewStripeClient("sk_test", secret, "")
	svc.store = finishFailStore{Store: svc.store}
	resp := postWebhook(t, ts, secret,
		webhookEnv("checkout.session.completed", "cus_x", "", "", "", "", 0))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("finish failure = %d, want 500 rather than buffered 200", resp.StatusCode)
	}
}

func TestFailedInvoiceAfterPaidKeepsCanonicalActiveState(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_failed_after_paid"
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
	loginCookie(t, ts, mail, "failed-after-paid@example.com")
	uid := mustUserID(t, store, "failed-after-paid@example.com")
	if err := store.SetUserStripeCustomer(context.Background(), uid, "cus_paid"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetUserStripeSubscription(context.Background(), uid, "sub_paid"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetUserSubscription(context.Background(), uid, "pro", "active", 2000, "stripe", "monthly", time.Now().Unix(), 0); err != nil {
		t.Fatal(err)
	}
	stripe := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"id":"sub_paid","status":"active","current_period_end":3000,"items":{"data":[{"price":{"id":"price_pro_m"}}]}}`)
	}))
	defer stripe.Close()
	client := NewStripeClient("sk_test", secret, "")
	client.base = stripe.URL
	client.canonicalWebhookRefresh = true
	svc.biller = client
	resp := postWebhook(t, ts, secret,
		webhookEnv("invoice.payment_failed", "cus_paid", "sub_paid", "", "", "", 0))
	resp.Body.Close()
	u, _, _ := store.GetUserByStripeCustomer(context.Background(), "cus_paid")
	if u.PlanID != "pro" || u.SubscriptionStatus != "active" {
		t.Fatalf("late failed invoice overwrote canonical active state: plan=%q status=%q", u.PlanID, u.SubscriptionStatus)
	}
}

func TestOldDeletedDoesNotRevokeNewCanonicalSubscription(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_old_deleted"
	svc.biller = NewStripeClient("sk_test", secret, "")
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
	loginCookie(t, ts, mail, "old-deleted@example.com")
	uid := mustUserID(t, store, "old-deleted@example.com")
	if err := store.SetUserStripeCustomer(context.Background(), uid, "cus_new"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetUserStripeSubscription(context.Background(), uid, "sub_new"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetUserSubscription(context.Background(), uid, "pro", "active", 3000, "stripe", "monthly", time.Now().Unix(), 0); err != nil {
		t.Fatal(err)
	}
	resp := postWebhook(t, ts, secret,
		webhookEnv("customer.subscription.deleted", "cus_new", "sub_old", "", "canceled", "", 1000))
	resp.Body.Close()
	u, _, _ := store.GetUserByStripeCustomer(context.Background(), "cus_new")
	if u.PlanID != "pro" || u.SubscriptionStatus != "active" || u.StripeSubscriptionID != "sub_new" {
		t.Fatalf("old deletion revoked new canonical subscription: %+v", u)
	}
}

func TestScheduleUpdateKeyIncludesTargetAndExistingGeneration(t *testing.T) {
	var gets int
	var keys []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/subscriptions":
			fmt.Fprint(w, `{"data":[{"id":"sub_1","status":"active","schedule":"sched_1","items":{"data":[{"price":{"id":"price_current"}}]}}]}`)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/subscription_schedules/sched_1":
			gets++
			target := "price_b"
			if gets == 4 {
				target = "price_c"
			}
			fmt.Fprintf(w, `{"id":"sched_1","phases":[{"start_date":100,"end_date":200,"items":[{"price":"price_current"}]},{"start_date":200,"end_date":0,"items":[{"price":%q}]}]}`, target)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/subscription_schedules/sched_1":
			keys = append(keys, r.Header.Get("Idempotency-Key"))
			fmt.Fprint(w, `{"id":"sched_1"}`)
		default:
			t.Fatalf("unexpected %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()
	c := NewStripeClient("sk_test", "whsec", "")
	c.base = srv.URL
	for _, target := range []string{"price_a", "price_a", "price_d", "price_a"} {
		if err := c.ScheduleDowngrade(context.Background(), "cus_1", target); err != nil {
			t.Fatal(err)
		}
	}
	if len(keys) != 4 || keys[0] != keys[1] || keys[1] == keys[2] || keys[0] == keys[3] {
		t.Fatalf("keys must be stable for one intent and change with target or schedule state: %q", keys)
	}
}

func TestStripeWebhookWriterPreservesFirstStatusHeadersAndBody(t *testing.T) {
	tw := newStripeWebhookWriter()
	tw.Header().Set("X-Relayium-Test", "kept")
	tw.WriteHeader(http.StatusAccepted)
	if _, err := tw.Write([]byte("pending")); err != nil {
		t.Fatal(err)
	}
	tw.WriteHeader(http.StatusNoContent)
	recorder := httptest.NewRecorder()
	tw.flushTo(recorder)
	if recorder.Code != http.StatusAccepted || recorder.Header().Get("X-Relayium-Test") != "kept" || recorder.Body.String() != "pending" {
		t.Fatalf("buffered response = status %d header %q body %q", recorder.Code,
			recorder.Header().Get("X-Relayium-Test"), recorder.Body.String())
	}
}
