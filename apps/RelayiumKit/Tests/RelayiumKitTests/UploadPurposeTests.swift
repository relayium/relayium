import XCTest
@testable import RelayiumKit

/// Purpose threading through the native resumable upload.
///
/// The property this file exists for is narrow and load-bearing: **the purpose
/// on the wire is the purpose the caller named, on BOTH init paths.** There are
/// two, and only one of them is obvious:
///
///  - the fresh init at the start of an upload;
///  - the init that replaces a session the server's idle reaper collected. That
///    one runs minutes or hours later, in a process that may never have seen the
///    send begin, and a `share` default there would silently republish a device
///    delivery as a public object.
///
/// The wire assertions run against the REAL `HTTPResumableTransport`, because a
/// fake that receives `purpose` proves the argument travelled inside this
/// process and nothing about the query string that leaves it.
final class UploadPurposeTests: XCTestCase {

    private let base = URL(string: "https://relayium.test")!

    override func tearDown() {
        StubURLProtocol.stub = nil
        StubURLProtocol.router = nil
        super.tearDown()
    }

    private func transport() -> HTTPResumableTransport {
        HTTPResumableTransport(baseURL: base, session: StubURLProtocol.session())
    }

    private func query(_ request: URLRequest) -> [String: String] {
        let comps = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)
        return Dictionary(uniqueKeysWithValues:
            (comps?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
    }

    // MARK: - the vocabulary

    func testThePurposeTokensAreTheOnesTheServerParses() {
        XCTAssertEqual(UploadPurpose.share.rawValue, "share")
        XCTAssertEqual(UploadPurpose.deviceTask.rawValue, "device_task")
        XCTAssertEqual(Set(UploadPurpose.allCases.map(\.rawValue)), ["share", "device_task"])
        XCTAssertNil(UploadPurpose(rawValue: "deviceTask"))
        XCTAssertNil(UploadPurpose(rawValue: ""))
        XCTAssertEqual(UploadPurpose.deviceTaskTTLSeconds, 86_400)
    }

    func testOnlyAShareMayBeBurnAfterRead() {
        XCTAssertTrue(UploadPurpose.share.allowsBurnAfterRead)
        XCTAssertFalse(UploadPurpose.deviceTask.allowsBurnAfterRead)
    }

    // MARK: - the init request

    /// Explicit on every request, for both purposes. The web sender omits a
    /// default `share` and lets the server backfill it; a native client that
    /// relied on that would be one refactor away from uploading a delivery as a
    /// public object.
    func testInitAlwaysCarriesAnExplicitPurpose() async throws {
        for purpose in UploadPurpose.allCases {
            StubURLProtocol.reset()
            StubURLProtocol.stub = .init(status: 200, body: Data(
                #"{"uploadId":"UPLOAD0000000001","chunkSize":8388608}"#.utf8))
            _ = try await transport().initUpload(
                header: [1, 2, 3], purpose: purpose,
                burnAfterRead: false, ttl: 86_400, size: 4096, token: "t")

            let request = try XCTUnwrap(StubURLProtocol.observed.last)
            XCTAssertEqual(request.url?.path, "/api/uploads")
            XCTAssertEqual(query(request)["purpose"], purpose.rawValue)
            XCTAssertEqual(query(request)["burnAfterRead"], "0")
            XCTAssertEqual(query(request)["ttl"], "86400")
            XCTAssertEqual(query(request)["size"], "4096")
            // No download cap is requested; the queue refuses a limited object.
            XCTAssertNil(query(request)["maxDownloads"])
        }
    }

    /// The existing share behaviour, unchanged: burn-after-read still travels.
    func testAShareStillCarriesBurnAfterRead() async throws {
        StubURLProtocol.reset()
        StubURLProtocol.stub = .init(status: 200, body: Data(
            #"{"uploadId":"UPLOAD0000000001","chunkSize":8388608}"#.utf8))
        _ = try await transport().initUpload(
            header: [], purpose: .share, burnAfterRead: true, ttl: 3600,
            size: 10, token: "t")
        XCTAssertEqual(query(try XCTUnwrap(StubURLProtocol.observed.last))["burnAfterRead"], "1")
    }

    /// A device delivery must be unlimited until its TTL. The server refuses
    /// the pair rather than rewriting it, so this is refused before the request
    /// is built — never silently cleared, which would hand the caller retention
    /// it did not ask for.
    func testADeviceTaskRefusesBurnAfterReadWithoutSendingAnything() async throws {
        StubURLProtocol.reset()
        StubURLProtocol.stub = .init(status: 200, body: Data())
        await XCTAssertThrowsErrorAsync(
            try await self.transport().initUpload(
                header: [], purpose: .deviceTask, burnAfterRead: true, ttl: 86_400,
                size: 10, token: "t"),
            { XCTAssertEqual($0 as? CloudError, .server(status: 0)) })
        XCTAssertEqual(StubURLProtocol.requestCount, 0,
                       "an incoherent purpose/retention pair still reached the network")
    }

    // MARK: - both uploader paths

    /// A recording fake that answers a `404` offset once, which is exactly what
    /// a session the idle reaper collected looks like — and then records what
    /// the REPLACEMENT init asked for.
    private final class ReapingTransport: ResumableTransport, @unchecked Sendable {
        var purposes: [UploadPurpose] = []
        var burnFlags: [Bool] = []
        private let reap: Bool

        init(reap: Bool) { self.reap = reap }

        func initUpload(header: [UInt8], purpose: UploadPurpose, burnAfterRead: Bool,
                        ttl: Int, size: Int,
                        token: String) async throws -> (uploadId: String, chunkSize: Int) {
            purposes.append(purpose)
            burnFlags.append(burnAfterRead)
            return ("UPLOAD0000000001", 64 * 1024)
        }

        func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int, total: Int,
                        token: String,
                        onBytesSent: ((Int) -> Void)?) async throws -> PatchOutcome {
            .committed(received: to)
        }

        func uploadOffset(uploadId: String, token: String) async throws -> Int {
            if reap { throw CloudError.notFound }
            return 0
        }

        func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult {
            UploadResult(id: "STORED0123456789", expiresAt: 1)
        }
    }

    private func source() -> [PlaintextSource] {
        [InMemorySource(name: "a.bin", bytes: [UInt8](repeating: 7, count: 1024))]
    }

    func testAFreshUploadCarriesTheCallersPurpose() async throws {
        for purpose in UploadPurpose.allCases {
            let transport = ReapingTransport(reap: false)
            _ = try await CloudUploader(transport: transport).upload(
                sources: source(), purpose: purpose, burnAfterRead: false,
                ttl: 86_400, token: "t", onProgress: { _, _ in })
            XCTAssertEqual(transport.purposes, [purpose])
        }
    }

    /// The default on `upload` is `.share`, deliberately, and every existing
    /// call site depends on it. Pinned so a change is a test failure rather than
    /// a silent behaviour change on the public share path.
    func testTheFreshUploadDefaultIsShare() async throws {
        let transport = ReapingTransport(reap: false)
        _ = try await CloudUploader(transport: transport).upload(
            sources: source(), burnAfterRead: true, ttl: 3600, token: "t",
            onProgress: { _, _ in })
        XCTAssertEqual(transport.purposes, [.share])
        XCTAssertEqual(transport.burnFlags, [true])
    }

    /// A resume that finds its session already gone opens a REPLACEMENT with
    /// the same purpose. This is the path a `.share` default would corrupt.
    func testAReapedSessionIsReopenedWithTheSamePurpose() async throws {
        for purpose in UploadPurpose.allCases {
            let transport = ReapingTransport(reap: true)
            _ = try await CloudUploader(transport: transport).resume(
                sources: source(), key: generateStoreKey(), uploadId: "UPLOAD0000000009",
                uploadChunkSize: 64 * 1024, purpose: purpose, burnAfterRead: false,
                ttl: 86_400, token: "t", onUploadSession: { _, _ in },
                onProgress: { _, _ in })
            XCTAssertEqual(transport.purposes, [purpose],
                           "the replacement session did not carry \(purpose)")
        }
    }

    /// A resume whose session is still live opens no new session at all, so
    /// there is nothing for a purpose to be wrong about — asserted so the test
    /// above is known to be exercising the reaped branch specifically.
    func testALiveSessionOpensNoNewInit() async throws {
        let transport = ReapingTransport(reap: false)
        _ = try await CloudUploader(transport: transport).resume(
            sources: source(), key: generateStoreKey(), uploadId: "UPLOAD0000000009",
            uploadChunkSize: 64 * 1024, purpose: .deviceTask, burnAfterRead: false,
            ttl: 86_400, token: "t", onUploadSession: { _, _ in }, onProgress: { _, _ in })
        XCTAssertTrue(transport.purposes.isEmpty)
    }
}

/// A byte source that never touches the filesystem, so these tests measure the
/// upload path rather than staging.
private struct InMemorySource: PlaintextSource {
    let name: String
    let bytes: [UInt8]
    private var offset = 0

    init(name: String, bytes: [UInt8]) {
        self.name = name
        self.bytes = bytes
    }

    var size: Int { bytes.count }

    mutating func read(_ max: Int) throws -> [UInt8] {
        guard offset < bytes.count else { return [] }
        let end = Swift.min(offset + max, bytes.count)
        defer { offset = end }
        return Array(bytes[offset..<end])
    }
}
