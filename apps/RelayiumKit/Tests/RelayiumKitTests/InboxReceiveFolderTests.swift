import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// The durable folder authorization: its four honest outcomes, its balanced
/// security scopes, and the rule that a stale bookmark is refreshed only from a
/// resolution proven writable.
///
/// A fake bookmarking seam is not a convenience here. `bookmarkDataIsStale`, a
/// revoked grant and a refused scope cannot be produced on demand from a real
/// bookmark, and those are exactly the branches a person's data depends on. The
/// real API is exercised separately, once, by a round trip over a temporary
/// directory — so the seam is proven to describe the thing it stands in for.
final class InboxReceiveFolderTests: XCTestCase {

    private let account = try! InboxAccountID("accountfolder001")
    private let other = try! InboxAccountID("accountfolder002")

    private func temporaryDirectory() throws -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("relayium-folder-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    // MARK: - the states

    func testNoChosenFolderIsAbsentRatherThanAFailure() {
        let folder = InboxReceiveFolder(store: InMemoryInboxFolderStore(),
                                        bookmarking: FakeBookmarking())
        let opened = folder.open(account: account)
        XCTAssertEqual(opened.state, .absent)
        XCTAssertNil(opened.access)
        XCTAssertFalse(opened.state.canReceive)
    }

    func testAResolvableWritableFolderIsUsableAndHoldsAnOpenScope() throws {
        let directory = try temporaryDirectory()
        let bookmarking = FakeBookmarking(resolveTo: directory)
        let store = InMemoryInboxFolderStore()
        let folder = InboxReceiveFolder(store: store, bookmarking: bookmarking)
        try folder.chooseFolder(directory, account: account)

        let opened = folder.open(account: account)
        XCTAssertEqual(opened.state, .usable(directory))
        XCTAssertTrue(opened.state.canReceive)
        XCTAssertEqual(try XCTUnwrap(opened.access).isOpen, true)

        // Balanced: exactly the scopes that were started are stopped, and only
        // once the handle is released.
        XCTAssertEqual(bookmarking.stopped.count, bookmarking.started.count - 1)
        opened.access?.release()
        XCTAssertEqual(bookmarking.stopped.count, bookmarking.started.count)
        opened.access?.release()
        XCTAssertEqual(bookmarking.stopped.count, bookmarking.started.count,
                       "release must be idempotent")
    }

    /// The bookmark no longer resolves at all: the folder was deleted, the volume
    /// is not mounted, or the grant was revoked.
    func testAnUnresolvableBookmarkIsUnavailableAndTakesNoScope() throws {
        let bookmarking = FakeBookmarking(resolveTo: nil)
        let store = InMemoryInboxFolderStore()
        store.setBookmarkData(Data([1, 2, 3]), account: account)
        let folder = InboxReceiveFolder(store: store, bookmarking: bookmarking)

        let opened = folder.open(account: account)
        XCTAssertEqual(opened.state, .unavailable(.unresolvable))
        XCTAssertTrue(bookmarking.started.isEmpty)
        XCTAssertTrue(bookmarking.stopped.isEmpty)
    }

    /// It resolved but the system refused the scope. Distinct from unresolvable:
    /// the grant exists and something else is wrong.
    func testARefusedSecurityScopeIsUnavailableAndOwesNoStop() throws {
        let directory = try temporaryDirectory()
        let bookmarking = FakeBookmarking(resolveTo: directory)
        bookmarking.refuseAccess = true
        let store = InMemoryInboxFolderStore()
        store.setBookmarkData(Data([1]), account: account)
        let folder = InboxReceiveFolder(store: store, bookmarking: bookmarking)

        let opened = folder.open(account: account)
        XCTAssertEqual(opened.state, .unavailable(.accessDenied))
        // A start that returned false consumed no extension; stopping it anyway
        // would be unbalanced in the other direction.
        XCTAssertTrue(bookmarking.stopped.isEmpty)
    }

    /// It resolved and the scope opened, but the folder is not writable — a
    /// read-only remount, an ACL, a revoked TCC grant. The scope is released
    /// rather than leaked.
    func testAnUnwritableFolderIsUnavailableAndReleasesItsScope() throws {
        let directory = try temporaryDirectory()
        let file = directory.appendingPathComponent("not-a-directory")
        FileManager.default.createFile(atPath: file.path, contents: Data())
        let bookmarking = FakeBookmarking(resolveTo: file)
        let store = InMemoryInboxFolderStore()
        store.setBookmarkData(Data([1]), account: account)
        let folder = InboxReceiveFolder(store: store, bookmarking: bookmarking)

        let opened = folder.open(account: account)
        XCTAssertEqual(opened.state, .unavailable(.notWritable))
        XCTAssertEqual(bookmarking.stopped, bookmarking.started)
    }

    // MARK: - stale refresh

    /// A refresh happens only AFTER a resolution proven writable. This is the
    /// happy path: the stored bookmark is replaced with the fresh one.
    func testAStaleBookmarkIsRefreshedOnceTheResolutionIsProvenWritable() throws {
        let directory = try temporaryDirectory()
        let bookmarking = FakeBookmarking(resolveTo: directory)
        let store = InMemoryInboxFolderStore()
        let folder = InboxReceiveFolder(store: store, bookmarking: bookmarking)
        try folder.chooseFolder(directory, account: account)
        let original = store.bookmarkData(account: account)

        bookmarking.isStale = true
        bookmarking.nextBookmark = Data("refreshed".utf8)
        let opened = folder.open(account: account)

        XCTAssertEqual(opened.state, .usable(directory))
        XCTAssertEqual(store.bookmarkData(account: account), Data("refreshed".utf8))
        XCTAssertNotEqual(store.bookmarkData(account: account), original)
        // The order the refresh depends on: resolve, open the scope, and only then
        // take fresh bookmark data. The probe runs between the start and the
        // bookmark, so a refresh that appeared before the start would be one taken
        // without an open scope at all.
        XCTAssertEqual(bookmarking.events.suffix(3), [.resolve, .start, .bookmark])
    }

    /// The refresh failed. The OLD bookmark is KEPT — it is still the best
    /// authorization this app has and may resolve again next launch — and the
    /// state says so rather than reporting success.
    func testAFailedStaleRefreshKeepsTheOldBookmarkAndSaysSo() throws {
        let directory = try temporaryDirectory()
        let bookmarking = FakeBookmarking(resolveTo: directory)
        let store = InMemoryInboxFolderStore()
        let folder = InboxReceiveFolder(store: store, bookmarking: bookmarking)
        try folder.chooseFolder(directory, account: account)
        let original = store.bookmarkData(account: account)

        bookmarking.isStale = true
        bookmarking.failBookmarkCreation = true
        let opened = folder.open(account: account)

        XCTAssertEqual(opened.state, .unavailable(.staleRefreshFailed))
        XCTAssertFalse(opened.state.canReceive)
        XCTAssertEqual(store.bookmarkData(account: account), original,
                       "the last known-good grant was overwritten")
        XCTAssertEqual(bookmarking.stopped, bookmarking.started)
    }

    /// The ordering that matters: a folder that resolves but is NOT writable must
    /// not have its bookmark refreshed, even when the system flags it stale.
    /// Rewriting from an unproven resolution would overwrite the last known-good
    /// grant with one that may point somewhere unusable, with no way back.
    func testAStaleUnwritableResolutionNeverReplacesTheStoredBookmark() throws {
        let directory = try temporaryDirectory()
        let bookmarking = FakeBookmarking(resolveTo: directory)
        let store = InMemoryInboxFolderStore()
        let folder = InboxReceiveFolder(store: store, bookmarking: bookmarking)
        try folder.chooseFolder(directory, account: account)
        let original = store.bookmarkData(account: account)

        // Now point the resolution at something unwritable AND flag it stale.
        let file = directory.appendingPathComponent("a-file")
        FileManager.default.createFile(atPath: file.path, contents: Data())
        bookmarking.resolved = file
        bookmarking.isStale = true
        bookmarking.nextBookmark = Data("must-not-be-stored".utf8)

        let opened = folder.open(account: account)
        XCTAssertEqual(opened.state, .unavailable(.notWritable))
        XCTAssertEqual(store.bookmarkData(account: account), original)
    }

    // MARK: - automatic receive

    /// Default-off is a product invariant, not a convenience: a missing key, a
    /// fresh install and a cleared domain all mean "not enabled". There is no
    /// spelling of this store's state that turns it on by omission.
    func testAutomaticReceiveDefaultsOff() {
        let folder = InboxReceiveFolder(store: InMemoryInboxFolderStore(),
                                        bookmarking: FakeBookmarking())
        XCTAssertFalse(folder.isAutomaticReceiveEnabled(account: account))
    }

    /// Choosing a folder is not consent to unattended writes. The two decisions are
    /// separate, and choosing a folder leaves automatic receive off.
    func testChoosingAFolderDoesNotEnableAutomaticReceive() throws {
        let directory = try temporaryDirectory()
        let store = InMemoryInboxFolderStore()
        let folder = InboxReceiveFolder(store: store, bookmarking: FakeBookmarking(resolveTo: directory))
        try folder.chooseFolder(directory, account: account)
        XCTAssertFalse(folder.isAutomaticReceiveEnabled(account: account))
    }

    /// Enabling with no folder would be a stored "yes" waiting to be paired with
    /// whatever folder is chosen next.
    func testEnablingAutomaticReceiveWithoutAFolderIsRefused() {
        let folder = InboxReceiveFolder(store: InMemoryInboxFolderStore(),
                                        bookmarking: FakeBookmarking())
        XCTAssertThrowsError(try folder.setAutomaticReceive(true, account: account)) {
            XCTAssertEqual($0 as? InboxFolderError, .noFolderChosen)
        }
        XCTAssertFalse(folder.isAutomaticReceiveEnabled(account: account))
    }

    func testForgettingClearsBothTheGrantAndTheOptIn() throws {
        let directory = try temporaryDirectory()
        let store = InMemoryInboxFolderStore()
        let folder = InboxReceiveFolder(store: store, bookmarking: FakeBookmarking(resolveTo: directory))
        try folder.chooseFolder(directory, account: account)
        try folder.setAutomaticReceive(true, account: account)

        folder.forget(account: account)

        XCTAssertNil(store.bookmarkData(account: account))
        XCTAssertFalse(folder.isAutomaticReceiveEnabled(account: account))
        XCTAssertEqual(folder.open(account: account).state, .absent)
    }

    /// A folder grant and an unattended-write opt-in that carried across a sign-in
    /// would let one account's decision authorise writes on behalf of another.
    func testBothTheGrantAndTheOptInAreScopedToOneAccount() throws {
        let directory = try temporaryDirectory()
        let store = InMemoryInboxFolderStore()
        let folder = InboxReceiveFolder(store: store, bookmarking: FakeBookmarking(resolveTo: directory))
        try folder.chooseFolder(directory, account: account)
        try folder.setAutomaticReceive(true, account: account)

        XCTAssertEqual(folder.open(account: other).state, .absent)
        XCTAssertFalse(folder.isAutomaticReceiveEnabled(account: other))
        XCTAssertThrowsError(try folder.setAutomaticReceive(true, account: other))
    }

    /// A folder that cannot be written is never STORED as a grant, so a later
    /// launch does not resolve a bookmark that was already known to be useless.
    func testAFolderThatFailsItsProbeIsNotStored() throws {
        let directory = try temporaryDirectory()
        let file = directory.appendingPathComponent("a-file")
        FileManager.default.createFile(atPath: file.path, contents: Data())
        let store = InMemoryInboxFolderStore()
        let folder = InboxReceiveFolder(store: store, bookmarking: FakeBookmarking(resolveTo: file))
        XCTAssertThrowsError(try folder.chooseFolder(file, account: account)) {
            XCTAssertEqual($0 as? InboxFolderError, .notWritable)
        }
        XCTAssertNil(store.bookmarkData(account: account))
    }

    // MARK: - the writability probe

    /// Mode bits lie. The probe is a real create-and-remove because
    /// `receiveDirReady` decides whether a sender is told their file will land.
    func testTheProbeIsACreateAndRemoveThatLeavesNothingBehind() throws {
        let directory = try temporaryDirectory()
        XCTAssertTrue(InboxReceiveFolder.probeWritable(directory))
        let contents = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        XCTAssertTrue(contents.isEmpty, "the probe left a file behind: \(contents)")
    }

    /// A previous probe that died before cleanup must not make the folder look
    /// unusable forever.
    func testAStaleProbeFileIsClearedRatherThanTreatedAsAFailure() throws {
        let directory = try temporaryDirectory()
        let stale = directory.appendingPathComponent(InboxReceiveFolder.probeName)
        FileManager.default.createFile(atPath: stale.path, contents: Data("old".utf8))
        XCTAssertTrue(InboxReceiveFolder.probeWritable(directory))
        XCTAssertFalse(FileManager.default.fileExists(atPath: stale.path))
    }

    func testAMissingOrNonDirectoryTargetFailsTheProbe() throws {
        let directory = try temporaryDirectory()
        XCTAssertFalse(InboxReceiveFolder.probeWritable(
            directory.appendingPathComponent("does-not-exist")))
        let file = directory.appendingPathComponent("a-file")
        FileManager.default.createFile(atPath: file.path, contents: Data())
        XCTAssertFalse(InboxReceiveFolder.probeWritable(file))
    }

    /// A symlink TO a directory is refused: the grant names a folder, and
    /// following a link would write wherever it points now rather than where the
    /// user pointed it then.
    func testASymlinkedTargetFailsTheProbe() throws {
        let directory = try temporaryDirectory()
        let real = directory.appendingPathComponent("real", isDirectory: true)
        try FileManager.default.createDirectory(at: real, withIntermediateDirectories: true)
        let link = directory.appendingPathComponent("link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)
        XCTAssertFalse(InboxReceiveFolder.probeWritable(link))
    }

    // MARK: - the real API

    /// The seam above stands in for `URL.bookmarkData`/`URL(resolvingBookmarkData:)`.
    /// This is the one test that proves it stands in for something real: a genuine
    /// security-scoped bookmark for a temporary directory, created and resolved
    /// through the product's own `SystemInboxFolderBookmarking`, resolving back to
    /// the same path.
    ///
    /// `.withSecurityScope` on BOTH sides is what makes a bookmark a durable
    /// authorization rather than a path, and it is required on macOS by Apple's
    /// current documentation. Unsandboxed hosts (like `swift test`) still accept
    /// the option, which is what makes this runnable here.
    func testARealSecurityScopedBookmarkRoundTrips() throws {
        #if os(macOS)
        let directory = try temporaryDirectory()
        let bookmarking = SystemInboxFolderBookmarking()
        let data = try bookmarking.bookmark(for: directory)
        XCTAssertFalse(data.isEmpty)

        let resolved = try bookmarking.resolve(data)
        XCTAssertEqual(resolved.url.standardizedFileURL.path, directory.standardizedFileURL.path)

        // Balanced, whatever the sandbox decides: an unsandboxed host returns
        // false from `startAccessingSecurityScopedResource` because there is no
        // extension to consume, and a stop is owed only for a start that
        // succeeded.
        if bookmarking.startAccess(to: resolved.url) {
            bookmarking.stopAccess(to: resolved.url)
        }
        XCTAssertTrue(InboxReceiveFolder.probeWritable(resolved.url))
        #endif
    }

    /// The stored keys are namespaced per account, so the defaults domain cannot
    /// let one account's grant be read under another's name.
    func testTheDefaultsKeysAreNamespacedPerAccount() {
        XCTAssertNotEqual(UserDefaultsInboxFolderStore.bookmarkKey(account),
                          UserDefaultsInboxFolderStore.bookmarkKey(other))
        XCTAssertNotEqual(UserDefaultsInboxFolderStore.bookmarkKey(account),
                          UserDefaultsInboxFolderStore.automaticKey(account))
        XCTAssertTrue(UserDefaultsInboxFolderStore.bookmarkKey(account).hasSuffix(account.value))
    }
}

/// Drives the outcomes a real bookmark cannot be made to produce on demand.
private final class FakeBookmarking: InboxFolderBookmarking, @unchecked Sendable {
    var resolved: URL?
    var isStale = false
    var refuseAccess = false
    var failBookmarkCreation = false
    var nextBookmark: Data?

    enum Event: Equatable { case bookmark, resolve, start, stop }

    private(set) var events: [Event] = []
    private(set) var started: [String] = []
    private(set) var stopped: [String] = []

    init(resolveTo url: URL? = nil) { resolved = url }

    func bookmark(for url: URL) throws -> Data {
        if failBookmarkCreation { throw InboxFolderError.bookmarkFailed }
        events.append(.bookmark)
        return nextBookmark ?? Data(url.path.utf8)
    }

    func resolve(_ data: Data) throws -> (url: URL, isStale: Bool) {
        guard let resolved else { throw InboxFolderError.bookmarkFailed }
        events.append(.resolve)
        return (resolved, isStale)
    }

    func startAccess(to url: URL) -> Bool {
        if refuseAccess { return false }
        events.append(.start)
        started.append(url.path)
        return true
    }

    func stopAccess(to url: URL) {
        events.append(.stop)
        stopped.append(url.path)
    }
}
