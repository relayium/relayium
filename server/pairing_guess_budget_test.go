package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/relayium/relayium/internal/signal"
)

// jointGuessHarness wires the two halves of the pairing-code validity oracle the
// way main() does: one CodeGuessLimiter object shared by the /ws route and
// account.handleICE, and one trusted-proxy-aware IPExtractor deriving the
// rate-limit key on both sides.
//
// Both handlers are the REAL ones — the production wsRoute handler and the real
// /api/ice route off account.Service.Routes() — because the claim under test is
// about what an attacker gets from the deployed pair of endpoints, which a test
// against the limiter alone cannot establish.
type jointGuessHarness struct {
	ws  http.HandlerFunc
	api http.Handler
}

func newJointGuessHarness(t *testing.T, live string, now func() int64) *jointGuessHarness {
	t.Helper()
	ipx := signal.NewIPExtractor(nil)
	budget := signal.NewCodeGuessLimiter(pairingGuessesPerIPPerMinute, time.Minute, now)

	rt := wsRoute{
		// Deliberately generous per-endpoint request caps (100 each): this test is
		// about the SHARED distinct-code budget, and a per-endpoint cap firing
		// first would hide whether that budget is shared at all.
		reqLimiter:   signal.NewRateLimiter(100, time.Minute, now),
		guessBudget:  budget,
		guessBreaker: signal.NewGuessBreaker(100_000, time.Minute, 30*time.Second, now),
		ipx:          ipx,
		validate:     func(c string) bool { return c == live },
		globalConns:  signal.NewGlobalConnLimiter(),
		ipConns:      signal.NewIPConnLimiter(),
		handle: func(context.Context, *websocket.Conn, string, int, string) {
			panic("the upgrade must not be reached in these tests")
		},
		lanMaxPeers: lanMaxPeers,
	}

	svc := newPairTestService(t)
	svc.SetClientIP(ipx.IP)
	svc.SetICELimiter(&countingLimiter{limit: 100})
	svc.SetCodeGuessLimiter(budget) // the SAME object the /ws route holds

	return &jointGuessHarness{ws: rt.handler(), api: svc.Routes()}
}

// countingLimiter is a stand-in for the per-endpoint /api/ice request cap with a
// budget large enough never to be the thing refusing a request here.
type countingLimiter struct {
	n, limit int
}

func (c *countingLimiter) Allow(string) bool {
	c.n++
	return c.n <= c.limit
}

func (h *jointGuessHarness) joinWS(ip, code string) int {
	r := httptest.NewRequest(http.MethodGet, "/ws?code="+code, nil)
	r.RemoteAddr = ip + ":54321"
	w := httptest.NewRecorder()
	h.ws(w, r)
	return w.Code
}

func (h *jointGuessHarness) askICE(ip, code string) int {
	url := "/api/ice"
	if code != "" {
		url += "?code=" + code
	}
	r := httptest.NewRequest(http.MethodGet, url, nil)
	r.RemoteAddr = ip + ":54321"
	w := httptest.NewRecorder()
	h.api.ServeHTTP(w, r)
	return w.Code
}

// The gap this closes: /ws and /api/ice each answer whether a code is live, and
// while each held its own 5/min/IP budget an attacker simply alternated between
// them for ~10 candidates a minute. Five distinct codes split across BOTH
// endpoints must exhaust ONE budget, and the sixth must be refused on either.
func TestPairingGuessBudgetIsSharedAcrossWSAndICE(t *testing.T) {
	clock := int64(1_000)
	h := newJointGuessHarness(t, "000000", func() int64 { return clock })
	const attacker = "203.0.113.7"

	// Three candidates spent on /api/ice. Each is answered 200 (the endpoint
	// always answers 200; validity shows in the body), so the budget — not a
	// refusal — is what the next assertions turn on.
	for i := 1; i <= 3; i++ {
		if got := h.askICE(attacker, fmt.Sprintf("%06d", 900_000+i)); got != http.StatusOK {
			t.Fatalf("/api/ice candidate %d: status = %d, want 200", i, got)
		}
	}
	// Two more on /ws. Refused on their merits (403 — not live), not by a cap.
	for i := 4; i <= 5; i++ {
		if got := h.joinWS(attacker, fmt.Sprintf("%06d", 900_000+i)); got != http.StatusForbidden {
			t.Fatalf("/ws candidate %d: status = %d, want %d", i, got, http.StatusForbidden)
		}
	}

	// Five distinct candidates are gone. A sixth is refused on EITHER endpoint.
	if got := h.askICE(attacker, "900666"); got != http.StatusTooManyRequests {
		t.Fatalf("sixth candidate on /api/ice: status = %d, want %d", got, http.StatusTooManyRequests)
	}
	if got := h.joinWS(attacker, "900777"); got != http.StatusTooManyRequests {
		t.Fatalf("sixth candidate on /ws: status = %d, want %d", got, http.StatusTooManyRequests)
	}

	// Another address is untouched by the attacker's spending.
	if got := h.joinWS("198.51.100.4", "900666"); got != http.StatusForbidden {
		t.Fatalf("other IP on /ws: status = %d, want %d", got, http.StatusForbidden)
	}
	if got := h.askICE("198.51.100.4", "900666"); got != http.StatusOK {
		t.Fatalf("other IP on /api/ice: status = %d, want 200", got)
	}

	// Past the trailing window the attacker's candidates expire and it may guess
	// again — this is a rate, not a lifetime quota.
	clock += 61
	if got := h.joinWS(attacker, "900888"); got != http.StatusForbidden {
		t.Fatalf("after the window: status = %d, want %d", got, http.StatusForbidden)
	}
}

// The ordinary client sequence — ask /api/ice for relay credentials, then join
// /ws — is ONE guess. If the shared budget charged it twice, the honest cap
// would be 2 codes rather than 5, and a real receiver retrying a few times would
// be locked out of its own transfer.
func TestPairingGuessBudgetChargesTheNormalICEThenWSPairOnce(t *testing.T) {
	clock := int64(1_000)
	h := newJointGuessHarness(t, "000000", func() int64 { return clock })
	const user = "203.0.113.20"

	// A real receiver with the live code: /api/ice then /ws, plus a page reload
	// doing both again. All four requests are the same single candidate.
	for round := 0; round < 2; round++ {
		if got := h.askICE(user, "000000"); got != http.StatusOK {
			t.Fatalf("round %d /api/ice: status = %d, want 200", round, got)
		}
		if got := h.joinWS(user, "000000"); got == http.StatusTooManyRequests {
			t.Fatalf("round %d /ws: the real receiver was rate-limited on its own code", round)
		}
	}

	// Four further DISTINCT candidates still fit inside the five-code budget:
	// the repeats above consumed exactly one slot.
	for i := 1; i <= 4; i++ {
		if got := h.joinWS(user, fmt.Sprintf("%06d", 700_000+i)); got != http.StatusForbidden {
			t.Fatalf("distinct candidate %d: status = %d, want %d (repeats over-charged)", i, got, http.StatusForbidden)
		}
	}
	if got := h.joinWS(user, "700999"); got != http.StatusTooManyRequests {
		t.Fatalf("candidate past the budget: status = %d, want %d", got, http.StatusTooManyRequests)
	}
}

// LAN uses both endpoints with NO code (STUN-only ICE, room-key join). That is
// not a guess, must never be counted, and must keep working after an address has
// spent its whole pairing-code budget.
func TestPairingGuessBudgetIgnoresCodelessLANRequests(t *testing.T) {
	clock := int64(1_000)
	h := newJointGuessHarness(t, "000000", func() int64 { return clock })
	const lanUser = "203.0.113.30"

	for i := 0; i < 20; i++ {
		if got := h.askICE(lanUser, ""); got != http.StatusOK {
			t.Fatalf("codeless /api/ice %d: status = %d, want 200", i, got)
		}
	}
	// The full pairing-code budget is still available afterwards.
	for i := 1; i <= pairingGuessesPerIPPerMinute; i++ {
		if got := h.joinWS(lanUser, fmt.Sprintf("%06d", 600_000+i)); got != http.StatusForbidden {
			t.Fatalf("candidate %d after codeless requests: status = %d, want %d", i, got, http.StatusForbidden)
		}
	}
	// And once it IS spent, codeless LAN requests still go through.
	if got := h.joinWS(lanUser, "600999"); got != http.StatusTooManyRequests {
		t.Fatalf("budget should be spent: status = %d, want %d", got, http.StatusTooManyRequests)
	}
	if got := h.askICE(lanUser, ""); got != http.StatusOK {
		t.Fatalf("codeless /api/ice after the budget is spent: status = %d, want 200", got)
	}
}

// The per-endpoint request caps stay in force alongside the shared budget:
// hammering ONE code costs the guess budget nothing, so without them repeated
// identical requests would be free server load.
func TestPerEndpointRequestCapsStillApplyToARepeatedCode(t *testing.T) {
	clock := int64(1_000)
	now := func() int64 { return clock }
	rt := newTestRoute("000000", now) // production wsJoinPerIPPerMinute cap
	h := rt.handler()
	const ip = "203.0.113.40"

	for i := 1; i <= wsJoinPerIPPerMinute; i++ {
		if got := joinStatus(t, h, ip, "123456"); got != http.StatusForbidden {
			t.Fatalf("repeat %d: status = %d, want %d", i, got, http.StatusForbidden)
		}
	}
	if got := joinStatus(t, h, ip, "123456"); got != http.StatusTooManyRequests {
		t.Fatalf("repeated identical request past the endpoint cap: status = %d, want %d", got, http.StatusTooManyRequests)
	}
}
