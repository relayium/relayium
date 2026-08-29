# Relayium Web MVP — Manual Acceptance Procedure

This document is the repeatable acceptance script for spec §7 criteria 1–6.

Accessibility has its own procedure — automated coverage plus a screen-reader
matrix that no headless check can stand in for: **[TESTING-accessibility.md](TESTING-accessibility.md)**.

**Execution status key:**
- `[AUTOMATED]` — actually executed in CI / this session; output captured.
- `[MANUAL]` — requires two real browsers/devices and a real network; cannot run headless.
- `[NOT RUN]` — written, but not currently executing anywhere. Not coverage. See §1a
  for the one live instance of this: the tail of `web/e2e/lan-transfer.mjs`.

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

## 1a. `web/e2e/lan-transfer.mjs` — local only, and currently red

`npm run test:e2e` is the broadest headless suite in the repository, it is **not
a CI gate**, and as of 2026-08-29 it **cannot exit zero**. Both halves of that
matter; take them in order.

### It is not a CI gate

`.github/workflows/web.yml` runs seven hosted browser lanes, and `lan-transfer.mjs`
is not one of them:

| Lane | Script | Job |
|---|---|---|
| Accessibility scan of the built `dist` | `test:a11y` | `test` |
| Page-shell contracts (auth landing, `/apps`, `/pricing`, unsupported layout) | `test:e2e:page-shell` | `test` |
| Pairing-code room, unified workspace | `test:e2e:code-room` | `test` |
| Device-discovery findability journey | `test:device-discovery` | `test` |
| Device Inbox entry journey | `test:device-inbox-entry` | `test` |
| Device Inbox: browser → server → CLI → disk | `test:device-inbox` | `device-inbox-e2e` |
| LAN room, unified `link/1` workspace, real Go server | `test:e2e:mixed` | `mixed-link-e2e` |

The last row is new as of 2026-08-29 (Phase 3D C3a). It is a separate job rather
than another step in `test` because it needs a Go toolchain that Node-only job
does not have, and because `test` already spends most of a 15-minute budget on
four browser lanes.

Getting it hosted required fixing what made it un-hostable: it used to demand
that a human had already started a server on `:8098`. `mixed-link.mjs` now
builds and starts its own, on its own port, over its own temporary database, and
tears the whole thing down — see `web/e2e/go-server.mjs`, the lifecycle it now
shares with `test:device-inbox`. An explicit `--url` still targets a server you
started yourself; without one, nothing external is required.

`test:e2e` (`lan-transfer.mjs`) appears in none of them. As of 2026-08-29
(Phase 3D C2) the `/apps` hierarchy contract, along with the auth-landing and
`/pricing` page contracts and the insecure-context layout contract, moved out of
`lan-transfer.mjs` into `web/e2e/page-shell.mjs` — the `test:e2e:page-shell` row
above — so those four **are** now executed by every push and pull request.
Nothing else in `lan-transfer.mjs` is:

```bash
cd web && npm run build && npm run test:e2e
# Today: the run fails immediately. mobileRelayFallbackScenario — now main()'s
# first call, since the four page contracts that used to run ahead of it moved
# out — drives the same removed .file-pick-input control described below, so no
# scenario prints "ok" before the run dies.
```

### Why it stops in the tail

Commit `d175f863` ("Remove legacy Mac and Web transfer paths", 2026-08-27) deleted
the legacy per-peer transfer controls from `web/src/App.svelte`: the `.pa-files`
label wrapping a hidden `.file-pick-input`, and the file / folder / message fork
beside it. A peer card now renders exactly **one** control — `.open-workspace` —
and only for a peer that routes `link/1`. A peer that does not gets
`<p class="pa-unsupported">`: a sentence, not a disabled button.

`lan-transfer.mjs` is built on the opposite premise. `main()` calls
`setDefaultInit(STRIP_LINK_CAP)` before opening the first tab, so **every** tab in
the suite presents as a legacy `text/1`-only peer — and the scenarios then drive
the fork that such a peer used to be given. That fork no longer exists, so those
scenarios address elements the component does not render.

What that leaves, now that the four single-tab page contracts have moved to
`web/e2e/page-shell.mjs` (see Stage 1 below):

- **Executed and passing — nowhere in this file anymore.** The three that used to
  pass here (`authLandingScenario`, `appsHierarchyScenario`,
  `pricingHierarchyScenario`) moved out entirely, and `unsupportedLayoutScenario`
  moved with them (it never depended on anything removed; it only ever failed to
  run here because of ordering, not content — see Stage 1). None of the four is
  in `lan-transfer.mjs` any longer, executed or not.
- **Not executed** — everything, starting from `mobileRelayFallbackScenario`,
  which is now `main()`'s first call. It drives a removed control
  (`web/e2e/lan-transfer.mjs:1420` picks up `.file-pick-input`, which now resolves
  to `null`), and the run does not get past it. The main LAN transfer act and every
  scenario after it — small-message-cap, transfer-boundary, early-failure,
  mobile-no-picker, desktop-picker-cancel, resume, the four message scenarios,
  multi-page-device and caps-suppressed — are downstream of that point and
  currently produce no signal at all.

So `lan-transfer.mjs` itself proves nothing today: `[NOT RUN]` end to end. The
four page contracts it used to carry are `[AUTOMATED]` in their new home,
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

What the audit found genuinely stranded is **exactly eight** current unique
assertions, held nowhere else:

| # | Stranded unique assertion |
|---|---|
| 1 | Mobile no-picker fallback (no `showSaveFilePicker`) |
| 2 | Desktop save-picker cancellation |
| 3 | 64 KiB max-message-size boundary |
| 4 | Response race (responder accepts while the initiator is still taking ownership) |
| 5 | Pre-open PeerConnection failure (`failed` before the DataChannel opens) |
| 6 | Live `role="progressbar"` accessibility during an in-flight transfer |
| 7 | Multi-page device identity and focus (two pages of one browser plus a third device) |
| 8 | Bounded relay-pool failure (credentials issued from the pool, then discarded) |

Those eight are the actual regression exposure, and they are what the migration
below has to carry across. Everything else in the tail can be retired rather than
ported, because a hosted suite already asserts it.

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

**Stage 2 — the transfer uniques move into `mixed-link.mjs`, and `mixed-link`
becomes hosted.** Uniques 1–6 above are about the real pipeline (commit-reveal,
chunked AES-GCM, ACK flow control, checkpoint resume, consent), not about the
retired fork. They come off `STRIP_LINK_CAP` and onto the unified `link/1`
workspace — `.open-workspace`, then the workspace's own composer and
`.attach-file` / `.attach-folder`. `mixed-link.mjs` already drives exactly that
surface. Migrating uniques into a suite nobody runs would move the problem
rather than fix it, so hosting `mixed-link` came first and is **done** (C3a,
2026-08-29): the `mixed-link-e2e` job above runs its existing single scenario on
every push and pull request. Moving the six uniques onto it is C3b, and it
starts from a baseline that is green and hosted rather than from a suite whose
own queued-batch assertion had been stale for weeks.

**Stage 3 — identity and bounded relay failure.** Uniques 7 and 8 are last
because both need setup the other stages do not: multi-page device identity needs
a third independent context alongside two pages of one browser, and bounded
relay-pool failure needs the pool-shaped `/api/ice` response plus an unreachable
TURN host and a probe budget that actually elapses.

**Stage 4 — delete `lan-transfer.mjs` and its `test:e2e` npm script.** Only after
the hosted `main` is green with stages 1–3 landed. Deleting earlier would drop the
eight uniques; keeping it after is worse than useless — a script that cannot exit
zero teaches everyone to ignore a red run.

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
- **Written but not executing** — `capsSuppressedScenario` was designed to assert
  the observer-side shape in a real browser (a peer that never announces caps is
  offered no control, and the old peer sees no spurious card). It is the **last**
  scenario in `main()`, so it sits deepest in the non-executing tail described
  above and does not run today, locally or in CI.

So the source-level half is guarded and the rendered half is not. That gap is
narrow — the source guard makes it structurally hard for a legacy transport to
come back — but it is a gap, and unique #7 and the browser-side unsupported-peer
shape are both waiting on the stage-3 migration. Nothing there needs a legacy
transfer to be performed, because there is no longer a legacy transfer to perform.

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
7. On **device A**, drag `testfile.bin` onto device B's card, or click the card and pick it.
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

1. On **device A**, drag 2–10 files onto device B's card (or click and multi-select).
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

> **⚠️ The automated half of the messaging gates is not currently running.**
> `web/e2e/lan-transfer.mjs` was *written* to cover both verification paths — the
> default (`messageDefaultScenario`, advanced verification OFF: recipient lands
> straight in the composer, no accept/reject card, no SAS on either side) and the
> opt-in path (`messageScenario`, advanced verification ON: explicit accept/reject
> gate and matching SAS on both tabs), plus byte-exact multibyte content, literal
> rendering of script-like content and the suppressed-caps case. All four message
> scenarios sit in that script's **non-executing tail** (§1a), so none of them runs
> today, locally or in CI. Do not count them as coverage.
>
> The consent state machines and the one-SAS-per-link rule are still asserted, by
> `web/e2e/mixed-link.mjs` and `web/e2e/code-room.mjs` on the unified `link/1`
> surface, and **both** run in hosted CI as of 2026-08-29. What is genuinely uncovered until the
> §1a migration lands is the response race (unique #4) — a responder accepting
> while the initiator is still taking ownership of its channel. Deterministic
> coverage of the surrounding logic remains in `src/lib/verify-gates.test.ts` and
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
2. On device A press **💬 Send a message** on B's card.

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

1. From A, press the message control on B's card. **Do not accept on B yet.**
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
1. The **new** device offers **no** message control for the old peer — it never
   announced `text/1`.
2. The **old** device shows **no** spurious card of any kind: no failed receive, no
   0% transfer, no error banner. Check its DevTools console: no exceptions.
3. A **file** transfer between the two still completes byte-exactly in both
   directions, and a mid-transfer resume still works.

Point 3 is the one that would matter most if it broke, because the file path is
what people already depend on.

### 5. Mutual exclusion

1. Start a large file transfer from A to B and accept it on B.
2. While it is running, on A press the message control for B (if enabled) and on B
   try the same toward A.

**Expect:** the message control is disabled while a transfer is in flight, and any
inbound message offer is refused as **busy** rather than opening a session. At no
point are **two different 6-digit codes** on screen at once — that is the specific
confusion the exclusion exists to prevent.

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
