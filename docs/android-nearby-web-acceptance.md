# Android ↔ the real Web, in the code-less room

One command:

```sh
JAVA_HOME=... ANDROID_HOME=... ./scripts/android-nearby-web-acceptance.sh <serial>
```

It starts a throwaway Go server, builds and serves the real Web bundle, installs
the debug APK and its instrumentation on one Android instance, opens **three**
independent browser devices in the same code-less room, and judges the round
from what the two halves independently observed.

---

## 1. Why this lane exists

Four lanes reach the browser or a second implementation, and each proves
something the others structurally cannot:

| lane | rendezvous | second endpoint | what only it shows |
|---|---|---|---|
| `android-nearby-acceptance.sh` | NSD (direct) or the hub | a second Android | both directions, both roles, no server at all on the direct path |
| `android-nearby-apple-acceptance.sh` | Bonjour | the shipped Apple modules | this build's wire read by an independently written client |
| `android-interop-acceptance.sh` | a pairing **code** | a real browser | the browser wire, cancel/retry, multi-batch |
| **this one** | the **code-less room** | **three** real browsers | the phone **choosing one device out of several**, in both directions |

Two copies of one implementation agree perfectly, so the two-Android lane cannot
see a disagreement with the browser. The pairing-code lane has no device list at
all — there is nothing to choose between. The Apple lane has one candidate and
one direction. **"The user's chosen device, out of several" is only testable
here.**

## 2. What the round does

1. The phone opens the Nearby destination and starts **"Search through
   relayium.com"** — the code-less room, a WebSocket rendezvous the server keys
   by the address it observes. It publishes the name it joined under.
2. Three browser tabs join the same room as three **independent devices** and
   wait. The decoys join first; the target joins **last**.
3. The phone waits until all three are listed, records the order the model
   offers and the order the screen shows, and **taps the Connect button of the
   target's own row**.
4. One `link/1` session, one six-digit SAS, compared on both sides.
5. The conversation opens. **The shipped Web opens the text lane by itself**,
   once per authenticated mixed link (`App.svelte`'s `textOpener`), so the phone
   is usually answering an `INCOMING_REQUEST` rather than asking — it taps the
   real **Accept** control, and only requests the lane when the state is `IDLE`.
   Then each side sends a message through its real composer.

   Two facts about the shipped components make this the only correct shape, and
   both were learned from a failed owning run rather than from reading:

   * an unconditional `requestText()` on the phone leaves an already-pending
     incoming request unanswered — `requestText` does not accept one — and both
     endpoints wait forever;
   * `MessagePanel.svelte` renders the composer when `composing` is true, which
     in the unified workspace is `open || connecting || waitingAccept`, while
     `canSend` requires `status === "open"`. **The textarea existing is not the
     lane being open.** Every send in the browser half is therefore one
     non-blocking attempt per tick, never a wait — a wait there starves the same
     loop that answers the consent card which opens the lane.
6. The phone sends an in-band ready; the browser attaches **one batch of three
   files** through the real `.attach-file` input; the phone answers with the
   real folder picker and verifies every file by path, size and digest.
7. The phone sends **two batches** through the real DocumentsUI file picker; the
   browser answers its **file consent card** for each and verifies both by name,
   size and digest.
8. Both halves reach the **transfer barrier**, then the phone disconnects and
   confirms all three browsers are still listed, then both reach the **room
   barrier**, then the phone stops Nearby.

## 3. The invariants, and where each is enforced

| invariant | enforced |
|---|---|
| the run cannot reach production | the phone compares its own resolved origin against the one the launcher set; the oracle requires `http://10.0.2.2:` |
| three real devices, not three tabs of one | each tab overrides `relayium.lan.seed`; the browser half fails if the server hands two of them one id |
| the browsers see the phone under its **actual** name | the name is read from the device's own early report; matched with `===`, never `includes` |
| ≥3 candidates | phone asserts, oracle re-checks |
| the target is **not first** | in the model order **and** in the on-screen order, read from the semantics tree's geometry; either being index 0 fails |
| the target joined **last** | browser records `joinOrder`; oracle checks |
| the selection went through the **UI binding** | the tap matches the Connect button that is a *sibling* of the target's name, never `viewModel.connectToPeer` |
| the phone connected to the row it tapped | `nearby.selectedId` compared to that row's id, and to the named target's id |
| the two halves mean the **same device** | the phone's `targetId` must equal the target browser's own `selfId` — one room, one id namespace, and neither half can produce that agreement alone |
| **no decoy was dialled** | latched for the whole run, at the wire (inbound non-benign `signal` frames) and in the DOM (a `MutationObserver`, so a card that appeared and vanished still counts) |
| a decoy's zeroes are not vacuous | the same latch counts the **chooser surface** (`.radar` / `.peerlink`), which every page in the room renders while it has no workspace. Checked as a **precondition** before the transfer starts *and* re-checked over the whole interval; zero means the latch never looked, and that fails. Deliberately **not** `.open-workspace`: `App.svelte` renders a peer card only for `selectedPeer`, and selection is automatic only when there is exactly **one** visible peer — so with three peers a page sits in radar mode showing no card at all |
| one authenticated link | `wire == LINK`, SAS present, exactly six digits, equal on both sides |
| a consent prompt was really answered | by whichever endpoint was actually offered one. The shipped Web opens the text lane by itself, so on an ordinary round the **phone** holds the prompt and the browser correctly never sees one. The phone reports its own negotiation (prompts counted as *edges* into `INCOMING_REQUEST`, accepted prompts, raw clicks, and whether OPEN followed an accept); the oracle requires one genuine acceptance, requires the non-answering side to account for it, and fails when **neither** answered. Counts and decisions are read through strict typed readers, because in Python `True` is an `int` and would satisfy any naive count check |
| text arrived, not echoed | the browser reads only `.msg:not(.out) .msg-body`; both bodies compared by **equality**, including whitespace and non-ASCII |
| files arrived, per file | name, path, size and SHA-256 bound to the **same record** at each receiver; an extra or missing save fails |
| the pickers did not end the session | link and room ids compared across every picker round trip |
| neither half tore down early | two barriers, `released` required in both reports |
| the room survived its own transfer | all three browser names still listed after the disconnect |

## 4. The fixtures

Generated on all three sides from one rule — `(i * 31 + seed) % 251` — and
compared by digest, so a drift between the implementations is a failed round
rather than a silent pass. Nothing large travels as an argument: a 300 KiB body
as hex is 614 400 characters in one argv entry, past `MAX_ARG_STRLEN`, and it
surfaces as an unrelated `am` usage error rather than as anything about size.

| direction | file | size | why |
|---|---|---|---|
| phone → browser | `android-large.bin` | 307 200 | crosses the 192 KiB logical fragment boundary |
| phone → browser | `android-zero.bin` | 0 | no CHUNK at all; completes on DONE |
| browser → phone | `web-large.bin` | 307 200 | same boundary, other direction |
| browser → phone | `web-zero.bin` | 0 | same |
| browser → phone | `外层 目录/内层/файл-测试.bin` | 1 234 | a **nested, non-ASCII** path with a space in a directory name |

Text carries different whitespace in each direction on purpose: the browser's
body has a tab and a trailing newline (a textarea's value is set
programmatically and survives byte for byte); the phone's has leading spaces and
non-ASCII but no trailing whitespace, because it is typed into a real Compose
field and this round is not the place to discover what an IME does with a
trailing tab.

Everything whitespace-significant or non-ASCII travels **hex-encoded** to the
device or in a **file** to the browser. `adb shell` re-joins argv into one remote
command line, so host-side quoting does not survive it.

## 5. The negative control

```sh
RELAYIUM_NEARBY_WEB_NEGATIVE=wrong-selection ./scripts/android-nearby-web-acceptance.sh <serial>
```

The phone taps the **first** row instead of the named target. The run must then
FAIL, and the script reports success only if it did. An acceptance whose central
invariant cannot be made to fail is evidence of nothing.

"The round failed" is **not** the claim. A crash, a missing runner, an APK that
never built and a plain timeout all make a round fail, and none of them says
anything about whether a wrong selection is detectable — a control built on that
would always hold. So the control is counted as *held* only when a second,
typed judge (`--counterpart web-negative`) confirms all of:

* both halves wrote their observations at all;
* the phone listed three candidates and recorded both orders;
* it tapped the **first row on screen**, and that row is a decoy;
* it **connected**, and to a decoy — the target-vs-selected assertion was
  actually reached;
* the browser half **independently** saw that same decoy dialled or rendering a
  session, latched across the run;
* and neither half reported a pass.

Anything else is reported as **INCONCLUSIVE**, not as held. The judgement is
reproduced in the transcript, because a held control is a *successful* run and
`lib/local-acceptance.sh` removes the per-run root on success — set
`RELAYIUM_NEARBY_WEB_ARTIFACTS` to keep the reports and logs.

Two more negative controls run with no device, no browser and no server, and are
part of an ordinary edit-time check:

```sh
python3 scripts/test/android-nearby-oracle.py --selftest
( cd web && node e2e/android-nearby-hub.mjs --self-check )
```

The first builds one clean report set the oracle must accept, then mutates it one
field at a time — including fields it **deletes** rather than falsifies — and
requires every mutation to be rejected. The second composes and **runs** every
script the browser half injects into a page: the name override, the roster
observer, the DOM latch, and the dial classifier the whole decoy claim rests on
(a caps or rename broadcast is not a dial; an offer, and anything unrecognised,
is). The launcher runs it as a preflight, before the builds.

## 5a. Verified

Both gates have been run by the acceptance owner on a real emulator (`5580`) and
a real headless Chrome against a real throwaway server. The figures below are
read from the runs' own reports, not from this document.

**Positive** — `owning-v5-artifacts/f2e5e884`, exit 0 in 33.5s, one native test
PASS, browser half exit 0, typed judge PASS:

| observation | value |
|---|---|
| candidates listed by the phone | 3 |
| model order · on-screen order | `decoy-01, decoy-02, target-zz` (identical) |
| row tapped · peer connected to | `target-zz` · `target-zz` (`c86890c3…`, and the browser reports the same id for itself) |
| SAS, both sides | `858924` |
| wire | `LINK` |
| text negotiation | Web opened the lane; the phone saw 1 prompt, accepted 1, reached OPEN |
| files phone → browser | `android-large.bin` 307 200 B, `android-zero.bin` 0 B |
| files browser → phone | `web-large.bin` 307 200 B, `web-zero.bin` 0 B, `外层 目录/内层/файл-测试.bin` 1 234 B |
| real picker · session survived it | yes · yes |
| decoys | both `dialFrames 0`, no workspace, no panel; ~70 latch ticks each |
| room after the transfer | all three browser devices still listed |
| both barriers, both halves | `released` |

Two details in that run are worth keeping. Every observer proved itself live
*before* the transfer (`readiness` 8–12 ticks each). And `latchPeerCard` was
**2 for decoy-01 and 0 for decoy-02** — the ordering-dependent asymmetry that
made an earlier `.open-workspace`-based anti-vacuity check fail, now recorded as
an observation rather than an assertion.

**Negative** (`RELAYIUM_NEARBY_WEB_NEGATIVE=wrong-selection`) —
`owning-v5-negative-artifacts/4ab21cfc`, exit 0, **HELD** on typed evidence:

* the phone tapped the first row (`decoy-01`) and connected to it — its own
  named-target comparison failed with `expected 0a155322… but was 874c5057…`;
* the browser's sticky latch corroborated it from the other side:
  `decoy-01 dialFrames 3, everHead true`, while `decoy-02` stayed at 0;
* the ordinary positive judge rejected the run, and the negative judge accepted
  it as held.

That run takes ~435s, against ~33s for the positive. It is **cost, not a
defect**: the browser half correctly waits out its bound for a workspace the
phone is never going to open, which is exactly the state a wrong selection
produces. It is not worth reworking a passing runner to shorten.

## 6. What a green run does **not** prove

* **Not a physical phone.** An emulator and a headless Chrome are not devices
  people own.
* **The hub room only.** The direct (NSD) path is `android-nearby-acceptance.sh`
  and shares none of this evidence.
* **Two stubs, both OS dialogs a headless run cannot answer.** Save-as is
  replaced by a per-save ledger that records the bytes the page **decrypted** —
  it does not produce them, and no receipt is injected. `webkitRelativePath` is
  defined on the File objects handed to the real `.attach-file` input, because a
  folder pick is the only way a browser learns a relative path; the bytes, the
  input, the handler and the wire are the product's own, and the round fails
  closed if the property did not take. Both are documented at the head of
  `web/e2e/android-nearby-hub.mjs`.
* **One nested path, one direction.** An Android send goes through
  `ACTION_OPEN_DOCUMENT`, which yields a document and no relative path at all, so
  the nested-path claim is browser → phone only.
* **One role assignment, by chance.** `linkRole` gives the offer to the smaller
  id, and which id is smaller has nothing to do with who pressed Connect.
* **One text-lane initiation, by design.** On an ordinary round the shipped Web
  opens the lane, so the phone is the endpoint that answers a consent prompt.
  The judge accepts the other direction and a genuine collision, and the
  self-test exercises all three — but a green run here has only *observed* the
  first.
* **One emulator, one browser profile, one machine.** Everything is loopback:
  no real network path, no NAT, no mDNS, no second physical device.
* **Not a soak.** One round per invocation; nothing here says anything about
  repeated sessions, long-lived rooms or memory over time.

## 7. Requirements and knobs

* `ANDROID_HOME` or `ANDROID_SDK_ROOT` (for `adb`), a JDK for Gradle, the Go
  toolchain, Node, and **`npm ci` already run in `web/`** — the launcher refuses
  to start without `web/node_modules/.bin/vite`, because `npx vite build` on a
  tree with no `node_modules` fetches a different vite over the network in the
  middle of an acceptance.
* `RELAYIUM_NEARBY_WEB_REAL_PICKER=0` replaces both DocumentsUI round trips with
  direct view-model calls. It is an explicit opt-out, the report records which
  path ran, and the oracle refuses a run that took the shortcut without being
  told to.
* `RELAYIUM_NEARBY_WEB_ARTIFACTS=<dir>` copies the reports, logs, expectations,
  fixtures and barrier markers to `<dir>/<run-tag>/` on **every** exit path,
  including an interrupt. The phone's report is captured **before** the
  force-stop on every path and validated as JSON first — the instrumentation
  writes it from a `finally`, so a *failed* round produces one too, and that
  partial is the most valuable thing a failed round has. A judging path that
  returned early would otherwise discard it, and an unchecked redirect would
  store `run-as`'s own error text under the name of a report. Without it, `lib/local-acceptance.sh` removes the
  per-run root on success — so a passing round and a held negative control both
  leave nothing behind. An explicit allowlist, not the whole root: the server
  binary, its database and its blob directory are not evidence.
* `RELAYIUM_GRADLE`, `RELAYIUM_NODE` override the toolchain binaries.
  `RELAYIUM_NODE` is used for the bundle build too — through
  `node_modules/vite/bin/vite.js` rather than the `.bin/vite` shebang, which
  would pick up whatever `node` is on `PATH`.
* **The device's `debug.relayium.backend` is read before it is overridden and
  the exact original is put back on exit** — not cleared. Three rules, each of
  which has been got wrong once:
  * *Clearing is not restoring.* A device already pointed at someone's staging
    server would be silently reset, and the next run of anything on it would
    resolve somewhere nobody chose.
  * *A run that never overrode it must not touch it.* The cleanup runs on every
    exit path, including a preflight or build failure long before the capture,
    so the restore is gated on having actually performed the override.
  * *One already-quoted remote command, or none.* `adb shell` re-joins its argv
    into a single remote command line, so a value assembled from fragments can
    split or execute. The capture builds one `shlex.quote`d command; a value it
    cannot represent faithfully (a control character, non-UTF-8) makes the run
    **refuse to override at all**, leaving the property exactly as it was.
    Exactly one line terminator is stripped, so a value that genuinely ended in
    whitespace keeps it.

## 8. The files

| file | role |
|---|---|
| `scripts/android-nearby-web-acceptance.sh` | the launcher: server, bundle, APKs, fixtures, both halves, both barriers, cleanup |
| `apps/android/app/src/androidTest/.../nearby/NearbyWebCounterpartTest.kt` | the Android half, driving the shipped app |
| `web/e2e/android-nearby-hub.mjs` | the browser half: three owned devices, one owned Chrome |
| `scripts/test/android-nearby-oracle.py` | `--counterpart web`, plus `--selftest` |
| `scripts/test/android-policy-test.mjs` | the source-level guards that keep the invariants above from being quietly weakened |
