import Combine
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// The conversation surface's own decisions, driven where a test can reach them:
/// how a row is named and summarised, what a staged batch may be sealed to, and
/// what a local deletion is and is not.
///
/// The iOS conversation page and the macOS one render from the same functions —
/// that is what stops the two describing one device two ways — so these assert
/// the shared rules and the iOS-only staging model that has no macOS counterpart.
@MainActor
final class IOSInboxConversationTests: XCTestCase {

    private let account = try! InboxAccountID("accountconvaaa1")
    private let other = try! InboxAccountID("accountconvbbb2")
    private let epoch = Date(timeIntervalSince1970: 1_700_000_000)

    // MARK: - naming a row

    /// A device removed from the account keeps its name AND its qualifier.
    ///
    /// Dropping the qualifier is the failure that matters: the row still reads
    /// as an ordinary device, so the user opens it expecting to send and finds a
    /// page that cannot. The legacy bucket is the other special case — it
    /// predates authenticated attribution and has no device to name at all.
    func testAConversationRowNamesRemovedAndLegacyPeersHonestly() {
        let live = conversation(peer: "peer-1", entries: [])
        XCTAssertEqual(
            InboxTimelinePresentation.conversationName(live, resolvedName: "Studio Mac",
                                                       isRemoved: false, language: .en),
            "Studio Mac")

        let removed = InboxTimelinePresentation.conversationName(
            live, resolvedName: "Studio Mac", isRemoved: true, language: .en)
        XCTAssertTrue(removed.contains("Studio Mac"),
                      "a removed device lost the name the user knows it by")
        XCTAssertNotEqual(removed, "Studio Mac",
                          "a removed device reads as one that can still be sent to")

        let legacy = conversation(peer: InboxConversationStore.legacySenderID, entries: [])
        XCTAssertEqual(
            InboxTimelinePresentation.conversationName(legacy, resolvedName: "ignored",
                                                       isRemoved: false, language: .en),
            L10n.t(.inboxConversationLegacy, language: .en),
            "the pre-attribution bucket must not borrow a device's name")

        // Both languages, because a row whose qualifier exists in one catalog
        // only is a row that lies in the other.
        for language in AppLanguage.allCases {
            let text = InboxTimelinePresentation.conversationName(
                live, resolvedName: "Studio Mac", isRemoved: true, language: language)
            XCTAssertFalse(text.isEmpty)
            XCTAssertNotEqual(text, "Studio Mac", "\(language.rawValue) drops the qualifier")
        }
    }

    /// Unread messages and unread files are counted and stated SEPARATELY.
    ///
    /// A row that summed them would claim a number matching neither, and the two
    /// are different things to go and look at — one is text on this screen, the
    /// other is files in the Files app.
    func testAConversationSummaryCountsMessagesAndFilesApart() {
        let entries = [
            received(id: "r:1", kind: .message, files: [], readAt: nil),
            received(id: "r:2", kind: .files, files: ["a.txt", "b.txt"], readAt: nil),
            received(id: "r:3", kind: .files, files: ["c.txt"], readAt: epoch),
        ]
        let summary = InboxTimelinePresentation.conversationSummary(
            conversation(peer: "peer-1", entries: entries), language: .en)
        // One unread message, two unread files — the read one is excluded.
        //
        // Asserted against the rendered plural rather than against the digit:
        // the summary also carries a timestamp, and a bare `contains("3")` would
        // match the date instead of the count it is meant to be about.
        XCTAssertTrue(summary.contains(L10n.plural(.inboxSavedFiles, 2, language: .en)),
                      "the unread file count is missing or wrong")
        XCTAssertFalse(summary.contains(L10n.plural(.inboxSavedFiles, 3, language: .en)),
                       "a read entry was counted, or the two kinds were summed")
        XCTAssertTrue(summary.contains(L10n.t(.inboxSavedMessage, language: .en)),
                      "the unread message is not stated apart from the files")

        // A conversation with nothing unread still says when it last moved, or
        // the list has no order the reader can see.
        let quiet = InboxTimelinePresentation.conversationSummary(
            conversation(peer: "peer-1",
                         entries: [received(id: "r:1", kind: .message, files: [],
                                            readAt: epoch)]),
            language: .en)
        XCTAssertFalse(quiet.isEmpty)

        // And it carries no body and no file name: this is a list of rows on a
        // screen somebody may be holding in public.
        for secret in ["a.txt", "b.txt", "c.txt"] {
            XCTAssertFalse(summary.contains(secret),
                           "the conversation list leaked a file name")
        }
        for language in AppLanguage.allCases {
            XCTAssertFalse(InboxTimelinePresentation.conversationSummary(
                conversation(peer: "peer-1", entries: entries),
                language: language).isEmpty, "\(language.rawValue) renders an empty summary")
        }
    }

    // MARK: - the composer's staged batch

    /// **A batch chosen for one device is never sealed to another.**
    ///
    /// The conversation page can be reused for a different peer without being
    /// torn down — `focusPeer` writes one value and SwiftUI is free to keep the
    /// same view — so a composer that merely remembered its files would aim them
    /// at whoever the page is showing now. `batch(for:)` re-asks at the moment of
    /// use, and `stage(for:)` discards rather than re-addressing.
    func testAStagedBatchCannotBeSealedToADeviceItWasNotChosenFor() throws {
        let composer = InboxComposerModel(enforcesReadyAccount: false)
        let urls = try stagedFiles(count: 2)

        composer.stage(for: "peer-1")
        composer.chooseFiles(.success(urls))
        XCTAssertEqual(composer.files.count, 2)
        XCTAssertEqual(composer.batch(for: "peer-1")?.count, 2)
        XCTAssertNil(composer.batch(for: "peer-2"),
                     "a batch chosen for one device was offered to another")

        // Re-aiming the page discards, rather than silently re-addressing.
        composer.stage(for: "peer-2")
        XCTAssertTrue(composer.files.isEmpty,
                      "files chosen while looking at one device followed the user to another")
        XCTAssertNil(composer.batch(for: "peer-2"))
        XCTAssertNil(composer.batch(for: "peer-1"))
    }

    /// Staging the same peer twice is a redraw, not a discard.
    func testStagingTheSamePeerAgainKeepsTheBatch() throws {
        let composer = InboxComposerModel(enforcesReadyAccount: false)
        composer.stage(for: "peer-1")
        composer.chooseFiles(.success(try stagedFiles(count: 1)))
        composer.stage(for: "peer-1")
        XCTAssertEqual(composer.batch(for: "peer-1")?.count, 1,
                       "a redraw threw away the files the user had just chosen")
    }

    /// **An account switch clears the staged batch, with no page on screen.**
    ///
    /// This is why the composer is app-scoped and observes the session in `init`
    /// rather than from a `.task` on the conversation page: a `TabView` may tear
    /// the Device Inbox down, and a batch chosen under one account must not be
    /// sealable to a device belonging to the next one.
    func testAnAccountSwitchClearsTheStagedBatch() async throws {
        let session = CurrentValueSubject<SessionState, Never>(.loggedOut)
        let composer = InboxComposerModel()
        composer.observe(session)

        session.send(try ready("user-a"))
        await settle()
        composer.stage(for: "peer-1")
        composer.chooseFiles(.success(try stagedFiles(count: 2)))
        XCTAssertEqual(composer.files.count, 2)

        // The SAME account republished for an unrelated reason — a usage
        // refresh, a plan change — is not an isolation event, and clearing on it
        // would drop a batch mid-choice every time the plan was re-read.
        session.send(try ready("user-a"))
        await settle()
        XCTAssertEqual(composer.files.count, 2,
                       "a republished account discarded a batch the user was choosing")

        // A DIFFERENT account is.
        session.send(try ready("user-b"))
        await settle()
        XCTAssertTrue(composer.files.isEmpty,
                      "one account's staged files survived into another's session")
        XCTAssertNil(composer.peerID,
                     "the composer stayed aimed at the previous account's device")
    }

    /// Signing out clears it too, and a picker callback that lands afterwards is
    /// refused rather than putting a hidden batch back into a signed-out model.
    func testSignOutClearsTheBatchAndRefusesALatePickerCallback() async throws {
        let session = CurrentValueSubject<SessionState, Never>(.loggedOut)
        let composer = InboxComposerModel()
        composer.observe(session)
        session.send(try ready("user-a"))
        await settle()
        composer.stage(for: "peer-1")
        composer.chooseFiles(.success(try stagedFiles(count: 1)))
        XCTAssertFalse(composer.files.isEmpty)

        session.send(.loggedOut)
        await settle()
        XCTAssertTrue(composer.files.isEmpty)

        // The picker was already up when the account left.
        composer.chooseFiles(.success(try stagedFiles(count: 1)))
        XCTAssertTrue(composer.files.isEmpty,
                      "a picker callback re-armed a signed-out composer")
    }

    /// A picker failure clears the batch and says why, rather than leaving the
    /// previous selection in place under a Send button that would use it.
    func testAPickerFailureClearsTheBatchAndReportsIt() throws {
        let composer = InboxComposerModel(enforcesReadyAccount: false)
        composer.stage(for: "peer-1")
        composer.chooseFiles(.success(try stagedFiles(count: 1)))
        XCTAssertFalse(composer.files.isEmpty)

        composer.chooseFiles(.failure(InboxError.network))
        XCTAssertTrue(composer.files.isEmpty,
                      "a failed choice left the previous batch armed")
        XCTAssertNotNil(composer.selectionError)

        // And the next successful choice clears the message.
        composer.chooseFiles(.success(try stagedFiles(count: 1)))
        XCTAssertNil(composer.selectionError)
    }

    /// A cancelled picker — an empty URL list — clears rather than sending
    /// nothing, and does not report a failure the user did not cause.
    func testAnEmptyChoiceClearsWithoutReportingAFailure() throws {
        let composer = InboxComposerModel(enforcesReadyAccount: false)
        composer.stage(for: "peer-1")
        composer.chooseFiles(.success(try stagedFiles(count: 1)))
        composer.chooseFiles(.success([]))
        XCTAssertTrue(composer.files.isEmpty)
        XCTAssertNil(composer.selectionError)
        XCTAssertNil(composer.batch(for: "peer-1"),
                     "Send would have been offered for an empty batch")
    }

    // MARK: - the navigation path IS the model's focus

    /// **An account switch while a conversation is open pops it.**
    ///
    /// The iOS conversation page's `NavigationStack` path is bound to
    /// `InboxSendModel.focusedPeerID` rather than to a `@State` mirror, and this
    /// is the case that distinguishes the two: `isolateFromPreviousAccount`
    /// drops the focus, so the path empties and the page comes down. A mirror
    /// would leave the previous account's device page on screen — with its
    /// title, its history and a composer aimed at it — under the new account's
    /// session.
    ///
    /// Asserted on the model rather than through SwiftUI, because the binding is
    /// a pure function of this value: `focusedPeerID.map { [$0] } ?? []`.
    func testAnAccountSwitchEmptiesTheConversationNavigationPath() async throws {
        let session = CurrentValueSubject<SessionState, Never>(.loggedOut)
        let model = makeSendModel()
        model.observe(session)

        session.send(try ready("user-a"))
        await settle()
        model.focusPeer("peer-1")
        XCTAssertEqual(path(of: model), ["peer-1"], "the page never opened")

        // The same account republished is not an isolation event, and must not
        // close a page the user is reading.
        session.send(try ready("user-a"))
        await settle()
        XCTAssertEqual(path(of: model), ["peer-1"],
                       "a usage refresh closed the conversation the user was reading")

        session.send(try ready("user-b"))
        await settle()
        XCTAssertTrue(path(of: model).isEmpty,
                      "the previous account's device page stayed open under a new account")

        // And so does signing out entirely.
        session.send(try ready("user-b"))
        await settle()
        model.focusPeer("peer-2")
        XCTAssertEqual(path(of: model), ["peer-2"])
        session.send(.loggedOut)
        await settle()
        XCTAssertTrue(path(of: model).isEmpty,
                      "a signed-out app kept a device page open")
    }

    /// A peer that cannot be sent to still OPENS, and still has no composer.
    ///
    /// Two different questions with two different answers, and collapsing them
    /// is a defect in either direction: refusing to open a blocked device hides
    /// the history the user came for, and offering a composer for one is a Send
    /// the model would refuse.
    func testOpeningAPeerIsSeparateFromBeingAbleToSendToIt() async throws {
        let session = CurrentValueSubject<SessionState, Never>(.loggedOut)
        let model = makeSendModel()
        model.observe(session)
        session.send(try ready("user-a"))
        await settle()

        // Nothing in the directory yet — a conversation with a device the
        // account no longer lists.
        model.focusPeer("peer-gone")
        XCTAssertEqual(path(of: model), ["peer-gone"], "a removed peer's page would not open")
        XCTAssertNil(model.selectedCandidate,
                     "a peer the directory does not list was offered a composer")
        XCTAssertNil(model.selectedTargetID)

        // And `selectTarget` — the aiming door rather than the navigation one —
        // refuses it outright.
        model.selectTarget("peer-gone")
        XCTAssertNil(model.selectedTargetID)
    }

    private func makeSendModel() -> InboxSendModel {
        InboxSendModel(
            pending: PendingUploadSupport(
                store: PendingUploadStore(root: FileManager.default.temporaryDirectory
                    .appendingPathComponent("relayium-ios-send-\(UUID().uuidString)")),
                keys: InMemoryStoredLinkKeyStore(), drafts: nil),
            uploader: CloudUploader(transport: HTTPResumableTransport(
                baseURL: URL(string: "https://example.invalid")!)),
            // Never called: nothing in these tests sends. The model's isolation
            // and its focus are both decided before a credential is ever spent,
            // which is the point — a switch has to clear them without any
            // network having been reached.
            makeSender: { _ in FakeInboxSenderTransport() },
            objects: AccountClient(baseURL: URL(string: "https://example.invalid")!))
    }

    /// The binding `DeviceInboxView` installs, as a pure function so the
    /// property can be asserted without SwiftUI.
    private func path(of model: InboxSendModel) -> [String] {
        model.focusedPeerID.map { [$0] } ?? []
    }

    // MARK: - deleting history is local, and converges

    /// **A deletion interrupted between the tombstone and the unlink finishes on
    /// the next refresh.**
    ///
    /// The tombstone is durable before `delete` returns; removing the protected
    /// body is the caller's half. A crash in that window is the one case where a
    /// deleted message could stay on disk with nothing on screen able to delete
    /// it again — so the convergence is not a nicety, it is the difference
    /// between "deleted" being true and being a claim.
    func testAnInterruptedDeletionConvergesOnTheNextRefresh() throws {
        let harness = try makeStores()
        let entry = received(id: "r:task1", kind: .message, files: [], readAt: nil,
                             messageID: "task1")
        _ = try harness.conversations.record(entry)
        try harness.messages.commit(id: "task1", text: "secret", receivedAt: epoch)
        XCTAssertNotNil(harness.messages.all().first)

        // The deletion, with the unlink half NOT performed — exactly the state a
        // process death between the two leaves behind.
        let owed = try harness.conversations.delete(entryIDs: [entry.id],
                                                    peerDeviceID: "peer-1")
        XCTAssertEqual(owed.receivedMessageIDs, ["task1"])
        XCTAssertNotNil(harness.messages.all().first,
                        "the fixture did not actually leave the body behind")
        XCTAssertFalse(try harness.conversations.pendingPlaintextCleanup().isEmpty,
                       "the store forgot it was owed a removal")

        // A controller adopting this account converges it before publishing.
        let controller = makeController(harness)
        controller.session(InboxAccountIdentity(accountID: account.value, bearer: "bearer"))
        controller.refreshConversations()
        XCTAssertNil(harness.messages.all().first,
                     "the protected body survived a deletion the user already confirmed")
        XCTAssertTrue(try harness.conversations.pendingPlaintextCleanup().isEmpty,
                      "the debt was not cleared, so it would be retried forever")
        XCTAssertTrue(controller.deletedTimelineIDs.contains(entry.id),
                      "the tombstone is not published, so a live send card would linger")
        controller.signedOut()
    }

    /// **Deleting is not a recall, and does not touch the delivery.**
    ///
    /// A deleted send stops being DESCRIBED. Nothing about it changes: it keeps
    /// running, keeps reporting and keeps its staged bytes, its content key and
    /// its idempotency key. The tombstone's only job is to stop the row coming
    /// back — which is also why a later state update may not recreate it.
    func testDeletingASendStopsDescribingItWithoutCancellingIt() throws {
        let harness = try makeStores()
        let controller = makeController(harness)
        controller.session(InboxAccountIdentity(accountID: account.value, bearer: "bearer"))

        let event = InboxSentHistoryEvent(
            accountID: account.value, jobID: "job1", peerDeviceID: "peer-1",
            kind: .message, at: epoch, byteCount: 4, files: [],
            state: .sending, taskID: nil)
        XCTAssertTrue(controller.recordSentHistory(event, messageBody: { "hello" }))
        XCTAssertFalse(controller.isSentHistoryDeleted(accountID: account.value, jobID: "job1"))

        let id = InboxTimelineEntry.sentID(jobID: "job1")
        controller.deleteTimelineEntry(id, peerDeviceID: "peer-1")
        XCTAssertTrue(controller.isSentHistoryDeleted(accountID: account.value, jobID: "job1"),
                      "a deleted send would still be drawn as a card")

        // The delivery goes on reporting, and the report must NOT resurrect the
        // row — the failure the tombstones exist to prevent, reintroduced one
        // layer above them.
        controller.updateSentHistory(accountID: account.value, jobID: "job1",
                                     state: .saved, taskID: "task9")
        controller.refreshConversations()
        XCTAssertFalse(controller.conversations.contains { $0.entries.contains { $0.id == id } },
                       "a status update wrote a deleted history row back")
        XCTAssertTrue(controller.isSentHistoryDeleted(accountID: account.value, jobID: "job1"))
        controller.signedOut()
    }

    /// **A sent history event belonging to another account is refused.**
    ///
    /// The send model and the controller adopt an account from the same session
    /// a turn apart, so during a switch one can still be describing the previous
    /// one. Trusting that would write one account's sent history into another's
    /// index — a leak the user would then read as their own.
    func testSentHistoryFromAnotherAccountIsRefused() throws {
        let harness = try makeStores()
        let controller = makeController(harness)
        controller.session(InboxAccountIdentity(accountID: account.value, bearer: "bearer"))

        let stale = InboxSentHistoryEvent(
            accountID: other.value, jobID: "job-other", peerDeviceID: "peer-1",
            kind: .message, at: epoch, byteCount: 4, files: [],
            state: .sending, taskID: nil)
        XCTAssertFalse(controller.recordSentHistory(stale, messageBody: { "not mine" }),
                       "the previous account's send was written into this one's index")
        controller.refreshConversations()
        XCTAssertFalse(controller.conversations.contains {
            $0.entries.contains { $0.id == InboxTimelineEntry.sentID(jobID: "job-other") }
        })
        controller.signedOut()
    }

    /// Signing out drops every rendered trace of the account, with no view
    /// involved — so a switch cannot leave the next account looking at the
    /// previous one's conversations.
    func testSigningOutClearsEveryPublishedTraceOfTheAccount() throws {
        let harness = try makeStores()
        _ = try harness.conversations.record(
            received(id: "r:task1", kind: .message, files: [], readAt: nil, messageID: "task1"))
        let controller = makeController(harness)
        controller.session(InboxAccountIdentity(accountID: account.value, bearer: "bearer"))
        controller.refreshConversations()
        XCTAssertFalse(controller.conversations.isEmpty)

        controller.signedOut()
        XCTAssertTrue(controller.conversations.isEmpty)
        XCTAssertTrue(controller.deletedTimelineIDs.isEmpty)
        XCTAssertTrue(controller.messages.isEmpty)
        XCTAssertNil(controller.activeAccountID)
        XCTAssertEqual(controller.state, .signedOut)
    }

    /// The bridge's mapping: `ready` with a bearer is the ONLY state that
    /// produces an identity, so nothing else can keep a generation alive.
    ///
    /// `unavailable` is the one worth naming: a token is held but the account
    /// could not be loaded, so this app cannot tell a revoked credential from a
    /// server outage. Continuing to receive would be rendering "we are not sure"
    /// as "yes".
    func testOnlyAReadyAccountWithABearerMayReceive() {
        XCTAssertEqual(
            InboxSessionBridge.identity(for: try ready("user-a"), bearer: "token")?.accountID,
            "user-a")
        XCTAssertNil(InboxSessionBridge.identity(for: try ready("user-a"), bearer: nil))
        XCTAssertNil(InboxSessionBridge.identity(for: try ready("user-a"), bearer: ""))
        for state: SessionState in [.loggedOut, .restoring, .authenticating,
                                    .unavailable(message: "offline"),
                                    .emailUnverified(email: "a@b.c")] {
            XCTAssertNil(InboxSessionBridge.identity(for: state, bearer: "token"),
                         "\(state) produced a receiving identity")
        }
    }

    // MARK: - fixtures

    private struct Stores {
        let conversations: InboxConversationStore
        let messages: InboxMessageStore
        let sentMessages: InboxMessageStore
    }

    private func makeStores() throws -> Stores {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("relayium-ios-conv-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return Stores(
            conversations: InboxConversationStore(
                directory: root.appendingPathComponent("conversations", isDirectory: true)),
            messages: InboxMessageStore(
                directory: root.appendingPathComponent("messages", isDirectory: true)),
            sentMessages: InboxMessageStore(
                directory: root.appendingPathComponent("sent", isDirectory: true)))
    }

    private func makeController(_ stores: Stores) -> InboxController {
        InboxController(runtime: InboxRuntime(
            folder: InboxReceiveFolder(store: InMemoryInboxFolderStore()),
            makeEngine: { _, _ in throw InboxError.network },
            messageStore: { _ in stores.messages },
            sentMessageStore: { _ in stores.sentMessages },
            conversationStore: { _ in stores.conversations },
            sleeper: ManualInboxSleeper(),
            platform: AppEnvironment.iosInboxPlatform, appVersion: "test"))
    }

    private func conversation(peer: String, entries: [InboxTimelineEntry]) -> InboxConversation {
        InboxConversation(peerDeviceID: peer, peerNameSnapshot: "", entries: entries)
    }

    private func received(id: String, kind: InboxTimelineEntry.Kind, files: [String],
                          readAt: Date?, messageID: String? = nil) -> InboxTimelineEntry {
        InboxTimelineEntry(
            id: id, peerDeviceID: "peer-1", direction: .received, kind: kind,
            at: epoch, peerNameSnapshot: "", byteCount: Int64(files.count),
            taskID: String(id.dropFirst(2)), messageID: messageID,
            files: files.map { .init(urlPath: "/tmp/\($0)", displayName: $0) },
            readAt: readAt)
    }

    /// `.ready` built from the same server-frozen fixtures the account tests
    /// use, with the user id as the knob — because the id is the whole of what
    /// isolation turns on, and a hand-made shape might not be one the server can
    /// actually produce.
    private func ready(_ userID: String) throws -> SessionState {
        let meURL = try XCTUnwrap(Bundle.module.url(forResource: "me", withExtension: "json"))
        var user = try JSONDecoder().decode(MeResponse.self,
                                            from: Data(contentsOf: meURL)).user
        user.id = userID
        let usageURL = try XCTUnwrap(Bundle.module.url(forResource: "me-usage",
                                                       withExtension: "json"))
        let usage = try JSONDecoder().decode(UsageResponse.self,
                                             from: Data(contentsOf: usageURL))
        return .ready(user: user, usage: usage)
    }

    private func stagedFiles(count: Int) throws -> [URL] {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("relayium-ios-staged-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return try (0..<count).map { index in
            let url = root.appendingPathComponent("file\(index).txt")
            try Data("payload\(index)".utf8).write(to: url)
            return url
        }
    }

    private func settle(_ turns: Int = 4) async {
        for _ in 0..<turns { await Task.yield() }
    }
}
