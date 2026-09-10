# Windows desktop client

The Windows client is in development toward parity with released macOS 1.3.10.
It is intended for direct distribution as an EXE outside the Microsoft Store.
It is not yet feature complete and is not publicly distributed.

The latest verified Windows build is candidate commit
`30593a1c74d1f56dd48509b83499276f49908cb5`, workflow run `34478969571`. Both
Windows jobs passed, including 494 unit tests, Electron startup and account
authority, native helpers, and installed-process recovery checks. That build is
a foundation checkpoint. Reviewed source has moved on since — resident
closure and the Device Inbox receive backend are both integrated — and **none of
it has had a Windows CI run**.

## Status by area

| Area | Implemented and verified | Remaining work |
|---|---|---|
| Installation and storage | Per-user x64 NSIS installer; installed forced-kill, relaunch and reinstall checks; fixed-path IO helper; direct DPAPI secret writes, with read-only migration from legacy Electron `safeStorage` | Application install/upgrade/uninstall acceptance, signing, distribution |
| Account | Native device-code sign-in, cancellation, expiry, installation identity; the bearer stays in main | Account, usage and device information; management links |
| Realtime transfer | LAN and pairing pages connect through the real main/renderer bridge. Both pairing creator roles interoperated with macOS 1.3.10: first text arrived once; a 262 144-byte file and nested Unicode and empty-file batches matched the receiver's bytes and paths | Windows-hosted transfer and receive flows; real NAT and TURN |
| Stored links | Streaming receive backend with authenticated manifest validation, native destination, cancellation and retained cleanup, plus the upload engine, **integrated into current source**. Real-server acceptance passes 12 of 12, including history, delete and recovery from a lost finalize | Main/UI bindings, Windows save tests |
| Device Inbox | Receive backend **integrated into current source**: encrypted journal, vault and key storage, and account lifecycle. A real-server harness verifies decoding, receipt recovery, and ACK-only replay that does not re-download published files | Main/UI bindings, background scheduling, the sender, Windows native-destination acceptance |
| Desktop behaviour | Resident close/quit, tray, startup, notifications and deep-link handling are **integrated into current source** (CP13). The installer alone owns scheme registration | Combined application and Windows desktop acceptance |
| Presentation | Five-row navigation, English **and Chinese** catalogues with compile-enforced key parity, light/dark styling, focus and reduced-motion support. Browser DOM checks drive the production send pane: 10 of 10 pass, covering real file-input selection, dropped directory entries and held text, including stale-intent cases | Stored and Device Inbox are placeholder pages; complete them, then validate Windows scaling, keyboard and motion behaviour |
| Updates | No Windows updater has been delivered | Implement and verify the update path |

## What the evidence does and does not cover

The realtime interoperability runs used Electron hosted on macOS against a
loopback server. They establish protocol and page behaviour, **not** Windows
operating-system behaviour and **not** TURN traversal.

The Device Inbox real-server harness used a recording destination. Windows
helper composition tests are authored but **have not run on Windows**.

The send-pane DOM checks ran in a browser against the production component, not
on Windows. They discriminate: the same unchanged fixture reports **six
failures** against the previous source and **ten passes** against current
source, with the positive controls passing in both — so they measure the
behaviour they name rather than the fixture agreeing with itself. The cases cover a late picker after a quit
fence and after Stay, a picker or held drop following a replacement peer, a held
drop meeting verification enabled during the read, a held drop surviving an
expired quit ticket, and held text replaying after Stay.

The secret helper's Windows tamper oracle passed: of 620 single-byte mutations,
588 were refused and 32 returned exactly the original plaintext; **none returned
altered plaintext**. Four further DPAPI-valid blobs carrying invalid inner
records were refused.

## Standing guarantees

* Stored-link fragments remain local and never enter API requests or
  diagnostics. A deep link opened by the OS necessarily arrives through process
  arguments.
* File and message content is encrypted on the network.
* Secret keys are persisted only through the protected store. A signed-out or
  disabled state does not erase local messages or recovery keys.

## Completion

Parity requires reachable user flows for files, folders, text, stored links and
the Device Inbox; actual Windows receive and resident testing; account and
update completion; installer and upgrade acceptance; and an accurate public
download surface.

Source and backend operational acceptance is a different thing from full-page
behaviour and from Windows evidence. Passing a subsystem checkpoint does not
establish platform parity.
