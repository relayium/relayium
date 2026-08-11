# Code-First Pairing Flow (Web) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Invert the cross-network sender flow from "pick files, then mint a code" to "mint a code, then stage what you send while you wait", so the sender never idles waiting for the other device to join.

**Architecture:** No transport, protocol, or server change. The existing local `outbox` store already holds a batch across the wait and App's auto-send effect already drains it the moment one peer is reachable; this plan makes the code room a place where that outbox can be *filled* (append, inspect, remove) instead of only pre-loaded. Copy on both the code room and LAN states, in nine locales, that staged files live on the device and are never uploaded.

**Tech Stack:** Svelte 5 (runes), TypeScript, Vitest + jsdom, `svelte-check`, Playwright-free headless-Chrome e2e harness under `web/e2e/`.

## Resolved design (owner decisions, 2026-08-11)

The owner's second and third messages settled the shape. Recorded here because
the decisions are not derivable from the code:

- **No A/B switch. The timing of the pick IS the mode.** Files added while the
  room is still waiting are pre-uploaded (Plan A). Files added after the peer
  joined go over the live link (Plan B). Default behaviour is therefore B, and
  A is something the user opts into simply by not waiting. Owner: 「这里默认应该
  是方案 B……在对方加入之前，你已经可以传文件了……如果想提高传输效率，可以在他
  加入之前就把文件传上来」.
- **Key delivery: E2E only.** The sender's browser hands the file key to the
  peer over the existing end-to-end channel at the moment it joins. The server
  never holds a key, so zero-knowledge is untouched and no `#k=` fragment is
  needed. Consequence, accepted by the owner: the sender must stay on the page
  during the wait — "upload and walk away" is NOT supported.
- **Join deadline 5 minutes; transfer deadline none.** If nobody joins within
  5 minutes of the upload, the transfer fails and the ciphertext is void. Once
  a peer has joined, a long transfer is never cut off by that clock. **Refined
  by B1 below:** the 5 minutes run from upload *completion*, and the code stays
  joinable for the whole upload — otherwise a ten-minute upload kills its own
  code at T+5.
- **Metering bills from the first uploaded byte,** including when pairing later
  fails or times out, so upload bandwidth cannot be consumed for free.
- **Brute-force hardening: declined for now** by the owner, who judged the
  attacker's expected payoff too low to be worth defending. The code must simply
  stay genuinely random. **Already satisfied — no change required:**
  `server/internal/signal/pair.go:244` `randCode()` draws each digit with
  `crypto/rand.Int` over the alphabet length (no modulo bias) and builds a
  string, so `000000` and `012345` are in-space. Do NOT add a filter that
  excludes "patterned" codes like `111111`: excluding them shrinks the space and
  makes codes more predictable, not less.
- **Not authorised by that decision:** letting the server hold user file keys.
  Declining brute-force work is not permission to weaken the zero-knowledge
  promise, which needs an explicit owner decision under `PROJECT-GOVERNANCE.md`.

## Global Constraints

- **LAN must stay off the server.** Owner: 「不需要也不能上传到服务器，否则就失去
  了局域网传输不收费的意义」. LAN staging is local-only in every phase, and the
  UI must say so.
- **Copy must be literally true, and must survive Phase 2.** A code-room note may
  not say bytes go "straight to the other device": cross-network browser sessions
  are relayed through TURN. A LAN note may not imply a relay: LAN realtime is
  direct. Phase 1 must not ship a code-room string that Phase 2 makes false —
  which is why the code-room staging note says only "the transfer starts on its
  own once the other device joins" (true under both A and B) and makes no claim
  either way about uploading. The LAN "never uploaded" note is permanent.
- **Nine locales, always together:** `en, zh, de, es, pt, ar, fr, ja, ko`. A key
  added to `src/lib/i18n/types.ts` fails `svelte-check` until all nine define it.
- **Keep the receiver entry.** "Enter a pairing code" stays on the choose screen;
  without it a receiver with only six digits cannot join at all.
- **Preserve the OS share-target path.** `share-target.ts` fills the same outbox.
  Files that arrive that way must remain visible, not silently replaced.
- **Baseline to protect:** 3448 passing / 3 skipped Vitest tests at `0240d41e`.

---

## Phase 1 — DELIVERED AND PUBLIC (`ebd2f10c`, 2026-08-11)

Tasks 1–5 below all shipped in one commit, fast-forwarded onto `origin/main` and
verified in production (assets SHA-256-identical to the local build of that SHA,
`healthz=ok`, new copy live in the shipped locale chunks, real headless Chrome on
`/cross-network` clean). Their unchecked boxes are the plan as written, kept as
the record of what was intended; they are **not** open work.

Deviations from the plan as written, and why:
- `pair.stageLocalNote` became `pair.stageNote` and dropped its "stays on this
  device / not uploaded" sentence. Pre-upload was reinstated by the owner while
  Phase 1 was being built, so a no-upload promise in a code room would have been
  false within one phase. The LAN note keeps the promise; the code-room note says
  only that the transfer starts on join.
- `pair.sendCode` was removed from `i18n.test.ts`'s 24-character short-label
  budget rather than shortening three locales. It is now a full-width primary
  button, and "Crear un código de emparejamiento" is 33 characters and correct.
- Per-file removal was added to `PendingFiles.svelte` (optional `onRemove` /
  `removeLabel`) instead of a parallel list of buttons, so one list carries both
  the files and the control that removes them.
- `web/e2e/code-room.mjs`'s `preselectedSendScenario` was rewritten to load its
  queue from the waiting room's staging box; it drove the deleted files-first
  pickers and was a real (not flaky) failure until updated.

---

### Task 1: Outbox gains append and remove

**Files:**
- Modify: `web/src/lib/outbox.svelte.ts`
- Test: `web/src/lib/outbox.test.ts`

**Interfaces:**
- Consumes: `PickedFile` from `./drag`.
- Produces: `addToOutbox(next: PickedFile[]): void` — appends, dropping entries
  whose `file.name` + `file.size` + `file.lastModified` already match one in the
  queue. `removeFromOutbox(index: number): void` — drops one entry by position.
  Existing `outbox()`, `setOutbox`, `takeOutbox`, `clearOutbox` are unchanged.

`setOutbox` stays a replace, because the files-first entry and the share-target
handoff both mean "this batch supersedes whatever was there". Staging inside a
room is the opposite: each pick is an addition.

- [ ] **Step 1: Write the failing tests** in `outbox.test.ts` — `addToOutbox`
  appends to an existing queue; a second `addToOutbox` of the same
  name/size/lastModified does not duplicate; `removeFromOutbox` drops the entry
  at that index and leaves the rest in order; an out-of-range index is a no-op.
- [ ] **Step 2: Run and watch them fail.** `npx vitest run src/lib/outbox.test.ts`
  → FAIL, "addToOutbox is not a function".
- [ ] **Step 3: Implement both functions** in `outbox.svelte.ts`, with a comment
  saying why `setOutbox` remains a replace.
- [ ] **Step 4: Run to green.** `npx vitest run src/lib/outbox.test.ts` → PASS.
- [ ] **Step 5: Commit.** `feat(web): let the outbox append and drop single entries`

---

### Task 2: One sender action on the choose screen

**Files:**
- Modify: `web/src/lib/CodePairing.svelte` (the `{:else if session().user}` branch,
  and delete `pickAndSend`)
- Modify: `web/src/lib/i18n/types.ts` and all nine locales (retire `pair.bareConnect`)
- Test: `web/src/lib/CodePairing.test.ts`, `web/src/lib/i18n.test.ts`

**Interfaces:**
- Consumes: `addToOutbox` from Task 1 (not on this screen, but the same component).
- Produces: a signed-in choose screen with exactly two controls — primary
  `t.pair.sendCode` ("Create a pairing code") calling `send()`, ghost
  `t.pair.enterCode` switching to `mode = "receive"`.

`pair.bareConnect` ("Just connect") disappears: it was the de-emphasized version
of what is now the only sender action, and leaving both would put two buttons
that mint a code side by side. `i18n.test.ts:134-139` pins its length — that
assertion moves to `pair.sendCode`, which now occupies the same slot.

- [ ] **Step 1: Write the failing test** — the signed-in, roomless
  `CodePairing` renders no `input[type=file]`, exposes a primary button whose
  text is `messages.en.pair.sendCode`, still exposes the enter-code control, and
  clicking the primary calls `createPair` exactly once.
- [ ] **Step 2: Run and watch it fail.** `npx vitest run src/lib/CodePairing.test.ts`
- [ ] **Step 3: Implement** — replace the two `<label class="btn btn-primary">`
  file pickers with the single create button; delete `pickAndSend`; drop the now
  unused `pickedFromInput` / `Icon` imports only if nothing else in the file uses
  them; remove `bareConnect` from `types.ts` and the nine locales; retarget the
  `i18n.test.ts` length guard.
- [ ] **Step 4: Run to green.** `npx vitest run src/lib/CodePairing.test.ts src/lib/i18n.test.ts`
- [ ] **Step 5: Typecheck.** `npm run check` → 0 errors (this is what proves all
  nine locales were updated).
- [ ] **Step 6: Commit.** `feat(web): make "create a pairing code" the one sender action`

---

### Task 3: Stage files while the code waits

**Files:**
- Modify: `web/src/lib/CodePairing.svelte` (the `isMinter && roomCode` branch)
- Modify: `web/src/lib/i18n/types.ts` and all nine locales
- Test: `web/src/lib/CodePairing.test.ts`

**Interfaces:**
- Consumes: `addToOutbox`, `removeFromOutbox` (Task 1); `outbox()`;
  `pickedFromInput` from `./drag`; `folderUploadSupported` from `./platform`.
- Produces: new locale keys under `pair` —
  `handoff: string` (tell them to pass the code/link on),
  `stageLead: string` (you can add things now, before they join),
  `stageNote: string` (it will start by itself once they join),
  `stageAdd: string`, `stageAddFolder: string`, `stageDrop: string`,
  `stageRemove: string`.

English copy, verbatim:
- `handoff`: "Send the code or the link to the other person so they can join."
- `stageLead`: "No need to wait — pick what you want to send now."
- `stageNote`: "The transfer starts on its own once the other device joins."
- `stageAdd`: "Add files" · `stageAddFolder`: "Add a folder"
- `stageDrop`: "or drop files and folders here" · `stageRemove`: "Remove"

`stageNote` is deliberately silent about where the bytes are. It is true today
(staged locally, sent on join) and stays true in Phase 2 (uploaded during the
wait, downloaded on join), so Phase 2 adds a sentence about speed rather than
correcting a false one. It must never claim the bytes go directly to the peer —
a cross-network code room relays them through TURN. And it must not say "never
uploaded" here: that is a LAN promise, and Phase 2 makes it false for code rooms.

- [ ] **Step 1: Write the failing tests** — in the minter's waiting state:
  `handoff` and `stageLead` are rendered; an "Add files" input exists and picking
  files appends to the outbox rather than replacing it; a second pick appends
  again; `stageLocalNote` is rendered whenever staged files are shown; a remove
  control drops one file; the folder input is absent when
  `folderUploadSupported` is false.
- [ ] **Step 2: Run and watch them fail.** `npx vitest run src/lib/CodePairing.test.ts`
- [ ] **Step 3: Implement** the staging block: the two pickers, a drop zone
  wired to the same `addToOutbox`, `PendingFiles` with a per-row remove, and the
  two copy lines. Add the seven keys to `types.ts` and all nine locales.
- [ ] **Step 4: Run to green.** `npx vitest run src/lib/CodePairing.test.ts`
- [ ] **Step 5: Typecheck.** `npm run check` → 0 errors.
- [ ] **Step 6: Commit.** `feat(web): stage files inside a waiting code room`

---

### Task 4: Say that LAN staging never leaves the device

**Files:**
- Modify: `web/src/App.svelte` (the `outbox().length && visiblePeers.length !== 1`
  `PendingFiles` block inside `transferSurface`)
- Modify: `web/src/lib/i18n/types.ts` and all nine locales
- Test: `web/src/lib/a11y-semantics.test.ts` or a new
  `web/src/lib/staging-honesty.test.ts`

**Interfaces:**
- Produces: top-level locale key `lanStagedNote: string`.

English copy, verbatim: "Files you pick stay on this device — Relayium never
uploads them. On this network they go directly to the other device."

This is the LAN counterpart of `pair.stageLocalNote` and is a separate key
precisely because the second sentence differs: LAN realtime really is direct,
and a code room really is not.

- [ ] **Step 1: Write the failing test** — a guard that both notes exist in all
  nine locales, that neither the LAN note nor the code-room note contains any
  "upload"-family word in a positive claim, and that the LAN surface renders
  `lanStagedNote` next to the staged-files list.
- [ ] **Step 2: Run and watch it fail.**
- [ ] **Step 3: Implement** — add the key in nine locales, render it under the
  LAN `PendingFiles`.
- [ ] **Step 4: Run to green.** `npx vitest run` (full suite; App.svelte is
  widely covered).
- [ ] **Step 5: Typecheck.** `npm run check` → 0 errors.
- [ ] **Step 6: Commit.** `feat(web): state that staged LAN files are never uploaded`

---

### Task 5: Gates

**Files:** none — this task only runs things.

- [ ] **Step 1: Full unit suite.** `npx vitest run` → ≥3448 passing, 0 failing.
- [ ] **Step 2: Typecheck.** `npm run check` → 0 errors.
- [ ] **Step 3: Build.** `npm run build` → succeeds.
- [ ] **Step 4: Real-browser code-room gate.** `npm run test:e2e:code-room`.
      Known-unreliable on this repo (`WORK-QUEUE.md`); record the actual result
      either way and do not silently treat a pre-existing red as green.
- [ ] **Step 5: Accessibility.** `npm run test:a11y` → 0 violations.
- [ ] **Step 6: Commit** any fixes the gates force.

---

---

## Phase 2 — checkpoint 1 DELIVERED: server, protocol and the double-send seam

The server-side lifecycle, the wire contracts and the tests are built. The Web
sender and receiver are NOT, deliberately: they are checkpoint 2, and everything
they need is now a fixed contract rather than a decision.

Authoritative contract: **`docs/protocol/relayium-pair-room-v1.md`**. Read that
before writing the client; the summary below is a map, not the spec.

**What shipped**

- `purpose=pair_room`, a third stored-object kind bound to a pairing ROOM
  instance (never to the six digits, which are recycled). One object per FILE,
  which is what makes "already uploaded goes from storage, not-yet-started goes
  over the link" a per-file decision and structurally prevents splitting one file
  across two transports. `server/account/pairroom.go` owns the whole lifecycle
  and states its eight invariants at the top.
- The timing rule, in one place and one expression: the room is joinable until
  `min(max(open, lastByte) + 300, open + 6h)`; joining replaces that with no
  deadline of any kind — literally, which is why pre-upload is opt-in. A progressing upload keeps its own code alive; a stalled or trickled
  one cannot, in both directions.
- **The code follows the room.** That deadline is written down twice — in
  `pair_rooms.expires_at`, and in the signaling layer's in-memory registry entry
  for the six digits, which is what an upload's owner check and a receiver's
  `/ws` actually resolve. Opening a room and every accepted committed append push
  the code's expiry out to the room's current join deadline
  (`Service.SetPairCodes` → `PairCodes.ExtendFor`, `syncPairCode`); voiding a
  room removes the code outright (`RevokeFor`). Extension is owner-bound,
  forward-only, never a resurrection, and bounded by the room's own six-hour
  ceiling, so it can neither steal, revive nor over-extend six digits. Pre-upload
  refuses to run (503) without that wiring, because half of it is the bug.
- Void means gone NOW, and gone means everything the room held: every read and
  write re-derives liveness and, if the room is over, closes it and reclaims each
  artifact inline — the finalized objects AND the upload sessions still arriving,
  blob and row for each, from one transactional `ClosePairRoom` closure. Storage
  and the account's open-session budget are free at the deadline rather than at
  the generic one-hour reaper. GC's new `SweepPairRooms` pass is a backstop for
  rooms nobody touches again — proven by tests that never run a sweep.
- Metering moved from finalize-only to **per committed append**, everywhere (not
  just pre-upload): an abandoned chunked upload used to be entirely free
  bandwidth. Finalize now bills only the unbilled remainder; a refused/aborted
  single-shot upload bills what it actually read. `upload_sessions.metered` is
  the ledger that keeps the two from double-billing across instances.
- The join is observed by the SERVER (`signal.ServeWSObserved` → `PeerCount` ≥ 2
  → `account.MarkPairRoomJoined`), never claimed by a client — a client-asserted
  join would be a free jump from the five-minute deadline to none at all. The
  write is reported back to the signaling wiring and, if it fails, QUEUED
  (`pairJoinQueue`): while an observed join is unwritten the room is not voided,
  so a database blip cannot silently reimpose the five-minute clock. The queue
  has **no time bound** — an observation was judged timely when it was made, so
  a long outage cannot turn it into a latecomer. What keeps holding it safe is
  identity, not a clock: the retry resolves the room by id, and when only the
  digits are known it refuses a room opened after the observation, so a recycled
  code can never inherit somebody else's join.
- The receiver stays account-free: pair-room objects are read through the same
  unauthenticated `/api/files/{id}/meta` and `/blob` as a share.
- **B4 closed.** `outbox.svelte.ts` now carries per-entry state
  (`staged`/`uploading`/`uploaded`) and `takeOutbox()` drains only `staged`. The
  auto-send effect therefore cannot re-send a pre-uploaded file over the link.
  With nothing uploaded this is byte-for-byte the old drain-everything.
- **B5 defined and implemented as a codec.** `preupload-handoff.ts` +
  `relayium-pair-room-v1.md` §4: sealed DataChannel frame kind 10, payload
  `{"v":1,"items":[{"id","key"}]}`, gated on the exact capability `preupload/1`,
  sent first on every (re)established link, deduped by id on receipt, no ack.
- **B6 held.** Anonymous receiver access is asserted by test, not by intent.

Accounting and lifecycle survive failure, not just success: every append error
(not only the oversize one) re-reads the blob's authoritative size, bounded by
the bytes central itself forwarded; the reaper re-probes before it deletes, and
a session whose node cannot be reached at all is moved to a durable UNRESOLVED
state (`upload_sessions.unresolved_at`) rather than written off against the
offset that happens to be on the row — that offset is a lower bound, and
settling it would permanently underbill every byte the node committed but never
acknowledged. Such a row is never purged, its blob is never dropped (it is the
only thing that can still answer the question), and a paced, batched pass
re-probes it until the node returns and the exact size can be billed. There is
no horizon after which it is written off: the bound on that state is the work
it costs, not the evidence it holds. The one thing that ends it early is the
account owner asking to be deleted: confirming a deletion enumerates and removes
every one of that user's upload sessions and reclaims every partial blob,
recovery state included. Keeping evidence is a rule about what an automatic
sweep may write off, not a claim on the data of an account that has asked to be
gone — the residual bytes could never be charged to it afterwards, and a
user-attributed row plus real ciphertext held for a node that may never return
would make the immediate-deletion promise false indefinitely.
Claim-and-reconcile is one transaction and no session row is deleted or purged
by a sweep while its ledger is short; the room's
open-ness is a transactional precondition on both the append's progress commit
and the stored-file insert, so a sender never gets success for ciphertext bound
to a closed room.

**Evidence:** `go test ./...` and `go vet ./...` green; 62 adversarial pair-room
and upload-recovery cases (counting subtests) plus 3 signaling-observer cases
plus 5 account-deletion-vs-upload-session cases (`deletion_uploads_test.go`,
each verified to fail against the pre-fix delete set);
18 failure-path mutations introduced, 17 killed (the survivor is the redundant
second guard at finalize — the deadline-move precondition and the insert
precondition each refuse the object alone, so no end-to-end test can
distinguish them; the store-level `TouchPairRoomUpload` contract test holds the
first on its own).
Web: 3,490 Vitest (baseline 3,468), `svelte-check` 515 files 0 errors, build OK.

**Post-review round (both release blockers).** Two time-based give-ups were
removed outright, because both settled a question that time cannot answer:
the reaper's 24-hour horizon (which wrote an unreachable blob off against the
lower bound on the row and then deleted both) and the observed-join queue's
6-hour drop (which handed a joined room back the deadline the join had already
ended). Each is replaced by the state above, and pinned by tests that fail if
the evidence is discarded or marked settled: 8 further failure-path mutations
introduced, 8 killed — including the two that only became visible after a test
was strengthened (an unresolved row settled by a second probe) and after
`ReapPendingUploads` was reordered so the orphan pass runs BEFORE the recovery
pass, since the recovery pass's attempt stamp was otherwise shielding the row
from the orphan window as a side effect rather than by the guard that is meant
to. `go test ./...`, `go vet ./...` and `go build ./...` green; `-race` green on
`./account`, `./internal/signal`, `./internal/storage`.

**Second post-review round (two more release blockers).** Both were the same
mistake in two places: a rule implemented where it was easy to write down rather
than everywhere it has to be true.

1. *The room's deadline moved; the code's did not.* Progress extended
   `pair_rooms.expires_at` while `signal.PairRegistry` still expired the six
   digits 300 s after the mint — and the registry is what `pairRoomForUpload`'s
   owner check and `signal.RoomFor`'s receiver validation actually resolve. A
   legitimately progressing pre-upload therefore became unjoinable at T+5 with
   its ciphertext still alive: the feature's whole promise, inverted. Fixed by
   making the code follow the room (see above) — `ExtendFor`/`RevokeFor` on the
   registry, `PairCodes` + `SetPairCodes` on the service, `syncPairCode` at room
   creation and after every accepted committed append, `revokePairCode` first
   thing in the void.
2. *A void reclaimed only what had finished uploading.* `ClosePairRoom`
   enumerated finalized `stored_files` and nothing else, so an idle partial blob
   and its `upload_sessions` row outlived the room by up to the generic
   one-hour reaper — twelve times the window the room enforces. Fixed by
   returning one `PairRoomClosure` (objects **and** sessions) from a single
   transaction and reclaiming each: probe the blob for what it really holds, bill
   that, claim the session terminally, drop blob and row. The unreachable-node
   case is the one deliberate write-off, and its precedence is now stated
   explicitly in the protocol and in `docs/billing-transparency.md`.

Along the way `CommitUploadProgress` learned to answer the ROOM question even
when it cannot move an offset (session gone or already terminal), so an append
in flight when its room was reclaimed is refused with 410 instead of being told
200 with a stale offset — and, found while checking what the code sync would
amplify, it stopped MOVING the deadline for an append that commits nothing. An
empty body at the committed offset is free to send in a loop, so renewing on it
made "the only way to hold a code open is to keep uploading, and uploading is
billed" untrue; with the code now following the room, that would have held six
digits and their room to the six-hour ceiling at no cost. Only bytes renew the
window. Finalize still renews without new bytes — the owner's rule puts the last
five minutes at completion — and that one is bounded by being terminal per
upload and by the daily quota every finalize reserves.

29 new adversarial cases: 18 for the code's lifetime (7 directly on
`signal.PairRegistry`, 11 through the HTTP upload path — one of which wires the
production registry into the service so the account-layer suite's miniature
registry cannot drift from the real one unnoticed) and 11 for the reclaim,
including a store-level check that two racing voids share the artifact list
exactly once. 8 failure-path mutations introduced, 8 killed (append-path sync,
room-creation sync, revoke-on-void, the session reclaim, the probe-before-delete
bill, the closed-room answer for a terminal session, the close's exactly-once
gate, and the no-free-renewal guard). `go build ./...`, `go vet ./...`,
`go test ./...` green;
`-race` green on `./account`, `./internal/signal`, `./internal/storage`.

### Remaining seams for checkpoint 2 (exact)

1. **Sender upload.** ✅ **Done in checkpoint 2a.** `stored-file.ts` `UploadPurpose` needs `"pair_room"` and
   `uploadQuery` needs to pass `&code=`. Use `uploadFileResumable` only — the
   single-shot route refuses `pair_room` with 400 on purpose. Honour the init
   response's `chunkSize` (1 MiB here, not 8). Drive
   `markUploading`/`markUploaded`/`failUpload` around it.
2. **Sender failure handling.** ✅ **Done in checkpoint 2a.** `410` from a PATCH or finalize means the room is
   over and the ciphertext is gone: call `failUpload(i)` so the file returns to
   the live-link path, and say so in copy. `409` means the peer joined — stop
   starting new uploads, let the in-flight one finish.

**What checkpoint 2a actually delivered, and what it deliberately did not.**
`preupload.svelte.ts` is the sender driver: one object per file, one at a time,
`403/503/413/429`/network stop the pass silently (the batch and the live link are
exactly as they were), `409` holds — no new init, the running upload finishes —
and `410`/`404` return the file to `staged` and raise the one user-visible
explanation, `pair.preuploadExpired`, rendered outside every branch of
`CodePairing` because the on-screen countdown (mint-based) usually gives up
before the room's real deadline (last-byte-based) does. The outbox gained a
stable per-entry handle (`outboxToken`/`outboxIndexOf`) because an index is not
an identity across a minutes-long upload: without it, removing a file ahead of
the uploading one strands that upload in `uploading` for good, drained by neither
lane. Three things are deliberately open:

- **It is off.** `preuploadSenderReady()` is `advertisedCaps().includes(CAP_PREUPLOAD)`,
  so seam 3 below turns the sender on by announcing the capability and nothing
  else can. Uploading what this build cannot hand off is worse than not
  uploading: the peer joins, gets no key, and the objects wait for the room's
  deadline to delete them.
- **A folder's files are never pre-uploaded.** The stored manifest has no field
  for a relative path (`StoredManifest` is names and sizes), so a pre-uploaded
  folder would arrive flattened while the live link reproduces it. They stay
  staged; flat files in the same batch still go up. Closing this means a manifest
  change, which §6 of the protocol puts out of scope for now.
- **The staged list does not show per-row origin.** An `uploaded` row looks like
  a `staged` one; only the in-flight file has a line of its own
  (`pair.preuploading`). That is seam 5's presentation work.
3. **Flip the capability on.** `advertisedCaps()` must include `CAP_PREUPLOAD`
   only in the same change that implements BOTH sending and receiving kind 10;
   `preupload-handoff.test.ts` asserts it is absent today, and that assertion is
   the reminder.
4. **Wire kind 10 into `transfer.ts`.** Seal/parse with the session key in the
   existing seq space, send before any live-lane content, resend on every
   (re)established link, fold with `mergeHandoff`.
5. **Receiver download.** Fetch `/api/files/<id>/meta` + `/blob` per handoff item
   and decrypt with `StoreDecryptor`; the row's origin (storage vs live) is
   presentation, and one list with two origins is the expected shape.
6. **Countdown copy.** `CodePairing.svelte` reads `expiresAt` once at mint and
   counts down; with pre-upload the deadline MOVES. Finalize's `expiresAt` is a
   floor, not a promise — treat it as such or the UI will show an expired code
   that is actually alive.
7. **B3's over-quota gate before entering the room** is NOT built. The decision
   stands (block before minting, fail OPEN on a read error, say LAN still works);
   it needs a quota read the choose screen does not have today.
8. **Burn-after-download** ("delete the ciphertext once the receiver has it") is
   NOT built; the room's window bounds storage instead. It needs a completion
   signal that resume cannot fake.
9. **Native clients** (`apps/`) are untouched and announce no `preupload/1`, so
   they keep the live-link behaviour. Adding it means porting §4 exactly.
10. **Multi-instance:** pair rooms inherit the pairing registry's existing
    single-process constraint (the registry is in memory). The DB half is
    instance-safe; the code→owner lookup is not, exactly as before this change —
    and the code's *lifetime* is now in the same boat, since an append served by
    another instance extends only that instance's copy of the registry, which
    does not have the code. Nothing new is broken by it: a request that reaches
    an instance which never minted the code is already refused (`403` for an
    upload, no room for a receiver's `/ws`), so the whole flow was pinned to one
    process before any of this. Whatever eventually makes the registry shared
    must carry `ExtendFor`/`RevokeFor` with it, not just the lookup.

## Phase 2 original sketch (superseded above for checkpoint 1)

Not built by the tasks above. Sketched here so the next session starts from the
resolved design rather than re-deriving it. Phase 1 is a prerequisite: it is what
creates the waiting-state staging surface that Phase 2 attaches an uploader to.

The transport already exists — `POST /api/files` plus the stored-wire codec
(`docs/protocol/relayium-stored-wire-v1.md`, `relayium-cloud-transport-v1.md`)
is a zero-knowledge encrypt-then-upload pipeline serving `/offline-transfer`
today. Phase 2 binds it to a pairing-code room instead of a `/d/<id>#k=` link.

### Blockers

B1–B3 needed the owner and were **answered on 2026-08-11** (below, with the work
each answer creates). B4–B6 are engineering items that still have to be settled
while building.

Two corrections the owner made to this document's own framing, worth keeping so
they are not re-introduced:

- **There is no "direct" cross-network path.** `web/src/lib/ice.ts:212,219` set
  `iceTransportPolicy: "relay"` whenever a TURN relay is available, which drops
  host and srflx candidates entirely — cross-network browsers do not attempt a
  direct connection and cannot fall back to one. The choice is never
  "server vs direct"; it is **store-and-forward vs live TURN relay**, and both go
  through Relayium. Only LAN is genuinely direct. (The `"p2p"` path label exists
  in the code but is unreachable for a cross-network browser.)
- **Store-and-forward is not inherently faster.** With both peers online, the
  live relay is a single pipelined pass — `size / min(up, down)` — while
  store-and-forward is `size/up + size/down`, strictly worse. The entire benefit
  of pre-upload is spending wait time that was going to be idle anyway: if the
  upload finishes before the peer arrives, the peer pays only `size/down` and
  skips the sender's slow uplink. If the peer joins immediately, pre-upload is
  a net loss. This is why the default is Plan B and A is opt-in by staging early,
  and it is the reasoning behind B2's answer.

**B1 — the 5-minute code TTL vs. a long upload.**
A real conflict the current rules do not resolve, and the first thing to settle.

`CodeTTLSeconds = 300` (`server/internal/signal/pair.go:233`) runs from the
moment the code is **minted**, and is checked exactly once, when a device joins
(`RoomFor`, at WebSocket setup). The owner's rule is 「我上传文件后，对方必须在 5
分钟之内加入」 — measured from **upload**. Those are different clocks, and the
owner's own example is the case that breaks it: 「上传一个大文件，上传本身可能就要
超过 5 分钟」. Mint at T, upload for ten minutes, and the code died at T+5 while
the upload was still running. Nobody can join at all, and the transfer that was
meant to be *faster* cannot happen.

**DECIDED — the code stays joinable while the upload is genuinely progressing,
then the 5-minute clock starts at upload completion.** 「上传期间码不死，传完再计
5 分钟」. `pair.go`'s own comment calls widening this window 「永久放宽一个安全
参数」, and the owner accepted it knowingly, having already declined brute-force
hardening.

What this decision creates:
- The pair registry needs an **extend/keepalive** driven by observed upload
  progress for that room, then a final 300s window when the upload completes.
- **Define "genuinely progressing" or the window is unbounded.** A stalled or
  deliberately trickled upload must not hold a code open forever — needs an idle
  timeout (no bytes for N seconds → fall back to normal expiry). Without this,
  "upload duration + 5 min" is an attacker-chosen number.
- The abuse case is self-limiting but only because of the owner's own billing
  rule: holding a code open requires continuously uploading, and traffic bills
  from the first byte against the holder's own quota. Note this explicitly — the
  billing rule is load-bearing for the security argument, so weakening one
  weakens the other.
- **Client countdown must follow.** `CodePairing.svelte` reads `expiresAt` from
  `sessionStorage` once at mint and counts down from it. Left alone it will show
  an expired code while the code is actually alive.

**DECIDED — split the batch at file boundaries.** Already-uploaded files: the
receiver downloads them from storage. The file currently uploading: let it
finish (it is already paid for), then download. Files not yet started: send over
the live TURN relay, which skips a whole leg. **Never split a single file across
two transports** — byte-range reassembly across two ciphertext framings with an
integrity check over the seam is a large amount of risk for no real gain.

What this decision creates:
- Confirms B4's per-item state is needed at **file** granularity, not batch.
- Receiver UI shows one list whose rows have two different origins. That is the
  main cost of this choice, and it is presentation work, not protocol work.

**DECIDED — block before entering the room when the account is over quota.**
「进房前就拦」. The create-code action is replaced by a quota explanation, an
upgrade path, and a "use LAN instead" route; no code is minted.

Why the earlier framing of this question was void, and must not come back: there
is **one combined monthly traffic pool**, not separate upload/download/relay
budgets. `account/turn.go:124` says so outright — "monthly traffic (relay +
staged upload/download combined)" — and the same `overTraffic()` gate guards
TURN credentials (`turn.go:126`), upload (`files.go:204,242`), download billed to
the file's owner (`files.go:486`) and Device Inbox (`deviceinbox_task.go:103`).
So an over-quota account cannot fall back to the live relay either: **the whole
cross-network path is dead, not just the accelerated one.** LAN is unaffected —
it generates no server traffic and passes no gate.

What this decision creates:
- **A quota read the choose screen does not have today.** The client currently
  learns about quota only from `/api/ice` (`relayStatus`), which is fetched after
  entering a room. Gating the create-code action needs that state earlier —
  either carried on `/api/me` or a small dedicated endpoint. This is real work,
  not a copy change.
- **The gate must fail OPEN on a quota read error**, matching `turn.go`'s
  existing behaviour ("fail-open so a DB blip never blocks a real user"). A
  fail-closed gate here would deny transfers to paying users on a database blip.
- Copy must say three things: that the month's allowance is used up, how to
  raise it, and that LAN still works.

**B4 (engineering) — the auto-send effect must learn what is already uploaded.**
Phase 1 ships an App effect that drains the whole outbox over the live link the
moment a peer joins (`web/src/App.svelte`, the `outbox().length && surfaceShown
&& visiblePeers.length === 1` effect). If Phase 2 uploads that same batch, the
join must not *also* send it over the link — that is a double send and double
billing. The outbox needs per-item state (`staged` / `uploading` / `uploaded`)
and the effect must drain only the `staged` ones. This is the concrete seam
between the two phases, and where a careless Phase 2 introduces a
duplicate-transfer bug.

**B5 (engineering) — define the key handoff on the wire.** E2E-only delivery
means the file key travels over the DataChannel after the handshake. Which
message carries it, and what happens if the link drops after the peer joined but
before the key arrived? Undefined, this fails as "the receiver joined and then
nothing happened".

**B6 (invariant to preserve, not a question).** A code-room receiver needs no
account today, and stored downloads are unauthenticated and zero-knowledge
(`docs/protocol/relayium-cloud-transport-v1.md`). Phase 2 must not quietly gate
the receiver behind an account just because the bytes now come from storage.

### Open work, roughly in dependency order

1. **Server:** bind an uploaded set to a code room; enforce the 5-minute join
   deadline; delete and void the ciphertext on timeout; burn after the peer's
   download completes so storage is not held past the transfer.
2. **Metering — settled by the owner, 2026-08-11:**
   - Bill upload traffic from the first byte, including when pairing later fails
     or times out. 「不能让用户通过无限制的上传来免费占用我们的带宽和存储空间」.
   - A pairing that times out has its ciphertext **deleted immediately**, so it
     is not billed as storage and its quota is released at once. 「超时作废的密文，
     不用给他存储，直接删掉，所以配额也就释放了」.
   - Quota is drawn from the uploader's own plan allowance. 「这个额度在他自己的
     VIP 等级额度里」.
   - A part-upload cancelled midway is billed for exactly what was transferred.
     「用了多少就给他记多少」.
   - So the meter is traffic-shaped, not storage-shaped: upload bytes always
     count, storage effectively never accrues because the object's whole life is
     bounded by the 5-minute join deadline plus the transfer.
3. **Sender web:** upload staged files during the wait with real progress, hold
   the key locally, and hand it to the peer over the E2E channel on join.
4. **Receiver web:** when a room carries pre-uploaded content, fetch and decrypt
   from storage instead of waiting on the live link; keep the live link for
   anything added after the join.
5. **Copy:** extend `pair.stageNote` with the speed reason the owner asked for
   (「如果想提高传输效率，可以在他加入之前就把文件传上来」), and state plainly
   that pre-uploaded content is encrypted before it leaves the device.
6. **Abuse/billing note:** with pre-upload live, a guessed code downloads the
   whole batch and the egress bills to the sender. The owner declined
   brute-force hardening; the metering rules still need an answer for that case.

## Non-goals

- Staging a **text** draft during the wait. Text is a session with its own
  request/accept handshake; a locally staged draft that auto-opens the composer
  is a coherent follow-up, but it is not files.
- Supporting "upload and close the tab". Ruled out by the E2E-only key decision.
- Letting LAN stage files before any device appears. Today the LAN empty state
  offers no picker; adding one is symmetric with this change but is a new
  behavior the owner has not asked for.
- macOS (`apps/mac/Relayium/DirectPane.swift:146`) and iOS
  (`apps/ios/Relayium/DirectView.swift:361`), both of which hard-gate their
  create-code button behind `.disabled(selection.isEmpty)` and need the same
  inversion. Blocked on unowned uncommitted work — see the lease.

## Risks

- **Share-target regression.** Removing the files-first buttons changes who fills
  the outbox first. Task 3's append semantics are what keep a share-sheet batch
  from being clobbered; `share-target.test.ts` must stay green.
- **`startOver` clears the outbox.** `CrossPage.startOver` calls `clearOutbox()`.
  That is still correct — an abandoned pairing must not surprise-send later — but
  it now discards work the user did *inside* the room, so it must keep reading as
  a deliberate reset.
- **Auto-send confirmation.** With advanced verification on, staged files raise a
  confirmation bar rather than sending. More files staged means that bar matters
  more; `verify-gates.ts` behavior must not change.
