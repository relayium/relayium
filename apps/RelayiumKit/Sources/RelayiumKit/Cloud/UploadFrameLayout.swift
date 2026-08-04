import Foundation

/// Where a byte offset in the framed ciphertext stream comes from.
///
/// The stream is `frame(seal(key, seq, chunk))` repeated — a 4-byte big-endian
/// length, then ciphertext‖tag — with chunks of `STORE_CHUNK_SIZE` plaintext
/// taken from each file in turn and `seq` counting globally from 1 (0 is the
/// manifest). Nothing in that depends on timing, on the network, or on how the
/// bytes were chunked for transport: given the file sizes, the position of
/// every byte is arithmetic.
///
/// That is what makes a resume possible at all. The server commits bytes at an
/// exact offset and splices the next PATCH onto it, so a resumed run has to
/// produce the identical stream from an arbitrary point inside it — including
/// from inside a frame's length prefix, its ciphertext or its tag.
public struct FramePosition: Equatable {
    /// Which source the frame containing the offset is read from.
    public let fileIndex: Int
    /// The plaintext offset within that source where the frame BEGINS — not
    /// where the byte is. A frame is sealed whole or not at all.
    public let byteInFile: Int
    /// The sequence number of that frame, and therefore its AES-GCM nonce.
    public let seq: UInt64
    /// How many bytes of that frame the server already holds. The resumed run
    /// re-seals the whole frame and sends only what follows this.
    public let dropFromFrame: Int

    public init(fileIndex: Int, byteInFile: Int, seq: UInt64, dropFromFrame: Int) {
        self.fileIndex = fileIndex
        self.byteInFile = byteInFile
        self.seq = seq
        self.dropFromFrame = dropFromFrame
    }
}

/// The wire size of one frame carrying `plaintext` bytes.
/// Resolve `offset` in the stream `sizes` describes, or nil if it is negative
/// or lands at/after the end (there is no frame there to resume into).
///
/// A zero-length file contributes no frames and consumes no sequence number,
/// matching `encryptChunks`'s `off < size` loop and the web encoder. Getting
/// that wrong would shift every nonce after it by one and produce a stream that
/// decrypts to nothing.
public func framePosition(sizes: [Int], offset: Int) -> FramePosition? {
    guard offset >= 0, sizes.allSatisfy({ $0 >= 0 }) else { return nil }
    var seq: UInt64 = 1
    var remaining = offset
    for (fileIndex, size) in sizes.enumerated() {
        guard size >= 0 else { return nil }
        guard size > 0 else { continue }            // no frames, no seq

        let fullFrames = size / STORE_CHUNK_SIZE
        let tail = size % STORE_CHUNK_SIZE
        let fullWire = STORE_CHUNK_SIZE + FRAME_OVERHEAD
        let (fullSpan, spanOverflow) = fullFrames.multipliedReportingOverflow(by: fullWire)
        guard !spanOverflow else { return nil }

        if remaining < fullSpan {
            let frameIndex = remaining / fullWire
            guard let frameIndex64 = UInt64(exactly: frameIndex) else { return nil }
            let (frameSeq, seqOverflow) = seq.addingReportingOverflow(frameIndex64)
            guard !seqOverflow else { return nil }
            return FramePosition(fileIndex: fileIndex,
                                 byteInFile: frameIndex * STORE_CHUNK_SIZE,
                                 seq: frameSeq,
                                 dropFromFrame: remaining % fullWire)
        }
        remaining -= fullSpan
        guard let fullFrames64 = UInt64(exactly: fullFrames) else { return nil }
        let (afterFullFrames, seqOverflow) = seq.addingReportingOverflow(fullFrames64)
        guard !seqOverflow else { return nil }
        seq = afterFullFrames

        if tail > 0 {
            let tailWire = tail + FRAME_OVERHEAD
            if remaining < tailWire {
                return FramePosition(fileIndex: fileIndex,
                                     byteInFile: fullFrames * STORE_CHUNK_SIZE,
                                     seq: seq, dropFromFrame: remaining)
            }
            remaining -= tailWire
            let (afterTail, tailOverflow) = seq.addingReportingOverflow(1)
            guard !tailOverflow else { return nil }
            seq = afterTail
        }
    }
    return nil                                       // at or past the end
}
