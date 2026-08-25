import Foundation

/// A URLSession body stream with byte-counted backpressure.
///
/// `AsyncThrowingStream` is unbounded by default. A fast download feeding a
/// slow decryptor or disk writer can therefore retain the whole ciphertext in
/// memory. Buffer-dropping policies are not an option for authenticated frames:
/// one dropped byte makes the rest of the stream undecryptable. This sequence
/// suspends its owning data task at `highWaterBytes`, resumes after consumption
/// reaches `lowWaterBytes`, and cancels the task when iteration is abandoned.
public final class BoundedDataStream: AsyncSequence, @unchecked Sendable {
    public typealias Element = Data

    public final class Iterator: AsyncIteratorProtocol {
        private var stream: BoundedDataStream?

        fileprivate init(_ stream: BoundedDataStream) {
            self.stream = stream
        }

        public func next() async throws -> Data? {
            guard let stream else { return nil }
            do {
                let value = try await withTaskCancellationHandler {
                    try await stream.nextElement()
                } onCancel: {
                    stream.cancel()
                }
                if value == nil { self.stream = nil }
                return value
            } catch {
                self.stream = nil
                throw error
            }
        }

        deinit {
            // A `break`, decrypt/write failure, or owner disappearing must not
            // leave a delivery-sized request running in the background.
            stream?.cancel()
        }
    }

    private let lock = NSLock()
    private let highWaterBytes: Int
    private let lowWaterBytes: Int
    private var queue: [Data] = []
    private var queueHead = 0
    private var bufferedBytes = 0
    private var waiter: CheckedContinuation<Data?, Error>?
    private var terminal: Result<Void, Error>?
    private struct TaskControl {
        let suspend: () -> Void
        let resume: () -> Void
        let cancel: () -> Void
    }
    private var taskControl: TaskControl?
    private var taskSuspended = false

    public init(highWaterBytes: Int = 1 << 20, lowWaterBytes: Int = 1 << 19) {
        precondition(highWaterBytes > 0)
        precondition(lowWaterBytes >= 0 && lowWaterBytes < highWaterBytes)
        self.highWaterBytes = highWaterBytes
        self.lowWaterBytes = lowWaterBytes
    }

    deinit { cancel() }

    public func makeAsyncIterator() -> Iterator { Iterator(self) }

    /// Associate the one task whose delegate feeds this stream.
    func attach(_ task: URLSessionDataTask) {
        attach(suspend: { [weak task] in task?.suspend() },
               resume: { [weak task] in task?.resume() },
               cancel: { [weak task] in task?.cancel() })
    }

    func attach(suspend: @escaping () -> Void,
                resume: @escaping () -> Void,
                cancel: @escaping () -> Void) {
        lock.lock()
        precondition(taskControl == nil, "BoundedDataStream may own only one URLSession task")
        if terminal != nil {
            lock.unlock()
            cancel()
            return
        }
        taskControl = TaskControl(suspend: suspend, resume: resume, cancel: cancel)
        lock.unlock()
    }

    /// Enqueue one delegate callback without dropping or coalescing its bytes.
    public func yield(_ data: Data) {
        guard !data.isEmpty else { return }
        var direct: CheckedContinuation<Data?, Error>?
        lock.lock()
        if terminal == nil {
            if let waiting = waiter {
                waiter = nil
                direct = waiting
            } else {
                queue.append(data)
                bufferedBytes += data.count
                if bufferedBytes >= highWaterBytes, !taskSuspended, let taskControl {
                    // Performed while holding the state lock so a concurrent
                    // low-water dequeue cannot race a resume before this suspend.
                    taskControl.suspend()
                    taskSuspended = true
                }
            }
        }
        lock.unlock()
        direct?.resume(returning: data)
    }

    public func finish(throwing error: Error? = nil) {
        var waiting: CheckedContinuation<Data?, Error>?
        lock.lock()
        guard terminal == nil else { lock.unlock(); return }
        terminal = error.map { .failure($0) } ?? .success(())
        taskControl = nil // completion happened; break task→delegate→stream retention
        taskSuspended = false
        if queueHead == queue.count {
            waiting = waiter
            waiter = nil
        }
        lock.unlock()
        if let waiting {
            if let error { waiting.resume(throwing: error) }
            else { waiting.resume(returning: nil) }
        }
    }

    public func cancel() {
        var waiting: CheckedContinuation<Data?, Error>?
        var ownedTask: TaskControl?
        lock.lock()
        if terminal == nil {
            terminal = .failure(CancellationError())
            queue.removeAll(keepingCapacity: false)
            queueHead = 0
            bufferedBytes = 0
            waiting = waiter
            waiter = nil
            ownedTask = taskControl
            taskControl = nil
            taskSuspended = false
        }
        lock.unlock()
        ownedTask?.cancel()
        waiting?.resume(throwing: CancellationError())
    }

    private func nextElement() async throws -> Data? {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if queueHead < queue.count {
                let data = queue[queueHead]
                queueHead += 1
                bufferedBytes -= data.count
                if queueHead >= 32, queueHead * 2 >= queue.count {
                    queue.removeFirst(queueHead)
                    queueHead = 0
                }
                if taskSuspended, bufferedBytes <= lowWaterBytes, let taskControl {
                    taskControl.resume()
                    taskSuspended = false
                }
                lock.unlock()
                continuation.resume(returning: data)
                return
            }
            if let terminal {
                lock.unlock()
                switch terminal {
                case .success: continuation.resume(returning: nil)
                case .failure(let error): continuation.resume(throwing: error)
                }
                return
            }
            precondition(waiter == nil, "BoundedDataStream supports one consumer")
            waiter = continuation
            lock.unlock()
        }
    }

    var bufferedBytesForTesting: Int {
        lock.lock(); defer { lock.unlock() }
        return bufferedBytes
    }

    var isBackpressuredForTesting: Bool {
        lock.lock(); defer { lock.unlock() }
        return taskSuspended
    }
}
