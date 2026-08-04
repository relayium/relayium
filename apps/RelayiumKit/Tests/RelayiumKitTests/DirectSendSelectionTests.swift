import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// Counts the two URL APIs a security-scoped resource is governed by, per path.
///
/// Counting rather than flagging: the defect this file exists to catch is an
/// UNBALANCED scope — started twice and stopped once, or stopped twice — and a
/// boolean cannot see either.
private final class ScopeSpy: SecurityScopedResourceAccessing, @unchecked Sendable {
    private let lock = NSLock()
    private var starts: [String: Int] = [:]
    private var stops: [String: Int] = [:]
    /// Every call in order, so a test can assert that staging happened while the
    /// scope was still held rather than after it was released.
    private(set) var log: [String] = []
    /// Paths whose start returns false — a real refusal, which owes no stop.
    var refuses: Set<String> = []

    func startAccess(to url: URL) -> Bool {
        lock.lock(); defer { lock.unlock() }
        log.append("start \(url.path)")
        guard !refuses.contains(url.path) else { return false }
        starts[url.path, default: 0] += 1
        return true
    }

    func stopAccess(to url: URL) {
        lock.lock(); defer { lock.unlock() }
        log.append("stop \(url.path)")
        stops[url.path, default: 0] += 1
    }

    func started(_ url: URL) -> Int { lock.lock(); defer { lock.unlock() }; return starts[url.path] ?? 0 }
    func stopped(_ url: URL) -> Int { lock.lock(); defer { lock.unlock() }; return stops[url.path] ?? 0 }

    /// Every successful start has exactly one stop, and nothing was stopped that
    /// was never started.
    var isBalanced: Bool {
        lock.lock(); defer { lock.unlock() }
        return starts == stops
    }

    var outstanding: [String] {
        lock.lock(); defer { lock.unlock() }
        return starts.filter { (stops[$0.key] ?? 0) != $0.value }.keys.sorted()
    }
}

/// The iOS Direct tab's file selection: who owns the security scopes, and for
/// how long.
///
/// `fileImporter` hands back security-scoped URLs, and the SwiftUI view it
/// belongs to is the one place their lifetime must NOT live: SwiftUI decides
/// when a tab is torn down and rebuilt, and a `TabView` does exactly that when
/// the user looks at Account and comes back. A scope started in `onChange` and
/// stopped in `onDisappear` is a scope whose balance depends on a scheduler.
///
/// So the ownership is here, app-scoped, and everything below is about the two
/// ways it can be wrong: a leaked start (the sandbox extension budget is finite
/// and per-process) and an early stop (the transfer loses access to files the
/// user chose).
@MainActor
final class DirectSendSelectionTests: XCTestCase {

    private func tempFile(_ name: String, bytes: [UInt8] = [1, 2, 3]) throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("r3e-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(name)
        try Data(bytes).write(to: url)
        return url
    }

    private func make(_ spy: ScopeSpy) -> DirectSendSelection {
        DirectSendSelection(access: SecurityScopedAccess(resource: spy))
    }

    // MARK: - the scope is started, and started here

    func testChoosingFilesStartsExactlyOneScopePerDistinctURLAndSummarisesThem() throws {
        let spy = ScopeSpy()
        let selection = make(spy)
        let a = try tempFile("a.txt")
        let b = try tempFile("b.txt")

        selection.chooseFiles(.success([a, b, a]))

        XCTAssertEqual(spy.started(a), 1, "a repeated URL took two sandbox extensions")
        XCTAssertEqual(spy.started(b), 1)
        XCTAssertFalse(selection.isEmpty)
        XCTAssertNotNil(selection.summary, "the chosen files are not described")
        XCTAssertNil(selection.errorMessage)
    }

    /// A second choice replaces the first, and the first's extensions go —
    /// exactly once each.
    func testASecondChoiceReleasesTheFirstBatchExactlyOnce() throws {
        let spy = ScopeSpy()
        let selection = make(spy)
        let a = try tempFile("a.txt")
        let b = try tempFile("b.txt")

        selection.chooseFiles(.success([a]))
        selection.chooseFiles(.success([b]))

        XCTAssertEqual(spy.stopped(a), 1, "the replaced batch was leaked or double-stopped")
        XCTAssertEqual(spy.stopped(b), 0, "the live batch was released")
    }

    func testClearReleasesEverythingAndIsIdempotent() throws {
        let spy = ScopeSpy()
        let selection = make(spy)
        let a = try tempFile("a.txt")

        selection.chooseFiles(.success([a]))
        selection.clear()
        selection.clear()

        XCTAssertEqual(spy.stopped(a), 1, "a second clear stopped an extension it did not hold")
        XCTAssertTrue(selection.isEmpty)
        XCTAssertNil(selection.summary)
        XCTAssertTrue(spy.isBalanced, "outstanding: \(spy.outstanding)")
    }

    /// Dropping the owner is the last-resort release, and it has to work with no
    /// view, no `onDisappear` and nobody calling anything.
    func testDroppingTheOwnerReleasesWhatItStillHolds() throws {
        let spy = ScopeSpy()
        let a = try tempFile("a.txt")
        do {
            let selection = make(spy)
            selection.chooseFiles(.success([a]))
            XCTAssertEqual(spy.stopped(a), 0)
        }
        XCTAssertEqual(spy.stopped(a), 1, "the last owner went away holding an extension")
    }

    // MARK: - staging happens INSIDE the scope

    /// The ordering that makes the descriptor pin worth anything.
    ///
    /// `stageRealtimeFiles` opens every chosen file and keeps the descriptor for
    /// the life of the batch, which is what stops the bytes on the wire being
    /// swapped between consent and transmission. That open has to happen while
    /// the sandbox extension is live — a stage after the stop is a stage that
    /// fails on a real device and passes in any test that only counts calls.
    func testStagingRunsBeforeAnythingIsReleased() throws {
        let spy = ScopeSpy()
        let selection = make(spy)
        let a = try tempFile("a.txt")

        selection.chooseFiles(.success([a]))
        let staged = selection.stageForSend()

        XCTAssertNotNil(staged, "staging refused a readable file")
        XCTAssertEqual(staged?.metas.map(\.name), ["a.txt"])
        XCTAssertEqual(staged?.metas.first?.size, 3)
        XCTAssertFalse(spy.log.contains("stop \(a.path)"),
                       "the scope was released before the files were opened")
    }

    /// And the scope OUTLIVES staging, because the batch is sent later — when
    /// the peer finally answers, which can be minutes after the code was shown.
    func testTheScopeSurvivesStagingUntilTheSelectionIsCleared() throws {
        let spy = ScopeSpy()
        let selection = make(spy)
        let a = try tempFile("a.txt")

        selection.chooseFiles(.success([a]))
        _ = selection.stageForSend()
        XCTAssertEqual(spy.stopped(a), 0, "staging released the scope the send still needs")

        selection.clear()
        XCTAssertEqual(spy.stopped(a), 1)
    }

    /// Staging with nothing chosen is a refusal, not an empty batch: an empty
    /// manifest is `RealtimeStagingError.fileCount`, and shipping it to
    /// `stageSend` would fail the session instead of the button.
    func testStagingWithNothingChosenRefusesAndSaysSo() {
        let spy = ScopeSpy()
        let selection = make(spy)
        XCTAssertNil(selection.stageForSend())
        XCTAssertNotNil(selection.errorMessage)
    }

    // MARK: - failures

    /// A picker failure is a PREPARATION failure: nothing was chosen, so the
    /// message belongs beside the picker rather than in a session state.
    func testAPickerFailurePublishesCopyAndHoldsNoScope() {
        let spy = ScopeSpy()
        let selection = make(spy)
        selection.chooseFiles(.failure(AccountError.rateLimited))
        XCTAssertNotNil(selection.errorMessage)
        XCTAssertTrue(selection.isEmpty)
        XCTAssertTrue(spy.isBalanced, "outstanding: \(spy.outstanding)")
    }

    /// And it has no claim on what the user chose EARLIER.
    ///
    /// A failed picker chose nothing, so throwing away a staged folder because a
    /// later invocation errored costs the user the whole choice and tells them
    /// only that something went wrong. Same rule `SendSelectionModel` follows.
    func testAPickerFailureLeavesAnEarlierSelectionAndItsScopeAlone() throws {
        let spy = ScopeSpy()
        let selection = make(spy)
        let a = try tempFile("a.txt")

        selection.chooseFiles(.success([a]))
        let summary = selection.summary
        selection.chooseFiles(.failure(AccountError.rateLimited))

        XCTAssertNotNil(selection.errorMessage)
        XCTAssertFalse(selection.isEmpty, "a failed picker discarded the earlier choice")
        XCTAssertEqual(selection.summary, summary)
        XCTAssertEqual(spy.stopped(a), 0, "the still-listed files lost their scope")
    }

    /// An expansion that refuses — here, a URL that is not there at all — leaves
    /// no scope held and no summary claiming files that cannot be sent.
    func testARefusedExpansionLeavesNothingHeldAndNoSummary() throws {
        let spy = ScopeSpy()
        let selection = make(spy)
        let missing = FileManager.default.temporaryDirectory
            .appendingPathComponent("r3e-missing-\(UUID().uuidString)/gone.txt")

        selection.chooseFiles(.success([missing]))

        XCTAssertNil(selection.summary, "a refused selection was still summarised")
        XCTAssertNotNil(selection.errorMessage)
        XCTAssertTrue(spy.isBalanced, "outstanding: \(spy.outstanding)")
    }

    /// An empty picker result is a cancellation on some paths and a clear on
    /// others; either way it must not leave the previous batch held with no
    /// summary describing it.
    func testAnEmptyResultClearsRatherThanStranding() throws {
        let spy = ScopeSpy()
        let selection = make(spy)
        let a = try tempFile("a.txt")
        selection.chooseFiles(.success([a]))
        selection.chooseFiles(.success([]))
        XCTAssertTrue(selection.isEmpty)
        XCTAssertEqual(spy.stopped(a), 1)
    }

    /// A start the OS refuses consumed no extension, so it owes no stop — and
    /// the refusal surfaces where the user can see it, when the file turns out
    /// to be unreadable, rather than as a silent success.
    func testARefusedStartIsNotStoppedLater() throws {
        let spy = ScopeSpy()
        let a = try tempFile("a.txt")
        spy.refuses = [a.path]
        let selection = make(spy)

        selection.chooseFiles(.success([a]))
        selection.clear()

        XCTAssertEqual(spy.stopped(a), 0, "an extension that was never taken was released")
        XCTAssertTrue(spy.isBalanced, "outstanding: \(spy.outstanding)")
    }
}
