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

    /// Peak bytes this uploader holds at once: the packing buffer plus anything
    /// copied out of it on the way to the transport.
    ///
    /// The copies are the point. An earlier version counted only the packing
    /// buffer, and stayed green while the process held four times what it
    /// claimed — one buffer plus three full copies of every chunk, all of them
    /// outside the assertion. A memory guard that cannot see copies is not a
    /// memory guard.
    public private(set) var bufferPeak = 0

    /// Bytes copied out of the packing buffer on the way to the transport during
    /// the last upload. Must stay 0: the body is a slice sharing that storage.
    public private(set) var bytesCopiedToTransport = 0

    /// How many times the packing buffer's backing storage changed address
    /// during the last upload.
    ///
    /// A slow network keeps each PATCH alive for tens of seconds, and the
    /// transport still holds the body — a slice of this buffer — when the loop
    /// mutates it for the next chunk. Mutating storage somebody else references
    /// is a copy-on-write, so the count answers whether every chunk quietly
    /// allocates a fresh 8.5 MB block.
    public private(set) var packingBufferReallocations = 0

    public init(transport: ResumableTransport) { self.transport = transport }

    /// The framed-stream header every session leads with: the length-prefixed
    /// encrypted manifest. A pure function of (key, names, sizes) — which is
    /// what lets a re-initialized session be byte-identical to the one the
    /// server reaped.
    static func manifestHeader(key: [UInt8], sources: [PlaintextSource]) throws -> [UInt8] {
        let manifest = StoredManifest(files: sources.map { ManifestFile(name: $0.name, size: $0.size) })
        let encManifest = try encryptManifest(key: key, manifest)
        let n = encManifest.count
        var header: [UInt8] = [UInt8(n >> 24 & 0xff), UInt8(n >> 16 & 0xff),
                               UInt8(n >> 8 & 0xff), UInt8(n & 0xff)]
        header += encManifest
        return header
    }

    public func upload(sources: [PlaintextSource], burnAfterRead: Bool, ttl: Int,
                       token: String,
                       onProgress: @escaping (_ sent: Int, _ total: Int) -> Void) async throws -> UploadOutcome {
        let raw = generateStoreKey()
        let header = try Self.manifestHeader(key: raw, sources: sources)
        let total = try Self.checkedCipherSize(sources.map(\.size))

        let (issuedId, chunkSize) = try await transport.initUpload(
            header: header, burnAfterRead: burnAfterRead, ttl: ttl, size: total, token: token)
        // The first thing this function does with the server's answer, and
        // deliberately before any file bytes are encrypted or sent — the
        // encryptor below is not even constructed yet. `uploadId` is appended as
        // a URL path component by every PATCH, offset read and finalize below,
        // and `URL.appendingPathComponent` percent-encodes neither `/` nor `.`
        // — so an id of `../me` composes a request aimed at an endpoint this
        // upload never authorised. Checking here means `patchChunk`,
        // `uploadOffset` and `finalizeUpload` are only ever reached with an id
        // that is one inert token.
        //
        // Refused, not escaped: see `StoredObjectID`.
        let uploadId = try StoredObjectID.checked(issuedId)
        guard validUploadChunkSize(chunkSize) else { throw CloudError.decoding }
        let enc = ChunkEncryptor(key: raw, sources: sources)
        try await pump(enc: enc, uploadId: uploadId, chunkSize: chunkSize,
                       from: 0, total: total, token: token, onProgress: onProgress)

        try Task.checkCancellation()
        let r = try await transport.finalizeUpload(uploadId: uploadId, token: token)
        // A second server-chosen id, and not necessarily the one init issued:
        // this is the one that becomes the keychain account name the key is
        // filed under and the `/d/<id>` the user is handed. Checked before an
        // `UploadOutcome` exists, so no caller can be given an outcome carrying
        // an id this app would refuse to act on.
        return UploadOutcome(id: try StoredObjectID.checked(r.id),
                             expiresAt: r.expiresAt, keyB64url: encodeStoreKey(raw))
    }

    /// Continue — or restart — the upload of an already-staged job.
    ///
    /// The difference from `upload` is where the key and the session come from.
    /// Both are the caller's: the key was generated when the job was staged and
    /// has lived in the keychain since, and `uploadId` is whatever session the
    /// plan recorded. That is what lets this run in a process that has never
    /// seen the user's original files.
    ///
    /// Three shapes come out of the server, and all three are recoverable:
    ///
    ///  - a live session with a committed offset — continue from that exact byte;
    ///  - a session already holding everything — finalize, send nothing;
    ///  - **404, the idle reaper got there first** — open a fresh session with
    ///    the SAME key and the SAME manifest and restart at zero. The bytes are
    ///    still ours; only the server's half expired.
    ///
    /// An offset outside `0...total` is refused rather than guessed at: it
    /// means the session is not the one this plan describes, and continuing
    /// would splice a misplaced stream into somebody's blob.
    public func resume(sources: [PlaintextSource], key: [UInt8], uploadId: String?,
                       uploadChunkSize: Int?,
                       burnAfterRead: Bool, ttl: Int, token: String,
                       onUploadSession: (String, Int) throws -> Void,
                       onProgress: @escaping (_ sent: Int, _ total: Int) -> Void) async throws -> UploadOutcome {
        let header = try Self.manifestHeader(key: key, sources: sources)
        let total = try Self.checkedCipherSize(sources.map(\.size))

        var session: (id: String, chunkSize: Int)?
        var committed = 0
        if let existing = uploadId {
            let checked = try StoredObjectID.checked(existing)
            guard let uploadChunkSize, validUploadChunkSize(uploadChunkSize) else {
                throw CloudError.decoding
            }
            do {
                let offset = try await transport.uploadOffset(uploadId: checked, token: token)
                guard offset >= 0, offset <= total else { throw CloudError.server(status: 0) }
                committed = offset
                // The server advertises this value only at init. It belongs to
                // the persisted session; a later process must not guess it.
                session = (checked, uploadChunkSize)
            } catch CloudError.notFound {
                session = nil                       // reaped: fall through to a fresh init
            }
        }

        if session == nil {
            let (issuedId, chunkSize) = try await transport.initUpload(
                header: header, burnAfterRead: burnAfterRead, ttl: ttl, size: total, token: token)
            guard validUploadChunkSize(chunkSize) else { throw CloudError.decoding }
            session = (try StoredObjectID.checked(issuedId), chunkSize)
            committed = 0
        }
        guard let live = session else { throw CloudError.network }
        // Before any byte moves, so the plan records the session it is about to
        // feed — including a brand-new one that replaced a reaped session.
        try onUploadSession(live.id, live.chunkSize)

        if committed < total {
            let enc = try ChunkEncryptor(key: key, sources: sources, resumingAt: committed)
            try await pump(enc: enc, uploadId: live.id, chunkSize: live.chunkSize,
                           from: committed, total: total, token: token, onProgress: onProgress)
        } else {
            // Everything already landed. A zero-length PATCH at the end of the
            // stream is not a thing to send; finalizing is the only work left.
            onProgress(total, total)
        }

        try Task.checkCancellation()
        let r = try await transport.finalizeUpload(uploadId: live.id, token: token)
        return UploadOutcome(id: try StoredObjectID.checked(r.id),
                             expiresAt: r.expiresAt, keyB64url: encodeStoreKey(key))
    }

    /// The send loop, shared by a first attempt and a resume.
    ///
    /// `from` is the server's committed offset; the encryptor is already
    /// positioned there and carries `dropFromFirstFrame` for an offset that
    /// landed inside a frame. Everything else — the packing buffer, the
    /// no-copy slice handed to the transport, the replay on a partial commit —
    /// is unchanged, and the memory guards still measure it.
    private func pump(enc: ChunkEncryptor, uploadId: String, chunkSize: Int,
                      from: Int, total: Int, token: String,
                      onProgress: @escaping (_ sent: Int, _ total: Int) -> Void) async throws {
        // Held bytes double as the replay buffer: the server can commit part of a
        // chunk, so the unacknowledged tail must survive until it is acked.
        //
        // `Data`, not `[UInt8]`: the transport takes a slice of this buffer, and
        // a Data slice shares its storage while an Array slice has to be copied
        // into a new allocation to cross the call.
        var pending = Data()
        pending.reserveCapacity(chunkSize + STORE_CHUNK_SIZE + FRAME_OVERHEAD)
        var chunkStart = from
        var offset = from
        /// Bytes of the first frame the server already holds. Sliced off after
        /// the frame is sealed whole — the seal is what makes the tail
        /// byte-identical to the run this one continues.
        var drop = enc.dropFromFirstFrame
        bufferPeak = 0
        bytesCopiedToTransport = 0
        packingBufferReallocations = 0
        var lastStorageBase: UInt = 0
        func noteStorage(_ d: Data) {
            let base = d.withUnsafeBytes { UInt(bitPattern: $0.baseAddress) }
            if base != 0, lastStorageBase != 0, base != lastStorageBase {
                packingBufferReallocations += 1
            }
            if base != 0 { lastStorageBase = base }
        }

        let gate = ProgressGate(onProgress)
        gate.floor(from)
        onProgress(from, total)
        while offset < total {
            try Task.checkCancellation()
            while pending.count < chunkSize {
                guard var f = try enc.next() else { break }
                try Task.checkCancellation()
                if drop > 0 {
                    // Only ever the first frame, and only ever a prefix of it.
                    guard drop < f.count else { throw CloudError.server(status: 0) }
                    f = Data(f[(f.startIndex + drop)...])
                    drop = 0
                }
                pending += f
            }
            // Encryptor dry before the declared size was met: the formula and the
            // stream disagree. Better to fail than finalize a truncated blob.
            if pending.isEmpty { throw CloudError.server(status: 0) }
            bufferPeak = max(bufferPeak, pending.count)

            // In-flight progress, so the bar follows the bytes rather than the
            // chunk boundaries.
            gate.floor(offset)
            let received = try await patchWithRetry(
                uploadId: uploadId, bytes: pending,
                chunkStart: chunkStart, total: total, token: token,
                onBytesSent: { gate.report(min($0, total), total) })
            let consumed = received - chunkStart
            // Offset moving backwards, or past bytes we never produced: either way
            // we can no longer align, and sending more writes a misplaced stream.
            if consumed < 0 || consumed > pending.count { throw CloudError.server(status: 0) }
            // Never `removeFirst`: it drops the buffer's allocation, so the next
            // refill takes a fresh ~8.5 MB block — once per chunk, whatever the
            // network is doing. Measured on this codebase: removeFirst reallocated
            // 5/5 rounds, removeAll(keepingCapacity:) 0/5.
            if consumed >= pending.count {
                pending.removeAll(keepingCapacity: true)
            } else if consumed > 0 {
                // Partial commit — only after a reset mid-chunk. Copying the
                // unacknowledged tail is bounded by one chunk and happens on a
                // path that is already recovering from a network failure.
                let tail = Data(pending[(pending.startIndex + consumed)...])
                pending.removeAll(keepingCapacity: true)
                pending.append(tail)
            }
            noteStorage(pending)
            chunkStart = received
            offset = received
            onProgress(offset, total)
        }
        // The other half of the asymmetric guard: the loop ends on offset >= total,
        // so an under-reporting formula would leave frames unsent. Confirm dry.
        if try enc.next() != nil { throw CloudError.server(status: 0) }
    }

    /// `cipherSizeFor` is the wire-format reference used by interop tests, but
    /// its historical signature cannot report malformed negative sizes or
    /// arithmetic overflow. Network-facing code needs a checked form before a
    /// total is placed into a URL or `Content-Range`.
    private static func checkedCipherSize(_ sizes: [Int]) throws -> Int {
        var total = 0
        for size in sizes {
            guard size >= 0 else { throw StoredWireError.lengthMismatch }
            let frameCount = size == 0 ? 0 : ((size - 1) / STORE_CHUNK_SIZE) + 1
            let (overhead, overheadOverflow) = frameCount.multipliedReportingOverflow(by: FRAME_OVERHEAD)
            guard !overheadOverflow else { throw StoredWireError.lengthMismatch }
            let (withPayload, payloadOverflow) = size.addingReportingOverflow(overhead)
            guard !payloadOverflow else { throw StoredWireError.lengthMismatch }
            let (next, totalOverflow) = total.addingReportingOverflow(withPayload)
            guard !totalOverflow else { throw StoredWireError.lengthMismatch }
            total = next
        }
        return total
    }

    /// PATCH with resync-and-replay. A reset commits whatever landed, so the
    /// server's offset can fall inside the chunk we sent; replay from there.
    private func patchWithRetry(uploadId: String, bytes: Data, chunkStart: Int,
                                total: Int, token: String,
                                onBytesSent: @escaping (Int) -> Void) async throws -> Int {
        let end = chunkStart + bytes.count
        var from = chunkStart
        for attempt in 1...5 {
            do {
                // A Data slice shares the packing buffer's storage — no copy,
                // on the first attempt or on a replay. The replay path runs
                // exactly when the network is already unhappy, which is the
                // worst moment to double the resident buffer.
                let body = bytes[(bytes.startIndex + (from - chunkStart))...]
                bufferPeak = max(bufferPeak, bytes.count)
                // `from` moves on a retry, so the delegate's per-request count
                // is rebased onto the absolute offset. Without that, a resumed
                // chunk would restart the bar partway through the file.
                let base = from
                let outcome = try await transport.patchChunk(
                    uploadId: uploadId, bytes: body,
                    from: from, to: end, total: total, token: token,
                    onBytesSent: { onBytesSent(base + $0) })
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
        onProgress: @escaping (_ sent: Int, _ total: Int) -> Void
    ) async throws -> UploadOutcome {
        do {
            return try await upload(sources: sources, burnAfterRead: burnAfterRead,
                                    ttl: ttl, token: token, onProgress: onProgress)
        } catch is CancellationError {
            throw CancellationError()
        } catch let e as StoredLinkKeyError {
            // An identifier this app refused is a trust-boundary failure, not a
            // server too old to offer `/api/uploads`. Stated as its own clause
            // rather than left to the fact that it is not a `CloudError`,
            // because what must not happen is specific: falling through would
            // send every byte a SECOND time down the single-shot path, in
            // response to an answer that was already malformed. There is also
            // nothing to retry — the same id would be refused again.
            throw e
        } catch let e as CloudError {
            // Never mask a failure the user can act on, and never retry it.
            if e == .unauthorized || e == .quota || e == .rateLimited { throw e }
            if cipherSizeFor(sources.map(\.size)) > FALLBACK_MAX_CIPHER_BYTES { throw e }
            let s = try await singleShot(burnAfterRead, ttl, token)
            // The fallback reaches a different endpoint on an older server, so
            // it is a trust boundary of its own and gets the same check. An
            // `UploadOutcome` may not escape either path unchecked.
            return UploadOutcome(id: try StoredObjectID.checked(s.result.id),
                                 expiresAt: s.result.expiresAt,
                                 keyB64url: s.keyB64url)
        }
    }
}

/// Serialises progress reports and keeps them monotonic.
///
/// Two threads reach this: the upload loop, which sets a floor as each chunk
/// begins, and URLSession's delegate queue, which reports bytes leaving. Both
/// mutate the same "highest reported" value, so it is locked rather than left
/// to chance — and the monotonic rule is what stops a retried chunk, whose
/// per-request counter restarts, from dragging the bar backwards.
final class ProgressGate: @unchecked Sendable {
    private let lock = NSLock()
    private var high = 0
    private let emit: (Int, Int) -> Void

    init(_ emit: @escaping (Int, Int) -> Void) { self.emit = emit }

    /// Never report below this again (the committed offset of a finished chunk).
    func floor(_ n: Int) {
        lock.lock(); defer { lock.unlock() }
        if n > high { high = n }
    }

    func report(_ n: Int, _ total: Int) {
        lock.lock()
        guard n > high else { lock.unlock(); return }
        high = n
        lock.unlock()
        emit(n, total)
    }
}
