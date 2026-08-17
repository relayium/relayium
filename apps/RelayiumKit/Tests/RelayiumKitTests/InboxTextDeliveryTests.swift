import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// A TEXT delivery, end to end, against real Stored Wire ciphertext.
///
/// The four claims this file exists to hold, each of which is a promise made to
/// somebody who pressed "send" on another machine:
///
///  1. A message is committed to the protected message store, as one message,
///     and nothing appears in the receive folder — not a `.txt` file, not
///     anything.
///  2. A missing or unusable receive folder does not block it. That is the whole
///     reason the receiver classifies before it consults the folder.
///  3. A replay commits one message, not two.
///  4. Bytes that are not exactly one nonempty UTF-8 message of the declared
///     length are refused, and refused terminally.
final class InboxTextDeliveryTests: XCTestCase {

    private let account = try! InboxAccountID("accounttext1")
    private let epoch = Date(timeIntervalSince1970: 1_700_000_000)

    private struct Harness {
        let transport: FakeInboxTransport
        let keys: InMemoryInboxDeviceKeyStore
        let journals: InboxJournalStore
        let messages: InboxMessageStore
        /// The receive folder. A message must never touch it, so every test here
        /// asserts on its contents as well as on the store's.
        let root: URL
        let deviceKey: InboxDeviceKeyPair
    }

    private func harness() async throws -> Harness {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("relayium-text-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let journals = root.appendingPathExtension("journals")
        let messages = root.appendingPathExtension("messages")
        addTeardownBlock {
            try? FileManager.default.removeItem(at: root)
            try? FileManager.default.removeItem(at: journals)
            try? FileManager.default.removeItem(at: messages)
        }
        let keys = InMemoryInboxDeviceKeyStore()
        let deviceKey = try InboxKeyMaterial.generateKeyPair()
        _ = try await keys.append(deviceKey, account: account, now: epoch)
        try await keys.bind(publicKey: InboxKeyMaterial.encode(deviceKey.publicKey),
                            keyID: "key1", generation: 1, account: account)
        return Harness(transport: FakeInboxTransport(), keys: keys,
                       journals: InboxJournalStore(directory: journals),
                       messages: InboxMessageStore(directory: messages),
                       root: root, deviceKey: deviceKey)
    }

    /// `root: nil` is the point of several of these: it is what the engine hands
    /// the receiver when this Mac has no usable receive folder.
    private func receiver(_ h: Harness, root: URL?, log: InboxLog? = nil) -> InboxReceiver {
        let epoch = self.epoch
        return InboxReceiver(transport: h.transport, keys: h.keys, journals: h.journals,
                             messages: h.messages, account: account, root: root,
                             now: { epoch }, log: log, renewInterval: 3600, streamAttempts: 3)
    }

    private func contents(_ root: URL) throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: root.path)
            .filter { $0 != InboxDestinationPlan.stagingDirectoryName }
            .sorted()
    }

    // MARK: - the happy path

    func testAMessageIsCommittedToTheStoreAndNeverToTheReceiveFolder() async throws {
        let h = try await harness()
        let text = "bring the keys 🙏"
        let built = try InboxFixture.message(text: text, deviceKey: h.deviceKey)
        h.transport.blobBody = built.ciphertext

        let outcome = try await receiver(h, root: h.root).deliver(built.delivery)

        XCTAssertEqual(outcome, .committed)
        XCTAssertEqual(h.messages.all().map(\.text), [text])
        XCTAssertEqual(try contents(h.root), [],
                       "a message put something in the user's receive folder")
    }

    /// Invariant: a missing, revoked or unwritable folder does not block a text
    /// task. The receiver is handed NO root at all here — the strongest form of
    /// the condition — and the message still lands.
    func testAMessageLandsWithNoReceiveFolderAtAll() async throws {
        let h = try await harness()
        let built = try InboxFixture.message(text: "no folder needed", deviceKey: h.deviceKey)
        h.transport.blobBody = built.ciphertext

        let outcome = try await receiver(h, root: nil).deliver(built.delivery)

        XCTAssertEqual(outcome, .committed)
        XCTAssertEqual(h.messages.all().map(\.text), ["no folder needed"])
    }

    /// The other half of the same rule: a FILE delivery in that state is parked
    /// for the user rather than committed anywhere.
    func testAFileDeliveryWithNoFolderIsParkedAndTouchesNoStore() async throws {
        let h = try await harness()
        let built = try InboxFixture.delivery(files: [("a.txt", [1, 2, 3])],
                                              deviceKey: h.deviceKey)
        h.transport.blobBody = built.ciphertext

        do {
            _ = try await receiver(h, root: nil).deliver(built.delivery)
            XCTFail("a file delivery was committed with no receive folder")
        } catch let failure as InboxFailure {
            XCTAssertEqual(failure.state, .attentionRequired)
            XCTAssertEqual(failure.code, .directoryUnavailable)
        }
        XCTAssertTrue(h.messages.all().isEmpty,
                      "a file delivery reached the message store")
    }

    // MARK: - replay

    /// A `saved` report that never reached central is re-asserted on the next
    /// claim. The journal is what makes that idempotent, and it must be
    /// idempotent for a message exactly as it is for a file.
    func testAReplayedMessageDeliveryCommitsOneMessage() async throws {
        let h = try await harness()
        let built = try InboxFixture.message(text: "only once", deviceKey: h.deviceKey)
        h.transport.blobBody = built.ciphertext

        _ = try await receiver(h, root: h.root).deliver(built.delivery)
        let second = try await receiver(h, root: h.root).deliver(built.delivery)

        XCTAssertEqual(second, .alreadyCommitted)
        XCTAssertEqual(h.messages.all().map(\.text), ["only once"])
        // The replay must not re-download either: the journal already says the
        // work is done.
        let blobs = h.transport.calls.filter { if case .blob = $0 { return true }; return false }
        XCTAssertEqual(blobs.count, 1)
    }

    /// A replay is answered from the journal alone, so it works when the receive
    /// folder is gone — the folder had nothing to do with this delivery.
    func testAReplayNeedsNoReceiveFolder() async throws {
        let h = try await harness()
        let built = try InboxFixture.message(text: "still here", deviceKey: h.deviceKey)
        h.transport.blobBody = built.ciphertext

        _ = try await receiver(h, root: h.root).deliver(built.delivery)
        let second = try await receiver(h, root: nil).deliver(built.delivery)

        XCTAssertEqual(second, .alreadyCommitted)
        XCTAssertEqual(h.messages.all().count, 1)
    }

    // MARK: - refusals

    /// AEAD proves who wrote the bytes and says nothing about whether they are
    /// text. Invalid UTF-8 is refused rather than repaired: a receiver that
    /// substituted U+FFFD would show the user something nobody wrote.
    func testInvalidUTF8IsRefusedRatherThanRepaired() async throws {
        let h = try await harness()
        let bytes: [UInt8] = [0x68, 0x69, 0xFF, 0xFE]   // "hi" + a lone continuation pair
        let built = try InboxFixture.delivery(
            manifest: InboxFixture.manifestBytes(items: [(kind: "text", name: nil,
                                                          size: bytes.count)]),
            payload: [bytes], deviceKey: h.deviceKey)
        h.transport.blobBody = built.ciphertext

        do {
            _ = try await receiver(h, root: h.root).deliver(built.delivery)
            XCTFail("malformed UTF-8 was committed as a message")
        } catch let failure as InboxFailure {
            XCTAssertEqual(failure.state, .failedTerminal)
            XCTAssertEqual(failure.code, .verifyFailed)
            XCTAssertEqual(failure.reason, .messageMalformed)
        }
        XCTAssertTrue(h.messages.all().isEmpty)
        XCTAssertEqual(try contents(h.root), [])
    }

    /// A manifest declaring one length behind a payload of another is a sender
    /// that lied about its own delivery. Nothing is committed.
    func testALengthMismatchIsRefused() async throws {
        let h = try await harness()
        let built = try InboxFixture.delivery(
            manifest: InboxFixture.manifestBytes(items: [(kind: "text", name: nil, size: 99)]),
            payload: [[UInt8]("short".utf8)], deviceKey: h.deviceKey)
        h.transport.blobBody = built.ciphertext

        do {
            _ = try await receiver(h, root: h.root).deliver(built.delivery)
            XCTFail("a length mismatch was committed as a message")
        } catch let failure as InboxFailure {
            XCTAssertEqual(failure.code, .verifyFailed)
        }
        XCTAssertTrue(h.messages.all().isEmpty)
    }

    /// A mixed manifest is refused whole, never partly honoured: honouring one
    /// would mean writing half a delivery into the folder and half into the
    /// store.
    func testAMixedManifestIsRefusedAndCommitsNothingAnywhere() async throws {
        let h = try await harness()
        let built = try InboxFixture.delivery(
            manifest: InboxFixture.manifestBytes(items: [
                (kind: "file", name: "a.txt", size: 1),
                (kind: "text", name: nil, size: 1),
            ]),
            payload: [[1], [2]], deviceKey: h.deviceKey)
        h.transport.blobBody = built.ciphertext

        do {
            _ = try await receiver(h, root: h.root).deliver(built.delivery)
            XCTFail("a mixed manifest was honoured")
        } catch let failure as InboxFailure {
            XCTAssertEqual(failure.state, .failedTerminal)
            XCTAssertEqual(failure.code, .verifyFailed)
            XCTAssertEqual(failure.reason, .manifestInvalid)
        }
        XCTAssertTrue(h.messages.all().isEmpty)
        XCTAssertEqual(try contents(h.root), [])
    }

    /// A v1-shaped document is refused as a version problem. This is the proof
    /// that the receiver decodes the DEDICATED v2 manifest and not the shared
    /// Stored-Wire one — `{"files":[…]}` is a perfectly valid `StoredManifest`
    /// and authenticates under the same key.
    func testAV1ShapedManifestIsRefused() async throws {
        let h = try await harness()
        let built = try InboxFixture.delivery(
            manifest: Array(#"{"files":[{"name":"a.txt","size":1}]}"#.utf8),
            payload: [[1]], deviceKey: h.deviceKey)
        h.transport.blobBody = built.ciphertext

        do {
            _ = try await receiver(h, root: h.root).deliver(built.delivery)
            XCTFail("a v1-shaped manifest was accepted")
        } catch let failure as InboxFailure {
            XCTAssertEqual(failure.state, .failedTerminal)
            XCTAssertEqual(failure.reason, .manifestInvalid)
        }
        XCTAssertEqual(try contents(h.root), [])
    }

    /// A text item carrying a name is refused: `name` is ABSENT for text, not
    /// empty, precisely so a receiver is never handed a string it could be
    /// tempted to treat as a destination.
    func testATextItemWithANameIsRefused() async throws {
        let h = try await harness()
        let built = try InboxFixture.delivery(
            manifest: InboxFixture.manifestBytes(items: [(kind: "text", name: "note.txt",
                                                          size: 5)]),
            payload: [[UInt8]("hello".utf8)], deviceKey: h.deviceKey)
        h.transport.blobBody = built.ciphertext

        do {
            _ = try await receiver(h, root: h.root).deliver(built.delivery)
            XCTFail("a named text item was accepted")
        } catch let failure as InboxFailure {
            XCTAssertEqual(failure.reason, .manifestInvalid)
        }
        XCTAssertEqual(try contents(h.root), [])
        XCTAssertTrue(h.messages.all().isEmpty)
    }

    // MARK: - what is said about it

    /// The log may carry a task id and a byte COUNT. Not the message.
    func testNoLogEventCarriesTheMessage() async throws {
        let h = try await harness()
        let secret = "the passphrase is hunter2"
        let built = try InboxFixture.message(text: secret, deviceKey: h.deviceKey)
        h.transport.blobBody = built.ciphertext

        let events = EventBox()
        _ = try await receiver(h, root: h.root, log: { events.add($0) }).deliver(built.delivery)

        XCTAssertFalse(events.all().isEmpty, "the delivery logged nothing at all")
        for event in events.all() {
            XCTAssertFalse("\(event)".contains("hunter2"), "a log event carried the message")
            XCTAssertFalse("\(event)".contains("passphrase"), "a log event carried the message")
        }
    }

    /// The journal records that a message was committed and how long it was, and
    /// never the message itself — it is a plaintext file a receipt and a crash
    /// recovery both read.
    func testTheJournalRecordsTheCommitButNotTheMessage() async throws {
        let h = try await harness()
        let secret = "hunter2"
        let built = try InboxFixture.message(text: secret, deviceKey: h.deviceKey)
        h.transport.blobBody = built.ciphertext

        _ = try await receiver(h, root: h.root).deliver(built.delivery)

        let journal = try XCTUnwrap(h.journals.load(built.delivery.task.id))
        XCTAssertEqual(journal.contentKind, .text)
        XCTAssertEqual(journal.messageBytes, secret.utf8.count)
        XCTAssertTrue(journal.isCompleted)
        XCTAssertTrue(journal.plan.isEmpty)

        let raw = try String(contentsOf: h.journals.directory
            .appendingPathComponent(built.delivery.task.id + ".json"), encoding: .utf8)
        XCTAssertFalse(raw.contains(secret), "the journal file contains the message")
    }

    /// The receipt is what a notification, a status line and a result row are
    /// built from. It says a MESSAGE arrived, carries no path, and carries no
    /// text.
    func testTheReceiptSaysMessageAndCarriesNoContent() async throws {
        let h = try await harness()
        let built = try InboxFixture.message(text: "hunter2", deviceKey: h.deviceKey)
        h.transport.blobBody = built.ciphertext

        _ = try await receiver(h, root: h.root).deliver(built.delivery)

        let receipt = try XCTUnwrap(InboxReceipt.make(
            taskID: built.delivery.task.id,
            journal: try h.journals.load(built.delivery.task.id), isReplay: false))
        XCTAssertEqual(receipt.kind, .message)
        XCTAssertEqual(receipt.urls, [])
        XCTAssertEqual(receipt.fileCount, 0)
        XCTAssertEqual(receipt.byteCount, Int64("hunter2".utf8.count))
    }
}

/// A lock-guarded collector, because the log closure is `@Sendable`.
final class EventBox: @unchecked Sendable {
    private let lock = NSLock()
    private var events: [InboxLogEvent] = []
    func add(_ event: InboxLogEvent) {
        lock.lock(); defer { lock.unlock() }
        events.append(event)
    }
    func all() -> [InboxLogEvent] {
        lock.lock(); defer { lock.unlock() }
        return events
    }
}
