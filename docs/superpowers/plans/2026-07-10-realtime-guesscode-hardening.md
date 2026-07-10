# C-α — Realtime Guess-Code Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the payoff of a brute-forced pairing code — a code-room join never auto-sends (the sender must confirm) — and add a global invalid-code breaker that sheds guessing load + signals attacks without ever denying a legitimate valid-code join.

**Architecture:** A pure `shouldConfirmBeforeSend(roomCode)` helper gates the frontend auto-send `$effect`: in a code room (cross-network) a joined peer surfaces a confirmation bar instead of auto-sending; LAN is unchanged. A backend `GuessBreaker` (wrapping the existing `signal.RateLimiter` with a single global key + a cooldown latch) records invalid `/ws?code=` attempts; when open it returns 429 + a throttled WARN for invalid codes, while valid codes always pass.

**Tech Stack:** Go (module root `server/`, `github.com/relayium/relayium`, CGO off), `net/http`; Svelte 5 (runes) frontend in `web/src`, Vitest.

## Global Constraints

- Module root is `server/`; import paths `github.com/relayium/relayium/...`. Run Go from `server/`; frontend from `web/`.
- CGO off; pure Go. Frontend is Svelte 5 runes; `fetch(..., {credentials:"include"})` for APIs; i18n via `web/src/lib/i18n/{zh,en,ja,ko,de,fr}.ts` + `types.ts` — new UI strings MUST be added to all 6 locales + the `Messages` type (else `npm run check` fails).
- **The confirmation gate is the security guarantee; the breaker is defense-in-depth.** The breaker MUST NOT deny a legitimate valid-code join (no DoS lever): only INVALID `/ws?code=` attempts are affected when the breaker is open.
- Breaker parameters (verbatim): `threshold = 200`, `window = 1 * time.Minute`, `cooldown = 30 * time.Second`. WARN log rate-limited to at most once per `cooldown`.
- Clock convention: unix-seconds `now func() int64` (matches `signal.RateLimiter`/`NewRateLimiter`).
- LAN auto-send behavior (code `""`) is unchanged.

---

## File Structure

**New files:**
- `server/internal/signal/guessbreaker.go` (+ `guessbreaker_test.go`) — the global invalid-code breaker.
- `web/src/lib/confirm-send.ts` (+ `confirm-send.test.ts`) — the pure `shouldConfirmBeforeSend` helper.

**Modified files:**
- `server/main.go` — construct the breaker; feed it in the `/ws` invalid-code branch.
- `web/src/App.svelte` — gate the auto-send `$effect`; confirmation-bar state + markup.
- `web/src/lib/i18n/types.ts` + `web/src/lib/i18n/{zh,en,ja,ko,de,fr}.ts` — confirmation-bar strings.

---

## Task 1: `GuessBreaker` + wire into `/ws`

**Files:**
- Create: `server/internal/signal/guessbreaker.go`
- Test: `server/internal/signal/guessbreaker_test.go`
- Modify: `server/main.go` (`/ws` handler invalid-code branch)

**Interfaces:**
- Consumes: existing `signal.RateLimiter` / `NewRateLimiter(limit int, window time.Duration, now func() int64)` with `Allow(key string) bool` (per-key trailing-window counter, returns false when at/over limit).
- Produces: `func NewGuessBreaker(threshold int, window, cooldown time.Duration, now func() int64) *GuessBreaker`; `func (b *GuessBreaker) RecordInvalid() (open, logNow bool)`.

- [ ] **Step 1: Write the failing test**

`server/internal/signal/guessbreaker_test.go`:
```go
package signal

import (
	"testing"
	"time"
)

func TestGuessBreakerTripsAndCoolsDown(t *testing.T) {
	now := int64(1000)
	clock := func() int64 { return now }
	b := NewGuessBreaker(3, time.Minute, 30*time.Second, clock) // threshold 3 for the test

	// Under threshold: not open.
	for i := 0; i < 3; i++ {
		if open, _ := b.RecordInvalid(); open {
			t.Fatalf("attempt %d: breaker should be closed under threshold", i)
		}
	}
	// The next attempt exceeds the window budget -> open.
	open, logNow := b.RecordInvalid()
	if !open {
		t.Fatal("breaker should be OPEN after exceeding threshold in the window")
	}
	if !logNow {
		t.Fatal("first open should signal a WARN log")
	}
	// Still within cooldown -> stays open, but log is throttled (no second log).
	now += 5
	if open, logNow := b.RecordInvalid(); !open || logNow {
		t.Fatalf("within cooldown: want open=true logNow=false, got open=%v logNow=%v", open, logNow)
	}
	// After the cooldown with no new over-budget bursts -> closes.
	now += 60 // past cooldown and past the 1-min window (attempts aged out)
	if open, _ := b.RecordInvalid(); open {
		t.Fatal("breaker should auto-close after cooldown once the burst subsides")
	}
}

func TestGuessBreakerLogThrottledToCooldown(t *testing.T) {
	now := int64(0)
	b := NewGuessBreaker(1, time.Minute, 30*time.Second, func() int64 { return now })
	b.RecordInvalid() // 1 (budget)
	if _, logNow := b.RecordInvalid(); !logNow { // 2 -> over -> open, first log
		t.Fatal("first open should log")
	}
	now += 29
	if _, logNow := b.RecordInvalid(); logNow {
		t.Fatal("log must be throttled within cooldown")
	}
	now += 2 // now 31 >= last log + 30
	if _, logNow := b.RecordInvalid(); !logNow {
		t.Fatal("log allowed again after cooldown elapses while still open")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/signal/ -run TestGuessBreaker`
Expected: FAIL — `NewGuessBreaker` undefined.

- [ ] **Step 3: Implement `guessbreaker.go`**

`server/internal/signal/guessbreaker.go`:
```go
package signal

import (
	"sync"
	"time"
)

// guessBreakerKey is the single global key under which all invalid pairing-code
// join attempts are counted (the breaker is process-wide, not per-IP).
const guessBreakerKey = "global"

// GuessBreaker is a process-wide detector for pairing-code brute-forcing. It
// counts INVALID /ws?code= attempts in a fixed window; once the window budget is
// exceeded it latches OPEN for a cooldown. It never inspects or blocks valid
// codes — callers only feed it invalid attempts — so it cannot deny a legitimate
// join. When open, callers shed the invalid attempt (429) and log (throttled).
type GuessBreaker struct {
	rl       *RateLimiter // windowed count of invalid attempts under guessBreakerKey
	cooldown int64        // seconds the breaker stays open after a trip
	now      func() int64

	mu        sync.Mutex
	openUntil int64 // unix secs until which the breaker is OPEN (open iff now < openUntil)
	nextLogAt int64 // earliest unix secs a WARN may be emitted again
}

func NewGuessBreaker(threshold int, window, cooldown time.Duration, now func() int64) *GuessBreaker {
	return &GuessBreaker{
		rl:       NewRateLimiter(threshold, window, now),
		cooldown: int64(cooldown.Seconds()),
		now:      now,
	}
}

// RecordInvalid records one invalid pairing-code attempt and reports whether the
// breaker is currently OPEN and whether the caller should emit a WARN now (at
// most once per cooldown while open). Uses absolute deadlines (openUntil /
// nextLogAt) rather than a "0 = never" sentinel so it behaves correctly even at
// unix time 0 (unit tests use a clock starting at 0).
func (b *GuessBreaker) RecordInvalid() (open, logNow bool) {
	over := !b.rl.Allow(guessBreakerKey) // false => window budget exceeded
	now := b.now()
	b.mu.Lock()
	defer b.mu.Unlock()
	if over {
		b.openUntil = now + b.cooldown // (re)arm / extend the open window
	}
	open = now < b.openUntil
	if open && now >= b.nextLogAt {
		b.nextLogAt = now + b.cooldown
		logNow = true
	}
	return open, logNow
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && go test ./internal/signal/ -run TestGuessBreaker`
Expected: PASS.

- [ ] **Step 5: Wire into `main.go`'s `/ws` handler**

Construct the breaker next to `wsCodeLimiter` (after its construction, ~line 152):
```go
	// Global (non-per-IP) breaker on INVALID pairing-code join attempts: sheds
	// brute-force load and signals attacks. It never affects valid-code joins.
	guessBreaker := signal.NewGuessBreaker(200, time.Minute, 30*time.Second, func() int64 { return time.Now().Unix() })
```
In the `/ws` handler, change ONLY the invalid-code branch (the `if !ok { ... }` after `RoomFor`):
```go
		room, maxPeers, lan, ok := signal.RoomFor(code, pairReg.Validate)
		if !ok {
			// Invalid/expired code = a guess. Feed the global breaker; when it is
			// open, shed with 429 and a throttled WARN. Valid codes are unaffected.
			if code != "" {
				if open, logNow := guessBreaker.RecordInvalid(); open {
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
```
(`log` is already imported in main.go. The breaker's single global key never grows the RateLimiter map, so no `Run`/reap goroutine is needed.)

- [ ] **Step 6: Build + full signal tests**

Run: `cd server && go build ./... && go test ./internal/signal/`
Expected: clean build + PASS (new breaker test + existing signal tests). (`main.go`'s `/ws` closure isn't unit-tested — consistent with how `wsCodeLimiter`/`iceLimiter` are wired; the breaker logic is covered by Task 1's unit tests.)

- [ ] **Step 7: Commit**

```bash
git add server/internal/signal/guessbreaker.go server/internal/signal/guessbreaker_test.go server/main.go
git commit -m "feat(signal): global pairing-code guess breaker; shed invalid /ws joins when open"
```

---

## Task 2: frontend sender confirmation gate

**Files:**
- Create: `web/src/lib/confirm-send.ts`
- Test: `web/src/lib/confirm-send.test.ts`
- Modify: `web/src/App.svelte` (auto-send `$effect` + confirmation-bar state/markup)
- Modify: `web/src/lib/i18n/types.ts` + `web/src/lib/i18n/{zh,en,ja,ko,de,fr}.ts`

**Interfaces:**
- Produces: `export function shouldConfirmBeforeSend(roomCode: string | null | undefined): boolean` — true iff a code room (`!!roomCode`).

- [ ] **Step 1: Write the failing test**

`web/src/lib/confirm-send.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { shouldConfirmBeforeSend } from "./confirm-send";

describe("shouldConfirmBeforeSend", () => {
  it("requires confirmation in a code room (cross-network)", () => {
    expect(shouldConfirmBeforeSend("123456")).toBe(true);
  });
  it("does NOT require confirmation on LAN (no code)", () => {
    expect(shouldConfirmBeforeSend(null)).toBe(false);
    expect(shouldConfirmBeforeSend("")).toBe(false);
    expect(shouldConfirmBeforeSend(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/confirm-send.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

`web/src/lib/confirm-send.ts`:
```ts
// shouldConfirmBeforeSend gates the auto-send flow: in a cross-network code room
// a joining peer could be a code-guesser, so the sender must confirm before the
// queued files are sent. On LAN (no code) auto-send stays frictionless.
export function shouldConfirmBeforeSend(roomCode: string | null | undefined): boolean {
  return !!roomCode;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/confirm-send.test.ts`
Expected: PASS.

- [ ] **Step 5: Add i18n strings (all 6 locales + type)**

The App.svelte page strings are FLAT top-level keys, and interpolated ones are function-valued
(e.g. `connected: (name: string) => string`). Add THREE flat keys. In
`web/src/lib/i18n/types.ts`, add to the `Messages` type (alongside the other flat page keys):
```ts
  confirmRecv: (name: string) => string; // "<name> wants to receive"
  confirmRecvSend: string;
  confirmRecvCancel: string;
```
Add the concrete values to each locale file (`zh, en, ja, ko, de, fr`), matching each file's
existing function-arrow style:
- `zh`: `confirmRecv: (n) => `${n} 想接收文件`,` · `confirmRecvSend: "发送",` · `confirmRecvCancel: "取消",`
- `en`: `confirmRecv: (n) => `${n} wants to receive`,` · `confirmRecvSend: "Send",` · `confirmRecvCancel: "Cancel",`
- `ja`: `confirmRecv: (n) => `${n} が受信を希望しています`,` · `confirmRecvSend: "送信",` · `confirmRecvCancel: "キャンセル",`
- `ko`: `confirmRecv: (n) => `${n} 님이 받기를 원합니다`,` · `confirmRecvSend: "보내기",` · `confirmRecvCancel: "취소",`
- `de`: `confirmRecv: (n) => `${n} möchte empfangen`,` · `confirmRecvSend: "Senden",` · `confirmRecvCancel: "Abbrechen",`
- `fr`: `confirmRecv: (n) => `${n} veut recevoir`,` · `confirmRecvSend: "Envoyer",` · `confirmRecvCancel: "Annuler",`

- [ ] **Step 6: Gate the auto-send effect + add the confirmation bar (`App.svelte`)**

Import the helper and the peer name resolver already present. Replace the auto-send `$effect` (currently ~line 263):
```svelte
  import { shouldConfirmBeforeSend } from "./lib/confirm-send";

  let pendingPeer = $state<Peer | null>(null);
  let dismissedPeerId = $state<string | null>(null);

  $effect(() => {
    if (outbox().length && surfaceShown && !busy && visiblePeers.length === 1) {
      const peer = visiblePeers[0];
      if (!shouldConfirmBeforeSend(roomCode)) {
        sendFiles(peer.id, takeOutbox()); // LAN: unchanged frictionless auto-send
        return;
      }
      // Code room: surface a confirmation bar instead of auto-sending, so a
      // code-guesser who joined never receives the files automatically.
      if (!pendingPeer && peer.id !== dismissedPeerId) pendingPeer = peer;
    } else {
      pendingPeer = null; // peer left / conditions changed
    }
  });

  function confirmSend() {
    if (pendingPeer) {
      const id = pendingPeer.id;
      pendingPeer = null;
      sendFiles(id, takeOutbox());
    }
  }
  function cancelSend() {
    if (pendingPeer) {
      dismissedPeerId = pendingPeer.id; // don't re-prompt this joiner; keep files queued for a different peer
      pendingPeer = null;
    }
  }
```
Add the bar to the template near the transfer/status area (use the existing `t` messages accessor and the existing `peerName(id)` helper for the joiner's name):
```svelte
  {#if pendingPeer}
    <div class="confirm-send" role="alertdialog" aria-live="polite">
      <span>{t.confirmRecv(peerName(pendingPeer.id))}</span>
      <button class="btn btn-primary" onclick={confirmSend}>{t.confirmRecvSend}</button>
      <button class="btn" onclick={cancelSend}>{t.confirmRecvCancel}</button>
    </div>
  {/if}
```
(`t` is `const t = $derived<Messages>(messages[lang()])` (App.svelte ~line 174). Use the
existing name-resolver already defined in App.svelte (~line 519, `peers.find((p)=>p.id===id)?.name ?? id.slice(0,6)`) — call it by its actual function name in that file. Style `.confirm-send` consistently with existing bars.)

- [ ] **Step 7: Verify build + type-check + tests**

Run: `cd web && npx vitest run src/lib/confirm-send.test.ts && npm run check && npm run build`
Expected: PASS + type-check clean (all 6 locales satisfy `Messages`) + build succeeds.

- [ ] **Step 8: Commit**

```bash
git add web/src/lib/confirm-send.ts web/src/lib/confirm-send.test.ts web/src/App.svelte web/src/lib/i18n/
git commit -m "feat(web): confirm before sending to a code-room joiner (guess-code payoff removal)"
```

---

## Self-Review Notes

**Spec coverage:** Component 1 (confirmation gate) → Task 2 (`shouldConfirmBeforeSend` + gated effect + bar + i18n); Component 2 (global breaker) → Task 1 (`GuessBreaker` + `/ws` wiring, 429 + throttled WARN when open, valid codes untouched). Chosen params (200/1m/30s) in Task 1. LAN-unchanged + never-deny-valid invariants in both tasks.

**Cross-task consistency:** `shouldConfirmBeforeSend(roomCode)` (Task 2 helper) is the only cross-file contract on the frontend; `GuessBreaker.RecordInvalid() (open, logNow bool)` (Task 1) is consumed only by main.go in the same task. No inter-task type coupling.

**Reviewer notes:** Task 1's main.go `/ws` closure isn't unit-tested (breaker logic is, in guessbreaker_test.go) — consistent with the existing wiring of `wsCodeLimiter`/`iceLimiter`. Task 2's confirmation bar is component code; the pure helper is the Vitest-covered unit (repo has no DOM-mount tests). The `pendingPeer`/`dismissedPeerId` re-prompt logic (cancel keeps the outbox but suppresses re-prompting the same joiner; a different joiner re-prompts) is the intended UX — call it out for the reviewer.
