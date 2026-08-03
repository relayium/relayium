# Native iOS R3-A — anonymous stored receive — design

Date: 2026-08-03
Milestone: R3-A, the first iOS vertical slice. Development only. Not public.

## Outcome

An iPhone or iPad user who was sent an encrypted Relayium stored link can paste
it into a native app, see what the link actually contains before spending
anything, download the files into an app-owned folder, and hand the finished
result to the rest of iOS through the system share sheet — including *Save to
Files*.

This is the smallest slice that is genuinely useful rather than a placeholder.
It exercises the whole shared stack end to end on iOS: `parseTransferLink` →
`CloudClient.fetchMeta` → `decryptManifest` → `ManifestWriter` →
`ReceivedPayload`. Every layer below the view is the code the macOS app and the
CLI already use; nothing about the wire, the crypto, or the destination
discipline is re-implemented for iOS.

It deliberately stops there. The rest of R3 — sending, realtime, accounts,
background transfer, Share Extension, notifications, App Store — is out of
scope and stays out.

## Non-negotiable invariants

These were fixed before implementation because this slice sits on a data-loss
and privacy boundary.

1. **The wire is untouched.** No change to the stored wire protocol, the crypto,
   link-key handling, the server APIs, or any server/web code. Relayium's
   servers never gain plaintext or fragment keys — the fragment is parsed on
   device and never leaves it, exactly as `parseTransferLink` already
   guarantees.
2. **Nothing sensitive is logged or persisted.** The full link, the fragment
   key, manifest filenames, and plaintext contents are never written to a log,
   a defaults key, or any file other than the received files themselves. There
   is no analytics of any kind in this app.
3. **A result is exposed only after `ManifestWriter.finish()` returns.** The
   share affordance is rendered from `model.received`, which is non-nil only in
   `.done`, which the model reaches only after `finish()` succeeded. The
   existing no-overwrite, path-validation, and partial-cleanup behavior is used
   as-is and is not relaxed.
4. **Nothing already on disk is overwritten, merged into, or deleted.**
   Received files land in an app-owned sublocation of the app's own
   `Documents`. What a taken name produces depends on the shape being received
   and is the shared behavior, unchanged: a single flat file **refuses**, the
   opaque `relayium-<id>` container **refuses** rather than merge, and a
   received folder **steps aside** to `<name> (2)`. None of the three replaces
   or merges into what is there, so the preexisting item keeps its bytes under
   its own name — that, not blanket refusal, is the invariant. See the table
   under *App-owned Documents behavior*.
5. **Burn-after-read is stated before it costs anything.** The warning is
   rendered in the `.ready` state, above the download action, so the user reads
   it before the network call that consumes the link.
6. **The pasteboard is never read implicitly.** No `UIPasteboard` access at
   launch, on foreground, or anywhere else. The user pastes into an ordinary
   `TextField` with the system's own paste affordance, which is a deliberate
   user action and shows the standard paste indicator.
7. **No availability claim.** iOS is not published, not listed as available,
   and the macOS release approval (`apps/mac/release-readiness.json`,
   `approved: false`) is untouched.

### Adversarial acceptance case

Because the iOS destination is a *fixed* folder rather than a folder the user
picks each time, a second receive of the same link is not a corner case — it is
what the second tap does. The acceptance case is therefore the second receive,
and what it must do depends on the shape:

- **a single flat file** whose name is taken, and **several flat files** whose
  `relayium-<id>` container is taken, must **fail** — without changing the
  existing bytes and without presenting a partial result as completed. These
  two are covered by tests at the model level (see *Testing*).
- **a nested folder** whose name is taken must land under `<name> (2)`,
  atomically, again without touching the existing tree. This is existing
  behavior, already covered by `FolderReceiveTests`; this slice neither changes
  it nor re-asserts it.

In every shape the assertion is the same one: whatever was already on disk is
still there, unchanged, under its own name.

## Scope

In:

- one screen, one flow: paste link → resolve → inspect → download → share;
- anonymous only (a stored link needs no account, and this slice adds none);
- the app-owned `Documents/Received` destination, exposed through Files;
- native `ShareLink` over `ReceivedPayload.dragURLs`;
- the same nine languages the package and the macOS app already ship;
- CI that builds the app for the generic iOS Simulator on every `apps/**` change.

Out (non-goals for this slice, in the order they are most likely to be asked
for):

- account login/management and native Sign in with Apple;
- uploads/sending, realtime pairing, ephemeral text, LAN/nearby;
- Share Extension;
- background `URLSession` and lifecycle-safe resume;
- local notifications and APNs;
- StoreKit/IAP, App Store release, icons, store metadata;
- Associated Domains and universal-link handoff;
- any website availability flip, server, web, or `relayium-ops` change.

## State flow

One app-scoped `CloudDownloadModel`, reused verbatim from `RelayiumAppKit`. The
iOS view renders its existing `DownloadState` and adds no state of its own:

```
.idle        link field + Open (disabled while empty)
   │ resolve()
.resolving   indeterminate progress + Cancel
   │ meta fetched, manifest decrypted on device
.ready       summary · safe file names · burn warning · expiry · Download
   │ download(into: Documents/Received)
.downloading determinate progress + Cancel
   │ finish() returned
.done        saved summary · where it went · ShareLink over dragURLs
   │
.failed      localized message (from ErrorCopy) + the link field, still editable
```

The model is app-scoped rather than view-scoped for the same reason it is on
macOS: a transfer must survive the view tree being rebuilt. `cancel()` is wired
to both busy states and returns the model to `.idle`.

`Cancel` in `.downloading` goes through the model's existing cancellation, which
discards a partial write. A cancelled transfer therefore leaves nothing behind
and is never presented as a result.

## App-owned Documents behavior

The destination is `<app container>/Documents/Received`.

- `Documents` is obtained from `FileManager` (`.documentDirectory`,
  `.userDomainMask`), never hard-coded. In the app sandbox that is the app's own
  container.
- `Received` is a fixed, unlocalized directory name. A localized directory name
  would move when the user changed language and orphan everything already
  saved.
- `Info.plist` sets `UIFileSharingEnabled` and
  `LSSupportsOpeningDocumentsInPlace`, which is what makes the folder appear as
  *On My iPhone ▸ Relayium* in the Files app, browsable and manageable by the
  user without the app.
- The directory is created on demand with `withIntermediateDirectories: true`,
  which is idempotent and does not disturb an existing directory.

What lands inside it follows the shared rules already implemented in
`CloudDownloadModel.download(into:)` — iOS gains no variant of them:

| Manifest shape | Destination | Collision |
|---|---|---|
| one flat file | `Received/<name>` | **refuses** (`fileExists`), existing bytes untouched |
| several flat files | `Received/relayium-<id>/` | **refuses** (`directoryExists`), existing container untouched |
| any nested path | `Received/<folder>/`, hierarchy preserved | steps aside to `<folder> (2)`, never merges, never deletes |

The folder case uniquifies rather than fails because receiving a folder called
`photos` twice is ordinary; the opaque `relayium-<id>` box does not, because a
second one of those means something is already wrong. All three preserve the
preexisting item, which is the invariant — not the refusal, which only two of
them use. This is existing, tested behavior and this slice does not change it —
it only makes the *fixed*-destination case the common one, which is why the
adversarial test is added at the model level.

What iOS does change is the **recovery advice**, not the outcome — and it has to
change it in more than the collision cases. `ErrorCopy` was written behind an
`NSOpenPanel`, and that assumption reaches five of its `DownloadDestinationError`
arms: four end in *choose / try another folder*, and two of those also describe
*the folder you chose*, which on iOS nobody did. `ReceiveDestinationCopy`
re-words exactly those five:

| case | shared wording that does not hold | iOS wording |
|---|---|---|
| `fileExists` | *Choose another folder* | rename or remove the item in the Files app, then download again |
| `directoryExists` | *Choose another folder* | as above, keeping the shared reason it will not merge |
| `unsafeName` | written *outside the folder you chose* | the link asked for an unsafe path, nothing was saved, ask the sender for a new link — no folder named at all |
| `systemError(EACCES/EPERM)` | *Choose another folder* | Relayium cannot write to its own receive folder in Files; retry, and report it if it persists |
| `systemError(other)` | *Try another folder* | as above, with the errno kept — the only diagnosable part, and the thing worth reporting |

Everything whose advice does not depend on a picker stays shared and is deferred
to `ErrorCopy` byte for byte: `systemError(ENOSPC)` (*free up space and try
again*), `incomplete` and `exceedsManifest` (*ask the sender to try again*), and
every non-destination error. macOS's wording is untouched — the shared
`error.destination.*` strings are not edited, only added beside.

## Native share / Files handoff

`.done` renders a `ShareLink(items: payload.dragURLs)`.

`ReceivedPayload` is reused rather than re-derived, and that reuse is the whole
point: a folder or multi-file receive offers its **container** as one item, so
*Save to Files* copies the tree in one piece and the hierarchy survives the last
step. Offering the individual files would flatten exactly what the folder
feature exists to preserve.

The share affordance is rendered only in `.done`, only from `model.received`,
and therefore only after `finish()` returned.

## Localization

The app links `RelayiumAppKit` and renders every string through `L10n`. It adds
no catalog of its own; the nine `.lproj` catalogs in the package bundle serve
both apps.

`Info.plist` declares the same nine `CFBundleLocalizations` as macOS. This is
load-bearing rather than cosmetic: the catalogs live in the *package* bundle, so
without this list iOS treats the app bundle as English-only, and
`UIApplication.userInterfaceLayoutDirection` — which is what SwiftUI's
`\.layoutDirection` follows — never becomes right-to-left. An Arabic user would
get correct Arabic words laid out backwards.

Ten new keys are added to all nine catalogs, because iOS says things macOS does
not:

| Key | Why macOS's key does not fit |
|---|---|
| `common.share` | macOS reveals in Finder and drags out; iOS shares |
| `download.receive` | macOS's `download.save` is `Save…`, which promises a picker iOS does not show |
| `download.resolving` | macOS shows a bare spinner; a touch UI needs a labelled status, and VoiceOver needs one on both platforms |
| `download.inProgress` | as above, for the transfer itself |
| `download.savedLocation` | macOS says "Reveal in Finder"; iOS has to say where the files actually are, by their full route in Files |
| `error.destination.fileExists.filesApp` | the shared key ends in *choose another folder*; iOS has no picker, so the recovery has to be "rename or remove it in Files" |
| `error.destination.directoryExists.filesApp` | as above, keeping the shared reason it will not merge |
| `error.destination.unsafeName.filesApp` | the shared key says the file would land *outside the folder you chose*; on iOS that is false in its subject as well as its advice |
| `error.destination.notPermitted.filesApp` | the shared key ends in *choose another folder*; the folder here is the app's own and fixed, so the only honest recovery is retry-then-report |
| `error.destination.systemError.filesApp` | as above, keeping the errno |

The two collision keys take `%1$@` (the colliding name) and `%2$@` (the folder's
path in the Files app); `unsafeName.filesApp` takes the unsafe path,
`notPermitted.filesApp` the folder path, and `systemError.filesApp` the folder
path and the errno. `download.savedLocation` takes `%@`, the same folder path,
for the success case. Every one of them is interpolated through `L10n.token`, so
nothing raw reaches the screen and Arabic lays each out as one unit.
`ReceiveDestinationCopy` chooses the path: `Relayium/Received` for a collision
inside the receive folder, for any write failure, and for the done state,
`Relayium` for the one case that can occupy the receive folder's own name. The
shared `error.destination.*` keys are unchanged, so macOS's wording does not
move.

The done state goes through `ReceiveDestinationCopy.savedLocation()` rather than
`L10n` directly, for the reason the route is interpolated at all: written out in
nine translations it was free to stop at `Relayium`, the app's own folder, which
holds the receive folder rather than the files. One tap short, on the one
sentence the user acts on after the transfer.

No user-facing English literal exists in the iOS sources.
`LocalizationSourceGuardTests` is extended to scan `apps/ios/Relayium` so that
stays true.

## Accessibility and layout

- Dynamic Type: no fixed font sizes, no fixed frames, no desktop width
  assumptions. The layout is a `Form`/`ScrollView` that reflows.
- RTL: platform layout only — leading/trailing, no left/right — so Arabic is
  laid out by the system rather than by the app.
- VoiceOver: the two progress states carry text labels rather than a bare
  spinner; the file list is readable; the burn warning is a normal text element
  in reading order above the action, not a decorative footnote.
- Technical values (file names) go through `safeDisplayName` for control/bidi
  stripping, exactly as the macOS pane does.

## CI

A new `ios-build` job in the existing macOS-hosted workflow
(`.github/workflows/macos.yml`), which already triggers on `apps/**`. It builds
the app for `generic/platform=iOS Simulator` with `CODE_SIGNING_ALLOWED=NO`.

It uses no secrets, so it runs on fork pull requests like the `test` job, and it
attempts no distribution. It reuses the checkout action already pinned in that
workflow, so no new third-party action is introduced.

## Testing

Package tests (`swift test`), because the app target holds no logic worth
testing without UI:

- `ReceiveDestinationTests` — the app-owned directory helper: creates on demand,
  is idempotent, refuses to follow a non-directory sitting at the name, and
  never returns a path outside the documents directory it was given.
- `CloudDownloadModelContainerTests` gains the adversarial case for the two
  shapes that refuse: a second receive into a destination that is already taken
  fails, the preexisting bytes are unchanged, and `model.received` stays nil so
  no partial result is presented as complete. The single-flat-file and the
  multi-flat-container shapes only — the nested-folder shape does not fail, and
  its step-aside is covered by `FolderReceiveTests`. It also asserts that a
  model built with the iOS copy renders the actionable Files-app recovery for
  that refusal rather than the shared *choose another folder*.
- `ReceiveDestinationCopyTests` — the iOS copy itself, in all nine languages: the
  shared copy really does give the advice this replaces (both picker wordings,
  and the *folder you chose* claim); no re-worded case names a picker; the two
  collision errors name the colliding item and the Files-app folder and keep the
  shared reason for refusing to merge; `unsafeName` blames the link and names no
  folder; the two write failures name the fixed receive folder, with the errno
  kept for the generic one; nothing leaves a `%@` on screen; Arabic isolates
  every interpolation without altering it; and `ENOSPC`, `incomplete`,
  `exceedsManifest` and every non-destination error are `ErrorCopy`'s byte for
  byte, with `ENOSPC` pinned to the shared key itself.
- `LocalizationIntegrityTests` gains the iOS `CFBundleLocalizations` assertion,
  mirroring the macOS one.
- `LocalizationSourceGuardTests` scans the iOS sources and asserts every root
  actually contributed files, so a rename cannot silently empty one.

Build acceptance:

- `xcodebuild -scheme RelayiumKit -destination 'generic/platform=iOS Simulator'`
  — the package and `RelayiumAppKit` build for iOS.
- `xcodebuild -project apps/ios/Relayium.xcodeproj -scheme Relayium
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build`
  — the app builds clean and unsigned.
- `plutil -lint` on the `Info.plist`, the entitlements, and all nine catalogs.
- `apps/mac/scripts/test-release-readiness.sh` still passes and the macOS
  manifest is still `approved: false`.

Done by hand, on the iPhone 17 Pro simulator: the unsigned Debug build installs,
launches, stays running, renders the package catalogs, and lays out Arabic
right-to-left — which is the evidence that the `CFBundleLocalizations` list
above is doing its job.

Manual validation this slice does **not** claim, and which is recorded as
outstanding rather than asserted:

- a real end-to-end receive against a live link;
- the `Received` folder appearing under *On My iPhone ▸ Relayium* in the Files
  app. `UIFileSharingEnabled` + `LSSupportsOpeningDocumentsInPlace` is the
  documented way to get it, but this build has not been looked at in Files;
- that *Save to Files* accepts a **directory** item from the share sheet (it is
  offered; the copy behavior for folders is worth seeing once);
- VoiceOver and Dynamic Type at the largest accessibility sizes.

## Later milestones

R3-A is the foundation. In the order they unlock the most:

- **R3-B — link handoff.** Associated Domains + `parseAppDeepLink` routing, so a
  tapped `relayium.com/d/…` link opens the app. Deliberately separate: the
  entitlement is a trust boundary and the app must not claim it before the
  routing exists.
- **R3-C — sending.** Files/Photos picker → `CloudUploadModel`, then the Share
  Extension, which is the native way iOS users start a transfer.
- **R3-D — accounts.** Session restore, device list, stored-file management,
  native Sign in with Apple.
- **R3-E — realtime.** Pairing code, LAN/nearby (needs the local-network
  permission and its usage string), SAS verification.
- **R3-F — lifecycle.** Background `URLSession` and resume, then local
  notifications and APNs.
- **R3-G — release.** Icons, store metadata, IAP, App Store submission, and only
  then the website availability flip.
