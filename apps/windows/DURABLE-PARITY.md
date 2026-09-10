# Windows desktop client — parity with released macOS 1.3.10

**Status: FOUNDATION. Not feature complete, not released, not signed.**

The objective is a Windows client whose experience matches the released macOS
app, distributed as a direct-download EXE outside the Microsoft Store. This file
is the durable record of that whole objective. It is not a description of what
slice 1 built; every row below that is not `done` is work this task still owes.

The reference is the **shipped** macOS build, `1.3.10 (28)` — the only `<item>` in
`web/public/apps/macos/appcast.xml`. The source tree is ahead at `1.3.11 (29)`,
which is archived to internal TestFlight and not in the feed.

## What exists after slice 1

A secure Electron foundation, the real account authority, a receive path that
streams bytes into opaque staged names — publication is deliberately
unimplemented and staging is not containment, see below — the imported protocol
executing against the frozen cross-language fixtures, and a Windows CI lane that
builds an unsigned installer but **has never run**.

**There is no transfer UI.** The renderer is a foundation shell that reports
build state and drives real sign-in. It deliberately does not draw the macOS
five-row navigation over destinations that do not exist: a screenshot of an
empty shell wearing the shipped app's chrome would claim progress that has not
been made.

## Parity matrix

### How to read the status column

Four distinct states, because collapsing them is how a checkpoint reads as a
release:

* **`author-tested`** — implemented, and covered by tests the same author wrote.
  This is the strongest claim anything below carries. It is NOT acceptance.
* **`partial`** — a real slice exists and the remaining gap is named.
* **`todo`** — not started.
* **`Windows-pending`** — appended to any row whose behaviour has never been
  observed on Windows. Every row in this document currently carries it
  implicitly: see "Verification status".

No row says `done`. Nothing here has been independently reviewed and accepted,
and the reviewer has already reproduced blocking defects in three of these
subsystems during this slice.

### Transport and protocol

| Capability (macOS 1.3.10) | Status | Notes |
|---|---|---|
| Realtime wire, crypto, SAS, commit-reveal | `partial` | The shipping `web/src/lib` modules are imported and executed against `crypto-vectors.json` and `realtime-wire-vectors.json`. No live peer session yet. |
| LAN transfer (hub-backed, code-less room) | `todo` | Mac uses `AppEnvironment.makeLanDiscoveryModel` — a signalling WebSocket with an empty `code`, keyed by observed public IP. **No mDNS/Bonjour**; the iOS local-only composition is explicitly out of the baseline. |
| Cross-network pairing (6-digit code, `link/1`) | `todo` | Includes relay-pool credentials, selection, deadlines, cancel/reconnect, stale-generation fencing. |
| Stored links (upload, `#k=` fragment, streamed decrypt) | `todo` | The key must never reach the server, and must not leak into a `relayium://` argv or Windows Error Reporting. |
| Device Inbox (`receive.v3`, `text.v1`) | `todo` | **No TypeScript receiver exists to reuse** — web is the sender; the receiver is Go (CLI) and Swift/Kotlin. This is net-new work, not a port. |
| Text lane | `todo` | `TEXT_KEY_DOMAIN` is 17 bytes including the NUL; the imported module already has this right and a test pins it. |

### Account

| Capability | Status | Notes |
|---|---|---|
| Device-code sign-in (`/api/cli/device/start`, `/poll`) | `author-tested` | Bearer only. The web client's cookie session is not reusable and is not used. One account at a time: a second sign-in over a held credential is refused, and switching accounts is an explicit sign out then sign in. |
| Cancelling a sign-in | `author-tested` | Cancellation is the MAIN process's decision, named by a nonce the renderer mints before it calls `start`. A cancelled attempt cannot adopt a token, including one whose poll or whose storage write was already in flight; a compensating deletion that fails is reported rather than presented as a successful cancellation. Cancel never touches an account that is already signed in. Covered by controller unit tests, main-process barrier tests, and a real Electron run that clicks the shipped buttons — each proven to fail against the previous behaviour. |
| Sign-in expiry | `author-tested` | Enforced by the main process on actual time, re-checked after every delayed await, so a success withheld across the deadline is not adopted. The renderer's countdown is a display of the remaining time main reports, not the authority. |
| Stable installation identity | `author-tested` | 43-char RawURL, strict round-trip, survives sign-out, rides `start` and never `poll`. |
| Bearer never reaches the renderer | `author-tested` | The renderer learns *that* it is signed in, never the credential. |
| Encrypted-at-rest secrets, fail closed | `author-tested` | `safeStorage`/DPAPI. No plaintext fallback. Under `%LOCALAPPDATA%`, never Roaming. |
| Account/usage display, website management links | `todo` | Read paths only; no new billing or provider behaviour anywhere in this task. |

### Receive IO

| Capability | Status | Notes |
|---|---|---|
| Manifest validation, Windows name safety | `author-tested` | Refuses traversal, absolute, drive-relative, UNC/device, ADS, reserved names (incl. `COM¹`/`LPT²`), trailing dot/space, control characters, over-length components (255 UTF-16 **and** 1024 UTF-8). |
| Whole-manifest conflict refusal before any write | `author-tested` | Case collisions and file-versus-parent, both orderings. Zero files created when one entry is bad. |
| Bounded chunks, ordered ops, exact declared length | `author-tested` | Short OS writes are detected via `bytesWritten`. |
| Cancel closes IO and removes owned partials | `author-tested` | Cancellation is a single cached promise; every caller waits for the cleanup. |
| Account fencing across sign-in/sign-out | `author-tested` | Transitions are queued and re-check their own identity after every await. The reviewer reproduced two real defects here — a poll adopting an account through a slow lease cancel could write a bearer *after* a completed sign-out, and a cancelled sign-in could still be completed by a late poll — both fixed and covered. Neither fix has been re-reviewed independently. |
| Privileged request admission | `author-tested` | At most one outstanding device poll per attempt; overlapping calls get a bounded "no outcome yet" rather than becoming concurrent HTTP requests from the privileged process. Renderer pacing is not treated as admission control. |
| **Publish staged files to their final names** | **`todo` — REQUIRED, next slice** | See below. This is the reason no Save flow is exposed. |

### Desktop integration

| Capability | Status | Notes |
|---|---|---|
| Single instance, second-instance forwarding | `author-tested` | |
| Local renderer, sandboxed, no remote content | `author-tested` | Served from `app://relayium/`, not `file://`. |
| Sender-validated IPC, no path-bearing channel | `author-tested` | |
| Tray resident, close hides, explicit quit | `partial` | Tray and hide-to-tray work with the real brand icon. Receiving while hidden is untestable until a transfer exists. |
| Deep link `relayium://` | `partial` | A second instance forwards it and the window comes forward; routing to a destination is `todo`. Registration is the installer's job; `main.ts` also calls `setAsDefaultProtocolClient` but **only when packaged AND on Windows**, so no development run or test can seize the scheme from another app on the host. |
| Notifications without sensitive filenames | `todo` | Needs an AUMID; unpackaged Windows requires a registered shortcut. |
| Drag and drop, open/reveal in Explorer | `todo` | |
| User-controlled startup | `todo` | Must re-read state every time, never cache — Task Manager can disable it behind the app's back. |
| Update mechanism | `todo` | macOS uses Sparkle + a signed appcast. Windows has no equivalent yet; the choice (electron-updater feed vs. Android-style browser handoff) is undecided. |

### Presentation

| Capability | Status | Notes |
|---|---|---|
| Mac five-row navigation | `todo` | `lanTransfer`, `crossNetworkTransfer`, `storedSend`, `deviceInbox`, `account`. `storedReceive` is routed-only, never a sidebar row. |
| Design tokens | `partial` | 24/16/12/8/4, radius 10, 44px hit floor, 720px measure, `#6D28D9`/`#7C3AED` restated in CSS. **The Mac deliberately has no colours of its own** — it inherits macOS semantic colours that answer Increase Contrast and Reduce Transparency for free. Windows has no equivalent, so that semantic layer must be authored, and the current file is a starting point, not parity. |
| EN + zh-Hans | `todo` | Both are release requirements. Nothing is localised yet. |
| Keyboard, focus, scaling, reduced motion | `partial` | Reduced motion and focus-visible are honoured; nothing else is exercised. |

### Distribution

| Capability | Status | Notes |
|---|---|---|
| NSIS per-user installer, x64 | `todo` — **`Windows-pending`** | The workflow step exists and is written; **the Windows lane has never run.** No installer has been produced by CI, and none has been executed anywhere. |
| ARM64 | `todo` | Tracked, not built. |
| Authenticode signing | `todo` | No certificate is provisioned, and no credential action is authorized in this task. Unsigned is expected to cause SmartScreen friction; that has not been measured and is not claimed. An **unsigned private candidate for owner testing is permitted** — signing gates public release, not an internal build. |
| Public download surface | `todo` — **deliberately not touched** | `web/src/lib/apps-claim-rules.ts` currently bans claiming a Windows app exists, and that ban is correct while none does. The conditions for lifting it are the owner's to set; this document does not invent them. |

## The one thing that is refused rather than approximated

`ReceiveLease.publish()` throws `publish-unsupported`. Staged bytes are complete
and verified; moving them to their final names is not implemented, because doing
it correctly on Windows needs two guarantees Node's API cannot give:

* **no-replace creation** — `fs.rename` silently overwrites, and an `lstat`
  check before it is a race, not a guarantee;
* **containment that survives a directory being swapped mid-operation** — for
  the staging root and every ancestor, not only the final names.

Shipping `fs.rename` behind a reassuring name would be an overwrite bug wearing a
safe label, so it is absent instead.

### A cancelled device code is abandoned, not revoked

The server exposes `POST /api/cli/device/start`, `POST /api/cli/device/poll` and
a session-authenticated `POST /api/cli/device/approve`
(`server/account/handlers.go`). There is no unauthenticated deny, so a client
cannot revoke a device code it has stopped wanting.

Cancelling therefore means: this client will never poll that code again, the
main process refuses to adopt any outcome for it, and the server expires it on
its own schedule. If the user approves the page *after* cancelling, the server
mints a token nobody collects. No credential reaches this machine either way,
so nothing is lost — but "cancelled" must not be read as "revoked". Adding a
deny endpoint is server work and was not in this task's scope.

### The residual that exists TODAY, before publish is reached

Two statements about the current staging path were previously recorded more
favourably than the code supports. Corrected here, because the wrong version
would let a later reader treat this slice as safer than it is:

* **Staging is origin control, not containment.** It keeps manifest-derived
  filenames off the disk during streaming — there is no attacker-supplied name
  for a junction, symlink, reserved device name or case collision to act on. It
  does **not** confine writes to a directory tree. Every path is a resolved
  string, the `realpath` check at `open` is true only at that instant, and the
  staging root and each of its ancestors can be renamed or swapped afterwards by
  another process on the machine. Writes would follow the swap.
* **Only file descriptors are pinned.** A checkpoint previously described the
  lease as "descriptor-pinned" in a way that read as covering the path. It does
  not. `cancel()` removes the staging directory by resolving a string, so an
  ancestor swapped between the check and the removal redirects it.

Both are removed by the same native helper below — handle-relative opens against
a pinned ancestor chain — and by nothing short of it. They are not mitigated by
staging, and no test in this slice asserts otherwise.

This is the **next slice of this task**, not an unsupported feature and not a
disabled control: no Save flow is exposed at all, so nothing in the UI advertises
a capability that is missing.

**The plan:** a Go helper
under `apps/windows/native`. `golang.org/x/sys/windows` (already pinned at
v0.47.0 in `server/go.mod`) exports `NtCreateFile` and `NtSetInformationFile`,
which give handle-relative creation via `RootDirectory` in `OBJECT_ATTRIBUTES`,
`FILE_CREATE` disposition for no-replace, and `FILE_OPEN_REPARSE_POINT` to refuse
following a junction. That is no new language and no Electron ABI coupling, it
cross-builds, and it can be tested on a real Windows runner in this lane. The
upstream rename helpers must NOT be copied: they use replace-if-exists and POSIX
semantics, and this app requires the opposite.

## Verification status

Distinguish four things, and do not let a later reader collapse them:

1. **Implemented** — the code exists.
2. **Author-tested** — 196 unit/conformance assertions and one real Electron
   smoke pass, all written by the implementer. Executed on **macOS only**. No
   Linux run has happened and none is claimed.
3. **Independently accepted, for the sign-in lifecycle only** — the reviewer has
   independently re-run `check`, `build`, the 196 unit tests and the real
   Electron smoke on macOS under Node 24, all exit 0, and separately composed
   the actual `SignInController` against the actual `AppService` with a real
   temporary `SecretStore` and test cipher — no mocked lifecycle — obtaining two
   passes: a success withheld until after cancellation, and the main process's
   own deadline, each leaving the shell signed out with no bearer stored and no
   timer left armed. The frozen source hashes matched.

   That acceptance is **bounded to the foundation's sign-in cancellation
   behaviour**. It is not acceptance of the Windows client, of native receive
   IO, or of any row in the matrices above beyond that behaviour.

   Earlier in this slice the reviewer independently reproduced blocking defects
   in the receive lease, the secret store, the IPC origin check and the account
   service. Those fixes are covered by tests and were re-run by the reviewer;
   everything outside the sign-in lifecycle nevertheless remains
   `author-tested`, not independently accepted.
4. **Windows runtime** — *nothing*. The `windows` lane has never executed. Cross-
   building and a macOS-hosted Electron boot prove the artifact compiles and the
   app starts; they prove nothing about the folder picker, DPAPI, the tray, the
   deep link, the installer, upgrade behaviour or SmartScreen. No installer has
   been produced and none has been run anywhere.

No row above may move past `author-tested` on macOS evidence, and none may reach
`done` until it has been both independently accepted and observed on Windows.
The sign-in acceptance in (3) is macOS evidence about a lifecycle; it does not
move any row to `done`, and it says nothing about containment — the staging
path's ancestor-swap exposure and the unsupported publication above are
unchanged, and remain the native helper's to remove.
