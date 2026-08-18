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

func seedTerminalInvoiceDeletion(t *testing.T, store *SQLiteStore, subject, customer, paymentIntent string) {
	seedTerminalInvoiceDeletionEpoch(t, store, subject, customer, "delete-"+subject, "epoch-"+subject, "", 1, paymentIntent)
}

func seedTerminalInvoiceDeletionEpoch(t *testing.T, store *SQLiteStore, subject, customer, deletionID, epoch, subscription string, cutoff int64, paymentIntent string) {
	t.Helper()
	p := BillingDeletionProgress{Version: billingDeletionProgressVersion, Customers: []string{customer}, Resources: map[string]BillingDeletionResource{
		"payment_intent:" + paymentIntent: {
			Kind: "payment_intent", ID: paymentIntent, PaymentIntentID: paymentIntent,
			CustomerID: customer, Status: "observed",
		},
	}}
	if subscription != "" {
		p.add(BillingDeletionResource{Kind: "subscription", ID: subscription, CustomerID: customer, Status: "observed"})
	}
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`INSERT OR IGNORE INTO stripe_customer_history(user_id,customer_id,created_at) VALUES(?,?,1)`, subject, customer); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`INSERT OR IGNORE INTO billing_deletion_holds(billing_subject_id,email_hmac,provider,created_at,expires_at,review_at,subject_released_at) VALUES(?,X'01','stripe',1,1,1,1)`, subject); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,customer_id,subscription_id,idempotency_key,state,created_at,updated_at,generation,progress_json,terminal_at,mode,deletion_epoch,cutoff_at) VALUES(?,?, 'stripe',?,?,?,'terminal',?,?,(SELECT COALESCE(MAX(generation),0)+1 FROM billing_cancellation_outbox WHERE billing_subject_id=?),?,?,'account_deletion',?,?)`,
		deletionID, subject, customer, subscription, "delete-key-"+deletionID, cutoff, cutoff, subject, string(raw), cutoff, epoch, cutoff); err != nil {
		t.Fatal(err)
	}
}

func assertPaidInvoiceExactJournal(t *testing.T, store *SQLiteStore, subject, invoice, paymentIntent, charge string) {
	t.Helper()
	var raw string
	if err := store.db.QueryRow(`SELECT progress_json FROM billing_cancellation_outbox WHERE billing_subject_id=? AND mode='exact_compensation' AND state='pending'`, subject).Scan(&raw); err != nil {
		t.Fatalf("exact compensation journal: %v", err)
	}
	p, err := decodeDeletionProgressStrict(raw)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"invoice:" + invoice, "payment_intent:" + paymentIntent} {
		if _, ok := p.Resources[key]; !ok {
			t.Fatalf("missing %s in paid-invoice journal: %+v", key, p.Resources)
		}
	}
	if charge != "" {
		if _, ok := p.Resources["charge:"+charge]; !ok {
			t.Fatalf("missing charge:%s in paid-invoice journal: %+v", charge, p.Resources)
		}
	}
	for _, resource := range p.Resources {
		if resource.SuccessAt != 0 {
			t.Fatalf("webhook fabricated canonical paid_at: %+v", resource)
		}
	}
}

func paidInvoiceBody(id, customer, subscription, paymentIntent, charge, userID string) string {
	metadata := "null"
	if userID != "" {
		metadata = fmt.Sprintf(`{"user_id":%q}`, userID)
	}
	return fmt.Sprintf(`{"id":"evt_%s","type":"invoice.paid","created":110,"livemode":false,"data":{"object":{"id":%q,"object":"invoice","customer":%q,"subscription":%q,"payment_intent":%q,"charge":%q,"status":"paid","metadata":%s}}}`,
		id, id, customer, subscription, paymentIntent, charge, metadata)
}

func TestPaidInvoiceIsJournaledBeforeCanonicalOrAuthorityGates(t *testing.T) {
	t.Run("canonical subscription missing", func(t *testing.T) {
		ts, svc, store, mail := newBillingServer(t)
		secret := "whsec_paid_missing"
		stripe := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/v1/subscriptions/sub_old" {
				http.Error(w, "unexpected", http.StatusBadRequest)
				return
			}
			http.Error(w, `{"error":{"message":"gone"}}`, http.StatusNotFound)
		}))
		defer stripe.Close()
		client := NewStripeClient("sk_test", secret, "")
		client.base, client.http = stripe.URL, stripe.Client()
		svc.biller = client
		loginCookie(t, ts, mail, "paid-missing@example.test")
		uid := mustUserID(t, store, "paid-missing@example.test")
		seedTerminalInvoiceDeletion(t, store, uid, "cus_paid_missing", "pi_paid_missing")
		resp := postWebhook(t, ts, secret, paidInvoiceBody("in_paid_missing", "cus_paid_missing", "sub_old", "pi_paid_missing", "ch_paid_missing", uid))
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status=%d", resp.StatusCode)
		}
		assertPaidInvoiceExactJournal(t, store, uid, "in_paid_missing", "pi_paid_missing", "ch_paid_missing")
	})

	t.Run("purged subject and invoice without subscription", func(t *testing.T) {
		ts, svc, store, _ := newBillingServer(t)
		secret := "whsec_paid_tombstone"
		svc.biller = newWebhookFixtureClient(secret)
		seedTerminalInvoiceDeletion(t, store, "purged-subject", "cus_paid_tombstone", "pi_paid_tombstone")
		resp := postWebhook(t, ts, secret, paidInvoiceBody("in_paid_tombstone", "cus_paid_tombstone", "", "pi_paid_tombstone", "", ""))
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status=%d", resp.StatusCode)
		}
		assertPaidInvoiceExactJournal(t, store, "purged-subject", "in_paid_tombstone", "pi_paid_tombstone", "")
	})

	for _, provider := range []string{SourceAdmin, ProviderApple} {
		t.Run(provider+" authority conflict", func(t *testing.T) {
			ts, svc, store, mail := newBillingServer(t)
			secret := "whsec_paid_conflict_" + provider
			svc.biller = newWebhookFixtureClient(secret)
			loginCookie(t, ts, mail, "paid-"+provider+"@example.test")
			uid := mustUserID(t, store, "paid-"+provider+"@example.test")
			if provider == SourceAdmin {
				mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true})
				if err := store.SetUserPlanAdmin(context.Background(), uid, "pro", 1); err != nil {
					t.Fatal(err)
				}
			} else if _, err := store.AcquireBillingAuthority(context.Background(), BillingAuthorityRequest{
				UserID: uid, Provider: ProviderApple, ExternalScope: testBundleIOS,
				AppleAccountToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Now: 1,
			}); err != nil {
				t.Fatal(err)
			}
			seedTerminalInvoiceDeletion(t, store, uid, "cus_paid_"+provider, "pi_paid_"+provider)
			resp := postWebhook(t, ts, secret, paidInvoiceBody("in_paid_"+provider, "cus_paid_"+provider, "sub_paid_"+provider, "pi_paid_"+provider, "ch_paid_"+provider, uid))
			resp.Body.Close()
			if resp.StatusCode != http.StatusInternalServerError {
				t.Fatalf("status=%d, want 500 authority conflict", resp.StatusCode)
			}
			assertPaidInvoiceExactJournal(t, store, uid, "in_paid_"+provider, "pi_paid_"+provider, "ch_paid_"+provider)
		})
	}
}

func TestPaidInvoiceMissingIdentityFailsBeforeAcknowledgement(t *testing.T) {
	for _, tc := range []struct{ name, invoice, customer string }{
		{name: "invoice", customer: "cus_missing_invoice"},
		{name: "customer", invoice: "in_missing_customer"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ts, svc, _, _ := newBillingServer(t)
			secret := "whsec_missing_" + tc.name
			svc.biller = newWebhookFixtureClient(secret)
			resp := postWebhook(t, ts, secret, paidInvoiceBody(tc.invoice, tc.customer, "", "", "", ""))
			resp.Body.Close()
			if resp.StatusCode != http.StatusInternalServerError {
				t.Fatalf("status=%d, want retryable 500", resp.StatusCode)
			}
		})
	}
}

func TestPaidInvoiceWithoutChainUsesCanonicalDeletionEpoch(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_paid_canonical"
	var invoiceGets int
	stripe := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/invoices/in_late" {
			http.Error(w, "unexpected", http.StatusBadRequest)
			return
		}
		invoiceGets++
		io.WriteString(w, `{"id":"in_late","status":"paid","customer":"cus_late","subscription":"sub_old","payment_intent":"pi_late","charge":"ch_late","created":90,"status_transitions":{"paid_at":110}}`)
	}))
	defer stripe.Close()
	client := NewStripeClient("sk_test", secret, "")
	client.base, client.http = stripe.URL, stripe.Client()
	svc.biller = client
	loginCookie(t, ts, mail, "late-paid@example.test")
	uid := mustUserID(t, store, "late-paid@example.test")
	seedTerminalInvoiceDeletionEpoch(t, store, uid, "cus_late", "delete-late", "epoch-late", "sub_old", 100, "pi_unrelated")
	resp := postWebhook(t, ts, secret, paidInvoiceBody("in_late", "cus_late", "", "", "", ""))
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || invoiceGets != 1 {
		t.Fatalf("status=%d canonicalGets=%d", resp.StatusCode, invoiceGets)
	}
	assertPaidInvoiceExactJournal(t, store, uid, "in_late", "pi_late", "ch_late")
}

func TestPaidInvoiceCanonicalEpochAmbiguityIsRetryable(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_paid_ambiguous"
	stripe := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"id":"in_ambiguous","status":"paid","customer":"cus_ambiguous","subscription":"sub_shared","payment_intent":"pi_new","created":90,"status_transitions":{"paid_at":130}}`)
	}))
	defer stripe.Close()
	client := NewStripeClient("sk_test", secret, "")
	client.base, client.http = stripe.URL, stripe.Client()
	svc.biller = client
	loginCookie(t, ts, mail, "ambiguous-paid@example.test")
	uid := mustUserID(t, store, "ambiguous-paid@example.test")
	seedTerminalInvoiceDeletionEpoch(t, store, uid, "cus_ambiguous", "delete-a", "epoch-a", "sub_shared", 100, "pi_old_a")
	seedTerminalInvoiceDeletionEpoch(t, store, uid, "cus_ambiguous", "delete-b", "epoch-b", "sub_shared", 120, "pi_old_b")
	resp := postWebhook(t, ts, secret, paidInvoiceBody("in_ambiguous", "cus_ambiguous", "", "", "", ""))
	resp.Body.Close()
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status=%d, want retryable 500", resp.StatusCode)
	}
	var exact int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM billing_cancellation_outbox WHERE billing_subject_id=? AND mode='exact_compensation'`, uid).Scan(&exact); err != nil || exact != 0 {
		t.Fatalf("exact=%d err=%v", exact, err)
	}
}

func TestPaidInvoiceForOrdinarySubjectDoesNotFetchCanonicalInvoice(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_paid_ordinary"
	var invoiceGets int
	stripe := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		invoiceGets++
		http.Error(w, "unexpected", http.StatusInternalServerError)
	}))
	defer stripe.Close()
	client := NewStripeClient("sk_test", secret, "")
	client.base, client.http = stripe.URL, stripe.Client()
	svc.biller = client
	loginCookie(t, ts, mail, "ordinary-paid@example.test")
	uid := mustUserID(t, store, "ordinary-paid@example.test")
	if _, err := store.db.Exec(`INSERT INTO stripe_customer_history(user_id,customer_id,created_at) VALUES(?,'cus_ordinary',1)`, uid); err != nil {
		t.Fatal(err)
	}
	resp := postWebhook(t, ts, secret, paidInvoiceBody("in_ordinary", "cus_ordinary", "", "", "", ""))
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || invoiceGets != 0 {
		t.Fatalf("status=%d canonicalGets=%d", resp.StatusCode, invoiceGets)
	}
}

func TestNewStripeDeletionRequiresHistoricalAuditBeforeQuiet(t *testing.T) {
	svc, store, _, user, token := deletionFixture(t, "historical-audit@example.test")
	seedStripeDeletion(t, store, user)
	if err := svc.ConfirmAccountDeletion(context.Background(), token); err != nil {
		t.Fatal(err)
	}
	var raw string
	if err := store.db.QueryRow(`SELECT progress_json FROM billing_cancellation_outbox WHERE billing_subject_id=? AND mode='account_deletion'`, user.ID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	progress, err := decodeDeletionProgressStrict(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !progress.HistoricalAuditRequired || progress.terminal(time.Now().Unix()+2*86400) {
		t.Fatalf("new deletion skipped historical audit: %+v", progress)
	}
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
		paidInvoiceBody("in_one_off", "cus_one_off", "", "pi_one_off", "ch_one_off", ""))
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
	body := paidInvoiceBody("in_panic", "cus_panic", "sub_panic", "pi_panic", "ch_panic", uid)
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
