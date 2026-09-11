# Windows desktop client

The Windows client is in development toward parity with released macOS 1.3.10.
It is intended for direct distribution as an EXE outside the Microsoft Store.
It is **not feature complete, not signed, and has no public release.**

## Current status

The Windows lane is green at integration `321d131be`
([run 34582006339](https://github.com/relayium/relayium/actions/runs/34582006339)):
all three jobs, `npm run check`, the Go helper suites, **2274 unit tests with 125
skips across 109 files**, `npm run build`, the Electron bootstrap and resident
lifecycle smokes, the secret durability matrix, an unsigned packaged installer,
installed-artifact acceptance, the native update runtime, the owned-process
guardian and the realtime pairing acceptance.

Superseded status note, corrected 2026-09-11: this section previously pinned
current status at `1753c3192`/`98af8a235` and described three areas as owed that
have since been delivered and proven on Windows — Account host wiring, the
Device Inbox send/named-history/recovery batch, and the update interface. The
Stored copy-history race it recorded as under repair was fixed in `6a2ab6b27`.
The table below is current as of `321d131be`.

## Status by area

| Area | Proven on Windows | Owed |
|---|---|---|
| Installation and storage | Per-user x64 NSIS installer packaged and installed to a path containing a space; forced-kill relaunch, reinstall and profile continuity; junction and `subst` alias destinations refused while ordinary paths install and uninstall; scheme ownership removed on uninstall with a foreign association preserved | Signing, distribution, upgrade acceptance, uninstall/data-removal policy |
| Secrets | Direct DPAPI writes with read-only migration from legacy `safeStorage`; a 7-cell durability matrix across forced kills; the helper's tamper oracle over 310 positions — **620 single-byte mutations: 588 refused with no output, 32 opened byte-for-byte unchanged, 0 altered** — plus refusal of DPAPI-valid blobs whose inner record does not verify | — |
| Realtime transfer | The real Windows client and a real browser in one room over a real server: both link roles and both code roles, an agreed verification code, UTF-8 both ways, and byte-exact nested Unicode, empty and chunk-boundary files landing on the **real Windows destination** through the real lease and path guards. A Windows-illegal name is refused for that reason, nothing is written, and the interface reports it. Both browser and Electron process trees proven empty afterwards by job-object census | Real-network transfer; NAT and TURN remain undemonstrated |
| Stored links | Receive backend, manifest validation, native destination, cancellation, retained cleanup and the upload engine. Stored **send and history run in the resident client on Windows**, from `77c` through `1753` | 12 further real-Go checks are development-host only. The copy-history race is fixed in `6a2ab6b27` |
| Account | Native device-code sign-in, cancellation, expiry and installation identity; the bearer never leaves main. **13 modules and their 109 owning tests executed on Windows**. Host wiring delivered in `6a2ab6b27` and green on Windows since; the account screen and device management are reachable in the shipping shell | Device rename and revoke are exercised by their owning tests only; neither has been driven against a real account on Windows |
| Device Inbox | Backend, encrypted journal, vault and key storage, account lifecycle, the Windows native-destination acceptance suite, a 39-case real-Go server run, the manual receive and policy slices, and the `98af8a235` send, named-history and recovery batch, which has run on Windows in every lane since | Delivery to a second real device across a network |
| Updates | The update core has run on Windows, including the native signer, custody and verified-byte launch checks. The interface covering 18 states is wired into the resident host in `a654041` and its host acceptance passed | No publisher pin, no expected publisher and no feed configured — all fail-closed, so no update can actually be delivered. No real installer has been launched |
| Desktop behaviour | Resident close/quit, tray, notifications, deep-link handling, login-item and first-run, against a real Electron process. Staged files are read through `relayium-io-helper --source-mode`, whose component-by-component walk is proven on Windows, so no ancestor can redirect the open; a Windows build without the helper refuses every staged read rather than substituting Node. The installer's Explorer verbs and SendTo shortcut now reach the app: `321d131be` stages `--send-files` at launch and on `second-instance`, and the bootstrap smoke drives the real listener and asserts the pane names the file while the directory appears in neither the text nor the markup | The OS startup toggle and the native file picker are supplied by injection, so neither is proven. Staging has not been driven from a real Explorer right-click on Windows |
| Received files | A finished receive announces its files as per-file capability tokens on the originating document. Dragging is main's — it re-checks that the file is still the one it registered before the OS is told — and the drag image is the build's icon rather than anything derived from the file. The page is given relative paths only, and an announcement carrying an absolute path is dropped rather than rendered | No drag has been performed by a person on Windows; the OS drag itself is only reachable through a real cursor |
| On-screen help | Every browseable screen ends with six answers — purpose, the shortest path, what Relayium can see, where things end up, what goes wrong and what to do — written against Windows behaviour rather than ported, in both maintained languages. Rendered once by the shell over a total table, so a screen cannot be added without its answers. A full-row button with aria-expanded and aria-controls, closed by default, driven on all five screens in a real window | No link to a maintained guide: macOS renders one only where a document exists, and none is written for these screens |
| Notifications | Files saved, a message saved, something waiting, a failure, and an upload whose link is ready — each its own event, each raised from main's own observation rather than a page's claim, and each carrying nothing that is unsafe on a lock screen. Suppressed while the window is focused, except the one that exists because something is waiting, and an offer nobody has answered yet — so the interval in which a sender is waiting is no longer silent | No notification has been seen by a person on Windows; every one of them is asserted through the platform seam rather than on a desktop |
| Tray | Opens the app and its three live surfaces, and pauses or resumes BOTH Nearby and the Device Inbox without opening the window. Pausing the Inbox stops claiming without writing the stored policy or telling central, so a mis-click in a menu costs a pause and not an enrolment; the label says what it will do and is rebuilt when the state moves. Driven against the real runtime in the resident smoke It also reports, above the actions: the account, what the Device Inbox is doing and whether Nearby is on, read from main and localized with the rest. A pause outranks the status beneath it, and an unrecognised state reports ON rather than as a fault | The reveal for the latest receipt is still menu-bar only on macOS. No tray has been driven by a person on Windows |
| Account gating | Main pushes an authority change carrying no identity, and the shell re-reads its state from a settled phase only, so a sign-out made anywhere reaches the screen. Signed out, the Device Inbox and the send half are gated ENTIRE: each names what it needs and offers the one action that ends it, and the controls are absent rather than greyed. Anonymous link opening is deliberately ungated | Gating is proven for the two account-bound surfaces only; no audit has walked every control for a dead one |
| Pairing handoff | The live code is reachable as a join link and a QR built from the compiled origin. Copy names an action and carries no text, so main writes only what main retained; an unknown action is refused and the clipboard is left alone, asserted in a real Electron process | No code has been minted end to end on Windows: the smoke is signed out, so only the refusal path is covered. Scanning the QR with a phone is unproven |
| Presentation | Five-row navigation; English and Chinese catalogues with compile-enforced key parity; light/dark, focus and reduced-motion support | Windows display scaling. Keyboard and motion now EXECUTE in a real window — the sidebar is focusable and arrow-driven through `sendInputEvent`, navigation moves focus into the page, and reduced motion is asserted under an emulated preference — but no screen reader has been run against it, and nobody has driven it by keyboard on Windows |

## What the evidence does not cover

**No network traversal is proven.** The realtime acceptance puts a real Windows
Electron client and a real Chrome in one room over a loopback server on a single
runner. That establishes the client's own behaviour on Windows — real files, real
code and link roles, the real destination and its guards — and establishes
nothing about a Windows machine reaching a Mac across a real network.

**Injected operating-system behaviour is not operating-system behaviour.** The
resident smoke drives a real Electron process, but startup registration and the
file dialog are supplied by the test.

**A backend that passes its own acceptance is not a user flow**, and a suite that
is green on the development host is not Windows evidence.

## Standing guarantees

* Stored-link fragments remain local and never enter API requests or
  diagnostics. A deep link opened by the OS necessarily arrives through process
  arguments.
* File and message content is encrypted on the network. Device Inbox ciphertext
  is uploaded under `purpose=device_task`, which is invisible in the account's
  own file list.
* Secret keys are persisted only through the protected store. A signed-out or
  disabled state does not erase local messages or recovery keys.
* A receive that cannot be completed ends visibly: the destination's own typed
  refusal stays in the privileged process, and the interface reports a terminal
  outcome with a reason.

## What is waiting on the owner

Four things stand between this client and parity, none of them engineering, and
each is queued in the workspace-only `OWNER-ACTIONS.md` with the exact action
and how it will be verified:

* **OA-029** a code-signing certificate. There is no pipeline to turn on — when
  a certificate exists, the CI step, the read-back verification and the secret
  wiring still have to be built, and they have to be built against the route
  chosen, because a token-bound key and a service-held key are not
  interchangeable in CI.
* **OA-030** the update publisher pin and feed. The expected publisher is the
  subject of that certificate and does not exist until it does.
* **OA-031** a transfer across a real network, which needs two machines.
* **OA-032** hands-on acceptance: no Explorer right-click has started this app,
  no phone has scanned its QR, no notification has been seen on a desktop.

They were recorded here from the beginning and never queued, so the one document
the owner reads when asking "what needs me" did not mention Windows at all.

## Gates that remain separate

Code signing, the update feed and any public release surface are each their own
decision, and none is authorised by a green run. The same applies to the native
picker, the OS startup toggle, manual scaling behaviour and upgrade acceptance.

## Completion

Closed since this list was written: the Device Inbox send, history and recovery
batch is proven on Windows, and account wiring is accepted and reachable.

Still required for parity:


* **Reachable user flows** for files, folders, text, stored links and the Device
  Inbox. Explorer and SendTo now reach the app; the flows themselves are
  reachable in the shell, but none has been driven end to end by a person on
  Windows.
* **Update delivery completed and configured.** The interface is wired and the
  core is proven, but with no publisher pin, no expected publisher and no feed,
  every path fails closed and no update can be delivered at all.
* **Real-network transfer demonstrated.** Everything proven so far is one
  runner and a loopback server.
* **Signing, installer and upgrade acceptance**, each its own gate.
* **A supported-version gate, before the first public release.** macOS refuses
  to build its content at all when the served policy says the build is below
  minimum, so a stale binary opens no socket. Windows has no equivalent and
  there is no `/api/client-policy/windows` to read. Deferred deliberately — no
  Windows build has ever been released, so there is nothing in the field to
  protect — but it must ship in or before the first version it governs, because
  a client already out there cannot be told to stop retroactively.
* **A real Explorer right-click.** Staging is driven in the bootstrap smoke
  through the shipping `second-instance` listener with the argv the installer's
  verbs produce, but no run has started from an actual right-click on Windows.

Passing a subsystem checkpoint does not establish platform parity.
