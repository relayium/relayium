import Foundation

/// Streams the CHUNK/DONE frames `dataFrames` returns all at once.
///
/// `dataFrames` takes every file's bytes and materialises every frame before
/// the first one is sent, so a transfer costs roughly twice its size in memory
/// — and realtime has no `MaxFileSize` equivalent to cap it, because nothing is
/// stored server-side.
///
/// It drives the caller's `RealtimeSender` rather than owning one. Seq is global
/// and monotonic across a transfer, so a producer with its own sender would
/// restart the GCM nonce counter at 0 under the same session key: a break of the
/// encryption rather than a bug in it.
public final class RealtimeFrameProducer {
    private let sender: RealtimeSender
    private var sources: [PlaintextSource]
    private let declaredSizes: [Int]
    private let resume: ResumePoint?
    private let maxFrameBytes: Double
    private var index = 0
    private var hash = [UInt8](repeating: 0, count: 32)
    private var readInCurrent = 0
    private var pendingDone = false

    /// Resolved on the first `next()`, together with the resume point's
    /// validation — both must fail before any protected frame exists, and both
    /// need to throw, which an initializer here deliberately does not.
    private var pieceBytes: Int?
    /// The logical chunk currently going out, and how much of it has been sealed.
    /// One chunk of plaintext plus one frame is the whole memory bill, whatever
    /// the transport's message size turns out to be.
    private var chunk: [UInt8] = []
    private var chunkOffset = 0
    private var chunkActive = false

    /// Peak bytes held at once. The guard that stops this quietly becoming
    /// `dataFrames` again.
    public private(set) var peakHeldBytes = 0

    /// - Parameters:
    ///   - resume: where a replaced transport picks the batch back up. Files
    ///     strictly before it are never opened or read; the file it points into
    ///     is read and hashed from byte zero — its DONE still covers the whole
    ///     file — but only whole logical chunks at or after the checkpoint are
    ///     emitted.
    ///   - maxFrameBytes: this connection's negotiated per-message ceiling. The
    ///     default is one whole logical chunk, which is what every current
    ///     desktop connection carries and what produces byte-for-byte the wire
    ///     this type emitted before fragmentation existed.
    ///
    /// There is deliberately no seek-by-path and no reopen: a `PlaintextSource`
    /// is pinned to a descriptor (or to data) from the moment it was staged, and
    /// naming a file a second time is exactly the lookup that can lie. A resumed
    /// batch therefore constructs a NEW producer over pristine staged copies
    /// rather than rewinding a used one.
    public init(sender: RealtimeSender,
                sources: [PlaintextSource],
                declaredSizes: [Int]? = nil,
                resume: ResumePoint? = nil,
                maxFrameBytes: Double = DEFAULT_MAX_FRAME_BYTES) {
        self.sender = sender
        self.sources = sources
        self.declaredSizes = declaredSizes ?? sources.map(\.size)
        self.resume = resume
        self.maxFrameBytes = maxFrameBytes
        self.index = resume?.index ?? 0
    }

    /// The next frame, or nil once every source has been read and closed out.
    ///
    /// The pool is load-bearing, not hygiene: `FileURLSource` reads through
    /// `FileHandle`, which returns autoreleased objects, and the send loop this
    /// feeds does not return until the whole transfer has gone out. Without a
    /// drain per frame the process grows by the size of the transfer even though
    /// `peakHeldBytes` — which only counts what Swift retains — stays at one
    /// chunk.
    public func next() throws -> [UInt8]? {
        try autoreleasepool { try nextFrame() }
    }

    private func nextFrame() throws -> [UInt8]? {
        guard sources.count == declaredSizes.count else {
            throw RealtimeSenderError.invalidManifest
        }
        let pieceBytes = try resolvedPieceBytes()
        while index < sources.count {
            guard index < declaredSizes.count, declaredSizes[index] >= 0 else {
                throw RealtimeSenderError.invalidManifest
            }
            // Mid-chunk: seal and hand back the next piece. The plaintext chunk
            // stays put until its final piece goes out, so a connection that
            // fragments changes the number of frames and nothing about memory.
            if chunkActive {
                let end = min(chunkOffset + pieceBytes, chunk.count)
                let isFinal = end >= chunk.count
                let f = try sender.nextChunkPieceFrame(Array(chunk[chunkOffset..<end]), isFinal: isFinal)
                peakHeldBytes = max(peakHeldBytes, chunk.count + f.count)
                if isFinal {
                    chunk = []
                    chunkOffset = 0
                    chunkActive = false
                } else {
                    chunkOffset = end
                }
                return f
            }
            if pendingDone {
                let f = try sender.nextDoneFrame(hash: hash)
                peakHeldBytes = max(peakHeldBytes, f.count)
                advance()
                return f
            }
            let remaining = declaredSizes[index] - readInCurrent
            if remaining == 0 {
                // Selection and transmission are separated by user confirmation
                // and pairing. Detect a file that grew in that interval instead
                // of silently sending bytes outside the authenticated manifest.
                if !(try sources[index].read(1)).isEmpty {
                    throw RealtimeSenderError.sourceLongerThanDeclared(name: sources[index].name)
                }
                pendingDone = true
                continue
            }
            // Filled COMPLETELY before it is hashed, compared against the resume
            // point, fragmented or exposed. `read` returns *up to* what it was
            // asked for, and `FileURLSource` is a single `pread`, which POSIX
            // lets return fewer bytes than requested long before end of file —
            // after partial progress around an interrupt, or simply per extent.
            //
            // Treating one positive short return as a whole logical chunk makes
            // the wire differ from `dataFrames`, so the browser cannot verify
            // the DONE; worse, it hands the receiver a chunk it will durably
            // checkpoint at an offset that is neither on the CHUNK_SIZE grid nor
            // the exact end of the file — and the sender then refuses the
            // receiver's own checkpoint as unaligned, which turns a recoverable
            // drop into a restart.
            let want = min(CHUNK_SIZE, remaining)
            var unit = [UInt8]()
            unit.reserveCapacity(want)
            while unit.count < want {
                let read = try sources[index].read(want - unit.count)
                if read.isEmpty {
                    // End of this file, mid-unit or at its start. A source that
                    // stopped short of what the manifest declared would otherwise
                    // send a DONE whose hash covers fewer bytes than the receiver
                    // is expecting. The half-filled unit is dropped here, before
                    // anything seals it.
                    throw RealtimeSenderError.sourceShorterThanDeclared(name: sources[index].name)
                }
                guard read.count <= want - unit.count else {
                    // A source that hands back more than it was asked for has
                    // produced bytes outside the window this position may take —
                    // at the end of a file that is literally the file having
                    // grown past its manifest entry, and anywhere else the
                    // source's own position can no longer be trusted to line up
                    // with the declared size. Either way the extra bytes cannot
                    // be placed on the chunk grid, so nothing goes out.
                    throw RealtimeSenderError.sourceLongerThanDeclared(name: sources[index].name)
                }
                unit += read
                peakHeldBytes = max(peakHeldBytes, unit.count)
            }
            let chunkStart = readInCurrent
            readInCurrent += unit.count
            // Hashed whole and from byte 0 even when it is not sent: the chain is
            // defined over CHUNK_SIZE pieces, so a resumed file's DONE still
            // covers every byte the receiver already wrote before the drop.
            hash = chainHash(hash, unit)
            if let resume, index == resume.index, chunkStart < resume.offset {
                continue   // already delivered: hashed, not sent
            }
            chunk = unit
            chunkOffset = 0
            chunkActive = true
        }
        return nil
    }

    /// The per-piece plaintext allowance, and the one place the resume point is
    /// validated.
    ///
    /// Both run before the first frame is built, so an unusable connection or a
    /// point the sender was never going to honour costs no nonce — which matters
    /// because a burned nonce cannot be given back, and "give it back" is exactly
    /// the wrong fix somebody reaches for.
    private func resolvedPieceBytes() throws -> Int {
        if let pieceBytes { return pieceBytes }
        let resolved = try piecePlainBytes(maxFrameBytes: maxFrameBytes)
        if let resume {
            guard resumePointInRange(resume, declaredSizes), resumePointAligned(resume, declaredSizes) else {
                throw RealtimeSenderError.resumePointRejected
            }
        }
        pieceBytes = resolved
        return resolved
    }

    /// Next file: the chain hash resets per file while seq keeps climbing.
    private func advance() {
        index += 1
        hash = [UInt8](repeating: 0, count: 32)
        readInCurrent = 0
        pendingDone = false
    }
}
