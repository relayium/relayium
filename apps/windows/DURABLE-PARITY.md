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
| Desktop behaviour | Resident close/quit, tray, notifications, deep-link handling, login-item and first-run, against a real Electron process. The installer's Explorer verbs and SendTo shortcut now reach the app: `321d131be` stages `--send-files` at launch and on `second-instance`, and the bootstrap smoke drives the real listener and asserts the pane names the file while the directory appears in neither the text nor the markup | The OS startup toggle and the native file picker are supplied by injection, so neither is proven. Staging has not been driven from a real Explorer right-click on Windows |
| Presentation | Five-row navigation; English and Chinese catalogues with compile-enforced key parity; light/dark, focus and reduced-motion support | Windows scaling, keyboard and motion validation |

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
* **A reparse-proof source read.** `relayium-io-helper --source-mode` exists and
  its walk is proven on Windows, but `SelectionReader` still reads through Node,
  so the race its own header describes is open on every staged file. The
  adapter is the remaining half.

Passing a subsystem checkpoint does not establish platform parity.
