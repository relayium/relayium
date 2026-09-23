import XCTest
@testable import RelayiumAppKit

/// A21: Open / Share / Save to Files for files the Device Inbox actually saved.
///
/// Three properties, each with an adversarial case:
///  1. **Only a file inside the receive folder is ever handed over** — a
///     recorded path with `..`, one outside any receive folder, and a symbolic
///     link out of the folder are all refused.
///  2. **What is handed over is the file that was saved** — found again after
///     the container moved, byte-identical, and reported missing (never
///     "available") once it is deleted or replaced by a folder.
///  3. **An answer is only ever about the account and entry that asked** — a
///     lookup that lands after an account switch, a local delete or a newer
///     request publishes nothing, and a presented request is dropped when its
///     entry or account goes.
@MainActor
final class InboxReceivedFileAccessTests: XCTestCase {
    private var root: URL!
    /// `<root>/NEW/Documents/Received` — the receive folder as resolved now.
    private var folder: URL!
    private let oldContainer = "/var/mobile/Containers/Data/Application/OLD-UUID"

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("a21-\(UUID().uuidString)")
        folder = root.appendingPathComponent("NEW/Documents/Received", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    // MARK: - fixtures

    @discardableResult
    private func write(_ relative: String, _ text: String = "saved bytes") throws -> URL {
        let url = folder.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url)
        return url
    }

    /// What the receiver recorded at commit time, in the OLD container.
    private func recorded(_ relative: String) -> InboxTimelineEntry.FileReference {
        .init(urlPath: oldContainer + "/Documents/Received/" + relative,
              displayName: (relative as NSString).lastPathComponent)
    }

    private func entry(id: String = "r:task-1", peer: String = "peer-1",
                       direction: InboxTimelineEntry.Direction = .received,
                       kind: InboxTimelineEntry.Kind = .files,
                       files: [InboxTimelineEntry.FileReference],
                       readAt: Date? = nil) -> InboxTimelineEntry {
        InboxTimelineEntry(id: id, peerDeviceID: peer, direction: direction, kind: kind,
                           at: Date(timeIntervalSince1970: 1), peerNameSnapshot: "Studio",
                           byteCount: 1, taskID: "task-1", files: files, readAt: readAt)
    }

    // MARK: - 1. containment

    func testAFileIsFoundAgainAfterTheContainerMovedAndItsBytesAreTheSavedOnes() throws {
        try write("a.txt", "exact bytes")
        let located = InboxReceivedFileAccess.locate(recorded("a.txt"), in: folder)
        guard case let .available(url) = located else {
            return XCTFail("a saved file was not found after the container moved: \(located)")
        }
        XCTAssertEqual(try Data(contentsOf: url), Data("exact bytes".utf8),
                       "what would be shared is not the file that was saved")
    }

    func testTheOrdinaryCaseResolvesUnderTheCurrentFolder() throws {
        let saved = try write("b.txt")
        let reference = InboxTimelineEntry.FileReference(url: saved)
        XCTAssertEqual(InboxReceivedFileAccess.relativePath(ofRecorded: reference.urlPath,
                                                           in: folder), "b.txt")
        XCTAssertNotNil(InboxReceivedFileAccess.files(
            of: entry(files: [reference]), in: folder).first?.url)
    }

    func testAFileInsideAReceivedFolderKeepsItsPlace() throws {
        try write("Photos/day 1/c.jpg")
        let file = try XCTUnwrap(InboxReceivedFileAccess.files(
            of: entry(files: [recorded("Photos/day 1/c.jpg")]), in: folder).first)
        XCTAssertEqual(file.relativePath, "Photos/day 1/c.jpg")
        XCTAssertNotNil(file.url)
    }

    /// **Adversarial: a recorded path cannot climb out of the receive folder.**
    func testTraversalAndForeignPathsAreRefused() throws {
        // A real file one level above the receive folder, which `..` would reach.
        try Data("secret".utf8).write(to: folder.deletingLastPathComponent()
            .appendingPathComponent("secret.txt"))
        for hostile in [oldContainer + "/Documents/Received/../secret.txt",
                        folder.path + "/../secret.txt",
                        folder.path + "/./secret.txt",
                        folder.path + "//secret.txt",
                        "/etc/hosts",
                        oldContainer + "/Documents/Received/",
                        folder.path] {
            let reference = InboxTimelineEntry.FileReference(urlPath: hostile,
                                                            displayName: "secret.txt")
            XCTAssertEqual(InboxReceivedFileAccess.locate(reference, in: folder), .refused,
                           "a recorded path escaped or aliased the receive folder: \(hostile)")
        }
    }

    /// **Adversarial: a symbolic link inside the folder does not lead out of it.**
    func testASymbolicLinkOutOfTheFolderIsRefusedAndOneInsideIsFollowed() throws {
        let outside = root.appendingPathComponent("outside.txt")
        try Data("not received".utf8).write(to: outside)
        try FileManager.default.createSymbolicLink(
            at: folder.appendingPathComponent("link.txt"), withDestinationURL: outside)
        XCTAssertEqual(InboxReceivedFileAccess.locate(recorded("link.txt"), in: folder), .refused,
                       "a link in the Files-visible folder handed out a file it does not contain")

        let inside = try write("real.txt", "inside")
        try FileManager.default.createSymbolicLink(
            at: folder.appendingPathComponent("alias.txt"), withDestinationURL: inside)
        XCTAssertNotNil(InboxReceivedFileAccess.files(
            of: entry(files: [recorded("alias.txt")]), in: folder).first?.url)
    }

    // MARK: - 2. missing is real

    func testADeletedOrReplacedFileIsMissingNotAvailable() throws {
        let saved = try write("gone.txt")
        try FileManager.default.removeItem(at: saved)
        XCTAssertEqual(InboxReceivedFileAccess.locate(recorded("gone.txt"), in: folder), .missing)

        try FileManager.default.createDirectory(
            at: folder.appendingPathComponent("now-a-folder.txt"), withIntermediateDirectories: true)
        XCTAssertEqual(InboxReceivedFileAccess.locate(recorded("now-a-folder.txt"), in: folder),
                       .missing, "a folder where the file was is not the file")

        try FileManager.default.createSymbolicLink(
            at: folder.appendingPathComponent("dangling.txt"),
            withDestinationURL: folder.appendingPathComponent("nowhere.txt"))
        XCTAssertEqual(InboxReceivedFileAccess.locate(recorded("dangling.txt"), in: folder),
                       .missing)
    }

    func testOnlyAReceivedFilesEntryHasFiles() throws {
        try write("a.txt")
        XCTAssertTrue(InboxReceivedFileAccess.files(
            of: entry(direction: .sent, files: [recorded("a.txt")]), in: folder).isEmpty)
        XCTAssertTrue(InboxReceivedFileAccess.files(
            of: entry(kind: .message, files: [recorded("a.txt")]), in: folder).isEmpty)
    }

    // MARK: - 3. the account and the entry

    func testTheScopeIsTheCurrentAccountsOwnReceivedFilesEntry() {
        let row = entry(files: [recorded("a.txt")])
        let conversations = [InboxConversation(peerDeviceID: "peer-1", peerNameSnapshot: "",
                                               entries: [row])]
        XCTAssertEqual(InboxReceivedFileScope.current(
            accountID: "acct-1", conversations: conversations, deletedTimelineIDs: [],
            peerDeviceID: "peer-1", entryID: row.id)?.accountID, "acct-1")
        XCTAssertNil(InboxReceivedFileScope.current(
            accountID: nil, conversations: conversations, deletedTimelineIDs: [],
            peerDeviceID: "peer-1", entryID: row.id), "signed out, yet a file is in scope")
        XCTAssertNil(InboxReceivedFileScope.current(
            accountID: "acct-1", conversations: conversations, deletedTimelineIDs: [row.id],
            peerDeviceID: "peer-1", entryID: row.id), "a deleted row can still hand out a file")
        XCTAssertNil(InboxReceivedFileScope.current(
            accountID: "acct-1", conversations: conversations, deletedTimelineIDs: [],
            peerDeviceID: "peer-2", entryID: row.id), "another device's page reached this row")
        let sent = [InboxConversation(peerDeviceID: "peer-1", peerNameSnapshot: "",
                                      entries: [entry(direction: .sent, files: [])])]
        XCTAssertNil(InboxReceivedFileScope.current(
            accountID: "acct-1", conversations: sent, deletedTimelineIDs: [],
            peerDeviceID: "peer-1", entryID: row.id))
    }

    /// Live state a test can move while a lookup is in flight.
    private final class Live {
        var accountID: String? = "acct-1"
        var entries: [InboxTimelineEntry] = []
        var deleted: Set<String> = []

        func scope(_ entryID: String) -> InboxReceivedFileScope? {
            InboxReceivedFileScope.current(
                accountID: accountID,
                conversations: [InboxConversation(peerDeviceID: "peer-1", peerNameSnapshot: "",
                                                  entries: entries)],
                deletedTimelineIDs: deleted, peerDeviceID: "peer-1", entryID: entryID)
        }
    }

    /// A receive-folder lookup the test holds until it says so.
    private final class Gate: @unchecked Sendable {
        let entered = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)

        /// Wait for the lookup to reach the folder, without blocking an async
        /// context on a semaphore.
        func waitForEntry() async {
            await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
                DispatchQueue.global().async {
                    self.entered.wait()
                    done.resume()
                }
            }
        }
    }

    private func waitUntil(_ what: String, _ condition: () -> Bool) async {
        for _ in 0..<400 {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("timed out waiting for \(what)")
    }

    func testARequestCarriesTheSavedFilesForThatAccount() async throws {
        try write("a.txt"); try write("Photos/b.txt")
        let live = Live()
        live.entries = [entry(files: [recorded("a.txt"), recorded("Photos/b.txt"),
                                      recorded("gone.txt")])]
        let folder = self.folder!
        let model = InboxReceivedFileAccessModel()

        model.begin(.share, entryID: "r:task-1", receiveFolder: folder, scope: live.scope)
        await waitUntil("the request") { model.request != nil }

        let request = try XCTUnwrap(model.request)
        XCTAssertEqual(request.action, .share)
        XCTAssertEqual(request.accountID, "acct-1")
        XCTAssertEqual(request.urls.map(\.lastPathComponent), ["a.txt", "b.txt"],
                       "a missing file was handed over, or a present one was left out")
        XCTAssertEqual(model.files["r:task-1"]?.filter { $0.url == nil }.count, 1)

        model.finish(request.id)
        XCTAssertNil(model.request)
    }

    /// **Adversarial: a lookup that lands after an account switch hands over
    /// nothing.** The folder is shared by every account on this device; the
    /// history is not.
    func testALookupThatLandsAfterAnAccountSwitchPublishesNothing() async throws {
        try write("a.txt")
        let live = Live()
        live.entries = [entry(files: [recorded("a.txt")])]
        let gate = Gate()
        let folder = self.folder!
        let model = InboxReceivedFileAccessModel(locate: { entry, folder in
            gate.entered.signal()
            gate.release.wait()
            return InboxReceivedFileAccess.files(of: entry, in: folder)
        })

        model.begin(.export, entryID: "r:task-1", receiveFolder: folder, scope: live.scope)
        await gate.waitForEntry()
        // Another account signs in on this device and has the same row id.
        live.accountID = "acct-2"
        gate.release.signal()
        try await Task.sleep(nanoseconds: 200_000_000)

        XCTAssertNil(model.request, "one account's file was handed over under another")
        XCTAssertNil(model.unavailableEntryID)
    }

    /// **Adversarial: a lookup that lands after the row was deleted locally
    /// hands over nothing.**
    func testALookupThatLandsAfterADeletePublishesNothing() async throws {
        try write("a.txt")
        let live = Live()
        live.entries = [entry(files: [recorded("a.txt")])]
        let gate = Gate()
        let folder = self.folder!
        let model = InboxReceivedFileAccessModel(locate: { entry, folder in
            gate.entered.signal()
            gate.release.wait()
            return InboxReceivedFileAccess.files(of: entry, in: folder)
        })

        model.begin(.open, entryID: "r:task-1", receiveFolder: folder, scope: live.scope)
        await gate.waitForEntry()
        live.deleted = ["r:task-1"]
        gate.release.signal()
        try await Task.sleep(nanoseconds: 200_000_000)

        XCTAssertNil(model.request, "a deleted row's file was handed over")
    }

    /// Marking the row read while its lookup runs is the SAME delivery, and
    /// must not cost the user their tap.
    func testMarkingTheRowReadDoesNotDropTheRequest() async throws {
        try write("a.txt")
        let live = Live()
        live.entries = [entry(files: [recorded("a.txt")])]
        let gate = Gate()
        let folder = self.folder!
        let model = InboxReceivedFileAccessModel(locate: { entry, folder in
            gate.entered.signal()
            gate.release.wait()
            return InboxReceivedFileAccess.files(of: entry, in: folder)
        })
        model.begin(.open, entryID: "r:task-1", receiveFolder: folder, scope: live.scope)
        await gate.waitForEntry()
        live.entries = [entry(files: [recorded("a.txt")], readAt: Date())]
        gate.release.signal()
        await waitUntil("the request") { model.request != nil }
    }

    /// A presented request goes when its account or its row does.
    func testAPresentedRequestIsDroppedWhenItsAccountOrEntryGoes() async throws {
        try write("a.txt")
        let live = Live()
        live.entries = [entry(files: [recorded("a.txt")])]
        let folder = self.folder!
        let model = InboxReceivedFileAccessModel()

        model.begin(.share, entryID: "r:task-1", receiveFolder: folder, scope: live.scope)
        await waitUntil("the request") { model.request != nil }
        model.invalidate(scope: live.scope, accountID: live.accountID)
        XCTAssertNotNil(model.request, "an unchanged account and row lost the request")

        live.accountID = "acct-2"
        model.invalidate(scope: live.scope, accountID: live.accountID)
        XCTAssertNil(model.request, "the share sheet outlived the account that opened it")
        XCTAssertEqual(model.files, [:], "the previous account's rows are still described")

        live.accountID = "acct-1"
        model.begin(.share, entryID: "r:task-1", receiveFolder: folder, scope: live.scope)
        await waitUntil("the second request") { model.request != nil }
        live.deleted = ["r:task-1"]
        model.invalidate(scope: live.scope, accountID: live.accountID)
        XCTAssertNil(model.request, "the share sheet outlived the row it was opened from")
    }

    /// Nothing left to hand over is said, and nothing is presented.
    func testAnEntryWhoseFilesAreAllGoneIsReportedUnavailable() async throws {
        let live = Live()
        live.entries = [entry(files: [recorded("gone.txt")])]
        let folder = self.folder!
        let model = InboxReceivedFileAccessModel()

        model.begin(.open, entryID: "r:task-1", receiveFolder: folder, scope: live.scope)
        await waitUntil("the refusal") { model.unavailableEntryID != nil }
        XCTAssertNil(model.request)
        XCTAssertEqual(model.files["r:task-1"]?.first?.availability, .missing)
    }

    /// The row descriptions follow the account too: a refresh that lands after
    /// a switch describes nothing.
    func testARefreshThatLandsAfterAnAccountSwitchDescribesNothing() async throws {
        try write("a.txt")
        let live = Live()
        live.entries = [entry(files: [recorded("a.txt")])]
        let gate = Gate()
        let folder = self.folder!
        let model = InboxReceivedFileAccessModel(locate: { entry, folder in
            gate.entered.signal()
            gate.release.wait()
            return InboxReceivedFileAccess.files(of: entry, in: folder)
        })

        model.refresh(entryIDs: ["r:task-1"], receiveFolder: folder, scope: live.scope)
        await gate.waitForEntry()
        live.accountID = "acct-2"
        gate.release.signal()
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertNil(model.files["r:task-1"], "a row was described under another account")

        live.accountID = "acct-1"
        model.refresh(entryIDs: ["r:task-1"], receiveFolder: folder, scope: live.scope)
        await gate.waitForEntry()
        gate.release.signal()
        await waitUntil("the description") { model.files["r:task-1"] != nil }
    }
}
