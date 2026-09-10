# Windows desktop client

The Windows client is in development toward parity with released macOS 1.3.10.
It is intended for direct distribution as an EXE outside the Microsoft Store.
It is **not feature complete, not signed, and has no public release.**

## Current status

The Windows lane is green at integration `1753c3192`
([run 34538825772](https://github.com/relayium/relayium/actions/runs/34538825772)):
all three jobs, `npm run check`, the Go helper suites, **1724 unit tests with 125
skips**, `npm run build`, the Electron bootstrap and resident lifecycle smokes,
the secret durability matrix, an unsigned packaged installer, installed-artifact
acceptance, the native update runtime, the owned-process guardian (**36 cases,
including 10 Windows job-object cases**) and the realtime pairing acceptance
(**25 assertions, no skips**).

A later integration `df1934f6c`
([run 34541106051](https://github.com/relayium/relayium/actions/runs/34541106051))
makes a refused receive end visibly and raises realtime to **26 assertions**. Its
`native` and `realtime` jobs are green, including the new check that the
interface reports the refusal. Its `build` job, which also runs the resident
smoke, failed on a Stored copy-history race over an empty job id; that is under
repair and is not covered by any claim below.

The most recent work sits at integration `98af8a235` — the Device Inbox send,
named-history and recovery batch — and passes **1967 tests**, a 13-case probe and
a real two-process smoke on the development host. It has not yet run in the
Windows lane. Where an area below is partly in that state, the table says so.

## Status by area

| Area | Proven on Windows | Owed |
|---|---|---|
| Installation and storage | Per-user x64 NSIS installer packaged and installed to a path containing a space; forced-kill relaunch, reinstall and profile continuity; junction and `subst` alias destinations refused while ordinary paths install and uninstall; scheme ownership removed on uninstall with a foreign association preserved | Signing, distribution, upgrade acceptance, uninstall/data-removal policy |
| Secrets | Direct DPAPI writes with read-only migration from legacy `safeStorage`; a 7-cell durability matrix across forced kills; the helper's tamper oracle over 310 positions — **620 single-byte mutations: 588 refused with no output, 32 opened byte-for-byte unchanged, 0 altered** — plus refusal of DPAPI-valid blobs whose inner record does not verify | — |
| Realtime transfer | The real Windows client and a real browser in one room over a real server: both link roles and both code roles, an agreed verification code, UTF-8 both ways, and byte-exact nested Unicode, empty and chunk-boundary files landing on the **real Windows destination** through the real lease and path guards. A Windows-illegal name is refused for that reason, nothing is written, and the interface reports it. Both browser and Electron process trees proven empty afterwards by job-object census | Real-network transfer; NAT and TURN remain undemonstrated |
| Stored links | Receive backend, manifest validation, native destination, cancellation, retained cleanup and the upload engine. Stored **send and history run in the resident client on Windows**, from `77c` through `1753` | 12 further real-Go checks are development-host only; interface polish and the copy-history race |
| Account | Native device-code sign-in, cancellation, expiry and installation identity; the bearer never leaves main. **13 modules and their 109 owning tests executed on Windows** at `1753` | Host wiring awaits acceptance |
| Device Inbox | Backend, encrypted journal, vault and key storage, account lifecycle, the Windows native-destination acceptance suite, a 39-case real-Go server run, and the manual receive and policy slices | The `98af8a235` send, named-history and recovery batch has not run on Windows |
| Updates | The update core has run on Windows | No publisher pin, no expected publisher and no feed configured — all fail-closed. An interface covering 18 states (12 modules) is under review and not wired |
| Desktop behaviour | Resident close/quit, tray, notifications, deep-link handling, login-item and first-run, against a real Electron process | The OS startup toggle and the native file picker are supplied by injection, so neither is proven |
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

Parity requires reachable user flows for files, folders, text, stored links and
the Device Inbox; the Inbox send, history and recovery batch proven on Windows;
account wiring accepted; update delivery completed and configured; real-network
transfer demonstrated; and signing, installer and upgrade acceptance.

Passing a subsystem checkpoint does not establish platform parity.
