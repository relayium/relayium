import Foundation
import Darwin

public enum PlaintextSourceError: Error, Equatable {
    /// The file could not be opened or is not a regular file.
    case unreadable(name: String)
    /// A read failed part-way through. The bytes already sent are covered by the
    /// per-file DONE hash, so the receiver rejects the file rather than keeping
    /// a truncated one.
    case readFailed(name: String, errno: Int32)
    /// The process ran out of file descriptors while pinning the selection.
    /// Carries the soft limit in force when it happened.
    case tooManyOpenFiles(limit: Int)
}

/// Owns one open file descriptor for as long as anything references it.
///
/// A class, deliberately: `FileURLSource` is a struct, and a struct has no
/// deinit, so a descriptor held directly in one would leak on every path that
/// simply drops a staged batch — a cancelled selection, a failed handshake,
/// `teardown()` clearing `pendingSend`. ARC releasing this object is what makes
/// "the batch went away" and "the descriptors are closed" the same event, with
/// no `close()` call for a future caller to forget.
final class OpenFile {
    let fd: Int32
    init(fd: Int32) { self.fd = fd }
    deinit { close(fd) }
}

@inline(__always)
private func retryingEINTR(_ body: () -> Int32) -> Int32 {
    while true {
        let r = body()
        if r >= 0 || errno != EINTR { return r }
    }
}

@inline(__always)
private func retryingEINTRSize(_ body: () -> Int) -> Int {
    while true {
        let r = body()
        if r >= 0 || errno != EINTR { return r }
    }
}

/// The soft descriptor limit currently in force, or 0 if it cannot be read.
public func currentDescriptorLimit() -> Int {
    var limit = rlimit()
    guard getrlimit(RLIMIT_NOFILE, &limit) == 0 else { return 0 }
    return limit.rlim_cur > rlim_t(Int.max) ? Int.max : Int(limit.rlim_cur)
}

/// Best-effort: raise the soft descriptor limit toward what pinning `count`
/// files needs. Never lowers, never throws, never promises.
///
/// Pinning is what makes a staged send safe (see `FileURLSource`), and pinning
/// `MAX_FILES` files means `MAX_FILES` descriptors, against a soft
/// `RLIMIT_NOFILE` that is 256 on some macOS configurations.
///
/// It deliberately does NOT decide in advance whether the selection will fit.
/// That prediction cannot be made from the rlimit: macOS accepts a soft limit
/// far above what a process can actually open — `setrlimit` to 2^40 succeeds
/// here while `kern.maxfilesperproc` is 61440 — so a check based on the limit
/// would report success and then fail anyway. The truthful answer comes from the
/// opens themselves, which is why `FileURLSource` reports `EMFILE` as its own
/// error rather than as "couldn't read that file".
public func raiseDescriptorBudget(for count: Int, reserve: Int = 512) {
    guard count > 0 else { return }
    var limit = rlimit()
    guard getrlimit(RLIMIT_NOFILE, &limit) == 0 else { return }
    // Two separate traps to avoid, both reachable from public API:
    //
    // * `count + reserve` overflowing. With `count > 0` already established,
    //   that can only happen upward, so `Int.max` is the right clamp.
    // * a NEGATIVE sum — `count: 1, reserve: -2`, or any `reserve` near
    //   `Int.min` — reaching `rlim_t(_:)`, which traps on a negative value.
    //   Nothing to raise toward, so there is nothing to do.
    let (sum, overflowed) = count.addingReportingOverflow(reserve)
    let wanted = overflowed ? Int.max : sum
    guard wanted > 0 else { return }
    var target = rlim_t(wanted)
    // Capped at what the kernel would honour anyway. No `RLIM_INFINITY`
    // comparison: Swift does not import the macro, and its macOS value is
    // `Int64.max` rather than the `UInt64.max` the name suggests — `min`
    // against the hard limit is right for both an "infinite" and a bounded one.
    if let ceiling = perProcessDescriptorCeiling() { target = min(target, ceiling) }
    target = min(target, limit.rlim_max)
    guard target > limit.rlim_cur else { return }
    var raised = limit
    raised.rlim_cur = target
    _ = setrlimit(RLIMIT_NOFILE, &raised)
}

/// `kern.maxfilesperproc` — the ceiling the kernel actually enforces, whatever
/// the rlimit says.
private func perProcessDescriptorCeiling() -> rlim_t? {
    var value: Int32 = 0
    var size = MemoryLayout<Int32>.size
    guard sysctlbyname("kern.maxfilesperproc", &value, &size, nil, 0) == 0, value > 0 else {
        return nil
    }
    return rlim_t(value)
}

/// A plaintext byte source read strictly forward. Files are read through this
/// rather than loaded, which is the difference between a bounded upload and a
/// file-sized one.
public protocol PlaintextSource {
    var name: String { get }
    var size: Int { get }
    /// Returns up to `max` bytes, or fewer at end of input. Empty means done.
    mutating func read(_ max: Int) throws -> [UInt8]
}

public struct DataSource: PlaintextSource {
    public let name: String
    private let bytes: [UInt8]
    private var off = 0
    public var size: Int { bytes.count }
    public init(name: String, bytes: [UInt8]) { self.name = name; self.bytes = bytes }
    public mutating func read(_ max: Int) throws -> [UInt8] {
        guard off < bytes.count else { return [] }
        let end = min(off + max, bytes.count)
        defer { off = end }
        return Array(bytes[off..<end])
    }
}

/// A file pinned by descriptor from the moment it is staged until the batch it
/// belongs to is released.
///
/// The descriptor is the point. Staging used to open the file, check it, close
/// it, and reopen the same PATH minutes later when the peer finally answered —
/// so between consent and transmission the name could be pointed at something
/// else entirely and the bytes on the wire would be the attacker's, under the
/// filename the user approved. No amount of re-checking fixes that: any check
/// names the file a second time, and the second lookup is the one that can lie.
///
/// Holding the descriptor removes the second lookup. `pread` on it reads the
/// inode that was opened and validated, so replacing the final component,
/// replacing a directory anywhere above it, or swapping in a file of exactly the
/// same size all change nothing about what is sent. `O_NOFOLLOW` additionally
/// refuses a symlink at the leaf, which is consistent with `expandSelection`
/// refusing symlinks outright.
///
/// What this does NOT cover: a process that can write to the file can still
/// change its CONTENT in place, through the very inode we pinned. Nothing
/// client-side can prevent that. It is bounded rather than silent — the
/// receiver verifies a per-file chained hash of what actually arrived, and
/// `RealtimeFrameProducer` refuses a source that has grown or shrunk against the
/// manifest the receiver consented to.
public struct FileURLSource: PlaintextSource {
    public let name: String
    public let size: Int
    /// Class-held so ARC closes it when the staged batch is dropped. `pread`
    /// takes the offset explicitly, so copies of this struct share the
    /// descriptor without sharing a file position.
    private let pin: OpenFile
    private var offset = 0

    /// `name` overrides the manifest name this source reports. A folder upload
    /// needs it: the stored manifest encodes hierarchy in `ManifestFile.name` as
    /// a forward-slash relative path (the convention the Go CLI's
    /// `walkUploadPaths` already writes and `safeJoin` already reads), so the
    /// name is "photos/sub/a.jpg" while the URL is an absolute local path.
    public init(url: URL, name: String? = nil) throws {
        let reported = name ?? url.lastPathComponent
        // `O_NONBLOCK` is not optional here, and not an optimisation.
        //
        // The type check has to happen AFTER the open — only `fstat` on the
        // descriptor says what was really opened, and asking the path first
        // would be the check-then-use this whole design removes. But a blocking
        // `open(O_RDONLY)` on a FIFO does not return until some other process
        // opens the write end, so the check would never be reached: staging
        // would hang forever on a named pipe, holding the main actor. With
        // `O_NONBLOCK` the open returns immediately and `fstat` gets to refuse
        // it. On a regular file the flag has no effect on `read`/`pread` at all.
        let fd = retryingEINTR {
            open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        }
        guard fd >= 0 else {
            // Descriptor exhaustion is not "that file is unreadable" — every
            // file in the selection is fine and the batch is simply too large
            // for this process. Saying so is the difference between a user
            // hunting for a corrupt file and one splitting the batch.
            let code = errno
            if code == EMFILE || code == ENFILE {
                throw PlaintextSourceError.tooManyOpenFiles(limit: currentDescriptorLimit())
            }
            throw PlaintextSourceError.unreadable(name: reported)
        }
        // Owned from here: if anything below throws, ARC closes it.
        let pin = OpenFile(fd: fd)
        var st = stat()
        guard fstat(fd, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG else {
            // A FIFO, socket, directory or device. None of them is a file with
            // bytes to send, and a FIFO would have blocked the reader forever.
            throw PlaintextSourceError.unreadable(name: reported)
        }
        // Now that it is known to be a regular file, drop the flag: it is inert
        // for regular files, and leaving it set would quietly change behaviour
        // for anything that later reaches this descriptor expecting a plain
        // blocking read.
        let flags = fcntl(fd, F_GETFL)
        if flags >= 0 { _ = fcntl(fd, F_SETFL, flags & ~O_NONBLOCK) }
        self.name = reported
        self.size = Int(st.st_size)
        self.pin = pin
    }

    public mutating func read(_ max: Int) throws -> [UInt8] {
        guard max > 0 else { return [] }
        var buffer = [UInt8](repeating: 0, count: max)
        let n: Int = buffer.withUnsafeMutableBytes { raw in
            retryingEINTRSize { pread(pin.fd, raw.baseAddress, max, off_t(offset)) }
        }
        guard n >= 0 else { throw PlaintextSourceError.readFailed(name: name, errno: errno) }
        guard n > 0 else { return [] }
        offset += n
        buffer.removeLast(max - n)
        return buffer
    }
}

/// Yields the same framed ciphertext stream as `encryptChunks`, one frame at a
/// time. `seq` is global across files and starts at 1, because 0 is the
/// manifest — the same rule the batch encoder and the web both follow.
public final class ChunkEncryptor {
    private let key: [UInt8]
    private var sources: [PlaintextSource]
    private var index = 0
    private var seq: UInt64 = 1

    /// Bytes of the FIRST frame this encryptor yields that the server already
    /// holds. Zero for a fresh encryptor; set when resuming into a frame's
    /// interior, where the frame must be sealed whole and then sliced.
    public private(set) var dropFromFirstFrame = 0

    public init(key: [UInt8], sources: [PlaintextSource]) {
        self.key = key
        self.sources = sources
    }

    /// Position a fresh encryptor at the frame containing `offset` in the
    /// framed stream, so `next()` yields exactly the frames from there on.
    ///
    /// **Fresh sources, never a seek.** The sources handed in must be at their
    /// start; this advances the one that carries the offset by reading and
    /// discarding in bounded steps. A `seek` on the protocol would be faster
    /// and worse: every conformer would then owe a correct rewind, and a source
    /// whose position was wrong by one byte produces a stream that is valid
    /// AES-GCM and decrypts to rubbish. Reading forward from a known start
    /// cannot be wrong by construction, and the cost is disk, not network.
    ///
    /// Sources before the offset's file are never read at all; sources after it
    /// are untouched and start where they always would.
    public convenience init(key: [UInt8], sources: [PlaintextSource], resumingAt offset: Int) throws {
        self.init(key: key, sources: sources)
        guard offset > 0 else { return }
        guard let position = framePosition(sizes: sources.map(\.size), offset: offset) else {
            throw StoredWireError.lengthMismatch
        }
        index = position.fileIndex
        seq = position.seq
        dropFromFirstFrame = position.dropFromFrame
        var consumed = 0
        while consumed < position.byteInFile {
            let want = min(STORE_CHUNK_SIZE, position.byteInFile - consumed)
            let got = try self.sources[index].read(want)
            // A source that ran dry before the offset it is supposed to hold is
            // not the source this plan was staged from.
            guard !got.isEmpty, got.count <= want else {
                throw StoredWireError.lengthMismatch
            }
            consumed += got.count
        }
    }

    /// The next frame, or nil once every source is exhausted.
    ///
    /// Returns `Data` rather than `[UInt8]` so the packing buffer it feeds can
    /// hand slices to the transport without copying — `Data` slices share
    /// storage, `Array` slices do not survive the trip without a copy.
    public func next() throws -> Data? {
        while index < sources.count {
            let pt = try sources[index].read(STORE_CHUNK_SIZE)
            if pt.isEmpty { index += 1; continue }
            guard pt.count <= STORE_CHUNK_SIZE else {
                throw StoredWireError.lengthMismatch
            }
            let f = Data(frame(seal(key: key, seq: seq, plaintext: pt)))
            seq += 1
            return f
        }
        return nil
    }
}
