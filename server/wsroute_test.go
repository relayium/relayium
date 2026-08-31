package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/relayium/relayium/internal/signal"
)

// newTestRoute builds the /ws route with the production per-IP join budget and
// a clock the test drives. `live` is the one code the fake registry accepts.
//
// handle is never reached: every assertion below is about a gate that answers
// before the websocket upgrade, and a plain httptest request carries no upgrade
// headers, so websocket.Accept would fail anyway.
func newTestRoute(live string, now func() int64) wsRoute {
	return wsRoute{
		reqLimiter:   signal.NewRateLimiter(wsJoinPerIPPerMinute, time.Minute, now),
		guessBudget:  signal.NewCodeGuessLimiter(pairingGuessesPerIPPerMinute, time.Minute, now),
		guessBreaker: signal.NewGuessBreaker(200, time.Minute, 30*time.Second, now),
		ipx:          &signal.IPExtractor{},
		validate:     func(c string) bool { return c == live },
		globalConns:  signal.NewGlobalConnLimiter(),
		ipConns:      signal.NewIPConnLimiter(),
		handle: func(context.Context, *websocket.Conn, string, int, string, bool) {
			panic("the upgrade must not be reached in these tests")
		},
		lanMaxPeers: lanMaxPeers,
	}
}

func joinStatus(t *testing.T, h http.HandlerFunc, ip, code string) int {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/ws?code="+code, nil)
	r.RemoteAddr = ip + ":54321"
	w := httptest.NewRecorder()
	h(w, r)
	return w.Code
}

func TestWSRouteUsesResolvedGenerationRoom(t *testing.T) {
	now := func() int64 { return 1000 }
	route := newTestRoute("", now)
	called := ""
	route.resolvePair = func(code string) (string, bool) {
		called = code
		return "c:" + code + ":opaque", true
	}
	req := httptest.NewRequest(http.MethodGet, "/ws?code=424242", nil)
	req.RemoteAddr = "198.51.100.8:1"
	rec := httptest.NewRecorder()
	route.handler()(rec, req)
	if called != "424242" {
		t.Fatalf("resolver called with %q", called)
	}
	if rec.Code == http.StatusForbidden {
		t.Fatal("resolved generation was rejected as an invalid code")
	}
}

func TestWSRouteKeepsOldSocketOutOfReissuedCodeGeneration(t *testing.T) {
	const code = "424242"
	oldRoom := "c:" + code + ":old-generation"
	newRoom := "c:" + code + ":new-generation"

	// This mutable resolver models the deterministic expiry/re-mint transition
	// proved against PairRegistry itself in pair_activity_test.go. Here the real
	// HTTP upgrade and signaling join prove wsRoute preserves that generation.
	var roomMu sync.RWMutex
	currentRoom := oldRoom
	now := func() int64 { return 1000 }
	route := newTestRoute(code, now)
	route.resolvePair = func(got string) (string, bool) {
		roomMu.RLock()
		defer roomMu.RUnlock()
		return currentRoom, got == code
	}
	hub := signal.NewHub()
	var ids atomic.Int64
	route.handle = signal.ServeWS(hub, func() string { return fmt.Sprintf("peer-%d", ids.Add(1)) })
	srv := httptest.NewServer(http.HandlerFunc(route.handler()))
	defer srv.Close()

	join := func(name string) *websocket.Conn {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/ws?code="+code, nil)
		if err != nil {
			t.Fatalf("dial %s: %v", name, err)
		}
		payload, err := json.Marshal(map[string]string{"type": "join", "name": name})
		if err != nil {
			t.Fatal(err)
		}
		if err := conn.Write(ctx, websocket.MessageText, payload); err != nil {
			t.Fatalf("join %s: %v", name, err)
		}
		if _, _, err := conn.Read(ctx); err != nil {
			t.Fatalf("welcome %s: %v", name, err)
		}
		return conn
	}

	oldSocket := join("old-socket")
	defer oldSocket.CloseNow()
	if got := hub.PeerCount(oldRoom); got != 1 {
		t.Fatalf("old generation peers = %d, want 1", got)
	}

	// The external digits are reissued after expiry, but PairRegistry now maps
	// them to a fresh opaque generation. The already-upgraded old socket stays.
	roomMu.Lock()
	currentRoom = newRoom
	roomMu.Unlock()
	newSocket := join("new-socket")
	defer newSocket.CloseNow()
	if oldRoom == newRoom || hub.PeerCount(oldRoom) != 1 || hub.PeerCount(newRoom) != 1 {
		t.Fatalf("generations shared a room: old=%d new=%d", hub.PeerCount(oldRoom), hub.PeerCount(newRoom))
	}

	// The old socket also consumes none of the new generation's two-peer cap.
	newPeer := join("new-peer")
	defer newPeer.CloseNow()
	if got := hub.PeerCount(newRoom); got != 2 {
		t.Fatalf("new generation peers = %d, want 2", got)
	}
	if got := hub.PeerCount(oldRoom); got != 1 {
		t.Fatalf("old generation changed to %d peers", got)
	}
}

// The per-IP join budget is the primary online brute-force bound on a 1e6 code
// space, so the exact cut-off is pinned rather than left to the constant: the
// sixth attempt inside one minute from one address is refused.
func TestWSJoinLimiterRefusesTheSixthAttemptFromOneIP(t *testing.T) {
	if wsJoinPerIPPerMinute != 5 {
		t.Fatalf("wsJoinPerIPPerMinute = %d, want 5 — it must match the /api/ice budget", wsJoinPerIPPerMinute)
	}
	clock := int64(1_000)
	h := newTestRoute("000000", func() int64 { return clock }).handler()

	// Five guesses are spent, and each is refused on its merits (403), not by
	// the limiter — otherwise "the sixth is limited" would prove nothing.
	for i := 1; i <= wsJoinPerIPPerMinute; i++ {
		got := joinStatus(t, h, "203.0.113.7", fmt.Sprintf("%06d", 900_000+i))
		if got != http.StatusForbidden {
			t.Fatalf("attempt %d: status = %d, want %d", i, got, http.StatusForbidden)
		}
	}
	if got := joinStatus(t, h, "203.0.113.7", "900999"); got != http.StatusTooManyRequests {
		t.Fatalf("sixth attempt within a minute: status = %d, want %d", got, http.StatusTooManyRequests)
	}
	// Even a VALID code is refused once this IP's budget is gone. That is the
	// deliberate cost of the tighter budget, and it is a fact about the design
	// rather than an accident, so it is asserted rather than left implicit.
	if got := joinStatus(t, h, "203.0.113.7", "000000"); got != http.StatusTooManyRequests {
		t.Fatalf("valid code after the budget is spent: status = %d, want %d", got, http.StatusTooManyRequests)
	}

	// A different address has its own budget — the limiter is per-IP, not global.
	if got := joinStatus(t, h, "198.51.100.4", "900999"); got != http.StatusForbidden {
		t.Fatalf("other IP: status = %d, want %d", got, http.StatusForbidden)
	}

	// And the window really is a minute: past it, the first address is served again.
	clock += 61
	if got := joinStatus(t, h, "203.0.113.7", "900999"); got != http.StatusForbidden {
		t.Fatalf("after the window: status = %d, want %d", got, http.StatusForbidden)
	}
}

// The invariant the guess breaker exists under: it counts INVALID attempts only,
// so no amount of guessing traffic can deny a legitimate join. Driven at the
// real trip threshold, from many source addresses, so the per-IP limiter above
// is not what produces the result.
func TestGuessBreakerNeverDeniesAValidJoin(t *testing.T) {
	clock := int64(1_000)
	rt := newTestRoute("012345", func() int64 { return clock })
	h := rt.handler()

	// 400 invalid attempts, 4 per address so the per-IP budget is never the
	// thing refusing them. That is twice the breaker's 200/min threshold.
	for i := 0; i < 100; i++ {
		ip := fmt.Sprintf("198.51.100.%d", i+1)
		for j := 0; j < 4; j++ {
			joinStatus(t, h, ip, fmt.Sprintf("%06d", 500_000+i*10+j))
		}
	}
	if !rt.guessBreaker.IsOpen() {
		t.Fatal("the breaker should have tripped after 400 invalid attempts in one window")
	}

	// A real recipient, from an address that has spent nothing, joins with the
	// live code while the breaker is open. It must go through: the breaker is
	// only consulted on the RoomFor-refused path.
	got := joinStatus(t, h, "203.0.113.200", "012345")
	if got == http.StatusTooManyRequests || got == http.StatusForbidden {
		t.Fatalf("valid join while the breaker is open: status = %d, want it past every admission gate", got)
	}
}

// A leading-zero code is an ordinary code. It is asserted at the HTTP boundary
// too, because that is where a "parse the code as a number" bug would land.
func TestWSAcceptsLeadingZeroCodes(t *testing.T) {
	clock := int64(1_000)
	h := newTestRoute("000042", func() int64 { return clock }).handler()

	if got := joinStatus(t, h, "203.0.113.9", "000042"); got == http.StatusForbidden {
		t.Fatal("a code with leading zeros was refused as malformed")
	}
	// And the numeric-equal-but-textually-different form is NOT the same code.
	if got := joinStatus(t, h, "203.0.113.10", "42"); got != http.StatusForbidden {
		t.Fatalf(`"42" status = %d, want %d — it is not six digits`, got, http.StatusForbidden)
	}
}

// Old-format codes stop working the instant this lands. Pinned so the coordinated
// break is visible in the test suite rather than only in a changelog.
func TestWSRefusesTheOldAlphabetFormat(t *testing.T) {
	clock := int64(1_000)
	h := newTestRoute("000000", func() int64 { return clock }).handler()
	if got := joinStatus(t, h, "203.0.113.11", "K7M3X9"); got != http.StatusForbidden {
		t.Fatalf("old-alphabet code: status = %d, want %d", got, http.StatusForbidden)
	}
}
