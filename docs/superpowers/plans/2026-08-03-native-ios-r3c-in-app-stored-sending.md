# Native iOS R3-C — in-app stored sending — Implementation Plan

Date: 2026-08-03

**Goal:** Add a real **Send** tab to the iOS app: pick files, folders, photos or
videos from inside the app, upload them end-to-end encrypted to the signed-in
account through the existing `CloudUploadModel`, and hand the resulting link to
the system share sheet. A user who cannot send is told why and routed to
Account. A user who never signs in keeps the anonymous receive R3-A shipped,
unchanged and structurally independent. Nothing account-owned survives the
account that produced it, whether or not the Send tab is on screen.

**Architecture:** The macOS send path, reused whole — `SelectionStore` →
`expandSelection` → `CloudUploadModel` → `stageCloudFiles` → `CloudUploader`.
The package gains four new files: a security-scope lifecycle owner; a photo
inbox whose candidates own their own bytes by ARC plus a per-launch staging
area; three pure presentation seams; and one app-scoped model that owns
selection, resources, session observation, account isolation and the advisory
config fetch. The iOS app target gains one view file plus a stateless
`Transferable` shim.

**Tech stack:** Swift 5.9 / SwiftPM local package, SwiftUI lifecycle, Combine
for the session subscription, iOS 16 minimum, XCTest.

**Spec:** `docs/superpowers/specs/2026-08-03-native-ios-r3c-in-app-stored-sending-design.md`

**Topology:** Claude authors the implementation; Codex reviews, validates,
delivers and verifies. **Claude does not commit or push.** Each task ends at a
checkpoint with executable evidence; a single English commit is made by Codex
after independent review — see *Delivery*.

## Global constraints

- **Anonymous receive stays structurally independent.** `RootView` never reads
  `session.state`; `ReceiveView` references neither `AccountSession` nor
  `bearerToken`; the receive tab renders in every session state.
- **Every started security scope is stopped.** All calls to
  `startAccessingSecurityScopedResource` / `stopAccessingSecurityScopedResource`
  live in `SystemSecurityScopedResource`, in the package. No iOS source calls
  them.
- **No whole-file `Data` for a photo, and no second byte copy.**
  `FileRepresentation` only; the provider file is copied once into an owned
  inbox directory and then *moved* into the batch on the same `tmp` filesystem.
- **Every copied byte has exactly one owner, released by ARC.** `PhotoCandidate`
  owns its inbox directory and frees it exactly once — on `discard()`, on a
  successful transfer to the staging area, or in `deinit`. **There is no runtime
  inbox sweep**; the single sweep happens at app-scoped model construction, for
  crash leftovers.
- **No global mutable import context.** The static `Transferable` closure calls
  one narrow package function. No shared "current batch", no `TaskLocal`, no
  mutable static in `PhotoStaging.swift`.
- **A newer picker intent always supersedes an older one.** `upload.isBusy` is
  the only condition that refuses a new selection. The UI disables controls
  during a normal import as a courtesy; the model's guards defend against late
  callbacks and programmatic races.
- **Account work is app-scoped and session-driven**, never owned by a view's
  `.task`. Isolation is synchronous on the main actor; the config fetch is an
  independent, cancellable task guarded by generation **and** ready-user id.
- **The bearer is read once at tap time and held no longer than the upload.**
  The view stores it in no `@State`, stored property or `@Published`;
  `CloudUploadModel.start(token:)` captures it for that one authenticated upload
  task, and nothing else does. No `print`, `NSLog`, `os_log`, `debugPrint` or
  `dump` in `apps/ios/Relayium` or `Sources/RelayiumAppKit`.
- **No new capability.** `Relayium.entitlements` keeps an empty `<dict/>` (only
  its comment changes). No `NSPhotoLibraryUsageDescription`, no
  `UIBackgroundModes`, no Associated Domains, no App Group, no Share Extension
  target, no push, no IAP.
- **Foreground-only, stated.** No background `URLSession`, no resume claim, no
  invented `DELETE` for an upload session.
- **Nine languages, always.** Every new and corrected string lands in all nine
  catalogs. `CFBundleLocalizations` unchanged. No user-facing English literal in
  Swift sources; a genuinely verbatim literal carries
  `// nonlocalized: <reason>`.
- **Layout by construction.** No fixed font sizes, no fixed frames, no
  left/right — leading/trailing only.
- **No availability claim.** No `DEVELOPMENT_TEAM`, no provisioning profile, no
  signing. `apps/mac/release-readiness.json` stays `approved: false`. No web,
  server, AASA or `relayium-ops` change. Do not touch the untracked `output/`
  directory.

## File structure

| File | Responsibility |
|---|---|
| `apps/RelayiumKit/Sources/RelayiumAppKit/SecurityScopedAccess.swift` | **new** — the start/stop contract, owned and balanced |
| `apps/RelayiumKit/Sources/RelayiumAppKit/PhotoStaging.swift` | **new** — `PhotoCandidate` (ARC-owned lease), `PhotoInbox`, `PhotoStagingArea`/`Batch`, naming, launch sweep |
| `apps/RelayiumKit/Sources/RelayiumAppKit/SendPresentation.swift` | **new** — `SendAvailability`, `SendAccountContext`, `UploadCaps`, `PhotoPickerChange` |
| `apps/RelayiumKit/Sources/RelayiumAppKit/SendSelectionModel.swift` | **new** — selection, resources, supersession, session observation, account isolation, config task, published render state |
| `apps/RelayiumKit/Sources/RelayiumAppKit/AppEnvironment.swift` | `makeSendSelectionModel(baseURL:upload:)`, wiring the real config fetcher |
| `apps/RelayiumKit/Sources/RelayiumAppKit/CloudUploadModel.swift` | `apply(_ caps:)`; one comment corrected |
| `apps/RelayiumKit/Sources/RelayiumAppKit/UploadPresentation.swift` | comments corrected (device, not Mac) |
| `apps/RelayiumKit/Sources/RelayiumAppKit/FileSelection.swift` | **comment only** — "Absolute location on this Mac" |
| `apps/RelayiumKit/Sources/RelayiumAppKit/Localization/L10nKey.swift` | nine new keys |
| `apps/RelayiumKit/Sources/RelayiumAppKit/Resources/*.lproj/Localizable.strings` | nine new keys ×9, five corrected ×9 |
| `apps/ios/Relayium/RelayiumApp.swift` | app-scoped key store, upload model, send model, `observe(account.$state)` |
| `apps/ios/Relayium/RootView.swift` | three tabs; the Account-routing closure |
| `apps/ios/Relayium/SendView.swift` | **new** — the gate and the upload flow |
| `apps/ios/Relayium/StagedPhotoFile.swift` | **new** — stateless `Transferable` shim |
| `apps/ios/Relayium/Relayium.entitlements` | **comment only** — the dict stays empty |
| `apps/RelayiumKit/Tests/RelayiumKitTests/SecurityScopedAccessTests.swift` | **new** |
| `apps/RelayiumKit/Tests/RelayiumKitTests/PhotoStagingTests.swift` | **new** |
| `apps/RelayiumKit/Tests/RelayiumKitTests/SendPresentationTests.swift` | **new** |
| `apps/RelayiumKit/Tests/RelayiumKitTests/SendSelectionModelTests.swift` | **new** |
| `apps/RelayiumKit/Tests/RelayiumKitTests/CloudUploadModelTests.swift` | reconciled key-notice assertions, `apply(_:)` |
| `apps/RelayiumKit/Tests/RelayiumKitTests/LocalizedCopyTests.swift` | corrected copy ×9, new keys ×9, iOS send surface |
| `apps/RelayiumKit/Tests/RelayiumKitTests/IOSSurfaceGuardTests.swift` | deliberate update: 22 → 17 guarded keys, new guards, corrected doc comment |
| `README.md` | truthful delivery status |

`apps/ios/Relayium.xcodeproj` needs **no** edit: the target uses a
`PBXFileSystemSynchronizedRootGroup`, so the two new Swift files are picked up
by path. `.github/workflows/macos.yml` needs no edit — its `ios-build` job
already triggers on `apps/**`.

## Tasks

### Task 1: The security-scope lifecycle seam

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumAppKit/SecurityScopedAccess.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/SecurityScopedAccessTests.swift`

**Interfaces:**
- Produces: `SecurityScopedResourceAccessing`, `SystemSecurityScopedResource`,
  `SecurityScopedAccess(resource:)`, `replace(with:) -> [URL]`, `clear()`,
  `heldURLs`, `startedURLs`.

- [ ] **Step 1: Write the failing tests**

Create `SecurityScopedAccessTests.swift`. The fake records every call so the
balance is countable rather than inferred:

```swift
import XCTest
@testable import RelayiumAppKit

/// Records what the sandbox was actually asked for. Not `@MainActor`: the type
/// under test releases from `deinit`, which cannot touch isolated state.
private final class RecordingResource: SecurityScopedResourceAccessing, @unchecked Sendable {
    private let lock = NSLock()
    private var _started: [String] = []
    private var _stopped: [String] = []
    /// Paths whose start should fail, as a real denied scope would.
    let refuse: Set<String>

    init(refuse: Set<String> = []) { self.refuse = refuse }

    func startAccess(to url: URL) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if refuse.contains(url.path) { return false }
        _started.append(url.path)
        return true
    }
    func stopAccess(to url: URL) {
        lock.lock(); defer { lock.unlock() }
        _stopped.append(url.path)
    }
    var started: [String] { lock.lock(); defer { lock.unlock() }; return _started }
    var stopped: [String] { lock.lock(); defer { lock.unlock() }; return _stopped }
}

private func url(_ path: String) -> URL { URL(fileURLWithPath: path) }

final class SecurityScopedAccessTests: XCTestCase {

    func testReplaceStartsEveryDistinctURLOnce() {
        let r = RecordingResource()
        let a = SecurityScopedAccess(resource: r)
        let kept = a.replace(with: [url("/tmp/one"), url("/tmp/two")])
        XCTAssertEqual(kept.map(\.path), ["/tmp/one", "/tmp/two"])
        XCTAssertEqual(r.started, ["/tmp/one", "/tmp/two"])
        XCTAssertEqual(r.stopped, [])
    }

    /// Two spellings of one path take two sandbox extensions if started twice,
    /// and then need two stops. De-duplicating first — by the same standardized
    /// path `expandSelection` de-duplicates roots by — means one of each.
    func testTheSamePathTwiceInOneBatchStartsOnce() {
        let r = RecordingResource()
        let a = SecurityScopedAccess(resource: r)
        let kept = a.replace(with: [url("/tmp/one"), url("/tmp/./one"), url("/tmp/one")])
        XCTAssertEqual(kept.count, 1)
        XCTAssertEqual(r.started, ["/tmp/one"])
        a.clear()
        XCTAssertEqual(r.stopped, ["/tmp/one"])
    }

    func testASecondReplaceStopsExactlyTheFirstBatch() {
        let r = RecordingResource()
        let a = SecurityScopedAccess(resource: r)
        a.replace(with: [url("/tmp/one"), url("/tmp/two")])
        a.replace(with: [url("/tmp/three")])
        XCTAssertEqual(r.started, ["/tmp/one", "/tmp/two", "/tmp/three"])
        XCTAssertEqual(r.stopped, ["/tmp/one", "/tmp/two"])
        XCTAssertEqual(a.heldURLs.map(\.path), ["/tmp/three"])
    }

    /// A refused start consumed no extension. Stopping it anyway is unbalanced
    /// in the other direction, and on a real sandbox that is not a no-op.
    func testARefusedStartIsNeverStopped() {
        let r = RecordingResource(refuse: ["/tmp/denied"])
        let a = SecurityScopedAccess(resource: r)
        let kept = a.replace(with: [url("/tmp/ok"), url("/tmp/denied")])
        // Both are still handed to the caller: the denied one fails visibly at
        // enumeration, with copy that names it.
        XCTAssertEqual(kept.map(\.path), ["/tmp/ok", "/tmp/denied"])
        XCTAssertEqual(a.startedURLs.map(\.path), ["/tmp/ok"])
        a.clear()
        XCTAssertEqual(r.stopped, ["/tmp/ok"])
    }

    func testClearIsIdempotent() {
        let r = RecordingResource()
        let a = SecurityScopedAccess(resource: r)
        a.replace(with: [url("/tmp/one")])
        a.clear(); a.clear()
        XCTAssertEqual(r.stopped, ["/tmp/one"])
        XCTAssertTrue(a.heldURLs.isEmpty)
    }

    /// The release path that must not be skippable. A `@MainActor` owner could
    /// not do this at all — a deinit cannot touch isolated state.
    func testDeallocationReleasesWhatWasHeld() {
        let r = RecordingResource()
        do {
            let a = SecurityScopedAccess(resource: r)
            a.replace(with: [url("/tmp/one"), url("/tmp/two")])
            XCTAssertEqual(r.stopped, [])
        }
        XCTAssertEqual(r.stopped.sorted(), ["/tmp/one", "/tmp/two"])
    }

    func testAnEmptyReplaceReleasesEverything() {
        let r = RecordingResource()
        let a = SecurityScopedAccess(resource: r)
        a.replace(with: [url("/tmp/one")])
        XCTAssertEqual(a.replace(with: []).count, 0)
        XCTAssertEqual(r.stopped, ["/tmp/one"])
    }
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/RelayiumKit && swift test --filter SecurityScopedAccessTests`
Expected: compile failure — `SecurityScopedResourceAccessing` and
`SecurityScopedAccess` are undefined.

- [ ] **Step 3: Write the implementation**

Create `SecurityScopedAccess.swift`. Requirements the tests encode: dedupe by
`standardizedFileURL.path` **before** any start; keep the caller's order;
remember only successful starts; `replace` records the new batch and *then*
releases the old; `clear()` and `deinit` share one non-isolated release path
guarded by an `NSLock`; `final class` marked `@unchecked Sendable`, never
`@MainActor`.

Document at the top, in prose the next reader needs:

> `fileImporter` hands back security-scoped URLs. Apple's contract is that every
> successful `startAccessingSecurityScopedResource()` must be balanced by a
> `stopAccessingSecurityScopedResource()`, that the final stop revokes access
> immediately, and that leaked scopes exhaust a finite per-process resource.
> That contract cannot live in a SwiftUI view: SwiftUI decides when a view is
> rebuilt, and a view cannot be unit-tested. It lives here, with one operation —
> `replace` — because an API that could start scopes without taking ownership of
> them would have a leak path in its own shape.

- [ ] **Step 4: Checkpoint**

Run: `cd apps/RelayiumKit && swift test --filter SecurityScopedAccessTests`
Expected: PASS. Record the output. Do not commit.

### Task 2: Photo candidates that own their own bytes

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumAppKit/PhotoStaging.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/PhotoStagingTests.swift`

**Interfaces:**
- Produces: `PHOTO_IMPORT_MAX`, `stagedFileName(suggested:taken:)`,
  `PhotoCandidate` (`url`, `suggestedName`, `discard()`, internal
  `relinquish() -> URL?`, `deinit`), `PhotoImportError`,
  `PhotoInbox.directory(_:)` / `.take(_:in:_:)` / `.sweepLeftovers(_:_:)`,
  `PhotoStagingBatch`, `PhotoStagingArea(root:fileManager:)`,
  `PhotoStagingArea.launchRoot(in:)`,
  `sweepOtherLaunches(under:keeping:fileManager:)`, `makeBatch()`,
  `adopt(_:into:)`, `adoptBatch(_:)`, `discard(_:)`, `clear()`.

The split exists because `Transferable.transferRepresentation` is **static** and
`loadTransferable(type:)` takes only a type: nothing per-import can be injected
into the import closure. `PhotoInbox.take` is the whole of what the static
closure may do, and it needs no context because each candidate gets its own UUID
directory — which it then **owns**.

- [ ] **Step 1: Write the failing tests**

Create `PhotoStagingTests.swift`. Three halves: table-driven naming, ownership,
and staging on a real temporary filesystem.

*Naming*

```swift
    func testStagedNamesAreSafeAndUnique() {
        XCTAssertEqual(stagedFileName(suggested: "IMG_1.HEIC", taken: []), "IMG_1.HEIC")
        // A separator must not be able to escape the batch directory.
        XCTAssertEqual(stagedFileName(suggested: "a/b/IMG_1.HEIC", taken: []), "IMG_1.HEIC")
        XCTAssertEqual(stagedFileName(suggested: "  ", taken: []), "photo")
        XCTAssertEqual(stagedFileName(suggested: "", taken: []), "photo")
        // Two photos with one provider name are the case that would otherwise
        // make the app emit a manifest its own receive side rejects.
        XCTAssertEqual(stagedFileName(suggested: "IMG_1.HEIC", taken: ["IMG_1.HEIC"]),
                       "IMG_1 (2).HEIC")
        XCTAssertEqual(stagedFileName(suggested: "IMG_1.HEIC",
                                      taken: ["IMG_1.HEIC", "IMG_1 (2).HEIC"]),
                       "IMG_1 (3).HEIC")
    }

    /// A provider name that is ONLY an extension. The split happens at the last
    /// dot, so the stem is EMPTY — not "mov" — and an empty stem becomes
    /// `photo`. Getting this wrong turns every such item into an extensionless
    /// file called "mov", which the receiving side cannot open by type.
    func testANameThatIsOnlyAnExtension() {
        XCTAssertEqual(stagedFileName(suggested: ".mov", taken: []), "photo.mov")
        XCTAssertEqual(stagedFileName(suggested: ".HEIC", taken: []), "photo.HEIC")
        XCTAssertEqual(stagedFileName(suggested: ".mov", taken: ["photo.mov"]),
                       "photo (2).mov")
        // A leading dot on a name that HAS an extension is stripped from the
        // stem instead, so nothing lands hidden.
        XCTAssertEqual(stagedFileName(suggested: ".IMG_1.HEIC", taken: []), "IMG_1.HEIC")
    }

    /// Truncation removes whole Characters. A byte slice can split a scalar or
    /// a grapheme cluster and produce a name with a replacement character in it.
    func testTruncationNeverSplitsAMultibyteCharacter() {
        let name = stagedFileName(suggested: String(repeating: "写", count: 300) + ".mov",
                                  taken: [])
        XCTAssertLessThanOrEqual(name.utf8.count, 200)
        XCTAssertTrue(name.hasSuffix(".mov"))
        XCTAssertFalse(name.unicodeScalars.contains("\u{FFFD}"))
        XCTAssertTrue(String(name.dropLast(4)).allSatisfy { $0 == "写" })
    }

    /// The cap has to hold AFTER the collision suffix, which means the stem is
    /// re-truncated per attempt rather than truncated once and then extended.
    func testACollisionSuffixStillFitsTheByteBudget() {
        let long = String(repeating: "n", count: 300) + ".mov"
        let first = stagedFileName(suggested: long, taken: [])
        let second = stagedFileName(suggested: long, taken: [first])
        let third = stagedFileName(suggested: long, taken: [first, second])
        for name in [first, second, third] { XCTAssertLessThanOrEqual(name.utf8.count, 200) }
        XCTAssertTrue(second.hasSuffix(" (2).mov"))
        XCTAssertTrue(third.hasSuffix(" (3).mov"))
        XCTAssertNotEqual(first, second)
        XCTAssertNotEqual(second, third)
    }

    func testTheMultibyteCollisionSuffixAlsoFits() {
        let long = String(repeating: "写", count: 300) + ".mov"
        let first = stagedFileName(suggested: long, taken: [])
        let second = stagedFileName(suggested: long, taken: [first])
        XCTAssertLessThanOrEqual(second.utf8.count, 200)
        XCTAssertTrue(second.hasSuffix(" (2).mov"))
        XCTAssertFalse(second.unicodeScalars.contains("\u{FFFD}"))
    }
```

*Ownership — the half that replaces the old sweep strategy*

```swift
    func testTakeCopiesTheProviderFileAndLeavesItAlone()

    /// The framework can decode a `StagedPhotoFile` and then drop it — a
    /// cancelled loadTransferable, a superseded import, a torn-down task — and
    /// when it does, no app code runs. ARC is the only cleanup hook left, which
    /// is why there is no sweep to race the provider callback.
    func testACandidateRemovesItsDirectoryOnDeinit() throws {
        let inbox = try tempInbox()
        var directory: URL!
        do {
            let candidate = try PhotoInbox.take(providerFile("IMG_1.HEIC"), in: inbox)
            directory = candidate.url.deletingLastPathComponent()
            XCTAssertTrue(FileManager.default.fileExists(atPath: directory.path))
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
    }

    func testDiscardIsExactlyOnceAndSafeToRepeat() throws {
        let inbox = try tempInbox()
        let candidate = try PhotoInbox.take(providerFile("IMG_1.HEIC"), in: inbox)
        let directory = candidate.url.deletingLastPathComponent()
        candidate.discard()
        candidate.discard()
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
    }

    /// Ownership moves only after the move succeeds, and the emptied inbox
    /// directory goes with it.
    func testAdoptTransfersOwnershipOnlyAfterASuccessfulMove() throws {
        let (area, batch, inbox) = try makeArea()
        let candidate = try PhotoInbox.take(providerFile("IMG_1.HEIC"), in: inbox)
        let directory = candidate.url.deletingLastPathComponent()
        let staged = try area.adopt(candidate, into: batch)
        XCTAssertTrue(FileManager.default.fileExists(atPath: staged.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: candidate.url.path),
                       "a move, not a copy")
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
    }

    /// And the candidate's LATER deinit must not delete a file that now belongs
    /// to the batch.
    func testAnAdoptedCandidatesDeinitDoesNotTouchTheBatch() throws {
        let (area, batch, inbox) = try makeArea()
        var staged: URL!
        do {
            let candidate = try PhotoInbox.take(providerFile("IMG_1.HEIC"), in: inbox)
            staged = try area.adopt(candidate, into: batch)
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: staged.path))
    }

    /// A failed move leaves the candidate still owning — and still cleaning up
    /// — its directory. Otherwise a transient move failure leaks a video.
    func testAFailedMoveLeavesTheCandidateOwningItsCleanup() throws {
        let (area, batch, inbox) = try makeArea()
        let candidate = try PhotoInbox.take(providerFile("IMG_1.HEIC"), in: inbox)
        let directory = candidate.url.deletingLastPathComponent()
        try FileManager.default.removeItem(at: batch.url)      // make the move fail
        XCTAssertThrowsError(try area.adopt(candidate, into: batch))
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.path))
        candidate.discard()
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
    }

    func testAdoptAppliesTheCollisionRuleWithinTheBatch()

    /// No global mutable current-batch context — the reason step 1 can be
    /// static at all.
    func testPhotoStagingDeclaresNoMutableStatic() throws {
        let source = try String(contentsOf: photoStagingSourceURL, encoding: .utf8)
        XCTAssertFalse(source.contains("static var"))
        XCTAssertFalse(source.contains("TaskLocal"))
    }
```

*Staging and leftovers*

```swift
    func testDiscardRemovesTheWholeBatch()
    func testAdoptingABatchRemovesThePreviouslyAdoptedOne()
    func testClearRemovesTheLiveBatch()
    func testDeallocationRemovesTheLiveBatch()

    /// The launch sweep can never race a live batch, because a live batch is
    /// always inside the launch directory the sweep excludes by construction.
    func testTheLaunchSweepRemovesOtherLaunchesAndNeverThisOne()
    func testSweepLeftoversEmptiesTheInbox()

    func testThePhotoImportBoundIsAboutDiskNotTheManifest() {
        XCTAssertEqual(PHOTO_IMPORT_MAX, 50)
        XCTAssertLessThan(PHOTO_IMPORT_MAX, MAX_FILES)
    }
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/RelayiumKit && swift test --filter PhotoStagingTests`
Expected: compile failure — nothing named here exists yet.

- [ ] **Step 3: Write the implementation**

Create `PhotoStaging.swift`.

`stagedFileName(suggested:taken:)`, in this exact order:

1. `lastPathComponent`;
2. strip control characters, `/` and `:`; trim whitespace;
3. split at the **last** dot into stem and extension — a leading dot with no
   further dot therefore yields an **empty stem** and a real extension; an
   "extension" longer than 16 bytes is not treated as one;
4. strip remaining leading dots from the stem;
5. empty stem → `photo`;
6. for attempt *n* = 1, 2, 3 …: suffix is `""`, `" (2)"`, `" (3)"` …, and the
   stem is truncated **per attempt**, by removing whole `Character`s from the
   end, until `stem + suffix + ext` ≤ 200 UTF-8 bytes;
7. if the stem truncates to empty, use `photo`, dropping the extension if it
   still does not fit;
8. return the first attempt not in `taken`.

`PhotoCandidate` — a `final class`, `@unchecked Sendable`, with an `NSLock`, the
owned directory, and a `released` flag:

```swift
    /// Give up the directory now. Idempotent, and safe from any thread.
    public func discard() { if let dir = relinquish() { try? fileManager.removeItem(at: dir) } }

    /// Exactly-once ownership transfer. Returns the directory to remove, or nil
    /// if ownership is already gone.
    func relinquish() -> URL? {
        lock.lock(); defer { lock.unlock() }
        guard !released else { return nil }
        released = true
        return directory
    }

    deinit { discard() }
```

with the design's paragraph as its doc comment: a class rather than a struct
because ownership must be releasable exactly once **and by ARC**, since the
framework can drop a decoded `StagedPhotoFile` without calling anything in this
app; and that is why there is no runtime sweep to race a provider callback.

`PhotoInbox`:

- `directory()` → `<tmp>/PhotoInbox`, created on demand. Flat and
  launch-independent, because step 1 has no context to be scoped by.
- `take(_:)` → creates `<inbox>/<UUID>/`, copies the provider file in under its
  sanitized `lastPathComponent` (or `photo` when unusable), returns a
  `PhotoCandidate` owning that directory, whose `suggestedName` is the
  provider's name **unsanitized** — final naming is step 2's decision.
- `sweepLeftovers(_:)` empties the inbox. Its doc comment states the whole
  contract: called **exactly once, at app-scoped model construction, before any
  import can exist**; it is for crash leftovers and nothing else; there is no
  runtime sweep.

`PhotoStagingArea`:

- `launchRoot(in:)` → `<tmp>/PhotoImports/<launch UUID>`, created.
- `sweepOtherLaunches(under:keeping:)` removes every sibling of the live launch
  directory. Best effort; failure ignored.
- `makeBatch()` → `<launchRoot>/<batch UUID>`.
- `adopt(_ candidate:into:)` → compute the name, `moveItem`, and **only after
  the move succeeds** call `candidate.relinquish()` and remove the returned
  directory; record the name; return the destination. A throwing move leaves the
  candidate owning its cleanup.
- `adoptBatch(_:)` makes a batch live and removes the previously live one;
  `discard(_:)` removes a batch; `clear()` removes the live one.
- Non-isolated `final class`, `@unchecked Sendable`, `NSLock`, `deinit` sharing
  `clear()`'s release path.

`PHOTO_IMPORT_MAX = 50`, with the reason in the doc comment.

- [ ] **Step 4: Checkpoint**

Run: `cd apps/RelayiumKit && swift test --filter PhotoStagingTests`
Expected: PASS. Record the output. Do not commit.

### Task 3: Presentation seams — availability, account context, caps, picker change

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumAppKit/SendPresentation.swift`
- Modify: `apps/RelayiumKit/Sources/RelayiumAppKit/CloudUploadModel.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/SendPresentationTests.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/CloudUploadModelTests.swift`

**Interfaces:**
- Produces: `SendAvailability.state(for:)`
  (`.checking` / `.needsAccount` / `.accountUnavailable` / `.ready`),
  `SendAccountContext(userId:retentionSecs:)`, `.none`, `.context(for:)`,
  `UploadCaps(retentionSecs:maxFileSize:)`, `.unknown`,
  `PhotoPickerChange.decide(itemCount:)`, `CloudUploadModel.apply(_:)`.
- Consumes: `SessionState`, `NativeUser.id`, `UsageResponse.plan.retentionSecs`.

- [ ] **Step 1: Write the failing tests**

Create `SendPresentationTests.swift`, using the `Bundle.module` fixtures
`SignInPresentationTests` uses for a `.ready` state:

```swift
    func testOnlyAReadyAccountCanSend() throws {
        XCTAssertEqual(SendAvailability.state(for: try readyState()), .ready)
        XCTAssertEqual(SendAvailability.state(for: .restoring), .checking)
        XCTAssertEqual(SendAvailability.state(for: .authenticating), .checking)
        XCTAssertEqual(SendAvailability.state(for: .loggedOut), .needsAccount)
        XCTAssertEqual(SendAvailability.state(for: .failed(message: "no")), .needsAccount)
        XCTAssertEqual(SendAvailability.state(for: .emailUnverified(email: "a@b.co")),
                       .needsAccount)
        XCTAssertEqual(SendAvailability.state(for: .pendingDeletion(purgeAfter: 1,
                                                                   reactivateToken: "t")),
                       .needsAccount)
        // Distinct on purpose: this user IS signed in, and "you need an account"
        // would be a false sentence with a useless remedy.
        XCTAssertEqual(SendAvailability.state(for: .unavailable(message: "down")),
                       .accountUnavailable)
    }

    /// The id, not the email: an email can change and would then read as an
    /// account switch that never happened.
    func testOnlyAReadyAccountHasAContext() throws {
        let context = SendAccountContext.context(for: try readyState())
        XCTAssertEqual(context.userId, try fixture("me", as: MeResponse.self).user.id)
        XCTAssertGreaterThan(context.retentionSecs, 0)
        for state in [SessionState.restoring, .loggedOut, .authenticating,
                      .failed(message: "x"), .unavailable(message: "x"),
                      .emailUnverified(email: "a@b.co"),
                      .pendingDeletion(purgeAfter: 1, reactivateToken: "t")] {
            XCTAssertEqual(SendAccountContext.context(for: state), .none, "\(state)")
        }
    }

    /// An empty picker change is OUR OWN programmatic reset, or nothing chosen.
    /// Treating it as an import of zero items would clear a selection the user
    /// never asked to clear.
    func testAnEmptyPickerChangeIsIgnoredRatherThanImportedAsZero() {
        XCTAssertEqual(PhotoPickerChange.decide(itemCount: 0), .ignore)
        XCTAssertEqual(PhotoPickerChange.decide(itemCount: 1), .importItems(count: 1))
        XCTAssertEqual(PhotoPickerChange.decide(itemCount: PHOTO_IMPORT_MAX),
                       .importItems(count: PHOTO_IMPORT_MAX))
    }
```

Append to `CloudUploadModelTests`:

```swift
    func testApplyingCapsNarrowsTheTTLChoices() {
        let m = makeModel()
        m.apply(UploadCaps(retentionSecs: 86_400, maxFileSize: 0))
        XCTAssertEqual(m.ttlChoices, [3600, 86400])
    }

    /// The pair is applied and cleared together, so a size gate cannot outlive
    /// the retention it arrived with.
    func testApplyingAnUnknownCapTurnsBothOff() {
        let m = makeModel()
        m.apply(UploadCaps(retentionSecs: 3600, maxFileSize: 1000))
        XCTAssertEqual(m.ttlChoices, [3600])
        XCTAssertEqual(m.maxFileSize, 1000)
        m.apply(.unknown)
        XCTAssertEqual(m.ttlChoices, [3600, 86400, 259200, 604800, 1209600])
        XCTAssertEqual(m.maxFileSize, 0)
    }
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/RelayiumKit && swift test --filter SendPresentationTests`
Expected: compile failure — the four types are undefined.

- [ ] **Step 3: Write the implementation**

Create `SendPresentation.swift` with all four types, each switching exhaustively
over `SessionState` where applicable (no `default:`, so a new case is a compile
error rather than a silent "can send"). Add to `CloudUploadModel`:

```swift
    /// Advisory limits, applied as a pair so they can only be set and cleared
    /// together. `UploadCaps.unknown` on every transition out of a ready
    /// account is what stops one account's plan from bounding another's picker.
    public func apply(_ caps: UploadCaps) {
        applyRetentionCap(caps.retentionSecs)
        maxFileSize = caps.maxFileSize
    }
```

- [ ] **Step 4: Checkpoint**

Run: `cd apps/RelayiumKit && swift test --filter 'SendPresentationTests|CloudUploadModelTests'`
Expected: PASS, except the two key-notice assertions that pin "this Mac", which
Task 5 reconciles — confirm those two are the only failures and that they fail
for that reason. Record the output. Do not commit.

### Task 4: The app-scoped selection owner

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumAppKit/SendSelectionModel.swift`
- Modify: `apps/RelayiumKit/Sources/RelayiumAppKit/AppEnvironment.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/SendSelectionModelTests.swift`

**Interfaces:**
- Produces: `SendSelectionModel(upload:access:photos:inbox:fetchConfig:store:)`,
  `observe<P: Publisher>(_ states: P) where P.Output == SessionState, P.Failure == Never`,
  `chooseFiles(_ result: Result<[URL], Error>)`,
  `importPhotos(count:load:) async`, `clear()`;
  `@Published summary`, `selectionError`, `isImportingPhotos`, `importError`;
  `AppEnvironment.makeSendSelectionModel(baseURL:upload:)`.
- Internal, **not** published and **not** rendered: `accountUserId`,
  `accountGeneration`, `photoGeneration`.
- Consumes: `CloudUploadModel`, `SelectionStore`, `SecurityScopedAccess`,
  `PhotoStagingArea`, `PhotoInbox`, `PhotoCandidate`, `SendAccountContext`,
  `UploadCaps`, `CloudClient.fetchConfig()`, `ErrorCopy`, `L10n`.

- [ ] **Step 1: Write the failing tests**

Create `SendSelectionModelTests.swift` with a gateable config fetcher, a
gateable candidate loader, a `CurrentValueSubject<SessionState, Never>` for the
session, and a `SelectionStore` whose injected `expand` closure reports what it
saw.

*Files and scopes*

```swift
    /// The scope has to be held BEFORE anything enumerates a folder, or a
    /// directory listing inside a security-scoped container fails.
    func testTheScopeIsHeldWhileTheSelectionIsExpanded()

    /// A refusal by the UPLOAD model (an oversized file) stays an upload
    /// failure, and the previous files must not be restorable — their access is
    /// already gone.
    func testAnUploadRefusalLeavesNoScopeAndNothingToReturnTo()

    /// A PREPARATION failure never reaches the upload model: nothing was ever
    /// picked, so `.failed` there would offer a "Try again" that retries
    /// nothing. It is the parent's `selectionError`, and it is also the path
    /// that proves the forwarded observation is real.
    func testAFailedExpansionSetsSelectionErrorAndLeavesTheUploadModelUntouched() {
        let m = makeModel(expand: { _ in throw FileSelectionError.noFiles })
        m.chooseFiles(.success([fileURL("a.txt")]))
        XCTAssertEqual(m.selectionError,
                       ErrorCopy.message(for: FileSelectionError.noFiles))
        XCTAssertEqual(upload.state, .idle, "a preparation failure is not an upload failure")
        XCTAssertTrue(access.heldURLs.isEmpty)
        XCTAssertNil(m.summary)
    }

    func testChoosingFilesWhileUploadingStartsNoScopeAtAll()
    func testClearReleasesScopesAndDeletesTheStagedBatch()
```

*Photo ordering, replacement and supersession*

```swift
    func testAdoptedPhotosReachTheModelInSelectionOrder() async

    /// The import replaced the selection at its START, so a failure part-way
    /// leaves nothing — including nothing of the FILE selection that was there
    /// before.
    func testAPartialPhotoFailureLeavesNoPriorFileSelectionRestorable() async {
        let m = makeModel()
        m.chooseFiles(.success([fileURL("a.txt")]))
        guard case .picked = upload.state else { return XCTFail() }

        await m.importPhotos(count: 3) { index in
            if index == 2 { throw PhotoImportError.unusable }
            return try candidate("IMG_\(index).HEIC")
        }

        XCTAssertEqual(m.importError, L10n.t(.errorPhotoImportFailed))
        XCTAssertNil(m.summary)
        upload.reset()
        XCTAssertEqual(upload.state, .idle, "the previous files must not be restorable")
        XCTAssertTrue(access.heldURLs.isEmpty)
        XCTAssertTrue(batchDirectoriesOnDisk().isEmpty)
        XCTAssertTrue(inboxCandidatesOnDisk().isEmpty)
    }

    /// Choosing files is a NEWER intent and must win. Refusing it because an
    /// import is running would make the app ignore the user.
    func testAFileChoiceOvertakesAnInFlightImport() async {
        let m = makeModel()
        let gate = LoaderGate()
        let importing = Task { await m.importPhotos(count: 2) { index in
            await gate.wait(at: index)
            return try candidate("IMG_\(index).HEIC")
        } }
        await gate.reached(0)

        m.chooseFiles(.success([fileURL("a.txt")]))     // supersedes, synchronously
        XCTAssertFalse(m.isImportingPhotos, "no newer import owns the flag")
        XCTAssertEqual(m.summary, expectedSummaryForOneFile)

        gate.release()
        await importing.value

        XCTAssertEqual(m.summary, expectedSummaryForOneFile, "the older import must not repaint")
        XCTAssertFalse(m.isImportingPhotos)
        XCTAssertNil(m.importError, "a superseded import reports no failure")
        XCTAssertTrue(batchDirectoriesOnDisk().isEmpty)
        XCTAssertTrue(inboxCandidatesOnDisk().isEmpty)
    }

    func testClearOvertakesAnInFlightImportAndLowersTheFlag() async
    func testAZeroItemCallSupersedesAndClears() async

    /// A second import is not refused either; it supersedes, and the flag stays
    /// up because a newer import owns it.
    func testASecondImportSupersedesTheFirstWhileItIsStillLoading() async {
        let m = makeModel()
        let first = LoaderGate(), second = LoaderGate()
        let a = Task { await m.importPhotos(count: 1) { _ in
            await first.wait(at: 0); return try candidate("A.HEIC") } }
        await first.reached(0)
        let b = Task { await m.importPhotos(count: 1) { _ in
            await second.wait(at: 0); return try candidate("B.HEIC") } }
        await second.reached(0)
        XCTAssertTrue(m.isImportingPhotos)

        first.release(); await a.value
        XCTAssertTrue(m.isImportingPhotos, "the newer import still owns the flag")
        second.release(); await b.value

        XCTAssertFalse(m.isImportingPhotos)
        XCTAssertEqual(stagedNames(), ["B.HEIC"])
        XCTAssertTrue(inboxCandidatesOnDisk().isEmpty)
    }

    func testAPhotoImportReleasesTheFileScopes() async
    func testAFileSelectionDeletesTheStagedPhotoBatch() async
    func testTheInboxIsSweptOnlyAtConstruction() async
```

*Account isolation, driven by the session and no view*

```swift
    /// The whole point of app-scoped observation: there is no SendView in this
    /// test, and there never was. A `.task` inside a lazily-mounted tab would
    /// fail this.
    ///
    /// The assertion is made IMMEDIATELY after `send`, with no await in
    /// between: isolation must be synchronous with the state write, or an
    /// account-owned transfer keeps running under an account that is gone.
    func testASignOutCancelsAndClearsSynchronouslyWithNoViewInExistence() {
        let states = CurrentValueSubject<SessionState, Never>(readyA)
        let m = makeModel(); m.observe(states)
        m.chooseFiles(.success([fileURL("a.txt")]))
        upload.start(token: "rlm_cli_A")
        guard case .uploading = upload.state else { return XCTFail() }

        states.send(.loggedOut)

        XCTAssertEqual(upload.state, .idle)
        XCTAssertNil(m.summary)
        XCTAssertTrue(access.heldURLs.isEmpty)
        XCTAssertEqual(upload.ttlChoices, allowedTTLs(retentionSecs: 0))
        XCTAssertEqual(upload.maxFileSize, 0)
    }

    /// A to B with no sign-out in between. A's link must not be on B's screen.
    func testSwitchingAccountsClearsTheFirstAccountsResultAndCaps()

    func testAccountIsolationSupersedesAnImportAndLowersTheFlag() async
    func testAccountIsolationCancelsThePendingConfigFetch() async
```

*Caps and staleness*

```swift
    func testRetentionAppliesSynchronouslyAndTheSizeHintOnlyAfterTheFetch() async

    /// The case the generation AND the identity guard both exist for.
    func testAStaleConfigResponseAfterLogoutAndAccountSwitchAppliesNothing() async {
        let states = CurrentValueSubject<SessionState, Never>(.loggedOut)
        let m = makeModel(); m.observe(states)
        configGate.hold()
        states.send(readyA)                    // retention 3600, fetch pending
        await configGate.reached()
        states.send(.loggedOut)
        states.send(readyB)                    // retention 1209600
        configGate.release(ServerConfig(maxFileSize: 999))   // A's answer, late
        await settle()

        XCTAssertEqual(upload.maxFileSize, 0, "account A's hint must not reach account B")
        XCTAssertEqual(upload.ttlChoices, allowedTTLs(retentionSecs: 1_209_600))
    }

    /// A slow fetch must not serialize later account events behind it.
    func testASecondAccountEventIsProcessedWhileTheFirstFetchIsStillPending() async

    func testDuplicateStatesProduceExactlyOneFetch() async
    func testAConfigFailureLeavesTheSizeUnknownAndTheFlowUsable() async
    func testNoConfigFetchIsAttemptedWithoutAReadyAccount() async
```

*Observation and lifetime*

```swift
    /// A view observing this model does NOT observe the SelectionStore inside
    /// it: ObservableObject does not propagate through a stored property. The
    /// failed-expansion path proves the forwarding is real — it never reaches
    /// the upload model, so a view relying on that model's redraws would show
    /// nothing at all.
    func testRenderStateIsPublishedByThisModelAndNotByCoincidence()

    /// ARC owns the lifetime: the AnyCancellable cancels itself and the config
    /// task box cancels in its own deinit, so a `@MainActor` deinit never has
    /// to reach isolated state.
    func testReleasingTheModelCancelsItsSubscriptionAndConfigTask() async
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/RelayiumKit && swift test --filter SendSelectionModelTests`
Expected: compile failure — `SendSelectionModel` is undefined.

- [ ] **Step 3: Write the implementation**

Create `SendSelectionModel.swift`, `@MainActor final class … ObservableObject`.

*Published render state.* `SelectionStore` is a `private let`; the model
forwards `summary`, `selectionError`, `isImportingPhotos` and `importError`
through one private `publishRenderState()` called after every mutation. The doc
comment records why: a nested `ObservableObject` never reaches the parent's
subscribers, and relying on `CloudUploadModel` publishing at the same moment is
a coincidence that breaks exactly where it matters. `accountUserId`,
`accountGeneration` and `photoGeneration` are internal isolation state — not
`@Published`, not rendered.

*Supersession helper.*

```swift
    /// A newer intent wins. Bump the generation so every in-flight import
    /// discards its own batch and candidate when it resumes, and take the
    /// visible flag down — the caller is not an import, so nothing newer owns
    /// it.
    private func supersedeImports() {
        photoGeneration += 1
        isImportingPhotos = false
        importError = nil
    }
```

*`chooseFiles`* — a callback that starts after sign-out is refused first; within
a ready account, `upload.isBusy` is the only refusal:

```swift
    public func chooseFiles(_ result: Result<[URL], Error>) {
        guard !enforcesReadyAccount || accountUserId != nil else { return }
        // The only ready-account refusal. An in-flight import does NOT block a file choice:
        // the user asking for files is a newer intent, and the answer is to
        // supersede, not to ignore them. Everything below runs synchronously,
        // so the older import cannot interleave.
        guard !upload.isBusy else { return }
        selectionError = nil
        switch result {
        case let .failure(error):
            // A picker failure is a PREPARATION failure: nothing was picked, so
            // it belongs in `selectionError`, not in the upload model.
            supersedeImports()
            selectionError = ErrorCopy.message(for: error)
        case let .success(urls):
            guard !urls.isEmpty else { clear(); return }
            supersedeImports()
            photos.clear()                          // a file pick replaces a photo batch
            let roots = access.replace(with: urls)  // ── the scope starts HERE
            // The previous list's access is gone, so nothing may return to it.
            upload.clearSelection()
            store.replace(with: roots)              // expansion runs inside the scope
            if let expanded = store.selection {
                upload.pick(expanded)               // an oversized file fails HERE
                if case .picked = upload.state { publishRenderState(); return }
            } else if let message = store.error {
                selectionError = message            // preparation, not upload
            }
            access.clear()
            store.clear()
        }
        publishRenderState()
    }
```

*`importPhotos`* — everything that replaces the selection happens **before the
first `await`**, and a second import supersedes rather than being refused:

```swift
    /// `load` returns a candidate the STATIC `FileRepresentation` already copied
    /// out of the provider, and whose inbox directory that candidate owns. It
    /// takes only an index, because `loadTransferable(type:)` cannot carry
    /// per-import context — which is exactly why the batch is applied here.
    public typealias PhotoCandidateLoading = (_ index: Int) async throws -> PhotoCandidate

    public func importPhotos(count: Int, load: @escaping PhotoCandidateLoading) async {
        guard !enforcesReadyAccount || accountUserId != nil else { return }
        guard !upload.isBusy else { return }        // the only ready-account refusal
        // A defensive path the view never takes: `PhotoPickerChange.decide`
        // turns an empty binding change into `.ignore`, because that change is
        // the view's own reset.
        guard count > 0 else { supersedeImports(); clear(); return }

        photoGeneration += 1
        let g = photoGeneration
        isImportingPhotos = true                    // THIS import now owns the flag
        importError = nil
        selectionError = nil
        // The picker result replaces the selection NOW, not when the loads
        // finish. Everything below can fail, and when it does "nothing is
        // selected" must be literally true — including of what was selected
        // before.
        access.clear()
        photos.clear()
        store.clear()
        upload.clearSelection()
        publishRenderState()

        defer {
            if g == photoGeneration { isImportingPhotos = false }
            publishRenderState()
        }

        let batch: PhotoStagingBatch
        do { batch = try photos.makeBatch() }
        catch { if g == photoGeneration { importError = L10n.t(.errorPhotoImportFailed) }; return }

        var staged: [URL] = []
        for index in 0..<count {
            let candidate: PhotoCandidate
            do { candidate = try await load(index) }
            catch {
                photos.discard(batch)
                // A superseded import reports nothing: the failure belongs to a
                // selection the user has already replaced.
                if g == photoGeneration { importError = L10n.t(.errorPhotoImportFailed) }
                return
            }
            guard g == photoGeneration, !upload.isBusy else {
                candidate.discard()                 // it owns its bytes; free them now
                photos.discard(batch)
                return
            }
            do { staged.append(try photos.adopt(candidate, into: batch)) }
            catch {
                candidate.discard()                 // the failed move left it owning
                photos.discard(batch)
                if g == photoGeneration { importError = L10n.t(.errorPhotoImportFailed) }
                return
            }
        }

        guard g == photoGeneration, !upload.isBusy else { photos.discard(batch); return }
        photos.adoptBatch(batch)
        store.replace(with: staged)
        if let expanded = store.selection { upload.pick(expanded) }
        else if let message = store.error {
            selectionError = message; photos.clear(); store.clear()
        }
    }
```

*`clear()`* calls `supersedeImports()`, releases scopes, deletes the staged
batch, clears the store and `CloudUploadModel`'s selection, drops
`selectionError`, and publishes.

*Session observation*, installed once and living as long as the model:

```swift
    /// Installed at app construction, for this model's whole life.
    ///
    /// `AccountSession` is `@MainActor`, so `$state` only ever fires there. This
    /// `sink` closure is non-`@Sendable` and is formed inside a `@MainActor`
    /// method, so it INHERITS main-actor isolation and runs SYNCHRONOUSLY with
    /// the state write. That is deliberate, and it is deliberately NOT the
    /// `Task { @MainActor in … }` hop `NearbyReceiveModel` uses: that model
    /// defers because it re-reads its sources and `@Published` fires in
    /// `willSet`, whereas this consumes the EMITTED value and never re-reads
    /// `session.state`. A hop here would leave a window in which an
    /// account-owned transfer runs under an account that is already gone —
    /// `testASignOutCancelsAndClearsSynchronouslyWithNoViewInExistence` fails if
    /// anyone adds one, and adding `.receive(on:)` would do the same.
    ///
    /// It takes a publisher rather than the session so a test can drive
    /// transitions through a `CurrentValueSubject` with no network, no keychain
    /// and no view.
    public func observe<P: Publisher>(_ states: P)
        where P.Output == SessionState, P.Failure == Never {
        sessionObservation = states
            .map(SendAccountContext.context(for:))
            .removeDuplicates()
            .sink { [weak self] context in self?.accountContextChanged(context) }
    }

    private func accountContextChanged(_ context: SendAccountContext) {
        if context.userId != accountUserId { isolateFromPreviousAccount() }
        accountGeneration += 1
        let g = accountGeneration
        accountUserId = context.userId
        configTask.cancel()                     // an older fetch applies to nobody
        guard context.userId != nil else { upload.apply(.unknown); return }
        // Retention is known NOW; the size hint is not. The pair is applied
        // twice on purpose: the screen is usable immediately and gets sharper
        // if the advisory fetch lands.
        upload.apply(UploadCaps(retentionSecs: context.retentionSecs, maxFileSize: 0))
        // Replaced rather than awaited, so a slow /api/config can never delay a
        // later account event.
        configTask.replace(with: Task { [weak self] in
            guard let config = try? await self?.fetchConfig() else { return }
            await self?.applyFetchedConfig(config, generation: g, context: context)
        })
    }

    private func applyFetchedConfig(_ config: ServerConfig,
                                    generation g: Int,
                                    context: SendAccountContext) {
        // The generation catches a re-entry into the same account; the id
        // catches everything else.
        guard g == accountGeneration, accountUserId == context.userId else { return }
        upload.apply(UploadCaps(retentionSecs: context.retentionSecs,
                                maxFileSize: config.maxFileSize))
    }

    /// Cancel FIRST: the upload is authorized by a bearer belonging to the
    /// account being left, and letting it run would either fail on a screen the
    /// user has left or put account A's link on account B's screen. The
    /// abandoned server session is reclaimed after `pendingUploadTTL`; there is
    /// no client DELETE and this does not invent one.
    private func isolateFromPreviousAccount() {
        upload.cancel()
        supersedeImports()
        configTask.cancel()
        access.clear()
        photos.clear()
        store.clear()
        upload.clearSelection()
        upload.apply(.unknown)
        selectionError = nil
        publishRenderState()
    }
```

*Lifetime by ARC.* `sessionObservation` is an `AnyCancellable`, which cancels
itself on release. `configTask` is a small non-isolated box — the same reason
`SecurityScopedAccess` and `PhotoStagingArea` are plain classes — so its
cancellation does not need a `@MainActor` `deinit` to reach isolated state:

```swift
/// Holds at most one task and cancels it on replace, on demand, or on release.
final class CancellableTaskBox: @unchecked Sendable {
    private let lock = NSLock()
    private var task: Task<Void, Never>?
    func replace(with new: Task<Void, Never>?)   // cancels the previous
    func cancel()
    deinit { cancel() }
}
```

*Construction* sweeps prior launches and the inbox once, before any import can
exist:

```swift
        Task.detached(priority: .utility) { [launchRoot, inbox] in
            PhotoStagingArea.sweepOtherLaunches(under: launchRoot.deletingLastPathComponent(),
                                                keeping: launchRoot)
            PhotoInbox.sweepLeftovers(inbox)     // crash leftovers only; no runtime sweep
        }
```

In `AppEnvironment`:

```swift
    /// The advisory per-file size hint comes from the PUBLIC `GET /api/config`
    /// that `CloudClient.fetchConfig()` has always spoken; this slice is the
    /// first caller. Injected as a closure so the staleness tests can gate the
    /// response and land it at a chosen moment.
    @MainActor
    public static func makeSendSelectionModel(baseURL: URL = productionBaseURL,
                                              upload: CloudUploadModel) -> SendSelectionModel {
        let client = CloudClient(baseURL: baseURL)
        return SendSelectionModel(upload: upload,
                                  fetchConfig: { try await client.fetchConfig() })
    }
```

- [ ] **Step 4: Checkpoint**

Run: `cd apps/RelayiumKit && swift test --filter SendSelectionModelTests`
Expected: PASS. Record the output. Do not commit.

### Task 5: Copy — nine new keys, five corrections, and the assertions they move

**Files:**
- Modify: `apps/RelayiumKit/Sources/RelayiumAppKit/Localization/L10nKey.swift`
- Modify: `apps/RelayiumKit/Sources/RelayiumAppKit/Resources/{en,zh-Hans,ja,ko,de,fr,ar,es,pt}.lproj/Localizable.strings`
- Modify: `apps/RelayiumKit/Sources/RelayiumAppKit/UploadPresentation.swift` (comments)
- Modify: `apps/RelayiumKit/Sources/RelayiumAppKit/CloudUploadModel.swift` (comment)
- Modify: `apps/RelayiumKit/Sources/RelayiumAppKit/FileSelection.swift` (comment)
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/LocalizedCopyTests.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/CloudUploadModelTests.swift`

- [ ] **Step 1: Add the nine keys to the canon**

In `L10nKey.swift`, each beside its siblings: `tabSend = "tab.send"` after
`tabReceive`; a `send.*` block (`sendAccountTitle`, `sendAccountBody`,
`sendOpenAccount`, `sendAccountUnavailableBody`, `sendChoosePhotos`,
`sendPreparingPhotos`) after the `upload.*` block; `uploadKeepOpen =
"upload.keepOpen"` after `uploadBurnAfterRead`; `errorPhotoImportFailed =
"error.photoImport.failed"` beside the other `error.*` keys. Each carries a doc
comment saying why an existing key does not fit.

- [ ] **Step 2: Add the nine strings to all nine catalogs**

```
tab.send
en "Send" · zh-Hans "发送" · ja "送信" · ko "보내기" · de "Senden"
fr "Envoyer" · ar "إرسال" · es "Enviar" · pt "Enviar"

send.accountTitle
en "Sending needs an account" · zh-Hans "发送需要账户"
ja "送信にはアカウントが必要です" · ko "보내려면 계정이 필요합니다"
de "Zum Senden ist ein Konto nötig" · fr "L’envoi nécessite un compte"
ar "يتطلّب الإرسال حسابًا" · es "Enviar requiere una cuenta"
pt "Enviar precisa de uma conta"

send.accountBody
en "Files you send are encrypted on this device and uploaded to your Relayium account, so sending needs you to sign in. Receiving a link never does."
zh-Hans "你发送的文件会在这台设备上加密，然后上传到你的 Relayium 账户，所以发送需要先登录。接收链接则始终不需要账户。"
ja "送信するファイルはこのデバイスで暗号化され、あなたの Relayium アカウントにアップロードされます。そのため送信にはサインインが必要です。リンクの受信にアカウントは一切要りません。"
ko "보내는 파일은 이 기기에서 암호화되어 Relayium 계정으로 업로드됩니다. 그래서 보내려면 로그인이 필요합니다. 링크를 받을 때는 계정이 전혀 필요하지 않습니다."
de "Dateien, die du sendest, werden auf diesem Gerät verschlüsselt und in dein Relayium-Konto hochgeladen — deshalb ist zum Senden eine Anmeldung nötig. Zum Empfangen eines Links nie."
fr "Les fichiers que vous envoyez sont chiffrés sur cet appareil puis téléversés vers votre compte Relayium : l’envoi demande donc une connexion. La réception d’un lien n’en demande jamais."
ar "تُشفَّر الملفات التي ترسلها على هذا الجهاز ثم تُرفع إلى حسابك في Relayium، لذا يتطلّب الإرسال تسجيل الدخول. أمّا استلام رابط فلا يتطلّب حسابًا أبدًا."
es "Los archivos que envías se cifran en este dispositivo y se suben a tu cuenta de Relayium, así que enviar requiere iniciar sesión. Recibir un enlace nunca lo requiere."
pt "Os ficheiros que envia são cifrados neste dispositivo e enviados para a sua conta Relayium, por isso enviar exige iniciar sessão. Receber uma ligação nunca exige."

send.openAccount
en "Go to Account" · zh-Hans "前往账户" · ja "アカウントへ" · ko "계정으로 이동"
de "Zum Konto" · fr "Aller au compte" · ar "الانتقال إلى الحساب"
es "Ir a Cuenta" · pt "Ir para Conta"

send.accountUnavailableBody
en "Sending needs your plan's limits, and they couldn't be loaded. Open Account to try again."
zh-Hans "发送需要读取你套餐的限额，但这次没能载入。请前往「账户」重试。"
ja "送信にはプランの上限が必要ですが、読み込めませんでした。「アカウント」を開いて再試行してください。"
ko "보내려면 요금제의 한도가 필요한데 불러오지 못했습니다. 「계정」에서 다시 시도하세요."
de "Zum Senden werden die Grenzen deines Tarifs gebraucht, und die ließen sich nicht laden. Öffne „Konto“ und versuche es erneut."
fr "L’envoi a besoin des limites de votre offre, qui n’ont pas pu être chargées. Ouvrez « Compte » pour réessayer."
ar "يحتاج الإرسال إلى حدود خطتك، ولم يمكن تحميلها. افتح «الحساب» وأعد المحاولة."
es "Enviar necesita los límites de tu plan y no se pudieron cargar. Abre «Cuenta» para intentarlo de nuevo."
pt "Enviar precisa dos limites do seu plano, que não foi possível carregar. Abra «Conta» para tentar de novo."

send.choosePhotos
en "Choose Photos or Videos…" · zh-Hans "选择照片或视频…"
ja "写真またはビデオを選択…" · ko "사진 또는 비디오 선택…"
de "Fotos oder Videos wählen…" · fr "Choisir des photos ou des vidéos…"
ar "اختيار صور أو مقاطع فيديو…" · es "Elegir fotos o vídeos…"
pt "Escolher fotos ou vídeos…"

send.preparingPhotos
en "Preparing what you chose…" · zh-Hans "正在准备所选内容…"
ja "選択した項目を準備しています…" · ko "선택한 항목을 준비하는 중…"
de "Auswahl wird vorbereitet…" · fr "Préparation de votre sélection…"
ar "جارٍ تجهيز ما اخترته…" · es "Preparando lo que elegiste…"
pt "A preparar o que escolheu…"

upload.keepOpen
en "Keep Relayium open until this finishes. Leaving the app can stop the upload, and it can't be resumed in the background yet."
zh-Hans "请保持 Relayium 打开，直到这次传输完成。离开应用可能会中断上传，而且目前还不能在后台续传。"
ja "完了するまで Relayium を開いたままにしてください。アプリを離れるとアップロードが止まることがあり、バックグラウンドでの再開はまだできません。"
ko "끝날 때까지 Relayium을 열어 두세요. 앱을 벗어나면 업로드가 중단될 수 있고, 아직 백그라운드에서 이어서 보낼 수 없습니다."
de "Lass Relayium geöffnet, bis das hier fertig ist. Die App zu verlassen kann den Upload abbrechen, und im Hintergrund lässt er sich noch nicht fortsetzen."
fr "Gardez Relayium ouvert jusqu’à la fin. Quitter l’app peut interrompre l’envoi, qui ne peut pas encore reprendre en arrière-plan."
ar "أبقِ Relayium مفتوحًا حتى ينتهي هذا. قد تؤدي مغادرة التطبيق إلى إيقاف الرفع، ولا يمكن استئنافه في الخلفية بعد."
es "Mantén Relayium abierto hasta que esto termine. Salir de la app puede detener la subida, y todavía no puede reanudarse en segundo plano."
pt "Mantenha o Relayium aberto até isto terminar. Sair da app pode parar o envio, que ainda não pode ser retomado em segundo plano."

error.photoImport.failed
en "Some of what you chose couldn't be prepared for sending, so nothing was selected. Choose again, or send fewer items at once."
zh-Hans "所选内容中有一部分无法准备好发送，因此这次什么都没有选中。请重新选择，或一次少选一些。"
ja "選択した項目の一部を送信用に準備できなかったため、何も選択されませんでした。選び直すか、一度に選ぶ数を減らしてください。"
ko "선택한 항목 중 일부를 보낼 준비를 하지 못해 아무것도 선택되지 않았습니다. 다시 선택하거나 한 번에 더 적게 선택하세요."
de "Ein Teil deiner Auswahl ließ sich nicht zum Senden vorbereiten, deshalb wurde nichts ausgewählt. Wähle erneut oder nimm weniger auf einmal."
fr "Une partie de votre sélection n’a pas pu être préparée pour l’envoi : rien n’a donc été sélectionné. Choisissez à nouveau, ou moins d’éléments à la fois."
ar "تعذّر تجهيز جزء مما اخترته للإرسال، لذا لم يُحدَّد شيء. اختر مرة أخرى، أو أرسل عناصر أقل في المرة الواحدة."
es "No se pudo preparar parte de lo que elegiste para enviarlo, así que no se seleccionó nada. Elige de nuevo o envía menos elementos a la vez."
pt "Não foi possível preparar parte do que escolheu para envio, por isso nada ficou selecionado. Escolha de novo ou envie menos itens de cada vez."
```

- [ ] **Step 3: Correct the five reachable platform-naming strings, in place**

A minimal noun swap in each of the nine catalogs, preserving every other word
and every placeholder. The device noun is the one R3-B already established for
`error.manifest.duplicatePath`: `this device` / `这台设备` / `このデバイス` /
`이 기기` / `diesem Gerät` / `cet appareil` / `هذا الجهاز` /
`este dispositivo` / `este dispositivo`.

- `upload.keyKept` — "on this Mac" → *this device*, in all nine.
- `error.storedKey.badId.save`, `error.storedKey.badKey.save` — "on this Mac" →
  *this device*, in all nine.
- `error.plaintext.tooManyOpenFiles` — "This Mac ran out …" → "This device ran
  out …", in all nine.
- `error.storedKey.keychain.save` — the subject changes from the OS to the
  keychain, because "macOS" is the wrong actor on iOS and the keychain is the
  right one on both:

```
en      "The keychain wouldn't save this file's key (keychain error %@).";
zh-Hans "钥匙串未能保存这个文件的密钥（钥匙串错误 %@）。";
ja      "キーチェーンにこのファイルの鍵を保存できませんでした（キーチェーンエラー %@）。";
ko      "키체인에 이 파일의 키를 저장하지 못했습니다(키체인 오류 %@).";
de      "Der Schlüsselbund konnte den Schlüssel dieser Datei nicht sichern (Schlüsselbund-Fehler %@).";
fr      "Le trousseau n’a pas pu enregistrer la clé de ce fichier (erreur de trousseau %@).";
ar      "تعذّر على سلسلة المفاتيح حفظ مفتاح هذا الملف (خطأ سلسلة المفاتيح %@).";
es      "El llavero no pudo guardar la clave de este archivo (error de llavero %@).";
pt      "O porta-chaves não conseguiu guardar a chave deste ficheiro (erro do porta-chaves %@).";
```

Do **not** touch `error.storedKey.keychain.read` / `.remove`, and do **not**
touch `error.storedLinkKey.invalidKey`: `ErrorCopy.storedLinkKeyMessage` routes
`.invalidKey` to `errorStoredKeyBadKeySave` on `.save` and to
`errorStoredLinkKeyInvalidKey` only on `.read`, and sending never reads a stored
key. All three belong to R3-D and stay on the guard list.

- [ ] **Step 4: Correct the comments this makes false**

- `UploadPresentation` — "safely on this Mac" and `keyKeptText`'s doc "stored on
  this Mac" become the device wording; the sentence about the two statements
  contradicting each other is unchanged, because it is still the point.
- `CloudUploadModel.UploadState.done` — "this Mac could not keep the key".
- `FileSelection.SelectedFile.url` — "Absolute location on this Mac".

- [ ] **Step 5: Reconcile the two assertions that pinned the old noun**

In `CloudUploadModelTests`:

```swift
    /// After a successful save the key IS on this device and the Account tab
    /// can hand the link back, so the screen must not say the link is the only
    /// copy of it. What the assertion pins is WHERE the key lives and that it
    /// never left — not the word "Mac", which was only ever assertable in nine
    /// languages because a brand name survives translation verbatim.
    func testTheSuccessNoticeSaysTheKeyIsKeptOnThisDeviceAndNeverSent() {
        let notice = UploadPresentation.keyNotice(warning: nil)
        XCTAssertFalse(notice.isWarning)
        XCTAssertTrue(notice.text.contains("this device"), notice.text)
        XCTAssertTrue(notice.text.contains("never sent to Relayium"), notice.text)
        XCTAssertFalse(notice.text.contains("Mac"), notice.text)
        XCTAssertFalse(notice.text.lowercased().contains("only"),
                       "the success copy still claims the link is the only copy: \(notice.text)")
    }
```

In `LocalizedCopyTests`, replace the `contains("Mac")` arm of
`testTheKeyIsKeptNoticeMakesItsClaimInEveryLanguage` with a nine-entry device-
noun table, keeping the brand assertion:

```swift
    private let deviceNoun: [AppLanguage: String] = [
        .en: "this device", .zh: "这台设备", .ja: "このデバイス", .ko: "이 기기",
        .de: "diesem Gerät", .fr: "cet appareil", .ar: "هذا الجهاز",
        .es: "este dispositivo", .pt: "este dispositivo",
    ]
```

Add the new copy assertions. The list includes the `error.selection.*` keys,
because the model now renders them through `selectionError`:

```swift
    func testEveryCopyTheSendSurfaceReachesNamesNoPlatform() {
        let reachable: [L10nKey] = [
            .tabSend, .uploadHeading, .uploadReady, .uploadLinkReady, .uploadSendAnother,
            .uploadExpiresAfter, .uploadBurnAfterRead, .uploadKeepOpen, .uploadKeyKept,
            .sendAccountTitle, .sendAccountBody, .sendOpenAccount,
            .sendAccountUnavailableBody, .sendChoosePhotos, .sendPreparingPhotos,
            .commonSend, .commonClear, .commonCancel, .commonShare, .commonExpires,
            .commonTryAgain, .commonChooseFilesOrFolders, .commonStarting,
            .errorPhotoImportFailed, .errorCloudUnauthorized,
            .errorSelectionNoFiles, .errorSelectionTooManyFiles, .errorSelectionUnreadable,
            .errorSelectionSymbolicLink, .errorSelectionPathTooLong,
            .ttlOneHour, .ttlOneDay, .ttlThreeDays, .ttlSevenDays, .ttlFourteenDays,
        ]
        for key in reachable {
            for language in AppLanguage.allCases {
                let text = L10n.t(key, language: language)
                XCTAssertFalse(text.contains("Mac"), "\(key.rawValue) [\(language.rawValue)]: \(text)")
                XCTAssertFalse(text.contains("macOS"), "\(key.rawValue) [\(language.rawValue)]: \(text)")
            }
        }
    }

    /// The save-path failures reached through `ErrorCopy` rather than by name,
    /// which is why they were found by reachability review.
    func testTheKeySavePathNamesNoPlatformInAnyLanguage() {
        for language in AppLanguage.allCases {
            for error in [KeychainError.status(-25308) as Error,
                          StoredLinkKeyError.invalidIdentifier,
                          StoredLinkKeyError.invalidKey] {
                let text = ErrorCopy.storedLinkKeyMessage(for: error, operation: .save,
                                                          language: language)
                XCTAssertFalse(text.contains("Mac"), "[\(language.rawValue)] \(text)")
                XCTAssertFalse(text.contains("macOS"), "[\(language.rawValue)] \(text)")
            }
            let staging = ErrorCopy.message(for: PlaintextSourceError.tooManyOpenFiles(limit: 256),
                                            language: language)
            XCTAssertFalse(staging.contains("Mac"), "[\(language.rawValue)] \(staging)")
        }
    }

    func testTheNewSendKeysAreTranslatedEverywhere() {
        for key in [L10nKey.tabSend, .sendAccountTitle, .sendAccountBody, .sendOpenAccount,
                    .sendAccountUnavailableBody, .sendChoosePhotos, .sendPreparingPhotos,
                    .uploadKeepOpen, .errorPhotoImportFailed] {
            for language in AppLanguage.allCases {
                let text = L10n.t(key, language: language)
                XCTAssertFalse(text.isEmpty, "\(key.rawValue) [\(language.rawValue)]")
                XCTAssertNotEqual(text, key.rawValue,
                                  "\(key.rawValue) [\(language.rawValue)] fell back to the key")
                XCTAssertFalse(text.contains("%@"), "\(key.rawValue) [\(language.rawValue)]: \(text)")
            }
        }
    }
```

`testSignInAndStoredKeyKeychainCopyStayDistinctInEveryLanguage` is left as
written and must keep passing.

- [ ] **Step 6: Checkpoint**

```bash
cd apps/RelayiumKit && swift test --filter 'Localiz|CloudUploadModelTests|ErrorCopyTests'
```
Expected: PASS. Record the output. Do not commit.

### Task 6: The iOS Send tab

**Files:**
- Modify: `apps/ios/Relayium/RelayiumApp.swift`
- Modify: `apps/ios/Relayium/RootView.swift`
- Create: `apps/ios/Relayium/SendView.swift`
- Create: `apps/ios/Relayium/StagedPhotoFile.swift`
- Modify (comment only): `apps/ios/Relayium/Relayium.entitlements`

- [ ] **Step 1: Wire the app, and install the account observation there**

```swift
    @MainActor init() {
        _download = StateObject(wrappedValue: AppEnvironment.makeDownloadModel())
        let account = AppEnvironment.makeSession()
        _session = StateObject(wrappedValue: account)
        // ONE stored-link key store, and the one R3-D's account management model
        // will read. R3-B made `makeStoredLinkKeyStore` per-platform, so this
        // resolves to com.relayium.app with NO access group and needs no #if.
        let keys = AppEnvironment.makeStoredLinkKeyStore()
        let uploads = AppEnvironment.makeUploadModel(keyStore: keys)
        _upload = StateObject(wrappedValue: uploads)
        let sending = AppEnvironment.makeSendSelectionModel(upload: uploads)
        // App-scoped, for the model's whole life, and BEFORE any view exists.
        // A `.task` inside SendView would not do: SwiftUI mounts tabs lazily and
        // may tear down an off-screen one, so a user who signs out from the
        // Receive tab would get no isolation at all.
        sending.observe(account.$state)
        _send = StateObject(wrappedValue: sending)
    }
```

Update the file's doc comment: sending is here; the Share Extension, background
transfer, realtime, device/file management and notifications are not, and the
Share Extension specifically is deferred to the capability/release slice.

- [ ] **Step 2: Add the third tab**

`RootView` gains `case send` and:

```swift
            SendView(upload: upload, selection: send,
                     onOpenAccount: { self.selection = .account })
                .tabItem { Label(L10n.t(.tabSend), systemImage: "arrow.up.doc") }
                .tag(Tab.send)
```

It still never reads `session.state`: routing to Account is a tab-selection
change handed down as a closure.

- [ ] **Step 3: The stateless `Transferable` shim**

Create `StagedPhotoFile.swift`:

```swift
/// A picked photo or video, as a FILE.
///
/// `FileRepresentation`, never `DataRepresentation`: Apple's own guidance for
/// large or numerous items, and the difference between copying a 4 GB video and
/// loading it into memory. The importing closure MUST finish its copy before it
/// returns — the provider deletes `received.file` at that moment.
///
/// `transferRepresentation` is STATIC and `loadTransferable(type:)` takes only a
/// type, so nothing per-import can be injected here. That is why the only thing
/// this closure does is copy the provider file into a unique app-owned
/// directory that the returned `PhotoCandidate` then OWNS: if the framework
/// decodes this value and drops it — a cancelled load, a superseded import —
/// ARC frees those bytes with no app code running. Which batch it belongs to,
/// what it is finally named, and whether the import that asked for it is still
/// current are decided in `SendSelectionModel`, where they can be tested. There
/// is no shared "current batch" and no TaskLocal.
struct StagedPhotoFile: Transferable {
    let candidate: PhotoCandidate

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .image) { received in
            StagedPhotoFile(candidate: try PhotoInbox.take(received.file))
        }
        FileRepresentation(importedContentType: .movie) { received in
            StagedPhotoFile(candidate: try PhotoInbox.take(received.file))
        }
    }
}
```

- [ ] **Step 4: The Send tab**

Create `SendView.swift`:

- outer switch on `SendAvailability.state(for: session.state)` — `.checking` is a
  labelled `ProgressView(account.restoring)`; `.needsAccount` and
  `.accountUnavailable` are the two panels, each with the `send.openAccount`
  button calling `onOpenAccount`. **This gate is presentation only** — it never
  cancels or clears; the model does that, driven by the session;
- `.ready` renders `CloudUploadModel`'s states as in the design, with:
  - `.fileImporter(isPresented:allowedContentTypes: [.item, .folder], allowsMultipleSelection: true)`
    whose completion goes straight to `selection.chooseFiles(_:)`;
  - the reusable Photos binding:
    ```swift
    @State private var picked: [PhotosPickerItem] = []

    .onChange(of: picked) { items in
        // An empty change is OUR OWN reset below — never a product change, and
        // never `importPhotos(count: 0)`, which would clear a selection the user
        // did not ask to clear. Cancelling the system picker changes the binding
        // not at all, so it changes nothing here either.
        guard case let .importItems(count) = PhotoPickerChange.decide(itemCount: items.count)
        else { return }
        let captured = items          // import from the CAPTURED array…
        picked = []                   // …and reset now, so choosing the same
                                      // items again fires onChange again.
        Task {
            await selection.importPhotos(count: count) { index in
                guard let staged = try await captured[index]
                        .loadTransferable(type: StagedPhotoFile.self)
                else { throw PhotoImportError.unusable }
                return staged.candidate
            }
        }
    }
    ```
  - `PhotosPicker(selection: $picked, maxSelectionCount: PHOTO_IMPORT_MAX, matching: .any(of: [.images, .videos]))`;
  - both choose controls **and Send** `.disabled(upload.isBusy || selection.isImportingPhotos)`
    — a courtesy, since the model supersedes correctly anyway;
  - `send.preparingPhotos` as a labelled `ProgressView` while importing, and
    `selection.importError` / `selection.selectionError` rendered as failure
    lines;
  - `selection.summary` for the picked line — the view never names
    `SelectionStore`;
  - `upload.keepOpen` as ordinary text above Cancel while `.uploading`;
  - `.done` exactly as specified: `upload.linkReady`, the single
    `UploadPresentation.keyNotice`, the link with `.textSelection(.enabled)` and
    middle truncation, `ShareLink(item: link)`, `common.expires`, and
    `upload.sendAnother`;
  - the Send button reading the bearer at tap time:
    ```swift
    guard let token = session.bearerToken, !token.isEmpty else {
        upload.fail(L10n.t(.errorCloudUnauthorized)); return
    }
    upload.start(token: token)
    ```
- **No `SendAccountContext`, no `applyAccountContext`, no `.task(id:)` for the
  account.** That is app-scoped work installed in `RelayiumApp`.
- No `NSPasteboard`, no `UIPasteboard`, no direct
  `startAccessingSecurityScopedResource`, no `SelectionStore`, no fixed frames,
  leading/trailing only, every string through `L10n`.

- [ ] **Step 5: Correct the entitlements comment (the dict does not change)**

Replace the comment body; leave `<dict/>` exactly as it is:

> Deliberately empty, and still empty after three slices.
>
> The app signs in to a Relayium account (R3-B) and now sends files (R3-C), and
> neither needs a capability. The bearer token and the stored-link keys live in
> this app's **own default per-app keychain access group** — the one every app
> gets — which is why no `keychain-access-groups` entitlement appears here.
> Naming a group would claim a credential share with another app that does not
> exist, and on a signed device build it would fail with
> `errSecMissingEntitlement` (-34018).
>
> `PhotosPicker` likewise needs neither an entitlement nor an
> `NSPhotoLibraryUsageDescription`: it runs out of process and hands back only
> the items the user picked, so this app never has library access to ask for.
>
> Still absent, each with the slice that would earn it: Associated Domains
> (link handoff), an App Group and a shared keychain group (a Share Extension),
> local network (nearby), background modes (transfers surviving suspension),
> push, IAP. An entitlement is a claim the app makes to the OS and to the user;
> each one lands with the functional slice that needs it, never in advance.

- [ ] **Step 6: Checkpoint**

```bash
xcodebuild -scheme RelayiumKit -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
xcodebuild -project apps/ios/Relayium.xcodeproj -scheme Relayium \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project apps/mac/Relayium.xcodeproj -scheme Relayium build
plutil -lint apps/ios/Relayium/Relayium.entitlements apps/ios/Relayium/Info.plist
```
Expected: three BUILD SUCCEEDED and two OK. Record the output. Do not commit.

### Task 7: The surface guard, updated deliberately

**Files:**
- Modify: `apps/RelayiumKit/Tests/RelayiumKitTests/IOSSurfaceGuardTests.swift`

- [ ] **Step 1: Correct the file's own doc comment**

It still says "Nineteen catalog strings name a platform". Update it to record
that re-deriving the set found **twenty-two** — R3-B's count missed
`error.storedKey.keychain.save`, `.read` and `.remove`, all of which say
*macOS* — that five are corrected and rendered by this slice, and that
seventeen remain.

- [ ] **Step 2: Move `CloudUploadModel` off the deferred list, and add six**

`CloudUploadModel` leaves `testNoDeferredFeatureIsReferenced` — this is the
slice that ships it. Everything else stays. Added, in two clearly labelled
groups: *a later slice owns this* (unchanged entries) and *this is the wrong way
to do this slice's work* — `URLSessionConfiguration.background`,
`DataRepresentation`, `Data.self`, `startAccessingSecurityScopedResource`,
`SelectionStore` (the view reads the model's forwarded state, not the nested
store) and `TaskLocal` (no ambient import context).

- [ ] **Step 3: Take the platform-naming list from nineteen to seventeen**

```swift
        let platformNaming: [L10nKey] = [
            // R3-D: device and stored-file management, and rebuilding a link
            // from a stored key.
            .accountThisMac, .accountRevokeThisMac, .accountKeyNotOnThisMac,
            .accountKeyLookupFailed, .accountKeyCleanupWarning, .accountBearerInvalid,
            .errorStoredLinkKeyInvalidKey,
            .errorStoredKeyKeychainRead, .errorStoredKeyKeychainRemove,
            // R3-E / R3-F: realtime, nearby, notifications.
            .nearbyExplain, .nearbyPausedBody, .nearbyAcceptanceNote,
            .notifyIncomingFiles, .notifyIncomingText, .verifyExplainEncryption,
            .errorNearbyNoAnswer,
            // Rendered by nothing on either platform yet.
            .errorKeychainSignIn,
        ]
        XCTAssertEqual(platformNaming.count, 17)
```

with a comment recording why `errorStoredLinkKeyInvalidKey` moved from R3-C to
R3-D: `storedLinkKeyMessage` reaches it only on `.read`, and sending never reads
a stored key.

- [ ] **Step 4: Add the new guards**

```swift
    /// The bearer is read at the moment of use and nowhere else. It is not
    /// `@Published` on purpose — a credential has no business in the
    /// view-update surface — so the send button's ENABLEMENT comes from
    /// `session.state` and its ACTION re-reads the token. The upload model does
    /// capture it for the life of one authenticated upload task; that is what
    /// an authenticated upload is, and it is not this guard's business. What
    /// this guard forbids is a SECOND holder in the view layer.
    func testTheBearerIsReadInExactlyOnePlaceOnce() throws {
        let all = try sources()
        XCTAssertEqual(all.map { $0.text.components(separatedBy: "bearerToken").count - 1 }
                          .reduce(0, +), 1)
        let owner = try XCTUnwrap(all.first { $0.text.contains("bearerToken") })
        XCTAssertEqual(owner.name, "SendView.swift")
    }

    /// Account-owned work is app-scoped. SwiftUI mounts tabs lazily and can
    /// tear down an off-screen one, so a view that owned the account context
    /// would silently stop isolating the moment the user was looking elsewhere.
    func testTheAccountContextIsNotDrivenByAView() throws {
        let view = try XCTUnwrap(try sources().first { $0.name == "SendView.swift" })
        for symbol in ["SendAccountContext", "applyAccountContext", "accountContextChanged"] {
            XCTAssertFalse(view.text.contains(symbol),
                           "SendView must not drive the account: \(symbol)")
        }
        let app = try XCTUnwrap(try sources().first { $0.name == "RelayiumApp.swift" })
        XCTAssertTrue(app.text.contains(".observe("),
                      "the session observation belongs to the app scope")
    }

    /// PhotosPicker returns only what the user chose, out of process. That is
    /// exactly why it needs no library permission — declaring one would ask for
    /// access this app never takes. Same rule as the empty entitlements file.
    func testTheInfoPlistClaimsNoPhotoLibraryAccessAndNoBackgroundMode() throws {
        let plist = try infoPlist()
        XCTAssertNil(plist["NSPhotoLibraryUsageDescription"])
        XCTAssertNil(plist["NSPhotoLibraryAddUsageDescription"])
        XCTAssertNil(plist["UIBackgroundModes"])
        XCTAssertEqual(plist["CFBundleLocalizations"] as? [String],
                       ["en", "zh-Hans", "ja", "ko", "de", "fr", "ar", "es", "pt"])
    }
```

`testTheReceiveFlowIsIndependentOfTheSession`,
`testLaunchRestoreIsWiredExactlyOnceInTheShell`,
`testTheSignInFormHasExactlyOneCallSite`,
`testTheEntitlementsFileIsStillEmpty` (which parses the plist and is unaffected
by the comment rewrite) and `testNothingInTheAppOrViewModelLayerLogs` are
unchanged and must keep passing; bump the `atLeast:` source counts to match the
new file counts in both roots.

- [ ] **Step 5: Checkpoint**

Run: `cd apps/RelayiumKit && swift test --filter IOSSurfaceGuardTests`
Expected: PASS. A failure here is a real finding, not a threshold to raise.
Record the output. Do not commit.

### Task 8: Status and full acceptance

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the iOS status bullet**

Extend the `**iOS — in development, not public:**` bullet so it describes
sending truthfully, and remove sending from the list of what remains. The Share
Extension **stays** on that list — the correction is to the plan's promise about
when, which lives in the design document. Add the foreground-only limitation in
one clause:

> … it can now also send: choose files, folders, photos or videos in the app,
> pick how long the link lives and whether it is deleted after the first
> download, and hand the finished link to the share sheet. Files are encrypted
> on the device and the key never reaches Relayium. Sending needs an account;
> receiving still does not. Uploads run only while the app is open — there is no
> background transfer or resume yet. Everything else in the iOS plan — realtime
> and nearby transfer, device and stored-file management, universal links, the
> Share Extension, background transfer, notifications, and App Store release —
> is still to be built, and there is no download to install.

Nothing else in `README.md` changes.

- [ ] **Step 2: Run everything**

```bash
cd apps/RelayiumKit && swift test
```
Expected: PASS. Only `testKeychainRoundTripIfAvailable` may skip.

```bash
xcodebuild -scheme RelayiumKit -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
xcodebuild -project apps/ios/Relayium.xcodeproj -scheme Relayium \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project apps/mac/Relayium.xcodeproj -scheme Relayium build
```
Expected: three BUILD SUCCEEDED. The macOS build is not optional — this round
changes `CloudUploadModel`, `UploadPresentation` and the catalogs it renders.

```bash
plutil -lint apps/ios/Relayium/Info.plist apps/ios/Relayium/Relayium.entitlements \
  apps/RelayiumKit/Sources/RelayiumAppKit/Resources/*.lproj/Localizable.strings
apps/mac/scripts/test-release-readiness.sh
git diff --check
git status --short --untracked-files=all
```
Expected: all OK; the readiness manifest still `approved: false`; no whitespace
errors; the working tree shows only the intended files plus the pre-existing,
untouched `output/`.

- [ ] **Step 3: Install and launch on a simulator**

```bash
xcrun simctl list devices available | head -20        # resolve a real device name
xcodebuild -project apps/ios/Relayium.xcodeproj -scheme Relayium \
  -destination 'platform=iOS Simulator,name=<device>' \
  -derivedDataPath /private/tmp/relayium-ios-r3c CODE_SIGNING_ALLOWED=NO build
xcrun simctl boot '<device>' || true
xcrun simctl install booted \
  /private/tmp/relayium-ios-r3c/Build/Products/Debug-iphonesimulator/Relayium.app
xcrun simctl launch booted com.relayium.app
```

Confirm, by hand: the app stays running; three tabs; the Receive tab still works
with nobody signed in; the Send tab signed out shows the account explanation and
its button switches to the Account tab; after signing in, the Files importer
opens and a chosen file appears in the summary; the Photos picker opens without
any permission prompt; **reopening the Photos picker and choosing the same items
imports again**; **cancelling the Photos picker leaves the current selection
untouched**; the TTL picker offers only the plan's retentions; the keep-open note
appears while uploading; **signing out from the Receive tab during an upload
stops it**, and the Send tab is clean when opened afterwards; the finished link
is selectable and the share sheet opens; and under an Arabic system language the
send pane lays out right to left.

- [ ] **Step 4: Hand off**

Report the full evidence — every checkpoint's output, the three builds, the
lints, the readiness check, and the simulator observations — for independent
review. **Do not commit and do not push.**

## Checkpoints

Stop and reassess rather than pressing on if any of these does not hold:

1. **After Task 1** — starts and stops balance in every sequence, including
   deallocation.
2. **After Task 2** — a candidate cleans itself on `deinit`, ownership transfers
   only after a successful move, a failed move keeps the candidate responsible,
   the byte cap holds after a collision suffix, and no mutable static exists.
3. **After Task 4** — a file choice overtakes an in-flight import and the
   importing flag goes down; a second import supersedes the first and the flag
   stays up; a partial photo failure leaves no prior file selection restorable;
   a `CurrentValueSubject` sign-out cancels the upload **synchronously** with no
   view in existence; a stale config response applies nothing.
4. **After Task 5** — `swift test --filter Localiz` is green.
5. **After Task 7** — the guard is green *and* its diff reads as a set of
   decisions, not as thresholds lowered to fit.

## Acceptance

1. `cd apps/RelayiumKit && swift test` — the full suite passes, including
   `SecurityScopedAccessTests`, `PhotoStagingTests`, `SendPresentationTests`,
   `SendSelectionModelTests`, `CloudUploadModelTests`, `LocalizedCopyTests`,
   `LocalizationIntegrityTests`, `LocalizationSourceGuardTests` and
   `IOSSurfaceGuardTests`. Only the documented opt-in real-Keychain test skips.
2. Every security scope that starts is stopped exactly once — on replace, on
   clear, on refusal, and on deallocation — and a start that returned `false` is
   never stopped.
3. The scope is held before `expandSelection` enumerates and stays held while
   the selection lives, so `stageCloudFiles` opens every descriptor inside it.
4. An upload-model refusal leaves nothing held and leaves `reset()` unable to
   return to files whose access is gone.
5. Photos arrive through `FileRepresentation` only; the static representation
   calls exactly one narrow package function and reads no ambient context; the
   second step **moves** rather than copies; no `DataRepresentation`,
   `Data.self`, `TaskLocal` or mutable static appears.
6. **A `PhotoCandidate` owns its inbox directory and frees it exactly once** —
   on `discard()`, on a successful `adopt`, or in `deinit` — so a
   `StagedPhotoFile` the framework drops leaks nothing. **No runtime inbox sweep
   exists**; the single sweep runs at app-scoped construction.
7. A failed move leaves the candidate still owning and still cleaning up its
   directory; an adopted candidate's later `deinit` never touches the batch.
8. Final photo names are collision-safe within the batch, hold ≤ 200 UTF-8 bytes
   **after** any `(n)` suffix, never split a multibyte character, and turn a name
   that is only an extension into `photo.<ext>`.
9. A photo import replaces the selection at its start: a partial failure leaves
   nothing selected, including nothing of the file selection that preceded it,
   and leaves no batch or candidate on disk.
10. **Within a ready account, `upload.isBusy` is the only refusal.** A callback
    that starts after sign-out is refused before touching resources. A file
    choice supersedes an in-flight import and the importing flag goes down; a second import
    supersedes the first and the flag stays up; Clear, a zero-item model call
    and account isolation supersede and lower the flag. Superseded work discards
    its own batch and candidates and reports no error.
11. The Photos binding is reusable: the view captures a non-empty array, resets
    the binding immediately, imports from the captured array, and ignores the
    resulting empty change. Cancelling the system picker changes nothing.
    `importPhotos(count: 0)` remains a model-level defensive path, tested
    directly and never reached from the view.
12. Leaving a ready account — including a change of the ready user's id —
    cancels any in-flight upload first, then supersedes imports, cancels the
    config task and clears selection, scopes, staged files, model state and caps.
    **This holds with no `SendView` in existence, and happens synchronously with
    the session's state write.**
13. Retention comes from `usage.plan.retentionSecs` and `maxFileSize` from
    `CloudClient.fetchConfig()`, applied only under a ready account; a response
    that lands after a sign-out or an account switch applies nothing; a slow
    fetch never delays a later account event; a fetch failure leaves the size
    unknown and the flow usable.
14. `bearerToken` appears in exactly one iOS source, exactly once, inside the
    send action; a sign-out that beats the tap produces
    `error.cloud.unauthorized` rather than a request with an empty bearer.
15. The view renders `summary`, `selectionError`, `isImportingPhotos` and
    `importError` published by `SendSelectionModel` itself; it never names
    `SelectionStore`, `SendAccountContext` or `applyAccountContext`; a
    preparation failure sets `selectionError` **without touching
    `CloudUploadModel`**, while an upload-model refusal remains an upload
    failure. `accountUserId` is internal isolation state, not UI.
16. The success state uses `ShareLink` and `.textSelection(.enabled)`; no
    pasteboard API appears anywhere; exactly one statement is made about the key;
    the expiry line, send-another, cancel, retry and clear behave as before.
17. `upload.keepOpen` is rendered while uploading, in all nine languages, and no
    background `URLSession`, resume claim or client-side upload `DELETE` exists.
18. Five platform-naming strings are corrected in place across all nine
    catalogs; the guarded list is seventeen with the count asserted;
    `error.storedLinkKey.invalidKey` is recorded as R3-D on reachability
    grounds; no iOS source renders any guarded key.
19. `Relayium.entitlements` is still an empty dict, and its comment now describes
    the default per-app keychain group and this slice's zero new capabilities;
    `Info.plist` declares no photo-library usage string and no background mode;
    `CFBundleLocalizations` is unchanged.
20. Three builds succeed — package for iOS, iOS app unsigned, macOS app —
    `plutil -lint` is clean, and `test-release-readiness.sh` still reports
    `approved: false`.
21. The app installs and launches on a simulator and behaves as listed in Task 8
    Step 3.

## Delivery

Claude's batch ends at Task 8 Step 4 with evidence and an uncommitted working
tree. Codex then:

1. reviews the complete diff and the surrounding failure paths independently,
   disposing of every finding explicitly as fixed or skipped with a reason;
2. reproduces the gates — `swift test`, the three `xcodebuild` invocations,
   `plutil -lint`, `test-release-readiness.sh` — rather than accepting reported
   output;
3. confirms `git status --short --untracked-files=all` shows only the intended
   files plus the untouched `output/`;
4. makes **one** English commit for the slice and pushes it;
5. records the checkpoint in `DEVELOPMENT-LOG.md` and any material decisions in
   `DECISION-LOG.md`, keeping both outside this repository.

## Outstanding manual validation

Recorded rather than claimed. The simulator proves the code runs; it does not
prove the sandbox behaves, because it is not a signed device build:

- a real send from a signed-in simulator against the production API, and the
  resulting link opening on the web and in the app's own receive tab;
- **the security scope on a real device**, including an iCloud Drive folder
  chosen through Files, where the scope covers a provider and enumeration can
  block or fail;
- a multi-gigabyte video import — the case `FileRepresentation` exists for, and
  the one where the inbox-to-batch move being a rename actually matters;
- a real sign-out during a real upload **while the Send tab has never been
  opened**, confirming the transfer stops and the server-side session is
  abandoned rather than completing;
- an upload interrupted by backgrounding, to confirm the failure is the ordinary
  one and the keep-open copy was accurate;
- `GET /api/config` against production, confirming the returned `maxFileSize`
  matches the deployed setting;
- a stored-link key round trip on a signed device build;
- VoiceOver and the largest Dynamic Type sizes on the send pane;
- Arabic right-to-left layout of the send pane specifically.

## Follow-ups this slice deliberately does not do

- Adopt `SendSelectionModel` (or at least `SecurityScopedAccess`) in the macOS
  `UploadPane`, replacing its view-scoped `SelectionStore` and its
  `.onChange(of: selection.revision)` bridge.
- Adopt `SignInPresentation` in the macOS `ContentView` — still open from R3-B.
- Use `ServerConfig.maxFileSize` on macOS too: it has the same advisory size gate
  and the same never-called `fetchConfig()`.
- Tell the user when account isolation abandons an upload, which needs a
  cross-tab notice this slice does not have.
- Map an out-of-space staging failure to its own message instead of the general
  `error.photoImport.failed`.
- The seventeen catalog strings that still name a platform, each with the slice
  that first renders it: R3-D (nine), R3-E/R3-F (seven), and
  `error.keychain.signIn`.
- **The Share Extension**, with Associated Domains and the rest of the capability
  work, in the separately designed release slice.
