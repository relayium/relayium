import XCTest
@testable import RelayiumShareKit

/// The bridge between an `NSItemProvider`'s completion handler and the thread
/// waiting inside `load`.
///
/// This is the file that exists because of a crash on a real iPad. The loader
/// used to wrap the caller's staging closure in `withoutActuallyEscaping`,
/// arguing that `load` blocks on a semaphore until the handler has run, so the
/// closure could not outlive the call. A real provider retains its handler —
/// past the call, and on iPadOS 18 past the load — so the argument was false and
/// the Swift runtime's escape check trapped as the scope exited: `EXC_BREAKPOINT`
/// in `ItemProviderLoader.load(_:stage:)`, after the copy and before `publish()`.
/// The user's share sheet died silently and the app saw no draft.
///
/// So the assertions here are about the provider's RETENTION, not about the
/// happy path:
///
///  1. the copy still happens inside the handler, before it returns;
///  2. `load` still does not return before the copy has finished;
///  3. a handler the provider keeps forever holds no writer, no URL, no staging
///     closure and no suggested filename once the result has been consumed;
///  4. a handler invoked a second time — later, or concurrently — stages
///     nothing and wakes nobody.
///
/// None of that is reproducible against a plain `NSItemProvider` built in a test
/// process, which is why `ItemRepresentationProviding` exists.
final class ItemProviderLoaderTests: XCTestCase {
    private static let folderType = "public.folder"
    private static let itemType = "public.item"

    // MARK: - doubles

    /// A provider that behaves like the real one in the way that broke the
    /// device: it **keeps** the completion handler it was given, and lets the
    /// test call it again whenever it likes.
    private final class RetainingProvider: ItemRepresentationProviding {
        enum Delivery {
            /// Called inside `loadFileRepresentation`, like a small local file.
            case immediate
            /// Held for the test to fire, like a representation that has to be
            /// materialised first.
            case deferred
        }

        let suggestedName: String?
        let conformingTypes: Set<String>
        var delivery: Delivery = .immediate
        var payload: (url: URL?, error: Error?) = (nil, nil)
        /// Deletes the delivered file the moment the handler returns, exactly as
        /// the real provider does. Anything left readable afterwards means the
        /// copy did not happen where it had to.
        var deletesOnReturn = false

        private let lock = NSLock()
        private var _survivedTheCallback = false
        private var _insideHandler = false
        private var _retained: ((URL?, Error?) -> Void)?
        private(set) var requestedTypes: [String] = []
        /// Raised once the handler has been stored, so a test firing it from
        /// another thread has a happens-before rather than a poll.
        let entered = DispatchSemaphore(value: 0)

        init(suggestedName: String?, conformingTypes: Set<String>) {
            self.suggestedName = suggestedName
            self.conformingTypes = conformingTypes
        }

        func hasItemConformingToTypeIdentifier(_ typeIdentifier: String) -> Bool {
            conformingTypes.contains(typeIdentifier)
        }

        func loadFileRepresentation(ofType typeIdentifier: String,
                                    completion: @escaping (URL?, Error?) -> Void) {
            lock.lock()
            requestedTypes.append(typeIdentifier)
            // Never cleared. THIS is the behaviour the seam exists for.
            _retained = completion
            lock.unlock()
            entered.signal()
            if case .immediate = delivery { fire() }
        }

        /// Call the retained handler. Again, if the test wants to.
        func fire() {
            lock.lock()
            let handler = _retained
            _insideHandler = true
            lock.unlock()
            handler?(payload.url, payload.error)
            lock.lock()
            _insideHandler = false
            lock.unlock()
            guard deletesOnReturn, let url = payload.url else { return }
            try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
            lock.lock()
            _survivedTheCallback = FileManager.default.fileExists(atPath: url.path)
            lock.unlock()
        }

        /// Whether the handler is running right now — read from inside the
        /// staging closure, which is the whole claim being made.
        var isInsideHandler: Bool {
            lock.lock()
            defer { lock.unlock() }
            return _insideHandler
        }

        var retainsHandler: Bool {
            lock.lock()
            defer { lock.unlock() }
            return _retained != nil
        }

        var survivedTheCallback: Bool {
            lock.lock()
            defer { lock.unlock() }
            return _survivedTheCallback
        }
    }

    /// Something the staging closure captures, so "the handler still holds the
    /// closure" becomes an object that is or is not still alive.
    private final class Sentinel {
        private let lock = NSLock()
        private var _names: [String] = []
        func record(_ name: String) {
            lock.lock()
            _names.append(name)
            lock.unlock()
        }
        var names: [String] {
            lock.lock()
            defer { lock.unlock() }
            return _names
        }
    }

    // MARK: - a real temporary representation

    private var scratch: URL!

    override func setUpWithError() throws {
        scratch = FileManager.default.temporaryDirectory
            .appendingPathComponent("item-loader-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: scratch)
    }

    /// One temporary file in a directory of its own, so a provider that deletes
    /// "its" representation deletes exactly that.
    private func representation(named name: String, contents: String) throws -> URL {
        let directory = scratch.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent(name)
        try Data(contents.utf8).write(to: file)
        return file
    }

    private func provider(name: String? = nil,
                          types: Set<String> = ["public.item"]) -> RetainingProvider {
        RetainingProvider(suggestedName: name, conformingTypes: types)
    }

    // MARK: - the copy happens inside the handler, and load waits for it

    func testTheCopyHappensInsideTheHandlerAndTheRepresentationIsGoneAfterwards() throws {
        let file = try representation(named: "one.txt", contents: "first")
        let source = provider(name: "one.txt")
        source.payload = (file, nil)
        source.deletesOnReturn = true
        let loader = ItemProviderLoader(items: [source])

        var read: String?
        var wasInsideHandler = false
        try loader.load(0) { url, name in
            wasInsideHandler = source.isInsideHandler
            XCTAssertEqual(name, "one.txt")
            read = String(decoding: try Data(contentsOf: url), as: UTF8.self)
        }

        XCTAssertTrue(wasInsideHandler,
                      "the copy ran outside the provider's handler — the bytes it read are a race")
        XCTAssertEqual(read, "first")
        XCTAssertFalse(source.survivedTheCallback)
    }

    /// **`load` does not return before the staging closure has finished**, even
    /// when the provider answers from another thread minutes later.
    ///
    /// Not a timing test: the provider here answers only when this test says so,
    /// and the assertion is about what is true at that moment.
    func testLoadDoesNotReturnBeforeADeferredCallbackHasStaged() throws {
        let file = try representation(named: "slow.txt", contents: "eventually")
        let source = provider(name: "slow.txt")
        source.delivery = .deferred
        source.payload = (file, nil)
        let loader = ItemProviderLoader(items: [source])

        let staged = Sentinel()
        let returned = DispatchSemaphore(value: 0)
        let finished = expectation(description: "load returned")
        DispatchQueue.global().async {
            try? loader.load(0) { _, name in staged.record(name) }
            returned.signal()
            finished.fulfill()
        }

        // The handler is stored; nothing has been delivered.
        source.entered.wait()
        XCTAssertEqual(staged.names, [], "the loader staged something nobody delivered")
        XCTAssertEqual(returned.wait(timeout: .now() + 0.2), .timedOut,
                       "load returned before the provider had answered at all")

        source.fire()
        wait(for: [finished], timeout: 5)
        XCTAssertEqual(staged.names, ["slow.txt"])
    }

    // MARK: - a handler the provider keeps forever

    /// The regression seam, and the reason the whole design changed.
    ///
    /// The provider below never lets go of the handler it was given. Two things
    /// have to be true afterwards and neither used to be: the loader must not
    /// trap on the way out, and what the provider is still holding must not
    /// include the staging closure — which, in production, owns the
    /// `SharedDraftWriter` and every byte staged so far.
    func testAKeptHandlerHoldsNoStagingClosureOnceTheResultIsConsumed() throws {
        let file = try representation(named: "kept.txt", contents: "bytes")
        let source = provider(name: "kept.txt")
        source.payload = (file, nil)
        let loader = ItemProviderLoader(items: [source])

        weak var released: Sentinel?
        do {
            let sentinel = Sentinel()
            released = sentinel
            // An explicit capture, so dropping the local below does not reach
            // inside the closure and empty it.
            try loader.load(0) { [sentinel] _, name in sentinel.record(name) }
            XCTAssertEqual(sentinel.names, ["kept.txt"])
        }

        XCTAssertTrue(source.retainsHandler,
                      "the double let go of the handler — this test then proves nothing")
        XCTAssertNil(released,
                     "a handler the provider keeps still owns the staging closure, "
                     + "and through it the draft writer")
    }

    /// Every slot, asserted on the bridge itself.
    ///
    /// The test above proves the staging payload is released, through an object
    /// the closure captured. The other two cannot be proved the same way. The
    /// failure slot: a debug build keeps a caught error alive to the end of the
    /// enclosing function whatever this code does, so the assertion would be
    /// about Swift's lifetime rules rather than about the clearing. The
    /// suggested name: it is a `String`, so there is no object whose death
    /// could stand in for it. So both are asserted where the clearing happens —
    /// and on *whether* a name is parked, never on which, because a diagnostic
    /// that answered with the name would be a new copy of the user's filename.
    func testTheBridgeHoldsNoSlotOnceTheResultIsConsumed() throws {
        let file = try representation(named: "kept.txt", contents: "bytes")
        let handoff = ItemHandoff(suggestedName: "kept.txt", stage: { _, _ in })

        XCTAssertTrue(handoff.holdsStagingPayload)
        XCTAssertTrue(handoff.holdsSuggestedName)
        handoff.deliver(file, nil)
        XCTAssertFalse(handoff.holdsStagingPayload,
                       "the callback still owns the writer after it has staged")
        XCTAssertFalse(handoff.holdsSuggestedName,
                       "a handler the provider keeps forever keeps the user's filename with it")
        XCTAssertTrue(handoff.holdsOutcome, "the waiter has nothing to read")
        try handoff.wait()
        XCTAssertFalse(handoff.holdsOutcome)
    }

    /// And on the failure path, where nothing was staged, the outcome slot holds
    /// the error — and the name is claimed and dropped all the same, because the
    /// claim happens before the answer is even looked at.
    func testTheBridgeClearsEverySlotAfterAFailureToo() throws {
        struct Refused: Error {}
        let handoff = ItemHandoff(suggestedName: "gone.txt", stage: { _, _ in })

        handoff.deliver(nil, Refused())
        XCTAssertFalse(handoff.holdsStagingPayload)
        XCTAssertFalse(handoff.holdsSuggestedName,
                       "a refused load leaves the user's filename in the retained handler")
        XCTAssertThrowsError(try handoff.wait()) { XCTAssertTrue($0 is Refused) }
        XCTAssertFalse(handoff.holdsOutcome,
                       "a retained handler still parks the failure it delivered")
    }

    // MARK: - a handler invoked more than once

    /// A provider that calls its handler again — later, on any thread — must not
    /// stage the item a second time, and must not wake a waiter that is no
    /// longer there.
    func testALaterSecondCallbackStagesNothing() throws {
        let file = try representation(named: "once.txt", contents: "bytes")
        let source = provider(name: "once.txt")
        source.payload = (file, nil)
        let loader = ItemProviderLoader(items: [source])

        let staged = Sentinel()
        try loader.load(0) { [staged] _, name in staged.record(name) }
        XCTAssertEqual(staged.names, ["once.txt"])

        // The share is over. The provider calls back anyway.
        source.fire()
        source.fire()
        XCTAssertEqual(staged.names, ["once.txt"],
                       "a second callback staged the user's file into a finished draft")
    }

    /// And the same when the second callback races the first rather than
    /// following it.
    func testConcurrentCallbacksStageExactlyOnce() throws {
        let file = try representation(named: "raced.txt", contents: "bytes")
        let source = provider(name: "raced.txt")
        source.delivery = .deferred
        source.payload = (file, nil)
        let loader = ItemProviderLoader(items: [source])

        let staged = Sentinel()
        let finished = expectation(description: "load returned")
        DispatchQueue.global().async {
            try? loader.load(0) { [staged] _, name in staged.record(name) }
            finished.fulfill()
        }
        source.entered.wait()
        DispatchQueue.concurrentPerform(iterations: 8) { _ in source.fire() }

        wait(for: [finished], timeout: 5)
        XCTAssertEqual(staged.names, ["raced.txt"],
                       "eight simultaneous callbacks staged \(staged.names.count) copies")
    }

    // MARK: - failures

    func testTheProvidersOwnFailureIsWhatLoadThrows() throws {
        struct Refused: Error, Equatable {}
        let source = provider()
        source.payload = (nil, Refused())
        let loader = ItemProviderLoader(items: [source])

        XCTAssertThrowsError(try loader.load(0) { _, _ in XCTFail("staged a missing item") }) {
            XCTAssertEqual($0 as? Refused, Refused())
        }
    }

    /// No URL and no error either: the provider answered with nothing at all.
    func testAnEmptyAnswerIsARefusalRatherThanAHang() throws {
        let source = provider()
        let loader = ItemProviderLoader(items: [source])

        XCTAssertThrowsError(try loader.load(0) { _, _ in XCTFail("staged nothing") }) {
            XCTAssertEqual($0 as? SharedDraftError, .nothingUsable)
        }
    }

    func testAStagingFailureIsWhatLoadThrows() throws {
        let file = try representation(named: "dup.txt", contents: "bytes")
        let source = provider(name: "dup.txt")
        source.payload = (file, nil)
        let loader = ItemProviderLoader(items: [source])

        XCTAssertThrowsError(try loader.load(0) { _, _ in
            throw SharedDraftError.duplicatePath("dup.txt")
        }) {
            XCTAssertEqual($0 as? SharedDraftError, .duplicatePath("dup.txt"))
        }
    }

    func testAnItemOutsideTheShareIsRefusedWithoutAskingForAnything() throws {
        let source = provider()
        let loader = ItemProviderLoader(items: [source])

        XCTAssertThrowsError(try loader.load(3) { _, _ in XCTFail("staged item 3 of 1") }) {
            XCTAssertEqual($0 as? SharedDraftError, .nothingUsable)
        }
        XCTAssertEqual(source.requestedTypes, [])
    }

    func testAProviderAdvertisingNothingUsableIsRefused() throws {
        let source = provider(types: [])
        let loader = ItemProviderLoader(items: [source])

        XCTAssertThrowsError(try loader.load(0) { _, _ in XCTFail("staged an unusable item") }) {
            XCTAssertEqual($0 as? SharedDraftError, .nothingUsable)
        }
        XCTAssertEqual(source.requestedTypes, [], "an unusable provider was asked to load anyway")
    }

    // MARK: - a shared folder stays a folder

    /// A folder registers `public.folder` AND `public.item`. Asking for the
    /// wider type would let the system satisfy the request with some other
    /// representation of it.
    func testAFolderIsAskedForTheFolderType() throws {
        let file = try representation(named: "trip", contents: "x")
        let source = provider(name: "trip", types: [Self.folderType, Self.itemType])
        source.payload = (file, nil)
        let loader = ItemProviderLoader(items: [source])

        try loader.load(0) { _, _ in }
        XCTAssertEqual(source.requestedTypes, [Self.folderType])
    }

    func testAPlainFileIsAskedForTheItemType() throws {
        let file = try representation(named: "a.txt", contents: "x")
        let source = provider(name: "a.txt", types: [Self.itemType])
        source.payload = (file, nil)
        let loader = ItemProviderLoader(items: [source])

        try loader.load(0) { _, _ in }
        XCTAssertEqual(source.requestedTypes, [Self.itemType])
    }

    // MARK: - the name the item is staged under

    /// A provider with no suggested name falls back to the representation's own
    /// leaf, rather than staging the user's file under an empty name.
    func testAnUnnamedItemIsStagedUnderItsRepresentationsLeaf() throws {
        let file = try representation(named: "IMG_0042.HEIC", contents: "x")
        let source = provider(name: nil)
        source.payload = (file, nil)
        let loader = ItemProviderLoader(items: [source])

        var staged: String?
        try loader.load(0) { _, name in staged = name }
        XCTAssertEqual(staged, "IMG_0042.HEIC")
    }

    // MARK: - the escape hatch must not come back

    /// `withoutActuallyEscaping` around a provider's completion handler is a
    /// runtime trap on a real device, and the trap is the *good* case — it
    /// happened after the copy and before the publish, so the user simply lost
    /// the share. Behaviour cannot observe an absence, so this is a source scan.
    ///
    /// Whole-line comments are dropped first, because the file above *explains*
    /// the absence and names the call in doing so.
    func testTheLoaderDoesNotResurrectTheEscapeHatch() throws {
        let code = try RepoRoot
            .text("apps/RelayiumKit/Sources/RelayiumShareKit/SharedDraftItemLoading.swift")
            .split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")

        XCTAssertFalse(code.contains("withoutActuallyEscaping"),
                       "the loader hands a non-escaping closure to a provider that retains it")
        XCTAssertTrue(code.contains("stage: @escaping (URL, String) throws -> Void"),
                      "the protocol must state the callback's real lifetime")
        // The extension's boundary, restated where the change was made: this
        // file may not gain a network, a credential or a log line.
        for forbidden in ["URLSession", "URLRequest", "Keychain", "SecItem",
                          "print(", "NSLog(", "os_log(", "debugPrint("] {
            XCTAssertFalse(code.contains(forbidden),
                           "the loader reaches for \(forbidden)")
        }
    }
}
