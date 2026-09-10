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
has run once (34448645493) and packaged an unsigned installer — **which has
never been executed, on any machine**.

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

No row says `done`. The foundation at `b7d65457d` has been independently
reviewed and accepted as bounded foundation behaviour; see "Verification status"
(3) for what that covers. Nothing in the Distribution matrix is included, and
the installation-destination guard is newer than that review.

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
| NSIS per-user installer, x64 | `todo` — **`Windows-pending`** | Run 34448645493 packaged one, and the reviewer verified its hash and PE header. **No installer has been executed anywhere yet.** The automated installed-artifact acceptance (`test/smoke/installed-acceptance.mjs`) is implemented and has never run: it is Windows-only and fails closed elsewhere. |
| Installation destination guard | `implemented` — **`Windows-pending`**, newer than the foundation review | `allowToChangeInstallationDirectory: true` otherwise permits a destination whose removal takes the installation identity, account bearer and Inbox private key with it. **Primary guard, `assets/installer.nsh`:** refuses a destination equal to, enclosing, or enclosed by `%LOCALAPPDATA%\Relayium`, before extraction and before the old version is uninstalled. Both sides are resolved through the filesystem with `GetFinalPathNameByHandleW` / `VOLUME_NAME_GUID`, on every call and with no cached verdict, so junctions, symlinks, `subst`, mount points, 8.3 aliases and `..` spellings collapse before comparison; resolution climbs to the nearest existing ancestor and re-appends the tail that does not exist yet, with lengths bounded *before* each concatenation because NSIS `StrCpy` truncates silently. **Fail closed:** no raw-spelling fallback, no GUID-against-DOS compare; unresolvable paths, over-capacity buffers and access-denied on an ancestor are refusals. UNC is rejected syntactically before any filesystem or network call; network installs are **explicitly unsupported**. Exit codes 2 collision, 3 unverifiable. **Second, weaker guard, `storage.ts`:** refuses the matching runtime writes, but `fs.realpathSync.native` resolves with `VOLUME_NAME_DOS` (verified in libuv 1.52.1 `deps/uv/src/win/fs.c` as bundled by Node 24.20.0), **not** volume GUIDs — so it collapses junctions, symlinks, mount points, 8.3 and `subst`, but **cannot reliably compare one volume reached through two DOS mount points**. That gap is asserted by a test rather than left as prose, and the installer guard is what covers it. **Coverage, stated honestly:** `customInit` validates the destination the run starts with including `/D=`; `.onVerifyInstDir` validates every destination chosen on the directory page. There is **no install-section gate** — `customInstall` runs after `uninstallOldVersion` and after extraction, so it could not protect anything; the earliest pre-extraction hook, `customCheckAppRunning`, is deliberately not used: it replaces the running-app check rather than extending it, suppresses the `getProcessInfo.nsh` include and `Var pid` that the replaced macro needs, and is inserted by `uninstaller.nsh` too — so a collision check wired there could refuse an uninstall, which is a worse failure than the one being prevented. **Residual: TOCTOU** between the last check and extraction, same Windows account. Test scope: 31 unit cases, 9 of which fail against the previous lexical guard, plus over-refusal regressions; on Windows, junction and `subst` negatives and positives against task-owned directories with a same-drive control. **The NSIS half has still never executed on Windows** — it now compiles, which it did not before. The enclosing-parent destination is deliberately never executed, because a broken guard would then destroy unowned state. |
| ARM64 | `todo` | Tracked, not built. |
| Native receive helper (`apps/windows/native`) | `todo` — **not accepted** | Authored in a separate lane and under independent review; its Windows runtime result is pending. A CI job now runs its tests and build on a real Windows runner, with `go test -v` so that every `--- PASS/FAIL/SKIP` line is in the hosted log: a run whose junction, retarget and real-helper-subprocess cases all SKIPPED still exits 0, and exit 0 with critical skips is not acceptance. That job existing is not acceptance either. The helper **is** now bundled — the `build` job compiles it and `electron-builder.yml` ships it as an `extraResources` entry at `resources/relayium-io-helper.exe`, asserted present and hash-equal to the binary built that run — but bundling is packaging, not acceptance: it is still not wired to the app, and no product code calls it. Its sources belong to another lane and are absent from this tree. |
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
2. **Author-tested** — 214 unit/conformance assertions and one real Electron
   smoke pass, all written by the implementer, on **macOS only**. No Linux run
   has happened and none is claimed. (196 at the foundation commit; the
   installation-destination guard and its alias closure added the rest.)

   The NSIS script is now also **compiled** locally: `electron-builder --win`
   runs makensis on macOS and produces the installer. Until this batch it did
   not compile at all — two defects (`LogicLib.nsh` not in scope where
   electron-builder emits the custom include, and duplicate macro labels when
   the resolver is inserted twice in one function) would each have failed the
   Windows lane at the packaging step. Compiling is not running: the guard's
   behaviour is still unobserved.
3. **Independently reviewed and accepted — the foundation at `b7d65457d`.**
   Under Node 24 on macOS: `check`, `build`, the 196 unit tests, the real
   Electron smoke and the eight repository policy gates, all exit 0 against
   matching frozen hashes. Beyond re-running the author's tests, the reviewer
   produced independent evidence against separately compiled snapshots of the
   actual source — receive IO (4), secret store (2), account authority, and the
   sign-in controller lifecycle composed from the actual controller and service
   with a real temporary store, no mocked lifecycle.

   This is macOS evidence about the foundation's behaviour. It is **not**
   acceptance of the Windows client, of native receive IO, of the installer or
   the installed artifact, or of any Distribution row. It says nothing about
   containment: the staging path's ancestor-swap exposure and the unsupported
   publication below are unchanged and remain the native helper's to remove.

   Everything added after `b7d65457d` — the installation-destination guard, its
   `storage.ts` half, the installed-artifact acceptance test and the native CI
   job — is newer than this review, `author-tested` only, and Windows-pending.
4. **Windows runtime** — *partial, and not the part that matters most.* The
   `windows` lane has run once, on the foundation commit, as run
   **34448645493**: `check`, `build`, the 196 unit tests and the unpackaged
   Electron smoke passed on a real Windows runner, and the NSIS installer
   packaged. The reviewer downloaded that installer and confirmed its recorded
   SHA-256 and PE header. This is the only Windows evidence that exists.

   It is not evidence about the installed artifact. That smoke runs the
   **unpackaged** app and injects its own `SecretStore` and test cipher, so
   **real DPAPI has still never executed**; the installer has never been
   executed and the installed application never launched, anywhere. Nothing
   added after `b7d65457d` has run on Windows at all.

   Implemented and awaiting its first run: `test/smoke/installed-acceptance.mjs`
   installs the packaged artifact, launches it, and asserts the app scheme, the
   production origin under injected engineering overrides, DPAPI health, the
   `relayium://` registration naming the installed executable, single-instance
   behaviour, identity survival across a same-version reinstall, the destination
   guard, and an uninstall that removes the program without removing user data.
   Until it runs on Windows none of that is evidence — it is a written intention.

   Still unproven either way: the folder picker, the tray, deep-link activation,
   graceful quit, upgrade across versions, and code signing. This lane produces
   an unsigned artifact and does not certify download or reputation behaviour.

No row above may move past `author-tested` on macOS evidence, and none may reach
`done` until it has been both independently accepted and observed on Windows.
The acceptance in (3) moves no row to `done`; the Windows observation half is
outstanding for every row in this document. Per-probe review history is the
reviewer's private evidence ledger, not this document's to reproduce.
