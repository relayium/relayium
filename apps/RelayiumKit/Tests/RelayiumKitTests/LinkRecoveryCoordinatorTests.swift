import XCTest
@testable import RelayiumKit

/// One value a coordinator callback writes and a test reads, with a lock of its
/// own.
///
/// Every fake below is reachable from more than one thread the moment a
/// concurrency test exists, and a harness that raced itself would turn a
/// coordinator defect into a crash or a garbage reading instead of a failed
/// assertion. These two boxes are what keep the RED evidence about the
/// coordinator.
private final class Locked<Value> {
    private let lock = NSLock()
    private var stored: Value

    init(_ value: Value) { stored = value }

    var value: Value {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); defer { lock.unlock() }; stored = newValue }
    }
}

/// An append-only record of what a hook was called with, in order.
private final class Recorded<Element> {
    private let lock = NSLock()
    private var items: [Element] = []

    func append(_ item: Element) {
        lock.lock(); defer { lock.unlock() }
        items.append(item)
    }

    var all: [Element] {
        lock.lock(); defer { lock.unlock() }
        return items
    }
}

/// One scheduled wake-up, controlled by the test rather than by a clock.
private final class FakeTimer: LinkRecoveryTimer {
    private let state = Locked(false)
    private let firedState = Locked(false)
    var cancelled: Bool { state.value }
    var fired: Bool {
        get { firedState.value }
        set { firedState.value = newValue }
    }
    func cancel() { state.value = true }
}

/// The coordinator's whole notion of time. Nothing here advances on its own, so
/// a ninety-second window and a 1.5-second retry are ordinary assertions.
private final class FakeScheduler: LinkRecoveryScheduler {
    struct Scheduled {
        let delay: TimeInterval
        let body: () -> Void
        let timer: FakeTimer
    }

    private let record = Recorded<Scheduled>()
    var scheduled: [Scheduled] { record.all }

    /// Every delay ever asked for, including ones later cancelled.
    var delays: [TimeInterval] { scheduled.map(\.delay) }

    /// Delays whose wake-up is still live.
    var liveDelays: [TimeInterval] {
        scheduled.filter { !$0.timer.cancelled && !$0.timer.fired }.map(\.delay)
    }

    func schedule(after delay: TimeInterval, _ body: @escaping () -> Void) -> LinkRecoveryTimer {
        let timer = FakeTimer()
        record.append(Scheduled(delay: delay, body: body, timer: timer))
        return timer
    }

    /// Fire the first live wake-up scheduled for exactly `delay`. Returns false
    /// when there is none — a cancelled timer is not a wake-up.
    @discardableResult
    func fire(_ delay: TimeInterval) -> Bool {
        guard let item = scheduled.first(where: {
            $0.delay == delay && !$0.timer.cancelled && !$0.timer.fired
        }) else { return false }
        item.timer.fired = true
        item.body()
        return true
    }
}

/// A transport that is only ever the CURRENT one: what the initial establishment
/// hands the coordinator, with no callbacks of the coordinator's on it.
private final class FakeCurrentTransport: LinkTransportHandle {
    private let closes = Locked(0)
    var closeCount: Int { closes.value }
    func close() { closes.value += 1 }
}

/// One candidate replacement, with the two-step publication a real driver makes:
/// `onReady` first, then the captured backlog.
private final class FakeReplacementTransport: LinkReplacementTransport {
    /// Guarded slots, exactly as `WebRTCLinkReplacementTransport` guards its
    /// own, and for the same reason: a real driver READS these on its private
    /// queue while the coordinator WRITES them from wherever a link ended. A
    /// fake with plain stored properties would race in that same instant and
    /// hide the coordinator's behaviour behind a harness defect.
    private let readyBox = Locked<((LinkIdentity) -> Void)?>(nil)
    private let frameBox = Locked<((LinkLane, [UInt8]) -> Void)?>(nil)
    private let errorBox = Locked<((Error) -> Void)?>(nil)
    private let closeBox = Locked<(() -> Void)?>(nil)

    var onReady: ((LinkIdentity) -> Void)? {
        get { readyBox.value }
        set { readyBox.value = newValue }
    }
    var onFrame: ((LinkLane, [UInt8]) -> Void)? {
        get { frameBox.value }
        set { frameBox.value = newValue }
    }
    var onError: ((Error) -> Void)? {
        get { errorBox.value }
        set { errorBox.value = newValue }
    }
    var onClose: (() -> Void)? {
        get { closeBox.value }
        set { closeBox.value = newValue }
    }

    /// Every call this transport received, in order. `start`/`receive` must come
    /// after the callbacks are installed, so the record has to be ordered.
    private let record = Recorded<String>()
    var calls: [String] { record.all }
    private let closes = Locked(0)
    var closeCount: Int { closes.value }
    /// Whether all four callbacks were installed before `start`/`receive`.
    private let installedFirst = Locked(true)
    var callbacksInstalledFirst: Bool { installedFirst.value }

    private var hasCallbacks: Bool {
        onReady != nil && onFrame != nil && onError != nil && onClose != nil
    }

    func start() {
        if !hasCallbacks { installedFirst.value = false }
        record.append("start")
    }

    func receive(from: String, signal: JSONValue) {
        if !hasCallbacks { installedFirst.value = false }
        record.append("receive:\(from)")
    }

    func close() {
        closes.value += 1
        record.append("close")
    }

    /// Publish exactly as `LinkEstablishment.publish` does: the identity first,
    /// then the pre-attachment backlog, with nothing in between.
    func becomeReady(_ identity: LinkIdentity, replay: [(LinkLane, [UInt8])] = []) {
        onReady?(identity)
        for (lane, bytes) in replay { onFrame?(lane, bytes) }
    }

    /// A real driver tears down and then reports: `onError` followed by
    /// `onClose`, both at most once.
    func failAndClose(_ error: Error) {
        onError?(error)
        onClose?()
    }
}

final class LinkRecoveryCoordinatorTests: XCTestCase {

    private let sendKey = [UInt8](repeating: 7, count: 32)
    private let recvKey = [UInt8](repeating: 9, count: 32)

    private func identity(peerId: String = "peer-b",
                          role: Role = .initiator,
                          sas: String = "314159",
                          generation: Int = 4,
                          codecs: LinkCodecs? = nil) -> LinkIdentity {
        LinkIdentity(peerId: peerId,
                     role: role,
                     sas: sas,
                     codecs: codecs ?? LinkCodecs(sendKey: sendKey, recvKey: recvKey),
                     authenticationGeneration: generation)
    }

    /// Everything the factory closure needs, in an object it can capture before
    /// the harness itself exists.
    private final class FactoryState {
        let built = Recorded<FakeReplacementTransport>()
        var produced: [FakeReplacementTransport] { built.all }
        var error: Error?
        /// Owner code that re-enters the coordinator from inside the factory,
        /// BEFORE anything is built — so a factory that ends the link and then
        /// fails is one call rather than two.
        var beforeBuild: (() -> Void)?
        /// Owner code that re-enters the coordinator from inside the factory,
        /// with the transport already built.
        var sideEffect: (() -> Void)?
    }

    /// The whole harness for one held link, so every test below states only what
    /// it is actually about.
    private final class Harness {
        let held: LinkIdentity
        let current = FakeCurrentTransport()
        let scheduler = FakeScheduler()
        let admission: LinkAdmission
        let coordinator: LinkRecoveryCoordinator

        private let state: FactoryState
        var produced: [FakeReplacementTransport] { state.produced }
        var factoryError: Error? {
            get { state.error }
            set { state.error = newValue }
        }
        var factorySideEffect: (() -> Void)? {
            get { state.sideEffect }
            set { state.sideEffect = newValue }
        }
        var beforeBuild: (() -> Void)? {
            get { state.beforeBuild }
            set { state.beforeBuild = newValue }
        }
        var attachError: Error?

        private let lostPolicy = Recorded<String>()
        var lostPolicyCalls: [String] { lostPolicy.all }
        var hold = true
        var policyError: Error?
        /// Owner code that re-enters the coordinator from inside a hook.
        var onLostSideEffect: (() -> Void)?
        var onAttachSideEffect: (() -> Void)?
        private let attachedIdentities = Recorded<LinkIdentity>()
        var attached: [LinkIdentity] { attachedIdentities.all }
        private let frameRecord = Recorded<(LinkLane, [UInt8])>()
        var frames: [(LinkLane, [UInt8])] { frameRecord.all }
        /// Frames seen at the instant `onAttach` ran, so "attach before replay"
        /// is an assertion rather than an ordering convention.
        private let attachFrames = Locked<Int?>(nil)
        var framesAtAttach: Int? { attachFrames.value }
        /// The gap as the owner sees it from INSIDE its own attach hook. Until
        /// that hook returns, nothing has been taken over.
        private let attachPhase = Locked<LinkRecoveryPhase?>(nil)
        var phaseAtAttach: LinkRecoveryPhase? { attachPhase.value }
        private let attachJoin = Locked<LinkRecoveryJoin?>(nil)
        var joinAtAttach: LinkRecoveryJoin? { attachJoin.value }
        private let endRecord = Recorded<LinkRecoveryError>()
        var ended: [LinkRecoveryError] { endRecord.all }
        /// Owner code that runs from inside `onEnded` — including an owner
        /// finishing with the coordinator entirely.
        var onEndedSideEffect: (() -> Void)?

        init(identity: LinkIdentity, selfId: String = "peer-a") {
            self.held = identity
            self.admission = LinkAdmission(selfId: { selfId }, supportsLink: { _ in true })
            admission.didBeginEstablishing(peerId: identity.peerId, role: identity.role)
            admission.didOpen(peerId: identity.peerId)
            let state = FactoryState()
            self.state = state
            self.coordinator = LinkRecoveryCoordinator(
                identity: identity,
                current: current,
                factory: { _ in
                    state.beforeBuild?()
                    if let error = state.error { throw error }
                    let transport = FakeReplacementTransport()
                    state.built.append(transport)
                    state.sideEffect?()
                    return transport
                },
                scheduler: scheduler,
                admission: admission)
            coordinator.onTransportLost = { [weak self] identity in
                guard let self else { return false }
                self.lostPolicy.append(identity.peerId)
                self.onLostSideEffect?()
                if let policyError = self.policyError { throw policyError }
                return self.hold
            }
            // `[weak self]` and then `self.coordinator`, deliberately: capturing
            // the local `coordinator` would put a strong reference to it inside a
            // hook the coordinator itself stores, and a harness that retains its
            // own subject cannot observe what a dropped coordinator releases.
            coordinator.onAttach = { [weak self] identity, _ in
                guard let self else { return }
                self.attachPhase.value = self.coordinator.phase
                self.attachJoin.value = self.coordinator.join(peerId: identity.peerId) { _ in }
                self.onAttachSideEffect?()
                if let attachError = self.attachError { throw attachError }
                self.attachFrames.value = self.frames.count
                self.attachedIdentities.append(identity)
            }
            coordinator.onFrame = { [weak self] lane, bytes in
                self?.frameRecord.append((lane, bytes))
            }
            coordinator.onEnded = { [weak self] error in
                guard let self else { return }
                self.endRecord.append(error)
                self.onEndedSideEffect?()
            }
        }

        var candidate: FakeReplacementTransport? { produced.last }

        /// The current transport dying the way a real one does.
        func loseTransport(_ error: Error = LinkTransportError.peerConnectionFailed) {
            coordinator.transportTerminated(current, error: error)
            coordinator.transportTerminated(current, error: nil)
        }
    }

    private func harness(role: Role = .initiator,
                         peerId: String = "peer-b",
                         selfId: String = "peer-a") -> Harness {
        Harness(identity: identity(peerId: peerId, role: role), selfId: selfId)
    }

    // MARK: - one terminal event, one gap

    /// A dying transport reports `failed` and then `closed`. That is one gap,
    /// and the owner's recovery policy is a decision about the gap — not about
    /// each callback the transport happened to make on its way out.
    func testErrorThenCloseIsOneGapAndOnePolicyQuestion() {
        let h = harness()
        h.loseTransport()

        XCTAssertEqual(h.lostPolicyCalls, ["peer-b"])
        XCTAssertEqual(h.coordinator.phase, .interrupted)
        XCTAssertEqual(h.current.closeCount, 1)
        XCTAssertEqual(h.produced.count, 1, "one gap starts one recovery, not two")
    }

    /// The retired transport's callbacks keep arriving after a replacement is
    /// live. A stale transport may fail itself; it must never end a link it no
    /// longer belongs to.
    func testStaleTransportCallbacksCannotTearDownTheReplacement() {
        let h = harness()
        h.loseTransport()
        guard let candidate = h.produced.first else { return XCTFail("no attempt") }
        candidate.becomeReady(h.held)
        XCTAssertEqual(h.coordinator.phase, .open)

        h.coordinator.transportTerminated(h.current, error: LinkTransportError.peerConnectionFailed)
        h.coordinator.transportTerminated(h.current, error: nil)

        XCTAssertEqual(h.coordinator.phase, .open, "a retired transport ended a live link")
        XCTAssertEqual(h.lostPolicyCalls, ["peer-b"], "the policy was asked for a dead transport")
        XCTAssertTrue(h.ended.isEmpty)
    }

    /// A retry attempt that loses its race is superseded, not merely slow. Its
    /// own failure is its business and stops there.
    func testASupersededAttemptFailingCannotEndTheLink() {
        let h = harness()
        h.loseTransport()
        guard let first = h.produced.first else { return XCTFail("no attempt") }
        first.failAndClose(LinkTransportError.peerConnectionFailed)
        XCTAssertTrue(h.scheduler.fire(LINK_RECOVERY_RETRY))
        guard h.produced.count == 2 else { return XCTFail("no retry attempt") }
        h.produced[1].becomeReady(h.held)
        XCTAssertEqual(h.coordinator.phase, .open)

        first.failAndClose(LinkTransportError.peerConnectionFailed)

        XCTAssertEqual(h.coordinator.phase, .open)
        XCTAssertTrue(h.ended.isEmpty)
        XCTAssertEqual(h.attached.count, 1)
    }

    // MARK: - the recorded recovery decision

    /// The owner suspends its lanes and answers once. That answer is what the
    /// coordinator acts on — never lane status read back afterwards, which the
    /// owner has by then already mutated.
    func testRecoveryHoldsOnlyOnTheOwnersRecordedAnswer() {
        let h = harness()
        h.hold = false

        h.loseTransport()

        XCTAssertEqual(h.lostPolicyCalls, ["peer-b"])
        XCTAssertEqual(h.coordinator.phase, .ended)
        XCTAssertTrue(h.produced.isEmpty, "a declined gap allocated a replacement")
        XCTAssertEqual(h.ended.count, 1)
        guard case .declined? = h.ended.first else { return XCTFail("wrong end reason") }
        XCTAssertEqual(h.current.closeCount, 1)
    }

    /// A policy that throws has recorded nothing. Guessing "hold" for it would
    /// keep a link alive on the strength of an exception.
    func testAThrowingPolicyTerminatesRatherThanHolds() {
        struct Boom: Error {}
        let h = harness()
        h.policyError = Boom()

        h.loseTransport()

        XCTAssertEqual(h.coordinator.phase, .ended)
        XCTAssertTrue(h.produced.isEmpty)
        guard case .policyFailed? = h.ended.first else { return XCTFail("wrong end reason") }
    }

    /// The owner's policy hook is arbitrary owner code, and one of the things an
    /// owner may legitimately decide while suspending its lanes is that the
    /// whole session is over — a user pressing disconnect, a peer already known
    /// to have left. Returning "hold" on the way out of that must not resurrect
    /// a link the same call stack has just ended.
    func testAPolicyHookThatStopsTheCoordinatorIsNotOverruled() {
        let h = harness()
        h.onLostSideEffect = { h.coordinator.stop() }

        h.loseTransport()

        XCTAssertEqual(h.coordinator.phase, .ended)
        XCTAssertTrue(h.produced.isEmpty, "an ended link started a rebuild")
        XCTAssertTrue(h.scheduler.liveDelays.isEmpty, "an ended link armed a window")
        XCTAssertEqual(h.ended.count, 1)
        guard case .cancelled? = h.ended.first else { return XCTFail("wrong end reason") }
    }

    /// The same for the attach hook. An owner that ends the session while taking
    /// the rebuilt lanes over has closed the replacement; making it current
    /// afterwards would publish a transport that is already gone.
    func testAnAttachHookThatStopsTheCoordinatorIsNotOverruled() {
        let h = harness()
        h.loseTransport()
        h.onAttachSideEffect = { h.coordinator.stop() }

        h.produced[0].becomeReady(h.held, replay: [(.file, [1])])

        XCTAssertEqual(h.coordinator.phase, .ended)
        XCTAssertTrue(h.frames.isEmpty, "a backlog replayed into an ended link")
        XCTAssertEqual(h.ended.count, 1)
        XCTAssertEqual(h.produced[0].closeCount, 1)
    }

    /// A declined gap is over. Nothing may retry it.
    func testADeclinedGapSchedulesNothing() {
        let held = harness()
        held.loseTransport()
        XCTAssertFalse(held.scheduler.liveDelays.isEmpty, "a held gap must be bounded")

        let h = harness()
        h.hold = false
        h.loseTransport()
        XCTAssertTrue(h.scheduler.liveDelays.isEmpty)
    }

    // MARK: - bounded deterministic recovery

    /// The two bounds, as VALUES.
    ///
    /// Every cadence test below spends the constants symbolically, so it would
    /// stay green if both moved together — and the numbers are not this client's
    /// to choose. They are `web/src/lib/peer-link.svelte.ts`'s
    /// `LINK_RECOVERY_WINDOW_MS` (90_000) and `LINK_RECOVERY_RETRY_MS` (1_500),
    /// and a native peer that gave up while a web peer was still retrying — or
    /// retried at a different rate into the same signalling room — would be a
    /// divergence no unit test on either side would show.
    func testTheRecoveryBoundsMatchTheDeployedWebClient() {
        XCTAssertEqual(LINK_RECOVERY_WINDOW, 90)
        XCTAssertEqual(LINK_RECOVERY_RETRY, 1.5)
        XCTAssertLessThan(LINK_RECOVERY_RETRY, LINK_RECOVERY_WINDOW,
                          "a retry interval at or past the window is one attempt, not a loop")
        XCTAssertGreaterThan(LINK_RECOVERY_RETRY, 0,
                             "a zero interval is a spin, not a retry cadence")
    }

    /// The original initiator drives the rebuild, and does so at once: a gap
    /// spent waiting for a first retry tick is a gap the peer spends alone.
    func testTheInitiatorAttemptsImmediatelyInsideOneWindow() {
        let h = harness(role: .initiator)
        h.loseTransport()

        XCTAssertEqual(h.produced.count, 1)
        XCTAssertEqual(h.scheduler.liveDelays, [LINK_RECOVERY_WINDOW])
    }

    /// The responder answers an authenticated offer and nothing else. An
    /// unsolicited attempt from it is rebuild glare: two PeerConnections racing
    /// into one pair of lanes.
    func testTheResponderStartsNoUnsolicitedAttempt() {
        let h = harness(role: .responder)
        h.loseTransport()

        XCTAssertEqual(h.coordinator.phase, .interrupted)
        XCTAssertTrue(h.produced.isEmpty)
        XCTAssertEqual(h.scheduler.liveDelays, [LINK_RECOVERY_WINDOW],
                       "the window still bounds a responder's gap")
    }

    /// A failed attempt costs one retry interval, not a new window.
    func testAFailedInitiatorAttemptRetriesOnTheRetryInterval() {
        let h = harness()
        h.loseTransport()
        h.produced[0].failAndClose(LinkTransportError.peerConnectionFailed)

        XCTAssertEqual(h.scheduler.liveDelays, [LINK_RECOVERY_WINDOW, LINK_RECOVERY_RETRY])
        XCTAssertEqual(h.produced.count, 1, "the retry ran before its interval elapsed")

        XCTAssertTrue(h.scheduler.fire(LINK_RECOVERY_RETRY))
        XCTAssertEqual(h.produced.count, 2)
        XCTAssertEqual(h.produced[1].calls, ["start"])
        XCTAssertTrue(h.produced[1].callbacksInstalledFirst,
                      "a peer speaking first would reach a handler that does not exist")
    }

    /// A responder's failed attempt does not become an initiator's. It goes back
    /// to waiting for the next authenticated offer.
    func testAFailedResponderAttemptDoesNotRetry() {
        let h = harness(role: .responder, peerId: "peer-b", selfId: "peer-c")
        h.loseTransport()
        h.coordinator.receiveResumeOffer(from: "peer-b", signal: genuineOffer(h.held))
        guard h.produced.count == 1 else { return XCTFail("no attempt from the offer") }

        h.produced[0].failAndClose(LinkTransportError.peerConnectionFailed)

        XCTAssertEqual(h.scheduler.liveDelays, [LINK_RECOVERY_WINDOW])
        XCTAssertEqual(h.coordinator.phase, .interrupted)
    }

    /// A responder whose attempt failed is still waiting, and the peer that is
    /// still trying deserves its next offer. Both the coordinator's allocation
    /// slot and the admission's rebuild slot have to come back, or the rest of
    /// the window is spent ignoring a peer this side could have rebuilt with.
    func testAResponderCanAllocateAgainAfterAFailedAttempt() {
        let h = harness(role: .responder, peerId: "peer-b", selfId: "peer-c")
        h.loseTransport()
        h.coordinator.receiveResumeOffer(from: "peer-b", signal: genuineOffer(h.held))
        h.produced[0].failAndClose(LinkTransportError.peerConnectionFailed)

        XCTAssertEqual(h.admission.route(from: "peer-b", signal: genuineOffer(h.held)),
                       .resumeOffer)
        h.coordinator.receiveResumeOffer(from: "peer-b", signal: genuineOffer(h.held, sdp: "v=0 b"))

        XCTAssertEqual(h.produced.count, 2)
    }

    /// The window is the bound. When it closes the link is gone, whatever is
    /// still in flight.
    func testTheWindowExpiryEndsTheLinkAndClosesTheCandidate() {
        let h = harness()
        h.loseTransport()
        guard let candidate = h.produced.first else { return XCTFail("no attempt") }

        XCTAssertTrue(h.scheduler.fire(LINK_RECOVERY_WINDOW))

        XCTAssertEqual(h.coordinator.phase, .ended)
        XCTAssertEqual(candidate.closeCount, 1)
        guard case .windowExpired? = h.ended.first else { return XCTFail("wrong end reason") }
        XCTAssertEqual(h.admission.phase, .failed)
        XCTAssertTrue(h.scheduler.liveDelays.isEmpty)
    }

    /// An expired window cannot be revived. A candidate whose completion was
    /// already in flight publishes nothing, and no timer creates another.
    func testAnExpiredWindowCannotBeRevivedByACallbackOrATimer() {
        let h = harness()
        h.loseTransport()
        guard let candidate = h.produced.first else { return XCTFail("no attempt") }
        XCTAssertTrue(h.scheduler.fire(LINK_RECOVERY_WINDOW))

        candidate.becomeReady(h.held, replay: [(.text, [1, 2, 3])])
        h.coordinator.receiveResumeOffer(from: "peer-b", signal: genuineOffer(h.held))

        XCTAssertTrue(h.attached.isEmpty)
        XCTAssertTrue(h.frames.isEmpty)
        XCTAssertEqual(h.produced.count, 1)
        XCTAssertEqual(h.ended.count, 1, "the held recovery finished more than once")
        XCTAssertEqual(h.coordinator.phase, .ended)
    }

    // MARK: - mid-gap intent

    /// Intent raised mid-gap joins the one outcome. Attaching to the dead
    /// transport the link still points at, or opening a second connection, are
    /// the two failures this exists to prevent.
    func testSamePeerIntentJoinsTheOneRecoveryOutcome() {
        let h = harness()
        h.loseTransport()
        var outcomes: [Result<LinkIdentity, Error>] = []
        XCTAssertEqual(h.coordinator.join(peerId: "peer-b") { outcomes.append($0) }, .joined)
        XCTAssertEqual(h.coordinator.join(peerId: "peer-b") { outcomes.append($0) }, .joined)
        XCTAssertTrue(outcomes.isEmpty)

        h.produced[0].becomeReady(h.held)

        XCTAssertEqual(outcomes.count, 2)
        for outcome in outcomes {
            guard case let .success(identity) = outcome else { return XCTFail("waiter failed") }
            XCTAssertTrue(identity.codecs === h.held.codecs)
        }
        XCTAssertEqual(h.produced.count, 1, "a joining intent opened a second connection")
    }

    /// Another peer is refused for the whole gap, exactly as it would be while
    /// the link was open. A held link is still a held link.
    func testOtherPeerIntentStaysBusyThroughTheGap() {
        let h = harness()
        h.loseTransport()
        XCTAssertEqual(h.coordinator.join(peerId: "peer-z") { _ in }, .busy)
    }

    /// Every waiter finishes exactly once, whatever ends the gap.
    func testWaitersFinishExactlyOnce() {
        let h = harness()
        h.loseTransport()
        var outcomes: [Result<LinkIdentity, Error>] = []
        XCTAssertEqual(h.coordinator.join(peerId: "peer-b") { outcomes.append($0) }, .joined)

        XCTAssertTrue(h.scheduler.fire(LINK_RECOVERY_WINDOW))
        h.coordinator.stop()
        h.produced[0].becomeReady(h.held)

        XCTAssertEqual(outcomes.count, 1)
        guard case .failure = outcomes[0] else { return XCTFail("waiter succeeded after expiry") }
    }

    /// A waiter is entitled to act on its own outcome — a lane that gives up, a
    /// user cancelling the moment the link comes back. Re-entering the
    /// coordinator from a completion must not find that completion still
    /// pending and run it a second time with the opposite result.
    func testAWaiterThatReentersIsStillFinishedOnlyOnce() {
        let h = harness()
        h.loseTransport()
        var outcomes: [Result<LinkIdentity, Error>] = []
        XCTAssertEqual(h.coordinator.join(peerId: "peer-b") { outcome in
            outcomes.append(outcome)
            h.coordinator.stop()
        }, .joined)

        h.produced[0].becomeReady(h.held)

        XCTAssertEqual(outcomes.count, 1)
        guard case .success = outcomes[0] else { return XCTFail("the waiter lost its outcome") }
        XCTAssertEqual(h.coordinator.phase, .ended)
    }

    /// A settled recovery has nothing left to join.
    func testJoiningIsUnavailableOutsideAGap() {
        let h = harness()
        XCTAssertEqual(h.coordinator.join(peerId: "peer-b") { _ in }, .unavailable)
        h.loseTransport()
        h.produced[0].becomeReady(h.held)
        XCTAssertEqual(h.coordinator.join(peerId: "peer-b") { _ in }, .unavailable)
    }

    // MARK: - authenticate before allocation

    /// The genuine article: this link's peer, its inherited responder role, the
    /// exact `resume` offer shape, and a tag under this link's own key.
    private func genuineOffer(_ identity: LinkIdentity,
                              sdp: String = "v=0 rebuild") -> JSONValue {
        resumeSDPSignal(kind: "offer", sdp: sdp, key: identity.codecs.resumeAuthKey)
    }

    private func responderHarness() -> Harness {
        // "peer-c" > "peer-b", so `linkRole` makes this side the responder, and
        // the identity carries that role through the gap.
        let h = harness(role: .responder, peerId: "peer-b", selfId: "peer-c")
        h.loseTransport()
        return h
    }

    /// Nothing that fails to verify may allocate a PeerConnection — and nothing
    /// that fails to verify may consume the one allocation slot either, or a
    /// flood of forgeries would deny the genuine peer its rebuild.
    func testOnlyAVerifiedOfferAllocatesAReplacement() {
        let h = responderHarness()
        let key = h.held.codecs.resumeAuthKey
        let foreignKey = [UInt8](repeating: 0xAB, count: 32)

        var untagged = resumeSDPSignal(kind: "offer", sdp: "v=0 x", key: key)
        if case var .object(fields) = untagged {
            fields.removeValue(forKey: "auth")
            untagged = .object(fields)
        }
        var malformed = genuineOffer(h.held)
        if case var .object(fields) = malformed {
            fields["auth"] = .string("not-a-tag")
            malformed = .object(fields)
        }
        var rewritten = genuineOffer(h.held)
        if case var .object(fields) = rewritten {
            fields["sdp"] = .object(["type": .string("offer"), "sdp": .string("v=0 rewritten")])
            rewritten = .object(fields)
        }
        let answer = resumeSDPSignal(kind: "answer", sdp: "v=0 x", key: key)
        let candidateOnly = resumeICESignal("candidate:1", sdpMid: "0", sdpMLineIndex: 0, key: key)
        // The right key over the right bytes, on the WRONG generation: a genuine
        // tag does not make an establishment signal a rebuild offer.
        var linkGeneration = sdpSignal(kind: "offer", sdp: "v=0 x", commit: nil, generation: .link)
        if case var .object(fields) = linkGeneration {
            fields["auth"] = .string(signResume(key: key, payload: authPayload(linkGeneration)))
            linkGeneration = .object(fields)
        }

        // From somebody else entirely.
        h.coordinator.receiveResumeOffer(from: "peer-x", signal: genuineOffer(h.held))
        // Signed with a key this link never derived.
        h.coordinator.receiveResumeOffer(from: "peer-b",
                                         signal: resumeSDPSignal(kind: "offer",
                                                                 sdp: "v=0 x",
                                                                 key: foreignKey))
        h.coordinator.receiveResumeOffer(from: "peer-b", signal: untagged)
        h.coordinator.receiveResumeOffer(from: "peer-b", signal: malformed)
        h.coordinator.receiveResumeOffer(from: "peer-b", signal: rewritten)
        h.coordinator.receiveResumeOffer(from: "peer-b", signal: answer)
        h.coordinator.receiveResumeOffer(from: "peer-b", signal: candidateOnly)
        h.coordinator.receiveResumeOffer(from: "peer-b", signal: linkGeneration)
        h.coordinator.receiveResumeOffer(from: "peer-b", signal: .string("nonsense"))

        XCTAssertTrue(h.produced.isEmpty, "an unverified signal allocated a replacement")
        XCTAssertEqual(h.coordinator.phase, .interrupted, "an unverified signal ended the link")

        h.coordinator.receiveResumeOffer(from: "peer-b", signal: genuineOffer(h.held))

        XCTAssertEqual(h.produced.count, 1, "the genuine offer did not allocate")
    }

    /// The original initiator drives its own rebuild. Consuming an inbound offer
    /// there would put two PeerConnections into the same lanes.
    func testAnOfferAtTheOriginalInitiatorAllocatesNothing() {
        let h = harness(role: .initiator)
        h.loseTransport()
        let before = h.produced.count

        h.coordinator.receiveResumeOffer(from: "peer-b", signal: genuineOffer(h.held))

        XCTAssertEqual(h.produced.count, before)
    }

    /// One allocation in flight. Two offers in one burst must not both start a
    /// PeerConnection into the same pair of lanes.
    func testADuplicateOfferAllocatesNothingMore() {
        let h = responderHarness()
        h.coordinator.receiveResumeOffer(from: "peer-b", signal: genuineOffer(h.held))
        XCTAssertEqual(h.produced.count, 1)

        h.coordinator.receiveResumeOffer(from: "peer-b", signal: genuineOffer(h.held))
        h.coordinator.receiveResumeOffer(from: "peer-b", signal: genuineOffer(h.held, sdp: "v=0 b"))

        XCTAssertEqual(h.produced.count, 1)
    }

    /// An offer that arrives when this link is not interrupted has nothing to
    /// rebuild — including after the link is already back, and after it ended.
    func testAnOfferOutsideTheGapAllocatesNothing() {
        let open = harness(role: .responder, peerId: "peer-b", selfId: "peer-c")
        open.coordinator.receiveResumeOffer(from: "peer-b", signal: genuineOffer(open.held))
        XCTAssertTrue(open.produced.isEmpty)

        let ended = responderHarness()
        ended.coordinator.stop()
        ended.coordinator.receiveResumeOffer(from: "peer-b", signal: genuineOffer(ended.held))
        XCTAssertTrue(ended.produced.isEmpty)
    }

    /// The offer that created the rebuild is handed to the driver, and only
    /// after the coordinator's callbacks are on it.
    func testAVerifiedOfferIsHandedToTheDriverAfterCallbacksAreInstalled() {
        let h = responderHarness()
        h.coordinator.receiveResumeOffer(from: "peer-b", signal: genuineOffer(h.held))

        guard let candidate = h.produced.first else { return XCTFail("no attempt") }
        XCTAssertTrue(candidate.callbacksInstalledFirst)
        XCTAssertEqual(candidate.calls, ["receive:peer-b", "start"])
    }

    // MARK: - identity continuity

    /// One authentication for the whole gap: the same peer, role, SAS,
    /// authentication generation and — the one that is catastrophic to get wrong
    /// — the same `LinkCodecs` object.
    func testTheRebuiltLinkKeepsTheExactIdentityAndCodecs() {
        let h = harness()
        h.loseTransport()
        h.produced[0].becomeReady(h.held)

        guard let attached = h.attached.first else { return XCTFail("nothing attached") }
        XCTAssertEqual(attached.peerId, h.held.peerId)
        XCTAssertEqual(attached.role, h.held.role)
        XCTAssertEqual(attached.sas, h.held.sas)
        XCTAssertEqual(attached.authenticationGeneration, h.held.authenticationGeneration)
        XCTAssertTrue(attached.codecs === h.held.codecs)
    }

    /// A second `LinkCodecs` is two AEAD sequences counting from zero under one
    /// pair of session keys. A factory that produces one is not a rebuild, and
    /// there is nothing safe to do but fail the link closed.
    func testAReadyIdentityWithDifferentCodecsFailsTheLinkClosed() {
        let h = harness()
        h.loseTransport()
        let imposter = LinkIdentity(peerId: h.held.peerId,
                                    role: h.held.role,
                                    sas: h.held.sas,
                                    codecs: LinkCodecs(sendKey: sendKey, recvKey: recvKey),
                                    authenticationGeneration: h.held.authenticationGeneration)

        h.produced[0].becomeReady(imposter, replay: [(.file, [1])])

        XCTAssertTrue(h.attached.isEmpty)
        XCTAssertTrue(h.frames.isEmpty)
        XCTAssertEqual(h.coordinator.phase, .ended)
        guard case .identityMismatch? = h.ended.first else { return XCTFail("wrong end reason") }
        XCTAssertEqual(h.produced[0].closeCount, 1)
    }

    /// Every other field of the identity is checked too, and each one on its
    /// own: a rebuild that quietly changed role, SAS, peer or authentication
    /// generation would be a different authentication wearing this one's codecs.
    func testEveryIdentityFieldMustSurviveTheRebuild() {
        let held = identity()
        let variants: [LinkIdentity] = [
            LinkIdentity(peerId: "peer-other", role: held.role, sas: held.sas,
                         codecs: held.codecs,
                         authenticationGeneration: held.authenticationGeneration),
            LinkIdentity(peerId: held.peerId, role: .responder, sas: held.sas,
                         codecs: held.codecs,
                         authenticationGeneration: held.authenticationGeneration),
            LinkIdentity(peerId: held.peerId, role: held.role, sas: "000000",
                         codecs: held.codecs,
                         authenticationGeneration: held.authenticationGeneration),
            LinkIdentity(peerId: held.peerId, role: held.role, sas: held.sas,
                         codecs: held.codecs,
                         authenticationGeneration: held.authenticationGeneration + 1),
        ]
        for variant in variants {
            let h = Harness(identity: held)
            h.loseTransport()
            h.produced[0].becomeReady(variant)
            XCTAssertTrue(h.attached.isEmpty)
            XCTAssertEqual(h.coordinator.phase, .ended)
        }
    }

    // MARK: - atomic publish and replay ordering

    /// The owner takes the lanes over inside `onReady`, before a single captured
    /// frame is replayed. Those frames belong to receiver codecs that already
    /// exist; one delivered to nothing is a lane that can never be used again.
    func testTheOwnerAttachesBeforeAnyCapturedFrameReplays() {
        let h = harness()
        h.loseTransport()

        h.produced[0].becomeReady(h.held, replay: [(.file, [1, 2]), (.text, [3])])

        XCTAssertEqual(h.framesAtAttach, 0, "frames replayed before the owner attached")
        XCTAssertEqual(h.frames.count, 2)
        XCTAssertEqual(h.frames[0].0, .file)
        XCTAssertEqual(h.frames[1].0, .text)
    }

    /// The gap is still a gap while the owner is inside its own attach hook.
    ///
    /// Making the replacement current first would mean an owner that re-enters —
    /// a lane resolving a queued intent, a UI observer reading status — sees an
    /// open link whose lanes nobody has taken over yet, and a mid-gap intent
    /// arriving in that instant would be told there is nothing to join and go
    /// open a second connection. Only a successful attach ends the gap.
    func testTheGapIsStillHeldWhileTheOwnerIsAttaching() {
        let h = harness()
        h.loseTransport()

        h.produced[0].becomeReady(h.held)

        XCTAssertEqual(h.phaseAtAttach, .interrupted)
        XCTAssertEqual(h.joinAtAttach, .joined)
        XCTAssertEqual(h.coordinator.phase, .open)
    }

    /// Only a successful attach makes a replacement current. An owner that
    /// cannot take the lanes has left them owned by nobody, and publishing over
    /// that is worse than ending.
    func testAFailingAttachFailsClosed() {
        struct Boom: Error {}
        let h = harness()
        h.loseTransport()
        h.attachError = Boom()

        h.produced[0].becomeReady(h.held, replay: [(.file, [1])])

        XCTAssertEqual(h.coordinator.phase, .ended)
        XCTAssertTrue(h.frames.isEmpty, "the backlog replayed into a link that failed to attach")
        guard case .attachFailed? = h.ended.first else { return XCTFail("wrong end reason") }
        XCTAssertEqual(h.produced[0].closeCount, 1)
    }

    // MARK: - the integration hooks a publication cannot substitute for

    /// A rebuild with no attach hook has nobody to hand the lanes to.
    ///
    /// `try _onAttach?(…)` on a nil hook succeeds, and "succeeded" is what
    /// makes a replacement current — so an owner that never wired one would get
    /// a live transport whose every frame reaches nothing. That is the exact
    /// failure the barrier exists to prevent, and it is worse than ending: the
    /// receiver codecs whose sequence those frames continue cannot survive the
    /// hole.
    func testAReadyReplacementWithNoAttachHookFailsClosed() {
        let h = harness()
        h.loseTransport()
        guard let candidate = h.produced.first else { return XCTFail("no attempt") }
        h.coordinator.onAttach = nil
        var outcomes: [Result<LinkIdentity, Error>] = []
        XCTAssertEqual(h.coordinator.join(peerId: "peer-b") { outcomes.append($0) }, .joined)

        candidate.becomeReady(h.held, replay: [(.file, [1, 2])])

        XCTAssertEqual(h.coordinator.phase, .ended, "a rebuild published with nobody attached")
        XCTAssertTrue(h.frames.isEmpty, "a backlog replayed with nobody attached")
        XCTAssertEqual(candidate.closeCount, 1, "an unattachable rebuild was left running")
        XCTAssertNil(candidate.onFrame, "an unattachable rebuild kept a handler")
        XCTAssertNil(candidate.onReady)
        XCTAssertEqual(h.admission.phase, .failed)
        XCTAssertTrue(h.scheduler.liveDelays.isEmpty)
        XCTAssertEqual(outcomes.count, 1)
        guard case .failure = outcomes[0] else {
            return XCTFail("a waiter succeeded onto lanes nobody owns")
        }
        guard case let .attachFailed(reason)? = h.ended.first else {
            return XCTFail("wrong end reason")
        }
        XCTAssertEqual(reason as? LinkRecoveryIntegrationError, .missingAttachHandler)
    }

    /// An attach hook that returns without a frame handler in place is the same
    /// failure one step later.
    ///
    /// The driver replays its captured backlog the instant publication returns,
    /// so a frame handler installed "later" is a backlog already discarded. The
    /// check therefore runs after the hook — which is entitled to install one —
    /// and before the replacement is made current.
    func testAReadyReplacementWithNoFrameHandlerFailsClosedBeforeAnyReplay() {
        let h = harness()
        h.loseTransport()
        guard let candidate = h.produced.first else { return XCTFail("no attempt") }
        h.coordinator.onFrame = nil

        candidate.becomeReady(h.held, replay: [(.file, [1, 2]), (.text, [3])])

        XCTAssertEqual(h.attached.count, 1, "the owner was never given its chance to attach")
        XCTAssertEqual(h.coordinator.phase, .ended, "a rebuild published with no frame handler")
        XCTAssertEqual(candidate.closeCount, 1)
        XCTAssertNil(candidate.onFrame)
        XCTAssertEqual(h.admission.phase, .failed)
        XCTAssertTrue(h.scheduler.liveDelays.isEmpty)
        guard case let .attachFailed(reason)? = h.ended.first else {
            return XCTFail("wrong end reason")
        }
        XCTAssertEqual(reason as? LinkRecoveryIntegrationError, .missingFrameHandler)
    }

    /// The two missing hooks are distinguishable, because an owner acting on
    /// them is fixing two different wirings.
    func testTheTwoMissingIntegrationHooksAreDistinguishable() {
        XCTAssertNotEqual(LinkRecoveryIntegrationError.missingAttachHandler,
                          LinkRecoveryIntegrationError.missingFrameHandler)
        XCTAssertEqual(LinkRecoveryIntegrationError.missingFrameHandler,
                       LinkRecoveryIntegrationError.missingFrameHandler)
    }

    /// Installing the frame forwarding IS part of taking the lanes over, so an
    /// owner doing it from inside `onAttach` is the ordinary integration rather
    /// than an abuse. The requirement is that a handler exists when the driver
    /// replays — not that it existed before the hook ran.
    func testAnAttachHookMayInstallTheFrameHandlerReentrantly() {
        let h = harness()
        h.loseTransport()
        guard let candidate = h.produced.first else { return XCTFail("no attempt") }
        let late = Recorded<(LinkLane, [UInt8])>()
        h.coordinator.onFrame = nil
        h.onAttachSideEffect = {
            h.coordinator.onFrame = { lane, bytes in late.append((lane, bytes)) }
        }

        candidate.becomeReady(h.held, replay: [(.file, [1, 2]), (.text, [3])])

        XCTAssertEqual(h.coordinator.phase, .open, "a re-entrant install was not enough to publish")
        XCTAssertEqual(h.attached.count, 1)
        XCTAssertTrue(h.ended.isEmpty)
        XCTAssertEqual(late.all.count, 2, "the backlog was lost after a re-entrant install")
        XCTAssertEqual(late.all[0].0, .file)
        XCTAssertEqual(late.all[1].0, .text)
        XCTAssertEqual(late.all[1].1, [3])
    }

    /// Publication retires the old transport, in that order: the replacement is
    /// current before the loser is closed, so the close cannot publish over it.
    func testThePublishedReplacementBecomesCurrentAndAdmissionFollows() {
        let h = harness()
        h.loseTransport()
        XCTAssertEqual(h.admission.phase, .interrupted(peerId: "peer-b"))

        h.produced[0].becomeReady(h.held)

        XCTAssertEqual(h.coordinator.phase, .open)
        XCTAssertEqual(h.admission.phase, .open(peerId: "peer-b"))
        XCTAssertTrue(h.scheduler.liveDelays.isEmpty, "the window outlived the gap")
    }

    /// A rebuilt transport that later dies is a new gap, on the same held
    /// authentication — not a link that has run out of recoveries.
    func testAPublishedReplacementDyingOpensANewGap() {
        let h = harness()
        h.loseTransport()
        h.produced[0].becomeReady(h.held)

        h.produced[0].failAndClose(LinkTransportError.peerConnectionFailed)

        XCTAssertEqual(h.coordinator.phase, .interrupted)
        XCTAssertEqual(h.lostPolicyCalls, ["peer-b", "peer-b"])
        XCTAssertEqual(h.produced.count, 2)
    }

    // MARK: - failure semantics

    /// Capture overflow is the one failure the reused receiver codecs cannot
    /// survive: an admitted frame was dropped, so the sequence has a hole in it.
    /// Retrying a transport onto that is not recovery.
    func testCaptureOverflowFailsTheWholeHeldLink() {
        let h = harness()
        h.loseTransport()

        h.produced[0].failAndClose(LinkTransportError.captureOverflow)

        XCTAssertEqual(h.coordinator.phase, .ended)
        XCTAssertEqual(h.produced.count, 1, "an unrecoverable failure was retried")
        guard case .unrecoverable? = h.ended.first else { return XCTFail("wrong end reason") }
        XCTAssertTrue(h.scheduler.liveDelays.isEmpty)
    }

    /// An ordinary attempt failure is not a link failure. It costs a retry.
    func testAnOrdinaryAttemptFailureStaysInsideTheWindow() {
        let h = harness()
        h.loseTransport()

        h.produced[0].failAndClose(LinkTransportError.peerConnectionFailed)

        XCTAssertEqual(h.coordinator.phase, .interrupted)
        XCTAssertTrue(h.ended.isEmpty)
    }

    /// A retired attempt is released as it ends, not merely forgotten. The
    /// `onError`-then-`onClose` pair a driver emits is one ended attempt, and
    /// nothing this object installed may outlive the attempt it belonged to.
    func testARetiredAttemptIsReleasedAsItEnds() {
        let h = harness()
        h.loseTransport()
        guard let candidate = h.produced.first else { return XCTFail("no attempt") }

        candidate.failAndClose(LinkTransportError.peerConnectionFailed)

        XCTAssertNil(candidate.onReady)
        XCTAssertNil(candidate.onFrame)
        XCTAssertNil(candidate.onError)
        XCTAssertNil(candidate.onClose)
        XCTAssertEqual(candidate.closeCount, 1)
    }

    /// The factory is owner code too, and the last of the three places owner
    /// code can end this link from inside a call it is making. A transport built
    /// for a gap that closed underneath it is released rather than started.
    func testAFactoryThatStopsTheCoordinatorLeavesNothingRunning() {
        let h = harness()
        // Ends the link with the transport already built: the instant the gap
        // stops being a gap is between "constructed" and "wired".
        h.factorySideEffect = { [weak h] in h?.coordinator.stop() }

        h.loseTransport()

        XCTAssertEqual(h.coordinator.phase, .ended)
        XCTAssertEqual(h.produced.count, 1)
        XCTAssertEqual(h.produced[0].calls, ["close"], "an ended link started a transport")
        XCTAssertNil(h.produced[0].onReady, "an ended link kept a handler on a transport")
    }

    /// A factory that cannot build a transport at all is an ordinary attempt
    /// failure — the next interval may find a working one.
    func testAThrowingFactoryIsAnOrdinaryAttemptFailure() {
        struct Boom: Error {}
        let h = harness()
        h.factoryError = Boom()
        h.loseTransport()

        XCTAssertEqual(h.coordinator.phase, .interrupted)
        XCTAssertEqual(h.scheduler.liveDelays, [LINK_RECOVERY_WINDOW, LINK_RECOVERY_RETRY])

        h.factoryError = nil
        XCTAssertTrue(h.scheduler.fire(LINK_RECOVERY_RETRY))
        XCTAssertEqual(h.produced.count, 1)
    }

    // MARK: - cancellation and teardown

    /// An explicit stop ends everything at once: no timer, no candidate, no
    /// waiter and no callback left pointing at this coordinator.
    func testStopCancelsEverythingAndReleasesTheCandidate() {
        let h = harness()
        h.loseTransport()
        guard let candidate = h.produced.first else { return XCTFail("no attempt") }
        var outcomes = 0
        XCTAssertEqual(h.coordinator.join(peerId: "peer-b") { _ in outcomes += 1 }, .joined)

        h.coordinator.stop()

        XCTAssertEqual(h.coordinator.phase, .ended)
        XCTAssertEqual(candidate.closeCount, 1)
        XCTAssertEqual(outcomes, 1)
        XCTAssertTrue(h.scheduler.liveDelays.isEmpty)
        XCTAssertNil(candidate.onReady)
        XCTAssertNil(candidate.onFrame)
        XCTAssertNil(candidate.onError)
        XCTAssertNil(candidate.onClose)
        guard case .cancelled? = h.ended.first else { return XCTFail("wrong end reason") }
    }

    /// Stop after publication releases the live replacement too — the
    /// coordinator installed those callbacks and must not leave them behind.
    func testStopDetachesAPublishedReplacement() {
        let h = harness()
        h.loseTransport()
        guard let candidate = h.produced.first else { return XCTFail("no attempt") }
        candidate.becomeReady(h.held)

        h.coordinator.stop()

        XCTAssertNil(candidate.onFrame)
        XCTAssertNil(candidate.onError)
        XCTAssertEqual(candidate.closeCount, 1)
        XCTAssertEqual(h.coordinator.phase, .ended)
    }

    /// The peer left on purpose. Rebuilding toward a browser that has gone burns
    /// real ICE and TURN allocations for the whole window.
    func testPeerDepartureEndsTheGapAndAnotherPeersDoesNot() {
        let stranger = harness()
        stranger.loseTransport()
        stranger.coordinator.peerDeparted("peer-z")
        XCTAssertEqual(stranger.coordinator.phase, .interrupted)
        XCTAssertTrue(stranger.ended.isEmpty)

        let h = harness()
        h.loseTransport()
        h.coordinator.peerDeparted("peer-b")
        XCTAssertEqual(h.coordinator.phase, .ended)
        guard case .peerDeparted? = h.ended.first else { return XCTFail("wrong end reason") }
    }

    /// Ending is idempotent, and every path through it reports once.
    func testEndingTwiceReportsOnce() {
        let h = harness()
        h.loseTransport()
        h.coordinator.stop()
        h.coordinator.stop()
        h.coordinator.peerDeparted("peer-b")
        XCTAssertTrue(h.scheduler.fire(LINK_RECOVERY_WINDOW) == false)
        XCTAssertEqual(h.ended.count, 1)
    }

    /// After the coordinator has ended, nothing a late callback does may
    /// resurrect it — no publish, no frame, no further attempt.
    ///
    /// The callbacks are captured BEFORE the teardown, which is the case that
    /// actually happens: a driver fires on its own queue and may already have
    /// dispatched a completion when the coordinator releases it. Reading them
    /// off the transport afterwards would find nil and prove nothing.
    func testNoCallbackAfterTeardownPublishesDeliversOrRetries() {
        let h = harness()
        h.loseTransport()
        guard let candidate = h.produced.first else { return XCTFail("no attempt") }
        guard let ready = candidate.onReady,
              let frame = candidate.onFrame,
              let error = candidate.onError,
              let closed = candidate.onClose else { return XCTFail("attempt was never wired") }
        h.coordinator.stop()

        ready(h.held)
        frame(.file, [1])
        error(LinkTransportError.peerConnectionFailed)
        closed()
        h.coordinator.transportTerminated(h.current, error: nil)

        XCTAssertTrue(h.attached.isEmpty)
        XCTAssertTrue(h.frames.isEmpty)
        XCTAssertEqual(h.produced.count, 1)
        XCTAssertEqual(h.coordinator.phase, .ended)
        XCTAssertEqual(h.ended.count, 1)
    }

    /// A candidate that lost its race can still complete: its `onReady` may
    /// already have been dispatched when a newer attempt won. Publishing it
    /// would put a second transport on lanes the owner has just taken over.
    func testASupersededCandidatesLateReadyPublishesNothing() {
        let h = harness()
        h.loseTransport()
        guard let first = h.produced.first, let lateReady = first.onReady else {
            return XCTFail("no attempt")
        }
        first.failAndClose(LinkTransportError.peerConnectionFailed)
        XCTAssertTrue(h.scheduler.fire(LINK_RECOVERY_RETRY))
        guard h.produced.count == 2 else { return XCTFail("no retry attempt") }

        lateReady(h.held)

        XCTAssertTrue(h.attached.isEmpty, "a superseded attempt published")
        XCTAssertEqual(h.coordinator.phase, .interrupted)

        h.produced[1].becomeReady(h.held)
        XCTAssertEqual(h.attached.count, 1)
    }

    /// The same race after the gap is over: the winner is current, and the loser
    /// completing must not publish over it.
    func testALateReadyCannotPublishOverTheCurrentReplacement() {
        let h = harness()
        h.loseTransport()
        guard let first = h.produced.first, let lateReady = first.onReady else {
            return XCTFail("no attempt")
        }
        first.failAndClose(LinkTransportError.peerConnectionFailed)
        XCTAssertTrue(h.scheduler.fire(LINK_RECOVERY_RETRY))
        h.produced[1].becomeReady(h.held)

        lateReady(h.held)

        XCTAssertEqual(h.attached.count, 1)
        XCTAssertEqual(h.coordinator.phase, .open)
    }

    // MARK: - synchronization is the coordinator's own

    /// How many times each concurrency test replays its race.
    ///
    /// One round proves nothing about a race: the losing interleaving is the
    /// common one, and a single unsynchronized run passes most of the time. The
    /// count is what turns "this can be wrong" into a test that actually says so
    /// — the unsynchronized coordinator fails these within the first few rounds.
    private var stressRounds: Int { 100 }

    /// Run `body` on `count` threads released as close to together as the
    /// platform allows.
    ///
    /// Every thread is parked on the gate BEFORE any of them is let go, so the
    /// overlap is real rather than a hope about scheduling — a `concurrentPerform`
    /// whose first iteration finishes before the second starts would exercise
    /// nothing.
    private func inParallel(_ count: Int, _ body: @escaping (Int) -> Void) {
        let queue = DispatchQueue(label: "link-recovery-stress", attributes: .concurrent)
        let parked = DispatchSemaphore(value: 0)
        let gate = DispatchSemaphore(value: 0)
        let finished = DispatchGroup()
        for index in 0..<count {
            finished.enter()
            queue.async {
                parked.signal()
                gate.wait()
                body(index)
                finished.leave()
            }
        }
        for _ in 0..<count { parked.wait() }
        for _ in 0..<count { gate.signal() }
        finished.wait()
    }

    /// A transport dies once, however many threads report it.
    ///
    /// A real one reports from its own private queue while the owner's session
    /// side is calling in from another, so "one terminal event, one gap" cannot
    /// rest on those arriving in some order. Two gaps would ask the owner to
    /// suspend its lanes twice, allocate two PeerConnections into one pair of
    /// lanes, and arm two windows over one authentication.
    func testConcurrentTerminalCallbacksAreOneGapAndOnePolicyQuestion() {
        for round in 0..<stressRounds {
            let h = harness()

            inParallel(8) { _ in
                h.coordinator.transportTerminated(h.current,
                                                  error: LinkTransportError.peerConnectionFailed)
            }

            XCTAssertEqual(h.lostPolicyCalls, ["peer-b"],
                           "round \(round): the recovery policy was asked more than once")
            XCTAssertEqual(h.produced.count, 1,
                           "round \(round): one gap allocated more than one rebuild")
            XCTAssertEqual(h.scheduler.delays, [LINK_RECOVERY_WINDOW],
                           "round \(round): one gap armed more than one window")
            XCTAssertEqual(h.current.closeCount, 1, "round \(round): the dying transport was closed twice")
            XCTAssertEqual(h.coordinator.phase, .interrupted, "round \(round)")
        }
    }

    /// A burst of GENUINE offers is one rebuild.
    ///
    /// A peer retransmitting its resume offer while ICE is still gathering is
    /// ordinary, and every one of those verifies. The allocation slot is what
    /// makes them one attempt; a slot read on one thread and taken on another is
    /// not a slot.
    func testConcurrentValidResumeOffersAllocateExactlyOneReplacement() {
        for round in 0..<stressRounds {
            let h = responderHarness()
            // Signed up front: the race under test is the slot, not the HMAC.
            let offers = (0..<8).map { genuineOffer(h.held, sdp: "v=0 burst-\($0)") }

            inParallel(offers.count) { index in
                h.coordinator.receiveResumeOffer(from: "peer-b", signal: offers[index])
            }

            XCTAssertEqual(h.produced.count, 1,
                           "round \(round): a burst of genuine offers allocated more than one rebuild")
            XCTAssertEqual(h.coordinator.phase, .interrupted, "round \(round)")
        }
    }

    /// A publication and an explicit stop arriving together settle one way.
    ///
    /// The waiter re-enters with a second `stop()` from inside its own
    /// completion, which is the case a lock has to survive rather than merely
    /// exclude: an owner acting on its outcome is not a misuse.
    func testAConcurrentStopAndPublicationSettleOnOneOutcome() {
        for round in 0..<stressRounds {
            let h = harness()
            h.loseTransport()
            guard let candidate = h.produced.first else { return XCTFail("round \(round): no attempt") }
            let outcomes = Recorded<Bool>()
            XCTAssertEqual(h.coordinator.join(peerId: "peer-b") { outcome in
                if case .success = outcome { outcomes.append(true) } else { outcomes.append(false) }
                h.coordinator.stop()
            }, .joined)

            inParallel(2) { index in
                if index == 0 { candidate.becomeReady(h.held) } else { h.coordinator.stop() }
            }

            XCTAssertEqual(outcomes.all.count, 1, "round \(round): a waiter finished more than once")
            XCTAssertEqual(h.ended.count, 1, "round \(round): the link ended more than once")
            XCTAssertLessThanOrEqual(h.attached.count, 1,
                                     "round \(round): the lanes were handed over twice")
        }
    }

    /// A rebuild completing as its window closes resolves one way, and the two
    /// answers stay consistent with each other: an attached link is open, an
    /// expired one is ended with nothing attached.
    func testAPublicationRacingTheWindowExpiryResolvesOneWay() {
        for round in 0..<stressRounds {
            let h = harness()
            h.loseTransport()
            guard let candidate = h.produced.first else { return XCTFail("round \(round): no attempt") }

            inParallel(2) { index in
                if index == 0 {
                    candidate.becomeReady(h.held)
                } else {
                    h.scheduler.fire(LINK_RECOVERY_WINDOW)
                }
            }

            XCTAssertLessThanOrEqual(h.attached.count, 1, "round \(round): the lanes were handed over twice")
            XCTAssertLessThanOrEqual(h.ended.count, 1, "round \(round): the link ended more than once")
            XCTAssertEqual(h.attached.count == 1, h.coordinator.phase == .open,
                           "round \(round): the published link and the phase disagree")
            XCTAssertEqual(h.attached.isEmpty, h.coordinator.phase == .ended,
                           "round \(round): an expired window left the link neither open nor ended")
        }
    }

    // MARK: - the one allocation slot is reserved before the factory

    /// The factory is arbitrary owner code, and the one thing it must not be able
    /// to do is allocate a second rebuild while it is producing the first.
    ///
    /// A `candidate` that stays nil for the whole factory call is not a slot: a
    /// factory that re-enters with another GENUINE offer — a session model
    /// draining a queued signal on its way through — finds it free and allocates
    /// again, into the same pair of lanes, and can do so to any depth.
    func testAReentrantFactoryCannotAllocateASecondAttempt() {
        let h = responderHarness()
        var remaining = 3
        h.factorySideEffect = { [weak h] in
            guard let h, remaining > 0 else { return }
            remaining -= 1
            h.coordinator.receiveResumeOffer(
                from: "peer-b",
                signal: self.genuineOffer(h.held, sdp: "v=0 reentrant-\(remaining)"))
        }

        h.coordinator.receiveResumeOffer(from: "peer-b", signal: genuineOffer(h.held))

        XCTAssertEqual(h.produced.count, 1,
                       "a re-entrant factory allocated a second rebuild into the same lanes")
        XCTAssertEqual(h.coordinator.phase, .interrupted)
        // The one transport that exists is the one that owns the slot: wired,
        // handed its offer, started, and not closed as somebody else's loser.
        XCTAssertEqual(h.produced[0].calls, ["receive:peer-b", "start"])
        XCTAssertEqual(h.produced[0].closeCount, 0)
        XCTAssertTrue(h.produced[0].callbacksInstalledFirst)
    }

    /// The reservation comes back when the attempt it was made for fails, or the
    /// rest of the window is spent refusing the peer that is still trying.
    func testAReentrantFactoryStillLeavesTheSlotFreeForTheNextOffer() {
        let h = responderHarness()
        h.factorySideEffect = { [weak h] in
            guard let h else { return }
            h.coordinator.receiveResumeOffer(from: "peer-b",
                                             signal: self.genuineOffer(h.held, sdp: "v=0 inner"))
        }
        h.coordinator.receiveResumeOffer(from: "peer-b", signal: genuineOffer(h.held))
        h.factorySideEffect = nil

        h.produced[0].failAndClose(LinkTransportError.peerConnectionFailed)
        h.coordinator.receiveResumeOffer(from: "peer-b", signal: genuineOffer(h.held, sdp: "v=0 next"))

        XCTAssertEqual(h.produced.count, 2)
        XCTAssertEqual(h.coordinator.phase, .interrupted)
    }

    /// A factory that ends the link and THEN fails must not arm a retry for a gap
    /// that is over — and must leave the room's admission where an ordinary
    /// cancellation leaves it.
    func testAFactoryThatStopsAndThenFailsArmsNoRetry() {
        struct Boom: Error {}
        let h = harness()
        h.factoryError = Boom()
        h.beforeBuild = { [weak h] in h?.coordinator.stop() }

        h.loseTransport()

        XCTAssertEqual(h.coordinator.phase, .ended)
        XCTAssertTrue(h.produced.isEmpty)
        XCTAssertTrue(h.scheduler.liveDelays.isEmpty, "an ended link armed a retry")
        XCTAssertEqual(h.ended.count, 1)
        XCTAssertEqual(h.admission.phase, .idle)
    }

    /// The same for a peer that leaves from inside the factory. Nothing is left
    /// running and nothing is left holding the slot.
    func testAFactoryThatLosesThePeerLeavesNothingRunning() {
        let h = harness()
        h.factorySideEffect = { [weak h] in h?.coordinator.peerDeparted("peer-b") }

        h.loseTransport()

        XCTAssertEqual(h.coordinator.phase, .ended)
        XCTAssertEqual(h.produced.count, 1)
        XCTAssertEqual(h.produced[0].calls, ["close"], "an ended link started a transport")
        XCTAssertEqual(h.admission.phase, .idle)
    }

    // MARK: - admission terminal semantics

    /// An ordinary end is not a failure.
    ///
    /// A user pressing disconnect, a server-confirmed departure, and a transport
    /// closing cleanly on a link the owner had nothing to recover are all normal
    /// — the web client's `close()` path, not its error path. Leaving admission
    /// in `.failed` for any of them means the room's one-link rule reports a
    /// broken link where there is simply none, and `didClose`'s reset of the
    /// established role, the leave budget and the timeout marks never happens.
    func testAnOrdinaryEndingLeavesAdmissionIdle() {
        let stopped = harness()
        stopped.loseTransport()
        stopped.coordinator.stop()
        XCTAssertEqual(stopped.admission.phase, .idle, "an explicit stop failed the link")

        let stoppedWhileOpen = harness()
        stoppedWhileOpen.coordinator.stop()
        XCTAssertEqual(stoppedWhileOpen.admission.phase, .idle)

        let departed = harness()
        departed.loseTransport()
        departed.coordinator.peerDeparted("peer-b")
        XCTAssertEqual(departed.admission.phase, .idle, "a peer leaving on purpose failed the link")

        // A transport that closed with no error, on a link whose owner had
        // nothing worth recovering: an ordinary end-of-session, not a fault.
        let declined = harness()
        declined.hold = false
        declined.coordinator.transportTerminated(declined.current, error: nil)
        XCTAssertEqual(declined.admission.phase, .idle)
        guard case .declined? = declined.ended.first else { return XCTFail("wrong end reason") }
    }

    /// Everything that genuinely broke still fails, including a declined decision
    /// that followed a transport failure: the owner declined to RECOVER it, which
    /// does not make the failure that caused it an ordinary close.
    func testEveryBrokenEndingFailsAdmission() {
        let declined = harness()
        declined.hold = false
        declined.loseTransport()
        XCTAssertEqual(declined.admission.phase, .failed, "a declined failure closed cleanly")

        struct Boom: Error {}
        let policy = harness()
        policy.policyError = Boom()
        policy.loseTransport()
        XCTAssertEqual(policy.admission.phase, .failed)

        let expired = harness()
        expired.loseTransport()
        XCTAssertTrue(expired.scheduler.fire(LINK_RECOVERY_WINDOW))
        XCTAssertEqual(expired.admission.phase, .failed)

        let mismatch = harness()
        mismatch.loseTransport()
        mismatch.produced[0].becomeReady(identity(peerId: mismatch.held.peerId,
                                                  role: mismatch.held.role,
                                                  sas: mismatch.held.sas,
                                                  generation: mismatch.held.authenticationGeneration))
        XCTAssertEqual(mismatch.admission.phase, .failed)

        let attach = harness()
        attach.loseTransport()
        attach.attachError = Boom()
        attach.produced[0].becomeReady(attach.held)
        XCTAssertEqual(attach.admission.phase, .failed)

        let poisoned = harness()
        poisoned.loseTransport()
        poisoned.produced[0].failAndClose(LinkTransportError.captureOverflow)
        XCTAssertEqual(poisoned.admission.phase, .failed)
    }

    /// An owner that cancels from inside a hook has still cancelled. The re-entry
    /// must not turn an ordinary stop into a reported failure.
    func testAReentrantStopFromAnOwnerHookStillLeavesAdmissionIdle() {
        let fromPolicy = harness()
        fromPolicy.onLostSideEffect = { [weak fromPolicy] in fromPolicy?.coordinator.stop() }
        fromPolicy.loseTransport()
        XCTAssertEqual(fromPolicy.admission.phase, .idle)

        let fromAttach = harness()
        fromAttach.loseTransport()
        fromAttach.onAttachSideEffect = { [weak fromAttach] in fromAttach?.coordinator.stop() }
        fromAttach.produced[0].becomeReady(fromAttach.held)
        XCTAssertEqual(fromAttach.admission.phase, .idle)

        let fromFactory = harness()
        fromFactory.factorySideEffect = { [weak fromFactory] in fromFactory?.coordinator.stop() }
        fromFactory.loseTransport()
        XCTAssertEqual(fromFactory.admission.phase, .idle)
    }

    // MARK: - lifetime

    /// An owner that drops this object mid-gap leaves a live PeerConnection and
    /// an installed signalling handler behind unless something releases them.
    ///
    /// Nothing else can: the candidate was never published, so no owner has it.
    /// The timers hold this object weakly, which is what makes the drop possible
    /// at all — and is also why nothing will ever run to clean up afterwards.
    func testACoordinatorDroppedMidGapReleasesItsRebuild() {
        var h: Harness? = harness()
        h?.loseTransport()
        guard let candidate = h?.produced.first else { return XCTFail("no attempt") }
        weak var dropped = h?.coordinator
        XCTAssertNotNil(dropped)

        h = nil

        XCTAssertNil(dropped, "a timer or a candidate kept the coordinator alive past its owner")
        XCTAssertEqual(candidate.closeCount, 1, "a dropped coordinator abandoned a live rebuild")
        XCTAssertNil(candidate.onReady, "a dropped coordinator left a handler on a transport")
        XCTAssertNil(candidate.onFrame)
        XCTAssertNil(candidate.onError)
        XCTAssertNil(candidate.onClose)
    }

    /// An owner may close the replacement from inside its own attach hook, and
    /// that close lands BEFORE the hook returns.
    ///
    /// `WebRTCLinkReplacementTransport` documents exactly that and implements it
    /// with an inline teardown, so `onClose` arrives on this coordinator's stack
    /// while it is still inside `onAttach` — through a recursive lock it already
    /// holds. Publishing afterwards would make a transport the owner has just
    /// closed the current one, and replaying a backlog into it would feed frames
    /// to a lane nobody owns.
    func testAnAttachHookThatClosesTheReplacementPublishesNothing() {
        let h = harness()
        h.loseTransport()
        guard let candidate = h.produced.first else { return XCTFail("no attempt") }
        // Exactly what an inline `close()` from a callback produces.
        h.onAttachSideEffect = { candidate.onClose?() }

        candidate.becomeReady(h.held, replay: [(.file, [1])])

        XCTAssertEqual(h.coordinator.phase, .interrupted, "a closed replacement was published")
        XCTAssertTrue(h.frames.isEmpty, "a backlog replayed into a closed replacement")
        XCTAssertTrue(h.ended.isEmpty, "one attempt ending ended the held link")
        XCTAssertEqual(h.scheduler.liveDelays, [LINK_RECOVERY_WINDOW, LINK_RECOVERY_RETRY],
                       "the gap gave up instead of retrying inside its window")
    }

    /// A retry attempt that fails while an explicit stop is racing it settles
    /// once, whichever wins: no resurrection, no second retry armed behind an
    /// ended link, and one reported outcome.
    func testAFailingRetryRacingAnExplicitStopSettlesOnce() {
        for round in 0..<stressRounds {
            let h = harness()
            h.loseTransport()
            guard let candidate = h.produced.first else { return XCTFail("round \(round): no attempt") }

            inParallel(2) { index in
                if index == 0 {
                    candidate.failAndClose(LinkTransportError.peerConnectionFailed)
                } else {
                    h.coordinator.stop()
                }
            }

            XCTAssertEqual(h.coordinator.phase, .ended, "round \(round)")
            XCTAssertEqual(h.ended.count, 1, "round \(round): the link ended more than once")
            XCTAssertEqual(h.admission.phase, .idle, "round \(round): an explicit stop failed the link")
            XCTAssertTrue(h.scheduler.liveDelays.isEmpty,
                          "round \(round): an ended link left a wake-up armed")
            XCTAssertEqual(candidate.closeCount, 1, "round \(round): the attempt was closed twice")
        }
    }

    /// An owner may finish with this coordinator from inside `onEnded`.
    ///
    /// That is where a session model tears down, so dropping the last reference
    /// there is the ordinary case rather than an abuse — and it deallocates this
    /// object while the `stop()` that ended it is still on the stack, inside a
    /// lock that has yet to be released. The lock is therefore held by value for
    /// the duration of every locked section.
    func testAnOwnerMayReleaseTheCoordinatorFromInsideItsEndCallback() {
        var h: Harness? = harness()
        h?.loseTransport()
        weak var dropped = h?.coordinator
        XCTAssertNotNil(dropped)
        h?.onEndedSideEffect = { h = nil }

        h?.coordinator.stop()

        XCTAssertNil(h, "the owner's own release did not run")
        XCTAssertNil(dropped, "a released coordinator outlived the callback that released it")
    }

    /// Frames follow the transport that is CURRENT, and a detached loser cannot
    /// inject into the lanes the winner now owns.
    func testFramesFollowTheCurrentReplacementAndNotADetachedCandidate() {
        let h = harness()
        h.loseTransport()
        guard let first = h.produced.first, let staleFrame = first.onFrame else {
            return XCTFail("no attempt")
        }
        first.failAndClose(LinkTransportError.peerConnectionFailed)
        XCTAssertTrue(h.scheduler.fire(LINK_RECOVERY_RETRY))
        guard h.produced.count == 2 else { return XCTFail("no retry attempt") }
        h.produced[1].becomeReady(h.held)

        staleFrame(.file, [9])
        h.produced[1].onFrame?(.text, [1, 2])

        XCTAssertEqual(h.frames.count, 1, "a detached candidate delivered into the current lanes")
        XCTAssertEqual(h.frames[0].0, .text)
        XCTAssertEqual(h.frames[0].1, [1, 2])
    }

    // MARK: - still gated

    /// This slice makes a rebuild reachable. It does not make `link/1`
    /// deliverable: there are no durable file checkpoints, no RESUME_REQ/
    /// RESUME_START, no poisoned text-lane policy, no UI lifecycle and no
    /// native↔Web evidence. Both constants stay false.
    func testTheBuildStillAdvertisesNoLinkSupport() {
        XCTAssertFalse(LINK_TRANSPORT_REPLACEMENT_SUPPORTED)
        XCTAssertFalse(LINK_BUILD_SUPPORT)
    }
}
