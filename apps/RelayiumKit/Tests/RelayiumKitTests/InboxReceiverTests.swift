import XCTest
import Darwin
@testable import RelayiumAppKit
@testable import RelayiumKit

/// One delivery, end to end, against real Stored Wire ciphertext.
///
/// Every fixture here is bytes an actual sender would have produced: a real
/// content key, a real encrypted manifest, real AES-GCM frames. That is what
/// makes "a tampered frame is refused", "a truncated stream leaves nothing" and
/// "the staged sizes match the manifest" mean anything — against a stub they
/// would be assertions about the stub.
///
/// The ordering claim the whole file is built around: nothing is written outside
/// the staging area until the last authenticated frame has been accepted and the
/// total length checked. So the strongest assertion in most of these tests is
/// what is NOT in the receive directory.
final class InboxReceiverTests: XCTestCase {

    private let account = try! InboxAccountID("accountreceiver1")
    private let epoch = Date(timeIntervalSince1970: 1_700_000_000)

    private struct Harness {
        let transport: FakeInboxTransport
        let keys: InMemoryInboxDeviceKeyStore
        let journals: InboxJournalStore
        let root: URL
        let deviceKey: InboxDeviceKeyPair
        var log: [InboxLogEvent] = []
    }

    private func harness(keyID: String = "key1") async throws -> Harness {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("relayium-receiver-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let journals = root.appendingPathExtension("journals")
        addTeardownBlock {
            try? FileManager.default.removeItem(at: root)
            try? FileManager.default.removeItem(at: journals)
        }

        let keys = InMemoryInboxDeviceKeyStore()
        let deviceKey = try InboxKeyMaterial.generateKeyPair()
        _ = try await keys.append(deviceKey, account: account, now: epoch)
        try await keys.bind(publicKey: InboxKeyMaterial.encode(deviceKey.publicKey),
                            keyID: keyID, generation: 1, account: account)

        return Harness(transport: FakeInboxTransport(), keys: keys,
                       // OUTSIDE the receive folder, as in production (Application
                       // Support): a journal holds plaintext names and absolute
                       // destinations, and it must stay readable when the receive
                       // folder itself becomes unusable.
                       journals: InboxJournalStore(directory: journals),
                       root: root, deviceKey: deviceKey)
    }

    private func receiver(_ h: Harness, log: InboxLog? = nil,
                          renewInterval: TimeInterval = 3600,
                          now: (@Sendable () -> Date)? = nil,
                          freeBytes: (@Sendable (URL) -> Int64?)? = nil) -> InboxReceiver {
        let epoch = self.epoch
        return InboxReceiver(transport: h.transport, keys: h.keys, journals: h.journals,
                             account: account, root: h.root,
                             now: now ?? { epoch }, log: log,
                             renewInterval: renewInterval, streamAttempts: 3,
                             freeBytes: freeBytes ?? InboxSpace.freeBytes)
    }

    /// Everything in the receive directory except this component's own staging
    /// area, which is a dot-directory the user never sees.
    private func delivered(_ root: URL) throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: root.path)
            .filter { $0 != InboxDestinationPlan.stagingDirectoryName }
            .sorted()
    }

    // MARK: - the happy path

    func testACompleteDeliveryLandsEveryFileAndReportsNothingItself() async throws {
        let h = try await harness()
        let built = try InboxFixture.delivery(files: [("a.txt", [UInt8]("hello".utf8)),
                                                      ("d/b.bin", [1, 2, 3])],
                                              deviceKey: h.deviceKey)
        h.transport.blobBody = built.ciphertext

        let outcome = try await receiver(h).deliver(built.delivery)

        XCTAssertEqual(outcome, .committed)
        XCTAssertEqual(try delivered(h.root), ["a.txt", "d"])
        XCTAssertEqual(try Data(contentsOf: h.root.appendingPathComponent("a.txt")),
                       Data("hello".utf8))
        XCTAssertEqual(try Data(contentsOf: h.root.appendingPathComponent("d/b.bin")),
                       Data([1, 2, 3]))
        // The receiver reports `verifying` before it touches the user's folder and
        // leaves `saved` to its caller: `saved` must be reported only from a
        // COMPLETED commit, and the receiver returns before that is decided.
        XCTAssertEqual(h.transport.calls.filter {
            if case .report(_, let state, _, _) = $0 { return state == .saved }
            return false
        }.count, 0)
    }

    func testAZeroLengthFileIsStillCreated() async throws {
        let h = try await harness()
        let built = try InboxFixture.delivery(files: [("empty.txt", []), ("a.txt", [7])],
                                              deviceKey: h.deviceKey)
        h.transport.blobBody = built.ciphertext

        _ = try await receiver(h).deliver(built.delivery)

        XCTAssertEqual(try delivered(h.root), ["a.txt", "empty.txt"])
        XCTAssertEqual(try Data(contentsOf: h.root.appendingPathComponent("empty.txt")), Data())
    }

    func testTheStagingAreaIsRemovedAfterASuccessfulCommit() async throws {
        let h = try await harness()
        let built = try InboxFixture.delivery(files: [("a.txt", [1])], deviceKey: h.deviceKey)
        h.transport.blobBody = built.ciphertext
        _ = try await receiver(h).deliver(built.delivery)
        let staging = h.root.appendingPathComponent(InboxDestinationPlan.stagingDirectoryName)
            .appendingPathComponent("task1")
        XCTAssertFalse(FileManager.default.fileExists(atPath: staging.path))
    }

    // MARK: - the key

    /// Central sealed to a key this account does not hold — a re-login that minted
    /// a new device, a restored Mac, a destroyed key history. Nothing here can ever
    /// open it, so it is TERMINAL rather than retried eight times.
    func testATaskSealedToAKeyThisMacDoesNotHoldIsTerminal() async throws {
        let h = try await harness(keyID: "key1")
        let built = try InboxFixture.delivery(files: [("a.txt", [1])],
                                              deviceKey: h.deviceKey, keyID: "some-other-key")
        h.transport.blobBody = built.ciphertext

        await assertFailure(try await receiver(h).deliver(built.delivery),
                            state: .failedTerminal, code: .decryptFailed,
                            reason: .noLocalPrivateKey)
        XCTAssertEqual(try delivered(h.root), [])
    }

    /// A wrapped key that does not open under this device's private half. Terminal:
    /// the same bytes fail identically on every attempt.
    func testAWrappedKeyThatDoesNotOpenIsTerminal() async throws {
        let h = try await harness()
        let other = try InboxKeyMaterial.generateKeyPair()
        let built = try InboxFixture.delivery(files: [("a.txt", [1])], deviceKey: other)
        // Central named OUR key, but the box was sealed to somebody else's.
        let delivery = InboxDelivery(task: InboxTask(id: "task1", state: .downloading,
                                                     ciphertextBytes: Int64(built.ciphertext.count),
                                                     targetKeyID: "key1"),
                                     encManifest: built.delivery.encManifest,
                                     wrappedKey: built.delivery.wrappedKey,
                                     claimToken: "ct")
        h.transport.blobBody = built.ciphertext

        await assertFailure(try await receiver(h).deliver(delivery),
                            state: .failedTerminal, code: .decryptFailed)
        XCTAssertEqual(try delivered(h.root), [])
    }

    // MARK: - the manifest

    /// A manifest is sender-controlled, and AEAD only proves who wrote it.
    /// Declared plaintext can never exceed the ciphertext byte count CENTRAL
    /// measured itself, so a manifest claiming terabytes behind a small object is
    /// a lie central can be used to catch — before any space is reserved for it.
    func testAManifestClaimingMoreThanTheCiphertextCanHoldIsRefused() async throws {
        let h = try await harness()
        let key = generateStoreKey()
        let manifest = StoredManifest(files: [ManifestFile(name: "a.txt", size: 1 << 30)])
        let encManifest = try encryptManifest(key: key, manifest)
        let sealed = try InboxFixture.seal(contentKey: key, to: h.deviceKey.publicKey)
        let delivery = InboxDelivery(
            task: InboxTask(id: "task1", state: .downloading, ciphertextBytes: 4096,
                            targetKeyID: "key1"),
            encManifest: Data(encManifest).base64EncodedString(),
            wrappedKey: InboxKeyMaterial.encode(sealed), claimToken: "ct")

        await assertFailure(try await receiver(h).deliver(delivery),
                            state: .failedTerminal, code: .verifyFailed,
                            reason: .manifestExceedsCiphertext)
        XCTAssertTrue(h.transport.calls.filter { if case .blob = $0 { return true }; return false }
            .isEmpty, "the ciphertext was fetched for a manifest that could not be true")
    }

    func testATamperedManifestIsRefusedBeforeAnythingIsPlanned() async throws {
        let h = try await harness()
        let built = try InboxFixture.delivery(files: [("a.txt", [1])], deviceKey: h.deviceKey)
        var encManifest = [UInt8](try XCTUnwrap(Data(base64Encoded: built.delivery.encManifest)))
        encManifest[encManifest.count - 1] ^= 0x01
        let delivery = InboxDelivery(task: built.delivery.task,
                                     encManifest: Data(encManifest).base64EncodedString(),
                                     wrappedKey: built.delivery.wrappedKey, claimToken: "ct")

        await assertFailure(try await receiver(h).deliver(delivery), state: .failedRetryable,
                            code: .verifyFailed)
        XCTAssertEqual(try delivered(h.root), [])
    }

    /// The RAW manifest names are what the planner sees. `decryptManifest` strips
    /// control characters for display; a stripped name is one this device would
    /// then create under a name nobody chose, so the receiver refuses instead.
    func testAControlCharacterInAManifestNameIsRefusedRatherThanStripped() async throws {
        let h = try await harness()
        let built = try InboxFixture.delivery(files: [("a\u{7}b.txt", [1])],
                                              deviceKey: h.deviceKey)
        h.transport.blobBody = built.ciphertext

        await assertFailure(try await receiver(h).deliver(built.delivery),
                            state: .failedTerminal, code: .verifyFailed,
                            reason: .unsafeManifestName)
        XCTAssertEqual(try delivered(h.root), [])
    }

    // MARK: - tamper and truncation

    /// A tampered frame fails authentication. Nothing outside staging exists yet,
    /// so nothing is left behind — the property the whole ordering exists for.
    func testATamperedFrameLeavesNoCompleteLookingOutput() async throws {
        let h = try await harness()
        let built = try InboxFixture.delivery(files: [("a.txt", [UInt8](repeating: 7, count: 64))],
                                              deviceKey: h.deviceKey)
        var ciphertext = [UInt8](built.ciphertext)
        ciphertext[ciphertext.count - 1] ^= 0x01
        h.transport.blobBody = Data(ciphertext)

        await assertFailure(try await receiver(h).deliver(built.delivery),
                            state: .failedRetryable, code: .verifyFailed)
        XCTAssertEqual(try delivered(h.root), [])
    }

    /// A stream that ends on a frame boundary but short of the declared total is a
    /// clean end as far as framing is concerned. `end(expectedBytes:)` is what
    /// catches it, and it runs before anything is committed.
    func testATruncatedStreamLeavesNothingInTheReceiveDirectory() async throws {
        let h = try await harness()
        let bytes = [UInt8](repeating: 3, count: STORE_CHUNK_SIZE * 2 + 5)
        let built = try InboxFixture.delivery(files: [("a.txt", bytes)], deviceKey: h.deviceKey)
        // Cut on a frame boundary: the first frame only.
        let firstFrameLength = 4 + STORE_CHUNK_SIZE + 16
        h.transport.blobBody = built.ciphertext.prefix(firstFrameLength)

        await assertFailure(try await receiver(h).deliver(built.delivery),
                            state: .failedRetryable, code: .verifyFailed,
                            reason: .truncatedStream)
        XCTAssertEqual(try delivered(h.root), [])
    }

    /// More decrypted data than the manifest accounts for must be refused rather
    /// than spilling into the next file or a new one.
    func testAStreamLongerThanTheManifestDeclaresIsRefused() async throws {
        let h = try await harness()
        let key = generateStoreKey()
        // The manifest declares one byte; the ciphertext carries two frames.
        let manifest = StoredManifest(files: [ManifestFile(name: "a.txt", size: 1)])
        let encManifest = try encryptManifest(key: key, manifest)
        let ciphertext = encryptChunks(key: key, files: [[1], [2]])
        let sealed = try InboxFixture.seal(contentKey: key, to: h.deviceKey.publicKey)
        let delivery = InboxDelivery(
            task: InboxTask(id: "task1", state: .downloading,
                            ciphertextBytes: Int64(ciphertext.count), targetKeyID: "key1"),
            encManifest: Data(encManifest).base64EncodedString(),
            wrappedKey: InboxKeyMaterial.encode(sealed), claimToken: "ct")
        h.transport.blobBody = Data(ciphertext)

        await assertFailure(try await receiver(h).deliver(delivery), code: .verifyFailed)
        XCTAssertEqual(try delivered(h.root), [])
    }

    // MARK: - resume

    /// The resume offset is `consumedCipher`, which only advances past frames that
    /// already authenticated — so a resumed request never re-feeds a partial frame
    /// and never skips one.
    func testAnInterruptedStreamResumesFromACompleteFrameBoundary() async throws {
        let h = try await harness()
        let bytes = [UInt8](repeating: 5, count: STORE_CHUNK_SIZE * 2)
        let built = try InboxFixture.delivery(files: [("a.txt", bytes)], deviceKey: h.deviceKey)
        h.transport.blobBody = built.ciphertext
        h.transport.blobChunkSize = 1024
        h.transport.blobFailAttempt = 1
        // Part way into the SECOND frame, so the resume offset must be the end of
        // the first one rather than wherever the bytes stopped.
        h.transport.blobFailAfter = 4 + STORE_CHUNK_SIZE + 16 + 100

        let outcome = try await receiver(h).deliver(built.delivery)
        XCTAssertEqual(outcome, .committed)
        XCTAssertEqual(try Data(contentsOf: h.root.appendingPathComponent("a.txt")), Data(bytes))

        let offsets = h.transport.calls.compactMap { call -> Int64? in
            if case .blob(_, _, let offset) = call { return offset }
            return nil
        }
        XCTAssertEqual(offsets, [0, Int64(4 + STORE_CHUNK_SIZE + 16)])
    }

    /// A resume answered with a full `200` body is not a tail. Splicing a fresh
    /// start into the middle of a stream would produce authenticated-looking
    /// garbage, so the whole delivery restarts instead.
    func testAResumeAnsweredWithAFullBodyRestartsTheDelivery() async throws {
        let h = try await harness()
        let bytes = [UInt8](repeating: 5, count: STORE_CHUNK_SIZE * 2)
        let built = try InboxFixture.delivery(files: [("a.txt", bytes)], deviceKey: h.deviceKey)
        h.transport.blobBody = built.ciphertext
        h.transport.blobChunkSize = 1024
        h.transport.blobFailAttempt = 1
        h.transport.blobFailAfter = 4 + STORE_CHUNK_SIZE + 16 + 100
        h.transport.blobIgnoresRange = true

        await assertFailure(try await receiver(h).deliver(built.delivery),
                            state: .failedRetryable, code: .downloadFailed,
                            reason: .rangeIgnored)
        XCTAssertEqual(try delivered(h.root), [])
    }

    /// Reconnects are bounded for one attempt; beyond that central's own backoff
    /// and attempt budget take over, and the receiver must not out-retry it.
    func testReconnectsAreBoundedAndThenReportedRetryable() async throws {
        let h = try await harness()
        let built = try InboxFixture.delivery(files: [("a.txt", [1])], deviceKey: h.deviceKey)
        h.transport.blobBody = built.ciphertext
        h.transport.blobError = URLError(.timedOut)

        await assertFailure(try await receiver(h).deliver(built.delivery),
                            state: .failedRetryable, code: .downloadFailed)
        let blobCalls = h.transport.calls.filter { if case .blob = $0 { return true }; return false }
        XCTAssertEqual(blobCalls.count, 3, "the reconnect bound was not honoured")
    }

    // MARK: - the lease

    /// Central took the task away. A report would be a stale worker asserting
    /// something about work it no longer holds, so the delivery is ABANDONED —
    /// silently.
    func testAStaleClaimAbandonsWithoutReporting() async throws {
        let h = try await harness()
        let built = try InboxFixture.delivery(files: [("a.txt", [1])], deviceKey: h.deviceKey)
        h.transport.blobError = InboxError.api(status: 409, code: "stale_claim")

        do {
            _ = try await receiver(h).deliver(built.delivery)
            XCTFail("a stale claim was worked")
        } catch let abandon as InboxAbandon {
            XCTAssertEqual(abandon.cause, .staleClaim)
        }
        XCTAssertTrue(h.transport.calls.allSatisfy {
            if case .report = $0 { return false }
            return true
        }, "an abandoned task was reported")
    }

    /// A refused renewal means the lease is gone. The staged bytes are complete but
    /// nothing is visible yet, so abandoning costs a re-download and risks nothing —
    /// whereas committing under a lease central has reassigned could let two
    /// workers deliver the same task into two directories.
    func testARefusedVerifyingRenewalAbandonsBeforeAnythingIsCommitted() async throws {
        let h = try await harness()
        let built = try InboxFixture.delivery(files: [("a.txt", [1])], deviceKey: h.deviceKey)
        h.transport.blobBody = built.ciphertext
        h.transport.reportErrors[.verifying] = [InboxError.api(status: 409, code: "stale_claim")]

        do {
            _ = try await receiver(h).deliver(built.delivery)
            XCTFail("a lost lease still committed")
        } catch let abandon as InboxAbandon {
            XCTAssertEqual(abandon.cause, .leaseRenewalRefused)
        }
        XCTAssertEqual(try delivered(h.root), [])
    }

    /// A long download renews periodically. The renewal is an idempotent
    /// re-report of the CURRENT state, which is how the claim stays alive without
    /// a separate heartbeat endpoint.
    func testALongDownloadRenewsTheLeaseAsDownloading() async throws {
        let h = try await harness()
        let bytes = [UInt8](repeating: 5, count: STORE_CHUNK_SIZE * 3)
        let built = try InboxFixture.delivery(files: [("a.txt", bytes)], deviceKey: h.deviceKey)
        h.transport.blobBody = built.ciphertext
        h.transport.blobChunkSize = 4096

        // A clock that advances a minute per reading forces a renewal between
        // chunks without any real waiting.
        let clock = TickingClock(start: epoch, step: 60)
        _ = try await receiver(h, renewInterval: 30, now: { clock.next() })
            .deliver(built.delivery)

        let downloading = h.transport.calls.filter {
            if case .report(_, let state, _, _) = $0 { return state == .downloading }
            return false
        }
        XCTAssertFalse(downloading.isEmpty, "a long download never renewed its lease")
    }

    // MARK: - duplicate delivery and restart

    /// The journal already says completed, so a re-claimed task re-asserts what
    /// happened rather than downloading and committing a second time.
    func testATaskWhoseJournalSaysCompletedIsNeverDeliveredTwice() async throws {
        let h = try await harness()
        let built = try InboxFixture.delivery(files: [("a.txt", [1])], deviceKey: h.deviceKey)
        h.transport.blobBody = built.ciphertext

        _ = try await receiver(h).deliver(built.delivery)
        let afterFirst = try delivered(h.root)

        let outcome = try await receiver(h).deliver(built.delivery)

        XCTAssertEqual(outcome, .alreadyCommitted)
        XCTAssertEqual(try delivered(h.root), afterFirst, "the delivery was duplicated")
        let blobCalls = h.transport.calls.filter { if case .blob = $0 { return true }; return false }
        XCTAssertEqual(blobCalls.count, 1, "the ciphertext was fetched twice")
    }

    /// A crash between the last journal write and the staging cleanup leaves an
    /// empty per-task directory. The re-report path never calls `prepareStaging`,
    /// so nothing else would ever collect it.
    func testAReClaimOfACommittedTaskAlsoClearsAStrandedStagingDirectory() async throws {
        let h = try await harness()
        let built = try InboxFixture.delivery(files: [("a.txt", [1])], deviceKey: h.deviceKey)
        h.transport.blobBody = built.ciphertext
        _ = try await receiver(h).deliver(built.delivery)

        // Exactly what that crash leaves behind.
        let staging = try InboxCommit.prepareStaging(root: h.root, taskID: "task1")
        XCTAssertTrue(FileManager.default.fileExists(atPath: staging.path))

        let outcome = try await receiver(h).deliver(built.delivery)

        XCTAssertEqual(outcome, .alreadyCommitted)
        XCTAssertFalse(FileManager.default.fileExists(atPath: staging.path))
    }

    /// A resumed task keeps its ORIGINAL plan. Recomputing it against a directory
    /// that now contains this task's own earlier output would walk the collision
    /// suffix forward and deliver the same file twice.
    func testAResumedTaskKeepsItsOriginalPlanRatherThanRecomputingIt() async throws {
        let h = try await harness()
        let built = try InboxFixture.delivery(files: [("a.txt", [1, 2, 3])],
                                              deviceKey: h.deviceKey)
        h.transport.blobBody = built.ciphertext

        // First attempt: journal the plan, then fail before the commit.
        h.transport.reportErrors[.verifying] = [InboxError.api(status: 409, code: "stale_claim")]
        _ = try? await receiver(h).deliver(built.delivery)
        let planned = try XCTUnwrap(try h.journals.load("task1")).plan
        XCTAssertEqual(planned.map(\.destination), [h.root.appendingPathComponent("a.txt").path])

        // Something else takes the name in the meantime.
        try Data("mine".utf8).write(to: h.root.appendingPathComponent("a.txt"))

        // Second attempt: the plan is UNCHANGED, so the delivery stops for a
        // person rather than quietly landing at `a (2).txt`.
        h.transport.reportErrors[.verifying] = []
        await assertFailure(try await receiver(h).deliver(built.delivery),
                            state: .attentionRequired, code: .nameConflict)
        XCTAssertEqual(try XCTUnwrap(try h.journals.load("task1")).plan, planned)
        XCTAssertEqual(try Data(contentsOf: h.root.appendingPathComponent("a.txt")),
                       Data("mine".utf8))
    }

    /// The receive directory changed under an unfinished task. The old plan
    /// describes paths that no longer mean anything, and inventing a new one would
    /// risk delivering into two places.
    func testAChangedReceiveDirectoryStopsAnUnfinishedTask() async throws {
        let h = try await harness()
        let built = try InboxFixture.delivery(files: [("a.txt", [1])], deviceKey: h.deviceKey)
        var journal = InboxJournal(taskID: "task1", storedFileID: "obj1", targetKeyID: "key1",
                                   root: "/somewhere/else",
                                   plan: [InboxPlanEntry(index: 0, name: "a.txt", size: 1,
                                                         destination: "/somewhere/else/a.txt")],
                                   plannedAt: 1)
        try h.journals.save(&journal, now: epoch)
        h.transport.blobBody = built.ciphertext

        await assertFailure(try await receiver(h).deliver(built.delivery),
                            state: .attentionRequired, code: .directoryUnavailable,
                            reason: .receiveFolderChanged)
    }

    func testAnUnfinishedJournalForDifferentDeliveryIdentityIsRefused() async throws {
        let h = try await harness()
        let built = try InboxFixture.delivery(files: [("a.txt", [1])], deviceKey: h.deviceKey)
        var journal = InboxJournal(
            taskID: "task1", storedFileID: "different-object", targetKeyID: "key1",
            root: h.root.standardizedFileURL.path,
            plan: [InboxPlanEntry(index: 0, name: "a.txt", size: 1,
                                  destination: h.root.appendingPathComponent("a.txt").path)],
            plannedAt: 1)
        try h.journals.save(&journal, now: epoch)

        await assertFailure(try await receiver(h).deliver(built.delivery),
                            state: .failedTerminal, code: .internal,
                            reason: .journalUnreadable)
        XCTAssertEqual(try delivered(h.root), [])
    }

    func testACompletedJournalForDifferentDeliveryIdentityIsNotTrusted() async throws {
        let h = try await harness()
        let built = try InboxFixture.delivery(files: [("a.txt", [1])], deviceKey: h.deviceKey)
        var journal = InboxJournal(
            taskID: "task1", storedFileID: "obj1", targetKeyID: "different-key",
            root: h.root.standardizedFileURL.path,
            plan: [InboxPlanEntry(index: 0, name: "a.txt", size: 1,
                                  destination: h.root.appendingPathComponent("a.txt").path)],
            plannedAt: 1, committed: [h.root.appendingPathComponent("a.txt").path],
            isCompleted: true, completedAt: 2)
        try h.journals.save(&journal, now: epoch)

        await assertFailure(try await receiver(h).deliver(built.delivery),
                            state: .failedTerminal, code: .internal,
                            reason: .journalUnreadable)
        XCTAssertEqual(try delivered(h.root), [])
    }

    // MARK: - local blockers

    /// Refused BEFORE anything is downloaded, so a doomed transfer does not fill
    /// the disk on its way to failing.
    func testAnImpossiblyLargeDeliveryIsRefusedBeforeItIsFetched() async throws {
        let h = try await harness()
        let key = generateStoreKey()
        let huge = Int(Int32.max)
        let manifest = StoredManifest(files: [ManifestFile(name: "a.bin", size: huge)])
        let encManifest = try encryptManifest(key: key, manifest)
        let sealed = try InboxFixture.seal(contentKey: key, to: h.deviceKey.publicKey)
        let delivery = InboxDelivery(
            task: InboxTask(id: "task1", state: .downloading,
                            ciphertextBytes: Int64(huge) + 1024, targetKeyID: "key1"),
            encManifest: Data(encManifest).base64EncodedString(),
            wrappedKey: InboxKeyMaterial.encode(sealed), claimToken: "ct")

        // A free-space report small enough to make the preflight refuse. The real
        // `statfs` on a test runner has plenty of room, so the seam is what makes
        // the disk-full branch reachable at all.
        await assertFailure(try await receiver(h, freeBytes: { _ in 1024 }).deliver(delivery),
                            state: .attentionRequired, code: .diskFull,
                            reason: .notEnoughSpace)
        XCTAssertTrue(h.transport.calls.filter { if case .blob = $0 { return true }; return false }
            .isEmpty)
    }

    /// A read-only receive folder is `permission_denied` rather than a retryable
    /// internal error: retrying would burn the attempt budget while the sender's
    /// UI showed nothing actionable.
    func testAReadOnlyReceiveFolderIsReportedAsPermissionDenied() async throws {
        let h = try await harness()
        let built = try InboxFixture.delivery(files: [("a.txt", [1])], deviceKey: h.deviceKey)
        h.transport.blobBody = built.ciphertext
        XCTAssertEqual(chmod(h.root.path, 0o500), 0)
        addTeardownBlock { chmod(h.root.path, 0o700) }

        await assertFailure(try await receiver(h).deliver(built.delivery),
                            state: .attentionRequired, code: .permissionDenied)
    }

    /// The whole `errno` mapping in one place, because the STATE is the part that
    /// decides whether a delivery is dropped, parked or retried.
    func testEveryLocalBlockerMapsToItsTruthfulCodeAndState() {
        let cases: [(Int32, InboxDeviceErrorCode, InboxTaskState)] = [
            (ENOSPC, .diskFull, .attentionRequired),
            (EDQUOT, .diskFull, .attentionRequired),
            (EACCES, .permissionDenied, .attentionRequired),
            (EPERM, .permissionDenied, .attentionRequired),
            (EROFS, .permissionDenied, .attentionRequired),
            (ENOENT, .directoryUnavailable, .attentionRequired),
            (ENOTDIR, .directoryUnavailable, .attentionRequired),
            (ELOOP, .directoryUnavailable, .attentionRequired),
            (EEXIST, .nameConflict, .attentionRequired),
            (EINVAL, .internal, .failedRetryable),
        ]
        for (code, expectedCode, expectedState) in cases {
            let failure = InboxClassify.filesystem(InboxCommitError.system(code))
            XCTAssertEqual(failure.code, expectedCode, "errno \(code)")
            XCTAssertEqual(failure.state, expectedState, "errno \(code)")
        }
    }

    /// `attention_required` is the state that PRESERVES recovery: the task can be
    /// re-queued once a person clears the blocker, whereas terminal drops it.
    func testEveryLocalBlockerPreservesRecovery() {
        for code: Int32 in [ENOSPC, EACCES, ENOENT, EEXIST] {
            XCTAssertEqual(InboxClassify.filesystem(InboxCommitError.system(code)).state,
                           .attentionRequired)
        }
    }

    // MARK: - logging

    /// The log event type has no case that can carry a file name, a destination, a
    /// bearer, a claim token or key material — so no future call site can add one
    /// by accident. This drives a real delivery and checks the rendered events
    /// against the secrets that existed in it.
    func testNoLogEventCarriesASecretOrAPlaintextName() async throws {
        let h = try await harness()
        let built = try InboxFixture.delivery(files: [("secret-report.txt", [1, 2, 3])],
                                              deviceKey: h.deviceKey,
                                              claimToken: "claim-token-secret")
        h.transport.blobBody = built.ciphertext

        let recorder = LogRecorder()
        _ = try await receiver(h, log: { recorder.append($0) }).deliver(built.delivery)

        XCTAssertFalse(recorder.events.isEmpty, "nothing was logged, so nothing was checked")
        let rendered = recorder.events.map { String(describing: $0) }.joined(separator: "\n")
        for secret in ["secret-report.txt", "claim-token-secret", h.root.path,
                       built.delivery.wrappedKey, built.delivery.encManifest,
                       InboxKeyMaterial.encode(h.deviceKey.privateKey)] {
            XCTAssertFalse(rendered.contains(secret), "a log event carried \(secret)")
        }
    }

    // MARK: - helpers

    private func assertFailure(_ expression: @autoclosure () async throws -> InboxReceiver.Outcome,
                               state: InboxTaskState? = nil,
                               code: InboxDeviceErrorCode? = nil,
                               reason: InboxFailureReason? = nil,
                               file: StaticString = #filePath, line: UInt = #line) async {
        do {
            _ = try await expression()
            XCTFail("the delivery succeeded", file: file, line: line)
        } catch let failure as InboxFailure {
            if let state { XCTAssertEqual(failure.state, state, file: file, line: line) }
            if let code { XCTAssertEqual(failure.code, code, file: file, line: line) }
            if let reason { XCTAssertEqual(failure.reason, reason, file: file, line: line) }
        } catch {
            XCTFail("unexpected error: \(error)", file: file, line: line)
        }
    }
}

/// A clock that moves forward by a fixed step on every reading, so a renewal
/// interval can be crossed without any real waiting.
final class TickingClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date
    private let step: TimeInterval

    init(start: Date, step: TimeInterval) {
        current = start
        self.step = step
    }

    func next() -> Date {
        lock.lock(); defer { lock.unlock() }
        current = current.addingTimeInterval(step)
        return current
    }
}

final class LogRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [InboxLogEvent] = []
    func append(_ event: InboxLogEvent) { lock.lock(); stored.append(event); lock.unlock() }
    var events: [InboxLogEvent] { lock.lock(); defer { lock.unlock() }; return stored }
}
