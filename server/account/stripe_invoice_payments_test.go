package account

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func dahliaMultiPaymentHandler(t *testing.T, includeSession bool) http.Handler {
	t.Helper()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Stripe-Version"); got != stripeAPIVersion {
			t.Errorf("Stripe-Version=%q", got)
		}
		switch r.URL.Path {
		case "/v1/checkout/sessions/cs_multi":
			if !includeSession {
				http.Error(w, "unexpected", http.StatusBadRequest)
				return
			}
			io.WriteString(w, `{"id":"cs_multi","customer":"cus_multi","subscription":"sub_multi","invoice":"in_multi","payment_status":"paid","client_reference_id":"subject","metadata":{"billing_attempt_id":"attempt"}}`)
		case "/v1/invoices/in_multi":
			io.WriteString(w, `{"id":"in_multi","status":"paid","customer":"cus_multi","parent":{"subscription_details":{"subscription":"sub_multi"}},"amount_paid":1000,"created":90,"status_transitions":{"paid_at":110}}`)
		case "/v1/invoice_payments":
			if r.URL.Query().Get("invoice") != "in_multi" || r.URL.Query().Get("status") != "paid" {
				t.Errorf("query=%v", r.URL.Query())
			}
			if r.URL.Query().Get("starting_after") == "" {
				io.WriteString(w, `{"data":[{"id":"inpay_a","invoice":"in_multi","status":"paid","amount_paid":400,"status_transitions":{"paid_at":105},"payment":{"type":"payment_intent","payment_intent":"pi_a"}}],"has_more":true}`)
			} else if r.URL.Query().Get("starting_after") == "inpay_a" {
				io.WriteString(w, `{"data":[{"id":"inpay_b","invoice":"in_multi","status":"paid","amount_paid":600,"status_transitions":{"paid_at":110},"payment":{"type":"payment_intent","payment_intent":"pi_b"}}],"has_more":false}`)
			} else {
				http.Error(w, "bad cursor", http.StatusBadRequest)
			}
		case "/v1/payment_intents/pi_a":
			io.WriteString(w, `{"id":"pi_a","customer":"cus_multi","status":"succeeded","latest_charge":"ch_a"}`)
		case "/v1/payment_intents/pi_b":
			io.WriteString(w, `{"id":"pi_b","customer":"cus_multi","status":"succeeded","latest_charge":"ch_b"}`)
		case "/v1/charges/ch_a":
			io.WriteString(w, `{"id":"ch_a","customer":"cus_multi","payment_intent":"pi_a","amount":400,"amount_refunded":0,"paid":true}`)
		case "/v1/charges/ch_b":
			io.WriteString(w, `{"id":"ch_b","customer":"cus_multi","payment_intent":"pi_b","amount":600,"amount_refunded":0,"paid":true}`)
		default:
			http.Error(w, "unexpected path", http.StatusBadRequest)
		}
	})
}

func TestCanonicalInvoicePaymentsPaginatesEveryPartialPayment(t *testing.T) {
	server := httptest.NewServer(dahliaMultiPaymentHandler(t, false))
	defer server.Close()
	client := NewStripeClient("sk_test", "whsec", "")
	client.base, client.http = server.URL, server.Client()
	invoice, err := client.canonicalInvoicePayments(context.Background(), "in_multi", "cus_multi", "sub_multi", true)
	if err != nil || len(invoice.Payments) != 2 || invoice.AmountPaid != 1000 || invoice.PaidAt != 110 {
		t.Fatalf("invoice=%+v err=%v", invoice, err)
	}
	if invoice.Payments[0].AmountPaid != 400 || invoice.Payments[1].AmountPaid != 600 {
		t.Fatalf("payments=%+v", invoice.Payments)
	}
}

func TestCanonicalInvoicePaymentPaginationAndIdentityFailClosed(t *testing.T) {
	for _, tc := range []struct {
		name string
		list func(url.Values) string
	}{
		{name: "empty page with has more", list: func(url.Values) string { return `{"data":[],"has_more":true}` }},
		{name: "paid amount without identity", list: func(url.Values) string { return `{"data":[],"has_more":false}` }},
		{name: "nonadvancing duplicate", list: func(q url.Values) string {
			return `{"data":[{"id":"inpay_same","invoice":"in_bad","status":"paid","amount_paid":500,"status_transitions":{"paid_at":110},"payment":{"type":"payment_intent","payment_intent":"pi_same"}}],"has_more":true}`
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/v1/invoices/in_bad":
					io.WriteString(w, `{"id":"in_bad","status":"paid","customer":"cus_bad","parent":{"subscription_details":{"subscription":"sub_bad"}},"amount_paid":500,"created":90}`)
				case "/v1/invoice_payments":
					io.WriteString(w, tc.list(r.URL.Query()))
				case "/v1/payment_intents/pi_same":
					io.WriteString(w, `{"id":"pi_same","customer":"cus_bad","status":"succeeded","latest_charge":"ch_same"}`)
				case "/v1/charges/ch_same":
					io.WriteString(w, `{"id":"ch_same","customer":"cus_bad","payment_intent":"pi_same","amount":500,"paid":true}`)
				default:
					http.Error(w, "unexpected", http.StatusBadRequest)
				}
			}))
			defer server.Close()
			client := NewStripeClient("sk_test", "whsec", "")
			client.base, client.http = server.URL, server.Client()
			if _, err := client.canonicalInvoicePayments(context.Background(), "in_bad", "cus_bad", "sub_bad", true); err == nil {
				t.Fatal("unsafe invoice payment list was accepted")
			}
		})
	}
}

func TestUnsupportedInvoicePaymentIdentityIsPreservedForManualReconciliation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/invoices/in_record":
			io.WriteString(w, `{"id":"in_record","status":"paid","customer":"cus_record","parent":{"subscription_details":{"subscription":"sub_record"}},"amount_paid":500,"created":90}`)
		case "/v1/invoice_payments":
			io.WriteString(w, `{"data":[{"id":"inpay_record","invoice":"in_record","status":"paid","amount_paid":500,"status_transitions":{"paid_at":110},"payment":{"type":"payment_record","payment_record":"pyr_1"}}],"has_more":false}`)
		default:
			http.Error(w, "unexpected", http.StatusBadRequest)
		}
	}))
	defer server.Close()
	client := NewStripeClient("sk_test", "whsec", "")
	client.base, client.http = server.URL, server.Client()
	invoice, err := client.canonicalInvoicePayments(context.Background(), "in_record", "cus_record", "sub_record", true)
	if err != nil || len(invoice.Payments) != 1 || invoice.Payments[0].PaymentRecordID != "pyr_1" || invoiceHasOneExclusivePaymentIntent(invoice) {
		t.Fatalf("invoice=%+v err=%v", invoice, err)
	}
	progress := BillingDeletionProgress{Customers: []string{"cus_record"}, Resources: map[string]BillingDeletionResource{"invoice:in_record": {Kind: "invoice", ID: "in_record", CustomerID: "cus_record"}}}
	got, err := client.ReconcileDeletionHazards(context.Background(), BillingCancellation{BillingSubjectID: "subject", CustomerID: "cus_record", CutoffAt: 100}, progress)
	if err == nil || !got.Resources["invoice:in_record"].Manual || got.Resources["invoice:in_record"].Status != "multiple_or_unsupported_invoice_payments" {
		t.Fatalf("progress=%+v err=%v", got, err)
	}
}

func TestCheckoutAndDeletionUseInvoicePaymentConstituents(t *testing.T) {
	server := httptest.NewServer(dahliaMultiPaymentHandler(t, true))
	defer server.Close()
	client := NewStripeClient("sk_test", "whsec", "")
	client.base, client.http = server.URL, server.Client()
	chain, err := client.canonicalCheckoutPaymentChain(context.Background(), "cs_multi")
	if err != nil || chain.InvoiceID != "in_multi" || len(chain.Payments) != 2 || chain.PaymentIntentID != "" || chain.ChargeID != "" {
		t.Fatalf("chain=%+v err=%v", chain, err)
	}
	progress := BillingDeletionProgress{Customers: []string{"cus_multi"}, Resources: map[string]BillingDeletionResource{
		"invoice:in_multi": {Kind: "invoice", ID: "in_multi", InvoiceID: "in_multi", CustomerID: "cus_multi", Status: "observed"},
	}}
	got, err := client.ReconcileDeletionHazards(context.Background(), BillingCancellation{BillingSubjectID: "subject", CustomerID: "cus_multi", CutoffAt: 100}, progress)
	if err == nil || !got.Resources["invoice:in_multi"].Manual || got.Resources["payment_intent:pi_a"].PaymentIntentID != "pi_a" || got.Resources["payment_intent:pi_b"].PaymentIntentID != "pi_b" {
		t.Fatalf("progress=%+v err=%v", got, err)
	}
	if _, err := client.deletionPaymentIntent(context.Background(), BillingDeletionResource{Kind: "invoice", ID: "in_multi", CustomerID: "cus_multi"}); err == nil {
		t.Fatal("manual resolver guessed one payment from a multi-payment invoice")
	}
}
