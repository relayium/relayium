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
| Ephemeral realtime text | Web text composer/history-in-session; text wire v1 | `RealtimeTextPane` + `RealtimeTextSessionModel` over `text/1`-negotiated kind-9 frames, in-memory-only history | Implemented |
| Folder transfer | Folder picker/drop, relative paths, multi-file preservation | One `expandSelection`/`SelectionStore` behind all three send flows; `ManifestWriter` rebuilds nested trees descriptor-relative on receive | Implemented |
| LAN nearby transfer | Nearby-device room and direct browser flow | `NearbyPane` + `LanDiscoveryModel` send to a picked peer; `NearbyReceiveModel` answers unsolicited offers. Both directions, STUN-only, no mint | Implemented |
| Account plan and usage | Personal center meters and plan | `AccountView` | Implemented |
| Device management | List/revoke signed-in CLI/app devices | `AccountView` devices section + `AccountManagementModel`, over bearer-authed `GET`/`DELETE /api/devices`; this Mac is marked and revoking it signs the app out | Implemented |
| Stored-file management | List links, rebuild link, delete stored ciphertext | `AccountView` stored-files section + `AccountManagementModel`; links rebuilt only where `StoredLinkKeyStore` holds the key, and the absence is explained rather than hidden | Implemented |
| Sign-in methods | Password, Apple, browser/device approval | Password is native; the Apple button opens the browser device-approval page, which is the only route available to a Developer ID build (see below) | Implemented, constrained by distribution |
| Localization | Nine web locales | Same nine (en, zh-Hans, ja, ko, de, fr, ar, es, pt) in `RelayiumAppKit`'s `.lproj` catalogs, resolved through `L10n`; Arabic is a real app localization so the platform drives RTL | Implemented |

## Native advantage audit

| Promised advantage | Current evidence | Release state |
|---|---|---|
| Menu-bar residency | App remains reachable from `MenuBarExtra` | Foundation only |
| Always-ready receive | `LanDiscoveryModel.startResident` holds one room socket for the life of the process, with backoff and a sticky user pause | Implemented |
| Drag files/folders into the app | One `FileDropZone` and one folder-capable picker behind all three send flows; a drop stages and never sends | Implemented |
| Reveal received files in Finder | Direct and cloud completion paths expose Finder | Implemented |
| Native notifications | Transfer completion notifications exist | Implemented |
| Drag received items out | `ReceivedResultView` vends real `NSItemProvider(contentsOf:)` file URLs from `receivedPayload`; a foldered result drags as its container | Implemented |
| Native Sign in with Apple | Unavailable on this distribution channel, not deferred — see below | Not implementable as a Developer ID app |
| Sparkle updates | Secure feed/key/updater foundation | Implemented, awaits first public feed |

## Sign in with Apple: what the constraint actually is

The two rows above deliberately do not read "follow-up". Native Sign in with
Apple is not work that is queued; it is work that **cannot be done on the channel
this app ships through**, and describing it as an entitlement someone has yet to
enable would send the next person to repeat a day of testing that has already
been done.

Established by testing rather than by reading documentation, and recorded in
full in `2026-07-27-native-macos-r1g2-5-sign-in-with-apple-design.md`:

- the capability was enabled on the App ID and the portal accepted it;
- the `Relayium Mac` Developer ID provisioning profile was regenerated three
  times and **never** contained `com.apple.developer.applesignin`;
- a binary signed with the entitlement anyway was killed at launch by
  `taskgated` with *Unsatisfied entitlements*;
- Xcode's automatically managed **development** profile for the same App ID does
  contain it, which rules out a portal misconfiguration;
- `xcodebuild -exportArchive` with `method=developer-id` fails outright with
  *Cannot create a Developer ID provisioning profile*.

Apple does not issue Developer ID profiles carrying that entitlement. A macOS app
distributed outside the App Store therefore cannot use native Sign in with Apple
at all; the entitlement is reachable only through development signing or App
Store/TestFlight distribution.

What the app does instead is not a degraded stand-in: the "Sign in with Apple"
button opens the browser device-approval flow (`/api/cli/device/*`) in an
`ASWebAuthenticationSession` that shares Safari's cookies, so an existing
relayium.com session — including one created with Apple — approves in one click
and the app adopts the resulting bearer. The outcome is the same account, signed
in on this Mac.

The dormant native endpoint `POST /api/auth/apple/native` is correct and
unchanged. It becomes usable when an iOS build ships through the App Store (R3),
which is the round that would also make the entitlement obtainable.

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
