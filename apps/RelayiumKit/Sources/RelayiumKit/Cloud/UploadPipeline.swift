import Foundation

/// The send promise also owns its progress callbacks. Closing waits for an
/// admitted callback and rejects every callback arriving after termination.
final class UploadPipelineProgressLifetime: @unchecked Sendable {
    private let lock = NSRecursiveLock()
    private var closed = false
    func perform(_ action: () -> Void) {
        lock.lock(); defer { lock.unlock() }
        if !closed { action() }
    }
    func close() { lock.lock(); closed = true; lock.unlock() }
}

/// Owns the at-most-two prepared buffers after all network owners have joined.
/// Taking a buffer empties this owner before the serial path can mutate it.
final class NativeUploadPipelineResult {
    let completed: Bool
    let offset: Int
    let highestSent: Int
    let bufferPeak: Int
    private var pending: Data
    private var queued: [Data]
    init(completed: Bool, offset: Int, highestSent: Int, bufferPeak: Int,
         pending: Data = Data(), queued: [Data] = []) {
        self.completed = completed; self.offset = offset; self.highestSent = highestSent
        self.bufferPeak = bufferPeak; self.pending = pending; self.queued = queued
    }
    func takePending() -> Data { var value = Data(); swap(&value, &pending); return value }
    func takeQueued() -> [Data] { var value: [Data] = []; swap(&value, &queued); return value }
}

private final class PipelineBuffer {
    var bytes = Data()
    init(capacity: Int) { bytes.reserveCapacity(capacity) }
    func take() -> Data { var value = Data(); swap(&value, &bytes); return value }
}

private final class PipelineChunk {
    let id: Int
    let start: Int
    let count: Int
    let buffer: PipelineBuffer
    var sent = false
    var settled = false
    var end: Int { start + count }
    init(id: Int, start: Int, buffer: PipelineBuffer) {
        self.id = id; self.start = start; self.buffer = buffer; count = buffer.bytes.count
    }
}

private enum PipelineEvent: Sendable {
    case sent(Int)
    case answer(Int, PatchOutcome)
    case failed(Int, any Error)
}

/// Progress callbacks may arrive on arbitrary threads, including after a task
/// returned. Only one body-sent event is admitted before its terminal event.
private final class PipelineBodyGate: @unchecked Sendable {
    private let lock = NSLock()
    private var sent = false
    private var finished = false
    func report(_ emit: () -> Void) {
        lock.lock(); defer { lock.unlock() }
        guard !sent, !finished else { return }; sent = true; emit()
    }
    func finish() { lock.lock(); finished = true; lock.unlock() }
}

private final class PipelineTasks: @unchecked Sendable {
    private let lock = NSLock()
    private var tasks: [Int: Task<Void, Never>] = [:]
    private var cancelled = false
    private var attempted = 0
    func attemptedThrough(_ end: Int) { lock.lock(); attempted = max(attempted, end); lock.unlock() }
    var highestSent: Int { lock.lock(); defer { lock.unlock() }; return attempted }
    func add(_ task: Task<Void, Never>, id: Int) {
        lock.lock(); tasks[id] = task; let cancel = cancelled; lock.unlock()
        if cancel { task.cancel() }
    }
    private func take(_ id: Int) -> Task<Void, Never>? {
        lock.lock(); defer { lock.unlock() }; return tasks.removeValue(forKey: id)
    }
    func finish(_ id: Int) async { if let task = take(id) { await task.value } }
    func cancelAll() {
        lock.lock(); cancelled = true; let owned = Array(tasks.values); lock.unlock()
        for task in owned { task.cancel() }
    }
    private func takeAll() -> [Task<Void, Never>] {
        lock.lock(); defer { lock.unlock() }; let owned = Array(tasks.values); tasks.removeAll(); return owned
    }
    func drain() async { for task in takeAll() { await task.value } }
}

/// A fresh share only. Ciphertext production remains serial; the successor's
/// send overlaps the predecessor's confirmation, with at most two owners.
func runNativeUploadPipeline(
    chunkSize: Int, total: Int,
    next: () throws -> Data?,
    send: @escaping @Sendable (Data, Int, @escaping @Sendable () -> Void) async throws -> PatchOutcome,
    recover: (Int) async throws -> Int,
    confirmed: (Int) -> Void,
    buffered: (Int) -> Void
) async throws -> NativeUploadPipelineResult {
    let tasks = PipelineTasks()
    // Two events per live request, bounded independently of file size.
    let channel = AsyncStream.makeStream(of: PipelineEvent.self, bufferingPolicy: .bufferingNewest(8))
    do {
        let result = try await withTaskCancellationHandler {
            var iterator = channel.stream.makeAsyncIterator()
            var chunks: [Int: PipelineChunk] = [:]
            var pool: [PipelineBuffer] = []
            var frontier = 0, floor = 0, serial = 0, peak = 0
            var fallback = false
            while !fallback {
                try Task.checkCancellation()
                if floor == total && chunks.values.allSatisfy({ $0.settled }) {
                    if try next() != nil { throw CloudError.server(status: 0) }
                    return NativeUploadPipelineResult(completed: true, offset: floor,
                        highestSent: tasks.highestSent, bufferPeak: peak)
                }
                for id in Array(chunks.keys) {
                    if let c = chunks[id], c.settled, c.end <= floor {
                        pool.append(c.buffer); chunks.removeValue(forKey: id)
                    }
                }
                let last = chunks.values.max(by: { $0.start < $1.start })
                if frontier < total && chunks.count < 2 && (last == nil || last!.sent || last!.settled) {
                    let buffer = pool.popLast() ?? PipelineBuffer(capacity: chunkSize + STORE_CHUNK_SIZE + FRAME_OVERHEAD)
                    buffer.bytes.removeAll(keepingCapacity: true)
                    while buffer.bytes.count < chunkSize && frontier + buffer.bytes.count < total {
                        try Task.checkCancellation()
                        guard let frame = try next(), frame.count <= total - frontier - buffer.bytes.count else { throw CloudError.server(status: 0) }
                        buffer.bytes.append(frame)
                    }
                    guard !buffer.bytes.isEmpty else { throw CloudError.server(status: 0) }
                    serial += 1
                    let c = PipelineChunk(id: serial, start: frontier, buffer: buffer)
                    chunks[c.id] = c; frontier += c.count
                    peak = max(peak, chunks.values.reduce(0, { $0 + $1.count }))
                    buffered(peak)
                    let id = c.id, start = c.start, end = c.end, body = buffer.bytes
                    let task = Task {
                        let bodyGate = PipelineBodyGate()
                        do {
                            try Task.checkCancellation()
                            tasks.attemptedThrough(end)
                            let answer = try await send(body, start) {
                                bodyGate.report { channel.continuation.yield(.sent(id)) }
                            }
                            bodyGate.finish()
                            channel.continuation.yield(.answer(id, answer))
                        } catch {
                            bodyGate.finish()
                            channel.continuation.yield(.failed(id, error))
                        }
                    }
                    tasks.add(task, id: id)
                    continue
                }
                guard let event = await iterator.next() else { throw CancellationError() }
                switch event {
                case .sent(let id): chunks[id]?.sent = true
                case .answer(let id, let answer):
                    guard let c = chunks[id] else { continue }
                    await tasks.finish(id) // A buffer cannot be reused before its owner exits.
                    c.settled = true
                    let received: Int
                    switch answer { case .committed(let n), .serverAhead(let n): received = n }
                    guard received >= 0, received <= tasks.highestSent else { throw CloudError.server(status: 0) }
                    if received > floor { floor = received; confirmed(received) }
                    if received < c.end && floor < c.end { fallback = true }
                case .failed(let id, let error):
                    await tasks.finish(id)
                    try Task.checkCancellation()
                    // Preserve actionable refusals. Only an uncertain transport
                    // or server result may enter same-session serial recovery.
                    if let cloud = error as? CloudError {
                        switch cloud {
                        case .unauthorized, .quota, .rateLimited, .dailyQuota, .monthlyTraffic, .notFound: throw cloud
                        default: break
                        }
                    } else if !(error is URLError) { throw error }
                    fallback = true
                }
            }
            tasks.cancelAll(); await tasks.drain()
            try Task.checkCancellation()
            let received = try await recover(floor)
            guard received >= floor, received <= tasks.highestSent else { throw CloudError.server(status: 0) }
            if received > floor { floor = received; confirmed(received) }
            var remaining = chunks.values.filter({ $0.end > floor }).sorted(by: { $0.start < $1.start })
            var pending = Data()
            if !remaining.isEmpty {
                let first = remaining.removeFirst()
                guard floor >= first.start else { throw CloudError.server(status: 0) }
                pending = first.buffer.take(); pending.removeFirst(floor - first.start)
            }
            return NativeUploadPipelineResult(completed: false, offset: floor,
                highestSent: tasks.highestSent, bufferPeak: peak,
                pending: pending, queued: remaining.map { $0.buffer.take() })
        } onCancel: {
            tasks.cancelAll(); channel.continuation.finish()
        }
        tasks.cancelAll(); await tasks.drain(); channel.continuation.finish()
        try Task.checkCancellation()
        return result
    } catch {
        tasks.cancelAll(); await tasks.drain(); channel.continuation.finish()
        throw error
    }
}

/// Pending pipeline bytes already handed to the transport. It can discard
/// only this retained prefix when a late cumulative ACK passes the current
/// serial packing buffer; it never skips unread plaintext/encryptor output.
struct UploadCipherReplay {
    private var chunks: [Data]
    private var index = 0
    private var offset = 0
    init(_ chunks: consuming [Data]) { self.chunks = consume chunks }
    mutating func next() -> Data? {
        while index < chunks.count && offset == chunks[index].count { chunks[index] = Data(); index += 1; offset = 0 }
        guard index < chunks.count else { return nil }
        let n = min(chunks[index].count-offset, STORE_CHUNK_SIZE + FRAME_OVERHEAD)
        let start = chunks[index].startIndex + offset
        let value = chunks[index][start..<(start+n)]
        offset += n
        return value
    }
    mutating func skip(_ count: Int) -> Bool {
        guard count >= 0, count <= chunks[index...].reduce(0, { $0 + $1.count })-offset else { return false }
        var left = count
        while left > 0 {
            while index < chunks.count && offset == chunks[index].count { chunks[index] = Data(); index += 1; offset = 0 }
            let n = min(left, chunks[index].count-offset); offset += n; left -= n
        }
        return true
    }
    var isEmpty: Bool { chunks[index...].reduce(0, { $0 + $1.count }) == offset }
}
