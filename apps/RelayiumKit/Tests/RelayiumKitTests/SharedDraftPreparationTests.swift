import XCTest
@testable import RelayiumShareKit

/// The share extension's behaviour, with no share sheet in existence.
///
/// The two things most likely to be got wrong here cannot be reproduced against
/// a real `NSItemProvider` on demand:
///
///  1. **The copy must finish before the loader's callback returns.** The
///     provider deletes its temporary representation at that moment, so a
///     staging pass that dispatched the copy elsewhere would race a deletion for
///     the user's file — and would usually win on a small file and lose on a
///     video, which is the worst possible failure distribution.
///  2. **Cancel has to return while a copy is running.** The copy holds the
///     writer's ownership lock for its whole duration, so anything the button
///     touches under that lock is a button that does nothing until the copy it
///     was meant to stop has finished.
///
/// `SharedDraftItemLoading` and `SharedDraftHost` exist so both are assertions
/// rather than claims.
///
/// **There is no open-the-app case here, and there must not be one.** Apple
/// documents `NSExtensionContext.open` as the Today and iMessage extension
/// points' method; a Share Extension may not open its containing app. The
/// terminal success state says where the files are, and the app re-reads the
/// inbox when its scene becomes active.
@MainActor
final class SharedDraftPreparationTests: XCTestCase {
    private var root: URL!
    private var store: SharedDraftStore!

    override func setUp() async throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("share-prep-\(UUID().uuidString)")
        store = SharedDraftStore(root: root)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: root)
    }

    // MARK: - doubles

    /// A loader that behaves like the real one in the way that matters: it hands
    /// over a temporary file and DELETES IT the moment `stage` returns.
    ///
    /// That deletion is the whole point of the double. A staging pass that
    /// copied lazily would pass against a double that left the file alone and
    /// fail on a device.
    private final class TemporaryFileLoader: SharedDraftItemLoading, @unchecked Sendable {
        let names: [String]
        let contents: [String]
        /// Raised if anything is still readable after `stage` returned.
        private(set) var survivedTheCallback = false
        var failAt: Int?
        /// Armed just before `stage` is called, so the writer blocks INSIDE
        /// `adopt` — holding the ownership lock a copy holds for its whole
        /// duration. The temporary path is chosen here, so only this object can
        /// name it.
        var barrier: SharedDraftStoreTests.BarrierFileManager?

        init(names: [String], contents: [String]) {
            self.names = names
            self.contents = contents
        }

        var itemCount: Int { names.count }

        func load(_ index: Int, stage: @escaping (URL, String) throws -> Void) throws {
            if failAt == index { throw SharedDraftError.nothingUsable }
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent("provider-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: directory,
                                                    withIntermediateDirectories: true)
            let file = directory.appendingPathComponent(names[index])
            try Data(contents[index].utf8).write(to: file)
            defer {
                try? FileManager.default.removeItem(at: directory)
                if FileManager.default.fileExists(atPath: file.path) {
                    survivedTheCallback = true
                }
            }
            barrier?.armNext()
            try stage(file, names[index])
        }
    }

    private final class RecordingHost: SharedDraftHost {
        var finishes = 0
        var cancellations = 0

        func finish() { finishes += 1 }
        func cancelled() { cancellations += 1 }
    }

    private func waitUntil(_ condition: @MainActor () -> Bool) async {
        for _ in 0..<400 {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
    }

    // MARK: - nothing happens until the user asks

    func testConstructionCopiesNothing() throws {
        let loader = TemporaryFileLoader(names: ["a.txt"], contents: ["a"])
        let model = SharedDraftPreparation(store: store, loader: loader, host: RecordingHost())

        XCTAssertEqual(model.stage, .ready)
        XCTAssertEqual(model.itemCount, 1)
        XCTAssertEqual(store.drafts(), [],
                       "opening the sheet must not duplicate a 4 GB video before anybody asks")
    }

    // MARK: - the copy happens inside the callback

    func testEveryItemIsCopiedBeforeItsRepresentationIsDeleted() async throws {
        let loader = TemporaryFileLoader(names: ["one.txt", "two.txt"],
                                         contents: ["first", "second"])
        let host = RecordingHost()
        let model = SharedDraftPreparation(store: store, loader: loader, host: host)

        model.start()
        await waitUntil { model.stage == .published }

        XCTAssertFalse(loader.survivedTheCallback)
        let drafts = store.drafts()
        XCTAssertEqual(drafts.count, 1)
        let plan = try XCTUnwrap(drafts.first)
        XCTAssertEqual(plan.files.map(\.name), ["one.txt", "two.txt"])
        // The bytes, not an empty file of the right size: a copy that started
        // after the representation was deleted would produce exactly that.
        let staged = try store.stagedFiles(for: plan)
        XCTAssertEqual(try Data(contentsOf: staged[0].url), Data("first".utf8))
        XCTAssertEqual(try Data(contentsOf: staged[1].url), Data("second".utf8))
    }

    /// Several providers become ONE draft, in the order the sheet handed them
    /// over.
    func testSeveralProvidersBecomeOneDraftInOrder() async throws {
        let loader = TemporaryFileLoader(names: ["c.txt", "a.txt", "b.txt"],
                                         contents: ["3", "1", "2"])
        let host = RecordingHost()
        let model = SharedDraftPreparation(store: store, loader: loader, host: host)

        model.start()
        await waitUntil { model.stage == .published }

        let plan = try XCTUnwrap(store.drafts().first)
        XCTAssertEqual(store.drafts().count, 1, "one share invocation is one draft")
        XCTAssertEqual(plan.files.map(\.name), ["c.txt", "a.txt", "b.txt"],
                       "the sheet's own order is what the user chose")
    }

    // MARK: - failure publishes nothing and leaves nothing

    func testAFailurePartWayThroughLeavesNoHalfJobAndNoBytes() async throws {
        let loader = TemporaryFileLoader(names: ["one.txt", "two.txt", "three.txt"],
                                         contents: ["1", "2", "3"])
        loader.failAt = 2
        let host = RecordingHost()
        let model = SharedDraftPreparation(store: store, loader: loader, host: host)

        model.start()
        await waitUntil { if case .failed = model.stage { return true } else { return false } }

        guard case let .failed(message) = model.stage else {
            return XCTFail("expected a failure, got \(model.stage)")
        }
        XCTAssertEqual(message, L10n.t(.errorShareNothingUsable, language: .en))
        XCTAssertEqual(store.drafts(), [], "a part-way failure published a draft")
        // And the two files it HAD copied are gone, rather than sitting in the
        // container until an hour-old sweep notices them.
        let staging = store.stagingRoot
        let leftovers = (try? FileManager.default.contentsOfDirectory(atPath: staging.path)) ?? []
        XCTAssertEqual(leftovers, [], "a failed preparation left the user's bytes behind")
        XCTAssertEqual(host.finishes, 0)
    }

    func testAShareWithNoItemsFailsRatherThanPublishingAnEmptyDraft() async throws {
        let loader = TemporaryFileLoader(names: [], contents: [])
        let model = SharedDraftPreparation(store: store, loader: loader, host: RecordingHost())

        model.start()
        guard case let .failed(message) = model.stage else {
            return XCTFail("expected a failure, got \(model.stage)")
        }
        XCTAssertEqual(message, L10n.t(.errorShareNothingUsable, language: .en))
        XCTAssertEqual(store.drafts(), [])
    }

    /// Cancel landing in the window before the writer is reachable.
    ///
    /// The staging pass creates its writer inside a `Task.detached` and hands it
    /// back one main-actor hop later. A Cancel in that gap finds `writer == nil`
    /// — and `Task.detached` is not a child, so cancelling the outer task does
    /// not stop it, and its copy loop runs inside a provider callback where
    /// `Task.isCancelled` is false anyway. Without the model's own flag this
    /// would publish a draft the user explicitly refused, and then repaint the
    /// sheet as a success — leaving those bytes waiting on the Send tab for a
    /// share the user cancelled.
    func testCancellingBeforeTheWriterIsReachablePublishesNothing() async throws {
        let loader = TemporaryFileLoader(names: (0..<25).map { "f\($0).txt" },
                                         contents: (0..<25).map { "\($0)" })
        let host = RecordingHost()
        let model = SharedDraftPreparation(store: store, loader: loader, host: host)

        model.start()
        model.cancel()          // same main-actor turn: the writer does not exist yet

        // Let the staging pass run to whatever end it reaches.
        try? await Task.sleep(nanoseconds: 200_000_000)

        XCTAssertEqual(host.cancellations, 1)
        XCTAssertEqual(host.finishes, 0, "a cancelled share completed the host request")
        XCTAssertEqual(model.stage, .copying(staged: 0),
                       "a cancelled share repainted as success on its way out")
        XCTAssertFalse(model.isStaging, "a cancelled model still claims to own bytes")
        XCTAssertEqual(store.drafts(), [], "a cancelled share published a draft")
        let leftovers = (try? FileManager.default
            .contentsOfDirectory(atPath: store.stagingRoot.path)) ?? []
        XCTAssertEqual(leftovers, [], "a cancelled share left the user's bytes behind")
    }

    func testCancellingPublishesNothingAndCancelsTheHostRequest() async throws {
        let loader = TemporaryFileLoader(names: ["a.txt"], contents: ["a"])
        let host = RecordingHost()
        let model = SharedDraftPreparation(store: store, loader: loader, host: host)

        model.cancel()

        XCTAssertEqual(host.cancellations, 1)
        XCTAssertEqual(host.finishes, 0, "a cancelled share must not complete the request")
        XCTAssertEqual(store.drafts(), [])
    }

    // MARK: - the hand-off Apple actually supports

    /// Success is a state the user reads and dismisses, not a dismissal.
    ///
    /// A Share Extension may not open its containing app, so the sheet cannot
    /// hand the user over — which makes the sentence on this screen the ONLY
    /// place they learn that the copy finished and that nothing was uploaded.
    /// Completing the host request on our own would take that away and leave the
    /// sheet vanishing with no explanation at all.
    func testAPublishedDraftSaysSoAndCompletesTheRequestOnlyOnDone() async throws {
        let loader = TemporaryFileLoader(names: ["a.txt"], contents: ["a"])
        let host = RecordingHost()
        let model = SharedDraftPreparation(store: store, loader: loader, host: host)

        model.start()
        await waitUntil { model.stage == .published }

        XCTAssertEqual(model.stage, .published)
        XCTAssertEqual(store.drafts().count, 1)
        XCTAssertEqual(host.finishes, 0, "the sheet dismissed before the user acknowledged")
        XCTAssertEqual(host.cancellations, 0)
        // Not "staging" any more: the bytes are durable and the sheet being torn
        // down from here is success, not a cancellation.
        XCTAssertFalse(model.isStaging)

        model.done()
        XCTAssertEqual(host.finishes, 1)
        XCTAssertEqual(store.drafts().count, 1, "acknowledging must not delete the draft")
        // Idempotent in the direction that matters: Done on any other stage does
        // nothing at all.
        model.done()
        XCTAssertEqual(host.finishes, 2, "Done is the user pressing a button; it may repeat")
    }

    /// Nothing in this model asks the system to open anything. The absence is
    /// the requirement — `NSExtensionContext.open` is documented for the Today
    /// and iMessage extension points, and a Share Extension is neither.
    func testTheModelHasNoWayToAskForTheAppToBeOpened() throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()          // RelayiumKitTests
            .deletingLastPathComponent()          // Tests
            .deletingLastPathComponent()          // RelayiumKit
            .appendingPathComponent("Sources/RelayiumShareKit/SharedDraftPreparation.swift")
        // Whole-line comments dropped, because this file EXPLAINS the absence —
        // it names `NSExtensionContext.open` to say why it does not call it, and
        // scanning raw text would fail on the very sentence that documents the
        // rule.
        let code = try String(contentsOf: source, encoding: .utf8)
            .split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
        for unsupported in ["openHostApp", "handoffURL", "URL(string:", "https://",
                            "UIApplication", "openURL", "NSExtensionContext.open(",
                            ".open("] {
            XCTAssertFalse(code.contains(unsupported),
                           "the extension model reaches for \(unsupported)")
        }
    }

    /// A missing host must still publish, and must still say so. Losing the
    /// draft because there was nobody to tell would be losing the user's files
    /// over a detail of how the sheet was hosted.
    func testAnAbsentHostStillLeavesTheDraftAndSaysSo() async throws {
        let loader = TemporaryFileLoader(names: ["a.txt"], contents: ["a"])
        let model = SharedDraftPreparation(store: store, loader: loader, host: nil)

        model.start()
        await waitUntil { model.stage == .published }

        XCTAssertEqual(model.stage, .published)
        XCTAssertEqual(store.drafts().count, 1)
        model.done()    // and does not crash reaching for a host that is gone
    }

    /// Pressing Continue twice must not stage the same share twice.
    func testASecondStartIsIgnored() async throws {
        let loader = TemporaryFileLoader(names: ["a.txt"], contents: ["a"])
        let host = RecordingHost()
        let model = SharedDraftPreparation(store: store, loader: loader, host: host)

        model.start()
        model.start()
        await waitUntil { model.stage == .published }
        try? await Task.sleep(nanoseconds: 30_000_000)

        XCTAssertEqual(store.drafts().count, 1, "one invocation must not become two drafts")
    }

    // MARK: - cancelling is prompt, and it happens once

    /// **The Cancel button returns while a copy is running.**
    ///
    /// Deterministic, and deliberately not a timing test over a giant file: the
    /// barrier stops the writer inside `adopt`, holding the ownership lock it
    /// holds for the whole of a copy, and keeps it there. Under the old shape
    /// `cancel()` took that same lock and `SharedDraftPreparation.cancel()` also
    /// called `abandon()` on the main actor, so this call could not return until
    /// the copy had finished — which on a shared video is a frozen sheet.
    ///
    /// It also pins what happens afterwards: the worker that eventually wakes up
    /// publishes nothing, repaints nothing, and leaves nothing on disk.
    func testCancelReturnsWhileTheCopyIsBlockedAndTheLateWorkerPublishesNothing() async throws {
        let barrier = SharedDraftStoreTests.BarrierFileManager()
        let blocking = SharedDraftStore(root: root, fileManager: barrier)
        let loader = TemporaryFileLoader(names: ["big.bin", "next.bin"], contents: ["a", "b"])
        loader.barrier = barrier
        let host = RecordingHost()
        let model = SharedDraftPreparation(store: blocking, loader: loader, host: host)

        model.start()
        // Polled rather than waited on: this test is `@MainActor`, the staging
        // pass hands its writer back through the main actor, and blocking here
        // would stop the very thing being observed.
        await waitUntil { barrier.isBlocked }
        XCTAssertTrue(barrier.isBlocked, "the staging pass never reached the barrier")

        // A watchdog, so that a `cancel()` which DOES wait for the copy fails
        // this test rather than hanging it. Three seconds is far outside any
        // correct implementation and far inside XCTest's own patience.
        DispatchQueue.global().asyncAfter(deadline: .now() + 3) { barrier.release.signal() }

        // On the main actor, exactly where the button is.
        let started = Date()
        model.cancel()
        let elapsed = Date().timeIntervalSince(started)
        XCTAssertLessThan(elapsed, 1,
                          "Cancel waited \(elapsed)s for a copy that is still in progress")
        XCTAssertEqual(host.cancellations, 1)
        XCTAssertFalse(model.isStaging)

        // Cancelling again — the button, then the sheet being torn down — must
        // not cancel the host request twice.
        model.cancel()
        XCTAssertEqual(host.cancellations, 1, "the host request was cancelled more than once")

        barrier.release.signal()    // the watchdog's signal, if it fired, is spare
        try? await Task.sleep(nanoseconds: 400_000_000)

        XCTAssertEqual(host.finishes, 0, "a cancelled share completed the host request")
        XCTAssertEqual(blocking.drafts(), [], "the late worker published a cancelled draft")
        XCTAssertEqual(model.stage, .copying(staged: 0),
                       "the late worker repainted a cancelled sheet")
        let leftovers = (try? FileManager.default
            .contentsOfDirectory(atPath: blocking.stagingRoot.path)) ?? []
        XCTAssertEqual(leftovers, [], "the late worker left the user's bytes behind")
    }

    /// A cancellation that lands after the draft was already published still
    /// leaves nothing: the user asked for nothing to happen.
    func testCancellingAfterPublicationRetiresTheDraft() async throws {
        let loader = TemporaryFileLoader(names: ["a.txt"], contents: ["a"])
        let host = RecordingHost()
        let model = SharedDraftPreparation(store: store, loader: loader, host: host)

        model.start()
        model.cancel()
        try? await Task.sleep(nanoseconds: 300_000_000)

        XCTAssertEqual(store.drafts(), [])
        XCTAssertEqual(host.cancellations, 1)
        XCTAssertEqual(host.finishes, 0)
    }

    // MARK: - the summary is items, and the progress is files

    /// One shared FOLDER is one item and three files, and the sheet must not
    /// call it three files before it has walked anything.
    ///
    /// The header used to render `download.fileCount` over the provider count,
    /// which is a file count the extension has not measured: for a folder it is
    /// wrong before the walk and still wrong after it. `share.itemCount` counts
    /// what the share sheet actually handed over; the copying label counts
    /// staged files, which is measured and which legitimately climbs past it.
    func testTheSummaryCountsSharedItemsAndTheProgressCountsStagedFiles() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("folder-\(UUID().uuidString)")
        let shared = directory.appendingPathComponent("trip", isDirectory: true)
        try FileManager.default.createDirectory(at: shared, withIntermediateDirectories: true)
        for name in ["a.txt", "b.txt", "c.txt"] {
            try Data("x".utf8).write(to: shared.appendingPathComponent(name))
        }
        defer { try? FileManager.default.removeItem(at: directory) }

        let loader = FixedURLLoader(url: shared, name: "trip")
        let model = SharedDraftPreparation(store: store, loader: loader, host: RecordingHost())
        XCTAssertEqual(model.itemCount, 1, "one shared folder is one item")

        model.start()
        await waitUntil { model.stage == .published }

        let plan = try XCTUnwrap(store.drafts().first)
        XCTAssertEqual(plan.files.count, 3, "and three files, once it has been walked")
        XCTAssertEqual(model.itemCount, 1, "the item count must not be restated as a file count")

        // The words exist in every language, and the two counts are different
        // strings rather than the same one used twice.
        for language in AppLanguage.allCases {
            let items = L10n.plural(.shareItemCount, 1, language: language)
            XCTAssertFalse(items.isEmpty)
            XCTAssertFalse(items.contains("share.itemCount"),
                           "the item count renders a raw key in \(language)")
            XCTAssertFalse(items.contains("%@"),
                           "the item count left a placeholder in \(language)")
            XCTAssertNotEqual(items, L10n.plural(.downloadFileCount, 1, language: language),
                              "\(language) calls a shared item a file")
        }
    }

    /// A loader over one URL that already exists, so a shared FOLDER can be
    /// staged. `TemporaryFileLoader` writes one flat file per item and cannot
    /// express the case that matters here.
    private struct FixedURLLoader: SharedDraftItemLoading {
        let url: URL
        let name: String
        var itemCount: Int { 1 }
        func load(_ index: Int, stage: @escaping (URL, String) throws -> Void) throws {
            try stage(url, name)
        }
    }

    /// The extension's own error copy, in a language nobody's CI runner is set
    /// to, so the assertion is about the catalogs rather than about the machine.
    func testEveryShareFailureHasWordsInEveryLanguage() {
        let failures: [Error] = [
            SharedDraftError.unavailableContainer,
            SharedDraftError.nothingUsable,
            SharedDraftError.duplicatePath("a.txt"),
            SharedDraftError.storageFailed,
            SharedDraftError.cancelled,
            SharedDraftWalkError.tooManyFiles(SHARED_DRAFT_MAX_FILES),
            SharedDraftWalkError.unreadable("a.txt"),
            SharedDraftWalkError.symbolicLink("a.txt"),
            SharedDraftWalkError.pathTooLong("a/b"),
        ]
        for language in AppLanguage.allCases {
            for failure in failures {
                let message = SharedDraftCopy.message(for: failure, language: language)
                XCTAssertFalse(message.isEmpty)
                XCTAssertFalse(message.contains("error.share"),
                               "\(failure) renders a raw key in \(language)")
                XCTAssertFalse(message.contains("error.selection"),
                               "\(failure) renders a raw key in \(language)")
                XCTAssertFalse(message.contains("%@"),
                               "\(failure) left a placeholder unfilled in \(language)")
            }
        }
    }

    /// An `NSError` from the filesystem becomes a sentence, not a domain and a
    /// code — and never a path, which would put the user's directory names on a
    /// screen inside somebody else's app.
    func testAnArbitraryFilesystemErrorNeverLeaksItsPath() {
        let underlying = NSError(domain: NSCocoaErrorDomain, code: 640, userInfo: [
            NSFilePathErrorKey: "/private/var/mobile/Containers/secret/tax.pdf",
        ])
        let message = SharedDraftCopy.message(for: underlying, language: .en)
        XCTAssertEqual(message, L10n.t(.errorShareStorageFailed, language: .en))
        XCTAssertFalse(message.contains("/private"))
        XCTAssertFalse(message.contains("tax.pdf"))
        XCTAssertFalse(message.contains("640"))
    }
}
