# macOS Share extension — framing and settled decisions

**Status:** `framed, not started`. Written 2026-08-06 while the 1.0 notarization run was in
flight, so the next session starts from settled decisions rather than reconstructing them.

**Topology:** Claude single-agent mode. **Run policy:** automated continuous work, active.

**Where it sits:** `MACOS-LAUNCH-QUEUE.md` execution order item 2. It is inside the owner's
narrowed launch scope, and its Owner dependency (OA-006) is **complete and verified** — both the
extension App ID and the containing app's re-issued profile authorize the shared container.

---

## Why this is framed rather than half-built

The one thing this feature must do — appear in Finder's Share menu and hand files to the app —
**cannot be verified from a build directory**. macOS only offers a Share extension once its
containing app is registered with Launch Services, which in practice means an installed,
signed copy. Building it before there is an installable notarized artifact would mean shipping
a launch-scope feature whose only real behaviour nobody had observed.

So the 1.0 notarized DMG comes first. This slice is then built and verified against an
installed app, which is also the state the owner's acceptance pass runs in.

---

## Settled decision 1 — the App Group identifier differs per platform

**Found by reading the issued profiles, not by assumption.** The macOS profiles authorize
`group.com.relayium.shared` and the team-prefixed wildcard `7PVYUG4YQS.*`. They do **not**
authorize iOS's `group.com.relayium.app`. Apple additionally documents the macOS form of an App
Group identifier as `<team identifier>.<group name>`, unlike iOS's bare `group.…`.

`AppGroup.identifier` is currently one hard-coded iOS string. It becomes:

```swift
public static let iOSIdentifier = "group.com.relayium.app"
public static let macOSIdentifier = "7PVYUG4YQS.com.relayium.shared"
#if os(macOS)
public static let identifier = macOSIdentifier
#else
public static let identifier = iOSIdentifier
#endif
```

**A working patch already exists** at
`<session scratchpad>/appgroup-macos.patch` (116 lines, tests green: 159 focused tests passed).
It was deliberately not committed, because until the macOS extension exists nothing consumes
`macOSIdentifier` and this codebase does not ship unused surface.

**Two existing tests must move with it**, and this is the subtle part: `IOSSurfaceGuardTests`
compares the iOS entitlement plists against `AppGroup.identifier`. That suite compiles for
macOS, so after the split it would assert the *wrong platform's* group — passing only while the
two strings happened to be equal, which they no longer are. Both call sites become
`AppGroup.iOSIdentifier`. `SharedDraftStoreTests` pins both literals by name plus the platform
resolution itself.

**Unverified and must be checked at runtime:** that
`containerURL(forSecurityApplicationGroupIdentifier: "7PVYUG4YQS.com.relayium.shared")` returns
non-nil in a signed, provisioned macOS build. `AppGroup` fails closed, so the symptom of a wrong
identifier is an honest refusal on screen rather than silent data loss — but it is still the
first thing to confirm on the installed build.

---

## Settled decision 2 — do not move the iOS view layer in this slice

`apps/ios/RelayiumShare/ShareRootView.swift` (178 lines, `ShareRootView` +
`ShareUnavailableView`) imports only SwiftUI and `RelayiumShareKit`. It is **fully portable**,
and this codebase's own principle — "one copy, two clients", stated in `AppCopy.swift` — argues
for moving it into the shared package.

It is nevertheless **out of scope here**, for one reason: the iOS Share extension is shipped and
owner-accepted (OA-005, verified on a physical iPad), and moving its view layer cannot be
re-verified without that device. A refactor whose regression can only be caught on hardware the
executor does not have does not belong in the same slice as a new target.

**Therefore:** write a macOS-local view, and keep the duplication honest — both platforms use
the *same* `L10n` keys and the *same* `SharedDraftPreparation` model, so only layout is
duplicated, not copy and not behaviour. Record unification as a follow-up with the trigger
"next time the iOS extension is being verified on a device anyway".

macOS's view legitimately differs where the platform does: a fixed sheet size instead of an
iPhone-height `ScrollView`, and standard macOS button placement. The iPhone-specific reasoning
in the iOS file (Dynamic Type at accessibility sizes on an SE) does not transfer.

---

## What the slice contains

**New — `apps/mac/RelayiumShare/`:**

| file | responsibility |
|---|---|
| `Info.plist` | `NSExtensionPointIdentifier = com.apple.share-services`, a **dictionary** `NSExtensionActivationRule` (never `TRUEPREDICATE`), principal class not a storyboard, the nine `CFBundleLocalizations`, non-empty `CFBundleDisplayName` |
| `RelayiumShare.entitlements` | sandbox + **exactly one** App Group. No keychain group, no associated domains, no network client |
| `ShareViewController.swift` | `NSViewController` principal class; the macOS twin of the iOS shell — read providers, host one SwiftUI view, adapt `NSExtensionContext` to `SharedDraftHost` |
| `ShareRootView.swift` | the macOS surface, same states and same keys as iOS |

**Changed:**

- `apps/RelayiumKit/Sources/RelayiumShareKit/AppGroup.swift` — the platform split above.
- `apps/mac/Relayium/Relayium.entitlements` — gains
  `com.apple.security.application-groups`, so the app can read what the extension writes.
  **This changes the signed app's entitlements**, which `macos.yml`'s "Verify signature and
  entitlements" step inspects; expect to update that step's expectations.
- `apps/mac/Relayium.xcodeproj/project.pbxproj` — a second native target, its build
  configurations (`PROVISIONING_PROFILE_SPECIFIER = "Relayium Mac Share Extension"`,
  `PRODUCT_BUNDLE_IDENTIFIER = com.relayium.mac.Share`, manual signing, Developer ID), and an
  Embed Foundation Extensions phase. Mirror `apps/ios/Relayium.xcodeproj`'s `B10000…` structure
  with `A10000…` ids.
- `.github/workflows/macos.yml` — install the **second** profile from
  `MACOS_SHARE_PROVISIONING_PROFILE_BASE64`, and extend signature verification to the embedded
  appex.
- The macOS app must **read** staged drafts. `SharedDraftStore.drafts()` /
  `stagedFiles(for:)` / `retire(id:)` already exist and are what iOS uses. The staged files then
  enter the send flow through **the seam B3-1 built** (`AppFileOpenRouter`), so a shared draft
  and an opened file take one path instead of two.

**Not in scope:** `NSServices`, Quick Actions, Finder Sync.

---

## Risks, in the order they will bite

1. **`project.pbxproj` is hand-maintained** with synthetic ids and a
   `PBXFileSystemSynchronizedRootGroup`. It is also the file Xcode rewrites on open — on
   2026-08-06 it silently downgraded `objectVersion` 77 → 70 and had to be restored. Edit it by
   hand, and re-check `git diff` for reformatting before committing.
2. **The app's entitlement change touches the signed release**, which is the pipeline the launch
   depends on. Verify a signed Release build's entitlements before and after.
3. **Notarization must accept the embedded appex.** Its signature, hardened runtime and
   timestamp are separate gates from the app's, per `PROJECT-GOVERNANCE.md` § native release
   evidence.
4. **The Share menu entry cannot be seen without an installed app** — see the top of this file.

## Acceptance

- `swift build --build-tests`, the full Swift suite, and the iOS Simulator build (the AppGroup
  split touches iOS's package) all green.
- A signed universal Release whose embedded appex passes `codesign --verify --strict`, carries
  the hardened runtime and a secure timestamp, and whose entitlements are exactly the one App
  Group.
- On an **installed** build: Relayium appears in Finder's Share menu, a share stages a draft,
  and the app shows those files on a send surface without the user re-picking them.
- Source guards mirroring `IOSSurfaceGuardTests`' absences for the new target: no `URLSession`,
  no `AccountSession`, no `bearerToken`, no Keychain, no `NSExtensionContext.open`.
