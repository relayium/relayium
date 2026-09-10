# Windows desktop client

The Windows client is in development toward parity with released macOS 1.3.10.
It is intended for direct distribution as an EXE outside the Microsoft Store.
It is **not feature complete, not signed, and not publicly distributed.**

The latest Windows-verified candidate is `22b4fb3f1c31871f807554ecad570142c59688de`,
workflow run `34512312628`. Both jobs — `native` and `build` — succeeded, covering
`npm run check`, the Go helper tests, **1380 unit tests across 62 files with 1
skip**, `npm run build`, the Electron bootstrap smoke, the resident lifecycle
smoke, the secret durability matrix, an unsigned packaged installer, and
installed-artifact acceptance with no failures.

The preceding candidate `c8381a0853d6a28f23e11525c3d8c39be2050b30`
(run `34511025161`, 1286 tests / 1 skip) was the **first Windows run to invoke
the resident lifecycle smoke**.

`22b4` adds exactly the Device Inbox **sender**: 89 tests across its three owning
suites, plus five contract cases that drive the **shared production encryptor**
through the built runtime artifact and back through the shared decryptor. That
accounts for the whole 94-test increase. The sender is therefore unit-tested on
Windows — but its **real-server evidence remains a macOS-hosted loopback run**,
and it has **no user interface**.

## Status by area

| Area | Verified on Windows in run 34512312628 | Still owed |
|---|---|---|
| Installation and storage | Per-user x64 NSIS installer packaged and installed to a path containing a space; forced-kill relaunch, reinstall, and profile continuity across both; junction and `subst` alias destinations refused (exit 2) while ordinary paths install and uninstall; scheme ownership removed on uninstall with a foreign association preserved | Code signing, distribution, upgrade acceptance, uninstall/data-removal policy |
| Secrets | Direct DPAPI writes with read-only migration from legacy Electron `safeStorage`; a 7-cell durability matrix across forced kills; the helper's tamper oracle over 310 positions — **620 single-byte mutations: 588 refused with no output, 32 opened byte-for-byte unchanged, 0 altered** — plus refusal of DPAPI-valid blobs whose inner record does not verify | — |
| Account | Native device-code sign-in, cancellation, expiry and installation identity; the bearer never leaves main | Account, usage and device information; management links |
| Device Inbox — receive | Backend ran on Windows: encrypted journal, vault and key storage, account lifecycle, and the Windows native-destination acceptance suite | Receive **UI is in progress**; background scheduling |
| Device Inbox — send | Backend accepted and **unit-tested on Windows** (89 suite tests; the shared production encryptor round-trips through the built artifact in 5 further cases). A separate real-server harness drives the compiled coordinator through 40 checks | That harness is **macOS-hosted loopback**, not Windows; **no send UI exists**; renderer/IPC composition not written |
| Stored links | Receive backend, manifest validation, native destination, cancellation, retained cleanup and the upload engine all ran on Windows; the stored Windows acceptance suite passed 4 of 5 with 1 skip. CP14 makes stored **receive reachable in the app** | Stored **send and history composition**; Windows save-path acceptance beyond the suite |
| Realtime transfer | LAN and pairing pages drive the real main/renderer bridge; suites for signalling, ICE control, room control and receive lifecycle ran on Windows | **Windows-hosted transfer and receive flows; real NAT and TURN** |
| Desktop behaviour | Resident close/quit, tray, notifications, deep-link handling, login-item and first-run all ran on Windows, and the resident lifecycle smoke passed against a real Electron process | Startup and picker behaviour is exercised **by injection**, so no real OS startup toggle is proven; combined desktop acceptance |
| Presentation | Five-row navigation; English and Chinese catalogues with compile-enforced key parity; light/dark, focus and reduced-motion support | Inbox and stored send surfaces; Windows scaling, keyboard and motion validation |
| Updates | **Nothing shipped.** The inert TypeScript core is accepted and integrated: `npm run check`, `build:main` and its 136 owning tests pass | The native Windows helper is **under implementation and unaccepted**; the production publisher pin is **missing and fail-closed**; no updater is delivered, and the core has had no Windows run |

## What the evidence does and does not cover

**The realtime interoperability runs used Electron hosted on macOS against a
loopback server.** They establish protocol and page behaviour — both pairing
creator roles interoperated with macOS 1.3.10, a 262 144-byte file and nested
Unicode and empty-file batches matched the receiver's bytes and paths — but they
are **not Windows operating-system behaviour and not TURN traversal.** No NAT
traversal of any kind has been demonstrated.

**The sender's real-server evidence is a loopback Go server on one macOS host.** It
drives the compiled coordinator against real handlers with a synthetic account:
a nested folder, a file crossing the chunk boundary by one byte and a UTF-8
message are encrypted by the shared production encryptor and decrypted back with
their bytes, paths and text asserted. It proves the protocol and the backend. The
sender's unit and encryptor-contract suites did run on Windows in `22b4`; that
harness did not, and neither proves a device or a user flow.

**Resident startup and picker cases are injected.** The smoke drives a real
Electron process, but the startup registration and the file dialog are supplied
by the test rather than by Windows, so nothing here proves the OS startup toggle.

**The send-pane DOM checks ran in a browser**, not on Windows. They discriminate:
the same unchanged fixture reports six failures against the previous source and
ten passes against current source, with positive controls passing in both.

One native experiment is recorded as unsupported rather than passed:
`FILE_DISPOSITION_INFORMATION_EX` with `DELETE|ON_CLOSE|IGNORE_READONLY` returns
`E_IO` on the CI host. No shipped path calls it; it is neither a failure nor
evidence the capability works.

## Standing guarantees

* Stored-link fragments remain local and never enter API requests or
  diagnostics. A deep link opened by the OS necessarily arrives through process
  arguments.
* File and message content is encrypted on the network. Device Inbox ciphertext
  is uploaded under `purpose=device_task`, which is invisible in the account's
  own file list; reclaiming an unbound object is the server's, not this client's.
* Secret keys are persisted only through the protected store. A signed-out or
  disabled state does not erase local messages or recovery keys.

## Completion

Parity requires reachable user flows for files, folders, text, stored links and
the Device Inbox; the sender and update work proven on Windows; account and
update completion; signing, installer and upgrade acceptance; and an accurate
public download surface.

A backend that passes its own acceptance is not a user flow, and a green local
suite is not Windows evidence. Passing a subsystem checkpoint does not establish
platform parity, and nothing here should be read as a launch.
