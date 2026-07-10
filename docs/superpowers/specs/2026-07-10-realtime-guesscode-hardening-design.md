# C-α — Realtime Pairing-Code Guess Hardening

Date: 2026-07-10
Status: Approved (design)
Part of: "Bucket C cleanup" (C-α security; C-β frontend polish and C-γ SEO landing pages
follow as separate specs). Closes followup #1 from
`memory/realtime-modes-merged.md`. (Followup #2 — pairing-code attribution — is already
resolved by the fleet/SP1 work: `/api/pair` mints owner-bound codes and `turn.go` attributes
TURN metering to the code's owner via the `owner.code` credential username.)

## Problem

Cross-network realtime transfer uses a 6-digit pairing code (10^6 space, 15-min TTL). The
sender's UX is "pick files first, then pair; auto-send when the peer joins"
(`web/src/App.svelte` auto-send effect, ~line 264: fires when
`outbox().length && surfaceShown && !busy && visiblePeers.length === 1`). A code room holds
at most 2 peers, so **whoever joins the sender's code room becomes the one visible peer and
the queued files are auto-sent to them.** Someone who brute-forces a live code (joining via
`/ws?code=`, currently limited only per-IP at 30/min via `wsCodeLimiter`) would receive the
sender's files automatically. IP rotation defeats the per-IP cap.

## Goal

Remove the payoff of a guessed code, and shed guessing load globally.

- **Primary (security guarantee): a sender confirmation gate.** In a code room, a joining
  peer never triggers an automatic send; the sender must confirm. A code-guesser who joins
  gets nothing unless the sender consciously sends to them.
- **Secondary (defense-in-depth): a global invalid-code breaker.** A process-wide (non-per-IP)
  detector that sheds abnormal invalid-code join volume and signals an attack — WITHOUT ever
  denying a legitimate valid-code join (so it can't be weaponized into a DoS).

## Design rationale (why the breaker is scoped narrowly)

The confirmation gate makes a successful guess **useless** — the guesser joins, but no file
is sent without the sender's explicit confirm. So the attack's payoff is already zero once
the gate ships. That is what lets the global breaker be a resource/abuse control rather than
a hard throughput cap: a hard global cap that rejects joins once a budget is exhausted would
necessarily deny some legitimate valid-code joins during an attack (you can't distinguish a
lucky hit from a real join), handing an attacker a cheap "spend N invalid/min to deny all new
transfers" DoS lever. We deliberately avoid that: valid codes are never blocked. (A per-IP-
rotating attacker's raw guessing throughput is therefore not hard-capped — an inherent limit
of any control that won't deny legitimate joins — but the confirmation gate makes that
throughput worthless.)

## Component 1 — sender confirmation gate (frontend, `web/src/App.svelte`)

Change the auto-send effect so that, **in a code room** (`roomCode` set — i.e. cross-network),
a peer joining with a pending outbox does NOT auto-send. Instead it surfaces a lightweight
confirmation bar naming the joiner ("<peer> 想接收 — 发送 / 取消"). Only "发送" fires the
existing send path; "取消" clears the pending state (and may leave/reset the room per existing
cancel behavior).

- **Scope:** only when `roomCode` is set. **LAN auto-send is unchanged** (same-network,
  not code-guessable — no brute-force vector).
- **Which side:** the gate only appears on the side that has a queued outbox (the sender);
  the receiver has no outbox, so nothing changes for them.
- **State:** introduce a `pendingPeer` (the joiner awaiting confirmation) `$state`. The
  auto-send `$effect` sets `pendingPeer` instead of calling `send` when `roomCode` is set;
  a `confirmSend()` handler runs the current send; a `cancelSend()` clears it. The bar is
  dismissed once the send starts (or on cancel/peer-leave).
- **i18n:** add `t.*` strings for the bar (prompt, send, cancel) across all 6 locales,
  matching the existing message structure (`web/src/lib/i18n/{zh,en,ja,ko,de,fr}.ts` +
  `types.ts`).
- **Testability:** extract the decision into a pure helper (e.g. in a small module or an
  exported function) `shouldConfirmBeforeSend(roomCode: string | null): boolean` returning
  `!!roomCode`, unit-tested with Vitest; the component wires the effect to it. (Mirrors how
  `nodes.ts`/`format.ts` expose pure helpers for testing without a DOM mount.)

## Component 2 — global invalid-code breaker (backend, `server/internal/signal`)

A process-wide detector on INVALID `/ws?code=` join attempts, wired in `server/main.go`'s
`/ws` handler where `RoomFor` currently returns `ok=false` for a failed
`pairReg.Validate(code)`.

New type in `internal/signal` (small, injectable clock, unit-testable), e.g.
`GuessBreaker`:
- `NewGuessBreaker(threshold int, window, cooldown time.Duration, now func() int64) *GuessBreaker`
  (unix-seconds clock, matching the existing `signal.RateLimiter`/`NewRateLimiter` convention)
- `RecordInvalid() (open bool)` — records one invalid attempt; returns whether the breaker is
  currently OPEN.
- **Implementation:** reuse the existing `signal.RateLimiter` (fixed `window`, `threshold`
  budget) called with a single constant global key (e.g. `Allow("global")`) as the windowed
  counter — when it returns `false`, the window's invalid count has exceeded `threshold`. On
  first over-threshold, latch OPEN and record the trip time; while `now < tripTime + cooldown`
  the breaker reports OPEN; after the cooldown it re-evaluates the windowed counter and closes
  when the next window is back under budget. Guard the latch state with a mutex (the `/ws`
  handler is concurrent). The injected `now func() time.Time` keeps it unit-testable.

`/ws` handler flow (only the invalid-code branch changes):
1. `code` present and per-IP `wsCodeLimiter` check — unchanged.
2. `RoomFor(...)` → if `ok==false` (invalid/expired code): call `breaker.RecordInvalid()`.
   Respond as today (HTTP 403 "invalid or expired pairing code"). When the breaker is OPEN,
   additionally: emit a rate-limited WARN log (at most once per `cooldown`) so ops sees the
   attack, and — as the load-shed — respond 429 instead of 403 for invalid codes while open
   (a fast, cheap rejection that signals "backing off"; behaviourally still a rejection).
3. **Valid codes are never affected** — a successful `RoomFor` proceeds exactly as today,
   open or not. This is the load-bearing non-DoS property.

**Chosen parameters:** `threshold = 200` invalid attempts, `window = 1 * time.Minute`,
`cooldown = 30 * time.Second`. (Normal users rarely present an invalid/expired code — a
handful per minute service-wide — so 200/min is a strong attack signal well above baseline.)
Wire the breaker in `main.go` alongside `wsCodeLimiter`.

## Error handling / edge cases

- The breaker never rejects a valid code, never touches existing rooms/connections, and never
  affects LAN (`code==""`) joins. An in-progress transfer is never interrupted.
- Breaker state is process-local (single-instance deployment, consistent with the rest of the
  signal layer). Restart resets it — acceptable for a best-effort abuse control.
- WARN log is rate-limited (≤ once per cooldown) so an attack can't flood the log.

## Testing

- **GuessBreaker (unit, injected clock):** invalid attempts below threshold → not open;
  crossing `threshold` within `window` → open; stays open through `cooldown`; auto-closes
  after the rate drops post-cooldown. No wall-clock sleeps.
- **/ws handler (or a thin extracted decision):** an invalid code records the attempt and
  returns 403 (closed) / 429 (open); a valid code is unaffected regardless of breaker state.
  (Follow the existing signal handler test patterns.)
- **Confirmation gate (Vitest):** `shouldConfirmBeforeSend(roomCode)` returns true for a
  non-empty code and false for LAN (`null`/empty). If a component-level test fits the repo's
  conventions, assert that in a code room a joined peer surfaces the bar rather than
  auto-sending, and that confirm invokes the send path while LAN still auto-sends.

## Out of scope / follow-ups

- Browser-side SAS/out-of-band verification for realtime (a larger authentication design).
- Hard global throughput cap (deliberately rejected — DoS lever; the confirmation gate makes
  it unnecessary).
- C-β (frontend polish) and C-γ (SEO landing pages) — separate specs.
