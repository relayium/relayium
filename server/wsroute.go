package main

import (
	"context"
	"log"
	"net/http"

	"github.com/coder/websocket"
	"github.com/relayium/relayium/internal/signal"
)

// wsJoinPerIPPerMinute is the per-IP REQUEST cap for /ws?code= join attempts —
// how many code-bearing requests this one endpoint will process from an address
// per minute, whatever codes they carry.
//
// Deliberately the SAME number as the /api/ice request cap (main.go): both
// endpoints take a pairing code and both hand out something a guesser wants
// (rendezvous rights here, a TURN credential there), so a looser cap on either
// would be the real limit and the tighter one decoration.
//
// This is NOT the bound on how many codes an address may TRY. Two endpoints with
// two independent request caps let an attacker split guesses and get the sum.
// The bound on distinct guesses is signal.CodeGuessLimiter (pairingGuessBudget
// below), shared by both endpoints; this cap remains so that repeating one code
// is not free load.
//
// It was 30/min while codes were 6 characters over a 24-character alphabet.
// A 6-digit code has 1e6 live values, so a single IP at 30/min would get 150
// requests inside the 300-second TTL; at 5/min it gets 25. See signal.CodeLen
// for the full arithmetic and what a guess actually buys.
//
// The cost is real and is accepted knowingly: several devices behind ONE NAT
// (an office, a school, a phone on carrier-grade NAT) share this budget, so the
// sixth join attempt from that address inside a minute is refused even when
// every one of them is legitimate. A join is one attempt per device per code —
// reloading the page or retrying a failed pair is what spends the rest.
const wsJoinPerIPPerMinute = 5

// pairingGuessesPerIPPerMinute is the number of DISTINCT pairing codes one
// address may present per minute across /ws?code= AND /api/ice?code= together.
//
// One code is one guess no matter how many requests it takes to spend it, so a
// real receiver (which asks /api/ice for relay credentials and then joins /ws
// with the same code) uses exactly one of these. See signal.CodeGuessLimiter for
// why the two endpoints must share one budget rather than hold one each.
const pairingGuessesPerIPPerMinute = 5

// pairingGuessBudget is the shared distinct-candidate cap. Declared as an
// interface (rather than *signal.CodeGuessLimiter) so a test can assert that the
// /ws handler and account.handleICE really do spend ONE object's budget: that is
// the whole property, and it cannot be shown by two handlers each holding a
// limiter of the same type.
type pairingGuessBudget interface {
	// AllowCode records `code` as presented by `ip` and reports whether the
	// address stays within its distinct-candidate budget. An empty code is not a
	// guess and is always allowed.
	AllowCode(ip, code string) bool
}

// wsRoute is everything the /ws handler needs. Grouped into a struct (rather
// than passed as eight parameters to a closure inside main) so the admission
// gates below — rate limit, code shape, registry lookup, breaker, connection
// caps — can be driven directly from a test. Every one of them answers before
// the websocket upgrade, so a test can exercise them over plain HTTP.
type wsRoute struct {
	// reqLimiter is this endpoint's own request cap (wsJoinPerIPPerMinute).
	reqLimiter *signal.RateLimiter
	// guessBudget is the cross-endpoint distinct-code cap, shared with /api/ice.
	guessBudget  pairingGuessBudget
	guessBreaker *signal.GuessBreaker
	ipx          *signal.IPExtractor
	validate     func(string) bool
	globalConns  *signal.GlobalConnLimiter
	ipConns      *signal.IPConnLimiter
	// handle takes the resolved room plus whether it is the code-less LAN room:
	// installation presence (device grouping / activation) is honoured there
	// only, so the two-participant pairing-code room keeps its exact semantics.
	handle       func(ctx context.Context, c *websocket.Conn, room string, maxPeers int, ip string, lan bool)
	lanMaxPeers  int
}

func (rt wsRoute) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Query().Get("code")
		clientIP := rt.ipx.IP(r)
		// Two caps, in cheapest-first order. The request cap keeps a flood of
		// (even identical) code-bearing requests off the rest of the handler; the
		// shared guess budget is what actually bounds how many DIFFERENT codes
		// this address gets to try, counting /api/ice's attempts too, so the two
		// validity oracles cannot be added together for double the guesses.
		if code != "" && !rt.reqLimiter.Allow(clientIP) {
			http.Error(w, "too many pairing attempts", http.StatusTooManyRequests)
			return
		}
		if code != "" && rt.guessBudget != nil && !rt.guessBudget.AllowCode(clientIP, code) {
			http.Error(w, "too many pairing attempts", http.StatusTooManyRequests)
			return
		}
		// 形状不对的直接拒，不进注册表：爆破流量里绝大多数是随便拼的串，没必要
		// 让它们变成 map 查询和日志里的攻击者自选内容。注意仍然走上面的限流，
		// 否则这条快速路径反而成了免费的试探通道。
		if code != "" && !signal.ValidCodeFormat(code) {
			http.Error(w, "invalid or expired pairing code", http.StatusForbidden)
			return
		}
		room, maxPeers, lan, ok := signal.RoomFor(code, rt.validate)
		if !ok {
			// Invalid/expired code = a guess. Feed the global breaker; when it is
			// open, shed with 429 and a throttled WARN. Valid codes are unaffected:
			// this branch is only reached when RoomFor already refused the code.
			if code != "" {
				if open, logNow := rt.guessBreaker.RecordInvalid(); open {
					if logNow {
						log.Printf("WARNING: pairing-code guess breaker OPEN — shedding invalid /ws?code= joins")
					}
					http.Error(w, "too many pairing attempts", http.StatusTooManyRequests)
					return
				}
			}
			http.Error(w, "invalid or expired pairing code", http.StatusForbidden)
			return
		}
		if lan {
			room = rt.ipx.RoomKey(r)
			maxPeers = rt.lanMaxPeers // LAN: capped (was unlimited)
		}
		ip := clientIP
		// Global check first: it's a plain int compare under the limiter's own
		// mutex, cheaper than the per-IP map lookup below, and if the server is
		// already at its global cap there is no reason to pay for that lookup
		// (or grow the per-IP map with an entry we're about to refuse anyway).
		if !rt.globalConns.Acquire() {
			http.Error(w, "too many connections", http.StatusTooManyRequests)
			return
		}
		defer rt.globalConns.Release()
		if !rt.ipConns.Acquire(ip) {
			http.Error(w, "too many connections", http.StatusTooManyRequests)
			return
		}
		defer rt.ipConns.Release(ip)
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		ctx := r.Context()
		rt.handle(ctx, c, room, maxPeers, ip, lan)
		_ = c.Close(websocket.StatusNormalClosure, "")
	}
}
