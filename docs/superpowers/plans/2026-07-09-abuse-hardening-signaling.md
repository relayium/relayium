# Abuse-Surface Hardening — SIGNALING (C2 / H4 / M4)

- Date: 2026-07-09
- Source spec: `docs/superpowers/specs/2026-07-09-abuse-surface-hardening-design.md` (items **C2, H4, M4** only)
- Scope: the `server/internal/signal/` package + the `/ws` handler in `server/main.go`. H1/H2/H3/M1/M2/M3 are a separate plan and are out of scope here.

## Goal

Stop the signaling channel from being abusable as a free, un-metered bulk relay (C2), stop connection/room exhaustion (H4), and stop roster-broadcast churn (M4) — without touching WebRTC/crypto semantics or the pair-code→owner resolution, and without long-transfer regressions.

## Architecture

Three independent mechanisms, each built as a small **pure/injectable unit** so it is unit-testable without a live websocket or wall-clock sleeps:

- **C2 — per-connection budget/rate (`connLimiter`).** A new per-connection token-bucket + cumulative-byte limiter in the signal package, with an injectable `now func() time.Time`. `ServeWS` sets a 32 KiB single-frame read limit, constructs one `connLimiter` per connection, and calls `admit(len(frame))` on every `TypeSignal` frame *before* relaying; on refusal it closes the socket with `StatusPolicyViolation`. `TypeJoin` frames are never counted. The `admit` method is unit-tested directly with an injected clock; one httptest+`websocket.Dial` integration test covers the `SetReadLimit`+`Close` wiring that the unit test cannot reach (because `ServeWS`'s read loop is not unit-tested today).
- **H4 — exhaustion caps.** A new reusable `IPConnLimiter` (mutex + `map[string]int`, max 20 concurrent conns/IP) wired into the `/ws` handler (Acquire after `RoomFor`, before `websocket.Accept`; 429 on refusal; `defer Release`, pruning empty map entries). A global room cap (`maxRooms = 5000`) enforced inside `Hub.JoinLimited` when a brand-new room would be created. The LAN branch's `maxPeers` changes from `0` (unlimited) to a `lanMaxPeers = 50` const. **No paired-connection lifetime cap** is added (see Global Constraints).
- **M4 — roster debounce.** `Hub` gains an injectable `now func() time.Time` and `afterFunc func(time.Duration, func())`, plus a per-room "leading-edge + trailing-coalesce" throttle so that `broadcastRoster` fires at most once per 200 ms per room. `Join`/`Leave` call `scheduleRoster` instead of `broadcastRoster`. A single change broadcasts immediately (leading edge); a burst within the window coalesces to one trailing broadcast. Tests drive a captured timer func + a controllable clock deterministically (no sleeps).

## Tech Stack

- Go 1.26.3 (module `github.com/relayium/relayium`), package `server/internal/signal`.
- `github.com/coder/websocket` v1.8.15 (already a dependency) — `SetReadLimit`, `Close`, `Accept`, `Dial`, `CloseStatus`.
- Standard library only otherwise (`sync`, `time`, `net/http`, `net/http/httptest`, `context`, `encoding/json`, `strings`, `strconv`, `sync/atomic`).

## Global Constraints

- **No new external dependencies.**
- **All thresholds are named consts with comments noting they're tunable:** `maxSignalBytes=1MiB`, `burst=50`, `refill=10/s`, `per-IP conns=20`, `LAN peers=50`, `rooms=5000`, `debounce=200ms` (also `maxFrameBytes=32 KiB`).
- **Go commands run from `server/`** (e.g. `go test ./internal/signal/ -run TestConnLimiter -v`).
- **Follow existing signal-package patterns** (injectable `now`, lazy map pruning à la `RateLimiter`, `fakeConn`/`writeFn` test doubles).
- **Do not change WebRTC/crypto or the pair-code→owner resolution.**
- **Do NOT add any paired-connection lifetime cap.** A legitimate large file transfer across networks can exceed 15 minutes; a lifetime cap would truncate it. C2's cumulative-byte budget already kills persistent free bulk relay, so a lifetime cap is both unnecessary and harmful. This is an explicit non-goal.

---

### Task 1: `connLimiter` — per-connection byte budget + message rate (C2 core)

Pure, clock-injectable limiter. This is the unit-testable heart of C2; no websocket involved.

**Files:**
- Create: `server/internal/signal/connlimit.go`
- Test: `server/internal/signal/connlimit_test.go`

**Interfaces:**
- Produces: `func newConnLimiter(now func() time.Time) *connLimiter`
- Produces: `func (l *connLimiter) admit(frameLen int) (ok bool, reason string)`
- Consumes: injected `now func() time.Time` (default in production: `time.Now`).
- Package consts: `maxFrameBytes = 32 << 10`, `maxSignalBytes = 1 << 20`, `signalBurst = 50`, `signalRefillPerSec = 10.0`.

Steps:

- [ ] Write failing test file `server/internal/signal/connlimit_test.go` with four cases (a) cumulative bytes > 1 MiB refused, (b) 51st admit at the same clock instant refused for rate, (c) advancing the clock refills tokens, (d) sustained small traffic passes:
  ```go
  package signal

  import (
  	"testing"
  	"time"
  )

  func TestConnLimiterByteBudget(t *testing.T) {
  	now := time.Unix(0, 0)
  	l := newConnLimiter(func() time.Time { return now })
  	const half = 512 * 1024
  	if ok, _ := l.admit(half); !ok {
  		t.Fatal("first 512 KiB should pass")
  	}
  	if ok, _ := l.admit(half); !ok {
  		t.Fatal("second 512 KiB (=1 MiB exactly) should pass")
  	}
  	ok, reason := l.admit(1)
  	if ok || reason != "signal budget exceeded" {
  		t.Fatalf("over-budget frame must be refused, got ok=%v reason=%q", ok, reason)
  	}
  }

  func TestConnLimiterRateBurst(t *testing.T) {
  	now := time.Unix(0, 0)
  	l := newConnLimiter(func() time.Time { return now })
  	for i := 0; i < signalBurst; i++ {
  		if ok, _ := l.admit(1); !ok {
  			t.Fatalf("admit %d within burst should pass", i)
  		}
  	}
  	ok, reason := l.admit(1)
  	if ok || reason != "signal rate exceeded" {
  		t.Fatalf("admit past burst at same instant must be rate-refused, got ok=%v reason=%q", ok, reason)
  	}
  }

  func TestConnLimiterRefillsOverTime(t *testing.T) {
  	now := time.Unix(0, 0)
  	l := newConnLimiter(func() time.Time { return now })
  	for i := 0; i < signalBurst; i++ {
  		l.admit(1)
  	}
  	if ok, _ := l.admit(1); ok {
  		t.Fatal("bucket should be empty at the same instant")
  	}
  	now = now.Add(time.Second) // +10 tokens
  	if ok, _ := l.admit(1); !ok {
  		t.Fatal("after 1s refill an admit should pass again")
  	}
  }

  func TestConnLimiterNormalTrafficPasses(t *testing.T) {
  	now := time.Unix(0, 0)
  	l := newConnLimiter(func() time.Time { return now })
  	for i := 0; i < 200; i++ {
  		now = now.Add(200 * time.Millisecond) // 5 frames/s, well under refill; bytes stay tiny
  		if ok, reason := l.admit(2000); !ok {
  			t.Fatalf("normal small frame %d refused: %q", i, reason)
  		}
  	}
  }
  ```
- [ ] Run from `server/`: `go test ./internal/signal/ -run TestConnLimiter -v` — expect compile failure (undefined `newConnLimiter`, `signalBurst`).
- [ ] Implement `server/internal/signal/connlimit.go` with COMPLETE code:
  ```go
  package signal

  import "time"

  // Per-connection abuse limits for the signaling channel (C2). A single
  // rendezvous exchanges only a few KB of SDP/ICE, so these caps are generous for
  // real use yet cut off anyone trying to use /ws as a free bulk relay. All values
  // are tunable.
  const (
  	// maxFrameBytes is the single-frame read limit set on the websocket. Real
  	// SDP/ICE is a few KB (the data channel carries no audio/video codecs).
  	maxFrameBytes = 32 << 10 // 32 KiB
  	// maxSignalBytes is the cumulative TypeSignal payload budget per connection.
  	// One real rendezvous is well under 100 KB; 1 MiB gives ~10x headroom while a
  	// bulk relay (MB/GB) trips it quickly.
  	maxSignalBytes = 1 << 20 // 1 MiB
  	// signalBurst / signalRefillPerSec form a token bucket bounding message rate
  	// (CPU-flood protection): burst of 50, refilled at 10 tokens/sec.
  	signalBurst        = 50
  	signalRefillPerSec = 10.0
  )

  // connLimiter is per-connection local state (not shared/global). It counts only
  // TypeSignal payload bytes and TypeSignal message rate; TypeJoin is never passed
  // to admit. now is injected so the bucket refill is deterministically testable.
  type connLimiter struct {
  	bytesUsed  int64
  	tokens     float64
  	lastRefill time.Time
  	now        func() time.Time
  }

  func newConnLimiter(now func() time.Time) *connLimiter {
  	return &connLimiter{tokens: signalBurst, lastRefill: now(), now: now}
  }

  // admit accounts for one TypeSignal frame of frameLen raw bytes. It returns
  // (false, reason) when the connection has exceeded its message rate or its
  // cumulative byte budget; the caller then closes the socket with that reason.
  func (l *connLimiter) admit(frameLen int) (bool, string) {
  	t := l.now()
  	if elapsed := t.Sub(l.lastRefill).Seconds(); elapsed > 0 {
  		l.tokens += elapsed * signalRefillPerSec
  		if l.tokens > signalBurst {
  			l.tokens = signalBurst
  		}
  		l.lastRefill = t
  	}
  	if l.tokens < 1 {
  		return false, "signal rate exceeded"
  	}
  	l.tokens--
  	l.bytesUsed += int64(frameLen)
  	if l.bytesUsed > maxSignalBytes {
  		return false, "signal budget exceeded"
  	}
  	return true, ""
  }
  ```
- [ ] Run `go test ./internal/signal/ -run TestConnLimiter -v` — expect PASS.
- [ ] Run `go test ./internal/signal/` (full package) to confirm nothing else broke.
- [ ] Commit: `signal: add per-connection connLimiter (C2 byte budget + rate)`.

---

### Task 2: wire `connLimiter` into `ServeWS` + close-on-budget integration test (C2)

Wires the limiter into the read loop and proves the `SetReadLimit`+`Close(StatusPolicyViolation)` behavior over a real socket. The read loop is not unit-tested today, so this task's coverage comes from one httptest integration test.

**Files:**
- Modify: `server/internal/signal/client.go` (the `ServeWS` closure)
- Test: `server/internal/signal/serve_ws_test.go` (new)

**Interfaces:**
- Consumes: `newConnLimiter`, `admit`, `maxFrameBytes`, `maxSignalBytes` (Task 1); `*websocket.Conn.SetReadLimit(int64)`, `.Close(code, reason)`.
- Produces: no new exported symbols; behavior change only (`ServeWS` now enforces C2).

Steps:

- [ ] Write failing integration test `server/internal/signal/serve_ws_test.go`:
  ```go
  package signal

  import (
  	"context"
  	"encoding/json"
  	"net/http"
  	"net/http/httptest"
  	"strconv"
  	"strings"
  	"sync/atomic"
  	"testing"
  	"time"

  	"github.com/coder/websocket"
  )

  // A client that pushes past the 1 MiB cumulative signal budget must be closed by
  // the server with StatusPolicyViolation. This covers the SetReadLimit + Close
  // wiring in ServeWS that the connLimiter unit test cannot reach.
  func TestServeWSClosesOnByteBudgetExceeded(t *testing.T) {
  	hub := NewHub()
  	var seq int32
  	newID := func() string { n := atomic.AddInt32(&seq, 1); return "p" + strconv.Itoa(int(n)) }
  	handle := ServeWS(hub, newID)

  	mux := http.NewServeMux()
  	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
  		c, err := websocket.Accept(w, r, nil)
  		if err != nil {
  			return
  		}
  		handle(r.Context(), c, "testroom", 0, "127.0.0.1")
  		_ = c.Close(websocket.StatusNormalClosure, "")
  	})
  	srv := httptest.NewServer(mux)
  	defer srv.Close()

  	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
  	defer cancel()
  	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
  	c, _, err := websocket.Dial(ctx, url, nil)
  	if err != nil {
  		t.Fatalf("dial: %v", err)
  	}
  	defer c.CloseNow()

  	// TypeJoin bytes are never counted against the budget.
  	join, _ := json.Marshal(map[string]any{"type": "join", "name": "tester"})
  	_ = c.Write(ctx, websocket.MessageText, join)

  	// ~40 frames * ~30 KB = ~1.2 MiB > 1 MiB budget, and 40 < the 50-token burst,
  	// so the byte budget (not the rate) is what trips. Each frame stays under the
  	// 32 KiB read limit.
  	payload, _ := json.Marshal(strings.Repeat("y", 30000))
  	for i := 0; i < 40; i++ {
  		frame, _ := json.Marshal(map[string]any{"type": "signal", "to": "nobody", "data": json.RawMessage(payload)})
  		if err := c.Write(ctx, websocket.MessageText, frame); err != nil {
  			break // server has closed us; remaining writes error out
  		}
  	}

  	_, _, err = c.Read(ctx)
  	if got := websocket.CloseStatus(err); got != websocket.StatusPolicyViolation {
  		t.Fatalf("want PolicyViolation close, got status=%v err=%v", got, err)
  	}
  }
  ```
- [ ] Run from `server/`: `go test ./internal/signal/ -run TestServeWSClosesOnByteBudgetExceeded -v` — expect FAIL (server never closes; `Read` blocks until the 5s ctx deadline → non-PolicyViolation error).
- [ ] Implement the wiring in `server/internal/signal/client.go`. Replace the body of the returned closure in `ServeWS` so it (1) sets the read limit, (2) builds a `connLimiter`, (3) admits each `TypeSignal` before relaying:
  ```go
  func ServeWS(h *Hub, idgen func() string) func(ctx context.Context, c *websocket.Conn, room string, maxPeers int, clientIP string) {
  	return func(ctx context.Context, c *websocket.Conn, room string, maxPeers int, clientIP string) {
  		// Explicit single-frame cap: a real signaling frame is a few KB. Anything
  		// larger is rejected by coder/websocket at read time (ends the loop).
  		c.SetReadLimit(maxFrameBytes)

  		id := idgen()
  		conn := newWSConn(ctx, c)
  		lim := newConnLimiter(time.Now)
  		joined := false
  		defer func() {
  			if joined {
  				h.Leave(room, id)
  			}
  		}()

  		go func() {
  			t := time.NewTicker(pingInterval)
  			defer t.Stop()
  			for {
  				select {
  				case <-ctx.Done():
  					return
  				case <-t.C:
  					pctx, cancel := context.WithTimeout(ctx, pingTimeout)
  					err := c.Ping(pctx)
  					cancel()
  					if err != nil {
  						_ = c.Close(websocket.StatusGoingAway, "ping timeout")
  						return
  					}
  				}
  			}
  		}()

  		for {
  			_, data, err := c.Read(ctx)
  			if err != nil {
  				return
  			}
  			e, err := DecodeEnvelope(data)
  			if err != nil {
  				continue
  			}
  			switch e.Type {
  			case TypeJoin:
  				if !joined {
  					if h.JoinLimited(room, id, e.Name, conn, maxPeers, clientIP) {
  						joined = true
  					} else {
  						return // room full or global cap — close the connection
  					}
  				}
  			case TypeSignal:
  				// Count the raw frame bytes; join frames are never counted.
  				if ok, reason := lim.admit(len(data)); !ok {
  					_ = c.Close(websocket.StatusPolicyViolation, reason)
  					return
  				}
  				e.From = id
  				h.Relay(room, e)
  			}
  		}
  	}
  }
  ```
  (Only the `SetReadLimit`, `lim := newConnLimiter(time.Now)`, and the `admit` guard inside `case TypeSignal` are new; keep the rest byte-for-byte as it is today.)
- [ ] Run `go test ./internal/signal/ -run TestServeWSClosesOnByteBudgetExceeded -v` — expect PASS.
- [ ] Run `go test ./internal/signal/` and `go test ./internal/rzvous/` — the existing rzvous pairing/relay integration test must still pass (normal small signals stay well under both caps).
- [ ] Commit: `signal: enforce C2 read limit + signal budget/rate in ServeWS`.

---

### Task 3: `IPConnLimiter` — per-IP concurrent connection cap (H4)

Reusable concurrency limiter, unit-testable in isolation.

**Files:**
- Create: `server/internal/signal/ipconnlimit.go`
- Test: `server/internal/signal/ipconnlimit_test.go`

**Interfaces:**
- Produces: `func NewIPConnLimiter() *IPConnLimiter`
- Produces: `func (l *IPConnLimiter) Acquire(ip string) bool`
- Produces: `func (l *IPConnLimiter) Release(ip string)`
- Package const: `maxConnsPerIP = 20`.

Steps:

- [ ] Write failing test `server/internal/signal/ipconnlimit_test.go`:
  ```go
  package signal

  import "testing"

  func TestIPConnLimiterCapsPerIP(t *testing.T) {
  	l := NewIPConnLimiter()
  	for i := 0; i < maxConnsPerIP; i++ {
  		if !l.Acquire("1.2.3.4") {
  			t.Fatalf("acquire %d under cap should succeed", i)
  		}
  	}
  	if l.Acquire("1.2.3.4") {
  		t.Fatal("acquire past the per-IP cap must fail")
  	}
  	// Releasing frees a slot.
  	l.Release("1.2.3.4")
  	if !l.Acquire("1.2.3.4") {
  		t.Fatal("after a release a new acquire should succeed")
  	}
  }

  func TestIPConnLimiterPerIPIsolation(t *testing.T) {
  	l := NewIPConnLimiter()
  	for i := 0; i < maxConnsPerIP; i++ {
  		l.Acquire("1.1.1.1")
  	}
  	if !l.Acquire("2.2.2.2") {
  		t.Fatal("a different IP must have its own independent budget")
  	}
  }

  func TestIPConnLimiterPrunesEmptyEntries(t *testing.T) {
  	l := NewIPConnLimiter()
  	l.Acquire("9.9.9.9")
  	l.Release("9.9.9.9")
  	if _, ok := l.n["9.9.9.9"]; ok {
  		t.Fatal("fully-released IP must be pruned from the map")
  	}
  }
  ```
- [ ] Run from `server/`: `go test ./internal/signal/ -run TestIPConnLimiter -v` — expect compile failure.
- [ ] Implement `server/internal/signal/ipconnlimit.go`:
  ```go
  package signal

  import "sync"

  // maxConnsPerIP bounds concurrent /ws connections from a single client IP so one
  // source cannot exhaust server memory/goroutines. Tunable.
  const maxConnsPerIP = 20

  // IPConnLimiter is a per-IP concurrent-connection counter. Empty entries are
  // pruned on release to keep the map bounded (same pattern as RateLimiter).
  type IPConnLimiter struct {
  	mu sync.Mutex
  	n  map[string]int
  }

  func NewIPConnLimiter() *IPConnLimiter {
  	return &IPConnLimiter{n: make(map[string]int)}
  }

  // Acquire reserves a connection slot for ip, returning false when ip is already
  // at maxConnsPerIP. A successful Acquire must be balanced by exactly one Release.
  func (l *IPConnLimiter) Acquire(ip string) bool {
  	l.mu.Lock()
  	defer l.mu.Unlock()
  	if l.n[ip] >= maxConnsPerIP {
  		return false
  	}
  	l.n[ip]++
  	return true
  }

  // Release frees a slot for ip and drops the map entry when it reaches zero.
  func (l *IPConnLimiter) Release(ip string) {
  	l.mu.Lock()
  	defer l.mu.Unlock()
  	if l.n[ip] <= 1 {
  		delete(l.n, ip)
  		return
  	}
  	l.n[ip]--
  }
  ```
- [ ] Run `go test ./internal/signal/ -run TestIPConnLimiter -v` — expect PASS.
- [ ] Commit: `signal: add IPConnLimiter (H4 per-IP concurrent conn cap)`.

---

### Task 4: global room cap in `Hub.JoinLimited` (H4)

Reject creation of a brand-new room once the hub already holds `maxRooms`; existing rooms still admit peers.

**Files:**
- Modify: `server/internal/signal/hub.go` (`JoinLimited`, new const)
- Test: `server/internal/signal/hub_test.go` (add one test)

**Interfaces:**
- Consumes/Produces: `JoinLimited` signature unchanged; new package const `maxRooms = 5000`.

Steps:

- [ ] Add a failing test to `server/internal/signal/hub_test.go` (add `"strconv"` to its imports):
  ```go
  func TestJoinLimitedGlobalRoomCap(t *testing.T) {
  	h := NewHub()
  	for i := 0; i < maxRooms; i++ {
  		room := "r" + strconv.Itoa(i)
  		if !h.JoinLimited(room, "a", "A", &fakeConn{}, 0, "") {
  			t.Fatalf("room %d under the cap must be admitted", i)
  		}
  	}
  	// A brand-new room beyond the cap is rejected...
  	if h.JoinLimited("overflow", "x", "X", &fakeConn{}, 0, "") {
  		t.Fatal("a new room beyond maxRooms must be rejected")
  	}
  	// ...but an already-existing room still admits new peers.
  	if !h.JoinLimited("r0", "b", "B", &fakeConn{}, 0, "") {
  		t.Fatal("an existing room must still admit peers at the cap")
  	}
  }
  ```
- [ ] Run from `server/`: `go test ./internal/signal/ -run TestJoinLimitedGlobalRoomCap -v` — expect FAIL (overflow room currently admitted).
- [ ] Implement in `server/internal/signal/hub.go`: add the const and the cap check at the top of `JoinLimited`, before the room map is created:
  ```go
  // maxRooms bounds the total number of concurrent signaling rooms so the hub
  // cannot be driven to exhaust memory by opening unbounded distinct rooms.
  // Tunable.
  const maxRooms = 5000
  ```
  ```go
  func (h *Hub) JoinLimited(room, id, name string, c Conn, max int, clientIP string) bool {
  	h.mu.Lock()
  	if h.rooms[room] == nil {
  		if len(h.rooms) >= maxRooms {
  			h.mu.Unlock()
  			return false // global room cap: refuse to create a new room
  		}
  		h.rooms[room] = make(map[string]*peer)
  	}
  	if max > 0 && len(h.rooms[room]) >= max {
  		h.mu.Unlock()
  		return false
  	}
  	h.rooms[room][id] = &peer{id: id, name: name, conn: c}
  	h.mu.Unlock()

  	c.Send(Envelope{Type: TypeWelcome, Name: id, IP: clientIP})
  	h.broadcastRoster(room)
  	return true
  }
  ```
  (The `broadcastRoster(room)` call here becomes `scheduleRoster(room)` in Task 6 — leave it as `broadcastRoster` for now so this task compiles and passes standalone.)
- [ ] Run `go test ./internal/signal/ -run TestJoinLimitedGlobalRoomCap -v` — expect PASS.
- [ ] Run `go test ./internal/signal/` (all existing hub tests must still pass; they create only a handful of rooms).
- [ ] Commit: `signal: cap total rooms at maxRooms in JoinLimited (H4)`.

---

### Task 5: `/ws` handler wiring — IPConnLimiter + LAN peer cap (H4)

Wire the per-IP concurrency limiter and the LAN peer cap into `main.go`. No new unit test harness (the `/ws` closure lives in `package main`); correctness of the limiter itself is covered by Task 3, and this task verifies via build/vet + the existing rzvous integration test.

**Files:**
- Modify: `server/main.go` (the `ipx := ...` setup block and the `/ws` handler, ~lines 126–175)

**Interfaces:**
- Consumes: `signal.NewIPConnLimiter()`, `Acquire`, `Release` (Task 3); `ipx.IP(r)`, `signal.RoomFor`.
- Produces: new local `ipConns := signal.NewIPConnLimiter()`; new package-level const `lanMaxPeers = 50`.

Steps:

- [ ] Add `const lanMaxPeers = 50 // LAN room peer cap (H4); tunable.` near the other `main` package consts.
- [ ] After `hub := signal.NewHub()` (around line 132), add:
  ```go
  // Per-IP concurrent /ws connection cap (H4). Acquired after the room is
  // resolved and before the websocket upgrade; released when the handler returns.
  ipConns := signal.NewIPConnLimiter()
  ```
- [ ] Replace the `/ws` handler body so the LAN branch uses `lanMaxPeers`, and Acquire/Release bracket the connection (compute `ipx.IP(r)` once):
  ```go
  mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
  	code := r.URL.Query().Get("code")
  	if code != "" && !wsCodeLimiter.Allow(ipx.IP(r)) {
  		http.Error(w, "too many pairing attempts", http.StatusTooManyRequests)
  		return
  	}
  	room, maxPeers, lan, ok := signal.RoomFor(code, pairReg.Validate)
  	if !ok {
  		http.Error(w, "invalid or expired pairing code", http.StatusForbidden)
  		return
  	}
  	if lan {
  		room = ipx.RoomKey(r)
  		maxPeers = lanMaxPeers // LAN: capped (was unlimited)
  	}
  	ip := ipx.IP(r)
  	if !ipConns.Acquire(ip) {
  		http.Error(w, "too many connections", http.StatusTooManyRequests)
  		return
  	}
  	defer ipConns.Release(ip)
  	c, err := websocket.Accept(w, r, nil)
  	if err != nil {
  		return
  	}
  	ctx := r.Context()
  	handle(ctx, c, room, maxPeers, ip)
  	_ = c.Close(websocket.StatusNormalClosure, "")
  })
  ```
- [ ] Run from `server/`: `go build ./...` and `go vet ./...` — expect clean.
- [ ] Run `go test ./internal/rzvous/` — the two-peer LAN pairing test must still pass (2 peers < 50 cap; 2 conns from one loopback IP < 20).
- [ ] Commit: `main: cap per-IP /ws connections and LAN room peers (H4)`.

---

### Task 6: roster broadcast debounce (M4)

Coalesce `broadcastRoster` per room to at most once per 200 ms with a leading edge, using an injectable clock + timer so it is deterministic in tests. Also convert the existing hub tests that assert on a *second* same-room mutation to a synchronous test hub (behavior-preserving), because the real-clock default now delays coalesced broadcasts.

**Files:**
- Modify: `server/internal/signal/hub.go` (`Hub` struct, `NewHub`, add `newHub`, `scheduleRoster`, `flushRoster`, `pruneBcast`; `JoinLimited`/`Leave` call `scheduleRoster`)
- Test: `server/internal/signal/hub_test.go` (add debounce tests; add `syncHub`/`countType` helpers; repoint affected existing tests)

**Interfaces:**
- Produces (unexported, test-facing): `func newHub(now func() time.Time, after func(time.Duration, func())) *Hub`.
- Consumes: injected `now func() time.Time` and `afterFunc func(time.Duration, func())`. Production default: `time.Now` and a `time.AfterFunc` wrapper.
- Package const: `rosterDebounce = 200 * time.Millisecond`.
- `NewHub()` signature unchanged.

Design (concrete, no wall-clock sleeps): per room the hub keeps a `roomBroadcast{ nextAllowed time.Time; pending, armed bool }`. `scheduleRoster(room)`:
- If `now >= nextAllowed` (quiet period): fire `broadcastRoster` **immediately** (leading edge) and set `nextAllowed = now + 200ms`.
- Else (inside the window): set `pending = true`; if no timer is `armed`, arm one via `afterFunc(nextAllowed-now, flushRoster)` and set `armed = true`.
`flushRoster(room)` clears `armed`; if `pending`, clears it, resets `nextAllowed = now + 200ms`, and does one trailing `broadcastRoster`. The lock is always released **before** calling `afterFunc` or `broadcastRoster`, so a synchronous test `afterFunc` (which calls `f()` inline) cannot deadlock. Empty rooms are pruned from the `bcast` map to bound memory. A burst therefore produces at most 2 broadcasts (1 leading + 1 trailing); a lone change produces exactly 1, immediately.

Steps:

- [ ] Add failing debounce tests + helpers to `server/internal/signal/hub_test.go`:
  ```go
  // countType counts how many envelopes of a given type a fakeConn has received.
  func countType(f *fakeConn, typ string) int {
  	f.mu.Lock()
  	defer f.mu.Unlock()
  	n := 0
  	for _, e := range f.sent {
  		if e.Type == typ {
  			n++
  		}
  	}
  	return n
  }

  // syncHub runs the roster timer inline so tests that assert on the roster after a
  // second same-room mutation see it immediately (debounce is behavior-preserving
  // when the trailing timer fires synchronously).
  func syncHub() *Hub {
  	return newHub(time.Now, func(_ time.Duration, f func()) { f() })
  }

  func TestRosterBroadcastDebounced(t *testing.T) {
  	now := time.Unix(1000, 0)
  	var pending []func()
  	after := func(_ time.Duration, f func()) { pending = append(pending, f) }
  	h := newHub(func() time.Time { return now }, after)

  	a, b, c := &fakeConn{}, &fakeConn{}, &fakeConn{}
  	h.JoinLimited("t:room", "a", "A", a, 0, "") // leading edge → immediate broadcast
  	h.JoinLimited("t:room", "b", "B", b, 0, "") // within window → coalesced
  	h.JoinLimited("t:room", "c", "C", c, 0, "") // within window → coalesced

  	if got := countType(a, TypePeers); got != 1 {
  		t.Fatalf("during the window a should have exactly 1 roster broadcast (leading), got %d", got)
  	}
  	if len(pending) != 1 {
  		t.Fatalf("a burst must arm exactly one trailing timer, got %d", len(pending))
  	}

  	now = now.Add(rosterDebounce) // advance past the window and fire the trailing timer
  	pending[0]()

  	if got := countType(a, TypePeers); got != 2 {
  		t.Fatalf("after the trailing flush a should have 2 roster broadcasts, got %d", got)
  	}
  	if last := a.last(); last.Type != TypePeers || len(last.Peers) != 3 {
  		t.Fatalf("final roster must list all 3 peers, got %+v", last)
  	}
  }

  func TestRosterSingleChangeBroadcastsPromptly(t *testing.T) {
  	now := time.Unix(2000, 0)
  	armed := 0
  	h := newHub(func() time.Time { return now }, func(_ time.Duration, _ func()) { armed++ })
  	a := &fakeConn{}
  	h.JoinLimited("t:room", "a", "A", a, 0, "")
  	if got := countType(a, TypePeers); got != 1 {
  		t.Fatalf("a single change must broadcast immediately, got %d", got)
  	}
  	if armed != 0 {
  		t.Fatalf("a single change must not arm a trailing timer, got %d", armed)
  	}
  }
  ```
- [ ] Repoint the existing tests that assert on a roster after a **second same-room** mutation to `syncHub()` (they otherwise see only the leading broadcast under the real-clock default): in `TestJoinSendsWelcomeAndRoster`, `TestWelcomeIPNotInRoster`, `TestLeaveRebroadcastsRoster`, and `TestJoinLimitedEnforcesCapacity`, replace `h := NewHub()` with `h := syncHub()`. (`TestJoinLimitedStampsWelcomeWithClientIP`, `TestJoinUnlimitedAllowsMany`, `TestRelayGoesOnlyToTarget`, `TestRoomsAreIsolated`, and `TestJoinLimitedGlobalRoomCap` only assert on welcome/return-values/leading broadcasts and can stay on `NewHub()`.)
- [ ] Run from `server/`: `go test ./internal/signal/ -run TestRoster -v` — expect compile failure (undefined `newHub`, `rosterDebounce`, `scheduleRoster`).
- [ ] Implement the debounce in `server/internal/signal/hub.go`. Add `"time"` to imports; extend the struct/constructors and add the throttle:
  ```go
  // rosterDebounce coalesces roster broadcasts to at most one per room per window
  // (leading edge + trailing flush), damping churn from rapid Join/Leave. Tunable.
  const rosterDebounce = 200 * time.Millisecond

  type roomBroadcast struct {
  	nextAllowed time.Time // earliest instant a new leading broadcast may fire
  	pending     bool      // a change occurred inside the window, not yet broadcast
  	armed       bool      // a trailing timer is scheduled
  }

  type Hub struct {
  	mu        sync.Mutex
  	rooms     map[string]map[string]*peer // room key -> peer id -> peer
  	bcast     map[string]*roomBroadcast   // room key -> debounce state
  	now       func() time.Time
  	afterFunc func(time.Duration, func())
  }

  func NewHub() *Hub {
  	return newHub(time.Now, func(d time.Duration, f func()) { time.AfterFunc(d, f) })
  }

  // newHub builds a Hub with an injectable clock and timer so the roster debounce
  // is deterministically testable without wall-clock sleeps.
  func newHub(now func() time.Time, after func(time.Duration, func())) *Hub {
  	return &Hub{
  		rooms:     make(map[string]map[string]*peer),
  		bcast:     make(map[string]*roomBroadcast),
  		now:       now,
  		afterFunc: after,
  	}
  }
  ```
  Change `JoinLimited`'s final `h.broadcastRoster(room)` and `Leave`'s `h.broadcastRoster(room)` to `h.scheduleRoster(room)`. Then add:
  ```go
  // scheduleRoster requests a roster broadcast for room, coalescing to at most one
  // per rosterDebounce window. The lock is released before afterFunc/broadcastRoster
  // so a synchronous test timer cannot deadlock.
  func (h *Hub) scheduleRoster(room string) {
  	h.mu.Lock()
  	rb := h.bcast[room]
  	if rb == nil {
  		rb = &roomBroadcast{}
  		h.bcast[room] = rb
  	}
  	now := h.now()
  	if !now.Before(rb.nextAllowed) {
  		rb.nextAllowed = now.Add(rosterDebounce)
  		rb.pending = false
  		h.mu.Unlock()
  		h.broadcastRoster(room)
  		h.pruneBcast(room)
  		return
  	}
  	rb.pending = true
  	arm := !rb.armed
  	if arm {
  		rb.armed = true
  	}
  	delay := rb.nextAllowed.Sub(now)
  	h.mu.Unlock()
  	if arm {
  		h.afterFunc(delay, func() { h.flushRoster(room) })
  	}
  }

  // flushRoster fires the trailing broadcast at the end of a window when changes
  // coalesced during it.
  func (h *Hub) flushRoster(room string) {
  	h.mu.Lock()
  	rb := h.bcast[room]
  	if rb == nil {
  		h.mu.Unlock()
  		return
  	}
  	rb.armed = false
  	if !rb.pending {
  		h.mu.Unlock()
  		return
  	}
  	rb.pending = false
  	rb.nextAllowed = h.now().Add(rosterDebounce)
  	h.mu.Unlock()
  	h.broadcastRoster(room)
  	h.pruneBcast(room)
  }

  // pruneBcast drops debounce state for a room that is now empty and idle, keeping
  // the bcast map bounded.
  func (h *Hub) pruneBcast(room string) {
  	h.mu.Lock()
  	rb := h.bcast[room]
  	if rb != nil && !rb.pending && !rb.armed && h.rooms[room] == nil {
  		delete(h.bcast, room)
  	}
  	h.mu.Unlock()
  }
  ```
  (`broadcastRoster` itself is unchanged; when a room has been emptied it simply finds no members and sends nothing.)
- [ ] Run `go test ./internal/signal/ -run TestRoster -v` — expect PASS.
- [ ] Run `go test ./internal/signal/` (full package) — all existing + new tests pass, including the repointed `syncHub()` ones.
- [ ] Run `go test ./internal/rzvous/` — real-socket pairing/roster still works.
- [ ] Commit: `signal: debounce roster broadcasts per room to 200ms (M4)`.

---

## Self-Review

**Spec coverage:**

- **C2 — signaling can't be a free bulk relay.** `connLimiter` (Task 1) enforces the 1 MiB cumulative byte budget and the 50-burst/10-per-sec token bucket, unit-tested with an injected clock for all four required cases (byte over-budget, rate at burst edge, refill-over-time, sustained normal traffic). `ServeWS` (Task 2) sets `SetReadLimit(32 KiB)`, builds one `connLimiter` per connection, admits every `TypeSignal` on the raw frame length before relaying, closes with `StatusPolicyViolation` on refusal, and never counts `TypeJoin`. The httptest+`websocket.Dial` integration test asserts the real close code via `websocket.CloseStatus`. ✅
- **H4 — connection/room exhaustion.** `IPConnLimiter` (Task 3, max 20/IP, mutex+map, pruned on release) unit-tested for cap/release/isolation/prune; wired into `/ws` (Task 5) as Acquire-after-`RoomFor`/before-`Accept`, 429 on refusal, `defer Release`. LAN `maxPeers` becomes `lanMaxPeers = 50` (Task 5). Global `maxRooms = 5000` enforced in `JoinLimited` for new rooms only, unit-tested (Task 4). No paired-connection lifetime cap is added (Global Constraints). ✅
- **M4 — roster broadcast debounce.** `Hub` gains injectable `now`/`afterFunc`; `scheduleRoster` coalesces to at most one broadcast per 200 ms per room (leading + trailing), unit-tested deterministically via a captured timer func + controllable clock: a 3-join burst yields exactly 2 broadcasts with a correct final 3-peer roster, and a lone change broadcasts immediately with no timer armed. ✅

**Type consistency:**

- `admit(frameLen int)` is called with `len(data) int`; internal accounting uses `int64` (`bytesUsed`, `maxSignalBytes = 1<<20` untyped const compares cleanly). `tokens float64` with `signalRefillPerSec = 10.0`. `maxFrameBytes` (untyped `32<<10`) passes to `SetReadLimit(int64)` fine.
- `newConnLimiter(now func() time.Time)` matches `time.Now`. `Hub.afterFunc func(time.Duration, func())` matches both the production `time.AfterFunc` wrapper and the test doubles (`func(_ time.Duration, f func()){ f() }` and the capturing variant).
- `IPConnLimiter.Acquire/Release(ip string)` keyed by `ipx.IP(r) string`; `RoomFor` returns `(string, int, bool, bool)` consumed unchanged; `JoinLimited` signature unchanged (only room-cap logic added). `NewHub()` signature unchanged, so `main.go` and all callers are unaffected.
- No new imports beyond stdlib + the already-vendored `github.com/coder/websocket`; `hub.go` adds `"time"`, `hub_test.go` adds `"strconv"`, `serve_ws_test.go` adds `net/http`, `net/http/httptest`, `strconv`, `strings`, `sync/atomic`, `encoding/json`, `context`, `time`, and the websocket package.

**Cross-task ordering note:** Task 4 writes `JoinLimited` with `broadcastRoster`; Task 6 switches that call (and `Leave`'s) to `scheduleRoster` and repoints four existing hub tests to `syncHub()`. Each task's suite is green at its own commit; Task 6 explicitly re-greens the tests it touches.
