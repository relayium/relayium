# Relayium Web MVP — Manual Acceptance Procedure

This document is the repeatable acceptance script for spec §7 criteria 1–6.

Accessibility has its own procedure — automated coverage plus a screen-reader
matrix that no headless check can stand in for: **[TESTING-accessibility.md](TESTING-accessibility.md)**.

**Execution status key:**
- `[AUTOMATED]` — actually executed in CI / this session; output captured.
- `[MANUAL]` — requires two real browsers/devices and a real network; cannot run headless.
- `[NOT RUN]` — written, but not currently executing anywhere. Not coverage.
  There is no live instance of this in the browser suites today: the long-standing
  one, the tail of `web/e2e/lan-transfer.mjs`, was deleted in §1a Stage 4 rather
  than left sitting in the tree looking like coverage.

---

## 0. Prerequisites

- Go 1.22+ and Node 20+ installed.
- Two machines (or two browser windows for intra-machine tests) on the same LAN, or two tabs
  pointing at `http://localhost:<port>` for a quick sanity check of the UI only.
- Chrome 114+ recommended for criterion 2 (streaming-to-disk via `showSaveFilePicker`).
- Firefox and Safari available for criterion 6 (browser matrix).

---

## 1. Build both halves `[AUTOMATED]`

```bash
# Web client
cd web
npm run build
# Expected output: "built in <Xms", creates web/dist/

# Server
cd ../server
go build -o relayium-server .
# Expected: binary ./relayium-server created, no errors
```

Verified output (captured 2026-06-28):

```
> web@0.0.0 build
> vite build

vite v8.1.0 building client environment for production...
✓ 117 modules transformed.
dist/index.html                   0.45 kB │ gzip:   0.28 kB
dist/assets/index-CsUDhMuy.css    4.10 kB │ gzip:   1.46 kB
dist/assets/index-DMwganuR.js   476.09 kB │ gzip: 169.44 kB
✓ built in 80ms

server/relayium-server: Mach-O 64-bit executable arm64  (go build OK)
```

---

## 1a. The retired LAN runner — deleted, and where its coverage lives now

`web/e2e/lan-transfer.mjs` and its `test:e2e` npm entry **no longer exist**. They
were deleted in Stage 4 below, together with the two `harness.mjs` APIs that had
no other caller (`setDefaultInit` and the `STRIP_LINK_CAP` wire filter). This
section is kept, in the past tense, because deleting the record would leave the
migration ledger underneath it unexplained — every hosted assertion between here
and Stage 4 is described relative to the scenario it came from.

Two facts about the retired runner, in the order that matters.

### It was never a CI gate

`.github/workflows/web.yml` runs seven hosted browser lanes, and `lan-transfer.mjs`
was not one of them:

| Lane | Script | Job |
|---|---|---|
| Accessibility scan of the built `dist` | `test:a11y` | `test` |
| Page-shell contracts (auth landing, `/apps`, `/pricing`, unsupported layout) | `test:e2e:page-shell` | `test` |
| Pairing-code room, unified workspace | `test:e2e:code-room` | `test` |
| Device-discovery findability journey | `test:device-discovery` | `test` |
| Device Inbox entry journey | `test:device-inbox-entry` | `test` |
| Device Inbox: browser → server → CLI → disk | `test:device-inbox` | `device-inbox-e2e` |
| LAN room, unified `link/1` workspace, real Go server | `test:e2e:mixed` | `mixed-link-e2e` |

That table is the current one, and it is unchanged by the deletion: nothing was
removed from CI, because the deleted script was never in it.

The last row is new as of 2026-08-29 and is **merged**: Phase 3D C3a landed on
`main` as `a703c56f` ("Test unified mixed-link path in hosted CI"). It is a
separate job rather than another step in `test` because it needs a Go toolchain
that Node-only job does not have, and because `test` already spends most of a
15-minute budget on the five browser lanes the table above assigns to it
(accessibility scan, page shell, code room, device discovery, Device Inbox
entry). `web.yml`'s comment beside the `mixed-link-e2e` job records the same
five-lane count.

Getting it hosted required fixing what made it un-hostable: it used to demand
that a human had already started a server on `:8098`. `mixed-link.mjs` now
builds and starts its own, on its own port, over its own temporary database, and
tears the whole thing down — see `web/e2e/go-server.mjs`, the lifecycle it now
shares with `test:device-inbox`. An explicit `--url` still targets a server you
started yourself; without one, nothing external is required.

As of 2026-08-29 (Phase 3D C2) the `/apps` hierarchy contract, along with the
auth-landing and `/pricing` page contracts and the insecure-context layout
contract, moved out of `lan-transfer.mjs` into `web/e2e/page-shell.mjs` — the
`test:e2e:page-shell` row above — so those four **are** executed by every push
and pull request.

### Why it could not be run at all, which is why it went

Commit `d175f863` ("Remove legacy Mac and Web transfer paths", 2026-08-27) deleted
the legacy per-peer transfer controls from `web/src/App.svelte`: the `.pa-files`
label wrapping a hidden `.file-pick-input`, and the file / folder / message fork
beside it. A peer card now renders exactly **one** control — `.open-workspace` —
and only for a peer that routes `link/1`. A peer that does not gets
`<p class="pa-unsupported">`: a sentence, not a disabled button.

`lan-transfer.mjs` was built on the opposite premise. Its `main()` called
`setDefaultInit(STRIP_LINK_CAP)` before opening the first tab, so **every** tab in
the suite presented as a legacy `text/1`-only peer — and the scenarios then drove
the fork that such a peer used to be given. That fork no longer exists, so those
scenarios addressed elements the component does not render. From 2026-08-27 until
the deletion the runner exited non-zero on its first scenario
(`mobileRelayFallbackScenario`, which picked up a `.file-pick-input` that no
longer resolved to an element), so nothing after that point produced any signal: the main LAN transfer
act, small-message-cap, transfer-boundary, early-failure, mobile-no-picker,
desktop-picker-cancel, resume, the four message scenarios, multi-page-device and
caps-suppressed were all downstream of a run that had already died.

A script that cannot exit zero is worse than no script: it teaches every reader to
ignore a red run. That is the whole argument for Stage 4, and it is why the
prerequisite was never "is anyone still using it" but "has every assertion it
uniquely held landed somewhere that actually executes".

The four page contracts it used to carry are `[AUTOMATED]` in their new home,
`web/e2e/page-shell.mjs`, executed on every push and pull request.

### What is actually lost — smaller than the tail's length suggests

This script has been described as the **only** regression net for the realtime
pipeline. That was true once and is not true now, and repeating it would overstate
the damage and misdirect the repair. A coverage audit against `mixed-link.mjs` and
`code-room.mjs` found **substantial duplication**: the handshake-to-disk path,
byte-exact resume across a forced PeerConnection replacement, one-SAS-per-link,
per-file SHA-256 integrity, consent state machines, live-state accessibility scans
and teardown are all driven by those two — on the unified `link/1` surface that
replaced the fork, and `code-room.mjs` runs in hosted CI on every push.

The audit originally listed **eight** current unique assertions as stranded. All
eight rows have since changed status, so the live count is **none stranded, six
hosted migrations and two retired**:

| # | Unique assertion | Status |
|---|---|---|
| 1 | Mobile no-picker fallback (the product opens no picker on a phone) | **hosted migration** (C3b-6, exact-main `122cb2fd`) |
| 2 | Desktop save-picker cancellation | **hosted migration** (C3b-4, exact-main `daadc94a`) |
| 3 | SCTP negotiated max-message-size boundary (RFC 8841 default, 64 KiB) | **hosted migration** (C3b-5, exact-main `b08457d6`) |
| 4 | Response race (responder accepts while the initiator is still taking ownership) | **retired** — see below |
| 5 | Pre-open PeerConnection failure (`failed` before the DataChannel opens) | **retired** — see below |
| 6 | Live `role="progressbar"` accessibility during an in-flight transfer | **hosted migration** (C3b-1, exact-main `129e4cd`) |
| 7 | Multi-page device identity and focus (two pages of one browser plus a third device) | **hosted migration** (C3b-7, exact-main `c7b83dc4`) |
| 8 | Bounded relay-pool failure (credentials issued from the pool, then discarded) | **hosted migration** (C3b-8, exact-main `74ac85db`) |

"None stranded" was a statement about the migration inventory rather than about
`lan-transfer.mjs`, which at the time still existed and still could not run.
Deleting it is Stage 4 below, now done; the assertion it was waiting on — the
rendered unsupported-peer shape migrated in C3b-9 — is hosted: `mixed-link-e2e` ran
the four-scenario ledger green on hosted PR run **33290134608**, which merged as
exact main **`9d815c84`**, and the merged bytes ran it green again in the
`mixed-link-e2e` job **99200800583** of exact-main Web run **33290357209**. That
job's conclusion is `success`. The Web workflow on that commit is red anyway,
because its separate `test` job failed the page-shell touch-target assertion
recorded under Stage 4 — nothing here claims the exact-main Web run was green.

**Row 1's wording is corrected here, and the correction matters — the retired
runner was stronger than the audit's phrasing suggested.** The audit named it
"no `showSaveFilePicker`", which reads as a browser without the API.
`lan-transfer.mjs`'s `mobileNoPickerScenario` did not arrange that. On the
exact-main revision that still carried the file,
its `WORKING_PICKERS` block (lines 317-329) installed a *working*
`showSaveFilePicker` and a *working* `showDirectoryPicker`, both resolving to
handles whose `createWritable()` really swallowed and counted bytes, spoofed an
Android user agent, and then asserted zero picker calls, zero bytes through a
handle, and a byte-exact Blob delivered by the browser download alone. That is
already the *proactive* rule — `pickersAllowed()` refusing the File System Access
branch on a phone **even when both pickers are present and working**, with the
consent card promising the Downloads directory before the user commits. C3b-6
**carries that proof forward**; it does not replace a weaker assertion, and
nothing here should be read as saying the old scenario proved less than it did.

What C3b-6 changes is where that proof lives and how tightly it is instrumented.
It migrates from the retired local-only runner — which is not wired into hosted
CI and has not executed for weeks — onto the current unified hosted `link/1`
journey, so the rule is proved on the pipeline the product actually ships rather
than on the LAN fork that surface replaced. On top of the migrated core it adds:
the two picker branches counted apart instead of through one shared counter, so a
run that opened the directory picker cannot pass as "the save picker was never
opened"; an explicit runtime usability probe that spends and then clears each
picker before the act relies on their silence, rather than leaving usability as
an unchecked property of the stub; a maintained-language rendered-copy contract
in `ReceiveActions.test.ts` standing behind the runner's language-agnostic hint
pattern; restoration of all four replaced browser boundaries and the user agent
by identity, in a `finally` that cannot throw; a name-scoped terminal card
so this new success cannot satisfy a later act's completion wait; and a
post-accept wait on the *first decisive* save boundary — one captured download
**or** any picker call — whose counters are judged before the slower terminal
and byte-exact checks, so a lifted mobile gate produces a prompt red naming the
picker branch and the bytes its handle took instead of a 60-second timeout on a
download that was never coming. The absent-API
case the audit's wording described, and the same mobile gate at the `filesink`
layer, both remain deterministically covered by `src/lib/filesink.test.ts`; what
only a browser can supply is that the live pipeline honours it end to end. See
below for exactly what this does and does not prove.

**Row 3 says SCTP, and the distinction is not pedantic.** There are two unrelated
64 KiB numbers in this product and naming the wrong one sends the repair to the
wrong module. This row is the *transport* limit: `a=max-message-size` as
negotiated per RFC 8841, read off `RTCPeerConnection.sctp.maxMessageSize`, whose
default when a peer advertises nothing is 65 536 — which is why an Android WebView
peer drags a desktop sender down to it and why the file stream must fragment
(`src/lib/wire-limit.ts`, `CONSERVATIVE_MAX_MESSAGE_BYTES`). It is **not**
`TEXT_MAX_BYTES`, the product's own 64 KiB cap on one text message
(`src/lib/text-wire.ts`), which exists so that anything larger is treated as a
file rather than silently split. The two even disagree numerically at the
boundary: 64 KiB of plaintext seals into a 65 557-byte frame, which does *not*
fit a channel that negotiated 65 536. What `lan-transfer.mjs`'s
`smallMessageCapScenario` uniquely held was the transport half — it rewrote the
SDP to force a real 64 KiB negotiation in a real Chromium and proved the old
192 KiB chunk frame was refused while a fitted one was accepted. The fragmentation
arithmetic behind it is already deterministic
(`src/lib/transfer-fragmentation.test.ts`); C3b-5 moved the previously stranded
negotiation into the existing real-Chromium mixed journey and is now hosted on
exact-main `b08457d6`, as recorded below.

**Row 4 is retired rather than migrated, and here is the exact evidence.**
`messageDefaultRaceScenario` forced the reported LAN failure: B auto-accepts and
sends its first message while A's `getStats()` path sample is still held, so both
frames arrive on an open DataChannel before A's lane has attached a handler. That
window is now closed by construction — the transport captures frames that arrive
before attachment and replays them into the lane afterwards — and the closure is
pinned by deterministic tests that run in `npm test` on every push:

- `src/lib/mixed-session.test.ts` — "replays a text request captured before lane
  attachment" (a REQUEST delivered before `attach`, replayed, status
  `incomingRequest`); "fails quickly instead of replaying into a declined lane
  capture sink"; "re-attaches both lanes to a replaced transport before replaying
  its capture" (both lanes own the new transport before a single captured frame
  replays).
- `src/lib/peer-link.test.ts` — "holds an inbound offer and replays the frames
  that chased it, in order", and the capture-replay case at `peer-link.test.ts`
  asserting `{ file: [1, 2], text: [9] }` arrive on the replacement channels in
  order and cannot be replayed twice into the codecs.

Ordering is the whole property, and those tests assert order directly.

**Row 5 is also retired with executable evidence, not counted as a migration.**
The old browser scenario forced `onconnectionstatechange("failed")` while the
removed receive-side constructor still had a not-yet-initialized callback in
scope; its unique regression was the resulting TDZ `ReferenceError`, not a
browser-specific ICE behavior. The unified implementation closes that window in
two deterministic layers that run in `npm test`: `src/lib/peer-link.test.ts`
fires the terminal callback synchronously before the transport promise resolves
and proves a clean failed manager with no current link, while
`src/lib/webrtc.test.ts` now drives an initial `connectLink` to `failed` before
either DataChannel opens and proves the named rejection, caller notification,
closed PeerConnection, and that a late open dispatch cannot turn the rejected
setup into success. The old receive constructor and its control no longer exist,
so reproducing their artificial browser hook would add no current-path fact.

The second half of the reason is about the scenario's *mechanism*, and it is the
half that makes this retirement rather than a deferral. That scenario did not
wait for the race; it manufactured it, by replacing
`RTCPeerConnection.prototype.getStats` with a promise the test released by hand.
That worked because the path sample was the last thing standing between an open
DataChannel and an attached lane. It no longer is. In
`src/lib/mixed-session.svelte.ts`, `onLinkChange` publishes the link
(`publishedLink = link`), attaches **both** lanes (`file.attach(link)`,
`text.attach(link)`, followed by a throw if either channel ended up without an
`onmessage`), and replays every captured frame — all synchronously — and only
*then* calls `observePath(link)`, which fires the `conn.path()` sample and
returns without awaiting it. `conn.path()` is `pc.getStats().then(classifyPath)`
(`src/lib/webrtc-core.ts`), so holding `getStats` now suspends a diagnostic that
has already been overtaken by the attachment it used to precede. The injection
point still exists; the window behind it does not.

To be exact about what is and is not being claimed: the unified workspace could
host an act for this. Nothing about `link/1` prevents writing one, and it would
not require restoring the deleted per-card message control. What is gone is the
lever — there is no longer a hook that opens the gap on demand, so a migrated act
would be racing a timer, which is what the original scenario's `getStats` hold
was written to avoid. Combined with the deterministic tests above, which assert
the property directly and run on every push, that makes this retired rather than
lost.

The remaining six are the actual regression exposure, and they are what the
migration below has to carry across. Everything else in the tail can be retired
rather than ported, because a hosted suite already asserts it.

That staleness risk is closed as of Stage 1 below: `appsHierarchyScenario` now
runs in hosted CI on every push and pull request, so a change to
`AppsPage.svelte` or `native-releases.json` can no longer merge without it
having executed.

### The migration direction for the stranded tail

The repair is **not** to restore the deleted controls, and not to add a test-only
switch that re-renders them. The legacy fork was removed from the product
deliberately; a path back to it that only tests can reach would assert behaviour no
user can ever get, which is worse than asserting nothing.

The migration is staged, and the stages are ordered so that coverage is never
lower than it is today. Each stage lands and goes green before the next begins.

**Stage 1 — a hosted page-shell suite — complete, 2026-08-29 (Phase 3D C2).**
The three scenarios that used to pass here were page contracts, not transfer
contracts, and did not belong in a transfer suite at all. They moved, together
with `unsupportedLayoutScenario` (the current single-column layout contract,
which was already content-independent of the removed controls and only failed
to run here for ordering reasons), into `web/e2e/page-shell.mjs`: a new
vite-preview-only hosted suite covering auth-landing route isolation, `/apps`,
`/pricing` and the insecure-context layout contract, wired into
`.github/workflows/web.yml` as `test:e2e:page-shell`. It needs no live Go
server — none of the four scenarios' assertions depend on real backend
responses; `/api/plans` is answered by the same in-process fixture the
accessibility scan already uses. `page-shell-contract.test.mjs` guards the
runner itself against silently dropping a scenario: it asserts a fixed
`EXPECTED_SCENARIO_COUNT` (not a comparison against the array's own, mutable
`.length`) and pins the new CI step as unconditional. This stage converts the
`/apps` hierarchy contract from local-only to hosted — the first time it is
enforced by anything other than someone remembering to run it.

This lane was **red on exact main `9d815c84`** (the `test` job of hosted Web run
33290357209), on a sub-pixel touch-target comparison rather than on any product
geometry. The repair merged into `main` as `47d648fc` (PR #96, merge commit
`3e9db59a`), and on that merge commit the lane is **green**: the `test` job
99206014409 of hosted Web run 33292324851 reported `test:e2e:page-shell` **4/4**.
See "The 44px touch floor, and the one renderer delta it tolerates" below.

**Stage 2 — the transfer uniques move into `mixed-link.mjs`, and `mixed-link`
becomes hosted.** Uniques 1–6 above are about the real pipeline (commit-reveal,
chunked AES-GCM, ACK flow control, checkpoint resume, consent), not about the
retired fork. They come off `STRIP_LINK_CAP` and onto the unified `link/1`
workspace — `.open-workspace`, then the workspace's own composer and
`.attach-file` / `.attach-folder`. `mixed-link.mjs` already drives exactly that
surface. Migrating uniques into a suite nobody runs would move the problem
rather than fix it, so hosting `mixed-link` came first and is **merged** (C3a,
2026-08-29, `a703c56f`): the `mixed-link-e2e` job above runs the suite on every
push and pull request — its one scenario at the time, and its two since C3b-7.
Moving the remaining uniques onto it is
C3b, and it starts from a baseline that is green and hosted rather than from a
suite whose own queued-batch assertion had been stale for weeks.

**C3b-1 — the live progressbar, file lane only.** The first C3b slice migrates
**unique #6 and nothing else**. It is a file-lane entry in every sense worth
recording:

- *What moved:* the live `role="progressbar"` assertion, into `mixed-link.mjs`'s
  existing 5 MiB resume act as a new `live-progressbar` act. It runs in the one
  window where an in-flight transfer exists — after the receiver has taken two
  durable chunks and **before** the forced transport gap closes both
  PeerConnections. The subject is proved to exist (one bar per direction,
  `role="progressbar"`, `aria-labelledby` resolving to the card's own heading id
  `xfer-label-{send,recv}`, `0 ≤ aria-valuenow ≤ 100`, card not yet terminal) and
  only then scanned with `scanLiveState` scoped to `XFER.card`. A scoped `axe.run`
  over a context matching nothing reports zero violations, so without the
  existence proof this act would print "axe clean" forever.
- *How that window is held open, and when it closes again:* the receiver's
  stubbed sink sleeps per 192 KiB write, and that sleep now has **two** values,
  because this scene contains two pieces of work with budgets an order of
  magnitude apart. `SCAN_WRITE_DELAY_MS` (1000ms) serves the act above only:
  ~25 writes remain after the two-chunk wait, so the previous 20ms left ~500ms —
  enough for the forced close, which is one CDP round trip, and not enough to
  inject and run axe on two tabs. The transfer would have finished first and the
  act would have failed reporting a terminal card instead of an accessibility
  result. **The moment the last scan returns**, the sink goes back to
  `RESUME_WRITE_DELAY_MS` (20ms — the value this scene ran at before the act
  existed), and it does so deliberately *before* the PeerConnection counts are
  read and before the forced close: the ~25 remaining writes at 1000ms are pure
  wall clock and buy nothing. Leaving the scan throttle on to the end of the
  scene is what took this scenario from ~10s to ~31s — a regression completely
  invisible in a green run, which is why the **order** of that switch is pinned
  by `go-server.test.mjs` rather than left to a comment. The switch also asserts
  the transfer is still live: if two axe passes ever ran long enough to let the
  file finish, every wait below it would time out blaming something else, and the
  scene would have degraded silently into a plain uninterrupted transfer.
- *What did not move in C3b-1:* uniques 1, 2, 3 and 5 were untouched by that
  slice. All four have since changed status: #5 retired on the deterministic
  evidence above, #2 moved in C3b-4, #3 in C3b-5 and #1 in C3b-6; #7 then moved
  in C3b-7 and #8 in C3b-8, so **no numbered row is left**; the separately scoped
  rendered unsupported-peer shape (C3b-9) was what remained before Stage 4, and
  it is hosted as of PR run 33290134608 and, on the merged bytes, the exact-main
  `mixed-link-e2e` job 99200800583 inside Web run 33290357209 at `9d815c84`.
  The byte-exact resume and replacement-PeerConnection assertions were preserved
  unchanged — the act was inserted into that scene, not in place of any of it.
- *What the diff touches:* test and documentation files only —
  `web/e2e/mixed-link.mjs`, `web/e2e/dom-contracts.mjs`, `web/e2e/go-server.test.mjs`,
  `web/src/lib/ReceiveActions.test.ts`, `web/src/lib/workspace-orchestration.test.ts`,
  this document and `web/e2e/README.md`. No product source, workflow, package,
  dependency, native or ops file changed.
- *Anti-vacuity, added with it:* one scenario is not one assertion.
  `mixed-link.mjs` introduced a frozen per-act execution ledger with seventeen
  named acts (C3b-4 adds the eighteenth, C3b-5 the nineteenth and C3b-6 the
  twentieth), checked for membership, order and a **literal** count
  (`EXPECTED_ACT_COUNT`, never `ACTS.length`) — alongside a literal
  `EXPECTED_SCENARIO_COUNT`. A `1/1` scenario count would otherwise be reported
  by a run edited down to its first assertion. `e2e/go-server.test.mjs` pins that
  shape, and pins that the live scan sits between the accept and the forced
  close. C3b-7 adds a **second** scenario rather than a twenty-first act, C3b-8 a
  **third** and C3b-9 a **fourth**, so there are now four frozen lists and four
  literal counts — `ACTS`/`EXPECTED_ACT_COUNT` (20),
  `MULTIPAGE_ACTS`/`EXPECTED_MULTIPAGE_ACT_COUNT` (5),
  `RELAY_ACTS`/`EXPECTED_RELAY_ACT_COUNT` (4) and
  `UNSUPPORTED_ACTS`/`EXPECTED_UNSUPPORTED_ACT_COUNT` (5) — with
  `EXPECTED_SCENARIO_COUNT` at 4. They are kept apart deliberately: a single flat
  list of thirty-four would report the same failure for "one journey never
  started" as for "one act was deleted", and those need different repairs.
- *Shared selectors:* the consent card and the transfer card are now written once
  in `e2e/dom-contracts.mjs` (`RECEIVE`, `XFER`) beside `QUEUED`, and asserted
  against real rendered markup by `ReceiveActions.test.ts` and against
  `App.svelte`'s actual branch structure by `workspace-orchestration.test.ts` —
  both of which run on every push, unlike the browser lane. `RECEIVE` records the
  one trap in that card: under the large-batch memory warning the two buttons'
  **meanings invert**, so `.btn-primary` becomes *decline*. That is why those two
  constants are named for their presentation role — `RECEIVE.primary` and
  `RECEIVE.ghost` — and not `accept`/`decline`: a shared identifier must not
  claim a semantic role that half its branches contradict, least of all at the
  moment a reader is deciding whether a click is safe. The runner establishes the
  branch instead, guarding on the warning before both of its consent clicks and
  failing rather than adapting if it is raised.

**Verification status: green locally and hosted on exact-main `129e4cd`.** Recorded
by the author on 2026-08-30, on a local macOS worktree against a self-started Go
server (`127.0.0.1:8124`) and a headless Chrome:

| Command | Result |
|---|---|
| `npm run check` | 548 files, **0 errors, 0 warnings**, 0 files with problems |
| `npx vitest run` (whole suite) | **4370 passed**, 3 skipped, 0 failed (233 files) |
| `npx vitest run` (the four files this slice touches) | **176 passed** — 79 in `e2e/go-server.test.mjs`, 97 across `ReceiveActions` / `workspace-orchestration` / `QueuedBatches` |
| `npm run build` | succeeded; 12 per-route SPA shells written |
| `npm run test:e2e:mixed` | **17/17 acts performed, in order**, five consecutive runs — 12.05s, 11.24s, 12.41s, 13.01s, 12.69s wall clock (was ~31s before the throttle was restored) |

The adversarial mutation this note previously recorded as un-run has now been
run, and it is the one that mattered: pointing `XFER.bar` at a class that does
not exist — the shape of "the bar stopped rendering during flight" — fails the
real browser run **at the act**, with

> no in-flight progress bar in the send card on tab A: the transfer is already
> terminal, or the bar left its `{#if !xf.done}` branch. Either way this act has
> no live subject left to scan.

and not with a vacuous "axe clean". Three cheaper source mutations were run the
same way and each was caught with a message naming its own cause: deleting the
throttle reset ("nothing restores the throttle after the scan"), renaming
`RECEIVE.primary` back to `accept` (four failures across `go-server.test.mjs` and
`ReceiveActions.test.ts`), and reverting the `web.yml` lane count to "four" ("the
mixed-link job's stated reason names the wrong lane count").

One measurement worth keeping, because it is what justifies restoring the
throttle rather than lowering `SCAN_WRITE_DELAY_MS`: on all five runs the
receiver had written exactly **393,216 of 5,242,953 bytes** at the moment of the
reset — still the two durable chunks it started from. Both axe passes fit inside
the *first* 1000ms sleep, so the runway left for the forced close is the full
~25 writes × 20ms ≈ 500ms, which is the budget this scene was already proven at.

The subsequent `mixed-link-e2e` run on exact-main `129e4cd` passed, so unique #6
is now a hosted migration rather than only a locally green one.

**C3b-2 did not migrate another `lan-transfer.mjs` unique.** Its U1 assertion
pins the initiator-only, one-shot same-PC ICE restart, and U3a pins the shared
empty stored-receive save options. Both are adjacent deterministic resilience
contracts. They did not move rows 2 or 3; row 2 moved later in C3b-4 and row 3 in
C3b-5.

**C3b-4 — desktop picker cancellation, inside the existing hosted journey.**
Unique #2 now reuses the 5 MiB transfer that already proves exact bytes,
replacement PeerConnections and resume; it does not add a second browser
scenario or another large payload. On the receiver, the existing save stub is
wrapped so its first call throws a real `DOMException` named `AbortError`. The
runner then proves one retry hint with non-empty `role="status"` text, no bytes,
no opened sink, no new terminal failure, exactly one picker call after a short
no-auto-reopen window, the same request heading and manifest, and the same link,
SAS, composer and attachment control. Only a second explicit click may make the
picker count two and begin durable writes; the unchanged progressbar/resume tail
then proves the final name, size, byte pattern and replacement transport.

The shared `.savehint.retry` selector lives in `e2e/dom-contracts.mjs` and is
pinned against rendered `ReceiveActions` markup in its ordinary Vitest test.
`e2e/go-server.test.mjs` independently freezes the new eighteenth act, its
position before progress/resume, the real AbortError injection, the first/second
picker counts, the non-terminal same-consent evidence, and the exact-byte tail.
No product source or timing constant changed.

The classified cancellation deliberately produces one console error. The runner
marks both tabs' error-array lengths immediately before the first click and,
after proving retry state, consumes only one exact receiver entry containing the
fixed product prefix, `SaveCancelledError`, and `showSaveFilePicker` source. A
duplicate, a different error/name/source, an entry on the sender, or the same
text outside that marked window remains for the unchanged final console sweep to
fail. There is no global ignore expression for picker errors.

The subsequent `mixed-link-e2e` run on exact-main `daadc94a` passed, so unique
#2 is hosted coverage rather than a local migration awaiting CI.

The old `NotAllowedError` second act was not carried into Chromium. It was an
artificial exception injected by the old runner, not evidence about a real
browser permission prompt. Its product rule is deterministic and remains
covered directly: `src/lib/filesink.test.ts` distinguishes `AbortError` from
non-cancellation failures, and `src/lib/mixed-file-session.test.ts` proves a
non-cancellation save failure rejects the transfer rather than claiming the user
cancelled it. That half is retired on those exact tests; this migration does not
claim real-browser permission-denial coverage.

**C3b-5 — absent SCTP advertisement and the RFC 8841 boundary, inside the same
hosted journey.** Unique #3 now installs a narrow `setRemoteDescription` seam on
both existing tabs which removes every nonzero `a=max-message-size` line before
Chromium consumes the remote SDP. A small same-tab raw DataChannel probe first
proves that a real nonzero advertisement was removed, Chromium reports
`pc.sctp.maxMessageSize === 65_536`, a 65,536-byte send remains open, and a
65,537-byte send cannot remain a successful open send. The probe's two PCs and
removal counter are then explicitly checked and reset before the product link is
opened, so they cannot satisfy the product or replacement-PC assertions.

The existing product journey then proves both initial product PCs independently
negotiated exactly 65,536. Its unchanged 5 MiB byte-exact transfer, forced gap,
resume and replacement proof run under that cap; at the end, unfiltered arrays
cover every tracked PC on both tabs and require every entry to remain exactly
65,536. Null or closed SCTP state is not filtered away. This is deliberately
separate from `TEXT_MAX_BYTES`: the latter is a plaintext product limit and is
neither imported nor asserted by this transport contract. The old runner's
dynamic 262,144-to-65,536 arithmetic remains directly covered by
`src/lib/transfer-fragmentation.test.ts`; this browser migration claims the real
absent-advertisement negotiation and the capped replacement journey, not a
second runtime implementation. No product source, workflow, package or timing
constant changed.

**Verification status: green locally and hosted on exact-main `b08457d6`.** The
author run recorded 194/194 in the focused four-file Vitest set, zero
`svelte-check`/TypeScript diagnostics, a successful production build, and the
real self-started Chromium journey at 19/19 acts. The subsequent `mixed-link-e2e`
run on exact-main `b08457d6` passed, so unique #3 is hosted coverage rather than
a local migration awaiting CI.

**C3b-6 — the phone opens no save picker at all, inside the same hosted
journey.** Unique #1 moves onto the same live `link/1`, between the
byte-identical text act and the desktop picker act, as the twentieth entry in the
act ledger — thirteenth in run order, with seven acts after it. For one
96 KiB deterministic file the receiver tab is given an Android user agent and
platform through `Emulation.setUserAgentOverride`, and four browser boundaries are
replaced at once: `showSaveFilePicker`, `showDirectoryPicker`,
`URL.createObjectURL` and `HTMLAnchorElement.prototype.click`.

**Both pickers installed for it genuinely work, and that is the whole
anti-vacuity argument.** They resolve to handles whose `createWritable()` really
accepts bytes and counts them, and the act *proves* that at runtime before it
relies on their silence — one call each and exactly eight bytes swallowed — then
resets the counters so the proof cannot later be mistaken for the product opening
one. "Zero picker calls" over a stub that throws is a statement about the stub; over
one that would have succeeded and eaten the file it is the only available evidence
that the product decided **in advance** not to open it. The two picker branches
are counted apart, because the product has two (flat single file vs. everything
else) and a single counter would let a run that opened the directory picker pass
as "the save picker was never opened". A source contract cannot supply this: a
function nobody calls has an unobservable body.

The user agent lands **before** the batch is sent, because `ReceiveActions`
resolves its save hint once, when the consent card mounts. Before the accept
click the runner reads the shared `.savehint` selector and requires exactly one
hint, not the retry variant, no memory warning, and copy that promises the
Downloads directory *and* is not the picker sentence the desktop branch renders —
checked in both directions, in whichever of the two maintained languages the run
booted in, so a hint asserted only by absence cannot pass on empty text. After the
click, both picker counters and the handle's own byte counter must still be
exactly zero; exactly one download must have been captured at the product's own
two boundaries with the exact name, declared length and byte pattern; its
uniquely name-scoped transfer card must be successful, carry no in-flight bar and
carry no cancellation wording; and the same link, SAS, composer, attachment
control and empty request queue must survive. The payload formula is written once
and interpolated into both the sending page and the verifying page — two copies
would make "byte-exact" mean "this file agrees with itself". Bytes are read off
the captured `Blob` rather than fetched through `blob:`, because production CSP
does not allow `blob:` in `connect-src` and a fetch would fail on the stub rather
than on the product.

**Because this adds an earlier successful transfer, the resume act's terminal
wait had to change.** It waited on `.xfer.ok` anywhere on the page; the mobile
download now satisfies that immediately, so a resume that never resumed would
have sailed straight through it and every assertion after it would have described
the wrong transfer. Both are now scoped by the card whose single-file counter
names the exact file, and a card that stopped rendering that counter **throws**
rather than filtering itself out — otherwise a renamed counter would silently
reduce every name-scoped check to `length === 0`, i.e. to a wait that can only
time out blaming the product.

Restoration is by **identity**, not by shape: the desktop cancellation act that
runs immediately afterwards captures `window.showSaveFilePicker` and calls
through to it, so "a picker is installed" is not the property that matters. The
`finally` restores all four functions and the original user agent and platform,
drops the temporary global along with the `Blob` and object-URL references it was
pinning, and — deliberately — **cannot throw**. A `finally` that throws replaces
the exception that sent it there, so a failure during setup would have been
reported as a missing global while the real diagnosis went unprinted, and the
first fault would have skipped the user-agent restoration and handed the desktop
acts a phone. Each half is therefore caught, both always run, and a cleanup fault
is re-raised only *after* the block, where it can only be the whole story. The
unchanged desktop act then proves its own two picker calls still happen, which is
the downstream evidence that the restoration was real.

**Be exact about what this is.** It is desktop Chromium wearing a spoofed Android
user agent, with browser-boundary stubs. It is **not** a real Android device, a
real system picker or a real Android download manager, and neither the runner nor
`go-server.test.mjs` may describe it as one — there is a contract that fails if
they start to. The two reported field failures behind the product rule (a
built-in browser whose picker opens nothing, and Chrome's folder page where one
stray Back cancels the whole receive) are **not** reproduced here. What is proved
is the product's own proactive policy on the unified pipeline: `pickersAllowed()`
refuses the branch up front, the card says so in advance, and the file still
arrives byte-exact through the browser download alone. No product source,
workflow, package, dependency or timing constant changed; the diff is
`web/e2e/mixed-link.mjs`, `web/e2e/go-server.test.mjs`,
`web/src/lib/ReceiveActions.test.ts`, this document and `web/e2e/README.md`.

The ordinary Vitest lane carries the half the browser cannot check. The browser
act matches a Downloads-promising pattern rather than a literal string, because
it runs in whichever maintained language the run booted in; that pairing is only
meaningful while the two sentences genuinely differ and the download one genuinely
says Downloads. `ReceiveActions.test.ts` asserts exactly that against real
rendered markup, in **both** English and Simplified Chinese, on every push —
mounted under each language from the start, since `lang()` is read at render time
and switching afterwards would prove nothing about what a `zh` user sees.

**Verification status: green locally, and hosted on exact-main `122cb2fd`.** The
`mixed-link-e2e` lane ran on exact-main `122cb2fd` — the commit that merged this
slice — and passed, so row 1 is hosted coverage rather than a local migration
awaiting CI. The author's local evidence, recorded before that merge, follows and
is unchanged; it remains the record of what was run by hand, not a hosted claim.
Every row was recorded on 2026-08-30 against the tree exactly as
it now stands — after the review corrections landed and after the mutation pass
below restored it — on a local macOS worktree and a headless Chrome, on branch
`test/mixed-link-mobile-download` based on `origin/main` `b08457d6`. The journey
runner did **not** self-start the server for these runs: an isolated Go test
server was started separately from this same worktree with
`RELAYIUM_STATIC=../web/dist RELAYIUM_ADDR=127.0.0.1:8124`, and the runner was
pointed at that already-running instance. The runner the acts live in is pinned
by content:
`web/e2e/mixed-link.mjs` SHA-256
`b2b78bb2b7f2e44fc0d1669e6036b3a93b5a1e0cb5481334254960fba358cedc`.

| Command | Result |
|---|---|
| `node --check` on `e2e/mixed-link.mjs` and `e2e/go-server.test.mjs` | both parse clean |
| focused `npx vitest run e2e/go-server.test.mjs src/lib/ReceiveActions.test.ts` | **121 passed** |
| `npm run check` | **0 errors, 0 warnings** |
| `npx vitest run` (whole Web suite) | **4394 passed**, 3 skipped |
| `npm run build` | succeeded; 447 generated pages, 12 per-route SPA shells |
| `node e2e/mixed-link.mjs --url http://127.0.0.1:8124` (against the separately started server above) | **20/20 acts performed, in order**, three consecutive runs — 13.27s, 11.90s and 12.59s wall clock |

**Adversarial mutation testing was performed, and the runtime gate was the first
mutation taken.** `pickersAllowed()` in `web/src/lib/filesink.ts` was changed so
the File System Access branch opens unconditionally, the app was rebuilt from
that mutation, and the journey re-run. It failed in **2.284s** — on the first
decisive save boundary, ahead of the slower terminal and byte-exact checks — with
the named diagnostic `saveCalls=1 dirCalls=0 handleBytes=0 downloads=0`. That is
the whole point of judging the counters early: a lifted mobile gate names the
picker branch that opened and reports the bytes its handle took, instead of
producing a 60-second timeout on a download that was never coming.
`filesink.ts` was then restored to its exact pre-mutation content — SHA-256
`624e6b344a5627bd3a43c4707aed94e2fdcc4ada7214aa913265e1b589bd8e90` — and the app
rebuilt from the restored source, which is why the slice's diff is still the five
test and documentation files named above and no runtime source.

Six further mutations were applied to the test files **one at a time**, each
reverted before the next: a picker stub that throws instead of working; a
corrupted `Blob` capture; the old generic `.xfer.ok` terminal wait put back in
the resume act; the `finally` cleanup omitted; the mobile entry omitted from the
`ACTS` ledger; and the `act()` call omitted. Each one failed the focused contract
that exists to catch it, and each file was restored afterwards. Two things this
does not cover: it is not a claim about the hosted lane, and it does not soften
the spoofed-Android limitation stated above into a real-device result.

**C3b-7 — two pages of one browser are one device, as a second scenario on the
same hosted runner.** Unique #7 is the first migration that could not reuse the
existing journey's tabs, so it is the first to arrive as a *second scenario*
rather than as more acts. It needs three pages with deliberately chosen
installation identities — two sharing one LAN seed, a third holding its own — and
it needs advanced verification **off**, because the property under test is where
a request arrives and a consent gate would turn every arrival assertion into an
assertion about a human clicking Accept. Neither is compatible with the twenty-act
journey, which owns two tabs and opts into verification before boot. The existing
journey is therefore untouched: the diff adds a scenario beside it and preserves
all twenty acts in order.

It is driven entirely through the current `link/1` surface. The defect was
originally found on a per-peer-card message control that no longer exists, and
the migration rule for this whole tail is that a proof must not be written
against a surface no user can reach — so the request is opened with the product's
single `.open-workspace` action and arrival is proved by the workspace's own
rendered composer. `go-server.test.mjs` fails if `.peer-actions button` or the
other retired selectors reappear here.

Its five acts, in frozen order:

1. *`multipage-one-device`* — the independently seeded third device sees the
   two-page browser exactly **once**, and neither page lists its own sibling.
   Both are exact roster comparisons, not membership tests: a page that offered
   its sibling *alongside* the other device would satisfy `includes` and is the
   other half of the reported defect.
2. *`multipage-focus-handover`* — focus decides the representative in **both**
   directions (A2, then back to A1), so an implementation of "whichever page
   joined last wins" cannot pass. It additionally requires that the handover
   moved **nobody**: the departure ledger is read before and after and must stay
   empty. A product that re-represented the device by dropping the old page and
   rejoining would satisfy every roster assertion above while dropping live links
   on every tab switch — and `current-page.ts` states the invariant directly
   ("losing focus does not send an inactive frame"), so this is pinning a real
   product rule rather than an incidental one.
3. *`multipage-request-follows-focus`* — the workspace opened from the third
   device reaches the **focused** page and the opener, while a latch armed on the
   background page **before** the request stays at exactly zero. Latched, not
   sampled: a card that appeared and vanished is the same defect as one that
   stayed, and a single read afterwards misses precisely that case. The latch
   also counts a control the background page certainly does have, and that
   counter must be **non-zero** — every other counter is asserted to be zero, and
   zero is equally what an unarmed latch or a stale selector reports.
4. *`multipage-fallback-on-close`* — the represented page is really closed
   (`Target.closeTarget`), the third device must observe **exactly** that page's
   physical departure, and the roster must fall back to the surviving sibling as
   exactly one entry. `includes` alone would also pass if the survivor had been
   reported gone too, which is how "the device fell back" and "the device vanished
   and something else appeared" get confused. The departure ledger is narrowed to
   this scenario's own three page ids — not to soften the claim but to make it
   possible, since the preceding scenario closes its tabs immediately before this
   one opens its own and a straggling `left` frame would otherwise land in the
   ledger.
5. *`multipage-sibling-reachable`* — a roster that fell back is not yet a device
   that works. The workspace the close left behind is answered through the
   product's own control, B must **regain exactly one enabled action** for the
   surviving page, and a **second** workspace is then opened through it and must
   reach that page and open the opener's own composer.

   The surviving page is made current (`activateTab`) before any of that, and
   that step is not cosmetic — see the product defect below, which is what this
   act turned out to be for.

   `returnToChooser` answers whichever single control the header is offering.
   `WorkspaceHeader.svelte` renders exactly one per state — `.wh-restart` for a
   terminal link, `.wh-disconnect` for one still reading as live, including the
   `interrupted` hold `mixed-session.svelte.ts` keeps while a lane still wants
   the transport back — and which of the two a page-close leaves on screen is a
   race this scenario has no business pinning, so both are enumerated. It is one
   answer, under bounds `go-server.test.mjs` pins directly: **one** deadline
   shared by both of its waits rather than a literal on each; **no sleeps**,
   because a pause "to let it settle" passes on a build where the chooser never
   returns; a refusal to succeed by doing nothing (an unanswerable head, or a
   page with neither head nor chooser, is an explicit error); and every refusal
   **reports what was on screen**, including the `.pa-unsupported` count that
   named the real defect.

**The product defect this journey found, and the fix.** Act 5 failed on two real
acceptance runs, and the first diagnosis was wrong. It attributed the failure to
an asynchronous `.wh-disconnect` → `.wh-restart` header transition and grew
`returnToChooser` into a loop that kept answering controls; the second run failed
anyway. A third run carrying a temporary diagnostic — since removed, the tree
restored exactly to `ef8d6f` — settled it. After A1 closes and B answers
Disconnect, B's raw roster is exactly `[A2]`, the workspace head is **absent**,
the open-workspace count is **zero**, and one `.pa-unsupported` card says A2 is
too old to talk to. No header transition was involved at any point.

The cause is one-sided capability pruning. `retainPeers` drops a peer's
announcement when that peer leaves the roster, and two pages of one browser are
**one** roster entry — so while A1 represented the installation, B pruned A2's
`link/1` hello. A2's own roster never changed through any of it, so
`CapsAnnouncer` still counts B greeted and its roster path can never send again.
Neither side is waiting for anything; the surviving page is simply unreachable
for the life of the tab. Any user with two tabs of Relayium open hits this the
moment the represented one closes.

The fix is in the product, and it is one behaviour: on a genuine
`watchCurrentPage` transition the page keeps sending `sendActivate` and now also
re-states its capability hello once to every present non-self roster peer
(`CapsAnnouncer.refreshPresent`). That is the right moment because it is exactly
the transition after which this page is the one a peer is being offered.

It deliberately owes nothing afterwards — no greeted state touched, no pending
entry created or cleared, no timer armed, no attempt spent from the bounded
budget a genuinely new peer is still owed — and it is never called from the
receive path, so answering a hello with a hello remains structurally impossible.
Nothing about admission moved: `peerSupportsLink` is still an exact `link/1`
match behind `linkRoomActive()`, an unannounced peer is still unsupported, and an
old or non-announcing peer behaves exactly as before. `caps-vectors.test.ts` pins
the announcer's side (including the end-to-end prune-then-refresh sequence) and
`go-server.test.mjs` pins the wiring in `App.svelte`.

**What this does not prove.** It is three pages of one headless Chromium with
per-page seed overrides, not three real devices, and the seed override is the
only reason two tabs of one profile count as one installation. It asserts the
server's grouping, representative election and fallback as observed from a third
page; it does not exercise a real network partition, a real backgrounded mobile
tab, or the recovery window's timing. The raw `welcome`/`peers`/`left` frames are
read — deliberately, because two pages of one browser carry the same device name
and the DOM genuinely cannot tell them apart — but they are used only to name the
pages and to know when the server has settled. Every claim about a request
*arriving* is made against rendered product UI, and a contract fails if a
signalling-frame read is ever substituted for it.

*What the diff touches:* **product source as well as tests and documentation**,
which earlier revisions of this section wrongly claimed it did not. Seven files:
`web/src/App.svelte` and `web/src/lib/peer-caps.svelte.ts` (the fix),
`web/src/lib/caps-vectors.test.ts`, `web/e2e/go-server.test.mjs` and
`web/e2e/mixed-link.mjs` (the coverage), and this document plus
`web/e2e/README.md`. No workflow, package, dependency, native or ops file
changed.

**Verification status: green locally, and hosted on exact-main
`c7b83dc413b44713771c54495ef8c7e95d28a209`.** The source merged through PR #93;
its merge-gate run `33285623243` passed every selected lane including
`mixed-link-e2e`, and exact-main Web run `33285787562` passed all five jobs,
including the 25-act mixed-link runner. Row 7 is therefore hosted coverage
rather than a local migration awaiting CI. The author's local evidence, recorded
before that merge, follows unchanged; it remains the record of what was run by
hand, not a hosted claim.

The three pre-fix runs are recorded above, with the defect they found. Two facts
from them belong here. Run 1 reached **20/20** mixed-link acts and multi-page acts
**1 through 4** before act 5 timed out, so everything above act 5 was already
proved against a scenario body this change does not alter. And the speculative
`.wh-disconnect` → `.wh-restart` answering loop written into `returnToChooser`
between runs 1 and 2 — along with its four-bound prose and its source contracts —
was **removed** once run 3 disproved that diagnosis, not kept "just in case".

Codex then independently verified the final restored seven-file source:

| Command | Result |
|---|---|
| `node --check` on `e2e/mixed-link.mjs` and `e2e/go-server.test.mjs` | **pass** — both parse clean. Worth running by hand: no gate parses `e2e/mixed-link.mjs` (`tsconfig.node.json` includes only `scripts/**/*.mjs`, and `go-server.test.mjs` reads it as *text*; `go-server.test.mjs` itself is parsed, since Vitest imports it). |
| focused `npx vitest run src/lib/caps-vectors.test.ts e2e/go-server.test.mjs` | **pass** — **150/150**, including the seven new `refreshPresent` vectors and the six new `App.svelte` / `peer-caps` wiring contracts |
| `node e2e/mixed-link.mjs` (self-started server) | **pass** — **20/20 mixed-link acts then 5/5 multi-page device identity acts**, three consecutive runs on the final source — 15.1s, 14.4s, 13.8s |
| `npx vitest run` (whole Web suite) | **pass** — 233 files, 4428 tests, 2 files / 3 tests skipped (recorded on this same tree before the mutation pass below) |
| `npm run check` | **pass** — 548 files, 0 errors, 0 warnings (same tree) |
| `npm run build` | **pass** (same tree) |

The contracts were checked against deliberate mutations, so they are known not to
pass vacuously. An earlier pass covered four: dropping the `refreshPresent` call
from `App.svelte`'s current-page callback; making `refreshPresent` mark peers
greeted (which fails both the source contract and the unit case proving a
refresh-then-greet peer still gets its bounded retries); reintroducing a `for (;;)`
answering loop in `returnToChooser`; and giving one of its waits a literal
`30_000` instead of the shared budget.

Codex then ran an independent pass on the final source, and took one mutation all
the way into a real browser rather than stopping at the contracts:

- Deleting the `refreshPresent` call from `App.svelte` failed **three** focused
  source contracts; rebuilt from that mutation, the real journey failed **act 5**
  with `head=false chooser=0 unsupported=1` — the exact signature of the pruning
  defect this fix closes, reproduced from the fix's absence rather than argued
  from it. Restoring `App.svelte` returned exact SHA `a5ca3fd1`.
- Replacing `refreshPresent` with a body that cleared `greeted` and set
  `rosterChanged` failed **three** unit and source contracts. Restoring
  `peer-caps.svelte.ts` returned exact SHA `4d53ceeb`.
- Deleting the `multipage-sibling-reachable` act failed **two** ledger contracts.
  Restoring `mixed-link.mjs` returned exact SHA `43ea22da`.

Every mutation was reverted to its exact pre-mutation content, which is why this
slice's diff is still the seven files named above. That pass predates the merge;
the hosted evidence that closed row 7 is the PR and exact-main runs recorded in
the verification-status paragraph above.

**C3b-8 — an unmeasurable relay pool is still used, and the connection it cannot
complete still ends.** Unique #8 is the last row, and like #7 it arrives as its
own scenario rather than as more acts: it needs an `/api/ice` answer installed on
both tabs *before boot*, and the twenty-act journey's entire point is a link that
works. A tab cannot have both. The existing twenty and five acts are untouched;
the diff adds a third scenario beside them.

The field failure it covers: a cross-network transfer sat at "establishing an
encrypted connection", 0%, and reported a connection failure ~30s later, with
clean server logs. The cause was not the timeout. The app used the relay pool
only when `measureRelay` had picked a winner; when the probe timed out — routine
on a phone, where a radio waking from idle plus TURN long-term credentials' two
Allocate round trips eat the budget — it fell back to reading the **legacy
top-level `iceServers`** for a relay. A "only my own nodes" user, and any
node-pool deployment, has no top-level TURN at all, so the transport policy fell
back to `all`, the freshly-issued pool credentials were dropped on the floor, and
both peers were left with host/srflx candidates that cannot cross CGNAT.

The setup is the scenario, so it is stated exactly. Both pages boot with a
`fetch` that answers **only** `/api/ice`, with a pool-shaped body: STUN alone at
the top level, and one relay inside `relays` whose single TURN URL is
`192.0.2.1` — RFC 5737 TEST-NET-1, reserved for documentation and advertised by
nobody, so the Allocate genuinely never completes. A hostname would not do: an
unresolvable name fails in milliseconds on some resolvers and hangs on others,
and neither is "a relay that is up and unreachable". The issued credentials are
deliberately **not** of the TURN REST `<unix-expiry>:<token>` form, because
`relayDeadline` reads an expiry out of that shape and arms a client-side terminal
bound on it — a REST-shaped username would let the link end on a *credential
clock* while this scenario reported a bounded end to an *impossible transport*.

Its four acts, in frozen order:

1. *`relay-pool-only-ice`* — both pages really asked for and ran on that answer
   (a page that never fetched it would run on an empty ICE list and satisfy "no
   relay was selected" for a reason that has nothing to do with the defect), the
   answer still carries **no top-level relay**, and page A is offered exactly one
   enabled `.open-workspace` action. The runner refuses to start on an answer
   with a legacy top-level TURN rather than trusting its own constant to stay a
   `stun:` URL: one added there would relay the link even on a build that threw
   the pool away, i.e. pass while broken.
2. *`relay-probe-spent-its-budget`* — the probe genuinely ran and genuinely
   finished. Waited on an observable product fact, never slept through:
   `measureRelay` closes its connection in a `finally`, so "every connection this
   page has built is closed" is the page's own statement that measurement is
   over, while a sleep of the same length passes just as happily on a build that
   never probed. Each captured configuration is then checked to *be* a probe of
   this pool — relay-only, that one relay, those credentials — rather than merely
   counted. The captures are then cleared and **the clearing is read back**,
   because everything below rests on the array being empty at the moment of the
   click.
3. *`relay-only-link-attempt`* — the product's own control opens the workspace,
   and the connection it builds must keep the black-hole relay **with the exact
   credentials that were issued**, under `iceTransportPolicy: "relay"`. Each of
   those three passes alone while the product is still broken: no relay at all is
   the reported failure; a relay URL with the credentials dropped allocates
   nothing; a relay present under policy `all` spends ~20s on candidates that
   cannot work before falling back to it. The act also requires the top-level
   **STUN** to be in that configuration, which proves two further things without
   a second observer — `chooseRtcConfig` builds the no-selection fallback by
   *merging* the top-level list with the pool, so the STUN marker is present in
   the product's configuration and in no probe's, and a *selected* relay would
   have used that relay's list alone with no STUN in it. That is how "this
   capture belongs to the attempt, not to a probe" and "the black-hole relay was
   never selected" are both settled.
4. *`relay-bounded-named-failure`* — the link cannot come up, and what it must
   not do is stay at "connecting" for ever or silently unmount and hand back the
   chooser with the failure reported nowhere. A **live** workspace header is
   proved first, and its sentence read, because a workspace that never appeared
   and one that failed both render zero `.wh-disconnect`. The terminal read-back
   is then made in product terms: the header is still there, it offers exactly
   one `.wh-restart` and no `.wh-disconnect`, it no longer claims a path, and its
   sentence has actually **changed** from the connecting one — which is the
   locale-independent part, since "it says something" is satisfied by a header
   still saying "connecting".

Everything after the click spends **one** deadline, `RELAY_FAILURE_BUDGET_MS`,
and that budget is deliberately larger than the product's own worst-case terminal
bound (`SETUP_DEADLINE_MS` is 90s in `webrtc.ts`; the link request and the
authentication step are 30s each). The runner's bound has to be the outer one, or
a red run cannot distinguish "the product never terminated" — the whole defect —
from "the runner ran out of patience first". The elapsed time is reported in the
act line, so a run that passed at 119s is visibly different from one that passed
at 35s.

**What this does not prove.** It is desktop Chromium against a reserved address,
not a phone and not a real cross-network path or NAT. The legacy scenario spoofed
an Android user agent and that has deliberately **not** been carried over: the UA
changed nothing about the code under test — `chooseRtcConfig` never reads it — so
keeping it would have dressed a desktop result up as a mobile one. The mobile
pressure that makes the probe time out in the field is replaced by a relay that
cannot answer at all, which is the same input to the same decision. There is also
no console-error sweep in this scenario, deliberately: it asks Chromium to
allocate against an address nothing answers, and asserting silence would be
asserting on the browser's logging rather than on the product.

*What the diff touches:* four files, all tests and documentation —
`web/e2e/mixed-link.mjs`, `web/e2e/go-server.test.mjs`, this document and
`web/e2e/README.md`. No product source, workflow, package, dependency, native or
ops file changed, and `lan-transfer.mjs` was deliberately left in place by that
diff. (Stage 4 has since deleted it; this paragraph records what C3b-8 touched,
not the current tree.)

**Verification status: hosted and green on exact main
`74ac85db83a636f747581cc35b580749d7cf0344`.** The source merged through PR #94;
its merge-gate run `33287525259` passed all 24 selected jobs — six intentionally
skipped — including `mixed-link-e2e`, and exact-main Web run `33287720721` passed
all five jobs, repeating the same 29 ordered acts and the same 30.9s terminal
result. Row 8 is therefore hosted coverage rather than a local migration awaiting
CI. The author's local evidence, recorded before the merge, is kept below as-is:
it says what was run by hand, not what CI concluded.

| Command | Result |
|---|---|
| `node --check` on `e2e/mixed-link.mjs` and `e2e/go-server.test.mjs` | **pass** — both parse clean. Worth running by hand: no gate parses `e2e/mixed-link.mjs` (`go-server.test.mjs` reads it as *text*). |
| focused `npx vitest run e2e/go-server.test.mjs` | **pass** — **136/136**, including this scenario's new contracts |
| `node e2e/mixed-link.mjs` (self-started server) | **pass** — **20/20 mixed-link acts, then 5/5 multi-page device identity acts, then 4/4 bounded relay-failure acts**. The probe was captured **once**, and the black-hole link reached its named `Connection failed` terminal card in **30.9s** — a bound the product met itself, far inside the runner's 120s `RELAY_FAILURE_BUDGET_MS` rather than at it. |
| `npx vitest run` (whole Web suite) | **pass** — 233 files, 4441 tests, 2 files / 3 tests skipped |
| `npm run check` | **pass** — 0 errors, 0 warnings |
| `npm run build` | **pass** — 447 generated pages, 12 per-route SPA shells |

The contracts were then checked against deliberate mutations, applied one at a
time and each restored before the next, so they are known not to pass vacuously:

- Deleting the top-level **STUN marker** check from the link-attempt act failed
  **one** contract — that check is what separates the product's merged fallback
  configuration from a probe's, and from a *selected* relay's.
- Changing `POOL_STUN` from a `stun:` URL to a `turn:` one failed **one**: the
  pool answer would have grown a legacy top-level relay, the exact shape that
  relays the link even on a build that throws the pool away.
- Replacing one of the shared `left()` budgets with a literal `120000` failed
  **one**. One deadline is the claim; a literal per wait is how a bounded
  failure quietly becomes 3 × 120s.
- Deleting the observable closed-probe wait failed **one**. Waiting on a product
  fact rather than sleeping is what makes "the probe really ran and really
  finished" mean anything.
- Deleting the final act, `relay-bounded-named-failure`, failed **two**.

Every mutation was restored, and the restored files hash back to the reviewed
source — SHA-256 prefixes `7da4db13` for `e2e/mixed-link.mjs` and `97cd90f7` for
`e2e/go-server.test.mjs` — which is why this slice's diff is still the four files
named above.

### C3b-9 — the peer this build cannot reach, and what it is told

**Status: hosted, and hosted on the merged bytes. `mixed-link-e2e` ran the
four-scenario ledger — 20/20 mixed link acts, then 5/5 multi-page device
identity acts, then 4/4 bounded relay-failure acts, then 5/5 unsupported-peer
acts — green on hosted PR run 33290134608, which merged as exact main
`9d815c84`; the same four ledgers then ran green on that exact main, in the
`mixed-link-e2e` job 99200800583 of Web run 33290357209, which logged
`Mixed link E2E passed` and completed `success`.** The rest of that Web run is
not part of this claim: the workflow is red on `9d815c84` because a separate
`test` job failed the page-shell assertion, and this document nowhere calls the
exact-main Web run green. This is the rendered half
of the one genuinely legacy-specific claim (discussed under "Two things this
migration must not do", below), and it was the last thing standing between
hosted `main` and Stage 4. It is the runner's **fourth** scenario,
`unsupportedPeerScenario`, with its own two tabs and its own frozen five-act
ledger; the twenty, five and four acts of the first three scenarios are untouched
and the inventory now checks a literal `EXPECTED_SCENARIO_COUNT = 4`.

**It is a migration in name and a stronger assertion in fact.** The retired
`capsSuppressedScenario` asserted one thing — that no message control was offered
to a peer that never announced `text/1` — and that is no longer the product rule.
There is no per-peer message control to withhold, and withholding is only half of
what this product does. A peer that does not announce exactly `link/1` gets an
explicit, non-interactive `<p class="pa-unsupported">` saying so, in the user's
language. "No control" and "no control, and told why" are different products, and
only the second one is this one. So the migrated scenario keeps the absence the
old one proved, and adds the presence that replaced the silence plus the four
ways a card can still mislead with no control on it at all.

**Why a fourth scenario rather than more acts on the first journey.** The same
reason the multi-page and relay journeys are their own: it needs a wire filter
installed before boot on one tab, and the twenty-act journey's entire point is a
link that *works*. A tab cannot be both.

**The instrument, stated precisely.** One tab boots with `SUPPRESS_CAPS_HELLO`,
a test-side rewrite of `WebSocket.prototype.send` that drops the roster hello —
the frame whose `data` carries nothing but `caps`, which is exactly what
`peer-caps.svelte.ts` routes on. The frame is dropped rather than emptied,
because that reproduces the peer production actually has to handle: one that
never announced at all, so `peerCapsKnown` is false and there is no third state
to hide in. It is a wire filter, never a product switch — a runtime downgrade
flag inside the product would be a shipped way to downgrade the protocol,
reachable by whoever can set it, and `src/lib/link-only-surface.test.ts` exists
to keep that from coming back.

**The differential is what makes every absence honest.** The suppressed tab still
*receives* normally, so it sees the fresh tab as an ordinary reachable peer and
renders the ordinary single action for it. Every "the fresh tab has none of this"
therefore has a live positive control one tab away, in the same browser, in the
same room, on the same build: the control exists there, the drag highlight is
taken there, the accent paint is applied there — just not for a peer that cannot
be reached. An absence with no positive control beside it is indistinguishable
from a page that failed to render, and that is the failure mode this scenario is
most at risk of. It is also why the retired scenario's approach — sampling for
eight seconds and concluding absence from silence — was **not** carried over: a
sampled window proves only that the runner was patient. It passes identically on
a page that never rendered, on a roster that lost the peer, and on a probe whose
selectors stopped matching.

Five acts, frozen order:

1. *`unsupported-caps-suppressed-on-the-wire`* — one tab's real announcement was
   suppressed, and both peers still see exactly one another. Three counters close
   the three ways this could be vacuous: `sawLink` proves the build *did*
   announce `link/1` before the filter removed it (without it, a product that
   stopped advertising the capability would leave every absence below passing for
   the wrong reason); `suppressed` proves the filter actually fired; and
   `otherCapsFrames` proves nothing else carried a capability list onto the wire
   behind the hello's back. The fresh tab is separately checked *not* to carry
   the filter, so "neither tab offers a control" cannot be a statement about the
   harness. Mutual visibility comes first, because a peer that vanished from the
   roster also has no control and no card.
2. *`unsupported-one-noninteractive-statement`* — exactly one statement on the
   card *and* exactly one on the page, in **each maintained language**. It is a
   `<p>` with no `role`, no `tabindex` and no `aria-disabled`; that last one is
   the near-miss, because it says "a control, currently not available" — "not
   now" — when the truth is "not this device", and those are different answers to
   "should I wait?". The sentence must also change between `en` and `zh`: two
   maintained languages rendering the same bytes is the one shape that satisfies
   every structural check while the product has stopped translating it.
3. *`unsupported-no-control-no-affordance`* — zero controls and zero refusing
   elements in the card, zero `.open-workspace` on the page, and then the three
   affordances a card can still carry with no control on it: a **real** left
   click (`Input.dispatchMouseEvent`, at a point `elementFromPoint` proves lands
   inside the card, counted by a capture-phase listener so "nothing happened" is
   only credited once the click is known to have happened) opens nothing; the
   drag highlight `ondragover` adds is withheld; and neither the solo accent fill
   nor a pointer cursor is applied. The drag probe's positive control is
   *dispatched and validated* on the reachable card before the unreachable card
   is dragged at all — not merely read first — so the refusal is credited only
   once the probe has been seen to move a real card's class.
   The click half is proved twice, on purpose. The browser proves a real click
   changes nothing, which cannot on its own distinguish "no handler" from "a
   handler that ran and returned"; a source-shape contract over the real
   `src/App.svelte` closes that gap by requiring the `.pcard` `onclick` to be
   conditional on `unifiedPeer` and to be `undefined` for a peer this build
   cannot reach. The browser proof is retained beside it rather than replaced:
   the source says no listener is attached, the journey says nothing happens when
   one is pressed anyway.
4. *`unsupported-drop-refused-with-that-sentence`* — the truthfulness anchor, and
   the only check that the sentence is a *fact* rather than merely rendered and
   inert. A real file drop that lands on the card anyway must be **consumed**
   (`dispatchEvent` returning false, i.e. the page called `preventDefault`) and
   answered, and the notice it produces must be byte-identical to the sentence
   already on the card. A drop the page ignores is left to the browser; a drop
   the page consumes and does nothing with is the file vanishing with nothing
   said anywhere. Because the comparison is statement-to-notice, it establishes
   the claim and the enforcement are one fact **without a single locale string
   being written into the runner**.
5. *`unsupported-quiet-suppressed-tab`* — the other half of the retired scenario,
   kept: the old peer must not be shown a "receive failed" card, a phantom
   session, or anything else invented by a page that could not reach it. Watched
   by `ARM_BACKGROUND_LATCH`, whose `chooser` field is its own anti-vacuity half
   — the suppressed tab certainly *has* that control, so "everything else zero,
   chooser non-zero" can only be reached by an observer genuinely watching a live
   DOM with selectors that still match. Both tabs are then swept for console
   errors.

**Language policy, applied rather than mentioned.** The runner freezes
`MAINTAINED_LANGS = ["en", "zh"]` — exactly what `i18n/types.ts` maintains — and
a source contract fails if any `FROZEN_LANGS` code (ja, ko, de, fr, ar, es, pt)
appears anywhere in the scenario's region. Asserting on an archived translation
would make this go red for a locale nobody is keeping current, which is a false
regression about a real policy. No sentence from *any* locale, maintained ones
included, is written into the runner: a copy edit in `en.ts` or `zh.ts` must not
turn this red, and a build that hard-coded one language must not turn it green.

**What this does not prove.** Two tabs of one headless Chromium, not two devices
and not two product versions: the peer is "old" only in the sense that its hello
never reaches the room. It says nothing about what a real legacy client renders
on *its* screen, nothing about the `LanPathRail` or radar drawn beside the card,
and nothing about any locale outside the two maintained ones.

*What the diff touches:* four files, all tests and documentation —
`web/e2e/mixed-link.mjs`, `web/e2e/go-server.test.mjs`, this document and
`web/e2e/README.md`. No product source, workflow, package, dependency, server,
native or ops file changed, and `lan-transfer.mjs` and its npm script were
deliberately left in place by that diff, until this scenario was hosted. (It has
since been hosted, and Stage 4 has since deleted both; this paragraph records what
C3b-9 touched, not the current tree.)

**Verification status: hosted on exact main `9d815c84`, and proved on the merged
bytes.** The `mixed-link-e2e` lane ran this scenario green on hosted PR run
33290134608 — **20/20, 5/5, 4/4 and 5/5** ordered acts — and that source merged
as exact main `9d815c84`, where the `mixed-link-e2e` job 99200800583 of Web run
33290357209 ran the same four ledgers green again (**20/20, 5/5, 4/4, 5/5**,
`Mixed link E2E passed`, job conclusion `success`). So the rendered
unsupported-peer shape is a **hosted** migration twice over: once on the reviewed
source, once on the bytes that are actually on `main`. The Web run holding that
job is itself red — in a separate `test` job, for the unrelated page-shell reason
recorded under Stage 4 below — and no claim in this section rests on it. The
table below is the earlier **local** record kept unchanged: it says what the
reviewer ran by hand on the reviewed source before the merge, not what CI
concluded.

| Gate | Result |
|---|---|
| `node --check` on `e2e/mixed-link.mjs` and `e2e/go-server.test.mjs` | **pass** — both parse clean. Worth running by hand: no gate parses `e2e/mixed-link.mjs` (`go-server.test.mjs` reads it as *text*). |
| focused Vitest over `e2e/go-server.test.mjs` | **pass — 150/150** at acceptance, including this scenario's source contracts and the updated inventory contracts |
| the real-browser runner, against a locally built Go server, all four scenarios | **pass — 20/20, 5/5, 4/4 and 5/5** ordered acts in real headless Chromium |
| the full Web suite | **pass — 4,455 passed, three skipped** (the three are the suite's own expected skips) |
| `npm run check` | **pass — zero errors, zero warnings** |
| `npm run build` | **pass — 447 pages and 12 shells** |

The 150 is the count *at acceptance*. The narrow post-acceptance revision
recorded at the end of this section adds one contract, so the focused suite reads
**151/151** on the current source; the browser, full-suite, check and build
figures above were taken before that revision and belong to it unchanged, since
the revision touches only test and documentation files.

Seven independent mutations were then applied by the reviewer, one at a time and
each restored to the exact reviewed hashes before the next, so the contracts are
known not to pass vacuously:

- Deleting the real `sawLink` anti-vacuity check failed **one** — that guard is
  the only thing separating "this peer is old" from "this product advertises
  nothing".
- Weakening the exactly-one rendered statement failed **one**.
- Deleting the zero-control gate failed **one**.
- Deleting the real-click landing check failed **one** — without it, "nothing
  happened" is satisfied by a click that never arrived.
- Deleting the notice-to-statement truthfulness equality failed **one**: the
  sentence would then be proved rendered and inert, but never proved true.
- Narrowing the maintained languages to one failed **one**.
- Bypassing the unsupported scenario, or its last act, failed **two**.

Seven mutations, 1/1/1/1/1/1/2, each one reverted to the exact reviewed hashes
before the next and none committed.

The author's own pre-acceptance checks, kept here because they say what was run
by hand before any gate existed in this worktree, were a `node --check` on both
files and twelve one-at-a-time mutations executed by a standalone Node `expect`
shim rather than by Vitest — **91/91** contract blocks sliced out of the real
file and run against the real `e2e/mixed-link.mjs`. That was a genuine execution
of the assertions, not a parse, but it was never the gate; the table above is:

- Removing the `sawLink` guard failed **one** — that guard is the only thing
  separating "this peer is old" from "this product advertises nothing".
- Adding an archived locale to `MAINTAINED_LANGS` failed **one**.
- Replacing a named budget with a literal `10_000` failed **one**.
- Deleting the final act failed **two**.
- Replacing the drag probe's positive control with an eight-second wait failed
  **one** — that is the retired scenario's own approach, rejected by name.
- Weakening "exactly one statement" to "at most one" failed **one**: a card with
  no controls *and* no statement is the silence the statement replaced.
- Removing the second rendered-subject re-read failed **one**.
- Wrapping the drop probe in a `try`/`catch` failed **two**.
- Reintroducing `.file-pick-input` as a constant failed **one**.
- Pinning the statement to an English locale literal failed **one**.
- Dropping the "the click landed on the card exactly once" check failed **one** —
  without it, "nothing happened" is satisfied by a click that never arrived.
- Dropping the notice/statement equality failed **one**: the sentence would then
  be proved rendered and inert, but never proved true.

Twelve shim mutations, applied one at a time and each restored before the next.
At acceptance both files hashed back to the reviewed source — SHA-256 prefixes
`fcf50699` for `e2e/mixed-link.mjs` and `964636a7` for `e2e/go-server.test.mjs`.

**Post-acceptance revision, and what it changed.** Acceptance raised two findings
about *claims*, not about behaviour, and both are closed inside the same
four-file scope:

1. The drag probe's positive control was **dispatched second** while the prose
   said it ran first. Both drags were in flight before either was judged, so the
   negative measurement was taken with a probe nothing had yet shown to work.
   The reachable card is now dragged over and validated before the unreachable
   card is dragged at all, and the source contract pins all four positions —
   dispatch positive, validate positive, dispatch negative, judge negative —
   rather than only the two assertions.
2. The act and this document said there is **no click handler**, while the live
   test proved only that a real click has no effect. Those are different claims,
   and a handler whose whole body is a guard that returns satisfies the second
   one exactly. The new `App.svelte` source-shape contract described under act 3
   makes the first claim from the product source; the browser's no-effect proof
   is retained beside it.

The revision also rejoins one error sentence that was split mid-phrase across a
string concatenation. The message it produces is byte-identical.

Revalidation after the revision: `node --check` **pass** on both files, focused
Vitest **151/151**. The current source hashes are SHA-256 prefixes `f094520f` for
`e2e/mixed-link.mjs` and `e2cadf0a` for `e2e/go-server.test.mjs`; the reviewer
revalidates from there. The diff is still the four files named above.

**Stage 3 — bounded relay failure: hosted on exact main `74ac85db` (C3b-8).**
Unique #7 moved in C3b-7 and #8 was what remained of this stage. It came last
because it needed setup the other stages did not: the pool-shaped `/api/ice`
response, an unreachable TURN host, and a probe budget that actually elapses.

**Stage 4 — delete `lan-transfer.mjs` and its `test:e2e` npm script: done
locally, awaiting review and hosted CI.** The bar was: hosted `main` green with
stages 1–3 landed *and* with the rendered unsupported-peer shape, which as of
C3b-9 means only after the **fourth** scenario has passed `mixed-link-e2e` on
`main`. Stages 1–3 cleared that bar at `74ac85db`; C3b-9 cleared it on hosted PR
run 33290134608, merged as exact main `9d815c84`, and then cleared it in the
literal sense the bar is written in — the **fourth** scenario passed
`mixed-link-e2e` *on `main`*, in job 99200800583 of Web run 33290357209,
20/20 + 5/5 + 4/4 + 5/5 with `Mixed link E2E passed`. That job passing is the
whole of the prerequisite claim; the Web run around it is red for the separate
reason below. Deleting earlier would have dropped the one assertion still
awaiting that run — none remained stranded once #1/#2/#3/#6/#7/#8 had moved
and #4/#5 were retired with the deterministic evidence recorded above; keeping it
after is worse than useless — a script that cannot exit zero teaches everyone to
ignore a red run.

**What the Stage 4 diff does.** It deletes `web/e2e/lan-transfer.mjs`, removes the
`test:e2e` entry from `web/package.json`, and removes the two `harness.mjs` APIs
that had no other caller: the run-wide `setDefaultInit` hook and the
`STRIP_LINK_CAP` wire filter it existed to install. `newTab`'s per-tab
`initScript` is unchanged, and so is every current runner's behaviour — the LAN
seed still goes first and unconditionally, with a scenario's own script layered on
top. Everything else in the diff is documentation, comments that pointed at the
deleted file, and one new contract block.

`web/e2e/go-server.test.mjs` gains that block — "the retired lan-transfer runner
stays deleted" — because **deletion is the one change no other gate here
notices**. A deleted file makes nothing red, and neither does a page still handing
a reader the retired command; they run it, get `Missing script`, and
reasonably conclude the repository is broken rather than that the page is stale.
The block pins: the file's absence (with the runners that replaced it asserted
present, so a wiped `e2e/` cannot report itself as a successful Stage 4); the
absence of the npm entry alongside the continued presence of the live `test:e2e:*`
scripts; the absence of the two orphan harness identifiers **in code** — comments
may still name them, which is how the harness header can tell the next reader not
to bring them back; the surviving per-tab `newTab` composition; and the four
current testing docs, which must not name the retired command.

That last rule is deliberately about *which files*, not about the string being
extinct. Dated specs, plans and reports are history and are explicitly classified
as archives that **may** keep it — `docs/optimization-requirements-2026-07.md`,
`docs/frontend-optimization-report.md`,
`docs/superpowers/specs/2026-07-24-native-macos-ios-design.md` and
`docs/superpowers/plans/2026-07-30-ephemeral-text-transfer-phase1.md`. One of them
is asserted to still contain it, so the whole block cannot pass because somebody
scrubbed every mention everywhere; rewriting a dated record to match today would
make it lie about its own past.

**Verification status: local only.** The author's evidence for this stage is
recorded in the delivery checkpoint, not here as a hosted claim. Nothing in this
section asserts a hosted run on the Stage 4 commit, because at the time of writing
no such run exists.

**One hosted job on exact main `9d815c84` is red, and it is not this one.** The
`mixed-link-e2e` result above is what unblocks Stage 4 — and it is a job *inside*
the run named here. Web run **33290357209** on `9d815c84` holds both
`mixed-link-e2e` (job 99200800583, `success`) and the `test` job (99200800702)
that failed; the workflow's overall conclusion is `failure` for that second job
alone, which is why this document reports the run at job granularity and never
calls it green. The `test` job failed in `test:e2e:page-shell`, on the `/apps`
mobile touch-target assertion: Linux Chromium measured a CSS 44px CTA as
`43.999969482421875` and the scenario compared a raw height against a bare `< 44`.
The same job passed on PR #95, because the shortfall is 2⁻¹⁵ px of float32 in
`getBoundingClientRect()`, not a button that got shorter. **Status: repair
merged into `main` as `47d648fc` ("Stabilize touch target geometry check", PR
#96, merge commit `3e9db59a`), and hosted green on that merge commit.** The fix
keeps 44px as the declared requirement, routes all three touch measurements
through one `undersizedTouchTarget()` comparison with a named
`TOUCH_TARGET_EPSILON_PX = 1 / 1024`, and pins that argument in
`apps-hierarchy-contract.test.mjs`. See "The 44px touch floor" under Stage 1
below. On exact main `3e9db59a`, Web run **33292324851** is green: its `test` job
**99206014409** reported `npm run check` at **0 errors, 0 warnings**, **4,458
passed / 6 skipped**, and `test:e2e:page-shell` **4/4**; its `mixed-link-e2e` job
**99206014430** reported **20/20, 5/5, 4/4 and 5/5**. The native-Web pairing run
**33292324848**, the compatibility run **33292324861** and the repository-hygiene
run **33292324867** on that same commit are green as well. So the repair is a
**hosted** claim now, exactly as C3b-9 became one on run 33290134608 — and Stage 4
above still does not depend on it, because the prerequisite Stage 4 was written
against is the `mixed-link-e2e` job, which had already passed on `9d815c84`.

Two things this migration must not do. It must not restore the deleted controls,
and it must not add a downgrade switch. What remains genuinely legacy-specific is
one claim, and it is a claim about *absence*: a peer that does not announce
`link/1` is offered no control and is told so.

Be precise about what guards that claim today, because the two halves have very
different status:

- **Currently running** — `web/src/lib/link-only-surface.test.ts` (added by the
  same commit that removed the fork). It is a deterministic Vitest source-level
  guard: no legacy session module imported anywhere in production source, and no
  fallback transport reaching the workspace router. It runs on every push, in the
  `npm test` step of the `test` job.
- **Migrated in C3b-9, hosted on exact main `9d815c84`** — `capsSuppressedScenario`
  was designed to assert the observer-side shape in a real browser (a peer that
  never announces caps is offered no control, and the old peer sees no spurious
  card). It is the **last** scenario in `main()`, so it sits deepest in the
  non-executing tail described above and has not run for weeks, locally or in
  CI. Its shape now lives in `mixed-link.mjs` as the runner's **fourth**
  scenario, `unsupportedPeerScenario` — see the C3b-9 section above, which also
  records why the migrated assertion is materially stronger than the retired one
  rather than a rename of it.

So the source-level half has been guarded all along and the rendered half is now
covered too — and hosted, which is what closes the gap rather than narrowing it.
`mixed-link-e2e` ran that fourth scenario on hosted PR run 33290134608, it merged
as exact main `9d815c84`, and the merged bytes ran it green again in job
99200800583 of exact-main Web run 33290357209, so this document may now call the
rendered half a **hosted** migration — on the source that was reviewed and on the
source that is on `main`. That Web run is red overall, in a separate `test` job,
and this sentence does not claim otherwise. It used to be described as waiting
on stage 3 alongside unique #8; #8 moved in C3b-8 and this shape moved in C3b-9,
and it remains a separate piece of work rather than part of any numbered row
above. Nothing in it needs a legacy transfer to be performed, because there is no
longer a legacy transfer to perform.

Each migrated assertion must be run and shown green before this document may call
it automated again. An assertion edited until it stops throwing, with no recorded
green run behind it, is precisely the measures-nothing case this section exists to
prevent.

### The conditional coverage inside `appsHierarchyScenario`

This subsection describes the `/apps` scenario now hosted in
`web/e2e/page-shell.mjs` (Stage 1 above), so what follows is live and hosted,
not aspirational or local-only.

The `/apps` assertions are **derived** from `src/lib/AppsPage.svelte` and
`native-releases.json` (see `appsCardModel`), not pinned to a card list. They
previously hard-coded three "in development" cards (iOS, Android, Windows) and
the counts 6 / 3 / 8; all three cards were removed on 2026-08-28 and the
literals became a stale second copy of a decision owned elsewhere.

One consequence has to be stated rather than assumed. The card contrast/opacity
check originally ran over `.future-card` only. **The release model currently
declares no in-development card, so that group is empty** — and a contrast check
over an empty list passes without measuring anything. The scenario therefore:

- runs the same contrast/opacity probe over the **available** cards, which are
  never empty, in both light and dark themes;
- prints an explicit disclosure line — `in-development card contrast/opacity NOT
  EXERCISED: the release model declares no in-development card` — instead of a
  silent tick; and
- **pins that disclosure**, failing if the reported branch disagrees with what
  the browser actually measured. Deleting the future-card check outright, or
  reporting it as exercised while measuring zero cards, is a red run.

**Revisit trigger:** when a card is next added to `AppsPage.svelte` with an
`available:` expression that is not `true` — i.e. the first time the
in-development group is non-empty again — the disclosure flips to `EXERCISED` on
its own and the future-card contrast assertion resumes with no edit here, and
the next hosted `test:e2e:page-shell` run proves it without a manual step. At
that point delete this subsection's "currently empty" framing. A new
`available:` expression the model cannot resolve fails loudly (`unrecognised
availability`) by design; teach `AVAILABILITY` what it means rather than widening
the regex.

### The 44px touch floor, and the one renderer delta it tolerates

**Status: repair merged into `main` as `47d648fc` ("Stabilize touch target
geometry check", PR #96, merge commit `3e9db59a`), from exact main `9d815c84`,
green locally before the merge and hosted green on the merge commit.** On exact
main `3e9db59a`, the `test` job **99206014409** of Web run **33292324851**
reported `test:e2e:page-shell` **4/4**, with `npm run check` at **0 errors, 0
warnings** and **4,458 passed / 6 skipped**; that run's `mixed-link-e2e` job
**99206014430** reported **20/20, 5/5, 4/4 and 5/5**, and the run's conclusion is
green.

The `test` job of hosted Web run **33290357209**, on exact main `9d815c84`,
failed `test:e2e:page-shell` inside `appsHierarchyScenario`: Linux Chromium
measured the
`/apps` CTA — a button whose only height rule is the global
`@media (pointer: coarse) { .btn { min-block-size: 44px } }` — as
`43.999969482421875`, and the scenario compared that raw height against a bare
`< 44`. The same source passed the same job on PR #95, and the `mixed-link-e2e`
job of that very exact-main run passed; this is one job's assertion, not the
commit. The shortfall is
2⁻¹⁵ px ≈ 0.000031px: `getBoundingClientRect()` returning a value that has been
through float32 on the compositor path. A bare `< 44` was therefore asserting on
that runner's floating-point mantissa, not on product geometry, and it will keep
flipping colour on a source tree nobody changed.

There are two ways to make that run green and only one of them is a repair.
Lowering the target, or widening the tolerance until nothing can fail, both work
immediately and both silently retire the assertion. So the repair is written as
an argument that a test can check:

- **44px stays the declared requirement.** `MIN_TOUCH_TARGET_PX = 44` in
  `web/e2e/page-shell.mjs` is the single source; no site compares against a
  literal.
- **The tolerance is named and bounded by something other than convenience.**
  `TOUCH_TARGET_EPSILON_PX = 1 / 1024` is 32× the observed delta — wide enough
  to absorb the mantissa — and strictly **less** than Chromium's own LayoutUnit,
  1/64 px. Anything genuinely short at the layout level is short by at least one
  LayoutUnit, so a tolerance below that quantum cannot buy a real shortfall. The
  effective floor is 43.9990234375px.
- **One comparison, and it fails closed.** `undersizedTouchTarget()` is the only
  place the floor is compared. It rejects non-finite input, because an empty
  selector makes `Math.min(...[])` return `Infinity` and `Infinity >= 44` is
  true — "measured nothing" would otherwise be indistinguishable from "all large
  enough". All three touch measurements route through it: the auth landing's
  `.auth-action`, `/apps`'s `.cta`, and `/pricing`'s `.toggle-btn`.
- **`/pricing` lost an undeclared ±0.5px tolerance in the same change.** Its
  `cycleTargets` used to be `Math.round(height)`, which is 512× wider than the
  delta that justified any tolerance at all and would pass a genuinely 43.5px
  control. It now measures the raw height and shares the one comparison, and a
  run that measures zero controls is red rather than vacuously green.

`web/e2e/apps-hierarchy-contract.test.mjs` pins that argument as source
contracts, so the two easy non-repairs are red: it reads the two constants'
**values** out of `page-shell.mjs` and asserts `44` exactly and
`observed delta < epsilon < 1/64`; it asserts the fail-closed guard and all three
call sites; and, after excising the comparison function and the comments, it
asserts no second comparison against the floor or a fresh `44` literal survives
anywhere in the file. A constant written in a form it cannot evaluate fails
rather than being skipped.

**Revisit trigger:** if a hosted run ever reports a measurement outside this
bound — short by more than 1/1024px but less than one LayoutUnit — the float32
explanation no longer covers it. Investigate the renderer before touching either
number; widening the epsilon past 1/64 is the one change these contracts exist to
prevent.

---

## 2. Run the server `[MANUAL — start before each acceptance step]`

```bash
cd server
./relayium-server -addr :8080 -static ../web/dist
```

Expected log line: `relayium signaling server listening on :8080`

To use a different port (e.g. to avoid conflicts): `-addr :8095`

---

## 2a. Server smoke test `[AUTOMATED]`

With the server running (substitute the port you started it on — `:8080` below):

```bash
curl -s localhost:8080/healthz
# → ok

curl -s -o /dev/null -w "%{http_code}" localhost:8080/
# → 200

curl -s localhost:8080/ | grep -o '<title>[^<]*'
# → <title>Relayium   (JS then sets a localized title; the tab title also follows the language switch)
```

All three checks passed in the automated run on 2026-06-28 (which used `:8095`
to avoid a local port conflict; the port is the only difference).

---

## 3. Criterion 1 & 3 — Two-device discovery and file transfer `[MANUAL]`

**Criterion 1:** Peer roster populates within a few seconds.
**Criterion 3:** File arrives intact (SHA-256 matches).

### Procedure

1. Determine the server machine's LAN IP: `ipconfig getifaddr en0` (macOS) or `hostname -I` (Linux).
2. Start the server on the LAN machine: `./relayium-server -addr :8080 -static ../web/dist`
3. On **device A**, open `http://<LAN-IP>:8080` in Chrome.
4. On **device B**, open `http://<LAN-IP>:8080` in Chrome.
5. Both pages should display each other under "附近的设备 / Devices on your network" within ~2 seconds.
6. On **device A**, note the SHA-256 of a small test file (~10 MB):
   ```bash
   shasum -a 256 testfile.bin
   ```
7. On **device A**, either drag `testfile.bin` onto device B's card, or press the
   card's **one** action — **Open workspace** (`.open-workspace`) — and attach the
   file from inside the workspace that opens. The per-card file / folder / message
   picker this step used to describe was removed by `d175f863` (2026-08-27); a
   `link/1`-capable card now offers that single action and nothing else, and the
   attachment control (`.attach-file`) lives in the workspace. A peer that cannot
   route `link/1` gets a sentence (`.pa-unsupported`), not a disabled button.
   You may select up to 10 files at once (see §3a).
8. **Device B shows an accept card** ("X 想发送 N 个文件 … 校验码 NNNNNN") with a SAS code.
   Compare it against the SAS shown in device A's send panel — they must match. If they differ,
   click **拒绝 / Decline** (possible MITM; see criterion 5).
9. On **device B**, click **接收 / Accept** — this user gesture opens the save target:
   - a single file → a "Save As" dialog (streamed to disk on Chrome);
   - multiple files → a directory picker; files stream into the chosen folder;
   - Firefox/Safari → each file is buffered and downloaded automatically.
10. On **device B**, verify integrity:
    ```bash
    shasum -a 256 ~/Downloads/testfile.bin   # or the folder you chose
    ```

**Expected:** SHA-256 output matches step 6. Transfer completes without errors.

> **Why the accept step exists:** `showSaveFilePicker` / `showDirectoryPicker` require a user
> gesture. Auto-receiving threw a `SecurityError` on Chrome and the transfer died silently, so
> receiving is now gated behind an explicit click — which also realizes the spec's SAS check.

## 3a. Multi-file batch `[MANUAL]`

1. On **device A**, drag 2–10 files onto device B's card, or open the workspace
   from the card's single **Open workspace** action and multi-select from its
   attachment control (see §3 step 7 — there is no per-card picker any more).
2. Device B's accept card lists every file and the combined size. Click **接收**.
3. For >1 file device B picks a **destination folder**; all files stream into it.
4. Each file is integrity-checked independently; the panel shows `文件 i/N` and overall progress.

**Expected:** All files arrive intact. Selecting >10 files sends only the first 10 (a notice says so).
The AES-GCM nonce counter runs globally across the batch, so no nonce is reused under one session key.

---

## 4. Criterion 2 — 1 GB file without OOM `[MANUAL]`

**Criterion 2:** Streaming write to disk; receiver tab memory stays well under file size.

### Procedure

1. Create a 1 GB test file on device A:
   ```bash
   # macOS
   mkfile 1g big.bin
   # Linux
   head -c 1G /dev/urandom > big.bin
   ```
2. Open **Chrome** on both A and B (Chrome supports `showSaveFilePicker` for streaming-to-disk).
3. Start a transfer of `big.bin` from A to B following the steps in §3.
4. On B, open **Chrome Task Manager** (Shift+Esc) and watch the receiving tab's memory column
   during the transfer.
5. Let the transfer complete.

**Expected:** The receiving tab's memory stays well below 1 GB throughout; Chrome streams the
chunks directly to disk via `showSaveFilePicker` without buffering the whole file. Browsers
without `showSaveFilePicker` (Firefox, Safari) will accumulate the file in memory — use a smaller
file there (see §6).

---

## 5. Criterion 4 — Server sees no file content `[MANUAL]`

**Criterion 4:** Only signaling (SDP/ICE/key-exchange envelopes) traverses the server; file bytes
go peer-to-peer over the WebRTC DataChannel.

### Procedure — log inspection

1. Run the server with its default logging in a terminal window.
2. Perform a transfer (§3).
3. Observe the server's stdout during the transfer.

**Expected:** The server logs only WebSocket connect/disconnect events and per-message envelope
routing. No large binary blobs appear in logs.

### Procedure — tcpdump (optional, stronger evidence)

```bash
# On the server machine, capture port 8080 traffic to a file
sudo tcpdump -i any -w /tmp/relay-capture.pcap port 8080

# Run a transfer, then stop tcpdump (Ctrl-C)
# Inspect the capture
tcpdump -r /tmp/relay-capture.pcap -A | wc -c
```

Compare the capture size against the file size transferred. Signaling-only traffic will be many
orders of magnitude smaller than the file itself (a few KB of JSON envelopes vs. hundreds of MB
of file data).

**Expected:** Capture is tiny — confirming the relay carries no file content.

---

## 6. Criterion 5 — SAS detects MITM `[MANUAL]`

**Criterion 5:** Short Authentication String (SAS) allows users to detect a key-swapping
man-in-the-middle.

### Procedure

This test simulates a compromised server that swaps public keys.

1. In `web/src/lib/webrtc.ts`, locate the `onPeerKey` handler (the function that processes the
   peer's X25519 public key received over the signaling channel).
2. Add a temporary one-line debug shim that replaces the incoming peer key bytes with random bytes
   before passing them to `deriveSession`:
   ```ts
   // DEBUG ONLY — simulate key-swapping MITM
   peerKeyBytes = crypto.getRandomValues(new Uint8Array(32));
   ```
3. Rebuild the web client (`npm run build`) and restart the server.
4. Open A and B; initiate a transfer.
5. Compare the SAS displayed on **device A** with the SAS displayed on **device B**.

**Expected:** The SAS codes differ between A and B. A human comparing them out-of-band (verbally,
or side-by-side) would detect the mismatch and abort the transfer.

6. Revert the debug change and rebuild before any real use.

---

## 7. Criterion 6 — Browser matrix `[MANUAL]`

**Criterion 6:** Transfer works across Chrome, Firefox, and Safari (with noted degradation for
the latter two).

### Procedure

Use a smaller file (~50 MB) for Firefox and Safari to avoid exhausting browser memory.

| Step | Browser pair        | File size | Expected outcome                                           |
|------|--------------------|-----------|------------------------------------------------------------|
| 7a   | Chrome A → Chrome B  | up to 1 GB | Streams to disk via `showSaveFilePicker`; low memory.    |
| 7b   | Firefox A → Firefox B | ~50 MB  | Transfer completes; file buffered in memory (Blob fallback). |
| 7c   | Safari A → Safari B  | ~50 MB   | Transfer completes; file buffered in memory (Blob fallback). |
| 7d   | Chrome A → Firefox B | ~50 MB   | Cross-browser transfer completes.                         |

For each combination, repeat the procedure in §3 (discovery, drag, SAS compare, download,
shasum check).

**Note on degradation:** Firefox and Safari do not implement `showSaveFilePicker`, so the
receiving side accumulates chunks in a `Blob` and triggers a standard download link at completion.
For large files this exhausts tab memory. The ≤ 50 MB figure in the matrix above is this
procedure's own test bound, not the product's limit: the shipped app warns above roughly
256 MB and says so on the page. Use the matrix bound when running these steps, and the
product's figure everywhere else.

---

## 8. Known limitations (M0) — HISTORICAL, superseded

> **⚠️ This table describes the M0 milestone and is kept as a record of it. Do
> not read any row as current behaviour.** Several of its rows were already
> false when this warning was added: Relayium runs a TURN relay in production
> and cross-network pairing-code rooms depend on it, the live deployment is
> HTTPS/WSS only (a secure context is required for the Web Crypto API and
> streaming-to-disk at all), and the buffered-browser advice moved from
> "≤ 50 MB" and "~200 MB" to the single ~256 MB warning the product actually
> shows. Where a row still holds, the current statement of it lives elsewhere
> and that is the copy to trust:
>
> - **Relay and cross-network reachability** — "Cross-network transfer" and
>   "Cross-network TURN relay" below, which are the current procedures.
> - **Buffered-browser limits** — the browser-support table in the root
>   [`README.md`](../README.md) and `web/public/llms.txt`, both pinned to the
>   same ~256 MB figure by `web/scripts/pages/llms-text.test.mjs`.
> - **Stored-link size and quota bounds** — the plan rows the server seeds
>   (`defaultPlans` in `server/account/settings.go`), surfaced live at
>   https://relayium.com/pricing. Figures are not copied into this file, because
>   an operator can edit a plan from the admin dashboard.
> - **Transport and origin rules** — `server/main.go` and
>   [`self-hosting.md`](self-hosting.md).
>
> No row below is a supported statement about the shipped product.

These were explicitly out of scope for the first milestone and were **not**
defects at that time:

| Limitation (M0, historical) | Details as written then |
|---|---|
| Same-LAN / same-public-IP only | No TURN relay is implemented. Peers behind different NATs (different public IPs) will fail ICE. Use a TURN server or run on the same LAN. |
| Same-origin WebSocket only | `websocket.Accept` defaults to same-origin enforcement. Both browsers must open the app from the Go server's own origin (e.g. `http://192.168.1.10:8080`), not from the Vite dev server (`http://localhost:5173`), otherwise the WebSocket upgrade is rejected. |
| Chrome recommended for large files | Firefox and Safari fall back to in-memory Blob buffering. Files above ~200 MB may exhaust memory on these browsers. |
| One transfer at a time | The client handles a single active transfer (send *or* receive). While one is in flight, peer cards are disabled and new incoming offers are ignored until it finishes. Repeated transfers to the same peer now work (the peer connection is torn down and signal listeners unsubscribed on completion). |
| Filename E2E | File names travel in the (plaintext) batch manifest over the DataChannel, which is DTLS-encrypted peer-to-peer — the signaling server never sees them — but they are not under the app-layer AEAD. Encrypting the manifest is a later refinement. |
| No cross-origin CORS | The Go server does not set CORS headers. API calls from a different origin will fail. |
| No HTTPS / WSS | M0 uses plain HTTP and WS. For production use, place behind a TLS-terminating reverse proxy (nginx, Caddy). WebRTC will still use DTLS-SRTP internally regardless. |

## Cross-network transfer (②a: pairing-code room + TURN relay)

Prerequisites: server running with TURN configured (`-turn-secret` / `-turn-urls`),
and a signed-in account on the machine that creates the pairing code. The joining
side needs no account. For a real cross-network test, the two machines must be on
different networks (e.g. laptop on Wi-Fi, phone on cellular). Cross-network browser
rooms use relay-only ICE through the configured TURN server, so the relay carries
only ciphertext — it never sees plaintext or file contents.

1. **Generate a pairing code (sender):** sign in, open the app, click
   "Send to someone on another network", pick files, and generate a 6-digit
   pairing code — a join link and QR appear alongside it (the receiver does not
   need to sign in; codes live 5 minutes). The page reloads into pairing-room mode.
2. **Open the link (receiver, different network):** open the link (or scan the
   QR). The receiver connects to the same room.
3. **Verify SAS (optional):** advanced verification is OFF by default, so no SAS
   is shown. Turn it on in the workspace's "Advanced verification" panel to see
   the 6-digit verification code on both sides and confirm they match — note it
   is a different value from the 6-digit pairing code.
4. **Unified workspace:** the peer card offers ONE action ("Open workspace").
   Press it and confirm both sides get the composer with "Send file" / "Send
   folder" under it, one verification code in the header (with advanced
   verification on) and none repeated on the lane cards. A pairing room is no
   longer the legacy file-or-text fork — see DECISION-LOG 2026-08-10.
5. **Transfer:** send files from the workspace's attachment control; receiver
   accepts and downloads. Confirm the per-file SHA-256 integrity check passes,
   and that a message can be sent on the SAME connection without disturbing it.
6. **Preselected batch, verification on:** on the sender, pick files FIRST (the
   "Send file" button on the cross-network page, before a code exists) or share
   into Relayium from the OS share sheet, then have the receiver join. A
   confirmation bar appears naming the joiner. With no workspace open yet it must
   offer **no way to send** — only "Open workspace" — because the code it tells
   you to compare does not exist yet. Open the workspace: the files must still be
   waiting (nothing sent), a code appears in the header, and only then does Send
   appear. Press Cancel instead and confirm the files are still reachable through
   the workspace's "Send waiting files" control, which re-arms the same bar.
7. **Peer's signalling loss mid-transfer (needs two real machines):** start a
   large transfer, then kill ONLY the receiver's connection to the signalling
   server — block `wss://<host>/ws` in its network, or stop/firewall the server
   while leaving the peers' direct path alone. The transfer must **continue to
   completion** on both sides: the data channel is a different transport, and the
   sender must not tear a healthy link down because the room said the peer left.
   The sender's header should say the link can no longer be restored if it drops.
   If the transport then does die, the sender must end immediately with the
   "connection to the pairing service was lost" explanation rather than sitting
   in a recovery it cannot win.
8. **Relay credential boundary (needs real TURN, and only checkable here):** the
   client derives a deadline from the TURN username's stated expiry minus a 60s
   clock-skew margin, and warns five minutes before it. The credential TTL is
   currently a constant — `TURNCredTTL: time.Hour` in `server/main.go`, no flag
   — so this check needs a local build with that value shortened to comfortably
   more than the five-minute warning lead, so the whole sequence (live → warned
   → terminal) is observable in one sitting. Then open a relayed workspace and
   confirm (a) a warning appears about five minutes before the boundary while
   the link still works, (b) at the boundary the workspace reaches a terminal
   "start again" state **even if you touch nothing**, and (c) it never sits in
   "Connecting…" retrying with the expired credential. Automated coverage of
   this is deterministic only (`web/src/lib/mixed-link-lifecycle.test.ts`): a
   browser cannot be made to expire a real credential on demand.
9. **Legacy-link check:** open `https://<host>/cross-network#t=deadbeef` (a retired
   share-link token). Expect it to land on the normal cross-network method-selection
   page — no error, no hang.
10. **Capacity check:** with a sender + receiver already in a pairing room, open the
   same join link in a third tab. Expect it to be refused (room full).
11. **LAN regression:** open the app on two devices on the SAME network with NO
   `#c=` in the URL. Confirm they still discover each other and transfer
   (login-free), proving the LAN path is unaffected.

## Cross-network TURN relay (②b-1)

Prerequisites: a running coturn (see `docs/self-hosting.md`) and the Go server started
with matching `-turn-secret` / `-turn-urls`.

1. **STUN-only regression (no TURN configured):** start the server WITHOUT
   `-turn-secret`. `GET /api/ice?code=<valid code>` returns STUN only; an
   easy-NAT cross-network transfer still works (②a behavior).
2. **Credentials served:** with TURN configured, generate a pairing code, and in
   the browser devtools confirm `GET /api/ice?code=<code>` returns a `turn:`
   entry with a `username` (`<expiry>:<code>`) and a `credential`. The
   receiver opening the join link gets the same TURN entry.
3. **Forced-relay transfer:** to prove the coturn path end-to-end, temporarily
   set `iceTransportPolicy: "relay"` in `RTCPeerConnection` (or test between two
   genuinely symmetric-NAT networks). Complete a transfer; confirm SAS matches
   and the per-file SHA-256 integrity check passes — proving relayed bytes are
   still end-to-end encrypted.
4. **Expiry:** an `/api/ice` credential older than the TTL is rejected by coturn
   (the relay allocation fails); a fresh link/credential succeeds.

## Cross-network relay-byte metering (②b-2)

Metering is now **anonymous**: ingested relay bytes are recorded as a global total,
unattributed to any account (realtime relay sessions are authorized by a pairing
code, not a sign-in). Prerequisites: Redis running; coturn with `redis-statsdb=...`
set (a coturn config directive — see coturn's own docs; Relayium's production
coturn config lives in the private relayium-ops repo); the Go server started
with `-redis-addr <host:port>` and matching TURN flags.

1. **Metering off (regression):** start the server WITHOUT `-redis-addr`. A
   relayed transfer still works; no usage is ingested. The server logs no
   metering worker.
2. **Ingestion:** with Redis + coturn + `-redis-addr` set, generate a pairing
   code and force a relayed transfer (`iceTransportPolicy: "relay"` or symmetric
   NATs). After the transfer completes, the ingested byte total increases and is
   consistent with coturn's reported `rcvb+sentb` for that session (check
   `redis-cli psubscribe 'turn/realm/*/user/*/allocation/*/total_traffic'` while
   transferring). The recorded event carries no account attribution.
3. **Idempotency:** restarting the Go server (re-subscribing) does not double-count
   an already-recorded session (alloc_id dedup).

---

## Ephemeral encrypted text transfer `[MANUAL]`

Phase 1 of the messaging feature (spec:
`docs/superpowers/specs/2026-07-30-ephemeral-text-transfer-design.md`; wire:
`docs/protocol/relayium-text-v1.md`).

Gates 1–3 and 5–9 are browser-side; gate 4 needs two builds; gate 10 needs two
machines with the CLI. What remains in this section is what a headless harness
cannot reach: two real devices, an older build, OS notifications, a screen reader,
and two live CLI processes.

> **⚠️ Four written message scenarios never became coverage, and no longer
> exist.** `web/e2e/lan-transfer.mjs` was *written* to cover both verification
> paths — the default (`messageDefaultScenario`, advanced verification OFF:
> recipient lands straight in the composer, no accept/reject card, no SAS on
> either side) and the opt-in path (`messageScenario`, advanced verification ON:
> explicit accept/reject gate and matching SAS on both tabs), plus byte-exact
> multibyte content, literal rendering of script-like content and the
> suppressed-caps case. All four sat in that script's non-executing tail and
> never ran, locally or in CI. The script was deleted in §1a Stage 4, so they are
> not merely uncounted now — they are gone. Nothing that follows should be read
> as claiming a message-lane browser gate exists.
>
> The consent state machines and the one-SAS-per-link rule are still asserted, by
> `web/e2e/mixed-link.mjs` and `web/e2e/code-room.mjs` on the unified `link/1`
> surface, and **both** run in hosted CI as of 2026-08-29.
>
> The response race (unique #4) — a responder accepting while the initiator is
> still taking ownership of its channel — was previously described here as
> "genuinely uncovered". That is **no longer accurate**, and it is now recorded as
> retired in §1a with its evidence: the pre-attachment capture-and-replay path is
> pinned in order by `src/lib/mixed-session.test.ts` ("replays a text request
> captured before lane attachment", "fails quickly instead of replaying into a
> declined lane capture sink", "re-attaches both lanes to a replaced transport
> before replaying its capture") and `src/lib/peer-link.test.ts` ("holds an
> inbound offer and replays the frames that chased it, in order"). All of those
> run in `npm test` on every push. Deterministic coverage of the surrounding
> consent logic remains in `src/lib/verify-gates.test.ts` and
> `src/lib/MessagePanel.test.ts`.

Prerequisites: `cd web && npm run build`, then
`cd server && RELAYIUM_ADDR=:8099 go run .`, and two devices on the same LAN
reaching that host over a secure context (HTTPS, or `localhost`).

The payload used throughout, chosen so any trimming or normalisation shows:

```
  <TAB>if x:
<blank line>
<TAB><TAB>print('你好 مرحبا 🌍')
   <blank line, three leading spaces>
  trailing<3 spaces>
```

### 1. Two devices, LAN — byte fidelity

Run this on the **default** setup: advanced verification OFF on both devices (that
is the shipped default — do not turn it on here).

1. Open `/` on both devices; wait until each shows the other on the radar.
2. On device A press B's card's single action, **Open workspace**
   (`.open-workspace`). The separate **💬 Send a message** control this step used
   to name was removed with the rest of the per-card fork by `d175f863`; the
   composer is inside the workspace the action opens.

   **Expect:** the composer opens directly on **both** devices. B is shown **no
   Accept/Decline card** — there is nothing to approve — and **neither** side
   shows a SAS / verification code. Seeing either one here is a failure of the
   default path (that gated flow is section 3's opt-in scenario).
3. Paste the payload above into A's composer and press ⌘/Ctrl+Enter.

**Expect:** B renders it with indentation, the blank lines and the emoji visually
identical to A's composer — tabs shown as tabs, not collapsed to one space.
Then press **Copy** on B's message and paste into an editor: the result must be
byte-identical, including the two trailing spaces. A `diff` against a file
containing the original payload must report no differences.

### 2. Cross-network room — relay path, one SAS, ten minutes

1. On A open `/cross-network`, sign in, mint a code. Join it from B via the link.
2. **Turn on "Advanced verification" on both devices** (the workspace's *Advanced
   verification* panel) **before** opening the message session. It is OFF by
   default and no SAS would be shown otherwise; this scenario checks the SAS, so
   it is deliberately opted in on both ends.
3. Open a message session and exchange several messages over ten minutes.

**Expect:** the path badge in the message panel reads **relay** (cross-network
forces `iceTransportPolicy: "relay"`); the 6-digit verification code shown on A
and B is **identical** — and it is a different value from the 6-digit pairing
code; messages still send after ten minutes of light use, and the session
has not silently ended. Note the idle timeout is 10 minutes of **no** traffic, so
keep exchanging a message every few minutes — a session that dies while in use is
a failure.

### 3. Advanced verification opt-in — the consent gates

This section tests the **opt-in** path, so **turn on "Advanced verification" on
both devices before starting**. With the preference on, an incoming message
request stops at an explicit Accept/Decline card and both sides show a SAS; with
it off (the shipped default, exercised in section 1) **none of these gates are
expected** — the session opens straight into the composer with no card and no
code, and that is not a bug. If you see the gates below without having opted in,
or fail to see them after opting in on both devices, that is the failure.

Everything here is observable in the UI. Note that the composer only exists once a
session is **open** — there is deliberately no way to type before the peer accepts,
so this gate checks the absence of a composer rather than trying to send early.

1. From A, press **Open workspace** on B's card — the card's only action; the
   text lane opens with the workspace. **Do not accept on B yet.**
2. Inspect **B**: the card names the peer ("… wants to send you a message"), shows a
   6-digit code with the compare-on-both-devices prompt, and offers **Accept** and
   **Decline**.

   **Expect on B:** no message body anywhere in the panel, and **no composer** —
   nothing to type into, so no content can exist before consent.
3. Inspect **A**: the panel says it is waiting for the other device to accept.

   **Expect on A:** also **no composer** — A cannot type or send until B accepts.
4. Press **Decline** on B.

   **Expect:** B's panel disappears. A reports that the other device declined —
   specifically that, not a generic connection failure.
5. From A, open a session again. This time press **Accept** on B.

   **Expect:** a composer appears on **both** sides and the state reads as open.
   Send a message from A to B and another from B to A; each arrives on the other
   side. The 6-digit code is identical on both, and is a **new** code, because this
   is a new session with a new handshake.

### 4. Old peer — the compatibility case that matters most

Serve the **previous release**'s `dist/` to one device (e.g. check out the commit
before this branch, `npm run build`, and serve it on a second port), and this
branch's build to the other.

**Expect, in this order of importance:**
1. The **new** device offers the old peer **no action at all** — not a disabled
   message control, which is what this step used to describe. A peer that routes
   neither `link/1` nor `text/1` gets `<p class="pa-unsupported">`: a sentence,
   and no button.
2. The **old** device shows **no** spurious card of any kind: no failed receive, no
   0% transfer, no error banner. Check its DevTools console: no exceptions.
3. There is **nothing on the new device to start a transfer with**, and that is
   the expected result rather than a defect. The card carries no control, the
   drag affordance is withheld (`ondragover` adds `.drag` only for a routing
   peer), and a drop that lands anyway is refused with the same unsupported
   message instead of being handed to the router. The pointer shortcut on the
   card body is attached only when the peer routes `link/1`.

This step used to end with "a file transfer between the two still completes
byte-exactly in both directions, and a mid-transfer resume still works." That is
**no longer a property this build has**, and asking a tester to confirm it would
send them looking for a control that was deliberately deleted. Current behavior
is `link/1`-only: the compatibility route to a peer that cannot route it was
removed with the per-card fork (`d175f863`), not left disabled. So what point 1
and point 2 check — one honest sentence on the new device, and silence on the old
one — is the whole of this gate now. Byte-exact transfer and mid-transfer resume
are still gated, on the surface that actually has them: `web/e2e/mixed-link.mjs`'s
`byte-resume` act, in hosted CI.

**Points 1-3 are now automated too, and this manual step is kept anyway.**
`mixed-link.mjs`'s fourth scenario (C3b-9 above) asserts the same three things
against a real Chromium — one non-interactive statement, no control, no drag
affordance, a refused drop answered with that same sentence, and a quiet
suppressed peer with no console error. It has now **run on hosted `main`**:
exact-main `9d815c84`, Web run `33290357209`, `mixed-link-e2e` job
`99200800583`, success, four ledgers 20/20 + 5/5 + 4/4 + 5/5. So the hosted
scenario, not this page, is the standing executed evidence for the shape — and
the manual step stays here anyway for the one thing the automated scenario
deliberately does not claim: that a genuinely older *build* renders this way,
rather than a current build whose hello was suppressed on the wire.

### 5. Mutual exclusion — **retired, and it must not be run**

This gate used to read: start a large file transfer, then confirm the message
control is *disabled* and an inbound message offer is refused as **busy**.

That is now the description of a bug. Mutual exclusion was deliberately lifted
when both streams moved onto one handshake and one SAS: a unified `link/1`
workspace runs the file lane and the text lane **concurrently**, on one
PeerConnection, and being able to type while a file is moving is the substance of
what the unified workspace is for. A tester following the old steps would find
the composer and the attachment control both live, and would file it.

There is no manual replacement step here, deliberately — inventing one would mean
writing a gate nobody has run. The property that replaced this one is already
asserted automatically, on the real surface, and by name:
`web/e2e/mixed-link.mjs`'s `byte-identical-text` act fails if the attachment
control or the send button is disabled while the other lane is in use
("text and file intent were not simultaneously available"), and its `queued-batch`
act fails if choosing files mid-transfer disables the picker instead of queueing.

The half of the old gate that was never about exclusion — **at no point are two
different 6-digit codes on screen at once** — survives, and is stronger now,
because one link owns exactly one SAS. It is checked on every state this scenario
visits by `oneSas`, which counts every `.sas` on the page and requires the count
to be one, with zero outside the workspace header. There is nothing left for a
human to do here.

### 6. Ephemerality

1. Exchange several messages, then reload the page.
2. Open DevTools → Application → Local Storage and Session Storage.

**Expect:** history is empty after the reload. Neither storage contains any
message body — search both for a distinctive string from your payload and get zero
hits. Note the transfer history panel *is* `localStorage`-backed; messages must not
appear in it. Also confirm the composer is empty after reload (no form
restoration).

### 7. Notification

1. Grant notification permission, open a session, background the tab.
2. Have the peer send a message.

**Expect:** an OS notification naming the **sender** and containing **no part of
the message body**. A notification renders on lock screens, shared displays and
screen recordings, so a body there would leak content outside the session.

### 8. Screen reader and keyboard

With VoiceOver (macOS: ⌘F5) on the message panel:

**Expect:** each arriving message is announced **once** — not re-announced on every
re-render, and the byte counter is not announced at all as it changes.
By keyboard only: Tab reaches the composer, the send button, and every per-message
copy control, each with an audible name. In the composer, **Enter inserts a
newline and does not send**; ⌘/Ctrl+Enter sends. Focus rings are visible on every
control.

### 9. RTL — archived, not a current step

**Do not run this one.** It is kept as a record of how the message panel was
checked while Arabic was a maintained product language; it is not executable
today, and nothing was substituted for it.

The app ships two languages, `en` and `zh` (`MAINTAINED_LANGS` in
`web/scripts/pages/shared.mjs`, and the two tables under `web/src/lib/i18n/` —
the other seven live in `web/src/lib/i18n/archive/`). There is no way to put the
running SPA into Arabic: the language selector offers only the two, and
`setLang` (`web/src/lib/i18n.svelte.ts`) accepts only a loaded language. A step
that begins "switch the UI language to العربية" therefore has no first action.

> **What it used to say.** Switch the UI language to **العربية**. Expect the
> panel to mirror (controls and alignment move to the right), and a message body
> containing Latin text to still read left-to-right inside the mirrored layout —
> each body carries `dir="auto"` independently of the UI direction. Send an
> Arabic body and confirm it reads right-to-left. Neither direction may cause
> horizontal page scrolling.

**What is still true, and where it is checked instead.** `dir()` still answers
`"rtl"` for `ar`, because the archived Arabic pages under `web/public/ar/` are
still served with `dir="rtl"` — they are archived translations, not a supported
product language. That is covered automatically rather than by hand:
`src/lib/Nav.test.ts` asserts `dir("ar") === "rtl"` and pins the chevron flip,
and `scripts/pages/rtl-head-isolation.test.mjs` covers the archived pages' head.
Restoring Arabic as a maintained locale would bring this manual step back; under
the supported-language policy that is an explicit owner decision, not something
a test pass can trigger.

### 10. CLI — two live processes

Two machines with this branch's binary:
`cd server && go build -o relayium ./cmd/relayium`.

#### Minting a code

`/api/pair` requires an account, so on the minting machine run `relayium login`
first. `relayium text` with **no code** mints one, prints the hand-off, and then
joins that code's room itself as the first of its two peers:

```bash
relayium text
# Code: 483920   (valid 5 minutes)
# On the other machine:  relayium text 483920
# waiting for the other side to join…
```

**Expect:** the hand-off line says `relayium text`, never `relayium receive` —
that command would pair and then be refused by the mode check. Machine A stays in
that session; machine B joins it with the printed code, so nothing has to be
stopped and no throwaway file is involved. (`relayium send` still mints for file
transfers and still hands off `relayium receive`.)

A code room holds exactly **two** peers, so make sure the previous pair of
processes has **exited** before starting the next sub-test, and mint a fresh code
if more than five minutes have passed.

Also check the refusals, which must not spend a code:

```bash
printf 'hi' | relayium text --verify; echo "exit=$?"  # exit 2: --verify asked for a
                                                      # prompt and stdin is not a
                                                      # terminal. Names --yes as the
                                                      # way out. No code minted.
empty_config="$(mktemp -d)"
XDG_CONFIG_HOME="$empty_config" relayium text; echo "exit=$?"  # exit 1, tells you to
                                                     # log in and says
                                                     # `relayium text <code>`
rmdir "$empty_config"
```

And the case that must **not** be a refusal — verification is opt-in, so a plain
piped run is an ordinary run and needs no flag at all:

```bash
printf 'hi' | relayium text 483920   # proceeds; --yes is not required
```

#### 10a. Interactive default: no prompt

Machine A mints and waits; machine B joins the code it prints:

```bash
# machine A                        # machine B
relayium text                      relayium text 483920
```

**Expect:** the session opens straight into the message loop with **no SAS prompt
on either side** and nothing extra passed to get there — `text` opts in to
verification exactly the way `send` does. A line typed on either side appears on
the other. Ctrl-D on either side ends the session cleanly on both, with no hang and
no stack trace.

#### 10b. `--verify`: opting in to the SAS comparison

```bash
# machine A                        # machine B
relayium text --verify             relayium text 483920 --verify
```

**Expect:** both print `SAS: NNNNNN  (compare on both ends)` and **prompt for
confirmation**; the two codes match. Answer `y` on both and the session opens as in
10a. Answer `n` on either side and it ends there, with nothing sent.

Two more checks on the flag itself, neither of which changes anything on the wire:
`--verify` on **one** side only is valid (that side prompts, the other does not),
and `--yes --verify` together never prompt — `--yes` wins, so a wrapper script that
already hard-codes it cannot start blocking on a human.

#### 10c. Piped: exact bytes, including multiline

Both sides must be **non-interactive**, or the receiver frames each message as a
line and the comparison fails. Any redirected stdin qualifies — a file, a pipe or
`/dev/null` — because the terminal check asks the OS whether the descriptor is a
terminal rather than whether it is a character device:

```bash
# prepare on A
printf '  \tif x:\n\n\t\tprint("你好 🌍")\n  trailing   ' > /tmp/msg.txt

# machine A mints, sends the file as one message, and waits
relayium text < /tmp/msg.txt

# machine B joins the printed code (redirected stdin means piped mode)
relayium text 483920 < /dev/null > /tmp/got.txt

# then on B
diff /tmp/msg.txt /tmp/got.txt && echo "byte-identical"
```

**Expect:** `diff` reports no differences — the piped form adds nothing, not even a
trailing newline. Both processes exit 0 without hanging.

Two things that are correct but look odd: B's empty stdin means B sends one **empty
message** to A, which A prints as nothing; and each side half-closes when its stdin
ends, which is what lets both terminate.

Adding `--yes` to either command must change nothing here. It is kept working for
scripts written when it was required; re-run one of the two with it to confirm the
byte comparison still passes.

#### 10d. Mode mismatch: refused, and never a silent empty success

```bash
# machine A
relayium text < /dev/null
# machine B
relayium receive 483920
```

**Expect:** a **mode mismatch** error naming both commands — "the other side is
running `relayium send`/`relayium receive`, not `relayium text`" — raised **before
any TLS connection**. Both sides exit non-zero.

The critical part: B must **not** report a completed transfer of zero files, and no
file may be written in B's destination directory. A silent empty success is exactly
the failure the handshake-level mode check exists to prevent, so check B's output
and `ls` its working directory.

#### 10e. Over the limit: refused, with the alternative named

```bash
head -c 70000 /dev/zero | tr '\0' a | relayium text 483920; echo "exit=$?"
```

**Expect:** non-zero exit; an error naming the byte count (70 000) and the
65 536-byte limit, and pointing at `relayium send`. Nothing is sent — the peer sees
no message at all.
