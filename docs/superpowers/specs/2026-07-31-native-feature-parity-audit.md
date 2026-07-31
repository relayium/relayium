# Native macOS/iOS feature parity and native-experience audit

## Owner requirement

macOS and iOS are not reduced companions to the web product. User-facing
capabilities should stay synchronized with the web client, while each native
client should add the operating-system advantages that a browser cannot offer.
This is a release requirement and an ongoing change-management rule.

The practical meaning of "synchronized" is:

- a common transfer capability must be native or have an intentional,
  user-visible handoff that loses no outcome;
- a new web transfer capability is incomplete until native impact is assessed;
- native clients should not copy browser interaction literally when drag/drop,
  menu-bar/background presence, Finder, notifications, share sheets, or platform
  authentication can produce a better experience;
- marketing/SEO, operator administration, and platform-store billing mechanics
  need not be duplicated inside a transfer client.

## Evidence audit: web versus current macOS app

| Capability | Web | Current macOS evidence | Release state |
|---|---|---|---|
| Cross-network realtime files | Pairing code/link, sender auth, receiver anonymous | `DirectPane` + `RealtimeSessionModel` | Implemented |
| Stored encrypted links | Upload/download, TTL, delete-after-read, anonymous receive | `UploadPane`, `DownloadPane`, resumable Kit paths | Implemented |
| Ephemeral realtime text | Web text composer/history-in-session; text wire v1 | Kit reserves frame kind 9 and text key domain, but no macOS text model or UI | **Blocking gap** |
| Folder transfer | Folder picker/drop, relative paths, multi-file preservation | Both macOS pickers reject directories; comments call recursion out of scope | **Blocking gap** |
| LAN nearby transfer | Nearby-device room and direct browser flow | Kit can join the empty-code LAN room, but the app exposes pairing codes only and has no nearby-device UI | **Blocking gap** |
| Account plan and usage | Personal center meters and plan | `AccountView` | Implemented |
| Device management | List/revoke signed-in CLI/app devices | No native API/model/UI; web-only | **Blocking gap** |
| Stored-file management | List links, rebuild link, delete stored ciphertext | No native API/model/UI; web-only | **Blocking gap** |
| Sign-in methods | Password, Apple, browser/device approval | Password is native; the button labelled Apple opens the browser device-approval page rather than native Sign in with Apple | Functional, native UX gap |
| Localization | Nine web locales | macOS UI strings are English literals | Follow-up parity gap |

## Native advantage audit

| Promised advantage | Current evidence | Release state |
|---|---|---|
| Menu-bar residency | App remains reachable from `MenuBarExtra` | Foundation only |
| Always-ready receive | No persistent incoming listener is started while idle | **Blocking gap** |
| Drag files/folders into the app | Cloud file drag-in exists; direct drag-in and folders do not | **Blocking gap** |
| Reveal received files in Finder | Direct and cloud completion paths expose Finder | Implemented |
| Native notifications | Transfer completion notifications exist | Implemented |
| Drag received items out | No evidence | Follow-up gap |
| Native Sign in with Apple | Browser approval flow only | Follow-up native UX gap |
| Sparkle updates | Secure feed/key/updater foundation | Implemented, awaits first public feed |

## Release policy

`apps/mac/release-readiness.json` is a machine-checked release gate. The public
publish path refuses to run while `approved` is false or any required capability
is unimplemented. This prevents signing/notarization progress from being
mistaken for product readiness.

The current notarized DMG remains a release candidate and interoperability
artifact. It is **not** the first public macOS release until the required parity
and native-experience gaps are implemented, tested, and the manifest is
truthfully approved.

## iOS starting rule

iOS begins from the shared `RelayiumKit` protocol/crypto/cloud/account core
after the macOS parity work makes those contracts complete. Its first public
scope includes the same common transfer capabilities, plus:

- share-sheet send;
- Files picker/save integration;
- background URLSession for stored transfers;
- native notifications and lifecycle-safe resume;
- native Sign in with Apple where applicable.

APNs wake-up behavior and App Store billing remain platform-specific work, but
their absence must not silently remove an otherwise supported transfer outcome.
