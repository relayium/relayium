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

/// What frame 0 of an upload seals.
///
/// Two documents, deliberately not one. The shared Stored-Wire manifest
/// describes public share objects whose bytes are frozen and interop-tested
/// across unrelated products; the Device Inbox v2 manifest carries a content
/// kind and is free to be stricter. Teaching the first about the second would
/// change what a share object looks like, so this type SELECTS between them and
/// no code path can end up producing a blend.
public enum UploadManifest: Equatable, Sendable {
    /// The shared Stored-Wire manifest, derived from the sources' names and
    /// sizes. What every public share upload has always sealed, byte for byte.
    case storedWire
    /// A dedicated, ALREADY CANONICAL plaintext document, sealed verbatim.
    ///
    /// The bytes belong to the caller — for a Device Inbox delivery they are
    /// `InboxManifest.encode`'s output — because this type must not acquire an
    /// opinion about a format whose canonical spelling is pinned by frozen
    /// cross-language vectors. It only seals what it is handed.
    case sealed([UInt8])
}

/// The manifest a purpose is allowed to seal, checked in both directions.
///
/// A `device_task` object whose frame 0 is the shared manifest is refused by its
/// own v2 receiver as `verify_failed` — after the whole ciphertext has been
/// uploaded. A share whose frame 0 is a v2 manifest is a download page that
/// cannot read its own file list. Neither is recoverable at the point it would
/// be discovered, so both are refused here, before a byte moves.
func uploadManifestMatches(purpose: UploadPurpose, manifest: UploadManifest) -> Bool {
    switch (purpose, manifest) {
    case (.deviceTask, .sealed): return true
    case (.deviceTask, .storedWire): return false
    case (.share, .storedWire): return true
    case (.share, .sealed): return false
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
    /// encrypted manifest. A pure function of (key, manifest) — which is what
    /// lets a re-initialized session be byte-identical to the one the server
    /// reaped, for a caller-sealed document exactly as for the shared one.
    static func manifestHeader(key: [UInt8], sources: [PlaintextSource],
                               manifest: UploadManifest = .storedWire) throws -> [UInt8] {
        let encManifest: [UInt8]
        switch manifest {
        case .storedWire:
            let stored = StoredManifest(files: sources.map { ManifestFile(name: $0.name, size: $0.size) })
            encManifest = try encryptManifest(key: key, stored)
        case .sealed(let plaintext):
            // Sealed verbatim, at the same AEAD unit the shared manifest uses —
            // sequence 0 under the content key — because v2 changes the DOCUMENT
            // at frame 0 and nothing about the framing around it.
            encManifest = seal(key: key, seq: 0, plaintext: plaintext)
        }
        let n = encManifest.count
        var header: [UInt8] = [UInt8(n >> 24 & 0xff), UInt8(n >> 16 & 0xff),
                               UInt8(n >> 8 & 0xff), UInt8(n & 0xff)]
        header += encManifest
        return header
    }

    /// `purpose` defaults to `.share`, which is what this entry point has always
    /// done and what every current caller means. The default is intentional
    /// rather than incidental: this path generates its own content key and hands
    /// back a `#k=` capability, which is a public share by definition. A device
    /// delivery goes through `resume`, where the purpose comes from the durable
    /// plan and is never inferred.
    public func upload(sources: [PlaintextSource], purpose: UploadPurpose = .share,
                       burnAfterRead: Bool, ttl: Int,
                       token: String,
                       onProgress: @escaping (_ sent: Int, _ total: Int) -> Void) async throws -> UploadOutcome {
        // This path mints its own content key and hands back a `#k=` capability,
        // which is a public share by definition — so the shared manifest is the
        // only coherent frame 0 here, and the check states it rather than
        // leaving it to the fact that no caller passes anything else.
        guard uploadManifestMatches(purpose: purpose, manifest: .storedWire) else {
            throw StoredWireError.invalidManifest
        }
        let raw = generateStoreKey()
        let header = try Self.manifestHeader(key: raw, sources: sources)
        let total = try Self.checkedCipherSize(sources.map(\.size))

        let (issuedId, chunkSize) = try await transport.initUpload(
            header: header, purpose: purpose, burnAfterRead: burnAfterRead,
            ttl: ttl, size: total, token: token)
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
    ///
    /// `purpose` has NO default here. A resumed job's purpose is a property of
    /// the durable plan, and the one thing this function must never do is
    /// re-open a reaped device delivery as a public share — which is exactly
    /// what an inherited `.share` default would do, silently, on the path where
    /// nobody is watching.
    ///
    /// `manifest` has no default for the same reason and one more. It decides
    /// which document frame 0 carries, it is derived from the durable plan, and
    /// it is derived on EVERY attempt: a retry, a reseal after a key rotation
    /// and a restart after the idle reaper all rebuild it from the same plan, so
    /// none of them can produce a delivery of a different kind — or fall back to
    /// the shared manifest — than the attempt before it.
    public func resume(sources: [PlaintextSource], key: [UInt8], uploadId: String?,
                       uploadChunkSize: Int?, purpose: UploadPurpose,
                       manifest: UploadManifest,
                       burnAfterRead: Bool, ttl: Int, token: String,
                       onUploadSession: (String, Int) throws -> Void,
                       onProgress: @escaping (_ sent: Int, _ total: Int) -> Void) async throws -> UploadOutcome {
        guard uploadManifestMatches(purpose: purpose, manifest: manifest) else {
            throw StoredWireError.invalidManifest
        }
        let header = try Self.manifestHeader(key: key, sources: sources, manifest: manifest)
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
            // The reaped-session path. It carries the SAME purpose as the plan
            // that opened the original session: the replacement object has to
            // be the same kind of object, or a delivery that was interrupted
            // for long enough becomes a public share on retry.
            let (issuedId, chunkSize) = try await transport.initUpload(
                header: header, purpose: purpose, burnAfterRead: burnAfterRead,
                ttl: ttl, size: total, token: token)
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

// MARK: - Device Inbox: finalize-recoverable upload

/// What the caller's durable record proves about a recorded upload session.
public enum DeliverySessionProvenance: Equatable, Sendable {
    /// Opened by this protected sender and persisted with its `uploading`
    /// phase before any byte moved. No finalize of it has ever been sent: every
    /// finalize is preceded by a durable `finalizing` phase. Only this state
    /// may ever re-initialize after a 404.
    case trustedUploading
    /// A finalize of this session may have been sent.
    case finalizing
    /// A session this sender did not open under its own phase record (a plan
    /// written by an earlier build). Whether a finalize was ever sent is
    /// unknown, so it is treated as possibly finalized for its whole life.
    case unproven
}

/// A recorded session handed to `resumeRecoverable`.
public struct DeliverySession: Equatable, Sendable {
    public let uploadId: String
    public let chunkSize: Int
    public let provenance: DeliverySessionProvenance

    public init(uploadId: String, chunkSize: Int, provenance: DeliverySessionProvenance) {
        self.uploadId = uploadId
        self.chunkSize = chunkSize
        self.provenance = provenance
    }
}

/// The object a recoverable upload ended with.
public struct RecoveredUpload: Equatable, Sendable {
    /// Checked through `StoredObjectID.checked`.
    public let id: String
    public let expiresAt: Int64
    /// The session this object was finalized from. The caller records the id
    /// only against exactly this session.
    public let uploadId: String
    /// Central answered from its record of an EARLIER finalize: nothing was
    /// completed or counted by this attempt.
    public let recovered: Bool
}

/// Why a recoverable upload stopped without an object.
public enum DeliveryUploadError: Error, Equatable, Sendable {
    /// Central may or may not hold an object for this session. Nothing may
    /// re-initialize it; the caller keeps every recovery input.
    case unconfirmed(DeliveryUnconfirmedReason)
    /// Central's durable record says the upload produced no usable object.
    case notCompleted(FinalizeOutcome)
    /// The caller's durable finalizing phase could not be written, so no
    /// finalize was sent.
    case finalizeStateNotRecorded
    /// The recorded session and central disagree about its bytes.
    case inconsistentSession
}

public enum DeliveryUnconfirmedReason: Equatable, Sendable {
    /// Every allowed attempt ended without a readable answer.
    case ambiguous
    /// Central kept answering `running` for longer than the budget.
    case stillRunning
    /// 404 after a finalize of this session may have been sent.
    case notFound
    /// A 409 that carries no recovery answer (a server without recovery).
    case unrecognizedConflict
    /// A refusal of a later request, which says nothing about an earlier one.
    case refusedAfterSend
}

/// Bounds for the recoverable finalize. Aligned with the CLI's accepted
/// `inboxsend.Session.finalize`.
///
/// Every bound is a COUNT or a SUM OF WAITS this code chose itself, never an
/// elapsed wall-clock reading: a clock moved backwards (or a suspended device)
/// cannot stretch the loop, and the total time spent waiting is at most
/// `ambiguousAttempts × backoffMax + runningBudget` whatever the clock does.
public struct FinalizeRecoveryPolicy: Sendable {
    public var ambiguousAttempts = 3
    /// Upper bound on the sum of `running` waits.
    public var runningBudget: TimeInterval = 60
    /// Upper bound on the number of `running` answers polled.
    public var runningPolls = 12
    public var runningPollDefault: TimeInterval = 5
    public var runningPollMin: TimeInterval = 1
    public var runningPollMax: TimeInterval = 10
    public var backoffStep: TimeInterval = 0.5
    public var backoffMax: TimeInterval = 2
    /// Injectable for tests; must honour cancellation. Every value passed is
    /// already clamped to at most `max(runningPollMax, backoffMax)`.
    public var sleep: @Sendable (TimeInterval) async throws -> Void = { seconds in
        try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
    }

    public init() {}

    func runningWait(_ hint: Int?) -> TimeInterval {
        guard let hint else { return min(max(runningPollDefault, runningPollMin), runningPollMax) }
        return min(max(TimeInterval(hint), runningPollMin), runningPollMax)
    }

    func backoff(_ attempt: Int) -> TimeInterval {
        min(max(0, backoffStep * Double(attempt)), backoffMax)
    }
}

extension CloudUploader {
    /// Continue a Device Inbox delivery's upload so that a lost finalize answer
    /// can never turn into a second object.
    ///
    /// Separate from `resume` on purpose: `resume` keeps the share path's
    /// existing behaviour — including its 404-means-reaped re-init, which can
    /// duplicate a share object after a lost finalize answer (a known residual,
    /// B30, not a behaviour this function relies on). Here the caller's durable
    /// record decides:
    ///
    ///  * `onUploadSession` persists a new session (with its trusted phase)
    ///    before any byte moves;
    ///  * `onFinalizing` persists "a finalize may have been sent" — a
    ///    compare-and-set against the caller's durable record — immediately
    ///    before EVERY finalize request: the first one, each retry, each
    ///    `running` poll and a recovery probe after a 404, because an opted-in
    ///    finalize of an open session is a real finalize. If it throws (the job
    ///    was discarded, retired, changed or cannot be written), that request
    ///    and every later one is not sent;
    ///  * a session is re-initialized only when it is `trustedUploading` and
    ///    central says it no longer exists. Every other doubt ends in
    ///    `DeliveryUploadError.unconfirmed`, never in a second upload.
    ///
    /// Device Inbox only: `purpose` must be `.deviceTask` with a sealed manifest.
    public func resumeRecoverable(sources: [PlaintextSource], key: [UInt8],
                                  session: DeliverySession?, purpose: UploadPurpose,
                                  manifest: UploadManifest, ttl: Int, token: String,
                                  policy: FinalizeRecoveryPolicy = FinalizeRecoveryPolicy(),
                                  onUploadSession: (String, Int) throws -> Void,
                                  onFinalizing: (String) throws -> Void,
                                  onProgress: @escaping (_ sent: Int, _ total: Int) -> Void)
        async throws -> RecoveredUpload {
        guard purpose == .deviceTask, case .sealed = manifest,
              uploadManifestMatches(purpose: purpose, manifest: manifest) else {
            throw StoredWireError.invalidManifest
        }
        let header = try Self.manifestHeader(key: key, sources: sources, manifest: manifest)
        let total = try Self.checkedCipherSize(sources.map(\.size))

        func finalize(_ id: String, sent: Bool) async throws -> RecoveredUpload {
            try await finalizeRecovering(id, sent: sent, policy: policy, token: token,
                                         beforeEachRequest: {
                do { try onFinalizing(id) } catch {
                    throw DeliveryUploadError.finalizeStateNotRecorded
                }
            })
        }

        if let recorded = session {
            let id = try StoredObjectID.checked(recorded.uploadId)
            guard validUploadChunkSize(recorded.chunkSize) else { throw CloudError.decoding }
            var offset: Int?
            do {
                try Task.checkCancellation()
                offset = try await transport.uploadOffset(uploadId: id, token: token)
            } catch CloudError.notFound {
                offset = nil
            }
            try Task.checkCancellation()
            if let r = offset, r < 0 || r > total { throw DeliveryUploadError.inconsistentSession }

            switch (recorded.provenance, offset) {
            case (.trustedUploading, let r?):
                if r < total {
                    let enc = try ChunkEncryptor(key: key, sources: sources, resumingAt: r)
                    try await pump(enc: enc, uploadId: id, chunkSize: recorded.chunkSize,
                                   from: r, total: total, token: token, onProgress: onProgress)
                } else {
                    onProgress(total, total)
                }
                return try await finalize(id, sent: false)
            case (.trustedUploading, nil):
                break                                // reaped before any finalize: re-init below
            case (.finalizing, let r?):
                // Every byte was acknowledged before the phase was written, and
                // an earlier finalize may still be in flight: never PATCH.
                guard r == total else { throw DeliveryUploadError.inconsistentSession }
                onProgress(total, total)
                return try await finalize(id, sent: true)
            case (.finalizing, nil):
                return try await finalize(id, sent: true)
            case (.unproven, let r?):
                // Consistent bytes may continue, but the session stays unproven:
                // an earlier build's finalize may still be in flight, so any
                // later 404 is never a reason to re-initialize.
                if r < total {
                    let enc = try ChunkEncryptor(key: key, sources: sources, resumingAt: r)
                    try await pump(enc: enc, uploadId: id, chunkSize: recorded.chunkSize,
                                   from: r, total: total, token: token, onProgress: onProgress)
                } else {
                    onProgress(total, total)
                }
                return try await finalize(id, sent: true)
            case (.unproven, nil):
                return try await finalize(id, sent: true)
            }
        }

        // A first session, or a trusted one central reaped before any finalize.
        // Same key and same manifest: the replacement ciphertext is
        // byte-identical, so no nonce ever seals different plaintext. (A reaped
        // session's committed bytes were already metered as monthly traffic;
        // sending them again meters them again. No second object or daily
        // debit can result, because the reaped session never finalized.)
        try Task.checkCancellation()
        let (issuedId, chunkSize) = try await transport.initUpload(
            header: header, purpose: purpose, burnAfterRead: false,
            ttl: ttl, size: total, token: token)
        guard validUploadChunkSize(chunkSize) else { throw CloudError.decoding }
        let id = try StoredObjectID.checked(issuedId)
        try onUploadSession(id, chunkSize)
        if total > 0 {
            let enc = try ChunkEncryptor(key: key, sources: sources, resumingAt: 0)
            try await pump(enc: enc, uploadId: id, chunkSize: chunkSize,
                           from: 0, total: total, token: token, onProgress: onProgress)
        } else {
            onProgress(0, 0)
        }
        return try await finalize(id, sent: false)
    }

    /// The bounded, opted-in finalize. `sent` is true when a finalize of this
    /// session may already have been sent (by this or an earlier attempt), which
    /// makes every refusal an answer about THIS request only.
    private func finalizeRecovering(_ uploadId: String, sent initiallySent: Bool,
                                    policy: FinalizeRecoveryPolicy, token: String,
                                    beforeEachRequest: () throws -> Void) async throws -> RecoveredUpload {
        var sent = initiallySent
        var ambiguous = 0
        var runningPolls = 0
        var runningWaited: TimeInterval = 0
        while true {
            try Task.checkCancellation()
            // The durable phase, re-asserted against the record on disk before
            // this very request: a job discarded or retired while this loop
            // slept can never be finalized by it.
            try beforeEachRequest()
            try Task.checkCancellation()
            let answer: FinalizeAnswer
            do {
                answer = try await transport.finalizeUploadRecovering(uploadId: uploadId, token: token)
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                // A cancelled URLSession task surfaces as a network error; it
                // must end the attempt, not spend a retry.
                try Task.checkCancellation()
                let cloud = error as? CloudError
                switch cloud {
                case .notFound?:
                    // With the phase written, a 404 cannot prove anything: the
                    // record may have been collected after an object existed.
                    throw DeliveryUploadError.unconfirmed(.notFound)
                case .unauthorized?, .quota?, .dailyQuota?, .monthlyTraffic?, .rateLimited?:
                    if sent { throw DeliveryUploadError.unconfirmed(.refusedAfterSend) }
                    throw error
                case .server(let status)? where status >= 400 && status < 500:
                    if sent { throw DeliveryUploadError.unconfirmed(.refusedAfterSend) }
                    throw error
                default:
                    // Transport failure, 5xx, unreadable answer: the request may
                    // have committed.
                    sent = true
                    ambiguous += 1
                    guard ambiguous < policy.ambiguousAttempts else {
                        throw DeliveryUploadError.unconfirmed(.ambiguous)
                    }
                    try await policy.sleep(policy.backoff(ambiguous))
                    continue
                }
            }
            switch answer {
            case .completed(let result, let recovered):
                guard result.expiresAt > 0,
                      let id = try? StoredObjectID.checked(result.id) else {
                    // A 2xx this build refuses to act on: an object may exist.
                    sent = true
                    ambiguous += 1
                    guard ambiguous < policy.ambiguousAttempts else {
                        throw DeliveryUploadError.unconfirmed(.ambiguous)
                    }
                    try await policy.sleep(policy.backoff(ambiguous))
                    continue
                }
                return RecoveredUpload(id: id, expiresAt: result.expiresAt,
                                       uploadId: uploadId, recovered: recovered)
            case .notCompleted(let outcome):
                throw DeliveryUploadError.notCompleted(outcome)
            case .running(let hint):
                sent = true
                runningPolls += 1
                let wait = policy.runningWait(hint)
                guard runningPolls < policy.runningPolls,
                      runningWaited + wait <= policy.runningBudget else {
                    throw DeliveryUploadError.unconfirmed(.stillRunning)
                }
                runningWaited += wait
                try await policy.sleep(wait)
            case .unconfirmedConflict:
                throw DeliveryUploadError.unconfirmed(.unrecognizedConflict)
            }
        }
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
    ///
    /// SHARE ONLY, and it says so by passing `.share` explicitly below rather
    /// than by inheriting a default. The fallback it wraps is the legacy
    /// whole-file endpoint, which has no purpose parameter at all — so a device
    /// delivery routed through here would fall back into creating a public
    /// object. A device send must use `resume` with a durable plan.
    public func uploadResumable(
        sources: [PlaintextSource],
        singleShot: (_ burnAfterRead: Bool, _ ttl: Int, _ token: String) async throws -> SingleShotResult,
        burnAfterRead: Bool, ttl: Int, token: String,
        onProgress: @escaping (_ sent: Int, _ total: Int) -> Void
    ) async throws -> UploadOutcome {
        do {
            return try await upload(sources: sources, purpose: .share,
                                    burnAfterRead: burnAfterRead,
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
