import Foundation

public struct UploadOutcome: Equatable {
    public let id: String
    public let expiresAt: Int64
    public let keyB64url: String

    public init(id: String, expiresAt: Int64, keyB64url: String) {
        self.id = id
        self.expiresAt = expiresAt
        self.keyB64url = keyB64url
    }
}

/// The chunked upload: encrypt and send interleaved, so resident memory is one
/// upload chunk plus one frame rather than the whole ciphertext.
///
/// Mirrors `web/src/lib/stored-file.ts`'s chunkedUpload, including its two
/// asymmetric guards. `cipherSizeFor` is computed before encryption because the
/// declared size is needed at init and there is no assembled blob to measure.
/// If that formula ever over-reports, the encryptor runs dry early; if it
/// under-reports, the loop exits with frames still unsent and we would finalize
/// a truncated, undecryptable ciphertext while the UI says success. Both are
/// caught below.
public final class CloudUploader {
    private let transport: ResumableTransport
    /// Peak bytes encrypted but not yet acknowledged. The memory regression guard.
    public private(set) var bufferPeak = 0

    public init(transport: ResumableTransport) { self.transport = transport }

    public func upload(sources: [PlaintextSource], burnAfterRead: Bool, ttl: Int,
                       token: String,
                       onProgress: (_ sent: Int, _ total: Int) -> Void) async throws -> UploadOutcome {
        let raw = generateStoreKey()
        let manifest = StoredManifest(files: sources.map { ManifestFile(name: $0.name, size: $0.size) })
        let encManifest = try encryptManifest(key: raw, manifest)
        let total = cipherSizeFor(sources.map(\.size))

        var header = [UInt8]()
        let n = encManifest.count
        header += [UInt8(n >> 24 & 0xff), UInt8(n >> 16 & 0xff), UInt8(n >> 8 & 0xff), UInt8(n & 0xff)]
        header += encManifest

        let (uploadId, chunkSize) = try await transport.initUpload(
            header: header, burnAfterRead: burnAfterRead, ttl: ttl, size: total, token: token)

        let enc = ChunkEncryptor(key: raw, sources: sources)
        // Held bytes double as the replay buffer: the server can commit part of a
        // chunk, so the unacknowledged tail must survive until it is acked.
        var pending = [UInt8]()
        pending.reserveCapacity(chunkSize + STORE_CHUNK_SIZE + FRAME_OVERHEAD)
        var chunkStart = 0
        var offset = 0
        bufferPeak = 0

        onProgress(0, total)
        while offset < total {
            try Task.checkCancellation()
            while pending.count < chunkSize {
                guard let f = try enc.next() else { break }
                try Task.checkCancellation()
                pending += f
            }
            // Encryptor dry before the declared size was met: the formula and the
            // stream disagree. Better to fail than finalize a truncated blob.
            if pending.isEmpty { throw CloudError.server(status: 0) }
            bufferPeak = max(bufferPeak, pending.count)

            let received = try await patchWithRetry(uploadId: uploadId, bytes: pending,
                                                    chunkStart: chunkStart, total: total, token: token)
            let consumed = received - chunkStart
            // Offset moving backwards, or past bytes we never produced: either way
            // we can no longer align, and sending more writes a misplaced stream.
            if consumed < 0 || consumed > pending.count { throw CloudError.server(status: 0) }
            if consumed > 0 { pending.removeFirst(consumed) }
            chunkStart = received
            offset = received
            onProgress(offset, total)
        }
        // The other half of the asymmetric guard: the loop ends on offset >= total,
        // so an under-reporting formula would leave frames unsent. Confirm dry.
        if try enc.next() != nil { throw CloudError.server(status: 0) }

        let r = try await transport.finalizeUpload(uploadId: uploadId, token: token)
        return UploadOutcome(id: r.id, expiresAt: r.expiresAt, keyB64url: encodeStoreKey(raw))
    }

    /// PATCH with resync-and-replay. A reset commits whatever landed, so the
    /// server's offset can fall inside the chunk we sent; replay from there.
    private func patchWithRetry(uploadId: String, bytes: [UInt8], chunkStart: Int,
                                total: Int, token: String) async throws -> Int {
        let end = chunkStart + bytes.count
        var from = chunkStart
        for attempt in 1...5 {
            do {
                let outcome = try await transport.patchChunk(
                    uploadId: uploadId, bytes: Array(bytes[(from - chunkStart)...]),
                    from: from, to: end, total: total, token: token)
                switch outcome {
                case .committed(let r), .serverAhead(let r): return r
                }
            } catch let e as CloudError {
                // User-actionable failures are never retried and never masked.
                if e == .unauthorized || e == .quota || e == .rateLimited { throw e }
                if attempt >= 5 { throw e }
                try Task.checkCancellation()
                from = (try? await transport.uploadOffset(uploadId: uploadId, token: token)) ?? from
                if from >= end { return from }
                // The server fell behind bytes we no longer hold — unreplayable.
                if from < chunkStart { throw CloudError.server(status: 0) }
                try await Task.sleep(nanoseconds: UInt64(100_000_000 * attempt))
            }
        }
        throw CloudError.network
    }
}

/// Above this the single-shot path's ~2x peak is worse than reporting the
/// error: a failed upload beats an app the OS kills mid-transfer.
public let FALLBACK_MAX_CIPHER_BYTES = 64 << 20

/// What the single-shot path hands back. It generates its own key, so it has to
/// return it: the key is only ever in the link, and a fallback that dropped it
/// would produce a link nobody can open.
public struct SingleShotResult {
    public let result: UploadResult
    public let keyB64url: String

    public init(result: UploadResult, keyB64url: String) {
        self.result = result
        self.keyB64url = keyB64url
    }
}

extension CloudUploader {
    /// The chunked flow with a safety net for a server too old to offer
    /// `/api/uploads`. `singleShot` receives the same inputs and does the
    /// whole-file upload; it is a closure so this type keeps no opinion about
    /// where the plaintext comes from.
    public func uploadResumable(
        sources: [PlaintextSource],
        singleShot: (_ burnAfterRead: Bool, _ ttl: Int, _ token: String) async throws -> SingleShotResult,
        burnAfterRead: Bool, ttl: Int, token: String,
        onProgress: (_ sent: Int, _ total: Int) -> Void
    ) async throws -> UploadOutcome {
        do {
            return try await upload(sources: sources, burnAfterRead: burnAfterRead,
                                    ttl: ttl, token: token, onProgress: onProgress)
        } catch is CancellationError {
            throw CancellationError()
        } catch let e as CloudError {
            // Never mask a failure the user can act on, and never retry it.
            if e == .unauthorized || e == .quota || e == .rateLimited { throw e }
            if cipherSizeFor(sources.map(\.size)) > FALLBACK_MAX_CIPHER_BYTES { throw e }
            let s = try await singleShot(burnAfterRead, ttl, token)
            return UploadOutcome(id: s.result.id, expiresAt: s.result.expiresAt,
                                 keyB64url: s.keyB64url)
        }
    }
}
