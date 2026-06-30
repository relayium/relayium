# 6 位短码配对 · 免登录实时直传 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让两台不同网络下的设备用一个 6 位短码免登录配对，进行实时点对点直传（文件不经服务器），并在跨网络页补全可用的实时传输 UI。

**Architecture:** 信令服务器新增第三种房间键 `c:<code>`（与现有 `t:<token>` token 房间、`<公网IP>` LAN 房间并列）。匿名 `POST /api/pair` 由内存 `PairRegistry` 铸造全局唯一短码（TTL 5 分钟、按 IP 限速）。客户端把码放进 URL 片段 `#c=<code>` 并 reload，复刻现有 token 进房机制；`fetchIceServers("")` 天然只给 STUN。真正的实时传输界面（peers/接收卡/进度卡）当前只在 LAN 路由渲染，本期用 Svelte snippet 抽出并在跨网络页也渲染，顺带补全现有分享链接的传输缺口。

**Tech Stack:** Go `net/http` + `crypto/rand`；Svelte 5 runes + TypeScript；Vitest；coder/websocket。

## Global Constraints

- 短码仅 STUN，**绝不**为 code 房间签发 TURN 凭证（TURN 仍仅 token 授权）。
- 配对码是"找对方的暗号"，非密钥；文件全程不经服务器（实时 WebRTC DTLS 直传）。
- `POST /api/pair` **匿名**（不走 `RequireSession`），但按客户端 IP 限速。
- 码格式：6 位数字，**允许前导零**（如 `042424`）。客户端正则 `/^#c=(\d{6})$/`。
- 短码功能**不依赖数据库**：`PairRegistry` 纯内存，DB 不可用时短码仍可用。
- 所有新 i18n 文案覆盖全部 6 种语言（zh/en/ja/ko/de/fr）；每个语言对象都标注 `: Messages`，缺键由 `svelte-check` 报错兜底。
- 提交信息结尾：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- Go 测试：`cd server && go test ./...`；前端：`cd web && npm run check && npm test && npm run build`。

## File Structure

- `server/internal/signal/pair.go`（新）：`PairRegistry`（Mint/Validate/reap/Run）。
- `server/internal/signal/pair_test.go`（新）。
- `server/internal/signal/pairhttp.go`（新）：`RateLimiter` + `PairHandler`（匿名 HTTP 端点）。
- `server/internal/signal/pairhttp_test.go`（新）。
- `server/internal/signal/route.go`（新）：纯函数 `RoomFor`（决定 code/token/LAN 房间）。
- `server/internal/signal/route_test.go`（新）。
- `server/main.go`（改）：建 `PairRegistry`、起回收 goroutine、注册 `POST /api/pair`、`/ws` 用 `RoomFor`。
- `web/src/lib/transfer-link.ts`（改）：`parseCodeParam`、`createPair`、`wsURL` 加 code 形参。
- `web/src/lib/transfer-link.test.ts`（改）。
- `web/src/lib/router.svelte.ts`（改）：`routeFromLocation`/`navigate` 纳入 `#c=`。
- `web/src/lib/router.test.ts`（改）。
- `web/src/lib/i18n.svelte.ts`（改）：新增 `pair` 段（6 语言）。
- `web/src/lib/i18n.test.ts`（改）：断言 `pair` 关键键存在。
- `web/src/lib/CodePairing.svelte`（新）：发送/接收码 UI + 码展示/倒计时。
- `web/src/lib/App.svelte`（改）：`roomCode`、`showTransfer`、`transferSurface` snippet、传 prop 给 CrossPage。
- `web/src/lib/CrossPage.svelte`（改）：两卡重排，渲染 `transferSurface` / `CodePairing`。

执行顺序：1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9。

---

### Task 1: PairRegistry（短码铸造/校验/回收）

**Files:**
- Create: `server/internal/signal/pair.go`
- Test: `server/internal/signal/pair_test.go`

**Interfaces:**
- Produces:
  - `func NewPairRegistry(ttlSeconds int64, now func() int64) *PairRegistry`
  - `func (p *PairRegistry) Mint() (code string, expiresAt int64)`
  - `func (p *PairRegistry) Validate(code string) bool`
  - `func (p *PairRegistry) Run(ctx context.Context, interval time.Duration)`（周期回收过期码）

- [ ] **Step 1: Write the failing test**

```go
// server/internal/signal/pair_test.go
package signal

import (
	"testing"
)

func TestPairRegistryMintValidate(t *testing.T) {
	clock := int64(1000)
	now := func() int64 { return clock }
	r := NewPairRegistry(300, now)

	code, exp := r.Mint()
	if len(code) != 6 {
		t.Fatalf("code = %q, want 6 digits", code)
	}
	for _, c := range code {
		if c < '0' || c > '9' {
			t.Fatalf("code %q has non-digit", code)
		}
	}
	if exp != 1300 {
		t.Fatalf("exp = %d, want 1300", exp)
	}
	if !r.Validate(code) {
		t.Fatal("freshly minted code should validate")
	}
	if r.Validate("000000-bogus") || r.Validate("999999") {
		t.Fatal("unknown code must not validate")
	}

	// Expire it.
	clock = 1300
	if r.Validate(code) {
		t.Fatal("code at exact expiry must be invalid")
	}
}

func TestPairRegistryMintUnique(t *testing.T) {
	clock := int64(1)
	r := NewPairRegistry(300, func() int64 { return clock })
	seen := map[string]bool{}
	for i := 0; i < 500; i++ {
		c, _ := r.Mint()
		if seen[c] {
			t.Fatalf("Mint returned a live duplicate: %s", c)
		}
		seen[c] = true
	}
}

func TestPairRegistryReapDropsExpired(t *testing.T) {
	clock := int64(1000)
	r := NewPairRegistry(300, func() int64 { return clock })
	code, _ := r.Mint()
	clock = 2000
	r.reap()
	r.mu.Lock()
	_, present := r.codes[code]
	r.mu.Unlock()
	if present {
		t.Fatal("reap should delete an expired code")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/signal/ -run TestPairRegistry -v`
Expected: FAIL — `undefined: NewPairRegistry`.

- [ ] **Step 3: Write minimal implementation**

```go
// server/internal/signal/pair.go
package signal

import (
	"context"
	"crypto/rand"
	"fmt"
	"math/big"
	"sync"
	"time"
)

// PairRegistry mints short numeric pairing codes for anonymous, login-free
// realtime rendezvous. Codes are in-memory only (no DB) and short-lived; a code
// becomes a 2-peer signaling room "c:<code>". now is injected for tests.
type PairRegistry struct {
	mu    sync.Mutex
	codes map[string]int64 // code -> unix expiry
	ttl   int64
	now   func() int64
}

func NewPairRegistry(ttlSeconds int64, now func() int64) *PairRegistry {
	return &PairRegistry{codes: make(map[string]int64), ttl: ttlSeconds, now: now}
}

// Mint returns a fresh 6-digit code not currently colliding with a live one,
// plus its unix expiry.
func (p *PairRegistry) Mint() (string, int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	for {
		code := randCode()
		if exp, ok := p.codes[code]; ok && exp > now {
			continue // collide with a still-live code; try again
		}
		exp := now + p.ttl
		p.codes[code] = exp
		return code, exp
	}
}

// Validate reports whether code exists and has not expired (expiry is exclusive).
func (p *PairRegistry) Validate(code string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	exp, ok := p.codes[code]
	return ok && exp > p.now()
}

func (p *PairRegistry) reap() {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	for c, exp := range p.codes {
		if exp <= now {
			delete(p.codes, c)
		}
	}
}

// Run reaps expired codes every interval until ctx is cancelled.
func (p *PairRegistry) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			p.reap()
		}
	}
}

// randCode returns a uniformly random 6-digit string, zero-padded (leading
// zeros allowed, e.g. "042424").
func randCode() string {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		// crypto/rand failure is unrecoverable for a security-relevant code.
		panic(fmt.Sprintf("signal: crypto/rand: %v", err))
	}
	return fmt.Sprintf("%06d", n.Int64())
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && go test ./internal/signal/ -run TestPairRegistry -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/internal/signal/pair.go server/internal/signal/pair_test.go
git commit -m "feat(signal): PairRegistry for anonymous 6-digit rendezvous codes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 匿名 /api/pair 端点 + 按 IP 限速

**Files:**
- Create: `server/internal/signal/pairhttp.go`
- Test: `server/internal/signal/pairhttp_test.go`

**Interfaces:**
- Consumes: `*PairRegistry` (Task 1).
- Produces:
  - `func NewRateLimiter(limit int, window time.Duration, now func() int64) *RateLimiter`
  - `func (rl *RateLimiter) Allow(ip string) bool`
  - `func PairHandler(reg *PairRegistry, rl *RateLimiter) http.HandlerFunc`
  - 成功响应 JSON：`{"code":"424242","expiresAt":1300}`；被限速 → 429。

- [ ] **Step 1: Write the failing test**

```go
// server/internal/signal/pairhttp_test.go
package signal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestPairHandlerMints(t *testing.T) {
	clock := int64(1000)
	now := func() int64 { return clock }
	reg := NewPairRegistry(300, now)
	rl := NewRateLimiter(5, time.Minute, now)
	h := PairHandler(reg, rl)

	req := httptest.NewRequest(http.MethodPost, "/api/pair", nil)
	req.RemoteAddr = "203.0.113.5:5555"
	rec := httptest.NewRecorder()
	h(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body struct {
		Code      string `json:"code"`
		ExpiresAt int64  `json:"expiresAt"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Code) != 6 || body.ExpiresAt != 1300 {
		t.Fatalf("body = %+v, want 6-digit code + exp 1300", body)
	}
	if !reg.Validate(body.Code) {
		t.Fatal("minted code should validate in the registry")
	}
}

func TestPairHandlerRateLimitsPerIP(t *testing.T) {
	clock := int64(1000)
	now := func() int64 { return clock }
	reg := NewPairRegistry(300, now)
	rl := NewRateLimiter(2, time.Minute, now)
	h := PairHandler(reg, rl)

	call := func(ip string) int {
		req := httptest.NewRequest(http.MethodPost, "/api/pair", nil)
		req.RemoteAddr = ip + ":1"
		rec := httptest.NewRecorder()
		h(rec, req)
		return rec.Code
	}

	if call("198.51.100.1") != 200 || call("198.51.100.1") != 200 {
		t.Fatal("first two from an IP should pass")
	}
	if got := call("198.51.100.1"); got != http.StatusTooManyRequests {
		t.Fatalf("third = %d, want 429", got)
	}
	// A different IP is unaffected.
	if call("198.51.100.2") != 200 {
		t.Fatal("a fresh IP should pass")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/signal/ -run TestPairHandler -v`
Expected: FAIL — `undefined: NewRateLimiter` / `PairHandler`.

- [ ] **Step 3: Write minimal implementation**

```go
// server/internal/signal/pairhttp.go
package signal

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

// RateLimiter is a simple per-key fixed-window counter (key = client IP). It is
// intentionally minimal: bounded memory via lazy pruning on each Allow call.
type RateLimiter struct {
	mu     sync.Mutex
	hits   map[string][]int64
	limit  int
	window int64
	now    func() int64
}

func NewRateLimiter(limit int, window time.Duration, now func() int64) *RateLimiter {
	return &RateLimiter{hits: make(map[string][]int64), limit: limit, window: int64(window.Seconds()), now: now}
}

// Allow records a hit for key and reports whether it stays within limit over the
// trailing window.
func (rl *RateLimiter) Allow(key string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	now := rl.now()
	cutoff := now - rl.window
	kept := rl.hits[key][:0]
	for _, t := range rl.hits[key] {
		if t > cutoff {
			kept = append(kept, t)
		}
	}
	if len(kept) >= rl.limit {
		rl.hits[key] = kept
		return false
	}
	rl.hits[key] = append(kept, now)
	return true
}

// PairHandler serves the anonymous POST /api/pair endpoint: it rate-limits by
// client IP, then mints a short rendezvous code. No auth, no DB.
func PairHandler(reg *PairRegistry, rl *RateLimiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ip := ClientIP(r)
		if !rl.Allow(ip) {
			http.Error(w, "too many pairing requests", http.StatusTooManyRequests)
			return
		}
		code, exp := reg.Mint()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"code": code, "expiresAt": exp})
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && go test ./internal/signal/ -run TestPairHandler -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/internal/signal/pairhttp.go server/internal/signal/pairhttp_test.go
git commit -m "feat(signal): anonymous POST /api/pair endpoint with per-IP rate limit

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: /ws 第三种房间键（code）+ main.go 接线

**Files:**
- Create: `server/internal/signal/route.go`
- Test: `server/internal/signal/route_test.go`
- Modify: `server/main.go` (`/ws` 处理器 + 启动接线)

**Interfaces:**
- Consumes: `*PairRegistry.Validate` (Task 1), `PairHandler` (Task 2), 现有 `validateRoom`.
- Produces:
  - `func RoomFor(code, token string, validatePair, validateToken func(string) bool) (room string, maxPeers int, lan bool, ok bool)`
    - code 非空且 `validatePair(code)` → `("c:"+code, 2, false, true)`；校验失败 → `("",0,false,false)`。
    - 否则 token 非空且 `validateToken(token)` → `("t:"+token, 2, false, true)`；校验失败 → `("",0,false,false)`。
    - 都为空 → `("", 0, true, true)`（LAN：调用方用 `RoomKey(r)`、`maxPeers=0`）。
    - `validatePair`/`validateToken` 为 nil 视为校验不通过。

- [ ] **Step 1: Write the failing test**

```go
// server/internal/signal/route_test.go
package signal

import "testing"

func TestRoomForCode(t *testing.T) {
	ok := func(string) bool { return true }
	room, max, lan, valid := RoomFor("424242", "", ok, nil)
	if room != "c:424242" || max != 2 || lan || !valid {
		t.Fatalf("got %q %d lan=%v ok=%v", room, max, lan, valid)
	}
}

func TestRoomForCodeRejected(t *testing.T) {
	no := func(string) bool { return false }
	_, _, _, valid := RoomFor("424242", "", no, nil)
	if valid {
		t.Fatal("bad code must be rejected")
	}
	// nil validator also rejects.
	if _, _, _, ok := RoomFor("424242", "", nil, nil); ok {
		t.Fatal("nil pair-validator must reject a code")
	}
}

func TestRoomForTokenStillWorks(t *testing.T) {
	ok := func(string) bool { return true }
	room, max, lan, valid := RoomFor("", "tok", nil, ok)
	if room != "t:tok" || max != 2 || lan || !valid {
		t.Fatalf("got %q %d lan=%v ok=%v", room, max, lan, valid)
	}
}

func TestRoomForLAN(t *testing.T) {
	room, max, lan, valid := RoomFor("", "", nil, nil)
	if room != "" || max != 0 || !lan || !valid {
		t.Fatalf("got %q %d lan=%v ok=%v", room, max, lan, valid)
	}
}

func TestRoomForCodeTakesPrecedenceOverToken(t *testing.T) {
	ok := func(string) bool { return true }
	room, _, _, valid := RoomFor("424242", "tok", ok, ok)
	if room != "c:424242" || !valid {
		t.Fatalf("code should win: got %q ok=%v", room, valid)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/signal/ -run TestRoomFor -v`
Expected: FAIL — `undefined: RoomFor`.

- [ ] **Step 3: Write RoomFor**

```go
// server/internal/signal/route.go
package signal

// RoomFor decides the signaling room for a /ws request from its query params.
// Precedence: pairing code > transfer token > LAN. When lan is true the caller
// derives the room from the client IP (RoomKey) with unlimited peers. When ok is
// false the request must be rejected (HTTP 403). nil validators reject.
func RoomFor(code, token string, validatePair, validateToken func(string) bool) (room string, maxPeers int, lan bool, ok bool) {
	if code != "" {
		if validatePair == nil || !validatePair(code) {
			return "", 0, false, false
		}
		return "c:" + code, 2, false, true
	}
	if token != "" {
		if validateToken == nil || !validateToken(token) {
			return "", 0, false, false
		}
		return "t:" + token, 2, false, true
	}
	return "", 0, true, true
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && go test ./internal/signal/ -run TestRoomFor -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire main.go — create the registry + limiter, register the endpoint, use RoomFor**

In `server/main.go`, just after `handle := signal.ServeWS(hub, newID)` (around line 76), add:

```go
	// Anonymous, login-free pairing: short numeric codes for cross-network
	// realtime rendezvous. Pure in-memory — works even if the DB is unavailable.
	pairReg := signal.NewPairRegistry(300, func() int64 { return time.Now().Unix() }) // 5 min
	go pairReg.Run(context.Background(), time.Minute)
	pairLimiter := signal.NewRateLimiter(10, time.Minute, func() int64 { return time.Now().Unix() })
```

Replace the `/ws` handler body (current lines 89-110) so the room decision goes through `RoomFor`:

```go
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Query().Get("code")
		token := r.URL.Query().Get("room")
		room, maxPeers, lan, ok := signal.RoomFor(code, token,
			pairReg.Validate,
			func(t string) bool { return validateRoom != nil && validateRoom(r.Context(), t) },
		)
		if !ok {
			http.Error(w, "invalid or expired pairing code or transfer link", http.StatusForbidden)
			return
		}
		if lan {
			room = signal.RoomKey(r)
			maxPeers = 0 // LAN: unlimited
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		ctx := r.Context()
		handle(ctx, c, room, maxPeers, signal.ClientIP(r))
		_ = c.Close(websocket.StatusNormalClosure, "")
	})
```

Register the anonymous endpoint on the root mux (NOT inside `acct.Routes()`), e.g. just after the `/ws` registration:

```go
	mux.HandleFunc("POST /api/pair", signal.PairHandler(pairReg, pairLimiter))
```

(Go 1.22 ServeMux: the specific `POST /api/pair` pattern wins over the `/api/` subtree mounted later, and works even when the DB-gated `acct.Routes()` is absent.)

- [ ] **Step 6: Build, vet, and full server test**

Run: `cd server && go build ./... && go vet ./... && go test ./...`
Expected: build clean, vet clean, all packages PASS.

- [ ] **Step 7: Commit**

```bash
git add server/internal/signal/route.go server/internal/signal/route_test.go server/main.go
git commit -m "feat(signal): wire code rooms into /ws via RoomFor + register POST /api/pair

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: transfer-link.ts — parseCodeParam / createPair / wsURL code 形参

**Files:**
- Modify: `web/src/lib/transfer-link.ts`
- Test: `web/src/lib/transfer-link.test.ts`

**Interfaces:**
- Produces:
  - `parseCodeParam(hash: string): string` — `/^#c=(\d{6})$/` 命中返回 6 位码，否则 `""`。
  - `wsURL(loc, token, code?): string` — code 非空 → `…/ws?code=<code>`；否则维持现有 token/LAN 行为。
  - `createPair(): Promise<{ code: string; expiresAt: number }>` — `POST /api/pair`。

- [ ] **Step 1: Write the failing test (append to existing file)**

```ts
// add to web/src/lib/transfer-link.test.ts
import { parseCodeParam, wsURL } from "./transfer-link";

describe("parseCodeParam", () => {
  it("extracts a 6-digit code, leading zeros allowed", () => {
    expect(parseCodeParam("#c=424242")).toBe("424242");
    expect(parseCodeParam("#c=042424")).toBe("042424");
  });
  it("rejects non-6-digit or malformed fragments", () => {
    expect(parseCodeParam("#c=12345")).toBe("");
    expect(parseCodeParam("#c=1234567")).toBe("");
    expect(parseCodeParam("#c=abcdef")).toBe("");
    expect(parseCodeParam("#t=abc")).toBe("");
    expect(parseCodeParam("")).toBe("");
  });
});

describe("wsURL with a pairing code", () => {
  const loc = { protocol: "https:", host: "relayium.com" };
  it("uses ?code= when a code is given", () => {
    expect(wsURL(loc, "", "424242")).toBe("wss://relayium.com/ws?code=424242");
  });
  it("ignores token when code is present (code wins)", () => {
    expect(wsURL(loc, "tok", "424242")).toBe("wss://relayium.com/ws?code=424242");
  });
  it("falls back to token/LAN when no code", () => {
    expect(wsURL(loc, "tok")).toBe("wss://relayium.com/ws?room=tok");
    expect(wsURL(loc, "")).toBe("wss://relayium.com/ws");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/transfer-link.test.ts`
Expected: FAIL — `parseCodeParam` not exported / `wsURL` arity.

- [ ] **Step 3: Edit transfer-link.ts**

Add after `parseTransferToken`:

```ts
/** Extract a 6-digit pairing code from a hash like "#c=424242". "" if none. */
export function parseCodeParam(hash: string): string {
  const m = /^#c=(\d{6})$/.exec(hash);
  return m ? m[1] : "";
}
```

Replace `wsURL` with the code-aware version:

```ts
/** Construct the signaling websocket URL. A pairing code wins over a token; with
 *  neither, it is the LAN (IP-grouped) socket. */
export function wsURL(
  loc: { protocol: string; host: string },
  token: string,
  code = "",
): string {
  const proto = loc.protocol === "https:" ? "wss" : "ws";
  const base = `${proto}://${loc.host}/ws`;
  if (code) return `${base}?code=${encodeURIComponent(code)}`;
  return token ? `${base}?room=${encodeURIComponent(token)}` : base;
}
```

Add the minting helper (mirrors `createTransfer`, but anonymous — no credentials needed):

```ts
/** Mint an anonymous short pairing code. No session required. */
export async function createPair(): Promise<{ code: string; expiresAt: number }> {
  const res = await fetch("/api/pair", { method: "POST" });
  if (!res.ok) throw new Error(`createPair failed: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/lib/transfer-link.test.ts`
Expected: PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/transfer-link.ts web/src/lib/transfer-link.test.ts
git commit -m "feat(web): parseCodeParam + createPair + code-aware wsURL

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: router — #c= 也判为 cross 路由

**Files:**
- Modify: `web/src/lib/router.svelte.ts`
- Test: `web/src/lib/router.test.ts`

**Interfaces:**
- Consumes: `parseCodeParam` (Task 4).
- Produces: `routeFromLocation` 在 hash 含 `#c=<6位>` 时返回 `"cross"`；`navigate` 在当前 URL 含 `#c=` 时走整页重载。

- [ ] **Step 1: Write the failing test (append to existing file)**

```ts
// add to web/src/lib/router.test.ts
import { routeFromLocation } from "./router.svelte";

describe("routeFromLocation with a pairing code", () => {
  it("treats #c=<code> as the cross-network route", () => {
    expect(routeFromLocation("/", "#c=424242")).toBe("cross");
    expect(routeFromLocation("/cross-network", "#c=042424")).toBe("cross");
  });
  it("does not treat a malformed #c= as cross", () => {
    expect(routeFromLocation("/", "#c=123")).toBe("lan");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/router.test.ts`
Expected: FAIL — `#c=424242` currently maps to `lan`.

- [ ] **Step 3: Edit router.svelte.ts**

Update the import:

```ts
import { parseTransferToken, parseCodeParam, CROSS_PATH, DOWNLOAD_PREFIX } from "./transfer-link";
```

In `routeFromLocation`, add the code check beside the token check:

```ts
export function routeFromLocation(pathname: string, hash: string): Route {
  if (downloadId(pathname)) return "download";
  if (parseTransferToken(hash) || parseCodeParam(hash)) return "cross";
  return pathname === CROSS_PATH ? "cross" : "lan";
}
```

In `navigate`, extend the full-reload guard to cover a code fragment:

```ts
  if (parseTransferToken(location.hash) || parseCodeParam(location.hash)) {
    location.href = pathname; // full navigation + reload; drops the token/code
    return;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/lib/router.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/router.svelte.ts web/src/lib/router.test.ts
git commit -m "feat(web): route #c=<code> to the cross-network page

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: i18n — pair 文案段（6 语言）

**Files:**
- Modify: `web/src/lib/i18n.svelte.ts`
- Test: `web/src/lib/i18n.test.ts`

**Interfaces:**
- Produces: `Messages["pair"]` 字段，供 Task 7/8/9 使用：

```ts
pair: {
  sendCode: string;        // "生成配对码"
  enterCode: string;       // "输入配对码"
  enterHint: string;       // "向对方索取 6 位配对码"
  joinBtn: string;         // "连接"
  yourCode: string;        // "你的配对码 — 告诉对方"
  waiting: string;         // "等待对方加入…"
  expiresIn: (s: string) => string; // "{s} 后失效"
  expired: string;         // "配对码已失效，请重新生成"
  copy: string;
  copied: string;
  loginEnhance: string;    // "登录可生成带中继的分享链接，提升连通性"
  errExpired: string;      // 房间 403/满：码无效或已过期
};
```

- [ ] **Step 1: Add the type to the `Messages` interface**

In `web/src/lib/i18n.svelte.ts`, inside `export interface Messages { … }`, add after the `crossnet` block (around line 89):

```ts
  pair: {
    sendCode: string;
    enterCode: string;
    enterHint: string;
    joinBtn: string;
    yourCode: string;
    waiting: string;
    expiresIn: (s: string) => string;
    expired: string;
    copy: string;
    copied: string;
    loginEnhance: string;
    errExpired: string;
  };
```

- [ ] **Step 2: Add `pair` to all 6 language objects**

Each language object is typed `: Messages`, so `svelte-check`/`tsc` will fail until all six have `pair`. Add a `pair` block next to each language's `crossnet` block. Use these translations verbatim:

**zh:**
```ts
  pair: {
    sendCode: "生成配对码",
    enterCode: "输入配对码",
    enterHint: "向对方索取 6 位配对码",
    joinBtn: "连接",
    yourCode: "你的配对码 —— 念给对方",
    waiting: "等待对方加入…",
    expiresIn: (s) => `${s} 后失效`,
    expired: "配对码已失效，请重新生成",
    copy: "复制",
    copied: "已复制",
    loginEnhance: "登录后可生成带中继的分享链接，提升连通性",
    errExpired: "配对码无效或已过期",
  },
```

**en:**
```ts
  pair: {
    sendCode: "Create a pairing code",
    enterCode: "Enter a pairing code",
    enterHint: "Ask the sender for their 6-digit code",
    joinBtn: "Connect",
    yourCode: "Your pairing code — read it to the other person",
    waiting: "Waiting for the other device to join…",
    expiresIn: (s) => `expires in ${s}`,
    expired: "Pairing code expired — generate a new one",
    copy: "Copy",
    copied: "Copied",
    loginEnhance: "Sign in to also get a relayed share link for better connectivity",
    errExpired: "Pairing code is invalid or expired",
  },
```

**ja:**
```ts
  pair: {
    sendCode: "ペアリングコードを生成",
    enterCode: "ペアリングコードを入力",
    enterHint: "送信者に 6 桁のコードを尋ねてください",
    joinBtn: "接続",
    yourCode: "あなたのペアリングコード — 相手に伝えてください",
    waiting: "相手の参加を待っています…",
    expiresIn: (s) => `${s} で失効`,
    expired: "ペアリングコードが失効しました。再生成してください",
    copy: "コピー",
    copied: "コピーしました",
    loginEnhance: "ログインすると中継付き共有リンクも作成でき、接続性が向上します",
    errExpired: "ペアリングコードが無効か期限切れです",
  },
```

**ko:**
```ts
  pair: {
    sendCode: "페어링 코드 생성",
    enterCode: "페어링 코드 입력",
    enterHint: "보내는 사람에게 6자리 코드를 요청하세요",
    joinBtn: "연결",
    yourCode: "내 페어링 코드 — 상대에게 알려주세요",
    waiting: "상대 기기의 참여를 기다리는 중…",
    expiresIn: (s) => `${s} 후 만료`,
    expired: "페어링 코드가 만료되었습니다. 다시 생성하세요",
    copy: "복사",
    copied: "복사됨",
    loginEnhance: "로그인하면 릴레이 공유 링크도 만들어 연결성을 높일 수 있습니다",
    errExpired: "페어링 코드가 잘못되었거나 만료되었습니다",
  },
```

**de:**
```ts
  pair: {
    sendCode: "Kopplungscode erstellen",
    enterCode: "Kopplungscode eingeben",
    enterHint: "Frag den Absender nach seinem 6-stelligen Code",
    joinBtn: "Verbinden",
    yourCode: "Dein Kopplungscode — sag ihn der anderen Person",
    waiting: "Warte darauf, dass das andere Gerät beitritt…",
    expiresIn: (s) => `läuft in ${s} ab`,
    expired: "Kopplungscode abgelaufen — bitte neu erzeugen",
    copy: "Kopieren",
    copied: "Kopiert",
    loginEnhance: "Melde dich an, um zusätzlich einen weitergeleiteten Link für bessere Verbindung zu erhalten",
    errExpired: "Kopplungscode ist ungültig oder abgelaufen",
  },
```

**fr:**
```ts
  pair: {
    sendCode: "Créer un code d'appairage",
    enterCode: "Saisir un code d'appairage",
    enterHint: "Demandez à l'expéditeur son code à 6 chiffres",
    joinBtn: "Connecter",
    yourCode: "Votre code d'appairage — communiquez-le à l'autre personne",
    waiting: "En attente de l'autre appareil…",
    expiresIn: (s) => `expire dans ${s}`,
    expired: "Code d'appairage expiré — générez-en un nouveau",
    copy: "Copier",
    copied: "Copié",
    loginEnhance: "Connectez-vous pour obtenir aussi un lien relayé, plus fiable",
    errExpired: "Code d'appairage invalide ou expiré",
  },
```

- [ ] **Step 3: Add a completeness assertion to i18n.test.ts**

Append inside the existing `describe("i18n completeness", …)`:

```ts
  it("every language has the pairing strings", () => {
    for (const { code } of LANGS) {
      const m = messages[code];
      expect(m.pair.sendCode, `${code}.pair.sendCode`).toBeTruthy();
      expect(m.pair.enterCode, `${code}.pair.enterCode`).toBeTruthy();
      expect(m.pair.errExpired, `${code}.pair.errExpired`).toBeTruthy();
      expect(m.pair.expiresIn("5:00"), `${code}.pair.expiresIn`).toContain("5:00");
    }
  });
```

- [ ] **Step 4: Type-check and test**

Run: `cd web && npm run check && npx vitest run src/lib/i18n.test.ts`
Expected: `check` 0 errors (all 6 langs satisfy `Messages`), i18n tests PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/i18n.svelte.ts web/src/lib/i18n.test.ts
git commit -m "feat(web): i18n pair strings across all 6 languages

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: CodePairing.svelte — 发送/接收码 UI

**Files:**
- Create: `web/src/lib/CodePairing.svelte`

**Interfaces:**
- Consumes: `createPair`, `parseCodeParam`, `CROSS_PATH` (Task 4); `messages`/`lang` (Task 6).
- Props: `{ roomCode?: string; expired?: boolean }`.
  - `roomCode === ""` → 显示"发送 / 接收"两个入口。
  - `roomCode !== ""` → 已在 code 房间：显示该码（大字）+ 复制 + 倒计时（若本机是铸造方）+ "等待对方加入"。
  - `expired === true` → 显示 `t.pair.expired`。
- 行为：发送点击 → `createPair()` → 把 `expiresAt` 存入 `sessionStorage("relayium_pair_exp")` → `history.replaceState({},"",`${CROSS_PATH}#c=${code}`)` → `location.reload()`。接收提交 6 位 → 同样 `replaceState`+`reload`。
- Produces: 无导出（UI 组件）。

- [ ] **Step 1: Create the component**

```svelte
<!-- web/src/lib/CodePairing.svelte -->
<script lang="ts">
  import { createPair, CROSS_PATH } from "./transfer-link";
  import { messages, lang, type Messages } from "./i18n.svelte";

  let { roomCode = "", expired = false }:
    { roomCode?: string; expired?: boolean } = $props();

  const t = $derived<Messages>(messages[lang()]);
  const EXP_KEY = "relayium_pair_exp";

  let mode = $state<"choose" | "receive">("choose");
  let entry = $state("");
  let busy = $state(false);
  let err = $state("");
  let copied = $state(false);

  // Countdown (only the minting device has the expiry stashed).
  let remaining = $state(""); // "m:ss" or ""
  $effect(() => {
    if (!roomCode) return;
    const raw = sessionStorage.getItem(EXP_KEY);
    if (!raw) return;
    const exp = Number(raw);
    const tick = () => {
      const left = exp - Math.floor(Date.now() / 1000);
      if (left <= 0) { remaining = "0:00"; return; }
      remaining = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    };
    tick();
    const h = setInterval(tick, 1000);
    return () => clearInterval(h);
  });

  function enterRoom(code: string) {
    history.replaceState({}, "", `${CROSS_PATH}#c=${code}`);
    location.reload();
  }

  async function send() {
    busy = true; err = "";
    try {
      const { code, expiresAt } = await createPair();
      sessionStorage.setItem(EXP_KEY, String(expiresAt));
      enterRoom(code);
    } catch {
      busy = false;
      err = t.pair.errExpired;
    }
  }

  function join() {
    if (/^\d{6}$/.test(entry)) enterRoom(entry);
  }

  async function copy() {
    await navigator.clipboard.writeText(roomCode);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }
</script>

<section class="pairing">
  {#if expired}
    <p class="error">{t.pair.expired}</p>
    <button onclick={() => enterRoom("")}>{t.pair.sendCode}</button>
  {:else if roomCode}
    <p class="lead">{t.pair.yourCode}</p>
    <div class="code">{roomCode}</div>
    <div class="row">
      <button onclick={copy}>{copied ? t.pair.copied : t.pair.copy}</button>
      {#if remaining}<span class="ttl">{t.pair.expiresIn(remaining)}</span>{/if}
    </div>
    <p class="waiting">{t.pair.waiting}</p>
  {:else if mode === "receive"}
    <p class="lead">{t.pair.enterHint}</p>
    <div class="row">
      <input
        inputmode="numeric"
        maxlength="6"
        placeholder="000000"
        bind:value={entry}
        oninput={() => (entry = entry.replace(/\D/g, "").slice(0, 6))}
      />
      <button class="primary" disabled={entry.length !== 6} onclick={join}>{t.pair.joinBtn}</button>
    </div>
  {:else}
    <div class="choices">
      <button class="primary" disabled={busy} onclick={send}>{t.pair.sendCode}</button>
      <button onclick={() => (mode = "receive")}>{t.pair.enterCode}</button>
    </div>
    {#if err}<p class="error">{err}</p>{/if}
  {/if}
</section>

<style>
  .pairing { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 8px 0; }
  .choices { display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; }
  .lead { margin: 0; font-size: 14px; color: var(--text); text-align: center; }
  .code {
    font-size: 40px; letter-spacing: 10px; font-weight: 700; color: var(--text-h);
    font-variant-numeric: tabular-nums; padding-left: 10px;
  }
  .row { display: flex; align-items: center; gap: 12px; }
  .ttl { font-size: 13px; color: var(--text); font-variant-numeric: tabular-nums; }
  .waiting { margin: 0; font-size: 13.5px; color: var(--text); }
  input {
    font: inherit; font-size: 22px; letter-spacing: 6px; text-align: center; width: 7ch;
    padding: 8px 10px; border-radius: 9px; border: 1px solid var(--border);
    background: var(--bg); color: var(--text-h); font-variant-numeric: tabular-nums;
  }
  button {
    font: inherit; font-size: 15px; padding: 9px 22px; border-radius: 9px; cursor: pointer;
    border: 1px solid var(--border); background: var(--bg); color: var(--text-h);
  }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .error { color: var(--accent); font-size: 13.5px; margin: 0; }
</style>
```

- [ ] **Step 2: Type-check and build**

Run: `cd web && npm run check`
Expected: 0 errors (component compiles; all `t.pair.*` keys exist from Task 6).

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/CodePairing.svelte
git commit -m "feat(web): CodePairing component — send/receive 6-digit codes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: App.svelte — roomCode、transferSurface snippet、传 prop 给 CrossPage

**Files:**
- Modify: `web/src/lib/App.svelte`
- Modify: `web/src/lib/CrossPage.svelte`（仅扩展 props + 渲染 surface；完整两卡布局留给 Task 9）

**Interfaces:**
- Consumes: `parseCodeParam` (Task 4)。
- Produces（App → CrossPage 的 prop 契约，Task 9 依赖）：
  - `transferSurface: Snippet`（peers + 接收卡 + 进度卡）。
  - `roomCode: string`、`showTransfer: boolean`（= 房间内有对端或正在传输）。
  - 既有 `roomToken`、`linkDead` 保留。

- [ ] **Step 1: Parse the code and feed it into ICE/ws/route/linkDead**

In `App.svelte`:

Add the import (extend the existing transfer-link import):
```ts
  import { parseTransferToken, parseCodeParam, wsURL } from "./lib/transfer-link";
```

Add reactive state beside `roomToken` (line ~63):
```ts
  let roomCode = $state("");
```

In `onMount`, after `roomToken = parseTransferToken(location.hash);` (line 91):
```ts
    roomCode = parseCodeParam(location.hash);
```

Change the signaling URL (line 99) to pass the code:
```ts
    signaling = new SignalingClient(wsURL(location, roomToken, roomCode), selfName);
```

Extend the `onClose` dead-room guard (line 105) to cover a code room:
```ts
      if ((roomToken || roomCode) && !joinedRoom) linkDead = true;
```

Add a derived flag near `visiblePeers`/`busy` (line ~74):
```ts
  const showTransfer = $derived(visiblePeers.length > 0 || busy);
```
(`busy` keeps the surface mounted through an in-flight transfer even if the roster momentarily empties.)

- [ ] **Step 2: Wrap the transfer surface in a snippet**

In the template, the block currently rendered for LAN — the `<section class="peers">…</section>`, the `{#if incoming}…{/if}` card, and the `{#each [send, recv]…}` cards (current lines 387-453) — wrap them in a snippet definition placed in the markup (Svelte 5 allows `{#snippet}` at the top of `<main>`'s children). Define it once and render it where the three blocks were:

Replace the three blocks (peers section + incoming card + xfer each) with:
```svelte
    {@render transferSurface()}
```

And add the snippet definition — put it immediately inside `<main>` before the `{#if currentRoute() === "download"}` line:
```svelte
{#snippet transferSurface()}
  <section class="peers">
    <h2>{t.peersTitle}</h2>
    {#if visiblePeers.length === 0}
      <p class="empty">{t.emptyPeers}</p>
    {:else}
      <ul>
        {#each visiblePeers as p (p.id)}
          <li
            class="peer"
            class:disabled={busy}
            ondragover={(e) => { e.preventDefault(); if (!busy) (e.currentTarget as HTMLElement).classList.add("drag"); }}
            ondragleave={(e) => (e.currentTarget as HTMLElement).classList.remove("drag")}
            ondrop={(e) => { if (busy) { e.preventDefault(); flash(messages[lang()].busy); return; } onDrop(e, p.id); }}
          >
            <label>
              <span class="pavatar">{p.name.slice(0, 1).toUpperCase()}</span>
              <span class="ptext">
                <span class="pname">{p.name}</span>
                <span class="pick">{t.pickHint(MAX_FILES)}</span>
              </span>
              <input type="file" multiple disabled={busy} onchange={(e) => pickFile(e, p.id)} />
            </label>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  {#if incoming}
    <section class="card request">
      <div class="req-head">{t.requestHead(nameOf(incoming.from), incoming.files.length, formatSize(incoming.total))}</div>
      <ul class="filelist">
        {#each incoming.files as f}
          <li><span class="fname">{f.name}</span><span class="fsize">{formatSize(f.size)}</span></li>
        {/each}
      </ul>
      {#if sasCode}
        <div class="sas">{t.codeLabel} <code>{sasCode}</code> — {t.codeCompare}</div>
      {/if}
      <div class="actions">
        <button class="primary" onclick={() => acceptFn?.()}>{t.accept}</button>
        <button class="ghost" onclick={() => rejectFn?.()}>{t.decline}</button>
      </div>
    </section>
  {/if}

  {#each [send, recv].filter(Boolean) as x (x!.dir)}
    {@const xf = x as Xfer}
    <section class="card xfer" class:ok={xf.done && xf.ok} class:bad={xf.done && !xf.ok}>
      <div class="xfer-head">
        <span class="label">{xf.dir === "send" ? t.sendTo(nameOf(xf.peer)) : t.recvFrom(nameOf(xf.peer))}</span>
        {#if xf.files.length}<span class="count">{xf.files.length > 1 ? t.fileCounter(xf.index + 1, xf.files.length) : xf.files[0].name}</span>{/if}
        {#if xf.done}<button class="x" onclick={() => (xf.dir === "send" ? (send = null) : (recv = null))} aria-label={t.close}>✕</button>{/if}
      </div>
      <div class="status">
        {statusText(t, xf)}
        {#if sasCode && !xf.done} · {t.codeLabel} <code>{sasCode}</code>{/if}
      </div>
      {#if !xf.done}
        <div class="bar"><div class="fill" style:width="{pct(xf)}%"></div></div>
        <div class="meta">
          <span>{pct(xf)}% · {formatSize(xf.sent)} / {formatSize(xf.total)}</span>
          {#if xf.speed > 0}<span>{formatSpeed(xf.speed)}</span>{/if}
        </div>
      {/if}
    </section>
  {/each}
{/snippet}
```

(The snippet closes over `t`, `visiblePeers`, `busy`, `incoming`, `send`, `recv`, `sasCode`, and all the handlers — no behavior changes, only relocation. The CSS classes already exist in App's `<style>`.)

- [ ] **Step 3: Pass the snippet + flags to CrossPage**

Update the CrossPage render (current line 376):
```svelte
    <CrossPage {roomToken} {roomCode} {linkDead} {showTransfer} {transferSurface} />
```

- [ ] **Step 4: Teach CrossPage to accept the new props and render the surface (minimal)**

In `CrossPage.svelte`, extend the props type:
```ts
  import type { Snippet } from "svelte";
  let { roomToken = "", roomCode = "", linkDead = false, showTransfer = false, transferSurface }:
    { roomToken?: string; roomCode?: string; linkDead?: boolean; showTransfer?: boolean; transferSurface?: Snippet } = $props();
```

Wrap the existing `<CrossNetwork {roomToken} />` (line 34) so a connected room shows the transfer surface:
```svelte
  {#if showTransfer && transferSurface}
    {@render transferSurface()}
  {:else}
    <CrossNetwork {roomToken} />
  {/if}
```

- [ ] **Step 5: Type-check and build**

Run: `cd web && npm run check && npm test && npm run build`
Expected: check 0 errors, all vitest PASS, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/App.svelte web/src/lib/CrossPage.svelte
git commit -m "feat(web): render the realtime transfer surface on the cross page via snippet

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: CrossPage.svelte — 两张处境卡（实时 / 存储）完整布局

**Files:**
- Modify: `web/src/lib/CrossPage.svelte`

**Interfaces:**
- Consumes: `transferSurface`/`roomCode`/`showTransfer`/`roomToken`/`linkDead` (Task 8); `CodePairing` (Task 7); 现有 `CrossNetwork`/`StoredUpload`/`Account`/`session`/i18n。
- 行为（「⚡ 实时直传」卡）：
  - `showTransfer` → `{@render transferSurface()}`。
  - 否则 `roomToken` → `<CrossNetwork {roomToken} />`（发起方链接/QR 或"连接中"）。
  - 否则 `roomCode` → `<CodePairing {roomCode} expired={linkDead} />`（显示码 + 等待）。
  - 否则（未进房）→ `<CodePairing />`（发送/接收入口）；若已登录追加 `<CrossNetwork />`（生成分享链接）+ `t.pair.loginEnhance` 注脚。
- 行为（「📦 存储链接」卡）：登录 → `<StoredUpload />`；未登录 → 登录提示按钮（`loginOpen = true`）。仅当无活跃实时房间（`!roomToken && !roomCode`）时显示该卡，避免接收方/配对中看到无关上传卡。
- 移除旧的整宽 `needsLogin` 横幅（实时配对免登录，登录要求收敛到存储卡内）。

- [ ] **Step 1: Rewrite the component body**

Replace the markup between `<div class="acct">…</div>` and the `{#if linkDead}` footer area with the two-card layout. Full new `CrossPage.svelte`:

```svelte
<script lang="ts">
  import type { Snippet } from "svelte";
  import Account from "./Account.svelte";
  import CrossNetwork from "./CrossNetwork.svelte";
  import CodePairing from "./CodePairing.svelte";
  import StoredUpload from "./StoredUpload.svelte";
  import { session } from "./auth.svelte";
  import { lang, messages, legalUrl, type Messages } from "./i18n.svelte";

  let { roomToken = "", roomCode = "", linkDead = false, showTransfer = false, transferSurface }:
    { roomToken?: string; roomCode?: string; linkDead?: boolean; showTransfer?: boolean; transferSurface?: Snippet } = $props();

  const t = $derived<Messages>(messages[lang()]);
  const inRoom = $derived(!!roomToken || !!roomCode);
  let loginOpen = $state(false);
</script>

<section class="crosspage">
  <div class="acct"><Account bind:open={loginOpen} /></div>

  <header class="cn-head">
    <h1>{t.nav.crossTab}</h1>
    <p class="tagline">{t.tagline}</p>
  </header>

  <div class="cards">
    <!-- ⚡ Realtime direct — code pairing (login-free), files never touch the server -->
    <section class="card realtime">
      <h2>⚡ {t.crossnet.realtimeTitle}</h2>
      <p class="cardsub">{t.crossnet.realtimeSub}</p>

      {#if showTransfer && transferSurface}
        {@render transferSurface()}
      {:else if roomToken}
        <CrossNetwork {roomToken} />
      {:else if roomCode}
        <CodePairing {roomCode} expired={linkDead} />
      {:else}
        <CodePairing />
        {#if session().user}
          <div class="enhance">
            <CrossNetwork />
            <p class="hint">{t.pair.loginEnhance}</p>
          </div>
        {/if}
      {/if}

      {#if linkDead && !roomCode}
        <p class="error">{t.crossnet.linkDead}</p>
      {/if}
      <p class="foot">{t.crossnet.realtimeFoot}</p>
    </section>

    <!-- 📦 Stored link — encrypted-at-rest, async download (login required) -->
    {#if !inRoom}
      <section class="card stored">
        <h2>📦 {t.stored.title}</h2>
        <p class="cardsub">{t.stored.desc}</p>
        {#if session().user}
          <StoredUpload />
        {:else}
          <button class="primary" onclick={() => (loginOpen = true)}>{t.account.signIn}</button>
        {/if}
      </section>
    {/if}
  </div>

  <footer>
    <nav class="legal">
      <a href={legalUrl("privacy", lang())}>{t.legal.privacy}</a>
      <a href={legalUrl("terms", lang())}>{t.legal.terms}</a>
      <a href="https://github.com/relayium/relayium" target="_blank" rel="noopener noreferrer">GitHub</a>
    </nav>
    <span class="fineprint">{t.footer}</span>
  </footer>
</section>

<style>
  .crosspage { position: relative; }
  .acct { display: flex; justify-content: flex-end; min-height: 32px; }

  .cn-head { text-align: center; padding: 12px 0 20px; }
  .cn-head h1 { font-size: 34px; margin: 0 0 8px; letter-spacing: -1px; }
  .cn-head .tagline { color: var(--text); font-size: 15px; max-width: 44ch; margin: 0 auto; }

  .cards { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); align-items: start; }
  .card {
    border: 1px solid var(--border); border-radius: 16px; padding: 20px;
    background: var(--social-bg); display: flex; flex-direction: column; gap: 12px;
  }
  .card h2 { font-size: 18px; margin: 0; }
  .cardsub { margin: 0; font-size: 13.5px; color: var(--text); }
  .enhance { display: flex; flex-direction: column; gap: 8px; border-top: 1px dashed var(--border); padding-top: 12px; }
  .enhance .hint { margin: 0; font-size: 12.5px; color: var(--text); text-align: center; }
  .foot { margin: 0; font-size: 12px; color: var(--text); text-align: center; }
  .error {
    margin: 6px 0 0; text-align: center; padding: 10px 12px; border-radius: 10px; font-size: 13.5px;
    color: var(--text-h); background: var(--accent-bg); border: 1px solid var(--accent-border);
  }
  .primary {
    font: inherit; font-size: 15px; padding: 9px 22px; border-radius: 9px; cursor: pointer;
    background: var(--accent); border: 1px solid var(--accent); color: #fff; align-self: center;
  }
  .primary:hover { filter: brightness(1.08); }

  footer {
    margin-top: 32px; padding-top: 18px; border-top: 1px solid var(--border);
    display: flex; flex-direction: column; align-items: center; gap: 10px;
    font-size: 12.5px; color: var(--text); text-align: center;
  }
  footer .legal { display: flex; flex-wrap: wrap; gap: 16px; justify-content: center; }
  footer .legal a { color: var(--text-h); text-decoration: none; }
  footer .legal a:hover { color: var(--accent); }
  footer .fineprint { max-width: 60ch; }
</style>
```

- [ ] **Step 2: Add the three new crossnet strings to i18n (all 6 langs)**

`CrossPage` now uses `t.crossnet.realtimeTitle`, `t.crossnet.realtimeSub`, `t.crossnet.realtimeFoot`. Add them to the `crossnet` block of the `Messages` interface and every language:

Interface (after `linkDead: string;` in the `crossnet` block):
```ts
    realtimeTitle: string;
    realtimeSub: string;
    realtimeFoot: string;
```

Values per language (add to each `crossnet` block):
```ts
// zh
    realtimeTitle: "实时直传",
    realtimeSub: "对方此刻在线 · 点对点直连 · 文件不经服务器",
    realtimeFoot: "免登录 · 登录可提升连通性",
// en
    realtimeTitle: "Realtime direct",
    realtimeSub: "Both online now · peer-to-peer · files never touch the server",
    realtimeFoot: "No sign-in needed · sign in for better connectivity",
// ja
    realtimeTitle: "リアルタイム直接転送",
    realtimeSub: "両者が今オンライン · P2P · ファイルはサーバーを経由しません",
    realtimeFoot: "ログイン不要 · ログインで接続性が向上",
// ko
    realtimeTitle: "실시간 직접 전송",
    realtimeSub: "양쪽 모두 온라인 · P2P · 파일은 서버를 거치지 않습니다",
    realtimeFoot: "로그인 불필요 · 로그인 시 연결성 향상",
// de
    realtimeTitle: "Echtzeit-Direktübertragung",
    realtimeSub: "Beide jetzt online · Peer-to-Peer · Dateien berühren nie den Server",
    realtimeFoot: "Keine Anmeldung nötig · angemeldet bessere Verbindung",
// fr
    realtimeTitle: "Transfert direct en temps réel",
    realtimeSub: "Les deux en ligne · pair-à-pair · les fichiers ne passent jamais par le serveur",
    realtimeFoot: "Sans connexion · connectez-vous pour une meilleure connectivité",
```

- [ ] **Step 3: Type-check, test, build**

Run: `cd web && npm run check && npm test && npm run build`
Expected: check 0 errors, vitest PASS, build succeeds.

- [ ] **Step 4: Manual smoke (document in commit; not automated)**

Run `npm run dev` + the Go server, then verify in two browser profiles:
1. 跨网络页未登录 → 实时卡显示"生成配对码 / 输入配对码"。
2. A 点"生成配对码" → 页面重载、显示 6 位码 + 倒计时。
3. B 输入该码 → 双方进入 `c:<code>` 房间，实时卡显示对方设备 → 选文件 → 直传成功。
4. 输错码 → 实时卡显示 `t.pair.expired`/`errExpired`。
5. 登录后实时卡仍可用，并额外出现"生成分享链接"。

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/CrossPage.svelte web/src/lib/i18n.svelte.ts
git commit -m "feat(web): two-situation-card cross-network page (realtime / stored)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 完成后

全部任务后运行整支验证：
- `cd server && go build ./... && go vet ./... && go test ./...`
- `cd web && npm run check && npm test && npm run build`

随后进入 `superpowers:finishing-a-development-branch`（含最终整支 opus 审查）。
