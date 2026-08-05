import Foundation

/// What `RealtimeReceiver.feed` hands back for each frame it dispatches.
/// Mirrors transfer.ts's `Receiver.feed` return shape (`{batch?,chunk?,done?,resume?}`),
/// as a proper enum since only one case is ever populated per frame.
public enum RealtimeEvent: Equatable {
    case batch([FileMeta])
    case chunk([UInt8])
    case done(ok: Bool)
    case resume(index: Int, offset: Int, seq: UInt32)
    /// A non-final piece of a fragmented logical chunk or manifest: authenticated
    /// and buffered, but carrying no event of its own.
    ///
    /// Explicitly "nothing happened", not a chunk of zero bytes: nothing is
    /// written, hashed, parsed or checkpointed from a partial unit, so the
    /// durable state a lane can resume from stays exactly on the `CHUNK_SIZE`
    /// grid however the transport fragmented the bytes.
    case pending
}

public enum RealtimeError: Error, Equatable {
    case outOfOrder
    case tamper
    case legacyPeer
    case unknownKind(UInt8)
    case malformed
    case lengthMismatch
    /// A logical unit (chunk or manifest) exceeded its protocol maximum — either
    /// across buffered fragments or in one terminal frame.
    case oversizedFrame
    /// Fragments of two different logical units arrived interleaved.
    case interleavedParts
    /// A resume was requested into no active batch, to a point outside it or off
    /// the chunk grid, or with a chain snapshot that is not a SHA-256 state.
    case resumeRejected
}

/// Receive side of the RealtimeWire protocol: dispatches on frame kind,
/// decrypts BATCH/CHUNK/DONE against the running seq counter, verifies the
/// chained per-file hash, and surfaces resume announcements. Byte-pinned to
/// transfer.ts's `Receiver` class — feeding the web-produced `framesHex`
/// stream round-trips to the same manifest/bytes/DONE-ok the sender started
/// from, which is the interop proof for this direction.
public final class RealtimeReceiver {
    private let sessionKey: [UInt8]

    /// Same monotonic seq discipline as `RealtimeSender`: every encrypted
    /// frame (BATCH/CHUNK/DONE) consumes the next seq in order, so a
    /// mismatch means either a dropped/reordered frame or an injected one.
    ///
    /// Held one width wider than the 32-bit wire value, exactly like
    /// `RealtimeTextReceiver`'s counter. `UInt32.max` is a nonce a conforming
    /// sender genuinely emits — `RealtimeSender.reserveSequence` hands out that
    /// last value and only then fails closed — so a `UInt32` counter would trap
    /// the process on the increment after it, at a moment the PEER chooses. One
    /// past the ceiling is not a legal seq for any frame, which is precisely the
    /// state wanted: it compares unequal to every parsed `UInt32`, so everything
    /// after the last nonce is refused as out of order rather than wrapping onto
    /// a nonce that is already spent.
    private var expectedSeq: UInt64 = 0

    /// Running per-file chain hash, reset after each DONE (a batch can carry
    /// more than one file, each with its own chain).
    private var hash = [UInt8](repeating: 0, count: 32)
    private var files: [FileMeta]?
    private var fileIndex = 0
    private var receivedInFile = 0

    /// Every file of `files` has closed out.
    ///
    /// The manifest is deliberately RETAINED in that state rather than dropped,
    /// and the reason is the last frame of a batch. A `COMPLETE` lost with the
    /// transport is repaired by replaying the final encrypted DONE on the next
    /// generation — but `resumeAt` validates its point against the manifest, so a
    /// receiver that had already forgotten it would refuse the very frame the
    /// replay exists to deliver.
    ///
    /// Retaining it changes nothing else: a chunk or DONE after the last file
    /// still fails `fileIndex < files.count`, and the next batch is admitted by
    /// this flag exactly as it used to be admitted by `files == nil`.
    private var batchComplete = false

    /// Plaintext pieces of the logical chunk (or manifest) currently arriving,
    /// held until its terminating frame.
    private var parts: [[UInt8]] = []
    private var partBytes = 0
    private var partKind: UInt8 = 0

    /// Whether a piece of a logical unit is buffered right now.
    ///
    /// `partBytes` cannot answer this. A zero-length PART is authenticated and
    /// accepted — the count cap, not the byte cap, is what bounds those — so it
    /// is real buffered state that leaves the byte total at zero. Using the byte
    /// count as the proxy makes `joinParts` take its "nothing buffered" shortcut
    /// without clearing `parts`/`partKind`, stranding a kind that then refuses
    /// the next logical unit as interleaved, and makes DONE close a file out
    /// over a chunk the sender has not finished framing.
    private var hasParts: Bool { !parts.isEmpty }

    public init(sessionKey: [UInt8]) {
        self.sessionKey = sessionKey
    }

    /// A copy of the current file's running chain hash. The owner checkpoints it
    /// next to the bytes it has durably written, so a resume can restore a point
    /// where hash state and written bytes agree.
    public func snapshotChain() -> [UInt8] { hash }

    /// An ordered BATCH_ABORT has authenticated every emitted frame of the old
    /// batch. Reset only its per-file integrity state and its consent: the
    /// global nonce sequence deliberately continues, because the link's keys
    /// have not changed and a reusable lane goes on to carry the next batch.
    public func abortBatch() {
        hash = [UInt8](repeating: 0, count: 32)
        files = nil
        batchComplete = false
        fileIndex = 0
        receivedInFile = 0
        dropParts()
    }

    /// Realign a direction that has NO batch to continue.
    ///
    /// The other half of `resumeAt`, and it has to exist separately. Every
    /// transport generation after the first owes exactly one forward-only
    /// realignment before its first protected frame, including on a lane that is
    /// merely idle — otherwise the next batch's manifest would be sealed under a
    /// nonce this side cannot prove was never used. There is no batch here to
    /// validate a point against, so the only point that means anything is the
    /// batch-free origin, and the chain resets with it.
    ///
    /// Refuses while a batch is live: an "origin" realignment there would
    /// silently rewind a transfer's position while claiming to move the sequence
    /// forward, which is the one shape of this call that could lose bytes.
    public func resumeAtOrigin(seq: UInt32) throws {
        // Same forward-only rule as `resumeAt`, and for the same reason: moving
        // the receive nonce backwards would make an old ciphertext valid again
        // under the same key and sequence number.
        guard UInt64(seq) >= expectedSeq else { throw RealtimeError.outOfOrder }
        // A batch that has closed out is not a live one: there is no position
        // left for this call to rewind, so the direction is idle in exactly the
        // sense that matters here. Whether such a batch still owes a replayed
        // final DONE is the LANE's question, not this receiver's — the lane
        // chooses `resumeAt` for that and this call for the idle case.
        guard files == nil || batchComplete else { throw RealtimeError.resumeRejected }
        hash = [UInt8](repeating: 0, count: 32)
        expectedSeq = UInt64(seq)
        files = nil
        batchComplete = false
        fileIndex = 0
        receivedInFile = 0
        dropParts()
    }

    /// Restore this receiver to a durable checkpoint before feeding resumed
    /// frames.
    ///
    /// Everything is validated against state the receiver already holds, because
    /// the announcement that motivates this call arrives in plaintext on a
    /// channel with a signalling relay in the middle. The owner is expected to
    /// have compared the announced point against its OWN durable checkpoint
    /// first; this is the second gate, not the first.
    public func resumeAt(_ point: ResumePoint, chain: [UInt8], seq: UInt32) throws {
        // A resume may skip forward over frames that were sent and lost, but must
        // never move the receive nonce backwards: that would make an old
        // ciphertext valid again under the same key and sequence number.
        // Widened, not truncated: once the counter is past the 32-bit ceiling no
        // announced `seq` can reach it, so an exhausted sequence can never be
        // rewound into a range whose nonces have all been used.
        guard UInt64(seq) >= expectedSeq else { throw RealtimeError.outOfOrder }
        guard let files else { throw RealtimeError.resumeRejected }
        guard chain.count == 32 else { throw RealtimeError.resumeRejected }
        let sizes = files.map(\.size)
        guard resumePointInRange(point, sizes), resumePointAligned(point, sizes) else {
            throw RealtimeError.resumeRejected
        }
        hash = chain
        expectedSeq = UInt64(seq)
        fileIndex = point.index
        receivedInFile = point.offset
        // Restoring INTO a batch that had closed out IS the replayed final DONE,
        // so the completion flag comes back off with it — otherwise the frame the
        // replay delivers would arrive with the next-manifest gate still open.
        batchComplete = false
        // Pieces of a chunk the old transport cut in half are worthless: the
        // sender restarts from the checkpoint, which is a whole-chunk boundary.
        dropParts()
    }

    private func dropParts() {
        parts = []
        partBytes = 0
        partKind = 0
    }

    /// Buffer one non-final piece. `limit` bounds how much a peer can make this
    /// receiver hold before the terminating frame arrives.
    private func addPart(kind: UInt8, plain: [UInt8], limit: Int) throws {
        if partKind != 0, partKind != kind { throw RealtimeError.interleavedParts }
        if partBytes + plain.count > limit { throw RealtimeError.oversizedFrame }
        // A byte bound alone is not a bound: a peer can send unlimited
        // ZERO-length pieces, which never advance `partBytes` while each one
        // costs an array slot. The count bound is what actually closes that,
        // and it costs no legitimate sender anything — the smallest piece any
        // conforming sender may use is MIN_PIECE_BYTES, so the largest logical
        // unit (a MANIFEST_MAX_BYTES manifest) is at most 50 pieces.
        if parts.count >= MAX_PIECES_PER_LOGICAL_UNIT { throw RealtimeError.oversizedFrame }
        partKind = kind
        parts.append(plain)
        partBytes += plain.count
    }

    /// Join the buffered pieces with the terminating frame's plaintext.
    ///
    /// The limit is checked BEFORE the "nothing buffered" shortcut, because it
    /// bounds the logical unit, not the fragmentation. A peer that skips the PART
    /// kinds and sends one authenticated terminal frame is the cheapest way to
    /// hand this receiver an arbitrarily large plaintext to hash or JSON-parse
    /// before any consent — the very thing `addPart` exists to prevent.
    private func joinParts(kind: UInt8, plain: [UInt8], limit: Int) throws -> [UInt8] {
        if partKind != 0, partKind != kind { throw RealtimeError.interleavedParts }
        if partBytes + plain.count > limit { throw RealtimeError.oversizedFrame }
        if !hasParts { return plain }
        var out = [UInt8]()
        out.reserveCapacity(partBytes + plain.count)
        for p in parts { out += p }
        out += plain
        dropParts()
        return out
    }

    public func feed(_ encoded: [UInt8]) throws -> RealtimeEvent {
        guard encoded.count >= 5 else { throw RealtimeError.malformed }
        let kind = encoded[0]
        let seq = beU32(encoded)
        let payload = Array(encoded[5...])

        switch kind {
        case RealtimeKind.chunkPart, RealtimeKind.batchPart:
            // A non-final piece: authenticate it in sequence, buffer it, emit
            // nothing.
            guard UInt64(seq) == expectedSeq else { throw RealtimeError.outOfOrder }
            guard let piece = open(key: sessionKey, seq: UInt64(seq), ciphertext: payload) else {
                throw RealtimeError.tamper
            }
            expectedSeq += 1
            try addPart(kind: kind, plain: piece,
                        limit: kind == RealtimeKind.chunkPart ? CHUNK_SIZE : MANIFEST_MAX_BYTES)
            return .pending

        case RealtimeKind.batchEnc, RealtimeKind.chunk, RealtimeKind.doneEnc:
            guard UInt64(seq) == expectedSeq else { throw RealtimeError.outOfOrder }
            guard let plain = open(key: sessionKey, seq: UInt64(seq), ciphertext: payload) else {
                throw RealtimeError.tamper
            }
            expectedSeq += 1
            switch kind {
            case RealtimeKind.batchEnc:
                // The whole logical manifest, however many messages carried it —
                // and bounded before it is decoded, not after.
                let plain = try joinParts(kind: RealtimeKind.batchPart, plain: plain,
                                          limit: MANIFEST_MAX_BYTES)
                // A batch that has closed out is over: the next one is admitted
                // exactly as it used to be when the manifest was dropped here.
                guard files == nil || batchComplete else { throw RealtimeError.malformed }
                guard let decoded = try? JSONDecoder().decode(BatchPayload.self, from: Data(plain)) else {
                    throw RealtimeError.malformed
                }
                guard (try? validateRealtimeFiles(decoded.files)) != nil else {
                    throw RealtimeError.malformed
                }
                files = decoded.files
                batchComplete = false
                fileIndex = 0
                receivedInFile = 0
                // 文件名由发送端任意构造，接收方的确认卡片正是用户做信任决策的地方：
                // 在这个唯一入口把双向控制符洗掉。
                return .batch(decoded.files.map(sanitizeFileMeta))
            case RealtimeKind.chunk:
                // The whole logical chunk, however many messages carried it — so
                // the chain hash and the owner's write/checkpoint both see the
                // CHUNK_SIZE unit. The bound comes first: it is what stops an
                // unfragmented oversize frame from being hashed before consent.
                let plain = try joinParts(kind: RealtimeKind.chunkPart, plain: plain, limit: CHUNK_SIZE)
                guard let files, fileIndex < files.count,
                      plain.count <= files[fileIndex].size - receivedInFile else {
                    throw RealtimeError.lengthMismatch
                }
                receivedInFile += plain.count
                hash = chainHash(hash, plain)
                return .chunk(plain)
            default: // doneEnc
                // A file cannot end in the middle of a logical chunk. Leftover
                // pieces mean the sender's framing and ours disagree — fail
                // rather than close out a file over a short chunk. A buffered
                // piece carrying no bytes says that just as loudly as a short
                // one, so this asks whether a piece exists, not how big it was.
                guard !hasParts else { throw RealtimeError.malformed }
                guard let files, fileIndex < files.count,
                      receivedInFile == files[fileIndex].size else {
                    throw RealtimeError.lengthMismatch
                }
                guard let done = try? JSONDecoder().decode(DonePayload.self, from: Data(plain)) else {
                    throw RealtimeError.malformed
                }
                let ok = done.sha256 == hexEncoded(hash)
                hash = [UInt8](repeating: 0, count: 32) // reset chain for the next file in the batch
                fileIndex += 1
                receivedInFile = 0
                if fileIndex == files.count { batchComplete = true }
                return .done(ok: ok)
            }

        case RealtimeKind.resumeStart:
            // Plaintext, not decrypted: a mid-signaling attacker can inject this
            // frame, and its `seq` becomes the nonce counter's new starting
            // point — a malformed/NaN-ish value would make every subsequent
            // comparison false and stall the transfer. `parseResumeStart` owns
            // that strictness, and owning it in ONE place is what keeps this
            // path and the lane that decides on the announcement from ever
            // disagreeing about which frames are well formed.
            guard let announced = parseResumeStart(encoded) else { throw RealtimeError.malformed }
            return .resume(index: announced.point.index,
                           offset: announced.point.offset,
                           seq: announced.seq)

        case RealtimeKind.batchLegacy, RealtimeKind.doneLegacy:
            // Peer is running a pre-encrypted-manifest version. No plaintext
            // fallback: that fallback, once present, never goes away and is a
            // permanent downgrade path for a MITM. Fail closed instead.
            throw RealtimeError.legacyPeer

        default:
            throw RealtimeError.unknownKind(kind)
        }
    }
}

private func beU32(_ b: [UInt8]) -> UInt32 {
    (UInt32(b[1]) << 24) | (UInt32(b[2]) << 16) | (UInt32(b[3]) << 8) | UInt32(b[4])
}

private func hexEncoded(_ bytes: [UInt8]) -> String {
    let digits = Array("0123456789abcdef".utf8)
    var out = [UInt8](); out.reserveCapacity(bytes.count * 2)
    for b in bytes {
        out.append(digits[Int(b >> 4)])
        out.append(digits[Int(b & 0x0f)])
    }
    return String(decoding: out, as: UTF8.self)
}

// `safeIndex` — the non-negative JSON-safe-integer gate this file applies to
// RESUME_START's index/offset/seq — now lives in RealtimeResume.swift, next to
// the resume-request parser that applies exactly the same rule to exactly the
// same two numbers. One copy, so the two directions of the resume handshake
// cannot drift apart.

private struct BatchPayload: Decodable {
    let files: [FileMeta]
}

private struct DonePayload: Decodable {
    let sha256: String
}

/// Sanitize one manifest entry's display name and — since `FileMeta` carries
/// a folder-relative `path` that `sanitizeNames`/`ManifestFile` don't have —
/// sanitize it per path segment too, so a bidi/control-character payload
/// can't hide in a folder name either. Mirrors web/src/lib/filename.ts's
/// generic `sanitizeNames<T>` (name + per-`/`-segment path); R1-B's Swift
/// `sanitizeNames` only covers `ManifestFile`, which has no path field.
private func sanitizeFileMeta(_ f: FileMeta) -> FileMeta {
    let name = safeDisplayName(f.name)
    let path = f.path.map { p in
        p.split(separator: "/", omittingEmptySubsequences: false)
            .map { safeDisplayName(String($0)) }
            .joined(separator: "/")
    }
    return FileMeta(name: name, size: f.size, path: path)
}
