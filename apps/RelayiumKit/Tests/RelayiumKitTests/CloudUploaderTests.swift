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

    func initUpload(header: [UInt8], purpose: UploadPurpose, burnAfterRead: Bool, ttl: Int,
                    size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) {
        if let e = initError { throw e }
        return ("up1", chunkSize)
    }

    func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int,
                    total: Int, token: String,
                    onBytesSent: ((Int) -> Void)?) async throws -> PatchOutcome {
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

/// Holds every body it is handed, the way URLSession holds a request body for
/// the life of the request — which on a slow link is tens of seconds, spanning
/// the loop's next mutation of the packing buffer.
final class RetainingTransport: ResumableTransport, @unchecked Sendable {
    var chunkSize = 64 * 1024
    var retained: [Data] = []
    private var committedCount = 0

    func initUpload(header: [UInt8], purpose: UploadPurpose, burnAfterRead: Bool, ttl: Int,
                    size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) {
        ("up1", chunkSize)
    }
    func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int,
                    total: Int, token: String,
                    onBytesSent: ((Int) -> Void)?) async throws -> PatchOutcome {
        retained.append(bytes)          // the URLSession-shaped hazard
        committedCount += bytes.count
        return .committed(received: committedCount)
    }
    func uploadOffset(uploadId: String, token: String) async throws -> Int { committedCount }
    func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult {
        UploadResult(id: "fid", expiresAt: 1)
    }
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

    /// Baseline for the pair below: a transport that drops each body leaves the
    /// packing buffer uniquely referenced, so mutating it cannot copy-on-write.
    func testBufferIsNotReallocatedWhenTheTransportDropsTheBody() async throws {
        let t = StubTransport()
        let u = CloudUploader(transport: t)
        _ = try await u.upload(sources: sources([STORE_CHUNK_SIZE * 12]), burnAfterRead: false,
                               ttl: 3600, token: "tok", onProgress: { _, _ in })
        XCTAssertEqual(u.packingBufferReallocations, 0)
    }

    /// The one that matters. A transport that holds the body — as URLSession
    /// does for the life of a request — leaves the buffer's storage shared when
    /// the loop mutates it for the next chunk. If that costs a fresh allocation
    /// every chunk, this is where it shows.
    func testBufferIsNotReallocatedWhenTheTransportRetainsTheBody() async throws {
        let t = RetainingTransport()
        let u = CloudUploader(transport: t)
        _ = try await u.upload(sources: sources([STORE_CHUNK_SIZE * 12]), burnAfterRead: false,
                               ttl: 3600, token: "tok", onProgress: { _, _ in })
        XCTAssertGreaterThan(t.retained.count, 1, "the test needs several chunks to be meaningful")
        XCTAssertEqual(u.packingBufferReallocations, 0,
                       "the packing buffer was reallocated \(u.packingBufferReallocations) times across \(t.retained.count) chunks")
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

/// A transport that reports the body leaving in four instalments, the way
/// URLSession's didSendBodyData does on a real link.
private final class DribblingTransport: ResumableTransport, @unchecked Sendable {
    var chunkSize = 64 * 1024
    private var committed = 0

    func initUpload(header: [UInt8], purpose: UploadPurpose, burnAfterRead: Bool, ttl: Int,
                    size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) {
        ("up1", chunkSize)
    }

    func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int,
                    total: Int, token: String,
                    onBytesSent: ((Int) -> Void)?) async throws -> PatchOutcome {
        let step = max(1, bytes.count / 4)
        var sent = 0
        while sent < bytes.count {
            sent = min(sent + step, bytes.count)
            onBytesSent?(sent)
        }
        committed += bytes.count
        return .committed(received: committed)
    }

    func uploadOffset(uploadId: String, token: String) async throws -> Int { committed }
    func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult {
        UploadResult(id: "fid", expiresAt: 1)
    }
}

extension CloudUploaderTests {
    /// The server hands out 8 MiB chunks. Reporting progress only when a chunk
    /// commits means a 13 MB upload moves twice — and on a 2 Mbit link the first
    /// move is 28 seconds in, so the transfer reads as frozen while it is in
    /// fact running. Progress has to follow the bytes, not the chunk boundaries.
    func testProgressAdvancesWithinAChunkNotOnlyWhenItCommits() async throws {
        let t = DribblingTransport()
        t.chunkSize = 64 * 1024
        let up = CloudUploader(transport: t)
        // Two chunks' worth, so "only at commit" would yield just two moves.
        let payload = [UInt8](repeating: 7, count: 100 * 1024)
        var seen: [Int] = []
        _ = try await up.upload(sources: [DataSource(name: "a.bin", bytes: payload)],
                                burnAfterRead: false, ttl: 3600, token: "tok",
                                onProgress: { sent, _ in seen.append(sent) })

        let firstCommit = seen.first(where: { $0 >= 64 * 1024 }) ?? Int.max
        let intra = seen.filter { $0 > 0 && $0 < firstCommit }
        XCTAssertFalse(intra.isEmpty,
                       "progress never moved inside the first chunk: \(seen)")
        // And it must never go backwards, or the bar jumps about.
        XCTAssertEqual(seen, seen.sorted(), "progress went backwards: \(seen)")
    }
}
