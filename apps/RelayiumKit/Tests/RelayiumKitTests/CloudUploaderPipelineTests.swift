import XCTest
import CryptoKit
@testable import RelayiumKit

private final class PipelineCountingSource: PlaintextSource, @unchecked Sendable {
    let name = "pipeline.bin"
    let bytes: [UInt8]
    private let lock = NSLock()
    private var position = 0
    private var reads = 0
    var size: Int { bytes.count }
    init(_ bytes: [UInt8]) { self.bytes = bytes }
    func read(_ max: Int) throws -> [UInt8] {
        lock.lock(); defer { lock.unlock() }
        guard position < bytes.count else { return [] }
        let end = min(bytes.count, position + max)
        let value = Array(bytes[position..<end]); position = end; reads += 1
        return value
    }
    var readCount: Int { lock.lock(); defer { lock.unlock() }; return reads }
}

private actor PipelineTestTransport: PipelinedResumableTransport {
    struct Record { let from: Int; let bytes: [UInt8] }
    struct Snapshot: Sendable {
        let count: Int, active: Int, peak: Int, finalized: Int, gets: Int, serial: Int
        let badResync: Bool, badFinalize: Bool
        let committed: [UInt8]
    }
    let marker: String?
    let reportSuccessorBody: Bool
    let serialError: CloudError?
    var callbacks: [Int: @Sendable (Int) -> Void] = [:]
    var records: [Record] = []
    var pending: [Int: CheckedContinuation<PatchOutcome, Error>] = [:]
    var committed: [UInt8] = []
    var active = 0, peak = 0, finalized = 0, gets = 0, serial = 0, total = 0
    var badResync = false, badFinalize = false
    var staleStatusOnce: Int?
    init(marker: String? = "ordered-v1", reportSuccessorBody: Bool = true, serialError: CloudError? = nil) { self.marker = marker; self.reportSuccessorBody = reportSuccessorBody; self.serialError = serialError }
    func initUpload(header: [UInt8], purpose: UploadPurpose, burnAfterRead: Bool, ttl: Int,
                    size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) {
        total = size; return ("up1", STORE_CHUNK_SIZE)
    }
    func initPipelinedUpload(header: [UInt8], purpose: UploadPurpose, burnAfterRead: Bool,
                             ttl: Int, size: Int, token: String) async throws -> PipelinedUploadSession {
        total = size
        return PipelinedUploadSession(uploadId: "up1", chunkSize: STORE_CHUNK_SIZE, pipelineVersion: marker)
    }
    func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int, total: Int,
                    token: String, onBytesSent: ((Int) -> Void)?) async throws -> PatchOutcome {
        serial += 1
        if let serialError { throw serialError }
        if from != committed.count { return .serverAhead(received: committed.count) }
        committed += [UInt8](bytes)
        onBytesSent?(bytes.count)
        return .committed(received: committed.count)
    }
    func patchPipelinedChunk(uploadId: String, bytes: Data, from: Int, to: Int, total: Int,
                             token: String, onBytesSent: (@Sendable (Int) -> Void)?) async throws -> PatchOutcome {
        let id = records.count
        // A fixture server owns its received copy, not the client's Data view.
        records.append(Record(from: from, bytes: [UInt8](bytes)))
        active += 1; peak = max(peak, active)
        defer { active -= 1 }
        callbacks[id] = onBytesSent
        onBytesSent?(id == 0 || reportSuccessorBody ? bytes.count : 0)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                if Task.isCancelled { continuation.resume(throwing: CancellationError()) }
                else { pending[id] = continuation }
            }
        } onCancel: { Task { await self.cancel(id) } }
    }
    func cancel(_ id: Int) { pending.removeValue(forKey: id)?.resume(throwing: CancellationError()) }
    func lateProgress(_ id: Int) { callbacks[id]?(Int.max) }
    func commit(_ id: Int, reply: Bool = true) throws {
        let record = records[id]
        guard record.from == committed.count else { throw CloudError.server(status: 0) }
        committed += record.bytes
        if reply { pending.removeValue(forKey: id)?.resume(returning: .committed(received: committed.count)) }
    }
    func reply(_ id: Int, received: Int) { pending.removeValue(forKey: id)?.resume(returning: .committed(received: received)) }
    func fail(_ id: Int, partial: Int = 0, staleStatus: Int? = nil) throws {
        let record = records[id]
        if partial > 0 {
            guard record.from == committed.count else { throw CloudError.server(status: 0) }
            committed += record.bytes.prefix(partial)
        }
        staleStatusOnce = staleStatus
        pending.removeValue(forKey: id)?.resume(throwing: CloudError.network)
    }
    func uploadOffset(uploadId: String, token: String) async throws -> Int {
        gets += 1; if active != 0 { badResync = true }
        if let stale = staleStatusOnce { staleStatusOnce = nil; return stale }
        return committed.count
    }
    func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult {
        finalized += 1
        if active != 0 || committed.count != total { badFinalize = true }
        return UploadResult(id: "fid", expiresAt: 4242)
    }
    func snapshot() -> Snapshot {
        Snapshot(count: records.count, active: active, peak: peak, finalized: finalized, gets: gets,
                 serial: serial, badResync: badResync, badFinalize: badFinalize, committed: committed)
    }
}

final class CloudUploaderPipelineTests: XCTestCase {
    private func wait(_ condition: () async -> Bool) async throws {
        let end = ContinuousClock.now.advanced(by: .seconds(2))
        while !(await condition()) {
            if ContinuousClock.now >= end { XCTFail("fixture state did not arrive"); throw CloudError.network }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
    }
    private func plain(_ count: Int = STORE_CHUNK_SIZE * 3 + 11) -> [UInt8] {
        (0..<count).map { UInt8(truncatingIfNeeded: $0 * 31) }
    }
    private func authenticate(_ outcome: UploadOutcome, _ ciphertext: [UInt8], _ plain: [UInt8]) throws {
        let decryptor = StoreDecryptor(key: try decodeStoreKey(outcome.keyB64url))
        let actual = try decryptor.push(ciphertext).flatMap { $0 }
        try decryptor.end(expectedBytes: plain.count)
        XCTAssertEqual(SHA256.hash(data: Data(actual)), SHA256.hash(data: Data(plain)))
    }

    func testTwoRequestsOverlapConfirmationAndAuthenticateWholeFile() async throws {
        let transport = PipelineTestTransport(), bytes = plain()
        let source = PipelineCountingSource(bytes), uploader = CloudUploader(transport: transport)
        let task = Task { try await uploader.upload(sources: [source], burnAfterRead: false,
            ttl: 3600, token: "fixture", onProgress: { _, _ in }) }
        do {
            try await wait { await transport.snapshot().count == 2 }
            let held = await transport.snapshot()
            XCTAssertEqual(held.active, 2); XCTAssertTrue(held.committed.isEmpty); XCTAssertEqual(held.finalized, 0)
            for i in 0..<4 {
                try await wait { await transport.snapshot().count > i }
                try await transport.commit(i)
            }
            let outcome = try await task.value, final = await transport.snapshot()
            XCTAssertEqual(final.peak, 2); XCTAssertEqual(final.active, 0); XCTAssertEqual(final.finalized, 1)
            XCTAssertFalse(final.badFinalize); XCTAssertFalse(final.badResync); XCTAssertEqual(source.readCount, 4)
            XCTAssertLessThanOrEqual(uploader.bufferPeak, 2 * (STORE_CHUNK_SIZE * 2 + FRAME_OVERHEAD))
            try authenticate(outcome, final.committed, bytes)
        } catch { task.cancel(); _ = try? await task.value; throw error }
    }

    func testNegotiatedFailureNeverStartsAnotherWholeFileUpload() async throws {
        let transport = PipelineTestTransport(serialError: .server(status: 503))
        let uploader = CloudUploader(transport: transport)
        uploader.pacing.sleep = { _ in try Task.checkCancellation() }
        let fallback = PipelineFallbackCounter()
        let source = PipelineCountingSource(plain())
        let task = Task { try await uploader.uploadResumable(
            sources: [source],
            singleShot: { _, _, _ in
                fallback.increment()
                return SingleShotResult(result: UploadResult(id: "fid", expiresAt: 4242), keyB64url: "fixture")
            }, burnAfterRead: false, ttl: 3600, token: "fixture", onProgress: { _, _ in }) }
        do {
            try await wait { await transport.snapshot().count == 2 }
            try await transport.fail(0, partial: 1000)
            do { _ = try await task.value; XCTFail("failed upload was replaced with a new whole-file upload") }
            catch let error as CloudError { XCTAssertEqual(error, .server(status: 503)) }
            let final = await transport.snapshot()
            XCTAssertEqual(fallback.count, 0); XCTAssertEqual(final.finalized, 0)
            XCTAssertEqual(final.active, 0); XCTAssertGreaterThan(final.serial, 0)
        } catch { task.cancel(); _ = try? await task.value; throw error }
    }

    func testLostPartialAnswerDrainsSuccessorBeforeSerialReplay() async throws {
        let transport = PipelineTestTransport(), bytes = plain()
        let source = PipelineCountingSource(bytes), uploader = CloudUploader(transport: transport)
        let task = Task { try await uploader.upload(sources: [source], burnAfterRead: false,
            ttl: 3600, token: "fixture", onProgress: { _, _ in }) }
        do {
            try await wait { await transport.snapshot().count == 2 }
            try await transport.fail(0, partial: 1000)
            let outcome = try await task.value, final = await transport.snapshot()
            XCTAssertEqual(final.active, 0); XCTAssertEqual(final.finalized, 1)
            XCTAssertGreaterThan(final.gets, 0); XCTAssertGreaterThan(final.serial, 0)
            XCTAssertFalse(final.badResync); XCTAssertFalse(final.badFinalize); XCTAssertEqual(source.readCount, 4)
            try authenticate(outcome, final.committed, bytes)
        } catch { task.cancel(); _ = try? await task.value; throw error }
    }

    func testLateCumulativeOffsetConsumesOnlyRetainedReplayBytes() async throws {
        let transport = PipelineTestTransport(), bytes = plain()
        let source = PipelineCountingSource(bytes), uploader = CloudUploader(transport: transport)
        let task = Task { try await uploader.upload(sources: [source], burnAfterRead: false,
            ttl: 3600, token: "fixture", onProgress: { _, _ in }) }
        do {
            try await wait { await transport.snapshot().count == 2 }
            try await transport.commit(0, reply: false); try await transport.commit(1, reply: false)
            // Both bytes landed but neither answer did; one stale status read
            // forces recovery to hear the later cumulative offset from PATCH.
            try await transport.fail(0, staleStatus: 0)
            let outcome = try await task.value, final = await transport.snapshot()
            XCTAssertEqual(final.active, 0); XCTAssertEqual(final.finalized, 1)
            XCTAssertFalse(final.badResync); XCTAssertFalse(final.badFinalize); XCTAssertEqual(source.readCount, 4)
            try authenticate(outcome, final.committed, bytes)
        } catch { task.cancel(); _ = try? await task.value; throw error }
    }

    func testUserCancellationJoinsBothWithoutStatusOrFinalize() async throws {
        let transport = PipelineTestTransport(), source = PipelineCountingSource(plain())
        let uploader = CloudUploader(transport: transport)
        let task = Task { try await uploader.upload(sources: [source], burnAfterRead: false,
            ttl: 3600, token: "fixture", onProgress: { _, _ in }) }
        do {
            try await wait { await transport.snapshot().count == 2 }
            task.cancel()
            do { _ = try await task.value; XCTFail("cancelled upload succeeded") } catch is CancellationError {}
            let final = await transport.snapshot()
            XCTAssertEqual(final.active, 0); XCTAssertEqual(final.gets, 0); XCTAssertEqual(final.finalized, 0)
        } catch { task.cancel(); _ = try? await task.value; throw error }
    }

    func testUnknownCapabilityUsesSerialTransport() async throws {
        let transport = PipelineTestTransport(marker: "later-v2"), bytes = plain()
        let source = PipelineCountingSource(bytes), uploader = CloudUploader(transport: transport)
        let outcome = try await uploader.upload(sources: [source], burnAfterRead: false,
            ttl: 3600, token: "fixture", onProgress: { _, _ in })
        let final = await transport.snapshot()
        XCTAssertEqual(final.count, 0); XCTAssertEqual(final.finalized, 1); XCTAssertGreaterThan(final.serial, 0)
        try authenticate(outcome, final.committed, bytes)
    }

    func testLateProgressAfterCancellationCannotRelabelTheUpload() async throws {
        let transport = PipelineTestTransport(reportSuccessorBody: false)
        let source = PipelineCountingSource(plain()), progress = PipelineProgressBox()
        let uploader = CloudUploader(transport: transport)
        let task = Task { try await uploader.upload(sources: [source], burnAfterRead: false,
            ttl: 3600, token: "fixture", onProgress: { n, _ in progress.append(n) }) }
        do {
            try await wait { await transport.snapshot().count == 2 }
            task.cancel()
            do { _ = try await task.value; XCTFail("cancelled upload succeeded") } catch is CancellationError {}
            let before = progress.values
            await transport.lateProgress(1)
            XCTAssertEqual(progress.values, before)
        } catch { task.cancel(); _ = try? await task.value; throw error }
    }

    func testReverseAnswersCannotFinalizeWhileAnEarlierOwnerIsLive() async throws {
        let transport = PipelineTestTransport(), bytes = plain(STORE_CHUNK_SIZE + 7)
        let source = PipelineCountingSource(bytes), uploader = CloudUploader(transport: transport)
        let task = Task { try await uploader.upload(sources: [source], burnAfterRead: false,
            ttl: 3600, token: "fixture", onProgress: { _, _ in }) }
        do {
            try await wait { await transport.snapshot().count == 2 }
            try await transport.commit(0, reply: false); try await transport.commit(1)
            try await wait { await transport.snapshot().active == 1 }
            let held = await transport.snapshot(); XCTAssertEqual(held.finalized, 0)
            await transport.reply(0, received: STORE_CHUNK_SIZE + FRAME_OVERHEAD)
            let outcome = try await task.value, final = await transport.snapshot()
            XCTAssertEqual(final.active, 0); XCTAssertEqual(final.finalized, 1); XCTAssertFalse(final.badFinalize)
            try authenticate(outcome, final.committed, bytes)
        } catch { task.cancel(); _ = try? await task.value; throw error }
    }

    func testUnsentOffsetIsRefusedAndOtherOwnerIsJoined() async throws {
        let transport = PipelineTestTransport(), bytes = plain()
        let uploader = CloudUploader(transport: transport)
        let task = Task { try await uploader.upload(sources: [PipelineCountingSource(bytes)], burnAfterRead: false,
            ttl: 3600, token: "fixture", onProgress: { _, _ in }) }
        do {
            try await wait { await transport.snapshot().count == 2 }
            await transport.reply(0, received: cipherSizeFor([bytes.count]))
            do { _ = try await task.value; XCTFail("unsent offset accepted") }
            catch let error as CloudError { XCTAssertEqual(error, .server(status: 0)) }
            let final = await transport.snapshot()
            XCTAssertEqual(final.active, 0); XCTAssertEqual(final.gets, 0); XCTAssertEqual(final.finalized, 0)
        } catch { task.cancel(); _ = try? await task.value; throw error }
    }

    func testHTTPTransportOptsInOnlyForNegotiatedRequests() async throws {
        PipelineWireProtocol.state.reset()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PipelineWireProtocol.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let transport = HTTPResumableTransport(baseURL: URL(string: "https://pipeline.invalid")!, session: session)
        let issued = try await transport.initPipelinedUpload(header: [0,0,0,1,1], purpose: .share,
            burnAfterRead: false, ttl: 3600, size: 2, token: "fixture")
        XCTAssertTrue(issued.supportsPipeline)
        _ = try await transport.patchPipelinedChunk(uploadId: issued.uploadId, bytes: Data([1,2]),
            from: 0, to: 2, total: 2, token: "fixture", onBytesSent: nil)
        _ = try await transport.patchChunk(uploadId: issued.uploadId, bytes: Data([1,2]),
            from: 0, to: 2, total: 2, token: "fixture", onBytesSent: nil)
        let requests = PipelineWireProtocol.state.requests
        XCTAssertEqual(requests.count, 3)
        XCTAssertEqual(requests[1], "ordered-v1")
        XCTAssertNil(requests[2])
    }
}

private final class PipelineProgressBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [Int] = []
    func append(_ n: Int) { lock.lock(); stored.append(n); lock.unlock() }
    var values: [Int] { lock.lock(); defer { lock.unlock() }; return stored }
}

private final class PipelineWireState: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String?] = []
    func reset() { lock.lock(); values = []; lock.unlock() }
    func append(_ value: String?) { lock.lock(); values.append(value); lock.unlock() }
    var requests: [String?] { lock.lock(); defer { lock.unlock() }; return values }
}

private final class PipelineWireProtocol: URLProtocol, @unchecked Sendable {
    static let state = PipelineWireState()
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "pipeline.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.state.append(request.value(forHTTPHeaderField: "X-Relayium-Upload-Pipeline"))
        let value = request.httpMethod == "POST"
            ? "{\"uploadId\":\"up1\",\"chunkSize\":65536,\"uploadPipeline\":\"ordered-v1\"}"
            : "{\"received\":2}"
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type":"application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(value.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private final class PipelineFallbackCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    func increment() { lock.lock(); value += 1; lock.unlock() }
    var count: Int { lock.lock(); defer { lock.unlock() }; return value }
}
