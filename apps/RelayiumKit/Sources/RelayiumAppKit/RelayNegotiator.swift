import Foundation
import RelayiumKit

/// Owns the two relay-RTT maps for one session and turns them into a choice.
///
/// Both peers measure the pool, swap maps over signalling, and run the same
/// symmetric `RelayChoice.pick` — so there is no negotiation round here, only
/// an exchange. `waitForChoice` exists because the maps may not have met yet
/// when the connection needs building.
///
/// Measurement is injected rather than owned: everything in this type is a
/// decision, and decisions are worth testing without a live TURN allocation.
public final class RelayNegotiator: @unchecked Sendable {
    private let signaling: SignalingClient
    private let pool: [RelayEntry]
    private let measure: ([RelayEntry]) async -> [String: Int]

    private let lock = NSLock()
    private var mine: [String: Int] = [:]
    private var theirs: [String: Int] = [:]
    private var peers: Set<String> = []
    // Each waiter is a "fire" closure rather than a raw continuation: see
    // `waitForChoice` for why a plain `withCheckedContinuation` here would
    // deadlock the whole call in the (very common) case nobody ever wakes it.
    private var waiters: [() -> Void] = []

    public init(signaling: SignalingClient,
                pool: [RelayEntry],
                measure: @escaping ([RelayEntry]) async -> [String: Int]) {
        self.signaling = signaling
        self.pool = pool
        self.measure = measure
    }

    /// Begin measuring. Returns immediately; the work runs detached so the
    /// caller can go on waiting for a peer, which is the window this uses.
    public func start() {
        guard !pool.isEmpty else { return }
        Task { [self] in
            record(await measure(pool))
        }
    }

    /// Synchronous on purpose. `NSLock.lock()`/`unlock()` are `noasync`, so
    /// taking the lock inline in `start()`'s async closure was a warning today
    /// and an error under the Swift 6 language mode — and the only such site
    /// left in the package. `current()`, `wake()` and `send()` below are the
    /// same move for the same reason.
    private func record(_ rtt: [String: Int]) {
        lock.lock()
        mine = rtt
        let targets = peers
        lock.unlock()
        for p in targets { send(to: p) }
        wake()
    }

    public func peerJoined(_ peerId: String) {
        lock.lock()
        peers.insert(peerId)
        let haveMine = !mine.isEmpty
        lock.unlock()
        // Only worth sending once there is something to say; `start`'s
        // completion covers the other ordering.
        if haveMine { send(to: peerId) }
    }

    public func handleSignal(from: String, data: JSONValue) {
        guard let map = RelayRttMessage.decode(data) else { return }
        lock.lock()
        theirs = map
        lock.unlock()
        // Deliberately no reply. Broadcasts happen on measure-done and on
        // peer-join; answering here would have two peers echoing maps forever.
        wake()
    }

    /// The chosen relay, waiting up to `deadline` for both maps to arrive.
    /// Nil means "use whatever the caller already had" — an empty pool, a peer
    /// that never answered, no relay in common, or simply not in time.
    ///
    /// Deliberately NOT a `withTaskGroup` racing a continuation-waiting child
    /// against a `Task.sleep` child: cancelling the loser after `group.next()`
    /// does not resume a raw `withCheckedContinuation`, and `withTaskGroup`
    /// implicitly awaits every child at scope exit regardless of cancellation —
    /// so on exactly the path this method exists for ("nobody answers before
    /// the deadline") that shape hangs forever. Verified with a standalone
    /// repro; the runtime itself reports the leaked continuation. Instead, one
    /// continuation is shared by both the wake-up path and the timeout, guarded
    /// so only the first of the two actually resumes it.
    public func waitForChoice(deadline: TimeInterval) async -> RelayEntry? {
        if let e = current() { return e }
        guard !pool.isEmpty else { return nil }
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            let once = ResumeOnce(c)
            lock.lock()
            // Re-check inside the lock: the answer may have arrived between
            // current() above and here.
            if chosenIDLocked() != nil { lock.unlock(); once.fire(); return }
            waiters.append(once.fire)
            lock.unlock()
            Task {
                try? await Task.sleep(nanoseconds: UInt64(max(0, deadline) * 1_000_000_000))
                once.fire()
            }
        }
        return current()
    }

    private func current() -> RelayEntry? {
        lock.lock(); defer { lock.unlock() }
        guard let id = chosenIDLocked() else { return nil }
        return pool.first { $0.id == id }
    }

    private func chosenIDLocked() -> String? {
        RelayChoice.pick(mine: mine, theirs: theirs)
    }

    private func send(to peerId: String) {
        lock.lock(); let m = mine; lock.unlock()
        guard !m.isEmpty else { return }
        signaling.sendSignal(to: peerId, data: RelayRttMessage.encode(m))
    }

    private func wake() {
        lock.lock()
        guard chosenIDLocked() != nil else { lock.unlock(); return }
        let pending = waiters
        waiters = []
        lock.unlock()
        for fire in pending { fire() }
    }
}

/// Resumes a continuation at most once, whichever of "woken by a fresh map"
/// or "deadline elapsed" gets there first. Without this guard the two racing
/// callers in `waitForChoice` could both try to resume the same continuation.
private final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Never>?

    init(_ continuation: CheckedContinuation<Void, Never>) {
        self.continuation = continuation
    }

    func fire() {
        lock.lock()
        guard let c = continuation else { lock.unlock(); return }
        continuation = nil
        lock.unlock()
        c.resume()
    }
}
