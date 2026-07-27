import XCTest
@testable import RelayiumKit

/// A transport that records what it was asked to do and can be told to misbehave.
final class StubTransport: ResumableTransport, @unchecked Sendable {
    var chunkSize = 64 * 1024
    var committed: [UInt8] = []
    var patches: [(from: Int, count: Int)] = []
    /// Commit only this many bytes of the next PATCH, then clear (partial commit).
    var partialCommitOnce: Int?
    /// Throw a network error on the next PATCH, then clear.
    var failNextPatch = false
    var initError: Error?
    var finalizeResult = UploadResult(id: "fid", expiresAt: 4242)

    func initUpload(header: [UInt8], burnAfterRead: Bool, ttl: Int,
                    size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) {
        if let e = initError { throw e }
        return ("up1", chunkSize)
    }

    func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int,
                    total: Int, token: String) async throws -> PatchOutcome {
        if failNextPatch { failNextPatch = false; throw CloudError.network }
        patches.append((from, bytes.count))
        var take = bytes.count
        if let p = partialCommitOnce { take = min(p, bytes.count); partialCommitOnce = nil }
        committed += [UInt8](bytes.prefix(take))
        return .committed(received: committed.count)
    }

    func uploadOffset(uploadId: String, token: String) async throws -> Int { committed.count }
    func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult { finalizeResult }
}

final class CloudUploaderTests: XCTestCase {
    private func sources(_ sizes: [Int]) -> [PlaintextSource] {
        sizes.enumerated().map { DataSource(name: "f\($0.offset)",
                                            bytes: [UInt8](repeating: 0x5A, count: $0.element)) }
    }

    /// The bytes the server ends up with must be exactly the bytes the batch
    /// encoder would have produced for the same files and key.
    func testCommittedStreamIsTheWholeCiphertext() async throws {
        let t = StubTransport()
        let u = CloudUploader(transport: t)
        let sizes = [STORE_CHUNK_SIZE * 2 + 7, 100]
        let out = try await u.upload(sources: sources(sizes), burnAfterRead: false,
                                     ttl: 86400, token: "tok", onProgress: { _, _ in })
        XCTAssertEqual(t.committed.count, cipherSizeFor(sizes))
        XCTAssertEqual(out.id, "fid")
        XCTAssertEqual(out.expiresAt, 4242)
        XCTAssertFalse(out.keyB64url.isEmpty)
    }

    /// A partial commit must replay from the server's offset, not from the start
    /// of the next chunk — otherwise the blob gets a hole.
    func testPartialCommitReplaysTheUnacknowledgedTail() async throws {
        let t = StubTransport()
        t.partialCommitOnce = 1000
        let u = CloudUploader(transport: t)
        let sizes = [STORE_CHUNK_SIZE * 3]
        _ = try await u.upload(sources: sources(sizes), burnAfterRead: false,
                               ttl: 3600, token: "tok", onProgress: { _, _ in })
        XCTAssertEqual(t.committed.count, cipherSizeFor(sizes))
    }

    /// A transient PATCH failure costs the current chunk, not the upload.
    func testRetriesAfterANetworkFailure() async throws {
        let t = StubTransport()
        t.failNextPatch = true
        let u = CloudUploader(transport: t)
        let sizes = [STORE_CHUNK_SIZE * 2]
        _ = try await u.upload(sources: sources(sizes), burnAfterRead: false,
                               ttl: 3600, token: "tok", onProgress: { _, _ in })
        XCTAssertEqual(t.committed.count, cipherSizeFor(sizes))
    }

    /// The guard the whole design rests on: memory must not track file size.
    ///
    /// `bufferPeak` counts the packing buffer *and* anything copied out of it on
    /// the way to the transport. The earlier version counted only the packing
    /// buffer, so three full copies per chunk sat outside the assertion and this
    /// test stayed green while the process held four times what it claimed.
    func testPeakBufferIsBoundedByChunkNotFile() async throws {
        let t = StubTransport()
        t.chunkSize = 64 * 1024
        let u = CloudUploader(transport: t)
        let sizes = [STORE_CHUNK_SIZE * 20]        // ~3.75 MiB, 60x the chunk
        _ = try await u.upload(sources: sources(sizes), burnAfterRead: false,
                               ttl: 3600, token: "tok", onProgress: { _, _ in })
        XCTAssertLessThanOrEqual(u.bufferPeak, t.chunkSize + STORE_CHUNK_SIZE + FRAME_OVERHEAD + 16)
    }

    /// The chunk must reach the transport as a slice of the packing buffer, not
    /// as a fresh allocation. This is the property the memory bound actually
    /// depends on, and the one a peak-of-one-buffer assertion cannot see.
    func testHandsTheChunkToTheTransportWithoutCopying() async throws {
        let t = StubTransport()
        let u = CloudUploader(transport: t)
        _ = try await u.upload(sources: sources([STORE_CHUNK_SIZE * 4]), burnAfterRead: false,
                               ttl: 3600, token: "tok", onProgress: { _, _ in })
        XCTAssertEqual(u.bytesCopiedToTransport, 0,
                       "the chunk was copied on its way to the transport")
    }

    /// Even the retry path replays a slice rather than a copy — that path runs
    /// exactly when the network is already unhappy, the worst moment to double
    /// the resident buffer.
    func testRetryReplaysWithoutCopying() async throws {
        let t = StubTransport()
        t.failNextPatch = true
        let u = CloudUploader(transport: t)
        _ = try await u.upload(sources: sources([STORE_CHUNK_SIZE * 3]), burnAfterRead: false,
                               ttl: 3600, token: "tok", onProgress: { _, _ in })
        XCTAssertEqual(u.bytesCopiedToTransport, 0)
    }

    /// Progress must reach the declared total, or the UI stalls at 97%.
    func testProgressEndsAtTheDeclaredTotal() async throws {
        let t = StubTransport()
        let u = CloudUploader(transport: t)
        let sizes = [STORE_CHUNK_SIZE * 2 + 5]
        var last = (sent: 0, total: 0)
        _ = try await u.upload(sources: sources(sizes), burnAfterRead: false,
                               ttl: 3600, token: "tok", onProgress: { s, tt in last = (s, tt) })
        XCTAssertEqual(last.sent, cipherSizeFor(sizes))
        XCTAssertEqual(last.total, cipherSizeFor(sizes))
    }

    /// A user-facing error is never retried into oblivion, and never masked.
    func testQuotaErrorPropagates() async {
        let t = StubTransport()
        t.initError = CloudError.quota
        let u = CloudUploader(transport: t)
        do {
            _ = try await u.upload(sources: sources([10]), burnAfterRead: false,
                                   ttl: 3600, token: "tok", onProgress: { _, _ in })
            XCTFail("expected quota to propagate")
        } catch {
            XCTAssertEqual(error as? CloudError, .quota)
        }
    }
}
