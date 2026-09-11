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
| Installation and storage | Per-user x64 NSIS installer packaged and installed to a path containing a space; forced-kill relaunch, reinstall and profile continuity; junction and `subst` alias destinations refused while ordinary paths install and uninstall; scheme ownership removed on uninstall with a foreign association preserved | Signing, distribution and upgrade acceptance. The uninstall policy is settled and asserted rather than owed: the uninstaller removes what it registered — the scheme, both send verbs, the SendTo entry — and the installed-artifact acceptance proves on a real machine that the private data root and the sealed identity SURVIVE it, byte-for-byte, and that a `relayium://` association pointing at another program is left alone. Keeping user data across an uninstall is what macOS does too |
| Secrets | Direct DPAPI writes with read-only migration from legacy `safeStorage`; a 7-cell durability matrix across forced kills; the helper's tamper oracle over 310 positions — **620 single-byte mutations: 588 refused with no output, 32 opened byte-for-byte unchanged, 0 altered** — plus refusal of DPAPI-valid blobs whose inner record does not verify | — |
| Realtime transfer | The real Windows client and a real browser in one room over a real server: both link roles and both code roles, an agreed verification code, UTF-8 both ways, and byte-exact nested Unicode, empty and chunk-boundary files landing on the **real Windows destination** through the real lease and path guards. A Windows-illegal name is refused for that reason, nothing is written, and the interface reports it. Both browser and Electron process trees proven empty afterwards by job-object census | Real-network transfer; NAT and TURN remain undemonstrated |
| Stored links | Receive backend, manifest validation, native destination, cancellation, retained cleanup and the upload engine. Stored **send and history run in the resident client on Windows**, from `77c` through `1753` | Narrowed, and the row previously undersold it: the shared upload engine, its transport, its fence and its planner ARE driven against a real Go server on Windows, in `inbox-server-acceptance.mjs`, because the Device Inbox delivers through the same machinery. The stored-LINK lifecycle now runs there too: an object publishes, the SHIPPING receiver opens a `relayium://d/<id>#k=…` link minted in the same run, the plaintext returns byte for byte, and a link carrying a different key fails on `integrity` rather than being refused earlier. The copy-history race is fixed in `6a2ab6b27` | Interface polish, and no stored link has been opened by a person on Windows |
| Account | Native device-code sign-in, cancellation, expiry and installation identity; the bearer never leaves main. **13 modules and their 109 owning tests executed on Windows**. Host wiring delivered in `6a2ab6b27` and green on Windows since; the account screen and device management are reachable in the shipping shell | Rename and revoke now run against a REAL account on Windows through the shipping client and normaliser: the list is re-read after each mutation, an astral-character name round-trips through central, and a repeat revoke is idempotent and resurrects nothing. Plan and usage figures are still read-only and unasserted against a real plan change |
| Device Inbox | Backend, encrypted journal, vault and key storage, account lifecycle, the Windows native-destination acceptance suite, a 39-case real-Go server run, the manual receive and policy slices, and the `98af8a235` send, named-history and recovery batch, which has run on Windows in every lane since | Delivery to a second real device across a network |
| Updates | The update core has run on Windows, including the native signer, custody and verified-byte launch checks. The interface covering 18 states is wired into the resident host in `a654041` and its host acceptance passed | No publisher pin, no expected publisher and no feed configured — all fail-closed, so no update can actually be delivered. No real installer has been launched |
| Desktop behaviour | Resident close/quit, tray, notifications, deep-link handling, login-item and first-run, against a real Electron process. Staged files are read through `relayium-io-helper --source-mode`, whose component-by-component walk is proven on Windows, so no ancestor can redirect the open; a Windows build without the helper refuses every staged read rather than substituting Node. The installer's Explorer verbs and SendTo shortcut now reach the app: `321d131be` stages `--send-files` at launch and on `second-instance`, and the bootstrap smoke drives the real listener and asserts the pane names the file while the directory appears in neither the text nor the markup. The registered verb is now EXECUTED rather than read: the installed-artifact acceptance takes the command out of the registry, substitutes %1 as the shell does, and spawns it BOTH ways — started cold, and delivered to an app already running. That found a live defect and fixed it: the argv parser assumed the paths sat immediately after the flag, which is true of Explorer's command line and false of the one Electron reconstructs for a second instance, so right-click send worked exactly once per app lifetime. The `relayium://` association is executed the same way, both cold and against a running instance: the page is handed the link and SHOWS it, and no transfer begins by itself. That one needed no fix — `handleDeepLink` searches the whole argv rather than a position, which is precisely the difference that broke its sibling. The SendTo shortcut is executed too, which is the only BULK path: its real target and arguments are read from the `.lnk`, three real files are appended the way the shell appends them, and all three stage with all three named and no directory in the text or the markup. The staged selection is discarded first through the control a person uses, so "a held selection survives another activation" and "a discard empties it" both run on the installed build. The OS startup toggle now runs against WINDOWS rather than a stand-in: the real IPC and the shipped adapter write, and the Run key is then read with `reg` — a declined consent leaves the registry untouched, a confirmed one leaves exactly one entry naming this executable, and turning it off removes that entry. Only the modal consent is injected. A platform-guarded scenario that does not run now reports itself, so a skip cannot read as coverage | The native file picker is still supplied by injection, so it is not proven. Explorer's OWN half — that the shell performs the %1 substitution and honours MultiSelectModel — still needs the shell, and no person has right-clicked a file on Windows |
| Received files | A finished receive announces its files as per-file capability tokens on the originating document. Dragging is main's — it re-checks that the file is still the one it registered before the OS is told — and the drag image is the build's icon rather than anything derived from the file. The page is given relative paths only, and an announcement carrying an absolute path is dropped rather than rendered | No drag has been performed by a person on Windows; the OS drag itself is only reachable through a real cursor |
| On-screen help | Every browseable screen ends with six answers — purpose, the shortest path, what Relayium can see, where things end up, what goes wrong and what to do — written against Windows behaviour rather than ported, in both maintained languages. Rendered once by the shell over a total table, so a screen cannot be added without its answers. A full-row button with aria-expanded and aria-controls, closed by default, driven on all five screens in a real window. Four screens end with a link to a maintained guide and the Account screen deliberately ends with none, asserted as an absence on the real rendered DOM. The page sends a SCREEN and a language, never an address, and the control is a button so the document holds no URL to read. Every promised guide is resolved to the file that serves it in BOTH maintained languages, and the English-only Device Inbox page to its route, so a renamed slug or an untranslated guide fails the build rather than shipping a 404 | The one remaining gap is a reader's, not a build's: no guide has been opened from a Windows build by a person, because following the link leaves the app for a browser and the suites deliberately stop at the control |
| Notifications | Files saved, a message saved, something waiting, a failure, and an upload whose link is ready — each its own event, each raised from main's own observation rather than a page's claim, and each carrying nothing that is unsafe on a lock screen. Suppressed while the window is focused, except the one that exists because something is waiting, and an offer nobody has answered yet — so the interval in which a sender is waiting is no longer silent | No notification has been seen by a person on Windows; every one of them is asserted through the platform seam rather than on a desktop |
| Tray | Opens the app and its three live surfaces, and pauses or resumes BOTH Nearby and the Device Inbox without opening the window. Pausing the Inbox stops claiming without writing the stored policy or telling central, so a mis-click in a menu costs a pause and not an enrolment; the label says what it will do and is rebuilt when the state moves. Driven against the real runtime in the resident smoke It also reports, above the actions: the account, what the Device Inbox is doing and whether Nearby is on, read from main and localized with the rest. A pause outranks the status beneath it, and an unrecognised state reports ON rather than as a fault | No tray has been driven by a person on Windows |
| Account gating | Main pushes an authority change carrying no identity, and the shell re-reads its state from a settled phase only, so a sign-out made anywhere reaches the screen. Signed out, the Device Inbox and the send half are gated ENTIRE: each names what it needs and offers the one action that ends it, and the controls are absent rather than greyed. Anonymous link opening is deliberately ungated | Gating is proven for the two account-bound surfaces. Every `disabled` binding in the renderer WAS walked — 52 of them — and each is a busy state that says so, an empty-input state that is self-evident, a control beside an explicit refusal, or a control not rendered at all with its reason given; no dead control was found and none was manufactured |
| Pairing handoff | The live code is reachable as a join link and a QR built from the compiled origin. Copy names an action and carries no text, so main writes only what main retained; an unknown action is refused and the clipboard is left alone, asserted in a real Electron process | A code is now minted end to end on Windows against the real server: two mints differ, a bearer that is not real is refused BY THE SERVER, and the expiry is the 300 seconds the on-screen help promises. Scanning the QR with a phone is unproven, and no code has been redeemed by a second device |
| Presentation | Five-row navigation; English and Chinese catalogues with compile-enforced key parity; light/dark, focus and reduced-motion support | Keyboard and motion now EXECUTE in a real window — the sidebar is focusable and arrow-driven through `sendInputEvent`, navigation moves focus into the page, and reduced motion is asserted under an emulated preference — but no screen reader has been run against it, and nobody has driven it by keyboard on Windows. Display scaling is handled rather than owed: the window is fitted to the display's WORK AREA, because Windows scaling shrinks the logical screen — a 1366x768 laptop at 150% leaves 910x512, below the old fixed 880x560 floor — and Electron does not clamp this itself. Covered across the screens people actually have, plus a real window proving the platform enforces the floor it was given. What is NOT covered is how it LOOKS at a high devicePixelRatio: no scaled desktop has been seen by a person |

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

* **OA-029** a code-signing certificate. The READ-BACK half is built and
  proven: every run re-reads the signature from the installer it produced and
  asserts it in both directions — unsigned when no credential is configured,
  `Valid` when one is, and a failure otherwise, so an artifact can never pass as
  signed without the file itself saying so. What still needs the route decision
  is the signing ACTION and its secret wiring, because a token-bound key and a
  service-held key are not signed with interchangeably.
* **OA-030** the update publisher pin, and whether updates are commissioned at
  all. Larger than it first looked: there is no Windows publication pipeline —
  `web/public/apps/` holds `android` and `macos` and no `windows`, nothing
  produces or signs `updates.json`, and no download surface exists. The CLIENT
  half is built and strict, and `manifest.ts` already pins what a manifest must
  contain, so the generator's contract is fixed by its consumer. The pin itself
  is the subject of the certificate and does not exist until that does.
* **OA-031** a transfer across a real network, which needs two machines. Note
  that a successful one does NOT prove relay traversal: the client knows which
  relays were issued and does not surface which candidate pair was selected, so
  whether TURN carried it is a server-side observation rather than anything the
  app can report.
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
