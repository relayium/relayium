import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// One pass of the receive loop: what it announces, what it refuses to claim, and
/// what it tells central afterwards.
///
/// The claims worth checking here are all about ORDER and ABSENCE — a heartbeat
/// that carries the folder verdict measured in THIS pass, a claim that never
/// happens when the folder is unusable, a `saved` that is only ever reached
/// through `verifying`, a report that never happens after an abandon. Each of
/// those is asserted against the transport's complete call record.
final class InboxReceiveEngineTests: XCTestCase {

    private let account = try! InboxAccountID("accountengine001")
    private let epoch = Date(timeIntervalSince1970: 1_700_000_000)

    private struct Harness {
        let transport: FakeInboxTransport
        let keys: InMemoryInboxDeviceKeyStore
        let journals: InboxJournalStore
        let store: InMemoryInboxFolderStore
        let folder: InboxReceiveFolder
        let root: URL
        let deviceKey: InboxDeviceKeyPair
    }

    private func harness(withFolder: Bool = true,
                         automatic: Bool = true) async throws -> Harness {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("relayium-engine-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let journalDirectory = root.appendingPathExtension("journals")
        addTeardownBlock {
            try? FileManager.default.removeItem(at: root)
            try? FileManager.default.removeItem(at: journalDirectory)
        }

        let store = InMemoryInboxFolderStore()
        let folder = InboxReceiveFolder(store: store,
                                        bookmarking: PassthroughBookmarking(url: root))
        if withFolder {
            try folder.chooseFolder(root, account: account)
            if automatic { try folder.setAutomaticReceive(true, account: account) }
        }

        let keys = InMemoryInboxDeviceKeyStore()
        let deviceKey = try InboxKeyMaterial.generateKeyPair()
        _ = try await keys.append(deviceKey, account: account, now: epoch)
        try await keys.bind(publicKey: InboxKeyMaterial.encode(deviceKey.publicKey),
                            keyID: "key1", generation: 1, account: account)

        return Harness(transport: FakeInboxTransport(), keys: keys,
                       journals: InboxJournalStore(directory: journalDirectory),
                       store: store, folder: folder, root: root, deviceKey: deviceKey)
    }

    private func engine(_ h: Harness, log: InboxLog? = nil,
                        freeBytes: (@Sendable (URL) -> Int64?)? = nil) -> InboxReceiveEngine {
        let epoch = self.epoch
        return InboxReceiveEngine(transport: h.transport, keys: h.keys, journals: h.journals,
                                  folder: h.folder, account: account, now: { epoch }, log: log,
                                  renewInterval: 3600, streamAttempts: 3,
                                  freeBytes: freeBytes ?? InboxSpace.freeBytes)
    }

    private func claim(_ h: Harness, files: [(String, [UInt8])] = [("a.txt", [1, 2, 3])])
        throws -> InboxDelivery {
        let built = try InboxFixture.delivery(files: files, deviceKey: h.deviceKey)
        h.transport.blobBody = built.ciphertext
        h.transport.pendingResults = [.success([built.delivery.task])]
        h.transport.claimResult = .success((deliveries: [built.delivery], leaseSeconds: 300))
        return built.delivery
    }

    private func reports(_ h: Harness) -> [(InboxTaskState, InboxDeviceErrorCode, Bool)] {
        h.transport.calls.compactMap { call in
            if case .report(_, let state, let code, let committed) = call {
                return (state, code, committed)
            }
            return nil
        }
    }

    // MARK: - what this Mac announces

    /// A device that announces `off` makes central refuse task creation outright.
    /// That is the truthful answer: queuing a task this Mac will never take would
    /// be a lie in the sender's UI.
    func testTheAnnouncedPolicyIsOffUntilAutomaticReceiveIsEnabled() async throws {
        let h = try await harness(automatic: false)
        XCTAssertEqual(engine(h).announcedPolicy, .off)
        try h.folder.setAutomaticReceive(true, account: account)
        XCTAssertEqual(engine(h).announcedPolicy, .auto)
    }

    /// An ENABLED device with a broken folder still announces `auto` and reports
    /// `receiveDirReady: false`, so central starts the task in
    /// `attention_required` — "something is wrong with the folder", not "this Mac
    /// does not do this".
    func testAnEnabledDeviceWithABrokenFolderStillAnnouncesAuto() async throws {
        let h = try await harness()
        try FileManager.default.removeItem(at: h.root)
        XCTAssertEqual(engine(h).announcedPolicy, .auto)

        _ = try? await engine(h).pass()
        XCTAssertEqual(h.transport.calls.first, .heartbeat(receiveDirReady: false))
    }

    func testEnrolmentCarriesThePolicyAndTheProbedFolder() async throws {
        let h = try await harness()
        h.transport.enrolResult = .success(InboxEnrolResult(
            inbox: InboxView(key: InboxKey(id: "key1", algorithm: InboxProtocol.keyAlgorithm,
                                           publicKey: InboxKeyMaterial.encode(h.deviceKey.publicKey),
                                           generation: 1)),
            protocolVersion: 1, receiveCapability: InboxCapability.receiveV1,
            keyAlgorithm: InboxProtocol.keyAlgorithm))

        _ = try await engine(h).prepare(platform: "darwin", appVersion: "1.0")
        XCTAssertEqual(h.transport.calls.first, .enrol(autoAccept: .auto, receiveDirReady: true))
    }

    // MARK: - no folder, no claim

    /// The single gate the whole receive path rests on. Claiming into a folder
    /// that just failed its probe would take a lease this Mac cannot honour and
    /// leave the sender watching a task that is not progressing.
    func testNoUsableFolderMeansNoClaimAtAll() async throws {
        for h in [try await harness(withFolder: false), try await harness()] {
            if h.store.bookmarkData(account: account) != nil {
                try FileManager.default.removeItem(at: h.root)   // grant resolves nowhere
            }
            _ = try await claim(h)
            let result = try await engine(h).pass()

            guard case .notReceiving = result else {
                return XCTFail("a pass claimed work with no usable folder: \(result)")
            }
            XCTAssertFalse(h.transport.calls.contains { if case .claim = $0 { return true }; return false },
                           "work was claimed into an unusable folder")
            XCTAssertFalse(h.transport.calls.contains { if case .pending = $0 { return true }; return false },
                           "a device that cannot receive still polled for work")
        }
    }

    /// Presence is a claim about NOW, and it carries the verdict measured in this
    /// pass — a real create-and-remove probe, not an inspection of permission bits.
    func testTheHeartbeatCarriesThisPassesOwnFolderVerdict() async throws {
        let h = try await harness()
        _ = try await engine(h).pass()
        XCTAssertEqual(h.transport.calls.first, .heartbeat(receiveDirReady: true))
    }

    // MARK: - a worked delivery

    func testAWorkedDeliveryReachesSavedOnlyThroughVerifying() async throws {
        let h = try await harness()
        _ = try await claim(h)

        let result = try await engine(h).pass()

        XCTAssertEqual(result, .worked)
        XCTAssertEqual(reports(h).map(\.0), [.verifying, .verifying, .saved])
        XCTAssertEqual(reports(h).last?.2, true, "`saved` was reported without the commit assertion")
        XCTAssertEqual(try Data(contentsOf: h.root.appendingPathComponent("a.txt")),
                       Data([1, 2, 3]))
    }

    /// One task per pass. A second claimed before the first finishes could have its
    /// lease expire without ever starting, because deliveries are worked
    /// sequentially and their sizes are unbounded until TTL.
    func testAPassClaimsExactlyOneTask() async throws {
        let h = try await harness()
        _ = try await claim(h)
        _ = try await engine(h).pass()
        XCTAssertEqual(h.transport.calls.filter { $0 == .claim(max: 1) }.count, 1)
        XCTAssertFalse(h.transport.calls.contains { call in
            if case .claim(let max) = call { return max != 1 }
            return false
        })
    }

    /// Pending said there was work but the claim leased none: another worker took
    /// it, or it expired between the two calls. Not an error.
    func testAClaimThatLeasesNothingIsIdleRatherThanAFailure() async throws {
        let h = try await harness()
        h.transport.pendingResults = [.success([InboxTask(id: "t1", state: .queued)])]
        h.transport.claimResult = .success((deliveries: [], leaseSeconds: 300))
        let result = try await engine(h).pass()
        XCTAssertEqual(result, .idle)
    }

    func testAnEmptyQueuePrunesReceiptsAndReportsIdle() async throws {
        let h = try await harness()
        var old = InboxJournal(taskID: "oldtask", storedFileID: "o", targetKeyID: "key1",
                               root: h.root.path, plan: [], plannedAt: 1)
        old.isCompleted = true
        old.isSavedReported = true
        try h.journals.save(&old, now: epoch.addingTimeInterval(-InboxJournalStore.retention - 60))

        let result = try await engine(h).pass()
        XCTAssertEqual(result, .idle)
        XCTAssertNil(try h.journals.load("oldtask"))
    }

    // MARK: - failure reporting

    func testALocalBlockerIsReportedWithItsTruthfulCodeAndState() async throws {
        let h = try await harness()
        _ = try await claim(h)
        // The race the no-overwrite design exists for: the plan is already
        // journalled, and a file appears at its destination afterwards. Planting
        // the file BEFORE the plan would only exercise the collision suffix, which
        // is a success, not a blocker.
        var journal = InboxJournal(
            taskID: "task1", storedFileID: "obj1", targetKeyID: "key1",
            root: h.root.standardizedFileURL.path,
            plan: [InboxPlanEntry(index: 0, name: "a.txt", size: 3,
                                  destination: h.root.appendingPathComponent("a.txt").path)],
            plannedAt: 1)
        try h.journals.save(&journal, now: epoch)
        try Data("mine".utf8).write(to: h.root.appendingPathComponent("a.txt"))

        let result = try await engine(h).pass()

        XCTAssertEqual(result, .worked)
        XCTAssertEqual(reports(h).last?.0, .attentionRequired)
        XCTAssertEqual(reports(h).last?.1, .nameConflict)
        XCTAssertEqual(try Data(contentsOf: h.root.appendingPathComponent("a.txt")),
                       Data("mine".utf8))
    }

    /// Central already took the task away, so a report would be a stale worker
    /// asserting something about work it no longer holds. Silence is the only safe
    /// response.
    func testAnAbandonedTaskIsNeverReported() async throws {
        let h = try await harness()
        _ = try await claim(h)
        h.transport.blobError = InboxError.api(status: 409, code: "stale_claim")

        _ = try await engine(h).pass()

        XCTAssertTrue(reports(h).isEmpty, "an abandoned task was reported: \(reports(h))")
    }

    /// The files ARE on disk. A lost `saved` response is retried from the journal
    /// on the next claim, never by re-delivering.
    func testALostSavedReportLeavesTheReceiptUnacknowledgedForARetry() async throws {
        let h = try await harness()
        _ = try await claim(h)
        h.transport.reportErrors[.saved] = [InboxError.network]

        _ = try await engine(h).pass()

        let journal = try XCTUnwrap(try h.journals.load("task1"))
        XCTAssertTrue(journal.isCompleted)
        XCTAssertFalse(journal.isSavedReported)
        XCTAssertEqual(try Data(contentsOf: h.root.appendingPathComponent("a.txt")),
                       Data([1, 2, 3]))
    }

    /// Central already recorded the outcome — this is the retry converging. The
    /// receipt is acknowledged rather than retried forever.
    func testATerminalTaskOnTheSavedReportConvergesRatherThanRetrying() async throws {
        let h = try await harness()
        _ = try await claim(h)
        h.transport.reportErrors[.saved] = [InboxError.api(status: 409, code: "task_terminal")]

        _ = try await engine(h).pass()

        XCTAssertTrue(try XCTUnwrap(try h.journals.load("task1")).isSavedReported)
    }

    /// The duplicate-delivery case end to end: a second pass over a task this Mac
    /// already committed re-reports rather than re-downloading, and the file is not
    /// written twice.
    func testASecondPassOverACommittedTaskReReportsWithoutRedelivering() async throws {
        let h = try await harness()
        _ = try await claim(h)
        _ = try await engine(h).pass()
        let after = try FileManager.default.contentsOfDirectory(atPath: h.root.path).sorted()

        // Central lost the report and hands the task back.
        let secondTransport = h.transport
        secondTransport.blobBody = Data()          // a re-download would fail loudly
        _ = try await engine(h).pass()

        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: h.root.path).sorted(),
                       after)
        XCTAssertEqual(reports(h).filter { $0.0 == .saved }.count, 2,
                       "the second pass did not re-assert the commit")
    }

    // MARK: - recovery

    /// A local blocker that has cleared is re-queued by THIS device. A task held
    /// under the `ask` policy carries no error code at all and is untouched:
    /// accepting it would be this machine answering a question asked of its owner.
    func testOnlyThisDevicesOwnClearedBlockersAreRequeued() async throws {
        let h = try await harness()
        let held = InboxTask(id: "asktask", state: .attentionRequired)
        let blocked = InboxTask(id: "permtask", state: .attentionRequired,
                                errorCode: .device(.permissionDenied))
        let conflict = InboxTask(id: "nametask", state: .attentionRequired,
                                 errorCode: .device(.nameConflict))
        h.transport.pendingResults = [.success([held, blocked, conflict])]
        h.transport.claimResult = .success((deliveries: [], leaseSeconds: 300))

        _ = try await engine(h).pass()

        let accepted = h.transport.calls.compactMap { call -> String? in
            if case .accept(let id, _) = call { return id }
            return nil
        }
        XCTAssertEqual(accepted, ["permtask"])
    }

    /// A write probe says the folder is writable; it does not say it now has room
    /// for a task that was parked as `disk_full`. The task's own declared size is
    /// re-checked with the SAME preflight the receiver uses.
    func testADiskFullTaskIsRequeuedOnlyOnceItActuallyFits() async throws {
        let big = InboxTask(id: "bigtask", state: .attentionRequired,
                            errorCode: .device(.diskFull), ciphertextBytes: 1 << 30)
        let stillFull = try await harness()
        stillFull.transport.pendingResults = [.success([big])]
        stillFull.transport.claimResult = .success((deliveries: [], leaseSeconds: 300))
        _ = try await engine(stillFull, freeBytes: { _ in 1024 }).pass()
        XCTAssertFalse(stillFull.transport.calls.contains { call in
            if case .accept = call { return true }
            return false
        }, "a task was re-queued into a disk that still cannot hold it")

        let roomy = try await harness()
        roomy.transport.pendingResults = [.success([big])]
        roomy.transport.claimResult = .success((deliveries: [], leaseSeconds: 300))
        _ = try await engine(roomy, freeBytes: { _ in 1 << 40 }).pass()
        XCTAssertTrue(roomy.transport.calls.contains(.accept(taskID: "bigtask", accept: true)))
    }

    // MARK: - the lease central advertises

    /// A server that shortens its lease is followed rather than contradicted: the
    /// renewal cadence comes from the claim response, not the compiled-in constant.
    func testTheRenewalCadenceFollowsTheLeaseCentralAdvertises() async throws {
        let h = try await harness()
        let bytes = [UInt8](repeating: 5, count: STORE_CHUNK_SIZE * 3)
        let built = try InboxFixture.delivery(files: [("a.txt", bytes)], deviceKey: h.deviceKey)
        h.transport.blobBody = built.ciphertext
        h.transport.blobChunkSize = 4096
        h.transport.pendingResults = [.success([built.delivery.task])]
        // Six seconds: a third of it is two, which the ticking clock crosses.
        h.transport.claimResult = .success((deliveries: [built.delivery], leaseSeconds: 6))

        let clock = TickingClock(start: epoch, step: 3)
        let engine = InboxReceiveEngine(transport: h.transport, keys: h.keys,
                                        journals: h.journals, folder: h.folder,
                                        account: account, now: { clock.next() },
                                        renewInterval: 3600, streamAttempts: 3)
        _ = try await engine.pass()

        XCTAssertTrue(reports(h).contains { $0.0 == .downloading },
                      "the advertised lease was ignored in favour of the default")
    }
}

/// Resolves every bookmark back to one directory, so the engine tests exercise
/// the real probe and the real filesystem without needing a sandbox.
private final class PassthroughBookmarking: InboxFolderBookmarking, @unchecked Sendable {
    private let url: URL
    init(url: URL) { self.url = url }
    func bookmark(for url: URL) throws -> Data { Data(url.path.utf8) }
    func resolve(_ data: Data) throws -> (url: URL, isStale: Bool) { (url, false) }
    func startAccess(to url: URL) -> Bool { true }
    func stopAccess(to url: URL) {}
}
