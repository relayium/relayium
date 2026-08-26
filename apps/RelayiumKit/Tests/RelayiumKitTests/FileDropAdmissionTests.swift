import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// **What a Finder drag is allowed to do to a staged selection.**
///
/// The drop *gesture* is AppKit's and has no unit test. Everything the gesture
/// decides does: which payloads become URLs, whether a mixed batch may be
/// partially staged, whether a surface that took ownership during the item load
/// may still be written to, and what the staged batch looks like afterwards.
/// That seam is `admitFileDrop` feeding `SelectionStore.add`, which is the same
/// method both file pickers call — so a rule proved here is a rule both the
/// Cross-network Transfer pane and the Device Inbox composer obey.
@MainActor
final class FileDropAdmissionTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("drop-admit-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    @discardableResult
    private func file(_ relative: String) throws -> URL {
        let url = root.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try Data([1, 2, 3]).write(to: url)
        return url
    }

    /// **The ordinary drag: one surface, still itself when the payload lands.**
    ///
    /// Every rule below this line is about the BATCH, so they all hold the
    /// context still and say so once, here. The context's own rules — what
    /// happens when the surface is REPLACED between the drop and the payload —
    /// are stated in their own section, against `admitFileDrop` directly.
    private func admit(_ items: [Any?], isBusy: Bool) -> FileDropAdmission {
        let here = FileDropContext("attempt 7")
        return admitFileDrop(items, isBusy: isBusy, droppedInto: here, nowServing: here)
    }

    private func dir(_ relative: String) throws -> URL {
        let url = root.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    // MARK: - the batch a drag is allowed to stage

    /// One file, which is the whole of the ordinary case.
    func testOneDroppedFileIsAdmitted() throws {
        let a = try file("a.txt")
        XCTAssertEqual(admit([a], isBusy: false), .accepted([a.standardizedFileURL]))
    }

    /// Many files, **in the order they were dropped**, because that order
    /// becomes manifest order and the far side reconstructs from it.
    func testManyDroppedFilesKeepTheOrderTheyWereDroppedIn() throws {
        let urls = [try file("c.txt"), try file("a.txt"), try file("b.txt")]
        guard case let .accepted(admitted) = admit(urls, isBusy: false) else {
            return XCTFail("a batch of readable files was not admitted")
        }
        XCTAssertEqual(admitted.map(\.lastPathComponent), ["c.txt", "a.txt", "b.txt"],
                       "the drop was re-ordered, so the same drag would send two manifests")
    }

    /// A folder is a legal drop, exactly as it is a legal pick: the selection
    /// contract has offered `canChooseDirectories = true` on every picker in the
    /// app, and a drag that refused what the button accepts would be a second
    /// answer to "what may a user hand us".
    func testAFolderIsAdmittedAndExpandsWithItsHierarchy() throws {
        try file("trip/day1/a.jpg")
        let folder = try dir("trip")
        guard case let .accepted(admitted) = admit([folder], isBusy: false) else {
            return XCTFail("a dropped folder was refused")
        }
        let store = SelectionStore()
        store.add(admitted)
        XCTAssertEqual(store.selection?.files.map(\.relativePath), ["trip/day1/a.jpg"],
                       "a dropped folder lost the hierarchy the manifest carries")
    }

    /// Every representation `public.file-url` is actually vended as. A drag from
    /// an app that hands back `NSURL` used to do nothing at all, silently.
    func testEveryPayloadRepresentationIsAdmitted() throws {
        let a = try file("a.txt")
        let items: [Any?] = [a,
                             a as NSURL,
                             a.dataRepresentation,
                             a.dataRepresentation as NSData,
                             a.absoluteString,
                             a.absoluteString as NSString]
        guard case let .accepted(admitted) = admit(items, isBusy: false) else {
            return XCTFail("a representation the OS actually vends was refused")
        }
        XCTAssertEqual(Set(admitted), [a.standardizedFileURL],
                       "the same file in six spellings did not canonicalise to one URL")
    }

    // MARK: - all or nothing

    /// **The rule the drop target did not used to have.** One unusable item in a
    /// batch of four refuses the whole drag; it does not stage the three that
    /// worked and leave the gap to be discovered after Send.
    func testOneUnreadableItemRefusesTheWholeBatch() throws {
        let good = [try file("a.txt"), try file("b.txt"), try file("c.txt")]
        for spoiler in [nil, "https://relayium.com/x" as Any?, "" as Any?, 17 as Any?] {
            var items: [Any?] = good
            items.insert(spoiler, at: 2)
            XCTAssertEqual(admit(items, isBusy: false), .refusedUnreadable,
                           "a batch containing \(String(describing: spoiler)) was partly admitted")
        }
    }

    /// And the refusal is a refusal all the way through: nothing reaches the
    /// store, so there is no half-batch for a Send to pick up.
    func testARefusedBatchStagesNothingAtAll() throws {
        let store = SelectionStore()
        store.add([try file("already.txt")])
        let before = store.files.map(\.relativePath)

        let items: [Any?] = [try file("a.txt"), nil]
        guard case .refusedUnreadable = admit(items, isBusy: false) else {
            return XCTFail("a batch with an unusable item was admitted")
        }
        // The caller stages nothing on this outcome, which is what the surfaces
        // do; what must also hold is that the batch already staged is untouched.
        XCTAssertEqual(store.files.map(\.relativePath), before,
                       "a refused drag disturbed the selection the user already had")
    }

    /// A drag out of a browser is a URL, and a URL is not a file. It must not
    /// become a file send — and, per the rule above, it must not quietly reduce
    /// a mixed batch either.
    func testANonFileURLIsNeverAdmitted() throws {
        XCTAssertEqual(admit(["https://relayium.com/download"], isBusy: false),
                       .refusedUnreadable)
        XCTAssertEqual(admit(["/etc/hosts"], isBusy: false), .refusedUnreadable,
                       "a bare POSIX path was treated as a file URL nobody promised")
    }

    /// AppKit only delivers providers for the types the target asked for, so a
    /// drag carrying nothing this surface wants arrives empty rather than wrong.
    func testAnEmptyDragIsNeitherAcceptedNorReportedAsAnError() {
        XCTAssertEqual(admit([], isBusy: false), .empty)
    }

    // MARK: - the surface may have moved on

    /// **Admission at drop time is not authority to mutate the selection.**
    /// AppKit accepts a drop before the payload exists; a transfer can start, a
    /// link can end or a device can be revoked while the item providers resolve.
    func testABusySurfaceRefusesEvenAPerfectlyGoodBatch() throws {
        XCTAssertEqual(admit([try file("a.txt")], isBusy: true), .refusedBusy)
    }

    /// Busy is decided FIRST and on its own. A batch refused because the link
    /// ended is not also reported as unreadable — the items may have been fine,
    /// and naming the wrong reason sends the user to fix the wrong thing.
    func testBusyOutranksAnUnreadableItemSoTheReasonIsNotMisreported() throws {
        let items: [Any?] = [try file("a.txt"), nil]
        XCTAssertEqual(admit(items, isBusy: true), .refusedBusy)
    }

    // MARK: - dropping the same thing twice

    /// Duplicates are the store's answer, not a second rule here: dropping the
    /// same folder twice is a no-op rather than a doubled manifest that the far
    /// side would refuse for colliding paths.
    func testDroppingTheSameItemsAgainDoesNotDoubleTheBatch() throws {
        let a = try file("a.txt")
        let folder = try dir("pics")
        try file("pics/p.jpg")
        let store = SelectionStore()

        for _ in 0..<2 {
            guard case let .accepted(urls) = admit([a, folder], isBusy: false) else {
                return XCTFail("a readable batch was refused")
            }
            store.add(urls)
        }
        XCTAssertEqual(store.roots.count, 2)
        XCTAssertEqual(store.files.map(\.relativePath), ["a.txt", "pics/p.jpg"])
    }

    /// One drag can carry the same item more than once. It is still one root.
    func testOneDragCarryingTheSameItemTwiceStagesItOnce() throws {
        let a = try file("a.txt")
        guard case let .accepted(urls) = admit([a, a as NSURL], isBusy: false) else {
            return XCTFail("a readable batch was refused")
        }
        let store = SelectionStore()
        store.add(urls)
        XCTAssertEqual(store.roots.count, 1)
        XCTAssertEqual(store.files.map(\.relativePath), ["a.txt"])
    }

    // MARK: - cancellation

    /// **Clear is the cancellation, and it is the only one.** Both surfaces put
    /// a dragged batch behind an explicit Send, so the state between the drop
    /// and the press has to be discardable without sending anything.
    func testClearDiscardsADraggedBatchWithoutSendingIt() throws {
        let store = SelectionStore()
        guard case let .accepted(urls) = admit([try file("a.txt")], isBusy: false) else {
            return XCTFail("a readable batch was refused")
        }
        store.add(urls)
        XCTAssertFalse(store.isEmpty)
        store.clear()
        XCTAssertTrue(store.isEmpty)
        XCTAssertTrue(store.roots.isEmpty)
        XCTAssertNil(store.error)
    }

    // MARK: - the existing bounds still apply to a drag

    /// A drag goes through `expandSelection` exactly as a pick does, so the
    /// bound that has to hold before a connection is opened still holds — and
    /// the batch is refused WHOLE: `selection` is nil, so no Send can find a
    /// truncated manifest to carry.
    func testADroppedSymlinkIsRefusedAndStagesNoFilesAtAll() throws {
        let a = try file("a.txt")
        let link = root.appendingPathComponent("shortcut.txt")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: a)

        guard case let .accepted(urls) = admit([a, link], isBusy: false) else {
            return XCTFail("the decode stage refused a batch it should have passed on")
        }
        let store = SelectionStore()
        store.add(urls)
        XCTAssertNil(store.selection, "a symlinked batch left files a Send could carry")
        XCTAssertTrue(store.files.isEmpty)
        XCTAssertNotNil(store.error, "a refused drag said nothing about why")
        // The roots are kept, so the user can see what they dropped and take the
        // offending item out rather than starting the whole batch over.
        XCTAssertEqual(store.roots.count, 2)
    }

    /// The count bound is the selection's, and a drag cannot get around it.
    func testTheFileCountBoundStillAppliesToADraggedFolder() throws {
        XCTAssertThrowsError(try checkSelectionBounds(relativePath: "a.txt",
                                                      countSoFar: MAX_FILES)) { error in
            XCTAssertEqual(error as? FileSelectionError, .tooManyFiles)
        }
    }

    // MARK: - the surface may have been REPLACED

    /// **The defect, in the order it happens.**
    ///
    /// `TransferLinkPane` is rendered for `.ended` as well as `.open`, so the
    /// pane and its `@StateObject SelectionStore` outlive the attempt they were
    /// drawn for. A drag accepted on attempt 7, over a 7 that ended while its
    /// item providers were resolving, meets an attempt 8 that is open, has its
    /// digits answered and is **not busy** — so every state read the adapter had
    /// says yes, and the batch stages onto a peer nobody dropped it on.
    ///
    /// Both arms are asserted deliberately. The refusal alone would also pass if
    /// the token refused everything.
    func testADragFromAnEndedAttemptDoesNotStageOntoTheOneThatReplacedIt() throws {
        let a = try file("a.txt")
        let seven = FileDropContext("attempt 7")
        let eight = FileDropContext("attempt 8")
        // The pane's own store, which survived the ending along with the pane.
        let store = SelectionStore()

        XCTAssertEqual(admitFileDrop([a], isBusy: false,
                                     droppedInto: seven, nowServing: eight),
                       .refusedStaleContext,
                       "a drag begun on a link that ended was staged onto its replacement")
        XCTAssertTrue(store.isEmpty)

        // Non-vacuous: the SAME batch, the same non-busy surface, and the only
        // difference is that the attempt is the one that was dropped on.
        guard case let .accepted(urls) = admitFileDrop([a], isBusy: false,
                                                       droppedInto: eight,
                                                       nowServing: eight) else {
            return XCTFail("the token refuses a drag that never left its own attempt")
        }
        store.add(urls)
        XCTAssertEqual(store.files.map(\.relativePath), ["a.txt"])
    }

    /// The same substitution on the Device Inbox's terms: one device page, two
    /// devices. `target != nil` is true for the second one, which is exactly why
    /// the busy read cannot carry this.
    func testADragFromOneDevicePageDoesNotStageForTheDeviceThatReplacedIt() throws {
        let a = try file("a.txt")
        XCTAssertEqual(admitFileDrop([a], isBusy: false,
                                     droppedInto: FileDropContext("device-A"),
                                     nowServing: FileDropContext("device-B")),
                       .refusedStaleContext,
                       "a drag begun on one device's page staged for another device")
        XCTAssertEqual(admitFileDrop([a], isBusy: false,
                                     droppedInto: FileDropContext("device-A"),
                                     nowServing: FileDropContext("device-A")),
                       .accepted([a.standardizedFileURL]),
                       "the same device refused its own drag")
    }

    /// **Stale is decided FIRST**, before busy and before any decoding. Once the
    /// target has been substituted, `isBusy` describes the REPLACEMENT — and
    /// reporting the replacement's state as this batch's reason would name a
    /// surface the user never dropped anything on.
    func testStaleOutranksBusySoTheReplacementsStateIsNotReported() throws {
        XCTAssertEqual(admitFileDrop([try file("a.txt")], isBusy: true,
                                     droppedInto: FileDropContext("attempt 7"),
                                     nowServing: FileDropContext("attempt 8")),
                       .refusedStaleContext)
    }

    /// …and before the payload is judged, for the same reason busy is: the items
    /// may have been perfectly good, and they were never this surface's business.
    func testStaleOutranksAnUnreadableItem() throws {
        let items: [Any?] = [try file("a.txt"), nil]
        XCTAssertEqual(admitFileDrop(items, isBusy: false,
                                     droppedInto: FileDropContext("attempt 7"),
                                     nowServing: FileDropContext("attempt 8")),
                       .refusedStaleContext)
    }

    /// An empty drag onto a replaced surface is still stale rather than empty:
    /// the reason a surface gives has to be about the surface, and `.empty` is a
    /// statement that THIS target was offered nothing.
    func testAnEmptyDragOntoAReplacedSurfaceIsStaleRatherThanEmpty() {
        XCTAssertEqual(admitFileDrop([], isBusy: false,
                                     droppedInto: FileDropContext("attempt 7"),
                                     nowServing: FileDropContext("attempt 8")),
                       .refusedStaleContext)
    }

    /// A surface whose destination cannot be replaced says so, and its drags are
    /// never stale. `fixed` is only ever compared against itself within one drop.
    func testAFixedDestinationNeverGoesStale() throws {
        let a = try file("a.txt")
        XCTAssertEqual(admitFileDrop([a], isBusy: false,
                                     droppedInto: .fixed, nowServing: .fixed),
                       .accepted([a.standardizedFileURL]))
        // …and it is not a wildcard. A surface that passed `fixed` while another
        // passed a real identity would otherwise be admitted by either.
        XCTAssertNotEqual(FileDropContext.fixed, FileDropContext("attempt 0"))
        XCTAssertEqual(admitFileDrop([a], isBusy: false,
                                     droppedInto: .fixed,
                                     nowServing: FileDropContext("attempt 0")),
                       .refusedStaleContext)
    }

    // MARK: - the drag source is not trusted

    /// `NSItemProvider.loadItem` runs a block supplied by the **drag source** —
    /// another application. Resuming a bridged continuation twice is a runtime
    /// trap, not a recoverable error, so a source that calls its completion
    /// handler twice must be ignored rather than able to terminate Relayium.
    func testAProviderThatCallsBackTwiceIsAnsweredOnlyOnce() {
        let once = OneShotClaim()
        XCTAssertTrue(once.claim())
        XCTAssertFalse(once.claim())
        XCTAssertFalse(once.claim())
    }

    /// …including when the two calls race on different queues, which is how a
    /// real provider would deliver them.
    func testOnlyOneOfManyConcurrentCallbacksWins() {
        let once = OneShotClaim()
        let claims = NSMutableArray()
        let lock = NSLock()
        DispatchQueue.concurrentPerform(iterations: 64) { _ in
            if once.claim() {
                lock.lock(); claims.add(true); lock.unlock()
            }
        }
        XCTAssertEqual(claims.count, 1, "a racing provider resumed the continuation twice")
    }

    // MARK: - what a staged batch belongs to, after the drag is over

    /// **The first target a surface reports is not a substitution.**
    ///
    /// A page that has just been built has staged nothing. Treating "I had no
    /// previous answer" as a change would discard a batch adopted before the
    /// first render — which is exactly what `adoptOpenedFiles` produces when the
    /// OS opens files into a launching app.
    func testTheFirstTargetReportedIsNotASubstitution() {
        var lifetime = StagedSelectionLifetime()
        XCTAssertFalse(lifetime.serving(FileDropContext("device-a")))
    }

    /// **A re-render is not a substitution**, however many of them there are.
    ///
    /// This is the half of the rule that protects the user's work: SwiftUI
    /// re-evaluates a body for any published change on the surface — a transfer
    /// progressing, a message arriving, a byte counter ticking — and a batch that
    /// were discarded by any of those would be a drag-and-drop feature that
    /// silently empties itself while the user is looking at it.
    func testTheSameTargetReportedAgainIsNeverASubstitution() {
        var lifetime = StagedSelectionLifetime()
        XCTAssertFalse(lifetime.serving(FileDropContext("device-a")))
        for _ in 0..<64 {
            XCTAssertFalse(lifetime.serving(FileDropContext("device-a")),
                           "a re-render of the same device discarded the staged batch")
        }
    }

    /// **A different device is a substitution**, which is the Device Inbox case:
    /// a host that renders `DeviceConversationPage` without an identity of its
    /// own reuses the page, and its `@StateObject selection` with it, across a
    /// swap from one open device straight to another. `DeviceInboxSurface` keys
    /// it `.id(peer.id)` today, so this rule is the depth behind that key rather
    /// than the thing currently doing the work there — the value's own contract
    /// is what is under test, and it must hold for any host.
    func testAReplacedDeviceIsASubstitution() {
        var lifetime = StagedSelectionLifetime()
        _ = lifetime.serving(FileDropContext("device-a"))
        XCTAssertTrue(lifetime.serving(FileDropContext("device-b")),
                      "a batch staged for device A survived into device B")
    }

    /// **A new attempt is a substitution**, which is the Cross-network Transfer
    /// case: `TransferLinkPane` renders through `.ended` and into the next
    /// attempt, carrying the same `@StateObject dropped`.
    func testANewAttemptIsASubstitution() {
        var lifetime = StagedSelectionLifetime()
        _ = lifetime.serving(FileDropContext("attempt 1"))
        XCTAssertTrue(lifetime.serving(FileDropContext("attempt 2")),
                      "a batch staged on attempt 1 survived into attempt 2")
    }

    /// **Coming back to an earlier target is still a substitution.** A user who
    /// goes A → B → A left a batch staged for A, opened B, and returned; the
    /// batch is two devices old and the page they are looking at has been
    /// somebody else's since. `attemptGeneration` never returns to an earlier
    /// value, so this is the device case, and it is why the rule compares the
    /// LAST target rather than remembering every one it has seen.
    func testReturningToAnEarlierTargetStillDiscards() {
        var lifetime = StagedSelectionLifetime()
        _ = lifetime.serving(FileDropContext("device-a"))
        XCTAssertTrue(lifetime.serving(FileDropContext("device-b")))
        XCTAssertTrue(lifetime.serving(FileDropContext("device-a")),
                      "a batch staged for A, then abandoned for B, came back sendable")
    }

    /// **A surface that cannot be substituted never discards.** `FileDropZone`
    /// passes `.fixed` on every render because its destination is this account's
    /// own storage; the rule has to agree, or the stored-upload pane would empty
    /// itself for no reason.
    func testAFixedSurfaceIsNeverSubstituted() {
        var lifetime = StagedSelectionLifetime()
        XCTAssertFalse(lifetime.serving(.fixed))
        XCTAssertFalse(lifetime.serving(.fixed))
        XCTAssertFalse(lifetime.serving(.fixed))
    }

    /// **The rule and the store together**, which is what the two panes actually
    /// do: files staged under one target, the target replaced, and nothing left
    /// that Send could put on the new one — while the same batch under an
    /// unchanged target is still exactly what the user staged.
    func testASubstitutedTargetLeavesNothingStagedAndAnUnchangedOneLeavesEverything() throws {
        let kept = SelectionStore()
        var keptLifetime = StagedSelectionLifetime()
        _ = keptLifetime.serving(FileDropContext("device-a"))
        kept.add([try file("keep/one.txt"), try file("keep/two.txt")])
        XCTAssertEqual(kept.files.count, 2)
        if keptLifetime.serving(FileDropContext("device-a")) { kept.clear() }
        XCTAssertEqual(kept.files.count, 2,
                       "a re-render for the same device discarded a staged batch")

        let discarded = SelectionStore()
        var discardedLifetime = StagedSelectionLifetime()
        _ = discardedLifetime.serving(FileDropContext("device-a"))
        discarded.add([try file("drop/one.txt"), try file("drop/two.txt")])
        XCTAssertEqual(discarded.files.count, 2)
        if discardedLifetime.serving(FileDropContext("device-b")) { discarded.clear() }
        XCTAssertTrue(discarded.files.isEmpty,
                      "files staged for device A were still sendable to device B")
        XCTAssertNil(discarded.selection,
                     "the expansion staged for device A outlived the device")
    }
}
