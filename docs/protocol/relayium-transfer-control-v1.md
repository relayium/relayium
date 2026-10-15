# Relayium stored-upload transfer control, v1 (client-side)

Status: Web implementation (`web/src/lib/transfer-control.ts`, used by
`web/src/lib/stored-file.ts`). Vectors: `contracts/transfer-control-v1.json`.
Other clients (CLI, Swift, Android, Windows) are expected to port the same
functions and pass the same vectors; until they do they keep their current
fixed-chunk behaviour.

**No wire change.** The server sees the same `POST /api/uploads`, `PATCH
/api/uploads/{id}` (`Content-Range: bytes start-end/total`), offset `GET` and
`finalize` as before. Ciphertext, frames, nonces, manifest and finalize recovery
are untouched; a slice is a byte range of ciphertext that was already produced,
so shrinking a slice never re-encrypts anything. One PATCH is in flight per
upload, in strict offset order.

## 1. Slice size

- `max = legacySliceMax(init.chunkSize)`: the server's positive safe-integer
  `chunkSize`, clamped to 64 MiB as a memory bound (absent/invalid → 8 MiB). It is
  a PACKING TARGET, not a byte limit.
- Unlimited ("fast"), not demoted: packing is unchanged from before v1 — frames
  are appended until the buffer holds at least `max` and the whole buffer is one
  request, so a request may exceed `max` by up to one ciphertext frame
  (192 KiB + 20 B); the server's per-PATCH append cap is larger. Request counts are
  identical to the pre-v1 client (vectors `requestCount`: 32 MiB = 4 requests at
  8 MiB, 29 at 1 MiB). An earlier v1 draft cut requests at exactly `max`, which
  added requests (4→5, 29→33); that was wrong and is withdrawn.
- No larger packing target than the server's is used: a pair room keeps 1 MiB, an
  ordinary upload 8 MiB. Growing past it is NOT part of v1: it needs a
  server-advertised, server-time-bounded capability (planned as L2), because a
  client cut is not proven to commit its prefix on every path (§3).
- After a watchdog cut, the slice is demoted; a cut sets the
  slice to `clamp(observedRate × 2 s, 64 KiB, min(tried/2, max))`. It doubles back
  toward `max` after each slice answered within 2 s.
- Paced uploads cut exact slices of `clamp(rate × 250 ms, 32 KiB, current)` from
  the retained ciphertext. At the lowest limits the 32 KiB floor dominates (one
  request body every 1 s at 32 KiB/s), so the burst is "about a quarter second of
  the limit, never less than 32 KiB", not a flat 250 ms.
- After a failed or cut request, the retry covers only the rest of THAT slice
  (bounded by the possibly shrunk size) before any new ciphertext.

## 2. Watchdog (per request time budget)

`watchdogMs(slice, {pairRoom, roomRemainingMs, stalls})`:

- No measured rate yet → no budget (pre-v1 behaviour; the server's own 10-minute
  append lifetime still applies), except a pair room bounded by its deadline.
- Measured rate `g` → `max(floor, 4 × slice/g) × 2^min(stalls, 6)`; floor 20 s
  (ordinary) or 8 s (pair room). `stalls` = consecutive attempts that committed
  nothing; any committed byte resets it. A link that keeps moving bytes is
  therefore never failed for being slow: each cut lowers `g`, which lengthens the
  next budget.
- Pair room with a known deadline → additionally at most
  `remaining − 30 s`; if that is under 1 s no cut is scheduled. `remaining` is
  computed from the server's `expiresAt` and the answer's `Date` header (both
  server time), aged by the local monotonic clock, clamped to [0, 300 s].
- Five consecutive no-progress failures end the upload with an error (never a
  finalize). A user cancel always wins and never triggers an offset read, PATCH
  or finalize.

## 3. What a cut relies on, and what is proven

After a cut the client reads the committed offset back and replays from it out
of its retained buffer. If the path committed the delivered prefix, the room's
deadline was renewed by it and nothing is resent; if it committed nothing, the
cut bytes are resent (counted as `replayedBytes`).

Measured (2026-10-14, artifacts `l1/proof`): private build of server 460cbf27
behind nginx with the production `/api/` directives, real headless Chrome 155
same-origin HTTP/1.1, 8 MiB PATCH collapsing to 20 kbit/s and aborted at 8 s:
the prefix (2,800,894 B) was committed, billed once and renewed the room within
152 ms. Node's undici client, by contrast, neither closed the connection nor
stopped sending on abort (no settlement in 78 s). NOT measured: HTTP/2, the
Cloudflare edge, remote storage nodes, WAN. v1 therefore uses cuts only to
SHRINK work within the server's legacy chunk, never to justify larger slices.

An offset read that is lower than bytes already confirmed (a status read racing
a settling append) is re-read up to 3 times (0.5/1/2 s); if it never catches up
the upload fails rather than writing a misaligned ciphertext.

## 4. Speed modes

Device-local preference (`relayium.transfer.speed`): `fast` (default, no
artificial delay), `background`, `cap` (32 KiB/s – 1 GiB/s).

- Pacing is a token bucket shared by all uploads in the page (vectors
  `tokenBucket`). Tokens are request-body bytes, refilled at `rate` from actual
  monotonic elapsed time up to `capacity` = one paced burst (`pacedBurst(rate)`,
  or the 256 KiB probe in background); the bucket starts full and never holds more,
  so idle time or a cancel buys no catch-up burst. Waiting uploads hold FIFO
  tickets; only the head may take, and tokens are taken only at the moment the
  body is dispatched — every attempt, retries and cut requests included.
  Queue departure wakes the remaining waiters immediately; the 250 ms settings
  poll is an upper bound for preference changes, not a FIFO handoff delay. A
  cancel or re-plan leaves the queue without any refund, so it cannot move another
  upload's turn. Guarantee: for any two request starts t1 ≤ t2, bytes started in
  [t1, t2] ≤ `rate × (t2 − t1) + capacity`. (R3 used a virtual clock with refunds;
  refunding a middle reservation let two later bodies start together — Root's
  A/B/C/D counterexample — and is withdrawn.)
- Each request still leaves at network speed: a burst of one slice (≥ 32 KiB,
  ~250 ms of the limit). This reduces, but does not remove, the effect on other
  traffic. The UI says so.
- `background` (provisional L1 policy) = `max(32 KiB/s, 0.5 × reference)`. The
  reference is an EWMA (½) over requests of at least 256 KiB only — a size that
  does not depend on the limit, so the mode's own small paced requests cannot talk
  it down — and every 8th request is such a probe (still paced on average, but a
  256 KiB burst), so a slower network lowers it; a watchdog cut halves it. The
  first request is an unpaced 256 KiB probe. Whether it actually reduces
  competing delay on representative links is a benchmark question, not a promise.
- A setting change during a pacing wait leaves the queue and re-plans the
  request (slice size and mode) within 250 ms; a cancel ends the wait at once.
- Live (WebRTC) transfers are not paced by v1.

## 4a. Server errors and the single-shot fallback

- A PATCH answered 5xx or 408 is transient: the client reads the committed offset
  back and continues on the SAME upload session with the SAME retained ciphertext
  (no new init, key or nonce), bounded by 5 consecutive attempts without committed
  progress; any committed byte resets the bound.
- Backoff after a failed or cut request (300 ms doubling, max 5 s) is applied only
  while part of the failed flight is unresolved: if the offset read back reaches
  the end of the outstanding retry range — this slice and any earlier, larger
  retry still pending — every byte was committed and the next bytes go out at
  once. A partial commit, no progress, or an earlier larger flight whose tail is
  still unsent all keep the backoff. (R5; R4 always slept, which cost ~0.3 s per
  lost answer after a complete append.) 400/401/403/404/410/413/429 and
  every other non-2xx except 409 remain definitive. A cancel that arrives while a
  5xx is being answered reports that status as before (callers key on it).
- The legacy single-shot route (`POST /api/files`, a full re-encrypt and re-send)
  is used only while NO PATCH body has been handed to the network: an init that
  is unsupported (404/405) or any other failure before the first PATCH, under the
  existing purpose/manifest/id/size gates. Once a PATCH has gone out, the server
  may hold and have metered a prefix — a first request whose answer was lost can
  have committed everything while an offset read still says 0 — so a failure is
  reported as it is, never answered by a second upload. Bounded no-progress
  failures surface as `UploadIncompleteError(status, committedBytes)` (an
  `UploadError`); `committedBytes` is a lower bound. Resuming such a session from
  the UI is not offered yet (O6).

- ACK ceiling: every server-reported offset (200, 409 and offset reads) must be
  at most `highestSent`, the largest end of any body ever handed to fetch for this
  upload, across cuts and retries; anything above it claims bytes that never left
  and fails the upload (`UploadError(0)`, no fallback) before any progress, buffer
  shift, further PATCH or finalize. Encrypted bytes still in the buffer are not
  proof they were sent. An offset above the CURRENT (smaller) slice but within
  `highestSent` is valid — an earlier larger request can settle late.

## 5. Progress, rate, ETA and diagnostics

- `sent` is always the server-confirmed offset.
- `rate`: confirmed bytes over the last 20 s; absent with fewer than 2 commits,
  under 3 s of history, or no progress for 15 s. `etaMs = (total − sent)/rate`:
  time until the last byte is confirmed, not until the recipient can open it.
- `stats` (local only, no names/keys/hashes): `prepareMs` (read + encrypt, not
  separable here), `requestMs` (PATCH start → answer: network AND server commit),
  `pacingMs`, `recoveryMs`, `requests`, `watchdogCuts`, `attemptedPayloadBytes`
  (request bodies handed to fetch, every attempt; an upper bound on payload that
  left the device, excluding HTTP/TLS overhead — NOT measured wire traffic and
  never a billing basis), `replayedRequestedBytes` (overlap of requested ranges,
  not observed retransmission), `committedBytes` (server-confirmed, exact).

## 6. Known boundaries (v1)

- The first request of an upload has no rate estimate (ordinary: no watchdog) and
  a pair room's first request has no deadline from init; a room that is already
  old when its upload starts is unprotected until the first answer. Closing this
  needs the server to advertise the deadline at init (L2).
- The speed preference is read through pure TypeScript (`currentSpeedPref`), so
  `stored-file.ts` stays importable from Node runtimes (Windows stored runtime);
  without storage the preference is "fast" or this page's in-memory choice.

## Browser realtime custom-cap extension (local policy)

The same page-wide custom-cap bucket also governs encrypted file-content frames
sent over the mixed WebRTC lane. Background estimation remains stored-only;
Fast keeps the transport congestion controller and existing durable-credit window.
This extension changes local scheduling, not stored HTTP v1. Other clients may
retain their existing scheduling. The setting is a tab's budget, not a system-wide
limit across apps or browsers.

Frames use at most the smaller of the negotiated maximum and the current paced
burst, while logical chunks/hash/checkpoints remain 192 KiB. A preference change
may cross one already sealed frame. Cancel/reject/terminal/gap wakes the pacing
wait immediately; an already sealed frame still entering the ordered channel
before ABORT is charged into debt, repaid by subsequent capped sends. No tokens
are refunded. Metadata, DONE, ACKs and text bypass this file-data cap. Bursts and
protocol overhead remain; no zero-effect-on-other-traffic promise is made.

A batch touched by the custom cap reports the optional encrypted DONE hint
`paced:true` and neither new endpoint records it as relay-throughput evidence.
Old receivers ignore this additive JSON field and continue full hash verification;
unknown external sender limits cannot be inferred. See realtime-wire v1.
