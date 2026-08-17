package account

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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

func TestInvoiceWithoutSubscriptionCannotMutateOrRevokeCanonicalEntitlement(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_invoice_without_subscription"
	svc.biller = NewStripeClient("sk_test", secret, "")
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
	loginCookie(t, ts, mail, "one-off-invoice@example.com")
	uid := mustUserID(t, store, "one-off-invoice@example.com")
	if err := store.SetUserStripeCustomer(context.Background(), uid, "cus_one_off"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetUserStripeSubscription(context.Background(), uid, "sub_canonical"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetUserSubscription(context.Background(), uid, "pro", "active", 4000,
		"stripe", "monthly", 2000, 0); err != nil {
		t.Fatal(err)
	}
	before, err := store.GetUserByID(context.Background(), uid)
	if err != nil {
		t.Fatal(err)
	}
	resp := postWebhook(t, ts, secret,
		webhookEnv("invoice.paid", "cus_one_off", "", "", "canceled", "", 9000))
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("invoice without subscription = %d, want ACK", resp.StatusCode)
	}
	u, err := store.GetUserByID(context.Background(), uid)
	if err != nil {
		t.Fatal(err)
	}
	if u.PlanID != before.PlanID || u.SubscriptionStatus != before.SubscriptionStatus ||
		u.BillingCycle != before.BillingCycle || u.SubscriptionEnd != before.SubscriptionEnd ||
		u.StripeSubscriptionID != before.StripeSubscriptionID {
		t.Fatalf("non-subscription invoice mutated canonical entitlement: before=%+v after=%+v", before, u)
	}
}

type panicRoundTripper struct{}

func (panicRoundTripper) RoundTrip(*http.Request) (*http.Response, error) {
	panic("injected canonical refresh panic")
}

func TestWebhookPanicAfterClaimIsFailedAndCanonicalRetryConverges(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_post_claim_panic"
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true,
		StripePriceMonthlyID: "price_pro_m"})
	loginCookie(t, ts, mail, "panic-retry@example.com")
	uid := mustUserID(t, store, "panic-retry@example.com")
	if err := store.SetUserStripeCustomer(context.Background(), uid, "cus_panic"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetUserStripeSubscription(context.Background(), uid, "sub_panic"); err != nil {
		t.Fatal(err)
	}

	client := NewStripeClient("sk_test", secret, "")
	client.canonicalWebhookRefresh = true
	client.http = &http.Client{Transport: panicRoundTripper{}}
	svc.biller = client
	body := webhookEnv("invoice.paid", "cus_panic", "sub_panic", "", "", "", 0)
	eventID := eventIDFromBody(t, body)

	resp := postWebhook(t, ts, secret, body)
	failedBody, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode < 500 || resp.StatusCode > 599 {
		t.Fatalf("panic response = %d, want 5xx", resp.StatusCode)
	}
	if strings.Contains(strings.ToLower(string(failedBody)), "ok") ||
		resp.Header.Get("X-Relayium-Test") != "" {
		t.Fatalf("panic leaked buffered success: headers=%v body=%q", resp.Header, failedBody)
	}
	var status string
	var attempts int
	if err := store.db.QueryRow(`SELECT status, attempts FROM stripe_webhook_events WHERE event_id=?`,
		eventID).Scan(&status, &attempts); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || attempts != 1 {
		t.Fatalf("panic ledger = status %q attempts %d, want failed/1", status, attempts)
	}

	stripe := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"id":"sub_panic","status":"active","current_period_end":5000,"items":{"data":[{"price":{"id":"price_pro_m"}}]}}`)
	}))
	defer stripe.Close()
	client.base = stripe.URL
	client.http = stripe.Client()
	retry := postWebhook(t, ts, secret, body)
	retryBody, err := io.ReadAll(retry.Body)
	retry.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if retry.StatusCode != http.StatusOK {
		t.Fatalf("canonical retry = %d body %q", retry.StatusCode, retryBody)
	}
	if err := store.db.QueryRow(`SELECT status, attempts FROM stripe_webhook_events WHERE event_id=?`,
		eventID).Scan(&status, &attempts); err != nil {
		t.Fatal(err)
	}
	if status != "processed" || attempts != 2 {
		t.Fatalf("retry ledger = status %q attempts %d, want processed/2", status, attempts)
	}
	u, err := store.GetUserByID(context.Background(), uid)
	if err != nil {
		t.Fatal(err)
	}
	if u.PlanID != "pro" || u.SubscriptionStatus != "active" ||
		u.StripeSubscriptionID != "sub_panic" || u.SubscriptionEnd != 5000 {
		t.Fatalf("canonical retry did not converge: %+v", u)
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

func TestScheduleUpdateABABUsesCanonicalPostconditionAcrossAmbiguousResponses(t *testing.T) {
	target := "price_old"
	var posts int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/subscriptions":
			fmt.Fprint(w, `{"data":[{"id":"sub_1","status":"active","schedule":"sched_1","items":{"data":[{"price":{"id":"price_current"}}]}}]}`)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/subscription_schedules/sched_1":
			fmt.Fprintf(w, `{"id":"sched_1","phases":[{"start_date":100,"end_date":200,"items":[{"price":"price_current"}]},{"start_date":200,"end_date":0,"items":[{"price":%q}]}]}`, target)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/subscription_schedules/sched_1":
			posts++
			if got := r.Header.Get("Idempotency-Key"); got != "" {
				t.Fatalf("declarative update must not use replay-prone key %q", got)
			}
			if err := r.ParseForm(); err != nil {
				t.Fatal(err)
			}
			target = r.Form.Get("phases[1][items][0][price]")
			http.Error(w, "ambiguous response after apply", http.StatusInternalServerError)
		default:
			t.Fatalf("unexpected %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()
	c := NewStripeClient("sk_test", "whsec", "")
	c.base = srv.URL
	c.now = func() time.Time { return time.Unix(150, 0) }
	for _, next := range []string{"price_a", "price_b", "price_a", "price_b"} {
		if err := c.ScheduleDowngrade(context.Background(), "cus_1", next); err != nil {
			t.Fatal(err)
		}
	}
	if posts != 4 || target != "price_b" {
		t.Fatalf("ABAB did not converge: posts=%d target=%q", posts, target)
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

func TestScheduleReleaseConvergesAfterAmbiguousResponse(t *testing.T) {
	released := false
	var releaseKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/subscriptions":
			fmt.Fprint(w, `{"data":[{"id":"sub_1","status":"active","schedule":"sched_1","items":{"data":[{"price":{"id":"price_current"}}]}}]}`)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/subscription_schedules/sched_1/release":
			releaseKey = r.Header.Get("Idempotency-Key")
			released = true
			http.Error(w, "connection failed after Stripe applied release", http.StatusInternalServerError)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/subscription_schedules/sched_1":
			status := "active"
			if released {
				status = "released"
			}
			fmt.Fprintf(w, `{"id":"sched_1","status":%q}`, status)
		default:
			t.Fatalf("unexpected %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()
	c := NewStripeClient("sk_test", "whsec", "")
	c.base = srv.URL
	if err := c.ReleaseSchedule(context.Background(), "cus_1"); err != nil {
		t.Fatalf("canonical terminal state must resolve ambiguous response: %v", err)
	}
	if releaseKey == "" || !released {
		t.Fatalf("release intent was not stable or applied: key=%q released=%v", releaseKey, released)
	}
}

func TestScheduleReleaseThenRescheduleRecoversFromVerbatimCreateReplay(t *testing.T) {
	var createKeys []string
	responseByKey := map[string]string{}
	canonicalStatus := map[string]string{}
	canonicalTarget := map[string]string{}
	currentSchedule := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/subscriptions":
			fmt.Fprintf(w, `{"data":[{"id":"sub_1","status":"active","schedule":%q,"latest_invoice":"in_1","current_period_end":200,"items":{"data":[{"price":{"id":"price_current"}}]}}]}`, currentSchedule)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/subscription_schedules":
			key := r.Header.Get("Idempotency-Key")
			createKeys = append(createKeys, key)
			body, replay := responseByKey[key]
			if !replay {
				id := "sched_live"
				if len(responseByKey) > 0 {
					id = "sched_new"
				}
				body = fmt.Sprintf(`{"id":%q,"status":"active"}`, id)
				responseByKey[key] = body
				canonicalStatus[id] = "active"
				currentSchedule = id
			}
			// Stripe replays the original response body byte-for-byte for a key.
			fmt.Fprint(w, body)
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/subscription_schedules/"):
			id := strings.TrimPrefix(r.URL.Path, "/v1/subscription_schedules/")
			status, ok := canonicalStatus[id]
			if !ok {
				t.Fatalf("unknown canonical schedule %q", id)
			}
			phase1 := ""
			if canonicalTarget[id] != "" {
				phase1 = fmt.Sprintf(`,{"start_date":200,"end_date":0,"items":[{"price":%q}]}`, canonicalTarget[id])
			}
			fmt.Fprintf(w, `{"id":%q,"status":%q,"phases":[{"start_date":100,"end_date":200,"items":[{"price":"price_current"}]}%s]}`, id, status, phase1)
		case r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/v1/subscription_schedules/") && !strings.HasSuffix(r.URL.Path, "/release"):
			if err := r.ParseForm(); err != nil {
				t.Fatal(err)
			}
			id := strings.TrimPrefix(r.URL.Path, "/v1/subscription_schedules/")
			canonicalTarget[id] = r.Form.Get("phases[1][items][0][price]")
			fmt.Fprintf(w, `{"id":%q}`, id)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/release"):
			id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/v1/subscription_schedules/"), "/release")
			canonicalStatus[id] = "released"
			currentSchedule = ""
			fmt.Fprintf(w, `{"id":%q,"status":"released"}`, id)
		default:
			t.Fatalf("unexpected %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()
	c := NewStripeClient("sk_test", "whsec", "")
	c.base = srv.URL
	if err := c.ScheduleDowngrade(context.Background(), "cus_1", "price_target"); err != nil {
		t.Fatal(err)
	}
	if err := c.ReleaseSchedule(context.Background(), "cus_1"); err != nil {
		t.Fatal(err)
	}
	if err := c.ScheduleDowngrade(context.Background(), "cus_1", "price_target"); err != nil {
		t.Fatal(err)
	}
	if len(createKeys) != 3 || createKeys[0] != createKeys[1] || createKeys[2] == createKeys[0] {
		t.Fatalf("released replay must advance to a new deterministic generation: %q", createKeys)
	}
	if currentSchedule != "sched_new" || canonicalTarget["sched_new"] != "price_target" {
		t.Fatalf("reschedule did not converge: current=%q target=%q", currentSchedule, canonicalTarget["sched_new"])
	}
}

func TestSchedulePastWaitingPhaseIsReleasedAndRecreated(t *testing.T) {
	var released bool
	var updatedOld bool
	newTarget := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/subscriptions":
			fmt.Fprint(w, `{"data":[{"id":"sub_1","status":"active","schedule":"sched_old","latest_invoice":"in_2","current_period_end":300,"items":{"data":[{"price":{"id":"price_current"}}]}}]}`)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/subscription_schedules/sched_old":
			if released {
				fmt.Fprint(w, `{"id":"sched_old","status":"released","phases":[]}`)
				return
			}
			fmt.Fprint(w, `{"id":"sched_old","status":"active","current_phase":{"start_date":200,"end_date":300},"phases":[{"start_date":100,"end_date":200,"items":[{"price":"price_current"}]},{"start_date":200,"end_date":0,"items":[{"price":"price_previous_target"}]}]}`)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/subscription_schedules/sched_new":
			phase1 := ""
			if newTarget != "" {
				phase1 = fmt.Sprintf(`,{"start_date":300,"end_date":0,"items":[{"price":%q}]}`, newTarget)
			}
			fmt.Fprintf(w, `{"id":"sched_new","status":"active","phases":[{"start_date":200,"end_date":300,"items":[{"price":"price_current"}]}%s]}`, phase1)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/subscription_schedules/sched_old/release":
			released = true
			fmt.Fprint(w, `{"id":"sched_old","status":"released"}`)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/subscription_schedules":
			fmt.Fprint(w, `{"id":"sched_new","status":"active","phases":[{"start_date":200,"end_date":300,"items":[{"price":"price_current"}]}]}`)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/subscription_schedules/sched_old":
			updatedOld = true
		case r.Method == http.MethodPost && r.URL.Path == "/v1/subscription_schedules/sched_new":
			if err := r.ParseForm(); err != nil {
				t.Fatal(err)
			}
			newTarget = r.Form.Get("phases[1][items][0][price]")
			fmt.Fprint(w, `{"id":"sched_new"}`)
		default:
			t.Fatalf("unexpected %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()
	c := NewStripeClient("sk_test", "whsec", "")
	c.base = srv.URL
	c.now = func() time.Time { return time.Unix(250, 0) }
	if err := c.ScheduleDowngrade(context.Background(), "cus_1", "price_target"); err != nil {
		t.Fatal(err)
	}
	if !released || updatedOld {
		t.Fatalf("past schedule release=%v updatedOld=%v", released, updatedOld)
	}
}
