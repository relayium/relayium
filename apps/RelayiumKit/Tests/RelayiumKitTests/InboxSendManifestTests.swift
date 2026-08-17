import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// The SENDER half of Device Inbox v2: what a delivery's ciphertext actually
/// carries at frame 0, and what it must never carry anywhere else.
///
/// Everything here is asserted against the BYTES a delivery produced, opened
/// with its own content key — not against the intermediate values the sender
/// happened to compute. That is the only way to check the property that matters:
/// a v2 receiver opens frame 0 with the v2 codec, so a sender that sealed the
/// shared Stored-Wire manifest has produced a delivery its own receiver refuses
/// as `verify_failed`, after the whole file has been uploaded, queued and
/// downloaded.
///
/// Three claims run through the file:
///
///  1. **Every delivery seals the v2 manifest**, and the shared codec cannot
///     read it. There is no fall-back and no dual stack.
///  2. **The kind is sealed and nothing else says it.** A message's body is in
///     the payload frames; the manifest declares only its length; the create
///     request carries seven opaque fields and an integer.
///  3. **Every attempt agrees.** A retry, a reseal after a key rotation and a
///     restart after the idle reaper rebuild the identical manifest from the
///     durable plan.
final class InboxSendManifestTests: XCTestCase {
    private var root: URL!
    private var store: PendingUploadStore!
    private var keys: InMemoryStoredLinkKeyStore!
    private var sender: FakeInboxSenderTransport!
    private var objects: FakeStoredObjectService!
    private var transport: StubTransport!

    private let deviceID = "DEVICE0123456789"
    private let keyID = "KEY0123456789abcd"
    private let rotatedKeyID = "KEY9999999999abcd"
    private let taskID = "TASK0123456789ab"
    private let idempotencyKey = "8C1A0F3D-2B45-4C6E-9A17-0000000000AA"

    private var devicePublicKey = ""
    private var rotatedPublicKey = ""

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("v2-sender-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        store = PendingUploadStore(root: root.appendingPathComponent("PendingUploads"))
        keys = InMemoryStoredLinkKeyStore()
        sender = FakeInboxSenderTransport()
        objects = FakeStoredObjectService()
        transport = StubTransport()
        transport.finalizeResult = UploadResult(id: "STORED0123456789", expiresAt: 4242)
        devicePublicKey = InboxKeyMaterial.encode(try InboxKeyMaterial.generateKeyPair().publicKey)
        rotatedPublicKey = InboxKeyMaterial.encode(try InboxKeyMaterial.generateKeyPair().publicKey)
        sender.deviceRows = [row()]
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    // MARK: - fixtures

    /// A sendable device. `presentsText` is what makes both halves of the
    /// capability rule reachable: a message needs `inbox.text.v1` and a file
    /// must not.
    private func row(keyID: String? = nil, publicKey: String? = nil, generation: Int64 = 4,
                     presentsText: Bool = true, receiveDirReady: Bool = true) -> InboxDeviceRow {
        let key = InboxKey(id: keyID ?? self.keyID, algorithm: InboxProtocol.keyAlgorithm,
                           publicKey: publicKey ?? devicePublicKey, generation: generation,
                           createdAt: 10)
        return InboxDeviceRow(id: deviceID, name: "Studio", kind: "mac", isCurrent: false,
                              inbox: InboxView(presence: .online, lastHeartbeatAt: 10,
                                               presenceExpiresAt: 100,
                                               heartbeatIntervalSeconds: 30, protocolVersion: 3,
                                               capabilities: InboxProtocol
                                                   .announcedCapabilities(presentingText: presentsText),
                                               receiveCapability: InboxCapability.receiveV3,
                                               autoAccept: .auto, receiveDirReady: receiveDirReady,
                                               revoked: false, canReceive: true,
                                               registeredAt: 10, key: key))
    }

    private func task(keyID: String? = nil, generation: Int64 = 4) -> InboxTask {
        InboxTask(id: taskID, targetDeviceID: deviceID, idempotencyKey: idempotencyKey,
                  storedFileID: "STORED0123456789", state: .queued, ciphertextBytes: 64,
                  targetKeyID: keyID ?? self.keyID, targetKeyGeneration: generation,
                  expiresAt: 86_500)
    }

    private func coordinator() -> InboxSendCoordinator {
        InboxSendCoordinator(store: store, keys: keys, uploader: CloudUploader(transport: transport),
                             sender: sender, objects: objects)
    }

    private func target(keyID: String? = nil, generation: Int64 = 4) -> PendingUploadTarget {
        PendingUploadTarget(deviceId: deviceID, keyId: keyID ?? self.keyID,
                            keyGeneration: generation, createIdempotencyKey: idempotencyKey)
    }

    /// A staged FILE delivery whose selection has the shape a folder send
    /// produces: nested "/"-separated relative paths, an empty file, and a
    /// deliberate order that is not alphabetical.
    private func stagedFiles(_ entries: [(name: String, bytes: [UInt8])]) async throws
        -> PendingUploadPlan {
        let sources = entries.map { DataSource(name: $0.name, bytes: $0.bytes) }
        let plan = try store.prepare(sources: sources, accountId: "acct-1", burnAfterRead: false,
                                     ttl: UploadPurpose.deviceTaskTTLSeconds,
                                     target: target())
        try await keys.save(id: plan.jobId, keyB64url: encodeStoreKey(contentKey))
        return plan
    }

    private func stagedText(_ message: String) async throws -> PendingUploadPlan {
        let plan = try store.prepare(sources: [DataSource(name: "message",
                                                          bytes: Array(message.utf8))],
                                     accountId: "acct-1", burnAfterRead: false,
                                     ttl: UploadPurpose.deviceTaskTTLSeconds,
                                     target: target(), deliveryKind: .text)
        try await keys.save(id: plan.jobId, keyB64url: encodeStoreKey(contentKey))
        return plan
    }

    /// One fixed content key for every delivery in this file, so the ciphertext
    /// a test opens is the ciphertext the coordinator sealed.
    private let contentKey = [UInt8](repeating: 0x2C, count: 32)

    private let folderSelection: [(name: String, bytes: [UInt8])] = [
        (name: "trip/day 1/IMG_0002.jpg", bytes: Array("second".utf8)),
        (name: "trip/day 1/IMG_0001.jpg", bytes: Array("first".utf8)),
        // An empty file is a real file: it earns a manifest item of size 0 and
        // contributes no payload frame at all.
        (name: "trip/notes/empty.txt", bytes: []),
        (name: "readme.md", bytes: Array("hello device inbox".utf8)),
    ]

    // MARK: - reading what actually left

    /// The plaintext manifest document of the ciphertext this delivery produced.
    private func sealedManifest() throws -> InboxManifestV2 {
        let header = try XCTUnwrap(transport.headers.last, "no upload session was opened")
        XCTAssertGreaterThan(header.count, 4)
        let n = Int(header[0]) << 24 | Int(header[1]) << 16 | Int(header[2]) << 8 | Int(header[3])
        XCTAssertEqual(header.count, 4 + n, "the length prefix does not describe the frame")
        return try InboxManifest.open(key: contentKey, sealed: Array(header[4...]))
    }

    /// Every payload frame's plaintext, concatenated in the order it was sent —
    /// which is the order the manifest's items claim.
    private func payloadPlaintext() throws -> [UInt8] {
        var out: [UInt8] = []
        var seq: UInt64 = 1
        var offset = 0
        let stream = transport.committed
        while offset + 4 <= stream.count {
            let n = Int(stream[offset]) << 24 | Int(stream[offset + 1]) << 16
                | Int(stream[offset + 2]) << 8 | Int(stream[offset + 3])
            offset += 4
            guard offset + n <= stream.count else { XCTFail("truncated frame"); break }
            let pt = try XCTUnwrap(open(key: contentKey, seq: seq,
                                        ciphertext: Array(stream[offset..<(offset + n)])),
                                   "frame \(seq) did not authenticate")
            out += pt
            offset += n
            seq += 1
        }
        XCTAssertEqual(offset, stream.count, "trailing bytes after the last frame")
        return out
    }

    // MARK: - a file delivery

    func testAFileDeliverySealsTheV2ManifestAtFrameZero() async throws {
        let plan = try await stagedFiles(folderSelection)
        sender.createOutcomes = [.success(InboxTaskCreation(task: task(), created: true))]

        _ = try await coordinator().deliver(plan, token: "bearer")

        let manifest = try sealedManifest()
        XCTAssertEqual(manifest.kind, .file)
        XCTAssertEqual(manifest.items.map(\.name), folderSelection.map(\.name), """
            item order is the SENDER's and is never sorted: item i describes the \
            payload frames of staged file i, so reordering renames every file
            """)
        XCTAssertEqual(manifest.items.map(\.size), folderSelection.map(\.bytes.count))
        XCTAssertEqual(manifest.items.map(\.kind), Array(repeating: .file,
                                                         count: folderSelection.count))
    }

    /// The "/"-separated hierarchy is inside the seal and nowhere else, and the
    /// payload arrives in exactly the order the manifest claims.
    func testTheEncryptedHierarchyAndPayloadOrderAgree() async throws {
        let plan = try await stagedFiles(folderSelection)
        sender.createOutcomes = [.success(InboxTaskCreation(task: task(), created: true))]

        _ = try await coordinator().deliver(plan, token: "bearer")

        XCTAssertEqual(try payloadPlaintext(), folderSelection.flatMap(\.bytes), """
            the frames are the items' bytes concatenated in item order, with an \
            empty file contributing nothing
            """)
        // The names travel encrypted. Nothing in what central was handed — the
        // create's fields or the framed header — spells one out.
        let header = try XCTUnwrap(transport.headers.last)
        for name in folderSelection.map(\.name) {
            XCTAssertFalse(contains(header, Array(name.utf8)),
                           "\(name) appeared in the ciphertext header in the clear")
        }
    }

    /// The shared Stored-Wire codec cannot read a delivery's frame 0, which is
    /// what makes "v2 senders write v2 manifests" checkable rather than assumed.
    func testTheSharedStoredWireCodecRefusesADeliveryManifest() async throws {
        let plan = try await stagedFiles(folderSelection)
        sender.createOutcomes = [.success(InboxTaskCreation(task: task(), created: true))]
        _ = try await coordinator().deliver(plan, token: "bearer")

        let header = try XCTUnwrap(transport.headers.last)
        XCTAssertThrowsError(try decryptManifestRaw(key: contentKey, Array(header[4...])), """
            a delivery's frame 0 must not also parse as the shared manifest: if \
            it did, the two formats would have started sharing bytes
            """)
    }

    /// And the reverse, on the path this stage exists to fix: a SHARE upload's
    /// frame 0 is still the shared manifest, byte for byte.
    func testAShareUploadStillSealsTheSharedManifestByteForByte() throws {
        let sources: [PlaintextSource] = [DataSource(name: "a.bin", bytes: [1, 2, 3])]
        let header = try CloudUploader.manifestHeader(key: contentKey, sources: sources)
        let expected = try encryptManifest(key: contentKey,
                                           StoredManifest(files: [ManifestFile(name: "a.bin",
                                                                               size: 3)]))
        XCTAssertEqual(Array(header[4...]), expected)
        XCTAssertEqual(try decryptManifestRaw(key: contentKey, Array(header[4...])).files.map(\.name),
                       ["a.bin"])
    }

    // MARK: - a message

    func testATextDeliverySealsOneTextItemCarryingOnlyItsLength() async throws {
        let message = "meet me at 6 — 会议室 B"
        let plan = try await stagedText(message)
        sender.createOutcomes = [.success(InboxTaskCreation(task: task(), created: true))]

        _ = try await coordinator().deliver(plan, token: "bearer")

        let manifest = try sealedManifest()
        XCTAssertEqual(manifest.kind, .text)
        XCTAssertEqual(manifest.items.count, 1, "one message per delivery")
        XCTAssertNil(manifest.items[0].name, """
            a text item has NO name key: an empty string is something a receiver \
            could be tempted to treat as a destination, an absent one cannot be
            """)
        XCTAssertEqual(manifest.items[0].size, Array(message.utf8).count,
                       "the length is in UTF-8 bytes, not characters")
    }

    /// The body is in the payload frames and in nothing else — not the manifest,
    /// not the create request.
    func testTheMessageBodyIsOnlyEverInThePayloadFrames() async throws {
        let message = "the passphrase is hunter2"
        let plan = try await stagedText(message)
        sender.createOutcomes = [.success(InboxTaskCreation(task: task(), created: true))]

        _ = try await coordinator().deliver(plan, token: "bearer")

        XCTAssertEqual(try payloadPlaintext(), Array(message.utf8))
        let header = try XCTUnwrap(transport.headers.last)
        XCTAssertFalse(contains(header, Array(message.utf8)),
                       "the message reached the manifest frame")
        // The create's own body, exactly as it goes on the wire.
        let request = try InboxSendRequest(idempotencyKey: idempotencyKey,
                                           storedFileID: "STORED0123456789",
                                           wrappedKey: try wrappedKey(),
                                           targetKeyID: keyID, targetKeyGeneration: 4)
        XCTAssertEqual(Set(request.payload.keys),
                       ["idempotencyKey", "storedFileId", "protocolVersion", "wrapAlgorithm",
                        "wrappedKey", "targetKeyId", "targetKeyGeneration"], """
            seven keys, the seventh a bare integer. No kind, text, message, \
            name, path, manifest or itemCount, ever
            """)
        XCTAssertEqual(request.payload["protocolVersion"] as? Int, 3)
        let body = try JSONSerialization.data(withJSONObject: request.payload)
        let text = try XCTUnwrap(String(data: body, encoding: .utf8))
        XCTAssertFalse(text.contains(message))
        for token in ["kind", "text", "message", "name", "path", "manifest"] {
            XCTAssertFalse(text.contains(token), "the create body mentioned \(token)")
        }
    }

    private func wrappedKey() throws -> String {
        try InboxKeyMaterial.sealContentKey(algorithm: InboxProtocol.keyAlgorithm,
                                            targetPublicKey: devicePublicKey,
                                            contentKey: contentKey)
    }

    // MARK: - bounds

    func testAMessageOutsideItsBoundsIsRefusedBeforeAnythingIsStaged() async throws {
        for bytes in [[UInt8](), [UInt8](repeating: 0x61,
                                         count: InboxManifest.maxTextBytes + 1)] {
            XCTAssertThrowsError(try store.prepare(
                sources: [DataSource(name: "message", bytes: bytes)],
                accountId: "acct-1", burnAfterRead: false,
                ttl: UploadPurpose.deviceTaskTTLSeconds, target: target(),
                deliveryKind: .text)) { error in
                XCTAssertEqual(error as? PendingUploadError, .unusableSelection)
            }
        }
        XCTAssertEqual(store.deviceSendPlans(for: "acct-1").count, 0,
                       "a refused message must leave nothing on disk")
    }

    /// Exactly at the ceiling is legal, and exactly one byte is the floor.
    func testTheMessageBoundsAreInclusive() async throws {
        for count in [InboxManifest.minTextBytes, InboxManifest.maxTextBytes] {
            let plan = try store.prepare(
                sources: [DataSource(name: "message",
                                     bytes: [UInt8](repeating: 0x61, count: count))],
                accountId: "acct-1", burnAfterRead: false,
                ttl: UploadPurpose.deviceTaskTTLSeconds,
                target: PendingUploadTarget(deviceId: deviceID, keyId: keyID, keyGeneration: 4),
                deliveryKind: .text)
            XCTAssertEqual(try InboxSendManifest.manifest(for: plan).items[0].size, count)
        }
    }

    /// A message is UTF-8 by construction on this platform — a Swift `String`
    /// cannot hold anything else — so what has to be checked is that the DECLARED
    /// length is the byte length rather than the character count.
    func testTheDeclaredLengthIsUTF8BytesNotCharacters() throws {
        let message = "🙂🙂"                       // 2 characters, 8 UTF-8 bytes
        XCTAssertEqual(message.count, 2)
        let manifest = try InboxManifest.text(size: Array(message.utf8).count)
        XCTAssertEqual(manifest.items[0].size, 8)
        XCTAssertEqual(String(decoding: try InboxManifest.encode(manifest), as: UTF8.self),
                       #"{"v":3,"items":[{"kind":"text","size":8}]}"#)
    }

    /// A name no receiver would accept fails the SEND rather than being sealed
    /// and left for the receiver to refuse after the upload.
    func testATraversalNameIsRefusedAtTheSenderAndNothingIsUploaded() async throws {
        let plan = try await stagedFiles([(name: "../../etc/passwd", bytes: [1])])
        do {
            _ = try await coordinator().deliver(plan, token: "bearer")
            XCTFail("a traversal name was sealed")
        } catch {
            XCTAssertEqual(error as? InboxSendFailure, .unsendableContent)
        }
        XCTAssertTrue(transport.purposes.isEmpty, "an upload session was opened anyway")
        XCTAssertEqual(sender.creates.count, 0)
    }

    // MARK: - the capability gate

    func testAMessageIsRefusedWhenTheTargetDoesNotPresentText() async throws {
        sender.deviceRows = [row(presentsText: false)]
        let plan = try await stagedText("hello")
        do {
            _ = try await coordinator().deliver(plan, token: "bearer")
            XCTFail("a message was sent to a device that would not present it")
        } catch {
            XCTAssertEqual(error as? InboxSendFailure, .textUnsupported)
        }
        XCTAssertTrue(transport.purposes.isEmpty, "the ciphertext was uploaded anyway")
        XCTAssertEqual(sender.creates.count, 0)
    }

    /// The other half of the rule, and the more important one: a FILE delivery
    /// must not consult `inbox.text.v1` at all. Requiring it would refuse
    /// ordinary file sends to the CLI, to iOS, and to every other build that
    /// receives perfectly well and renders no messages.
    func testAFileDeliveryDoesNotRequireTheTextCapability() async throws {
        sender.deviceRows = [row(presentsText: false)]
        let plan = try await stagedFiles([(name: "a.txt", bytes: Array("hi".utf8))])
        sender.createOutcomes = [.success(InboxTaskCreation(task: task(), created: true))]

        let result = try await coordinator().deliver(plan, token: "bearer")

        XCTAssertEqual(result.task.id, taskID)
        XCTAssertEqual(transport.purposes, [.deviceTask])
        XCTAssertEqual(try sealedManifest().kind, .file)
    }

    /// A device whose receive FOLDER is unusable can still be sent a message.
    /// The folder is a file caveat: a message is never written there, and the
    /// receiver decides the kind before it consults the folder at all.
    func testAnUnusableReceiveFolderDoesNotSuppressText() throws {
        let unready = row(receiveDirReady: false)
        XCTAssertTrue(InboxTargetEligibility.canReceiveText(unready))
        XCTAssertNotNil(InboxTargetEligibility.textTarget(for: unready))
        XCTAssertEqual(InboxTargetEligibility.availability(for: unready).caveats,
                       [.directoryNotReady], "the folder stays a truthful FILE caveat")
        XCTAssertTrue(InboxTargetEligibility.availability(for: unready).sendable)
    }

    func testTextEligibilityFollowsTheAnnouncedToken() throws {
        XCTAssertTrue(InboxTargetEligibility.canReceiveText(row(presentsText: true)))
        XCTAssertFalse(InboxTargetEligibility.canReceiveText(row(presentsText: false)))
        XCTAssertNil(InboxTargetEligibility.textTarget(for: row(presentsText: false)))
        // Every file-send rule still applies on top of the token.
        XCTAssertFalse(InboxTargetEligibility.canReceiveText(
            InboxDeviceRow(id: deviceID, name: "Browser", kind: "app", isCurrent: false,
                           inbox: nil)))
    }

    // MARK: - every attempt agrees

    /// The header is a pure function of (key, plan), so a session the idle
    /// reaper took is replaced by a byte-identical one — the property that lets a
    /// restarted upload be the upload it replaces.
    func testAReapedSessionRebuildsTheIdenticalHeader() async throws {
        let plan = try await stagedFiles(folderSelection)
        let first = try CloudUploader.manifestHeader(
            key: contentKey, sources: try store.sources(for: plan),
            manifest: try InboxSendManifest.sealed(for: plan))
        let second = try CloudUploader.manifestHeader(
            key: contentKey, sources: try store.sources(for: plan),
            manifest: try InboxSendManifest.sealed(for: plan))
        XCTAssertEqual(first, second)
    }

    /// A create refused as `stale_target_key` is retried after re-reading the
    /// device and resealing the content key. The manifest is rebuilt from the
    /// same plan, so the delivery is still a MESSAGE — a reseal that fell back
    /// to a file manifest would be refused by the receiver as `verify_failed`.
    func testAResealAfterAKeyRotationStillSealsTheTextKind() async throws {
        let plan = try await stagedText("still a message")
        sender.createOutcomes = [
            .failure(InboxError.api(status: 409, code: InboxRejection.staleTargetKey.rawValue)),
            .success(InboxTaskCreation(task: task(keyID: rotatedKeyID, generation: 5),
                                       created: true)),
        ]
        // The rotation becomes visible only after the first create was refused,
        // which is exactly the race the reseal branch exists for.
        sender.beforeCreate = { [self] attempt in
            if attempt == 0 {
                sender.deviceRows = [row(keyID: rotatedKeyID, publicKey: rotatedPublicKey,
                                         generation: 5)]
            }
        }

        let result = try await coordinator().deliver(plan, token: "bearer")

        XCTAssertTrue(result.resealed)
        XCTAssertEqual(sender.creates.count, 2)
        XCTAssertEqual(try sealedManifest().kind, .text)
        XCTAssertEqual(transport.initCount, 1, "no byte was re-uploaded for a reseal")
    }

    /// A retry in a process that never staged the delivery rebuilds the same
    /// manifest from the plan on disk alone.
    func testARetryFromTheDurablePlanAloneRebuildsTheSameManifest() async throws {
        let plan = try await stagedText("read from disk")
        let reread = try XCTUnwrap(store.deviceSendPlans(for: "acct-1").first)
        XCTAssertEqual(reread.effectiveDeliveryKind, .text)
        XCTAssertEqual(try InboxSendManifest.sealed(for: plan),
                       try InboxSendManifest.sealed(for: reread))
    }

    /// A plan written before text sending existed has no `deliveryKind` at all,
    /// and reads back as the file delivery it was. That is duplicate- and
    /// data-loss safety for an interrupted upload, not v1 compatibility.
    func testAPlanWithNoRecordedKindIsAFileDelivery() async throws {
        let plan = try await stagedFiles([(name: "a.txt", bytes: [1, 2])])
        XCTAssertNil(plan.deliveryKind, "a file plan records nothing, so its bytes are unchanged")
        XCTAssertEqual(plan.effectiveDeliveryKind, .file)
        XCTAssertEqual(try InboxSendManifest.manifest(for: plan).kind, .file)
    }

    // MARK: - the purpose/manifest pairing

    func testAPurposeMaySealExactlyOneDocument() {
        XCTAssertTrue(uploadManifestMatches(purpose: .share, manifest: .storedWire))
        XCTAssertTrue(uploadManifestMatches(purpose: .deviceTask, manifest: .sealed([0x7b])))
        XCTAssertFalse(uploadManifestMatches(purpose: .deviceTask, manifest: .storedWire), """
            a delivery sealing the shared manifest is refused by its own receiver \
            as verify_failed, after the whole ciphertext has been uploaded
            """)
        XCTAssertFalse(uploadManifestMatches(purpose: .share, manifest: .sealed([0x7b])), """
            a share sealing a v2 manifest is a download page that cannot read \
            its own file list
            """)
    }

    /// A share plan may not carry a content kind at all: its frame 0 has no room
    /// for one, so a plan claiming otherwise is two builds disagreeing.
    func testAShareCannotBeAMessage() throws {
        XCTAssertThrowsError(try store.prepare(
            sources: [DataSource(name: "message", bytes: Array("hi".utf8))],
            accountId: "acct-1", burnAfterRead: false, ttl: 3600,
            target: nil, deliveryKind: .text)) { error in
            XCTAssertEqual(error as? PendingUploadError, .unusableSelection)
        }
    }

    // MARK: - helpers

    private func contains(_ haystack: [UInt8], _ needle: [UInt8]) -> Bool {
        guard !needle.isEmpty, haystack.count >= needle.count else { return false }
        for start in 0...(haystack.count - needle.count) {
            if Array(haystack[start..<(start + needle.count)]) == needle { return true }
        }
        return false
    }
}
