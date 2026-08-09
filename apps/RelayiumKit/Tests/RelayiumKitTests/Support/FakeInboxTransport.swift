import Foundation
@testable import RelayiumAppKit
@testable import RelayiumKit

/// A scriptable stand-in for central, and the reason the receiver's interesting
/// behaviour is reachable at all.
///
/// The failures that matter here are ones no URL stub can produce on demand: a
/// lease refused between two frames of a download, a resume answered with a full
/// body, a report that lands after the task went terminal, a claim that returns
/// nothing after pending said there was work. Each is one line of script here.
///
/// Every call is recorded in order, because several assertions are about what was
/// NOT sent — a report after an abandon, a second claim in one pass — and an
/// absence can only be asserted against a complete record.
/// Not `final`: two enrolment tests subclass it to echo back the key material
/// they were handed, or to observe WHEN a registration happens relative to the
/// local durable write. The ordering is the invariant there, and a test that
/// only checked the end state would pass on either order.
class FakeInboxTransport: InboxTransport, @unchecked Sendable {

    enum Call: Equatable {
        case currentDevice
        case enrol(autoAccept: InboxAutoAccept, receiveDirReady: Bool)
        case registerKey(publicKey: String, previousKeyID: String?)
        case listKeys
        case heartbeat(receiveDirReady: Bool)
        case offline
        case pending(limit: Int)
        case claim(max: Int)
        case blob(taskID: String, claimToken: String, offset: Int64)
        case report(taskID: String, state: InboxTaskState,
                    code: InboxDeviceErrorCode, committed: Bool)
        case accept(taskID: String, accept: Bool)
        case clearInbox
    }

    private let lock = NSLock()
    private var _calls: [Call] = []

    var calls: [Call] { sync { _calls } }
    private func record(_ call: Call) { sync { _calls.append(call) } }

    /// Non-`async` on purpose: taking an `NSLock` directly inside an `async`
    /// function is an error under the Swift 6 language mode.
    @discardableResult
    private func sync<T>(_ body: () -> T) -> T {
        lock.lock(); defer { lock.unlock() }
        return body()
    }

    // MARK: - script

    var currentDeviceResult: Result<InboxDeviceRow, Error> = .failure(InboxError.noCurrentDevice)
    var enrolResult: Result<InboxEnrolResult, Error> = .failure(InboxError.network)
    /// Consumed in order; the last one repeats.
    var registerKeyResults: [Result<InboxKey, Error>] = []
    var listKeysResult: Result<[InboxKey], Error> = .success([])
    var heartbeatResult: Result<InboxHeartbeatResult, Error> =
        .success(InboxHeartbeatResult(presence: .online))
    var pendingResults: [Result<[InboxTask], Error>] = [.success([])]
    var claimResult: Result<(deliveries: [InboxDelivery], leaseSeconds: Int), Error> =
        .success((deliveries: [], leaseSeconds: 300))
    var acceptResult: Result<InboxTask, Error> = .success(InboxTask(id: "t", state: .queued))

    /// The ciphertext this fake serves, and how it serves it.
    var blobBody: Data = Data()
    /// Chunk size the body is delivered in, so a test can put a lease renewal or
    /// a transport failure between two frames.
    var blobChunkSize = 1 << 20
    /// Fail the Nth (1-based) blob read part way through, after `blobFailAfter`
    /// bytes. Nil never fails.
    var blobFailAttempt: Int?
    var blobFailAfter = 0
    /// Answer a resumed read with a full `200` instead of a `206`.
    var blobIgnoresRange = false
    /// Throw this instead of opening a stream.
    var blobError: Error?
    private var blobAttempts = 0

    /// Report outcomes, matched by state and consumed in order; anything with no
    /// script succeeds.
    var reportErrors: [InboxTaskState: [Error]] = [:]
    /// Called before each report resolves, so a test can observe ordering.
    var onReport: ((InboxTaskState, InboxDeviceErrorCode, Bool) -> Void)?

    // MARK: - InboxTransport

    func currentDevice() async throws -> InboxDeviceRow {
        record(.currentDevice)
        return try currentDeviceResult.get()
    }

    func enrol(_ request: InboxEnrolRequest) async throws -> InboxEnrolResult {
        record(.enrol(autoAccept: request.autoAccept, receiveDirReady: request.receiveDirReady))
        return try enrolResult.get()
    }

    func registerKey(algorithm: String, publicKey: String,
                     previousKeyID: String?) async throws -> InboxKey {
        record(.registerKey(publicKey: publicKey, previousKeyID: previousKeyID))
        let result = sync {
            registerKeyResults.count > 1
                ? registerKeyResults.removeFirst() : registerKeyResults.first
        }
        guard let result else { throw InboxError.network }
        return try result.get()
    }

    func listKeys() async throws -> [InboxKey] {
        record(.listKeys)
        return try listKeysResult.get()
    }

    @discardableResult
    func heartbeat(receiveDirReady: Bool) async throws -> InboxHeartbeatResult {
        record(.heartbeat(receiveDirReady: receiveDirReady))
        return try heartbeatResult.get()
    }

    func goOffline() async throws { record(.offline) }

    func pending(limit: Int) async throws -> [InboxTask] {
        record(.pending(limit: limit))
        let result = sync {
            pendingResults.count > 1 ? pendingResults.removeFirst() : pendingResults.first
        }
        return try (result ?? .success([])).get()
    }

    func claim(max: Int) async throws -> (deliveries: [InboxDelivery], leaseSeconds: Int) {
        record(.claim(max: max))
        return try claimResult.get()
    }

    func blob(taskID: String, claimToken: String, offset: Int64) async throws -> InboxBlobStream {
        record(.blob(taskID: taskID, claimToken: claimToken, offset: offset))
        if let blobError { throw blobError }
        let attempt = sync { blobAttempts += 1; return blobAttempts }

        let honoursRange = offset == 0 || !blobIgnoresRange
        let start = honoursRange ? Int(offset) : 0
        guard start <= blobBody.count else { throw InboxError.api(status: 416, code: "") }
        let tail = blobBody.suffix(from: start)

        let failAfter = (attempt == blobFailAttempt) ? blobFailAfter : nil
        let chunkSize = blobChunkSize
        let stream = AsyncThrowingStream<Data, Error> { continuation in
            var sent = 0
            var index = tail.startIndex
            while index < tail.endIndex {
                if let failAfter, sent >= failAfter {
                    continuation.finish(throwing: URLError(.networkConnectionLost))
                    return
                }
                let end = tail.index(index, offsetBy: chunkSize, limitedBy: tail.endIndex)
                    ?? tail.endIndex
                continuation.yield(Data(tail[index..<end]))
                sent += tail.distance(from: index, to: end)
                index = end
            }
            if let failAfter, sent >= failAfter, failAfter < tail.count {
                continuation.finish(throwing: URLError(.networkConnectionLost))
                return
            }
            continuation.finish()
        }
        return InboxBlobStream(status: offset > 0 && honoursRange ? 206 : 200,
                               isPartial: offset > 0 && honoursRange,
                               chunks: stream)
    }

    @discardableResult
    func report(taskID: String, claimToken: String, state: InboxTaskState,
                errorCode: InboxDeviceErrorCode, committed: Bool) async throws -> InboxTask {
        record(.report(taskID: taskID, state: state, code: errorCode, committed: committed))
        onReport?(state, errorCode, committed)
        let error = sync {
            reportErrors[state]?.isEmpty == false ? reportErrors[state]!.removeFirst() : nil
        }
        if let error { throw error }
        return InboxTask(id: taskID, state: state, errorCode: .device(errorCode))
    }

    @discardableResult
    func accept(taskID: String, accept: Bool) async throws -> InboxTask {
        record(.accept(taskID: taskID, accept: accept))
        return try acceptResult.get()
    }

    func clearInbox() async throws { record(.clearInbox) }
}

// MARK: - fixtures

enum InboxFixture {
    /// Build a real Stored Wire object: an encrypted manifest and the framed
    /// ciphertext, with a fresh content key sealed to `deviceKey`.
    ///
    /// Real bytes, not a stub. Every property the receiver is asserted on — that a
    /// tampered frame is refused, that a truncated stream leaves nothing, that
    /// sizes match — is only meaningful against ciphertext an actual sender would
    /// have produced.
    static func delivery(taskID: String = "task1", files: [(String, [UInt8])],
                         deviceKey: InboxDeviceKeyPair, keyID: String = "key1",
                         claimToken: String = "claim-token",
                         contentKey: [UInt8]? = nil)
        throws -> (delivery: InboxDelivery, ciphertext: Data, contentKey: [UInt8]) {
        let key = contentKey ?? generateStoreKey()
        let manifest = StoredManifest(files: files.map { ManifestFile(name: $0.0, size: $0.1.count) })
        let encManifest = try encryptManifest(key: key, manifest)
        let ciphertext = Data(encryptChunks(key: key, files: files.map { $0.1 }))
        let sealed = try seal(contentKey: key, to: deviceKey.publicKey)
        let task = InboxTask(id: taskID, storedFileID: "obj1", state: .downloading,
                             ciphertextBytes: Int64(ciphertext.count),
                             targetKeyID: keyID)
        let delivery = InboxDelivery(task: task,
                                     encManifest: Data(encManifest).base64EncodedString(),
                                     wrappedKey: InboxKeyMaterial.encode(sealed),
                                     claimToken: claimToken)
        return (delivery, ciphertext, key)
    }

    /// `crypto_box_seal`, built here rather than taken from the implementation
    /// under test: a fixture that called the product's own sealing code would make
    /// every interoperability claim a self round trip.
    static func seal(contentKey: [UInt8], to publicKey: [UInt8]) throws -> [UInt8] {
        guard let sealed = sodium.box.seal(message: contentKey, recipientPublicKey: publicKey) else {
            throw InboxKeyError.unseal
        }
        return sealed
    }
}
