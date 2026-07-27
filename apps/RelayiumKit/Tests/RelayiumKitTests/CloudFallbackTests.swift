import XCTest
@testable import RelayiumKit

private final class FailingInitTransport: ResumableTransport, @unchecked Sendable {
    let error: Error
    init(error: Error) { self.error = error }
    func initUpload(header: [UInt8], burnAfterRead: Bool, ttl: Int,
                    size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) {
        throw error
    }
    func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int,
                    total: Int, token: String) async throws -> PatchOutcome { .committed(received: 0) }
    func uploadOffset(uploadId: String, token: String) async throws -> Int { 0 }
    func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult {
        UploadResult(id: "x", expiresAt: 0)
    }
}

/// Declares a size without allocating it — the gate is checked before any read.
private struct StubSizeSource: PlaintextSource {
    let name: String
    let size: Int
    mutating func read(_ max: Int) throws -> [UInt8] { [] }
}

final class CloudFallbackTests: XCTestCase {
    /// An old server with no /api/uploads must still be able to receive an
    /// upload — this is the only path that exercises the fallback.
    func testFallsBackWhenChunkedEndpointsAreMissing() async throws {
        let u = CloudUploader(transport: FailingInitTransport(error: CloudError.server(status: 404)))
        var fellBack = false
        let out = try await u.uploadResumable(
            sources: [DataSource(name: "a", bytes: [1, 2, 3])],
            singleShot: { _, _, _ in
                fellBack = true
                return SingleShotResult(result: UploadResult(id: "single", expiresAt: 7), keyB64url: "K")
            },
            burnAfterRead: false, ttl: 3600, token: "tok", onProgress: { _, _ in })
        XCTAssertTrue(fellBack)
        XCTAssertEqual(out.id, "single")
        XCTAssertEqual(out.keyB64url, "K")
    }

    /// A user-actionable failure is never converted into a second attempt that
    /// will fail the same way — and never hidden behind the fallback.
    func testDoesNotFallBackOnQuotaOrAuth() async {
        for err in [CloudError.quota, .rateLimited, .unauthorized] {
            let u = CloudUploader(transport: FailingInitTransport(error: err))
            do {
                _ = try await u.uploadResumable(
                    sources: [DataSource(name: "a", bytes: [1])],
                    singleShot: { _, _, _ in
                        XCTFail("must not fall back on \(err)")
                        return SingleShotResult(result: UploadResult(id: "", expiresAt: 0), keyB64url: "")
                    },
                    burnAfterRead: false, ttl: 3600, token: "tok", onProgress: { _, _ in })
                XCTFail("expected \(err) to propagate")
            } catch {
                XCTAssertEqual(error as? CloudError, err)
            }
        }
    }

    /// Above the gate the single-shot path's 2x peak is worse than the error.
    func testDoesNotFallBackAboveTheSizeGate() async {
        let big = FALLBACK_MAX_CIPHER_BYTES + 1
        let u = CloudUploader(transport: FailingInitTransport(error: CloudError.server(status: 500)))
        do {
            _ = try await u.uploadResumable(
                sources: [StubSizeSource(name: "huge", size: big)],
                singleShot: { _, _, _ in
                    XCTFail("must not fall back above the gate")
                    return SingleShotResult(result: UploadResult(id: "", expiresAt: 0), keyB64url: "")
                },
                burnAfterRead: false, ttl: 3600, token: "tok", onProgress: { _, _ in })
            XCTFail("expected the original error to propagate")
        } catch {
            XCTAssertEqual(error as? CloudError, .server(status: 500))
        }
    }
}
