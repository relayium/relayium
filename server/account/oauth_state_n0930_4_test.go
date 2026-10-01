package account

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/authx"
)

// N-0930-4: browser OAuth state is spent server-side, once.

// seedOAuthState records state server-side as the start handler would, so a
// test that drives a callback directly presents a state that was issued. The
// row never expires within a test. Shared fixture for every callback test.
func seedOAuthState(t testing.TB, svc *Service, state string) {
	t.Helper()
	// Drop any earlier unspent row of the same value, so a helper that seeds
	// per call can be called again.
	if _, err := svc.store.ConsumeOAuthState(context.Background(), authx.HashToken(state), 0); err != nil {
		t.Fatalf("reset oauth state: %v", err)
	}
	if ok, err := svc.store.CreateOAuthState(context.Background(), authx.HashToken(state), 0, 1<<62, oauthStateBudget); err != nil || !ok {
		t.Fatalf("seed oauth state: ok=%v err=%v", ok, err)
	}
}

func oauthStateRows(t *testing.T, store *SQLiteStore) int {
	t.Helper()
	var n int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM oauth_states`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// googleStart runs the real start handler and returns the state it issued
// (from the redirect URL) after checking the cookie carries the same value.
func googleStart(t *testing.T, svc *Service) string {
	t.Helper()
	rec := httptest.NewRecorder()
	svc.handleGoogleStart(rec, httptest.NewRequest("GET", "/api/auth/google/start", nil))
	loc, err := url.Parse(rec.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	state := loc.Query().Get("state")
	if state == "" {
		t.Fatalf("start redirect carries no state: %q", rec.Header().Get("Location"))
	}
	for _, c := range rec.Result().Cookies() {
		if c.Name == oauthStateCookie && c.Value == state {
			return state
		}
	}
	t.Fatalf("start did not set the state cookie to the issued state")
	return ""
}

func googleCallbackWith(svc *Service, state string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("GET", "/api/auth/google/callback?code=abc&state="+url.QueryEscape(state), nil)
	req.AddCookie(&http.Cookie{Name: oauthStateCookie, Value: state})
	rec := httptest.NewRecorder()
	svc.handleGoogleCallback(rec, req)
	return rec
}

// A state issued by the start handler signs in once; the copied state/cookie
// pair replayed afterwards is refused and issues nothing.
func TestOAuthStateN0930ReplayedPairRefused(t *testing.T) {
	store := newTestStore(t)
	svc := googleSubService(t, store, "sub-state", "state@example.com", true)
	state := googleStart(t, svc)
	if n := oauthStateRows(t, store); n != 1 {
		t.Fatalf("start must record one state row, found %d", n)
	}

	first := googleCallbackWith(svc, state)
	if first.Header().Get("Location") != "/" || sessionUser(t, store, first) == "" {
		t.Fatalf("first use of an issued state must sign in, got %q", first.Header().Get("Location"))
	}
	if n := oauthStateRows(t, store); n != 0 {
		t.Fatalf("the callback must spend the state row, %d left", n)
	}
	sessionsBefore := googleSubCount(t, store, `SELECT COUNT(*) FROM sessions`)

	replay := googleCallbackWith(svc, state)
	if loc := replay.Header().Get("Location"); loc != "/?login=error" {
		t.Fatalf("replayed state/cookie pair must be refused, got %q", loc)
	}
	if got := sessionUser(t, store, replay); got != "" {
		t.Fatalf("replay must issue no session, got one for %q", got)
	}
	if n := googleSubCount(t, store, `SELECT COUNT(*) FROM sessions`); n != sessionsBefore {
		t.Fatalf("replay must insert no session row: before=%d after=%d", sessionsBefore, n)
	}
}

// The state is spent before the provider code is redeemed: a replay never
// reaches the exchange.
func TestOAuthStateN0930ConsumedBeforeExchange(t *testing.T) {
	store := newTestStore(t)
	svc := googleSubService(t, store, "sub-x", "x@example.com", true)
	exchanges := 0
	svc.fetchGoogleUser = func(context.Context, string) (string, string, string, bool, error) {
		exchanges++
		return "sub-x", "x@example.com", "X", true, nil
	}
	state := googleStart(t, svc)
	googleCallbackWith(svc, state)
	googleCallbackWith(svc, state)
	if exchanges != 1 {
		t.Fatalf("a replayed state must not reach the code exchange, exchanges=%d", exchanges)
	}
}

// A state whose server-side row has expired is refused even with a matching
// cookie, and an unissued state/cookie pair is refused outright.
func TestOAuthStateN0930ExpiredAndUnissuedRefused(t *testing.T) {
	store := newTestStore(t)
	svc := googleSubService(t, store, "sub-exp", "exp@example.com", true)
	base := time.Unix(1_800_000_000, 0)
	svc.now = func() time.Time { return base }
	state := googleStart(t, svc)
	svc.now = func() time.Time { return base.Add(oauthStateTTL * time.Second) }
	if loc := googleCallbackWith(svc, state).Header().Get("Location"); loc != "/?login=error" {
		t.Fatalf("expired state must be refused, got %q", loc)
	}
	if loc := googleCallbackWith(svc, "never-issued").Header().Get("Location"); loc != "/?login=error" {
		t.Fatalf("unissued state must be refused, got %q", loc)
	}
	if n := googleSubCount(t, store, `SELECT COUNT(*) FROM sessions`); n != 0 {
		t.Fatalf("no session may be issued, found %d", n)
	}
}

// The start handler sweeps expired rows, at most oauthStateSweepBatch per call,
// and never a live one.
func TestOAuthStateN0930SweepIsBounded(t *testing.T) {
	store := newTestStore(t)
	svc := googleSubService(t, store, "sub-sw", "sw@example.com", true)
	now := time.Unix(1_800_000_000, 0)
	svc.now = func() time.Time { return now }
	ctx := context.Background()
	for i := 0; i < oauthStateSweepBatch+50; i++ {
		if _, err := store.CreateOAuthState(ctx, authx.HashToken("old-"+strings.Repeat("x", i)), 0, now.Unix()-1, oauthStateBudget); err != nil {
			t.Fatal(err)
		}
	}
	live := googleStart(t, svc) // sweeps one batch, adds one live row
	if n := oauthStateRows(t, store); n != 50+1 {
		t.Fatalf("one start must sweep exactly one batch: want %d rows, got %d", 50+1, n)
	}
	googleStart(t, svc)
	if n := oauthStateRows(t, store); n != 2 {
		t.Fatalf("second start must sweep the rest and keep live rows: want 2, got %d", n)
	}
	if loc := googleCallbackWith(svc, live).Header().Get("Location"); loc != "/" {
		t.Fatalf("a live state must survive the sweep, got %q", loc)
	}
}

// Apple web shares the mechanism: its start records a state row, and a
// callback pair signs in once and is refused on replay.
func TestOAuthStateN0930AppleWebReplayRefused(t *testing.T) {
	svc, _ := newAppleWebTestService(t)
	claims := validAppleClaims(svc.now())
	claims["aud"], claims["nonce"] = "com.relayium.web", "NONCE1"
	svc, store := appleWebT4Service(t, claims)

	rec := httptest.NewRecorder()
	svc.handleAppleWebStart(rec, httptest.NewRequest("GET", "/api/auth/apple/web/start", nil))
	if n := oauthStateRows(t, store); n != 1 {
		t.Fatalf("apple web start must record one state row, found %d", n)
	}

	seedOAuthState(t, svc, "STATE1")
	callback := func() *httptest.ResponseRecorder {
		form := url.Values{"code": {"CODE1"}, "state": {"STATE1"}}
		req := httptest.NewRequest("POST", "/api/auth/apple/web/callback", strings.NewReader(form.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.AddCookie(&http.Cookie{Name: oauthStateCookie, Value: "STATE1"})
		req.AddCookie(&http.Cookie{Name: oauthNonceCookie, Value: "NONCE1"})
		rec := httptest.NewRecorder()
		svc.handleAppleWebCallback(rec, req)
		return rec
	}
	if loc := callback().Header().Get("Location"); loc != "/" {
		t.Fatalf("first use must sign in, got %q", loc)
	}
	before := googleSubCount(t, store, `SELECT COUNT(*) FROM sessions`)
	replay := callback()
	if loc := replay.Header().Get("Location"); loc != "/?login=error" {
		t.Fatalf("replayed apple state/cookie pair must be refused, got %q", loc)
	}
	if n := googleSubCount(t, store, `SELECT COUNT(*) FROM sessions`); n != before {
		t.Fatalf("replay must insert no session: before=%d after=%d", before, n)
	}
}

// perKeyLimiter allows `per` calls per key.
type perKeyLimiter struct {
	per  int
	seen map[string]int
}

func (l *perKeyLimiter) Allow(key string) bool {
	if l.seen == nil {
		l.seen = map[string]int{}
	}
	l.seen[key]++
	return l.seen[key] <= l.per
}

func startFrom(svc *Service, appleWeb bool, remote string) *httptest.ResponseRecorder {
	path := "/api/auth/google/start"
	if appleWeb {
		path = "/api/auth/apple/web/start"
	}
	req := httptest.NewRequest("GET", path, nil)
	req.RemoteAddr = remote
	rec := httptest.NewRecorder()
	if appleWeb {
		svc.handleAppleWebStart(rec, req)
	} else {
		svc.handleGoogleStart(rec, req)
	}
	return rec
}

// Both start routes are throttled per client IP before any state row is
// written; another address is unaffected.
func TestOAuthStateN0930StartThrottledPerIP(t *testing.T) {
	for _, appleWeb := range []bool{false, true} {
		t.Run(map[bool]string{false: "google", true: "apple web"}[appleWeb], func(t *testing.T) {
			svc, store := newAppleWebTestService(t)
			svc.SetOAuthStartLimiter(&perKeyLimiter{per: 2})
			for i := 0; i < 2; i++ {
				if rec := startFrom(svc, appleWeb, "203.0.113.7:1000"); rec.Code != http.StatusFound {
					t.Fatalf("start %d within the limit: want 302, got %d", i, rec.Code)
				}
			}
			rec := startFrom(svc, appleWeb, "203.0.113.7:1001")
			if rec.Code != http.StatusTooManyRequests {
				t.Fatalf("start over the per-IP limit: want 429, got %d", rec.Code)
			}
			if n := oauthStateRows(t, store); n != 2 {
				t.Fatalf("a throttled start must write no state row: want 2 rows, got %d", n)
			}
			if rec := startFrom(svc, appleWeb, "198.51.100.9:1000"); rec.Code != http.StatusFound {
				t.Fatalf("another address must not be throttled, got %d", rec.Code)
			}
		})
	}
}

// The global outstanding-state budget: once it is full a start is refused with
// 503 and writes nothing; expired states neither count nor block.
func TestOAuthStateN0930BudgetRefusesWhenFull(t *testing.T) {
	old := oauthStateBudget
	oauthStateBudget = 3
	t.Cleanup(func() { oauthStateBudget = old })
	store := newTestStore(t)
	svc := googleSubService(t, store, "sub-b", "b@example.com", true)
	base := time.Unix(1_800_000_000, 0)
	svc.now = func() time.Time { return base }
	for i := 0; i < 3; i++ {
		googleStart(t, svc)
	}
	rec := httptest.NewRecorder()
	svc.handleGoogleStart(rec, httptest.NewRequest("GET", "/api/auth/google/start", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("a start over the budget: want 503, got %d %q", rec.Code, rec.Header().Get("Location"))
	}
	for _, c := range rec.Result().Cookies() {
		if c.Name == oauthStateCookie {
			t.Fatal("a refused start must set no state cookie")
		}
	}
	if n := oauthStateRows(t, store); n != 3 {
		t.Fatalf("a refused start must write nothing: want 3 rows, got %d", n)
	}
	// Once those states expire they no longer count — even the ones a single
	// bounded sweep cannot reach yet.
	later := base.Add(oauthStateTTL * time.Second)
	for i := 0; i < oauthStateSweepBatch+50; i++ {
		if _, err := store.CreateOAuthState(context.Background(), authx.HashToken("exp-"+strings.Repeat("z", i)), 0, later.Unix()-1, 1<<30); err != nil {
			t.Fatal(err)
		}
	}
	svc.now = func() time.Time { return later }
	googleStart(t, svc)
	if n := oauthStateRows(t, store); n != 3+50+1 {
		t.Fatalf("one sweep batch removed, expired rows left behind, one live row added: want %d rows, got %d", 3+50+1, n)
	}
}

// The budget check and the insert are one statement: concurrent starts never
// overshoot it.
func TestOAuthStateN0930BudgetHoldsUnderConcurrency(t *testing.T) {
	store := newTestStore(t)
	const budget = 5
	ctx := context.Background()
	done := make(chan bool, 40)
	for i := 0; i < 40; i++ {
		go func(i int) {
			ok, err := store.CreateOAuthState(ctx, authx.HashToken("c-"+strings.Repeat("y", i)), 0, 1<<62, budget)
			done <- err == nil && ok
		}(i)
	}
	admitted := 0
	for i := 0; i < 40; i++ {
		if <-done {
			admitted++
		}
	}
	if n := oauthStateRows(t, store); n != budget || admitted != budget {
		t.Fatalf("want exactly %d admitted rows, got admitted=%d rows=%d", budget, admitted, n)
	}
}

// The expiry sweep and the budget count use an index on expires_at.
func TestOAuthStateN0930ExpiryIndexed(t *testing.T) {
	store := newTestStore(t)
	var n int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND tbl_name = 'oauth_states' AND sql LIKE '%expires_at%'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("oauth_states needs an index on expires_at, found %d", n)
	}
}
