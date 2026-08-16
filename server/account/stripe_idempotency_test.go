package account

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// planChangeServer is a Stripe stand-in for the change-plan path: it serves one
// live subscription (whose price and latest_invoice the test controls) and
// records the Idempotency-Key of every subscription POST.
type planChangeServer struct {
	mu sync.Mutex
	// price / invoice describe the current subscription state the list call
	// reports. Tests mutate them to model a change that has already landed.
	price, invoice string
	// keys is every Idempotency-Key seen on a mutating POST, in order.
	keys []string
	// postStatus, when non-zero, is returned for the next N posts (see postFails).
	postStatus int
	postBody   string
	postFails  int
	posts      int
}

func (p *planChangeServer) handler(t *testing.T) http.Handler {
	t.Helper()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p.mu.Lock()
		defer p.mu.Unlock()
		switch {
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/subscriptions"):
			fmt.Fprintf(w, `{"data":[{"id":"sub_1","status":"active","latest_invoice":%q,`+
				`"items":{"data":[{"id":"si_1","price":{"id":%q}}]}}]}`, p.invoice, p.price)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/subscriptions/sub_1":
			p.posts++
			p.keys = append(p.keys, r.Header.Get("Idempotency-Key"))
			if p.postFails > 0 {
				p.postFails--
				http.Error(w, p.postBody, p.postStatus)
				return
			}
			fmt.Fprint(w, `{"id":"sub_1"}`)
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
	})
}

func newPlanChangeClient(t *testing.T, p *planChangeServer) *stripeClient {
	t.Helper()
	srv := httptest.NewServer(p.handler(t))
	t.Cleanup(srv.Close)
	c := NewStripeClient("sk_test", "whsec", "")
	c.base = srv.URL
	c.idemRetryDelay = time.Millisecond // don't make the suite sleep
	return c
}

// 改订阅是要真扣钱的写操作。没有 Idempotency-Key 的话，用户双击一次「升级」或者
// 前端超时重发，Stripe 就会按比例扣两次。
func TestChangeSubscriptionPlanSendsIdempotencyKey(t *testing.T) {
	p := &planChangeServer{price: "price_old", invoice: "in_1"}
	c := newPlanChangeClient(t, p)

	if err := c.ChangeSubscriptionPlan(context.Background(), "cus_1", "price_new"); err != nil {
		t.Fatal(err)
	}
	if len(p.keys) != 1 {
		t.Fatalf("want one subscription POST, got %d", len(p.keys))
	}
	if p.keys[0] == "" {
		t.Fatal("the mutating subscription update carries no Idempotency-Key")
	}
	if !strings.HasPrefix(p.keys[0], "planchange_") {
		t.Fatalf("key %q should be namespaced to this operation", p.keys[0])
	}
}

// 同一个意图重发必须命中同一个 key —— 这才是「并发重试收敛成一次扣款」的前提。
func TestChangeSubscriptionPlanKeyIsDeterministicForSameIntent(t *testing.T) {
	p := &planChangeServer{price: "price_old", invoice: "in_1"}
	c := newPlanChangeClient(t, p)

	for i := 0; i < 2; i++ {
		if err := c.ChangeSubscriptionPlan(context.Background(), "cus_1", "price_new"); err != nil {
			t.Fatalf("attempt %d: %v", i, err)
		}
	}
	if len(p.keys) != 2 {
		t.Fatalf("want two POSTs, got %d", len(p.keys))
	}
	if p.keys[0] != p.keys[1] {
		t.Fatalf("same change from the same state produced different keys: %q vs %q", p.keys[0], p.keys[1])
	}
}

// 反过来的风险同样真实：如果 key 只是 (订阅, 原价, 新价) 的函数，用户在 Stripe 的
// 24 小时 key 窗口内来回切一圈再切回去，第三次请求会命中第一次的 key，Stripe 直接
// 重放旧响应、什么都不改 —— 一次用户已经确认过的付费变更就这样被静默吞掉。
// latest_invoice 每次 always_invoice 变更都会前进，正好把这两种情况区分开。
func TestChangeSubscriptionPlanKeyAdvancesWithSubscriptionState(t *testing.T) {
	p := &planChangeServer{price: "price_old", invoice: "in_1"}
	c := newPlanChangeClient(t, p)

	if err := c.ChangeSubscriptionPlan(context.Background(), "cus_1", "price_new"); err != nil {
		t.Fatal(err)
	}
	// The change applied: Stripe wrote a new invoice and moved the price. The
	// customer switches back, then forward again.
	p.mu.Lock()
	p.price, p.invoice = "price_new", "in_2"
	p.mu.Unlock()
	if err := c.ChangeSubscriptionPlan(context.Background(), "cus_1", "price_old"); err != nil {
		t.Fatal(err)
	}
	p.mu.Lock()
	p.price, p.invoice = "price_old", "in_3"
	p.mu.Unlock()
	if err := c.ChangeSubscriptionPlan(context.Background(), "cus_1", "price_new"); err != nil {
		t.Fatal(err)
	}

	if len(p.keys) != 3 {
		t.Fatalf("want three POSTs, got %d", len(p.keys))
	}
	// The first and third are the SAME from-price/to-price pair. Only the
	// generation token keeps them apart.
	if p.keys[0] == p.keys[2] {
		t.Fatalf("a later legitimate change reused the first change's key (%q) and would be replayed as a no-op", p.keys[0])
	}
}

func TestChangeSubscriptionPlanKeyDiffersPerTargetPrice(t *testing.T) {
	p := &planChangeServer{price: "price_old", invoice: "in_1"}
	c := newPlanChangeClient(t, p)

	if err := c.ChangeSubscriptionPlan(context.Background(), "cus_1", "price_a"); err != nil {
		t.Fatal(err)
	}
	if err := c.ChangeSubscriptionPlan(context.Background(), "cus_1", "price_b"); err != nil {
		t.Fatal(err)
	}
	if p.keys[0] == p.keys[1] {
		t.Fatalf("two different targets share key %q", p.keys[0])
	}
}

// Stripe 对「同一个 key 正在被另一个请求处理」返回 409。这正是两个并发重复请求
// 会撞到的情况，而且是唯一值得重试的 Stripe 失败：赢的那个请求执行的就是我们想
// 要的变更，用同一个 key 再发一次拿回的是它的结果，不会产生第二次扣款。输的那个
// 请求如果直接 500，用户看到的是「失败」，而钱其实已经扣了。
func TestChangeSubscriptionPlanRetriesInFlightIdempotencyConflict(t *testing.T) {
	p := &planChangeServer{
		price: "price_old", invoice: "in_1",
		postStatus: http.StatusConflict,
		postBody:   `{"error":{"code":"idempotency_key_in_use","message":"There is currently another in-progress request using this Idempotency Key."}}`,
		postFails:  1,
	}
	c := newPlanChangeClient(t, p)

	if err := c.ChangeSubscriptionPlan(context.Background(), "cus_1", "price_new"); err != nil {
		t.Fatalf("an in-flight-key conflict should be retried, not surfaced: %v", err)
	}
	if len(p.keys) != 2 {
		t.Fatalf("want the request re-issued once, got %d POSTs", len(p.keys))
	}
	// Re-issuing under a DIFFERENT key would be a second operation, not a retry.
	if p.keys[0] != p.keys[1] {
		t.Fatalf("retry changed the key (%q -> %q), which defeats the idempotency", p.keys[0], p.keys[1])
	}
}

// 只有 409 idempotency 冲突可以重试。把别的失败也塞进重试循环，一次网络抖动就会
// 变成反复扣款。
func TestChangeSubscriptionPlanDoesNotRetryOtherErrors(t *testing.T) {
	p := &planChangeServer{
		price: "price_old", invoice: "in_1",
		postStatus: http.StatusInternalServerError,
		postBody:   `{"error":{"message":"boom"}}`,
		postFails:  5,
	}
	c := newPlanChangeClient(t, p)

	if err := c.ChangeSubscriptionPlan(context.Background(), "cus_1", "price_new"); err == nil {
		t.Fatal("a 500 from Stripe must surface, not be swallowed by a retry loop")
	}
	if len(p.keys) != 1 {
		t.Fatalf("an unclassified failure must not be retried, got %d POSTs", len(p.keys))
	}
}

// A 409 that is NOT about idempotency (Stripe reuses 409 for other conflicts)
// must not be retried either.
func TestChangeSubscriptionPlanDoesNotRetryUnrelatedConflict(t *testing.T) {
	p := &planChangeServer{
		price: "price_old", invoice: "in_1",
		postStatus: http.StatusConflict,
		postBody:   `{"error":{"message":"subscription is in an incompatible state"}}`,
		postFails:  5,
	}
	c := newPlanChangeClient(t, p)

	if err := c.ChangeSubscriptionPlan(context.Background(), "cus_1", "price_new"); err == nil {
		t.Fatal("an unrelated 409 must surface")
	}
	if len(p.keys) != 1 {
		t.Fatalf("an unrelated 409 must not be retried, got %d POSTs", len(p.keys))
	}
}

// The same-price early return is what makes a composite retry free: after stage
// one has applied, re-running it must not reach Stripe at all.
func TestChangeSubscriptionPlanNoopSendsNoRequestAtAll(t *testing.T) {
	p := &planChangeServer{price: "price_new", invoice: "in_1"}
	c := newPlanChangeClient(t, p)

	if err := c.ChangeSubscriptionPlan(context.Background(), "cus_1", "price_new"); err != nil {
		t.Fatal(err)
	}
	if len(p.keys) != 0 {
		t.Fatalf("already on the target price must not POST, got %d", len(p.keys))
	}
}

// stripeAPIError must keep formatting exactly like the fmt.Errorf it replaced,
// because CancelSubscription still branches on a substring of that text.
func TestStripeAPIErrorPreservesMessageForSubstringChecks(t *testing.T) {
	err := error(&stripeAPIError{
		Method: http.MethodPost, Path: "/v1/subscriptions/sub_1",
		Status: http.StatusNotFound, Body: `{"error":{"message":"No such subscription: sub_1"}}`,
	})
	want := `stripe: POST /v1/subscriptions/sub_1: status 404: {"error":{"message":"No such subscription: sub_1"}}`
	if err.Error() != want {
		t.Fatalf("Error() = %q, want %q", err.Error(), want)
	}
	if !strings.Contains(err.Error(), "No such subscription") {
		t.Fatal("CancelSubscription's substring guard would stop matching")
	}
	var apiErr *stripeAPIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusNotFound {
		t.Fatal("errors.As should recover the status for callers that branch on it")
	}
}

// parseChangePreview is where the signed total and the post-change renewal date
// come from; both are read from fields the old amount_due-only parse ignored.
func TestParseChangePreviewReadsSignedTotalAndLatestLinePeriod(t *testing.T) {
	// A monthly→yearly switch: the credit line ends at the old monthly boundary,
	// the charge line a year out. Only the later one is the new renewal date.
	body := []byte(`{"amount_due":0,"total":-1234,"period_end":1900000000,
	  "lines":{"data":[
	    {"period":{"start":1893456000,"end":1900000000}},
	    {"period":{"start":1893456000,"end":1925000000}}
	  ]}}`)
	pv, err := parseChangePreview(body)
	if err != nil {
		t.Fatal(err)
	}
	if pv.AmountDueCents != 0 {
		t.Fatalf("AmountDueCents = %d, want 0", pv.AmountDueCents)
	}
	if pv.TotalCents != -1234 {
		t.Fatalf("TotalCents = %d, want -1234 (a credit)", pv.TotalCents)
	}
	if pv.PeriodEnd != 1925000000 {
		t.Fatalf("PeriodEnd = %d, want the LATEST line period end 1925000000", pv.PeriodEnd)
	}
}

func TestParseChangePreviewFallsBackToInvoicePeriodEnd(t *testing.T) {
	pv, err := parseChangePreview([]byte(`{"amount_due":500,"total":500,"period_end":1911111111}`))
	if err != nil {
		t.Fatal(err)
	}
	if pv.PeriodEnd != 1911111111 {
		t.Fatalf("PeriodEnd = %d, want the invoice period_end when there are no lines", pv.PeriodEnd)
	}
}

// No usable period anywhere means "unknown" — 0, for the caller to fall back on.
// Returning an epoch date would render as January 1970 in the confirmation UI.
func TestParseChangePreviewLeavesPeriodEndZeroWhenAbsent(t *testing.T) {
	pv, err := parseChangePreview([]byte(`{"amount_due":500,"total":500}`))
	if err != nil {
		t.Fatal(err)
	}
	if pv.PeriodEnd != 0 {
		t.Fatalf("PeriodEnd = %d, want 0 (unknown)", pv.PeriodEnd)
	}
}

// PreviewChange must project the whole ChangePreview off a realistic Basil
// create_preview body, not just the charge.
func TestPreviewChangeProjectsCreditAndPeriodEnd(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/v1/subscriptions"):
			fmt.Fprint(w, `{"data":[{"id":"sub_1","status":"active","latest_invoice":"in_1",`+
				`"items":{"data":[{"id":"si_1","price":{"id":"price_old"}}]}}]}`)
		case r.URL.Path == "/v1/invoices/create_preview":
			fmt.Fprint(w, `{"amount_due":0,"total":-2500,"lines":{"data":[{"period":{"end":1940000000}}]}}`)
		default:
			t.Errorf("unexpected %s", r.URL.Path)
		}
	}))
	defer srv.Close()
	c := NewStripeClient("sk_test", "whsec", "")
	c.base = srv.URL

	pv, err := c.PreviewChange(context.Background(), "cus_1", "price_new")
	if err != nil {
		t.Fatal(err)
	}
	if pv.AmountDueCents != 0 || pv.TotalCents != -2500 || pv.PeriodEnd != 1940000000 {
		t.Fatalf("preview = %+v, want {0 -2500 1940000000}", pv)
	}
}
