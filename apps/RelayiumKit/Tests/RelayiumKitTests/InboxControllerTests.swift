import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// The resident scheduler: what it announces, what it refuses to claim, when it
/// stops, and — above all — what a result that arrives too late is allowed to
/// touch.
///
/// Every test here drives the REAL engine, the real key store, the real sealed
/// box, the real Stored Wire decryptor, the real destination planner, the real
/// `linkat` commit and the real journal. Only three things are substituted, and
/// each one for a reason the Phase 2A review recorded: central (no URL stub can
/// hold a pass open at a chosen instant), the bookmark APIs (a real
/// security-scoped bookmark cannot be made unresolvable on demand), and the
/// clock (a scheduler whose only clock is the real one has tests that either take
/// minutes or assert nothing).
@MainActor
final class InboxControllerTests: XCTestCase {

    private let accountA = try! InboxAccountID("accountctlaaa01")
    private let accountB = try! InboxAccountID("accountctlbbb02")
    private let epoch = Date(timeIntervalSince1970: 1_700_000_000)

    // MARK: - harness

    private final class Harness {
        let store = InMemoryInboxFolderStore()
        let keys = InMemoryInboxDeviceKeyStore()
        let notifier = RecordingInboxNotifier()
        let sleeper = ManualInboxSleeper()
        let revealed = RevealRecorder()
        var folder: InboxReceiveFolder!
        var journals: InboxJournalStore!
        var messages: InboxMessageStore!
        var conversations: InboxConversationStore!
        var root: URL!
        var transports: [String: GatedInboxTransport] = [:]
        var deviceKeys: [String: InboxDeviceKeyPair] = [:]
        var controller: InboxController!
    }

    private func makeHarness(bookmarking: InboxFolderBookmarking? = nil,
                             sleeper: InboxSleeping? = nil) throws -> Harness {
        let harness = Harness()
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("relayium-controller-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let journalDirectory = root.appendingPathExtension("journals")
        let messageDirectory = root.appendingPathExtension("messages")
        let conversationDirectory = root.appendingPathExtension("conversations")
        addTeardownBlock {
            try? FileManager.default.removeItem(at: root)
            try? FileManager.default.removeItem(at: journalDirectory)
            try? FileManager.default.removeItem(at: messageDirectory)
            try? FileManager.default.removeItem(at: conversationDirectory)
        }
        harness.root = root
        harness.journals = InboxJournalStore(directory: journalDirectory)
        harness.messages = InboxMessageStore(directory: messageDirectory)
        harness.conversations = InboxConversationStore(directory: conversationDirectory)
        harness.folder = InboxReceiveFolder(
            store: harness.store,
            bookmarking: bookmarking ?? ControllerBookmarking(url: root))

        let keys = harness.keys
        let journals = harness.journals!
        let messages = harness.messages!
        let conversations = harness.conversations!
        let folder = harness.folder!
        let epoch = self.epoch
        let controller = InboxController(runtime: InboxRuntime(
            folder: folder,
            makeEngine: { [weak harness] account, _ in
                guard let harness else { throw InboxError.network }
                let transport = await MainActor.run { () -> GatedInboxTransport in
                    if let existing = harness.transports[account.value] { return existing }
                    let made = GatedInboxTransport()
                    harness.transports[account.value] = made
                    return made
                }
                return InboxReceiveEngine(transport: transport, keys: keys, journals: journals,
                                          messages: messages, folder: folder,
                                          account: account, now: { epoch },
                                          renewInterval: 3600, streamAttempts: 1)
            },
            notifier: harness.notifier,
            messageStore: { _ in messages },
            conversationStore: { _ in conversations },
            deviceDirectory: { _ in [InboxDeviceRow(id: "sender-device", name: "Sender Mac")] },
            sleeper: sleeper ?? harness.sleeper,
            reveal: { [revealed = harness.revealed] urls in revealed.record(urls) },
            platform: "macos", appVersion: "test",
            backoff: InboxBackoff(idle: 30, afterWork: 2, first: 5, cap: 300, blocked: 60)))
        harness.controller = controller
        return harness
    }

    /// The device key this account publishes, seeded the way enrolment would.
    @discardableResult
    private func seedKey(_ harness: Harness, account: InboxAccountID) async throws
        -> InboxDeviceKeyPair {
        let pair = try InboxKeyMaterial.generateKeyPair()
        _ = try await harness.keys.append(pair, account: account, now: epoch)
        try await harness.keys.bind(publicKey: InboxKeyMaterial.encode(pair.publicKey),
                                    keyID: "key1", generation: 1, account: account)
        harness.deviceKeys[account.value] = pair
        let transport = transport(harness, account)
        transport.enrolResult = .success(InboxEnrolResult(
            inbox: InboxView(presence: .online, canReceive: true,
                             key: InboxKey(id: "key1", algorithm: InboxProtocol.keyAlgorithm,
                                           publicKey: InboxKeyMaterial.encode(pair.publicKey),
                                           generation: 1, createdAt: 0, supersededAt: 0,
                                           revokedAt: 0)),
            protocolVersion: 3, receiveCapability: InboxCapability.receiveV3,
            keyAlgorithm: InboxProtocol.keyAlgorithm))
        return pair
    }

    @discardableResult
    private func transport(_ harness: Harness, _ account: InboxAccountID) -> GatedInboxTransport {
        if let existing = harness.transports[account.value] { return existing }
        let made = GatedInboxTransport()
        harness.transports[account.value] = made
        return made
    }

    private func identity(_ account: InboxAccountID, bearer: String = "bearer-a")
        -> InboxAccountIdentity {
        InboxAccountIdentity(accountID: account.value, bearer: bearer)
    }

    /// Queue one real delivery for this account.
    private func queueDelivery(_ harness: Harness, account: InboxAccountID,
                               taskID: String = "task1",
                               files: [(String, [UInt8])] = [("a.txt", [1, 2, 3])]) throws {
        let key = harness.deviceKeys[account.value]!
        let built = try InboxFixture.delivery(taskID: taskID, files: files, deviceKey: key)
        let transport = transport(harness, account)
        transport.blobBody = built.ciphertext
        transport.pendingResults = [.success([built.delivery.task]), .success([])]
        transport.claimResult = .success((deliveries: [built.delivery], leaseSeconds: 300))
    }

    private func queueMessage(_ harness: Harness, account: InboxAccountID,
                              taskID: String = "task1", text: String) throws {
        let key = harness.deviceKeys[account.value]!
        let built = try InboxFixture.message(taskID: taskID, text: text, deviceKey: key)
        let transport = transport(harness, account)
        transport.blobBody = built.ciphertext
        transport.pendingResults = [.success([built.delivery.task]), .success([])]
        transport.claimResult = .success((deliveries: [built.delivery], leaseSeconds: 300))
    }

    /// Spin the main actor until `condition` holds, so the loop's own `await`s
    /// can make progress. Bounded, because a scheduler test that hangs is a CI
    /// job that hangs.
    private func waitUntil(_ condition: @escaping () -> Bool, _ message: String,
                           file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<3000 {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTFail(message, file: file, line: line)
    }

    private func waitForSleep(_ harness: Harness, atLeast count: Int,
                              file: StaticString = #filePath, line: UInt = #line) async {
        await waitUntil({ harness.sleeper.delays.count >= count },
                        "the loop never reached sleep #\(count)", file: file, line: line)
    }

    // MARK: - default off

    /// A fresh account receives nothing and offers nothing, and says so.
    ///
    /// The state is `disabled` rather than `ready`: nothing is wrong, the user
    /// simply has not said yes. No enrolment, no heartbeat, no pending read and
    /// above all no claim happens on this path.
    func testAFreshAccountIsOffAndClaimsNothing() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        harness.controller.session(identity(accountA))

        await waitForSleep(harness, atLeast: 1)
        XCTAssertEqual(harness.controller.state, .disabled)
        XCTAssertEqual(harness.controller.policy, .off)
        XCTAssertTrue(transport(harness, accountA).calls.isEmpty,
                      "an inbox the user has not enabled must not talk to central at all")
        harness.controller.signedOut()
    }

    /// Choosing a folder is an authorization; receiving is a separate consent.
    /// The one must not imply the other, on screen or in storage.
    func testChoosingAFolderDoesNotTurnReceivingOn() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        harness.controller.session(identity(accountA))
        await waitForSleep(harness, atLeast: 1)

        harness.controller.chooseFolder(harness.root)
        await waitForSleep(harness, atLeast: 2)

        XCTAssertEqual(harness.controller.policy, .off)
        XCTAssertEqual(harness.controller.state, .disabled)
        XCTAssertTrue(harness.controller.folder.isChosen)
        XCTAssertNil(harness.controller.folder.problem)
        XCTAssertTrue(transport(harness, accountA).calls.isEmpty)
        harness.controller.signedOut()
    }

    /// The three answers, each announced as itself. `ask` is the one that cannot
    /// be spelled by a boolean, and announcing it as `off` would make central
    /// refuse a task the user asked to be consulted about.
    func testTheAnnouncedPolicyIsTheUsersOwnAnswer() async throws {
        for policy in [InboxAutoAccept.ask, .auto] {
            let harness = try makeHarness()
            try await seedKey(harness, account: accountA)
            harness.controller.session(identity(accountA))
            await waitForSleep(harness, atLeast: 1)
            harness.controller.chooseFolder(harness.root)
            harness.controller.setPolicy(policy)

            let watched = transport(harness, accountA)
            await waitUntil({
                watched.calls.contains { call in
                    if case .enrol(let announced, _) = call { return announced == policy }
                    return false
                }
            }, "the enrolment never announced \(policy)")
            harness.controller.signedOut()
        }
    }

    /// Receiving on with no folder is never `ready`, and never silently `off`
    /// either: the user's answer stands and the missing half is named.
    func testReceivingWithNoFolderNamesTheMissingHalfAndClaimsNothing() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        // Written straight to the store, because the product's own setter refuses
        // it — this is the repair state where a grant went missing under a policy
        // that is still on.
        harness.store.setReceivePolicy(.auto, account: accountA)
        harness.controller.session(identity(accountA))

        await waitForSleep(harness, atLeast: 1)
        XCTAssertEqual(harness.controller.state, .folderMissing)
        XCTAssertTrue(transport(harness, accountA).calls.isEmpty,
                      "a claim was attempted with nowhere to write")
        harness.controller.signedOut()
    }

    /// A grant that will not resolve stops the claim and identifies the action.
    /// The heartbeat still goes out, and it carries `receiveDirReady: false`, so
    /// the sender is told the truth rather than nothing.
    func testARevokedGrantStopsTheClaimAndAsksForTheFolderAgain() async throws {
        let harness = try makeHarness(bookmarking: UnresolvableBookmarking())
        try await seedKey(harness, account: accountA)
        harness.store.setBookmarkData(Data("x".utf8), account: accountA)
        harness.store.setReceivePolicy(.auto, account: accountA)
        harness.controller.session(identity(accountA))

        await waitUntil({ harness.controller.state == .attention(.folder(.unresolvable)) },
                        "a revoked grant did not become an actionable state")
        let calls = transport(harness, accountA).calls
        XCTAssertTrue(calls.contains(.heartbeat(receiveDirReady: false)),
                      "central was not told this Mac cannot currently receive")
        XCTAssertFalse(calls.contains { if case .claim = $0 { return true } else { return false } },
                       "a delivery was claimed into a folder that failed its probe")
        XCTAssertEqual(InboxStatusPresentation.recovery(for: harness.controller.state),
                       .chooseFolder)
        harness.controller.signedOut()
    }

    // MARK: - one pass at a time

    /// The loop is strictly sequential, and an explicit user action while a pass
    /// is running does not start a second one beside it.
    ///
    /// Asserted against the complete call record: two overlapping passes would
    /// produce a second heartbeat before the first pass's claim.
    func testOnlyOnePassRunsAtATime() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        try enable(harness, account: accountA, policy: .auto)
        let transport = transport(harness, accountA)
        transport.pendingGate.close()
        harness.controller.session(identity(accountA))

        await waitUntil({ transport.pendingGate.isWaiting }, "the pass never reached pending")
        // Three explicit wakes while the first pass is held open.
        harness.controller.retryNow()
        harness.controller.retryNow()
        harness.controller.retryNow()
        try? await Task.sleep(nanoseconds: 20_000_000)

        let heartbeats = transport.calls.filter {
            if case .heartbeat = $0 { return true } else { return false }
        }
        XCTAssertEqual(heartbeats.count, 1,
                       "a second pass started while the first was still running")
        transport.pendingGate.open()
        harness.controller.signedOut()
    }

    // MARK: - cancellation

    func testSignOutStopsTheLoopAndClearsEveryAccountScopedSurface() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        try enable(harness, account: accountA, policy: .auto)
        try queueDelivery(harness, account: accountA)
        harness.controller.session(identity(accountA))

        await waitUntil({ !harness.controller.results.isEmpty }, "no delivery completed")
        let before = transport(harness, accountA).calls.count
        harness.controller.signedOut()

        XCTAssertEqual(harness.controller.state, .signedOut)
        XCTAssertTrue(harness.controller.results.isEmpty,
                      "one account's deliveries survived into a signed-out app")
        XCTAssertEqual(harness.controller.policy, .off)
        XCTAssertEqual(harness.controller.folder, .none)
        try? await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertEqual(transport(harness, accountA).calls.count, before,
                       "the loop went on talking to central after sign-out")
    }

    /// A policy change invalidates the pass that is running under the OLD answer.
    /// A delivery claimed while the policy said `auto` must not be allowed to
    /// finish writing after the user has said Off.
    func testAPolicyChangeCancelsTheGenerationItWasTakenUnder() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        try enable(harness, account: accountA, policy: .auto)
        try queueDelivery(harness, account: accountA)
        let transport = transport(harness, accountA)
        transport.blobGate.close()
        harness.controller.session(identity(accountA))

        await waitUntil({ transport.blobGate.isWaiting }, "the delivery never started streaming")
        harness.controller.setPolicy(.off)
        transport.blobGate.open()

        await waitUntil({ harness.controller.state == .disabled },
                        "the inbox did not settle on the user's new answer")
        XCTAssertTrue(harness.controller.results.isEmpty,
                      "a delivery taken under the old policy published a result under the new one")
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: harness.root.appendingPathComponent("a.txt").path),
            "a delivery taken under the old policy still wrote after the user switched Off")
    }

    /// Switching receiving Off TELLS central, once.
    ///
    /// Central keeps the last policy a device announced, so a Mac that simply
    /// stopped polling would still be offered to senders as a target: the send
    /// would be accepted, the task queued, and it would sit there until it
    /// expired. Announcing `off` makes central refuse the send outright, which is
    /// the truthful answer — and the announcement is not repeated on every idle
    /// tick, because a device that is off has nothing further to say.
    func testTurningReceivingOffAnnouncesItOnceRatherThanGoingQuiet() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        try enable(harness, account: accountA, policy: .auto)
        harness.controller.session(identity(accountA))
        await waitForSleep(harness, atLeast: 1)

        let transport = transport(harness, accountA)
        harness.controller.setPolicy(.off)
        await waitUntil({ transport.calls.contains(.offline) },
                        "switching off never reached central")
        XCTAssertTrue(transport.calls.contains(.enrol(autoAccept: .off, receiveDirReady: true)),
                      "central was not told the new policy, only that presence ended")

        // Several more idle ticks must not repeat it.
        for _ in 0..<3 {
            let before = harness.sleeper.delays.count
            harness.sleeper.wake()
            await waitForSleep(harness, atLeast: before + 1)
        }
        XCTAssertEqual(transport.calls.filter { $0 == .offline }.count, 1,
                       "an inbox that is off keeps talking to central")
        harness.controller.signedOut()
    }

    /// An offline transition must survive the lifecycle boundary that used to
    /// erase the in-memory retry bit. Otherwise central can keep advertising a
    /// Mac as automatic after the user has switched it off and quit the app.
    func testAnOfflineStopIsRetriedAfterSignOutAndSignIn() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        try enable(harness, account: accountA, policy: .auto)
        harness.controller.session(identity(accountA))
        await waitForSleep(harness, atLeast: 1)

        let watched = transport(harness, accountA)
        watched.enrolResult = .failure(InboxError.network)
        harness.controller.setPolicy(.off)
        await waitUntil({ harness.controller.state == .disabled },
                        "the local off answer did not settle")
        XCTAssertTrue(harness.store.stopAnnouncementPending(account: accountA),
                      "a failed stop was forgotten before it reached central")
        XCTAssertFalse(watched.calls.contains(.offline))

        harness.controller.signedOut()
        watched.enrolResult = .success(InboxEnrolResult(
            inbox: InboxView(presence: .offline, canReceive: false,
                             key: InboxKey(id: "key1", algorithm: InboxProtocol.keyAlgorithm,
                                           publicKey: InboxKeyMaterial.encode(
                                            harness.deviceKeys[accountA.value]!.publicKey),
                                           generation: 1, createdAt: 0,
                                           supersededAt: 0, revokedAt: 0)),
            protocolVersion: 3, receiveCapability: InboxCapability.receiveV3,
            keyAlgorithm: InboxProtocol.keyAlgorithm))
        harness.controller.session(identity(accountA))
        await waitUntil({ watched.calls.contains(.offline) },
                        "the relaunched account never retried its pending stop")
        XCTAssertFalse(harness.store.stopAnnouncementPending(account: accountA),
                       "a delivered stop remained pending and would repeat")
        harness.controller.signedOut()
    }

    /// The adversarial lifecycle case the acceptance contract names.
    ///
    /// A pass for account A is held open past its COMMIT — the files are on disk
    /// and a receipt exists — while A signs out and B signs in. When A finally
    /// completes, none of it may reach B: not the result row, not the
    /// notification, not the status.
    ///
    /// Mutating away either generation guard (the one in `pass()` or the one in
    /// `adopt`) makes this fail. Both are checked, because a single-guard
    /// mutation proves nothing where a second guard covers the same property
    /// (WORKFLOW-LEARNINGS, 2026-08-09).
    func testALateCompletionForTheOldAccountCannotTouchTheNewOne() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        try await seedKey(harness, account: accountB)
        try enable(harness, account: accountA, policy: .auto)
        try enable(harness, account: accountB, policy: .auto)
        try queueDelivery(harness, account: accountA)

        let transportA = transport(harness, accountA)
        // Held AFTER the commit: `deliver` has returned, the journal says
        // completed, and the receipt for A already exists inside the pass.
        transportA.reportGate.close()
        harness.controller.session(identity(accountA, bearer: "bearer-a"))
        await waitUntil({ transportA.reportGate.isWaiting },
                        "account A never reached its post-commit report")

        harness.controller.signedOut()
        harness.controller.session(identity(accountB, bearer: "bearer-b"))
        await waitForSleep(harness, atLeast: 1)
        let stateForB = harness.controller.state
        harness.notifier.clear()

        // A completes now, into a process that belongs to B.
        transportA.reportGate.open()
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertTrue(harness.controller.results.isEmpty,
                      "account A's delivery appeared in account B's result list")
        XCTAssertTrue(harness.notifier.delivered.isEmpty,
                      "account A's delivery raised a notification under account B")
        XCTAssertEqual(harness.controller.state, stateForB,
                      "account A's late pass moved account B's status")
        harness.controller.signedOut()
    }

    // MARK: - saved, and only from a commit

    /// `saved` is reachable only from a durable commit, and the receipt names
    /// exactly what was committed.
    func testSavedIsReachedOnlyFromADurableCommit() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        try enable(harness, account: accountA, policy: .auto)
        try queueDelivery(harness, account: accountA,
                          files: [("a.txt", [1, 2, 3]), ("b.txt", [4, 5])])
        harness.controller.session(identity(accountA))

        await waitUntil({ !harness.controller.results.isEmpty }, "no delivery completed")
        let receipt = try XCTUnwrap(harness.controller.results.first)
        XCTAssertEqual(receipt.fileCount, 2)
        XCTAssertEqual(receipt.byteCount, 5)
        XCTAssertFalse(receipt.isReplay)
        for url in receipt.urls {
            XCTAssertTrue(FileManager.default.fileExists(atPath: url.path),
                          "a receipt named a file that is not on disk")
            XCTAssertEqual(url.deletingLastPathComponent().standardizedFileURL.path,
                           harness.root.standardizedFileURL.path,
                           "a receipt named a path outside the user's receive folder")
        }
        XCTAssertEqual(harness.controller.state, .saved(files: 2))
        XCTAssertEqual(harness.notifier.delivered, [.saved(files: 2)])
        harness.controller.signedOut()
    }

    func testCompletedDeliveryIsGroupedByAuthenticatedSenderAndReplayStaysOneUnread() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        try enable(harness, account: accountA, policy: .auto)
        try queueDelivery(harness, account: accountA, taskID: "conversation-task")
        harness.controller.session(identity(accountA))

        await waitUntil({ harness.controller.conversations.first?.entries.count == 1 },
                        "conversation record was not published")
        let conversation = try XCTUnwrap(harness.controller.conversations.first)
        XCTAssertEqual(conversation.peerDeviceID, "sender-device")
        XCTAssertEqual(harness.controller.displayName(for: conversation), "Sender Mac")
        XCTAssertEqual(conversation.unreadCount, 1)
        XCTAssertEqual(harness.controller.activeAccountID, accountA.value)

        harness.controller.refreshConversations()
        XCTAssertEqual(harness.controller.conversations.first?.entries.count, 1)
        XCTAssertEqual(harness.controller.conversations.first?.unreadCount, 1)
        harness.controller.markConversationRead("sender-device")
        XCTAssertEqual(harness.controller.conversations.first?.unreadCount, 0)
        harness.controller.signedOut()
        XCTAssertTrue(harness.controller.conversations.isEmpty)
        XCTAssertNil(harness.controller.activeAccountID)
    }

    /// A MESSAGE reaches the model layer as a message: its own state, its own
    /// notification, and readable text in `messages`.
    ///
    /// The three assertions that make `inbox.text.v1` an honest claim rather than
    /// a token: the status is not "0 files saved", the banner carries no content,
    /// and the message itself can be read back — from the protected store, not
    /// from the receipt, which deliberately does not carry it.
    func testAMessageIsPresentedAsAMessage() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        try enable(harness, account: accountA, policy: .auto)
        try queueMessage(harness, account: accountA, text: "the door code is 4321")
        harness.controller.session(identity(accountA))

        await waitUntil({ !harness.controller.results.isEmpty }, "no delivery completed")
        let receipt = try XCTUnwrap(harness.controller.results.first)
        XCTAssertEqual(receipt.kind, .message)
        XCTAssertEqual(receipt.urls, [], "a message receipt named a path")
        XCTAssertEqual(harness.controller.state, .savedMessage)
        XCTAssertEqual(harness.notifier.delivered, [.savedMessage])
        XCTAssertEqual(harness.controller.messages.map(\.text), ["the door code is 4321"])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: harness.root.path)
            .filter { $0 != InboxDestinationPlan.stagingDirectoryName }, [],
                       "a message put something in the user's receive folder")
        harness.controller.signedOut()
        XCTAssertEqual(harness.controller.messages, [],
                       "another account's session could see these messages")
    }

    /// **The list the surface renders is newest first, and it still contains
    /// what was received years ago.**
    ///
    /// Two requirements in one drive, because they are one property from the
    /// reader's side: opening the Device Inbox shows the newest message at the
    /// top, and nothing has quietly gone missing underneath it. The ordering is
    /// the store's — `InboxMessageStore.all()` — and this asserts it survives
    /// the trip through the published property a view binds to, which is the
    /// only order a user ever sees.
    ///
    /// The two messages are committed straight into the store rather than
    /// delivered, for a reason the harness makes unavoidable: the receiver
    /// stamps its own clock, this harness pins that clock to one instant, and
    /// `receivedAt` is stored to the second — so two real deliveries would tie
    /// and the assertion would be about the tie-break rather than about the
    /// order. Committing gives the two the dates the requirement is stated in.
    func testTheMessageListIsNewestFirstAndKeepsWhatArrivedLongAgo() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        try enable(harness, account: accountA, policy: .auto)
        // A decade apart, and the older one far beyond the one-year cutoff this
        // store briefly had. Both must be here.
        try harness.messages.commit(id: "task1", text: "the door code is 4321",
                                    receivedAt: epoch.addingTimeInterval(-10 * 365 * 86_400))
        try harness.messages.commit(id: "task2", text: "running late", receivedAt: epoch)
        harness.controller.session(identity(accountA))

        await waitUntil({ harness.controller.messages.count == 2 },
                        "the messages were never read back from the store")
        XCTAssertEqual(harness.controller.messages.map(\.text),
                       ["running late", "the door code is 4321"],
                       "the message list is not newest first")
        // And an idle pass — the one that used to prune — leaves both alone.
        await waitUntil({ harness.controller.state == .ready(.auto) },
                        "the loop never completed an idle pass")
        harness.controller.refreshMessages()
        XCTAssertEqual(harness.controller.messages.count, 2,
                       "running the receive loop deleted a received message")
        harness.controller.signedOut()
    }

    /// A delivery whose commit did not happen produces no receipt, no
    /// notification and no saved claim — only an actionable blocker.
    func testAFailedDeliveryNeverProducesASavedClaim() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        try enable(harness, account: accountA, policy: .auto)
        try queueDelivery(harness, account: accountA)
        // Truncated ciphertext: authenticated frames stop short, so nothing
        // complete-looking may be left where the user would find it.
        let transport = transport(harness, accountA)
        transport.blobBody = transport.blobBody.prefix(transport.blobBody.count / 2)
        harness.controller.session(identity(accountA))

        await waitUntil({
            if case .attention(.delivery) = harness.controller.state { return true }
            return false
        }, "a failed delivery did not become an actionable blocker")
        XCTAssertTrue(harness.controller.results.isEmpty)
        XCTAssertFalse(harness.notifier.delivered.contains { if case .saved = $0 { return true }
                                                             else { return false } },
                       "a failed delivery announced a save")
        harness.controller.signedOut()
    }

    /// A `saved` report that never reached central is re-asserted on the next
    /// claim. The files did not arrive twice, so the user is not told they did.
    func testAReplayedCompletionUpdatesTheResultWithoutAnnouncingItAgain() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        try enable(harness, account: accountA, policy: .auto)
        try queueDelivery(harness, account: accountA)
        harness.controller.session(identity(accountA))
        await waitUntil({ !harness.controller.results.isEmpty }, "no delivery completed")
        XCTAssertEqual(harness.notifier.delivered.count, 1)

        // Central re-offers the same task: the journal already says completed, so
        // the receiver re-reports rather than re-delivering.
        let transport = transport(harness, accountA)
        transport.pendingResults = [.success([InboxTask(id: "task1", state: .queued)]),
                                    .success([])]
        harness.controller.retryNow()

        await waitUntil({ harness.controller.results.first?.isReplay == true },
                        "the replayed completion never reached the result list")
        XCTAssertEqual(harness.controller.results.count, 1,
                       "one delivery produced two result rows")
        XCTAssertEqual(harness.notifier.delivered.count, 1,
                       "a replayed completion raised a second notification")
        harness.controller.signedOut()
    }

    /// The relaunch case, which is the one the replay flag exists for.
    ///
    /// A fresh generation has an empty notification memory — exactly as a
    /// restarted app does — so the in-session task-id de-duplication cannot help
    /// here. What stops the second banner is that the receipt is built from a
    /// journal that ALREADY said completed, which is a durable record rather than
    /// a second one that could disagree with it.
    func testAReplayAfterARestartIsRecordedButNotAnnouncedAgain() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        try enable(harness, account: accountA, policy: .auto)
        try queueDelivery(harness, account: accountA)
        harness.controller.session(identity(accountA))
        await waitUntil({ !harness.controller.results.isEmpty }, "no delivery completed")

        // Sign out and back in: a new generation with no memory of what has been
        // announced, and an empty result list — the state a relaunch starts in.
        harness.controller.signedOut()
        harness.notifier.clear()
        let transport = transport(harness, accountA)
        transport.pendingResults = [.success([InboxTask(id: "task1", state: .queued)]),
                                    .success([])]
        harness.controller.session(identity(accountA))

        await waitUntil({ harness.controller.results.first?.isReplay == true },
                        "the completed delivery did not reappear after the restart")
        // The row belongs in the list — the files are real — but the CURRENT
        // status must not say a file just arrived. `results` and `state` are set
        // in one synchronous step, so this reads the decision the pass made.
        XCTAssertNotEqual(harness.controller.state, .saved(files: 1),
                          "an old delivery was re-dated to this moment as a fresh save")
        try? await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertTrue(harness.notifier.delivered.isEmpty,
                      "a delivery from before the restart was announced as if it were new")
        harness.controller.signedOut()
    }

    // MARK: - ask

    /// Under `ask`, central holds the task and this Mac claims nothing until a
    /// person answers. Nothing in the loop may answer for them.
    func testAskHoldsTheDeliveryUntilThePersonAnswers() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        try enable(harness, account: accountA, policy: .ask)
        let transport = transport(harness, accountA)
        // How central presents a held task: `attention_required` with NO error
        // code at all.
        transport.pendingResults = [.success([InboxTask(id: "held1", state: .attentionRequired)]),
                                    .success([])]
        transport.claimResult = .success((deliveries: [], leaseSeconds: 300))
        harness.controller.session(identity(accountA))

        await waitUntil({ harness.controller.asking.map(\.id) == ["held1"] },
                        "a held delivery never became a question")
        XCTAssertEqual(harness.controller.state, .asking(count: 1))
        XCTAssertFalse(transport.calls.contains(.accept(taskID: "held1", accept: true)),
                       "this Mac answered a question that was asked of its owner")

        harness.controller.respond(toAsk: "held1", accept: true)
        await waitUntil({ transport.calls.contains(.accept(taskID: "held1", accept: true)) },
                        "the explicit acceptance never reached central")
        XCTAssertTrue(harness.controller.asking.isEmpty)
        harness.controller.signedOut()
    }

    func testMultipleAskRowsKeepSafeDistinguishingMetadata() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        try enable(harness, account: accountA, policy: .ask)
        let transport = transport(harness, accountA)
        transport.pendingResults = [.success([
            InboxTask(id: "held1", state: .attentionRequired,
                      ciphertextBytes: 1_024, expiresAt: 1_700_001_000),
            InboxTask(id: "held2", state: .attentionRequired,
                      ciphertextBytes: 8_192, expiresAt: 1_700_002_000)
        ])]
        transport.claimResult = .success((deliveries: [], leaseSeconds: 300))
        harness.controller.session(identity(accountA))

        await waitUntil({ harness.controller.asking.count == 2 },
                        "two held deliveries did not become two questions")
        XCTAssertEqual(harness.controller.asking.map(\.id), ["held1", "held2"])
        XCTAssertEqual(harness.controller.asking.map(\.ciphertextBytes), [1_024, 8_192])
        XCTAssertEqual(harness.controller.asking.map(\.expiresAt),
                       [1_700_001_000, 1_700_002_000])
        harness.controller.signedOut()
    }

    func testDecliningSendsTheRefusalAndClearsTheQuestion() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        try enable(harness, account: accountA, policy: .ask)
        let transport = transport(harness, accountA)
        transport.pendingResults = [.success([InboxTask(id: "held1", state: .attentionRequired)])]
        transport.claimResult = .success((deliveries: [], leaseSeconds: 300))
        harness.controller.session(identity(accountA))
        await waitUntil({ harness.controller.asking.map(\.id) == ["held1"] },
                        "no question appeared")

        harness.controller.respond(toAsk: "held1", accept: false)
        await waitUntil({ transport.calls.contains(.accept(taskID: "held1", accept: false)) },
                        "the refusal never reached central")
        harness.controller.signedOut()
    }

    /// An answer that could not be delivered puts the question back. A device
    /// that silently dropped it would leave the sender waiting forever on an
    /// answer this Mac believes it gave.
    func testAnUndeliverableAnswerRestoresTheQuestion() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        try enable(harness, account: accountA, policy: .ask)
        let transport = transport(harness, accountA)
        transport.pendingResults = [.success([InboxTask(id: "held1", state: .attentionRequired)])]
        transport.claimResult = .success((deliveries: [], leaseSeconds: 300))
        transport.acceptResult = .failure(InboxError.network)
        harness.controller.session(identity(accountA))
        await waitUntil({ harness.controller.asking.map(\.id) == ["held1"] },
                        "no question appeared")

        harness.controller.respond(toAsk: "held1", accept: true)
        await waitUntil({ harness.controller.settingsError == .askResponseFailed },
                        "a failed answer was not reported")
        XCTAssertEqual(harness.controller.asking.map(\.id), ["held1"],
                       "a question this Mac failed to answer was dropped anyway")
        // The restored question and the failure have to be rendered together,
        // and `source` is what the two surfaces route on to do it: this refusal
        // came from Accept/Decline, not from any configuration control, so a
        // surface that files it with the settings puts it below everything
        // while the buttons that retry it are back at the top.
        XCTAssertEqual(try XCTUnwrap(harness.controller.settingsError).source, .pendingAnswer)

        // And pressing the restored button clears it before retrying, so the
        // recovery is the control itself rather than a separate dismiss.
        transport.acceptResult = .success(InboxTask(id: "held1", state: .queued))
        harness.controller.respond(toAsk: "held1", accept: true)
        XCTAssertNil(harness.controller.settingsError,
                     "the stale refusal outlived the retry that replaced it")
        harness.controller.signedOut()
    }

    /// Every settings error names the control that produced it. A new case that
    /// defaulted into `configuration` would render three sections away from the
    /// button the user pressed, which is the defect `source` exists to prevent —
    /// so this is exhaustive over `allCases` rather than a spot check.
    func testEverySettingsErrorNamesTheControlThatProducedIt() {
        XCTAssertEqual(InboxSettingsError.askResponseFailed.source, .pendingAnswer)
        XCTAssertEqual(InboxSettingsError.notificationSettingsUnavailable.source,
                       .notificationAccess)
        for error in InboxSettingsError.allCases
        where error != .askResponseFailed && error != .notificationSettingsUnavailable {
            XCTAssertEqual(error.source, .configuration,
                           "\(error.rawValue) is not a configuration control's refusal")
        }
        // Nothing is unroutable: every source is claimed by at least one error,
        // so a surface that renders one branch renders something real.
        for source in InboxSettingsErrorSource.allCases {
            XCTAssertTrue(InboxSettingsError.allCases.contains { $0.source == source },
                          "no error routes to \(source)")
        }
    }

    // MARK: - backoff, wake and recovery

    /// A failed pass backs off along a bounded curve, and an explicit user action
    /// wakes it immediately rather than waiting the interval out.
    func testAFailedPassBacksOffAndAnExplicitRetryWakesItAtOnce() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        try enable(harness, account: accountA, policy: .auto)
        let transport = transport(harness, accountA)
        transport.heartbeatResult = .failure(InboxError.network)
        harness.controller.session(identity(accountA))

        for expected in 1...3 {
            await waitForSleep(harness, atLeast: expected)
            if expected < 3 { harness.sleeper.wake() }
        }
        XCTAssertEqual(Array(harness.sleeper.delays.prefix(3)), [5, 10, 20],
                       "the failure backoff is not the bounded doubling curve")
        XCTAssertEqual(harness.controller.state, .offline(retryInSeconds: 20))

        // The wake, and the proof it is a wake rather than a no-op: the sleeper
        // is currently suspended, and `retryNow` releases it.
        XCTAssertTrue(harness.sleeper.isSleeping)
        harness.controller.retryNow()
        await waitUntil({ !harness.sleeper.isSleeping || harness.sleeper.delays.count >= 4 },
                        "an explicit retry did not end the backoff wait")
        harness.controller.signedOut()
    }

    /// A blocker that clears is noticed, and the state returns to ready without
    /// the user going back to Settings.
    func testAttentionRecoversOnceTheConditionClears() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        try enable(harness, account: accountA, policy: .auto)
        let transport = transport(harness, accountA)
        transport.heartbeatResult = .failure(InboxError.network)
        harness.controller.session(identity(accountA))
        await waitUntil({ if case .offline = harness.controller.state { return true }
                          return false }, "the outage was not reported")

        transport.heartbeatResult = .success(InboxHeartbeatResult(presence: .online))
        harness.controller.retryNow()
        await waitUntil({ harness.controller.state == .ready(.auto) },
                        "a cleared outage never returned to ready")
        harness.controller.signedOut()
    }

    /// Pause is the user's own answer and it is sticky: it survives passes, it
    /// survives a policy change, and only an explicit resume clears it.
    func testPauseIsStickyAcrossAPolicyChange() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        try enable(harness, account: accountA, policy: .auto)
        harness.controller.session(identity(accountA))
        await waitForSleep(harness, atLeast: 1)

        harness.controller.pause()
        XCTAssertEqual(harness.controller.state, .paused)
        harness.controller.setPolicy(.ask)
        await waitUntil({ harness.controller.state == .paused && harness.controller.policy == .ask },
                        "a policy change cleared an explicit pause")

        harness.controller.resume()
        await waitUntil({ harness.controller.state == .ready(.ask) },
                        "resume did not put the loop back to work")
        harness.controller.signedOut()
    }

    /// A paused inbox claims nothing.
    func testAPausedInboxClaimsNothing() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        try enable(harness, account: accountA, policy: .auto)
        harness.controller.session(identity(accountA))
        await waitForSleep(harness, atLeast: 1)
        harness.controller.pause()
        let before = transport(harness, accountA).calls.count
        try queueDelivery(harness, account: accountA)
        harness.controller.retryNow()
        try? await Task.sleep(nanoseconds: 40_000_000)

        XCTAssertEqual(transport(harness, accountA).calls.count, before,
                       "a paused inbox went on claiming")
        XCTAssertTrue(harness.controller.results.isEmpty)
        harness.controller.signedOut()
    }

    // MARK: - reveal

    /// Reveal is an explicit act, and it can only ever name paths from a
    /// completed local receipt this generation knows about.
    func testRevealOnlyEverShowsPathsFromAKnownCompletedReceipt() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        try enable(harness, account: accountA, policy: .auto)
        try queueDelivery(harness, account: accountA)
        harness.controller.session(identity(accountA))
        await waitUntil({ !harness.controller.results.isEmpty }, "no delivery completed")

        // A receipt this controller never issued, naming somewhere it never wrote.
        let forged = InboxReceipt(taskID: "forged", urls: [URL(fileURLWithPath: "/etc/passwd")],
                                  byteCount: 1, savedAt: epoch, isReplay: false)
        harness.controller.reveal(forged)
        XCTAssertTrue(harness.revealed.urls.isEmpty,
                      "an arbitrary path reached the Finder through Reveal")

        let real = try XCTUnwrap(harness.controller.results.first)
        harness.controller.reveal(real)
        XCTAssertEqual(harness.revealed.urls, [real.urls],
                       "Reveal did not show the committed paths")
        harness.controller.signedOut()
    }

    // MARK: - identity

    /// An account id this build will not use as a keychain item name or a
    /// defaults key fails closed, rather than proceeding under a sanitized guess
    /// at who the user is.
    func testAnUnusableAccountIdFailsClosed() async throws {
        let harness = try makeHarness()
        harness.controller.session(InboxAccountIdentity(accountID: "../../etc", bearer: "b"))
        XCTAssertEqual(harness.controller.state, .failed(.identity))
        XCTAssertFalse(harness.controller.isSignedIn)
    }

    /// The session mapping: exactly one state may receive.
    func testOnlyAReadySessionWithABearerProducesAnIdentity() throws {
        let user = try JSONDecoder().decode(NativeUser.self, from: Data("""
            {"id":"acct_1","email":"a@example.com","displayName":"","hasPassword":true,
            "emailVerified":true,"linkedMethods":["password"],"onlyOwnNodes":false,
            "planId":"free","subscriptionStatus":"none","subscriptionEnd":0,
            "hasBilling":false,"scheduledPlanId":"","scheduledCycle":"","billingCycle":""}
            """.utf8))
        let usage = try JSONDecoder().decode(UsageResponse.self, from: Data("""
            {"period":"202608","resetsAt":0,"traffic":{"used":0,"cap":1},
            "storage":{"used":0,"cap":1},"plan":{"id":"free","name":"Free","storageBytes":1,
            "trafficBytes":1,"retentionSecs":1,"priceMonthly":0,"priceYearly":0,"isTop":false,
            "subscriptionStatus":"none","subscriptionEnd":0,"billingCycle":"",
            "scheduledPlanId":"","scheduledPlanName":"","scheduledCycle":""}}
            """.utf8))
        let ready = SessionState.ready(user: user, usage: usage)
        XCTAssertEqual(InboxSessionBridge.identity(for: ready, bearer: "t")?.accountID, "acct_1")
        XCTAssertNil(InboxSessionBridge.identity(for: ready, bearer: nil),
                     "a ready account with no bearer cannot claim anything")
        XCTAssertNil(InboxSessionBridge.identity(for: ready, bearer: ""))
        for state: SessionState in [.loggedOut, .restoring, .authenticating, .registering,
                                    .unavailable(message: "offline"),
                                    .failed(message: "no"),
                                    .pendingDeletion(purgeAfter: 0, reactivateToken: "t"),
                                    .emailUnverified(email: "a@example.com")] {
            XCTAssertNil(InboxSessionBridge.identity(for: state, bearer: "t"),
                         "\(state) must not receive")
        }
    }

    // MARK: - check now

    private func count(_ transport: GatedInboxTransport,
                       _ matches: (FakeInboxTransport.Call) -> Bool) -> Int {
        transport.calls.filter(matches).count
    }

    private func heartbeats(_ transport: GatedInboxTransport) -> Int {
        count(transport) { if case .heartbeat = $0 { return true } else { return false } }
    }

    private func pendingReads(_ transport: GatedInboxTransport) -> Int {
        count(transport) { if case .pending = $0 { return true } else { return false } }
    }

    private func enrolments(_ transport: GatedInboxTransport) -> Int {
        count(transport) { if case .enrol = $0 { return true } else { return false } }
    }

    /// A sleeping, healthy inbox checks at once when asked, and an empty answer
    /// says nothing new rather than anything about a delivery.
    ///
    /// Two properties beyond "it woke": the loop was NOT restarted — a restart
    /// re-enrols, and a restart is what cancels a delivery in flight — and the
    /// wait after the check is the ordinary idle interval, so a check buys one
    /// pass and does not shorten the schedule after it.
    func testCheckNowWakesASleepingInboxWithoutRestartingIt() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        try enable(harness, account: accountA, policy: .auto)
        let transport = transport(harness, accountA)
        harness.controller.session(identity(accountA))
        await waitForSleep(harness, atLeast: 1)
        XCTAssertEqual(harness.controller.state, .ready(.auto))
        XCTAssertEqual(harness.sleeper.delays, [30])
        XCTAssertTrue(harness.controller.canCheckNow)

        XCTAssertTrue(harness.controller.checkNow())
        XCTAssertEqual(harness.controller.manualCheck, .checking)
        await waitUntil({ harness.controller.manualCheck == .nothingNew },
                        "a check of an empty inbox was never answered")
        await waitForSleep(harness, atLeast: 2)

        XCTAssertEqual(pendingReads(transport), 2, "the check did not read pending once")
        XCTAssertEqual(heartbeats(transport), 2)
        XCTAssertEqual(enrolments(transport), 1,
                       "check now restarted the generation instead of waking it")
        XCTAssertEqual(harness.sleeper.delays, [30, 30],
                       "a check changed the schedule after it")
        XCTAssertEqual(harness.controller.state, .ready(.auto))
        XCTAssertTrue(harness.controller.results.isEmpty,
                      "an empty check produced a result")
        XCTAssertTrue(harness.notifier.delivered.isEmpty,
                      "an empty check announced something")
        harness.controller.signedOut()
    }

    /// Pressed while a pass is already running — repeatedly — the check is
    /// answered by exactly ONE following pass, serially. The running pass is not
    /// cancelled and no second pass runs beside it.
    ///
    /// The wake here arrives while nothing is sleeping, which is the window the
    /// sleeper alone used to lose: this is the controller-level half of that fix.
    func testChecksDuringAPassCoalesceIntoOneFollowingPass() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        try enable(harness, account: accountA, policy: .auto)
        let transport = transport(harness, accountA)
        transport.pendingGate.close()
        harness.controller.session(identity(accountA))
        await waitUntil({ transport.pendingGate.isWaiting }, "the pass never reached pending")

        XCTAssertTrue(harness.controller.checkNow())
        XCTAssertTrue(harness.controller.checkNow())
        XCTAssertTrue(harness.controller.checkNow())
        XCTAssertEqual(harness.controller.manualCheck, .checking)
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(heartbeats(transport), 1,
                       "a check started a pass beside the one already running")

        transport.pendingGate.open()
        await waitUntil({ harness.controller.manualCheck == .nothingNew },
                        "the check was never answered by a following pass")
        await waitForSleep(harness, atLeast: 1)
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(heartbeats(transport), 2,
                       "three presses produced more than one extra pass")
        XCTAssertEqual(pendingReads(transport), 2)
        XCTAssertEqual(harness.sleeper.delays, [30],
                       "the loop slept between the running pass and the requested one")
        XCTAssertEqual(enrolments(transport), 1)
        harness.controller.signedOut()
    }

    /// Pressed during preparation, the check is answered by the first pass — it
    /// started after the press — and costs no extra pass at all.
    func testACheckDuringPreparationIsAnsweredByTheFirstPass() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        try enable(harness, account: accountA, policy: .auto)
        let transport = transport(harness, accountA)
        transport.enrolGate.close()
        harness.controller.session(identity(accountA))
        await waitUntil({ transport.enrolGate.isWaiting }, "preparation never started")
        XCTAssertEqual(harness.controller.state, .loading)

        XCTAssertTrue(harness.controller.checkNow())
        transport.enrolGate.open()
        await waitUntil({ harness.controller.manualCheck == .nothingNew },
                        "a check during preparation was never answered")
        await waitForSleep(harness, atLeast: 1)
        XCTAssertEqual(heartbeats(transport), 1, "a check during preparation added a pass")
        harness.controller.signedOut()
    }

    /// The same wake, through the PRODUCTION sleeper and real time.
    ///
    /// Repeated, because the window it covers is the hop between the loop
    /// deciding to sleep and the sleep registering, and a single press lands in
    /// it only sometimes. Each check must be answered well inside the 30 s idle
    /// interval; one lost wake would wait that interval out and fail the bound.
    func testEveryCheckIsAnsweredPromptlyThroughTheRealSleeper() async throws {
        let sleeper = InboxTaskSleeper()
        let harness = try makeHarness(sleeper: sleeper)
        try await seedKey(harness, account: accountA)
        try enable(harness, account: accountA, policy: .auto)
        let transport = transport(harness, accountA)
        harness.controller.session(identity(accountA))
        await waitUntil({ harness.controller.state == .ready(.auto) }, "never became ready")

        for round in 1...25 {
            XCTAssertTrue(harness.controller.checkNow())
            await waitUntil({ harness.controller.manualCheck == .nothingNew },
                            "check \(round) was lost")
            if harness.controller.manualCheck != .nothingNew { break }
        }
        XCTAssertEqual(heartbeats(transport), 26, "checks were not one pass each")
        harness.controller.signedOut()
    }

    /// **Nothing new means central listed nothing — not that nothing was claimed.**
    ///
    /// The engine returns `.idle` both for an empty pending list and for a
    /// non-empty one whose claim leased nothing (another worker took it, or it
    /// expired between the two calls), and the controller then publishes
    /// `ready`. That check SAW work, so "nothing new" would be false.
    func testACheckThatSawPendingWorkButClaimedNothingIsNotNothingNew() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        try enable(harness, account: accountA, policy: .auto)
        let transport = transport(harness, accountA)
        harness.controller.session(identity(accountA))
        await waitForSleep(harness, atLeast: 1)
        XCTAssertEqual(harness.controller.state, .ready(.auto))

        transport.pendingResults = [.success([InboxTask(id: "raced", state: .queued)])]
        transport.claimResult = .success((deliveries: [], leaseSeconds: 300))
        XCTAssertTrue(harness.controller.checkNow())
        await waitUntil({ harness.controller.manualCheck != .checking },
                        "the check was never answered")
        await waitForSleep(harness, atLeast: 2)

        XCTAssertTrue(transport.calls.contains(.claim(max: InboxProtocol.claimBatch)),
                      "the pass did not reach the claim this test is about")
        XCTAssertEqual(harness.controller.state, .ready(.auto))
        XCTAssertEqual(harness.controller.manualCheck, .checked,
                       "a check that listed pending work reported nothing new")
        XCTAssertTrue(harness.controller.results.isEmpty, "an unclaimed task produced a result")
        XCTAssertTrue(harness.notifier.delivered.isEmpty)
        harness.controller.signedOut()
    }

    /// **A check pressed during a real download is serialized behind it.**
    ///
    /// The pass is held inside the ciphertext stream — past the claim, with the
    /// lease taken — which is exactly where a restart would cancel the transfer.
    /// Repeated presses there must not restart the generation, must not start a
    /// second pass, and must leave the delivery to finish and be receipted
    /// exactly once. The check is then answered by the one pass that follows.
    func testACheckDuringAnActualDownloadIsSerializedAndTheDeliveryLandsOnce() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        try enable(harness, account: accountA, policy: .auto)
        try queueDelivery(harness, account: accountA)
        let transport = transport(harness, accountA)
        transport.blobGate.close()
        harness.controller.session(identity(accountA))
        await waitUntil({ transport.blobGate.isWaiting }, "the download never started")
        await waitUntil({ harness.controller.state == .working }, "the download was not shown")

        XCTAssertTrue(harness.controller.canCheckNow)
        XCTAssertTrue(harness.controller.checkNow())
        XCTAssertTrue(harness.controller.checkNow())
        XCTAssertEqual(harness.controller.manualCheck, .checking)
        try? await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertEqual(heartbeats(transport), 1, "a check started a pass beside the download")
        XCTAssertEqual(enrolments(transport), 1, "a check restarted the receiver mid-download")
        XCTAssertEqual(harness.controller.state, .working, "a check interrupted the download")

        transport.blobGate.open()
        await waitUntil({ harness.controller.manualCheck == .nothingNew },
                        "the follow-up check was never answered")
        await waitForSleep(harness, atLeast: 1)
        try? await Task.sleep(nanoseconds: 20_000_000)

        let saved = transport.calls.filter {
            if case .report(_, .saved, _, _) = $0 { return true } else { return false }
        }
        XCTAssertEqual(saved.count, 1, "the delivery was not reported saved exactly once")
        XCTAssertEqual(transport.calls.filter { if case .claim = $0 { return true }
                                                return false }.count, 1,
                       "the follow-up check claimed again")
        XCTAssertEqual(harness.controller.results.map(\.taskID), ["task1"],
                       "the delivery was not receipted exactly once")
        XCTAssertEqual(harness.notifier.delivered, [.saved(files: 1)])
        XCTAssertEqual(heartbeats(transport), 2, "two presses produced more than one extra pass")
        XCTAssertEqual(enrolments(transport), 1)
        XCTAssertEqual(harness.sleeper.delays, [30],
                       "the loop slept between the download and the requested check")
        XCTAssertEqual(try Data(contentsOf: harness.root.appendingPathComponent("a.txt")),
                       Data([1, 2, 3]), "the delivery did not land intact")
        harness.controller.signedOut()
    }

    /// A check that finds a delivery says only that the check completed; the
    /// saved claim is the status line's, from the durable receipt. Once the loop
    /// moves on, the answer is withdrawn rather than left describing the past.
    func testACheckThatFindsADeliveryDefersToTheReceipt() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        try enable(harness, account: accountA, policy: .auto)
        harness.controller.session(identity(accountA))
        await waitForSleep(harness, atLeast: 1)

        try queueDelivery(harness, account: accountA)
        XCTAssertTrue(harness.controller.checkNow())
        await waitUntil({ harness.controller.manualCheck == .checked },
                        "a check that worked a delivery was not answered")
        XCTAssertEqual(harness.controller.state, .saved(files: 1))
        XCTAssertEqual(harness.controller.results.count, 1)
        await waitForSleep(harness, atLeast: 2)
        XCTAssertEqual(harness.sleeper.delays.last, 2, "after work the schedule is unchanged")

        harness.sleeper.wake()
        await waitUntil({ harness.controller.state == .ready(.auto) },
                        "the loop did not return to ready")
        XCTAssertEqual(harness.controller.manualCheck, .none,
                       "a check answer outlived the state it described")
        harness.controller.signedOut()
    }

    /// A check whose pass fails says so, keeps the bounded backoff, and does not
    /// turn a failing central into a busy loop.
    func testAFailedCheckSaysSoAndKeepsTheBackoff() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        try enable(harness, account: accountA, policy: .auto)
        let transport = transport(harness, accountA)
        harness.controller.session(identity(accountA))
        await waitForSleep(harness, atLeast: 1)

        transport.heartbeatResult = .failure(InboxError.network)
        XCTAssertTrue(harness.controller.checkNow())
        await waitUntil({ harness.controller.manualCheck == .failed },
                        "a failed check was not reported")
        XCTAssertEqual(harness.controller.state, .offline(retryInSeconds: 5))
        await waitForSleep(harness, atLeast: 2)
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(harness.sleeper.delays, [30, 5])
        XCTAssertEqual(heartbeats(transport), 2, "a failed check spun")
        // Offline is a problem state with its own Try again, so the surface does
        // not offer a second button beside it.
        XCTAssertFalse(InboxManualCheckPresentation.offersCheck(in: harness.controller.state))
        harness.controller.signedOut()
    }

    /// A failure BEFORE the pass — here, enrolment — answers the check as failed
    /// and backs off along the same curve rather than retrying at once.
    func testAFailureDuringPreparationAnswersTheCheckWithoutSpinning() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        try enable(harness, account: accountA, policy: .auto)
        let transport = transport(harness, accountA)
        let working = transport.enrolResult
        transport.enrolResult = .failure(InboxError.network)
        harness.controller.session(identity(accountA))
        await waitForSleep(harness, atLeast: 1)
        XCTAssertEqual(harness.sleeper.delays, [5])

        XCTAssertTrue(harness.controller.checkNow())
        await waitUntil({ harness.controller.manualCheck == .failed },
                        "a check whose preparation failed was not answered")
        await waitForSleep(harness, atLeast: 2)
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(harness.sleeper.delays, [5, 10], "the failed check reset or skipped backoff")
        XCTAssertEqual(enrolments(transport), 2)
        transport.enrolResult = working
        harness.controller.signedOut()
    }

    /// Under Ask, a check refreshes the questions and answers none of them —
    /// with SEVERAL held, which is where a check that accepted "the pending
    /// work" would do the most damage.
    func testACheckUnderAskAnswersNoQuestion() async throws {
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        try enable(harness, account: accountA, policy: .ask)
        let transport = transport(harness, accountA)
        transport.pendingResults = [.success([
            InboxTask(id: "held1", state: .attentionRequired, ciphertextBytes: 1_024),
            InboxTask(id: "held2", state: .attentionRequired, ciphertextBytes: 8_192),
            InboxTask(id: "held3", state: .attentionRequired, ciphertextBytes: 4_096)
        ])]
        transport.claimResult = .success((deliveries: [], leaseSeconds: 300))
        harness.controller.session(identity(accountA))
        await waitUntil({ harness.controller.asking.count == 3 }, "no questions appeared")
        await waitForSleep(harness, atLeast: 1)

        XCTAssertTrue(harness.controller.canCheckNow)
        XCTAssertTrue(harness.controller.checkNow())
        await waitUntil({ harness.controller.manualCheck == .checked },
                        "a check with held deliveries was not answered")
        XCTAssertNotEqual(harness.controller.manualCheck, .nothingNew,
                          "held deliveries were reported as nothing new")
        XCTAssertEqual(harness.controller.state, .asking(count: 3))
        XCTAssertEqual(harness.controller.asking.map(\.id), ["held1", "held2", "held3"])
        XCTAssertFalse(transport.calls.contains {
            if case .accept = $0 { return true } else { return false }
        }, "a check answered a question that was asked of the owner")
        XCTAssertTrue(harness.controller.results.isEmpty)
        XCTAssertTrue(transport.calls.filter { if case .blob = $0 { return true }
                                               return false }.isEmpty,
                      "a check downloaded a held delivery")
        harness.controller.signedOut()
    }

    /// Every gate the loop applies, the check applies too — and a refused check
    /// neither shows as checking nor talks to central.
    func testCheckNowIsRefusedWhereverTheLoopWouldNotReceive() async throws {
        // Off.
        do {
            let harness = try makeHarness()
            try await seedKey(harness, account: accountA)
            harness.controller.session(identity(accountA))
            await waitForSleep(harness, atLeast: 1)
            XCTAssertFalse(harness.controller.canCheckNow)
            XCTAssertFalse(harness.controller.checkNow())
            XCTAssertEqual(harness.controller.manualCheck, .none)
            try? await Task.sleep(nanoseconds: 20_000_000)
            XCTAssertTrue(transport(harness, accountA).calls.isEmpty, "an Off inbox checked")
            harness.controller.signedOut()
        }
        // On, with no folder.
        do {
            let harness = try makeHarness()
            try await seedKey(harness, account: accountA)
            harness.store.setReceivePolicy(.auto, account: accountA)
            harness.controller.session(identity(accountA))
            await waitForSleep(harness, atLeast: 1)
            XCTAssertEqual(harness.controller.state, .folderMissing)
            XCTAssertFalse(harness.controller.checkNow())
            XCTAssertEqual(harness.controller.manualCheck, .none)
            harness.controller.signedOut()
        }
        // Paused, in the background, signed out, and stopped for good.
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        try enable(harness, account: accountA, policy: .auto)
        let transport = transport(harness, accountA)
        harness.controller.session(identity(accountA))
        await waitForSleep(harness, atLeast: 1)

        harness.controller.pause()
        let beforePause = transport.calls.count
        XCTAssertFalse(harness.controller.checkNow())
        XCTAssertEqual(harness.controller.manualCheck, .none)
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(transport.calls.count, beforePause, "a paused inbox checked")
        harness.controller.resume()
        await waitUntil({ harness.controller.state == .ready(.auto) }, "resume did not recover")

        harness.controller.foreground(false)
        XCTAssertFalse(harness.controller.checkNow(), "a backgrounded inbox accepted a check")
        harness.controller.foreground(true)
        await waitUntil({ harness.controller.state == .ready(.auto) }, "foreground did not recover")

        transport.enrolResult = .failure(InboxEnrolment.Failure.registrationMismatch)
        harness.controller.retryNow()
        await waitUntil({ harness.controller.state == .failed(.enrolmentRefused) },
                        "the refusal did not stop the loop")
        XCTAssertFalse(harness.controller.checkNow(),
                       "a stopped loop accepted a check it will never answer")

        harness.controller.signedOut()
        XCTAssertFalse(harness.controller.checkNow())
    }

    /// Withdrawn, not answered, when something stops it: a pause, a policy
    /// change, a sign-out, or another account. The pass that was running must
    /// not answer for a generation it no longer belongs to.
    func testAnOutstandingCheckIsWithdrawnByEveryStopAndNeverAnsweredLate() async throws {
        // Pause while the check is outstanding.
        do {
            let harness = try makeHarness()
            try await seedKey(harness, account: accountA)
            try enable(harness, account: accountA, policy: .auto)
            let transport = transport(harness, accountA)
            harness.controller.session(identity(accountA))
            await waitForSleep(harness, atLeast: 1)
            transport.pendingGate.close()
            XCTAssertTrue(harness.controller.checkNow())
            await waitUntil({ transport.pendingGate.isWaiting }, "the check never ran")
            harness.controller.pause()
            XCTAssertEqual(harness.controller.manualCheck, .none)
            transport.pendingGate.open()
            await waitForSleep(harness, atLeast: 2)
            XCTAssertEqual(harness.controller.state, .paused)
            XCTAssertEqual(harness.controller.manualCheck, .none,
                           "a paused inbox reported the answer to a withdrawn check")
            harness.controller.signedOut()
        }
        // Policy switched Off mid-check.
        do {
            let harness = try makeHarness()
            try await seedKey(harness, account: accountA)
            try enable(harness, account: accountA, policy: .auto)
            let transport = transport(harness, accountA)
            harness.controller.session(identity(accountA))
            await waitForSleep(harness, atLeast: 1)
            transport.pendingGate.close()
            XCTAssertTrue(harness.controller.checkNow())
            await waitUntil({ transport.pendingGate.isWaiting }, "the check never ran")
            harness.controller.setPolicy(.off)
            XCTAssertEqual(harness.controller.manualCheck, .none)
            transport.pendingGate.open()
            await waitUntil({ harness.controller.state == .disabled }, "Off did not settle")
            XCTAssertEqual(harness.controller.manualCheck, .none)
            harness.controller.signedOut()
        }
        // Account switch mid-check: account A's pass returns under account B.
        let harness = try makeHarness()
        try await seedKey(harness, account: accountA)
        try await seedKey(harness, account: accountB)
        try enable(harness, account: accountA, policy: .auto)
        let transportA = transport(harness, accountA)
        harness.controller.session(identity(accountA))
        await waitForSleep(harness, atLeast: 1)
        transportA.pendingGate.close()
        XCTAssertTrue(harness.controller.checkNow())
        await waitUntil({ transportA.pendingGate.isWaiting }, "the check never ran")

        harness.controller.session(identity(accountB, bearer: "bearer-b"))
        XCTAssertEqual(harness.controller.manualCheck, .none)
        transportA.pendingGate.open()
        await waitUntil({ harness.controller.state == .disabled },
                        "account B did not settle on its own answer")
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(harness.controller.manualCheck, .none,
                       "account A's check was answered under account B")
        harness.controller.signedOut()
        XCTAssertEqual(harness.controller.manualCheck, .none)
    }

    // MARK: - helpers

    private func enable(_ harness: Harness, account: InboxAccountID,
                        policy: InboxAutoAccept) throws {
        try harness.folder.chooseFolder(harness.root, account: account)
        try harness.folder.setReceivePolicy(policy, account: account)
    }
}

// MARK: - doubles

/// A sleeper that never sleeps and never returns until a test says so.
final class ManualInboxSleeper: InboxSleeping, @unchecked Sendable {
    private let lock = NSLock()
    private var _delays: [TimeInterval] = []
    private var waiters: [CheckedContinuation<Void, Never>] = []

    var delays: [TimeInterval] { sync { _delays } }
    var isSleeping: Bool { sync { !waiters.isEmpty } }

    func sleep(_ seconds: TimeInterval) async {
        await withCheckedContinuation { continuation in
            record(seconds, continuation)
        }
    }

    func wake() {
        for waiter in take() { waiter.resume() }
    }

    private func record(_ seconds: TimeInterval,
                        _ continuation: CheckedContinuation<Void, Never>) {
        lock.lock(); defer { lock.unlock() }
        _delays.append(seconds)
        waiters.append(continuation)
    }

    private func take() -> [CheckedContinuation<Void, Never>] {
        lock.lock(); defer { lock.unlock() }
        let held = waiters
        waiters = []
        return held
    }

    private func sync<T>(_ body: () -> T) -> T {
        lock.lock(); defer { lock.unlock() }
        return body()
    }
}

/// A gate a test can hold a pass open on, at a chosen point in the protocol.
final class InboxGate: @unchecked Sendable {
    private let lock = NSLock()
    private var isOpen = true
    private var waiting = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []

    var isWaiting: Bool { sync { waiting > 0 } }

    func close() { sync { isOpen = false } }

    func open() {
        let held: [CheckedContinuation<Void, Never>] = sync {
            isOpen = true
            let all = waiters
            waiters = []
            waiting = 0
            return all
        }
        for waiter in held { waiter.resume() }
    }

    func pass() async {
        let shouldWait: Bool = sync {
            if isOpen { return false }
            waiting += 1
            return true
        }
        guard shouldWait else { return }
        await withCheckedContinuation { continuation in
            let resumeNow: Bool = sync {
                if isOpen { return true }
                waiters.append(continuation)
                return false
            }
            if resumeNow { continuation.resume() }
        }
    }

    private func sync<T>(_ body: () -> T) -> T {
        lock.lock(); defer { lock.unlock() }
        return body()
    }
}

/// `FakeInboxTransport` with three gates, so a pass can be suspended before the
/// pending read, mid-download, or after the commit but before its report.
final class GatedInboxTransport: FakeInboxTransport, @unchecked Sendable {
    let enrolGate = InboxGate()
    let pendingGate = InboxGate()
    let blobGate = InboxGate()
    let reportGate = InboxGate()

    override func enrol(_ request: InboxEnrolRequest) async throws -> InboxEnrolResult {
        await enrolGate.pass()
        return try await super.enrol(request)
    }

    override func pending(limit: Int) async throws -> [InboxTask] {
        await pendingGate.pass()
        return try await super.pending(limit: limit)
    }

    override func blob(taskID: String, claimToken: String,
                       offset: Int64) async throws -> InboxBlobStream {
        await blobGate.pass()
        return try await super.blob(taskID: taskID, claimToken: claimToken, offset: offset)
    }

    override func report(taskID: String, claimToken: String, state: InboxTaskState,
                         errorCode: InboxDeviceErrorCode,
                         committed: Bool) async throws -> InboxTask {
        await reportGate.pass()
        return try await super.report(taskID: taskID, claimToken: claimToken, state: state,
                                      errorCode: errorCode, committed: committed)
    }
}

final class RecordingInboxNotifier: InboxNotifying, @unchecked Sendable {
    private let lock = NSLock()
    private var _delivered: [InboxNotification] = []
    var delivered: [InboxNotification] { sync { _delivered } }
    func deliver(_ notification: InboxNotification) { sync { _delivered.append(notification) } }
    func clear() { sync { _delivered = [] } }
    private func sync<T>(_ body: () -> T) -> T {
        lock.lock(); defer { lock.unlock() }
        return body()
    }
}

final class RevealRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var _urls: [[URL]] = []
    var urls: [[URL]] { lock.lock(); defer { lock.unlock() }; return _urls }
    func record(_ batch: [URL]) { lock.lock(); _urls.append(batch); lock.unlock() }
}

private struct ControllerBookmarking: InboxFolderBookmarking {
    let url: URL
    func bookmark(for url: URL) throws -> Data { Data(url.path.utf8) }
    func resolve(_ data: Data) throws -> (url: URL, isStale: Bool) { (url, false) }
    func startAccess(to url: URL) -> Bool { true }
    func stopAccess(to url: URL) {}
}

private struct UnresolvableBookmarking: InboxFolderBookmarking {
    func bookmark(for url: URL) throws -> Data { Data("x".utf8) }
    func resolve(_ data: Data) throws -> (url: URL, isStale: Bool) {
        throw InboxFolderError.bookmarkFailed
    }
    func startAccess(to url: URL) -> Bool { false }
    func stopAccess(to url: URL) {}
}
