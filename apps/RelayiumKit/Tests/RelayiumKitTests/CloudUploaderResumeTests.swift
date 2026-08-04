import XCTest
@testable import RelayiumKit

/// R3-G, the cryptographic half: resuming must reproduce the SAME ciphertext.
///
/// The stream is deterministic by construction — AES-GCM under a nonce derived
/// from the frame sequence number (`Aead.swift`), frames laid out purely from
/// the file sizes (`StoreFrame.swift`) — so a resumed run can be byte-identical
/// to the run it continues. That is not a nicety: the server splices the new
/// bytes onto the committed prefix at an exact offset, and the receiver
/// decrypts one continuous frame stream. Bytes that differ by one produce a
/// blob nobody can open.
///
/// The offsets that matter are the awkward ones. A committed offset lands
/// wherever the network stopped: inside a frame's length prefix, inside its
/// ciphertext, inside its tag, at a file boundary. So the tests below resume
/// from frame-interior offsets and compare against the whole-stream reference
/// `encryptChunks` produces.
final class CloudUploaderResumeTests: XCTestCase {

    // MARK: - doubles

    /// Records what the resumed upload actually put on the wire.
    private final class RecordingTransport: ResumableTransport, @unchecked Sendable {
        let committed: Int
        private(set) var initCalls: [[UInt8]] = []
        private(set) var ranges: [(from: Int, to: Int, total: Int)] = []
        private(set) var body = Data()
        private(set) var offsetQueries = 0
        private(set) var finalized = false

        init(committed: Int) { self.committed = committed }

        func initUpload(header: [UInt8], burnAfterRead: Bool, ttl: Int,
                        size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) {
            initCalls.append(header)
            // Deliberately small, so a single test payload spans several
            // transport chunks and a committed offset can land inside one.
            return ("upload-1", 64 * 1024)
        }

        func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int,
                        total: Int, token: String,
                        onBytesSent: ((Int) -> Void)?) async throws -> PatchOutcome {
            ranges.append((from, to, total))
            body += bytes
            return .committed(received: to)
        }

        func uploadOffset(uploadId: String, token: String) async throws -> Int {
            offsetQueries += 1
            return committed
        }

        func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult {
            finalized = true
            return UploadResult(id: "stored-1", expiresAt: 42)
        }
    }

    // MARK: - fixtures

    /// Two files whose first one spans several frames, so frame boundaries and
    /// file boundaries are distinct events in the stream.
    private let fileA = (0..<(STORE_CHUNK_SIZE + 4096)).map { UInt8($0 % 251) }
    private let fileB = (0..<9000).map { UInt8(($0 &* 7) % 253) }

    private var key: [UInt8] { Array(repeating: 3, count: 32) }

    private func sources() -> [PlaintextSource] {
        [DataSource(name: "trip/a.bin", bytes: fileA), DataSource(name: "b.bin", bytes: fileB)]
    }

    private var wholeStream: [UInt8] { encryptChunks(key: key, files: [fileA, fileB]) }

    private var total: Int { cipherSizeFor([fileA.count, fileB.count]) }

    // MARK: - the offset arithmetic

    /// The pure part: where a byte offset lands in the framed stream. Every
    /// resume decision is derived from this, so it is pinned on its own rather
    /// than only through the bytes it produces.
    func testFramePositionAtTheStartOfTheStream() {
        let position = framePosition(sizes: [fileA.count, fileB.count], offset: 0)
        XCTAssertEqual(position, FramePosition(fileIndex: 0, byteInFile: 0, seq: 1, dropFromFrame: 0))
    }

    /// Inside the first frame — the case a naive implementation gets wrong by
    /// restarting the frame and writing its 4-byte length prefix twice.
    func testFramePositionInsideTheFirstFrame() {
        let position = framePosition(sizes: [fileA.count, fileB.count], offset: 100)
        XCTAssertEqual(position, FramePosition(fileIndex: 0, byteInFile: 0, seq: 1, dropFromFrame: 100))
    }

    /// The sequence number is global across files and never restarts, so an
    /// offset in the second file must carry the count of every frame before it.
    func testFramePositionInsideTheSecondFile() {
        let firstFrame = FRAME_OVERHEAD + STORE_CHUNK_SIZE
        let secondFrame = FRAME_OVERHEAD + (fileA.count - STORE_CHUNK_SIZE)
        let position = framePosition(sizes: [fileA.count, fileB.count],
                                     offset: firstFrame + secondFrame + 11)
        XCTAssertEqual(position, FramePosition(fileIndex: 1, byteInFile: 0, seq: 3, dropFromFrame: 11))
    }

    /// A zero-length file yields no frames at all (the encoder's `off < size`
    /// loop never runs), so it must not consume a sequence number either.
    func testFramePositionSkipsEmptyFiles() {
        let position = framePosition(sizes: [0, 10], offset: 0)
        XCTAssertEqual(position, FramePosition(fileIndex: 1, byteInFile: 0, seq: 1, dropFromFrame: 0))
    }

    func testFramePositionRejectsNegativeOrOverflowingSizes() {
        XCTAssertNil(framePosition(sizes: [-1, 10], offset: 0))
        XCTAssertNil(framePosition(sizes: [10, -1], offset: 0))
        XCTAssertNil(framePosition(sizes: [Int.max], offset: Int.max - 1))
    }

    // MARK: - byte identity

    /// From zero, a resumed run is the run it replaces.
    func testResumingAtZeroReproducesTheWholeStream() async throws {
        let transport = RecordingTransport(committed: 0)
        let uploader = CloudUploader(transport: transport)

        _ = try await uploader.resume(sources: sources(), key: key, uploadId: "upload-1",
                                      uploadChunkSize: 64 * 1024,
                                      burnAfterRead: false, ttl: 3600, token: "t",
                                      onUploadSession: { _, _ in }, onProgress: { _, _ in })

        XCTAssertEqual(Array(transport.body), wholeStream)
        XCTAssertEqual(transport.ranges.first?.from, 0)
        XCTAssertEqual(transport.ranges.last?.to, total)
        XCTAssertTrue(transport.finalized)
    }

    /// The heart of it: a committed offset INSIDE a frame. The resumed bytes
    /// must be exactly the tail of the same stream — which means re-sealing
    /// that whole frame and sending only the part the server does not have.
    func testResumingInsideAFrameSendsExactlyTheRemainingBytes() async throws {
        let committed = 100                       // inside frame 1's ciphertext
        let transport = RecordingTransport(committed: committed)
        let uploader = CloudUploader(transport: transport)

        _ = try await uploader.resume(sources: sources(), key: key, uploadId: "upload-1",
                                      uploadChunkSize: 64 * 1024,
                                      burnAfterRead: false, ttl: 3600, token: "t",
                                      onUploadSession: { _, _ in }, onProgress: { _, _ in })

        XCTAssertEqual(transport.offsetQueries, 1, "a resume must ask the server where it got to")
        XCTAssertEqual(transport.ranges.first?.from, committed)
        XCTAssertEqual(transport.ranges.last?.to, total)
        XCTAssertEqual(Array(transport.body), Array(wholeStream[committed...]))
    }

    /// The other frame-interior case, one byte into the tag of a frame that is
    /// not the first — so the file cursor, the sequence number and the
    /// intra-frame drop all have to be right at once.
    func testResumingInsideALaterFrameReproducesTheTail() async throws {
        let firstFrame = FRAME_OVERHEAD + STORE_CHUNK_SIZE
        let committed = firstFrame + FRAME_OVERHEAD + (fileA.count - STORE_CHUNK_SIZE) - 1
        let transport = RecordingTransport(committed: committed)
        let uploader = CloudUploader(transport: transport)

        _ = try await uploader.resume(sources: sources(), key: key, uploadId: "upload-1",
                                      uploadChunkSize: 64 * 1024,
                                      burnAfterRead: false, ttl: 3600, token: "t",
                                      onUploadSession: { _, _ in }, onProgress: { _, _ in })

        XCTAssertEqual(Array(transport.body), Array(wholeStream[committed...]))
        XCTAssertEqual(transport.ranges.first?.from, committed)
    }

    /// A committed offset inside a TRANSPORT chunk, not just inside a frame:
    /// the server advertises 64 KiB here, and the resume must still start at
    /// the exact byte rather than at the chunk boundary containing it.
    func testResumingInsideATransportChunkStartsAtTheExactByte() async throws {
        let committed = (64 * 1024) + 7
        let transport = RecordingTransport(committed: committed)
        let uploader = CloudUploader(transport: transport)

        _ = try await uploader.resume(sources: sources(), key: key, uploadId: "upload-1",
                                      uploadChunkSize: 64 * 1024,
                                      burnAfterRead: false, ttl: 3600, token: "t",
                                      onUploadSession: { _, _ in }, onProgress: { _, _ in })

        XCTAssertEqual(transport.ranges.first?.from, committed)
        XCTAssertEqual(Array(transport.body), Array(wholeStream[committed...]))
    }

    /// Resuming reuses the session the plan recorded: no second init, because a
    /// second init would orphan the bytes the server already holds.
    func testResumingAnExistingSessionDoesNotStartASecondOne() async throws {
        let transport = RecordingTransport(committed: 512)
        let uploader = CloudUploader(transport: transport)

        _ = try await uploader.resume(sources: sources(), key: key, uploadId: "upload-1",
                                      uploadChunkSize: 64 * 1024,
                                      burnAfterRead: false, ttl: 3600, token: "t",
                                      onUploadSession: { _, _ in }, onProgress: { _, _ in })

        XCTAssertTrue(transport.initCalls.isEmpty)
    }

    /// The chunk size belongs to the existing session. It is not re-advertised
    /// by the offset endpoint, so using today's default after a relaunch would
    /// change the PATCH boundaries of a session created under another value.
    func testExistingSessionUsesItsPersistedNonDefaultChunkSize() async throws {
        let transport = RecordingTransport(committed: 0)
        let uploader = CloudUploader(transport: transport)

        _ = try await uploader.resume(sources: sources(), key: key, uploadId: "upload-1",
                                      uploadChunkSize: 64 * 1024,
                                      burnAfterRead: false, ttl: 3600, token: "t",
                                      onUploadSession: { id, chunkSize in
                                          XCTAssertEqual(id, "upload-1")
                                          XCTAssertEqual(chunkSize, 64 * 1024)
                                      }, onProgress: { _, _ in })

        XCTAssertGreaterThan(transport.ranges.count, 1,
                             "the current 8 MiB default was used instead of the stored 64 KiB session value")
    }

    /// The manifest header is a pure function of (key, names, sizes), so a
    /// fresh session for the same job is byte-identical to the original one.
    /// This is what makes a re-init after the server's idle reaper a clean
    /// restart rather than a different upload.
    func testAFreshSessionRebuildsTheIdenticalManifestHeader() async throws {
        let transport = RecordingTransport(committed: 0)
        let uploader = CloudUploader(transport: transport)

        _ = try await uploader.resume(sources: sources(), key: key, uploadId: nil,
                                      uploadChunkSize: nil,
                                      burnAfterRead: false, ttl: 3600, token: "t",
                                      onUploadSession: { _, _ in }, onProgress: { _, _ in })

        let manifest = StoredManifest(files: [ManifestFile(name: "trip/a.bin", size: fileA.count),
                                              ManifestFile(name: "b.bin", size: fileB.count)])
        let encrypted = try encryptManifest(key: key, manifest)
        var expected: [UInt8] = [UInt8(encrypted.count >> 24 & 0xff), UInt8(encrypted.count >> 16 & 0xff),
                                 UInt8(encrypted.count >> 8 & 0xff), UInt8(encrypted.count & 0xff)]
        expected += encrypted

        XCTAssertEqual(transport.initCalls.count, 1)
        XCTAssertEqual(transport.initCalls.first, expected)
        XCTAssertEqual(transport.offsetQueries, 0, "there is no session to ask about yet")
    }

    // MARK: - the reaped session

    /// The server's idle reaper drops an abandoned session after an hour, and
    /// the status probe then 404s. That is a recoverable state, not a dead job:
    /// the same key and the same manifest open a fresh session, and the stream
    /// restarts at zero. Anything else would either lose the user's selection
    /// or splice new bytes onto a blob that no longer exists.
    private final class ReapedSessionTransport: ResumableTransport, @unchecked Sendable {
        private(set) var initCalls: [[UInt8]] = []
        private(set) var ranges: [(from: Int, to: Int)] = []
        private(set) var body = Data()
        private(set) var offsetQueries = 0

        func initUpload(header: [UInt8], burnAfterRead: Bool, ttl: Int,
                        size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) {
            initCalls.append(header)
            return ("upload-2", 64 * 1024)
        }
        func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int,
                        total: Int, token: String,
                        onBytesSent: ((Int) -> Void)?) async throws -> PatchOutcome {
            XCTAssertEqual(uploadId, "upload-2", "bytes went to the reaped session")
            ranges.append((from, to))
            body += bytes
            return .committed(received: to)
        }
        func uploadOffset(uploadId: String, token: String) async throws -> Int {
            offsetQueries += 1
            throw CloudError.notFound
        }
        func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult {
            UploadResult(id: "stored-2", expiresAt: 7)
        }
    }

    func testAReapedSessionIsReinitializedAtZeroWithTheSameManifest() async throws {
        let transport = ReapedSessionTransport()
        let uploader = CloudUploader(transport: transport)
        var reported: [String] = []

        let outcome = try await uploader.resume(sources: sources(), key: key, uploadId: "upload-1",
                                                uploadChunkSize: 64 * 1024,
                                                burnAfterRead: false, ttl: 3600, token: "t",
                                                onUploadSession: { id, _ in reported.append(id) },
                                                onProgress: { _, _ in })

        XCTAssertEqual(transport.offsetQueries, 1)
        XCTAssertEqual(transport.initCalls.count, 1, "the reaped session must be replaced, once")

        let manifest = StoredManifest(files: [ManifestFile(name: "trip/a.bin", size: fileA.count),
                                              ManifestFile(name: "b.bin", size: fileB.count)])
        let encrypted = try encryptManifest(key: key, manifest)
        var expected: [UInt8] = [UInt8(encrypted.count >> 24 & 0xff), UInt8(encrypted.count >> 16 & 0xff),
                                 UInt8(encrypted.count >> 8 & 0xff), UInt8(encrypted.count & 0xff)]
        expected += encrypted
        XCTAssertEqual(transport.initCalls.first, expected, "a new session must carry the SAME manifest")

        // Restarted at zero, and the whole stream re-sent under the same key.
        XCTAssertEqual(transport.ranges.first?.from, 0)
        XCTAssertEqual(Array(transport.body), wholeStream)
        // The new id is reported before any byte moves, so the plan can record it.
        XCTAssertEqual(reported, ["upload-2"])
        XCTAssertEqual(outcome.keyB64url, encodeStoreKey(key), "a re-init must not mint a new key")
    }

    // MARK: - offsets that cannot be honoured

    /// A committed offset the client cannot align to is refused rather than
    /// guessed at. Past the declared total means the server counted bytes this
    /// stream never produced; negative means the response is malformed. Either
    /// way, continuing would write a misplaced stream into someone's blob.
    private final class BadOffsetTransport: ResumableTransport, @unchecked Sendable {
        let offset: Int
        private(set) var patches = 0
        private(set) var finalized = false
        init(offset: Int) { self.offset = offset }

        func initUpload(header: [UInt8], burnAfterRead: Bool, ttl: Int,
                        size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) {
            ("upload-1", 64 * 1024)
        }
        func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int,
                        total: Int, token: String,
                        onBytesSent: ((Int) -> Void)?) async throws -> PatchOutcome {
            patches += 1
            return .committed(received: to)
        }
        func uploadOffset(uploadId: String, token: String) async throws -> Int { offset }
        func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult {
            finalized = true
            return UploadResult(id: "stored-1", expiresAt: 0)
        }
    }

    func testAnOffsetPastTheDeclaredTotalIsRefused() async throws {
        let transport = BadOffsetTransport(offset: total + 1)
        let uploader = CloudUploader(transport: transport)

        do {
            _ = try await uploader.resume(sources: sources(), key: key, uploadId: "upload-1",
                                          uploadChunkSize: 64 * 1024,
                                          burnAfterRead: false, ttl: 3600, token: "t",
                                          onUploadSession: { _, _ in }, onProgress: { _, _ in })
            XCTFail("an unalignable offset must not be uploaded through")
        } catch {
            XCTAssertEqual(error as? CloudError, .server(status: 0))
        }
        XCTAssertEqual(transport.patches, 0)
        XCTAssertFalse(transport.finalized, "nothing may be finalized from an offset we cannot align to")
    }

    func testANegativeOffsetIsRefused() async throws {
        let transport = BadOffsetTransport(offset: -1)
        let uploader = CloudUploader(transport: transport)

        do {
            _ = try await uploader.resume(sources: sources(), key: key, uploadId: "upload-1",
                                          uploadChunkSize: 64 * 1024,
                                          burnAfterRead: false, ttl: 3600, token: "t",
                                          onUploadSession: { _, _ in }, onProgress: { _, _ in })
            XCTFail("a negative offset must not be uploaded through")
        } catch {
            XCTAssertEqual(error as? CloudError, .server(status: 0))
        }
        XCTAssertEqual(transport.patches, 0)
    }

    /// The server already has everything: the only thing left is to finalize.
    /// Sending a zero-length tail would be a PATCH with an empty body at the
    /// end of the stream, which the server has no reason to accept.
    func testAFullyCommittedSessionGoesStraightToFinalize() async throws {
        let transport = BadOffsetTransport(offset: total)
        let uploader = CloudUploader(transport: transport)

        let outcome = try await uploader.resume(sources: sources(), key: key, uploadId: "upload-1",
                                                uploadChunkSize: 64 * 1024,
                                                burnAfterRead: false, ttl: 3600, token: "t",
                                                onUploadSession: { _, _ in }, onProgress: { _, _ in })

        XCTAssertEqual(transport.patches, 0)
        XCTAssertTrue(transport.finalized)
        XCTAssertEqual(outcome.id, "stored-1")
    }

    /// The id a resume ends up using is reported back, because the plan has to
    /// record it before any byte is sent — including when a re-init produced a
    /// new one.
    func testTheSessionIdIsReportedBeforeBytesMove() async throws {
        let transport = RecordingTransport(committed: 0)
        let uploader = CloudUploader(transport: transport)
        var reported: [String] = []

        _ = try await uploader.resume(sources: sources(), key: key, uploadId: nil,
                                      uploadChunkSize: nil,
                                      burnAfterRead: false, ttl: 3600, token: "t",
                                      onUploadSession: { id, _ in reported.append(id) },
                                      onProgress: { _, _ in })

        XCTAssertEqual(reported, ["upload-1"])
    }

    /// Persistence is part of establishing a session. If it fails, sending a
    /// PATCH would create bytes no later process knows how to find.
    func testSessionPersistenceFailureStopsBeforeAnyBytesMove() async throws {
        enum Expected: Error { case writeFailed }
        let transport = RecordingTransport(committed: 0)
        let uploader = CloudUploader(transport: transport)

        do {
            _ = try await uploader.resume(sources: sources(), key: key, uploadId: nil,
                                          uploadChunkSize: nil,
                                          burnAfterRead: false, ttl: 3600, token: "t",
                                          onUploadSession: { _, _ in throw Expected.writeFailed },
                                          onProgress: { _, _ in })
            XCTFail("a session whose plan could not be written must stop")
        } catch Expected.writeFailed {}

        XCTAssertTrue(transport.ranges.isEmpty)
        XCTAssertFalse(transport.finalized)
    }
}
