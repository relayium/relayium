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
    private var index = 0
    private var hash = [UInt8](repeating: 0, count: 32)
    private var readInCurrent = 0
    private var pendingDone = false

    /// Peak bytes held at once. The guard that stops this quietly becoming
    /// `dataFrames` again.
    public private(set) var peakHeldBytes = 0

    public init(sender: RealtimeSender, sources: [PlaintextSource], declaredSizes: [Int]? = nil) {
        self.sender = sender
        self.sources = sources
        self.declaredSizes = declaredSizes ?? sources.map(\.size)
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
        while index < sources.count {
            guard index < declaredSizes.count, declaredSizes[index] >= 0 else {
                throw RealtimeSenderError.invalidManifest
            }
            if pendingDone {
                let f = sender.nextDoneFrame(hash: hash)
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
            let chunk = try sources[index].read(min(CHUNK_SIZE, remaining))
            if chunk.isEmpty {
                // End of this file. A source that stopped short of what the
                // manifest declared would otherwise send a DONE whose hash
                // covers fewer bytes than the receiver is expecting.
                throw RealtimeSenderError.sourceShorterThanDeclared(name: sources[index].name)
            }
            guard chunk.count <= remaining else {
                throw RealtimeSenderError.sourceLongerThanDeclared(name: sources[index].name)
            }
            readInCurrent += chunk.count
            hash = chainHash(hash, chunk)
            let f = sender.nextChunkFrame(chunk)
            peakHeldBytes = max(peakHeldBytes, chunk.count + f.count)
            return f
        }
        return nil
    }

    /// Next file: the chain hash resets per file while seq keeps climbing.
    private func advance() {
        index += 1
        hash = [UInt8](repeating: 0, count: 32)
        readInCurrent = 0
        pendingDone = false
    }
}
