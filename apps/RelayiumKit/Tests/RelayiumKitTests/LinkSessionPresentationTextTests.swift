import Combine
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

// MARK: - what a transcript view would be watching
//
// Same shape and same reason as `PhaseLog` in the lifecycle suite: every
// positive delivery is observed through the model's own `@Published` projection
// rather than by reading a property after a guessed number of turns, because a
// model that assigned the right value without publishing it is a screen that
// never repaints.
//
// Generic over the published value so the transcript and the lane status can
// each be watched on their own — asserting on the transcript's publications
// while waiting on the status publisher would be waiting for the wrong thing.
//
// Lock-guarded and NOT `@MainActor`, again on purpose: one of these tests exists
// to prove deliveries land on the main actor, and a recorder that could only be
// touched there would assume the property it is meant to prove.

private final class PublicationLog<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var _values: [Value] = []
    private var _alwaysOnMainThread = true
    private var expected = Int.max
    private var arrival: XCTestExpectation?
    private var subscription: AnyCancellable?

    /// `$value` replays the current value on subscription, so the first entry is
    /// always whatever the model held when this log attached.
    @MainActor
    init(_ publisher: Published<Value>.Publisher) {
        subscription = publisher.sink { [weak self] value in
            self?.record(value)
        }
    }

    private func record(_ value: Value) {
        lock.lock()
        _alwaysOnMainThread = _alwaysOnMainThread && Thread.isMainThread
        _values.append(value)
        let reached = _values.count == expected
        let arrived = arrival
        lock.unlock()

        if reached { arrived?.fulfill() }
    }

    var values: [Value] {
        lock.lock(); defer { lock.unlock() }; return _values
    }

    var count: Int {
        lock.lock(); defer { lock.unlock() }; return _values.count
    }

    var alwaysOnMainThread: Bool {
        lock.lock(); defer { lock.unlock() }; return _alwaysOnMainThread
    }

    /// Wait for a publication that MUST happen, rather than for a fixed number
    /// of main-actor turns that might not be enough on a loaded machine.
    func expect(_ count: Int, _ description: String, in test: XCTestCase) -> XCTestExpectation {
        let waited = test.expectation(description: description)
        lock.lock()
        expected = count
        arrival = waited
        let already = _values.count >= count
        lock.unlock()

        if already { waited.fulfill() }
        return waited
    }

    /// Drop the subscription, for the lifetime test: nothing may be left holding
    /// anything of the model's when it checks whether the model went away.
    func detach() { subscription = nil }
}

@MainActor
final class LinkSessionPresentationTextTests: XCTestCase {

    // MARK: - helpers

    /// Every status this lane has, in one place. Enumerated rather than sampled:
    /// a case added to `LinkTextStatus` that this projection dropped would be a
    /// conversation whose state a screen silently stopped tracking.
    private let allStatuses: [LinkTextStatus] = [.idle, .waitingAccept, .incomingRequest,
                                                 .open, .ended, .refused, .failed]

    /// Let every main-actor consumer that is already scheduled run, for the
    /// checks that assert something does NOT arrive. Not a sleep, and bounded:
    /// a no-repaint property has nothing to wait for, so waiting longer only
    /// makes the suite slower, never more correct.
    private func settle(_ turns: Int = 4) async {
        for _ in 0..<turns { await Task.yield() }
    }

    /// Run `work` on a background thread and come back once it has returned.
    private func offMain(_ work: @escaping @Sendable () -> Void) async {
        await withCheckedContinuation { continuation in
            DispatchQueue.global().async {
                work()
                continuation.resume()
            }
        }
    }

    /// A bridge and the model bound to it, which is the only shape this slice
    /// has: no runtime, no transport, no environment.
    private func rig() -> (bridge: LinkSessionEventBridge, model: LinkSessionPresentationModel) {
        let bridge = LinkSessionEventBridge()
        return (bridge, bound(to: bridge))
    }

    /// The model, bound to a bridge exactly as its owner binds one.
    ///
    /// In production the binding is `LinkSessionAttempt`'s: one bridge is bound
    /// ONCE, by the owner, which then fans each event out to both projections.
    /// This slice has no attempt, so it makes the same binding the same way —
    /// through the bridge's structural weak-owner API, with the model reached
    /// through the handler's `owner` parameter and no `[weak self]` written.
    private func bound(to bridge: LinkSessionEventBridge) -> LinkSessionPresentationModel {
        let model = LinkSessionPresentationModel()
        bridge.bind(to: model) { owner, event in owner.apply(event) }
        return model
    }

    /// Open the link itself, since most of what the text lane does is only
    /// interesting under an authenticated one.
    private func open(_ bridge: LinkSessionEventBridge,
                      _ model: LinkSessionPresentationModel) async {
        let log = PublicationLog(model.$phase)
        let opened = log.expect(2, "the link opens", in: self)
        bridge.publish(.opened(peerId: "peer-text", sas: "424242"))
        await fulfillment(of: [opened], timeout: 5)
        log.detach()
    }

    // MARK: - 1. what a transcript opens as

    /// The state a view is built in, pinned literally: no conversation, no
    /// history, no failure.
    func testTheInitialTextStateIsIdleAndEmpty() {
        let (_, model) = rig()

        XCTAssertEqual(model.textStatus, .idle)
        XCTAssertTrue(model.textMessages.isEmpty)
        XCTAssertNil(model.textFailure)
        XCTAssertFalse(model.canSendText)
        XCTAssertFalse(model.hasIncomingTextRequest)
        XCTAssertFalse(model.isWaitingForTextAccept)
        XCTAssertFalse(model.isTextFailed)
    }

    // MARK: - 2. the status mapping

    /// Every status the driver can emit reaches the model as itself. The driver
    /// emits `status` only on a real change, so there is nothing to interpret
    /// here and interpreting one would be inventing a second state machine.
    func testEveryTextStatusIsProjectedVerbatim() async {
        for status in allStatuses {
            let (bridge, model) = rig()
            let log = PublicationLog(model.$textStatus)
            let arrived = log.expect(2, "\(status) arrives", in: self)

            bridge.publish(.text(.status(status)))
            await fulfillment(of: [arrived], timeout: 5)

            XCTAssertEqual(model.textStatus, status)
            XCTAssertNil(model.textFailure,
                         "\(status): a status carries no typed error, not even `.failed`")
        }
    }

    // MARK: - 3. the transcript

    /// Order, duplicates, empty bodies and exact contents. The driver and the
    /// session below it own every protocol limit — an empty body is already
    /// refused there — so this projection deliberately adds no second policy: it
    /// keeps what it is handed, verbatim, and gives each entry its own identity.
    func testEveryReceivedBodyIsKeptVerbatimWithADistinctIncreasingId() async {
        let (bridge, model) = rig()
        await open(bridge, model)

        let bodies = ["hello", "hello", "", "  spaced  ", "hello"]
        let log = PublicationLog(model.$textMessages)
        let arrived = log.expect(bodies.count + 1, "every message arrives", in: self)

        bridge.publish(.text(.status(.open)))
        for body in bodies { bridge.publish(.text(.received(body))) }
        await fulfillment(of: [arrived], timeout: 5)

        XCTAssertEqual(model.textMessages.map(\.body), bodies,
                       "no trimming, no de-duplication, no dropped empties")
        XCTAssertEqual(model.textMessages.map(\.direction),
                       Array(repeating: .incoming, count: bodies.count),
                       "this slice creates incoming entries only")

        let ids = model.textMessages.map(\.id)
        XCTAssertEqual(Set(ids).count, ids.count, "ids are distinct")
        XCTAssertEqual(ids, ids.sorted(), "and increasing, so a view can order by them")
    }

    // MARK: - 4. the hop

    /// The runtime delivers on whichever thread is draining, and this model is
    /// `@MainActor`. What a transcript view needs is that every publication it
    /// sees happens there, including for messages produced off the main thread.
    func testTextDeliveryFromABackgroundPublisherLandsOnTheMainActor() async {
        let (bridge, model) = rig()
        let log = PublicationLog(model.$textMessages)
        let arrived = log.expect(3, "both messages arrive", in: self)

        await offMain {
            bridge.publish(.text(.status(.open)))
            bridge.publish(.text(.received("from a background drain")))
            bridge.publish(.text(.received("and another")))
        }
        await fulfillment(of: [arrived], timeout: 5)

        XCTAssertTrue(log.alwaysOnMainThread, "every publication must be on the main thread")
        XCTAssertEqual(model.textMessages.map(\.body),
                       ["from a background drain", "and another"])
    }

    // MARK: - 5. failure is terminal for this lane

    /// The first typed failure is the one that stands, and nothing after it
    /// moves this lane — not a later status, not a later message, not a second
    /// failure. The driver promises at most one `failed`; the visible cost of
    /// trusting that promise alone is a lane that says "open" again on a screen
    /// that has already reported it broken.
    func testTheFirstTypedFailureWinsAndIsTerminalForTheLane() async {
        let (bridge, model) = rig()
        await open(bridge, model)

        let log = PublicationLog(model.$textStatus)
        let failed = log.expect(2, "the lane fails", in: self)
        bridge.publish(.text(.failed(.protectedSendFailed)))
        await fulfillment(of: [failed], timeout: 5)

        XCTAssertEqual(model.textStatus, .failed)
        XCTAssertEqual(model.textFailure, .protectedSendFailed)
        XCTAssertTrue(model.isTextFailed)

        let messages = PublicationLog(model.$textMessages)
        bridge.publish(.text(.status(.open)))
        bridge.publish(.text(.received("after the failure")))
        bridge.publish(.text(.failed(.linkEnded)))
        await settle()

        XCTAssertEqual(model.textStatus, .failed, "no later status repaints a failed lane")
        XCTAssertEqual(model.textFailure, .protectedSendFailed, "the first failure is the one kept")
        XCTAssertTrue(model.textMessages.isEmpty, "and no later message is admitted")
        XCTAssertEqual(log.count, 2, "nothing republished the status")
        XCTAssertEqual(messages.count, 1, "nor the transcript")
    }

    /// A lane can reach `failed` through a plain status change, which carries no
    /// typed error — the driver's own `failed` follows it. So a lane that is
    /// already failed must still take the FIRST typed error it is given, or the
    /// one fact a support conversation needs is the one thing this model drops.
    func testAStatusFailedFollowedByATypedFailureStillRecordsTheError() async {
        let (bridge, model) = rig()
        await open(bridge, model)

        let log = PublicationLog(model.$textStatus)
        let failed = log.expect(2, "the status goes failed", in: self)
        bridge.publish(.text(.status(.failed)))
        await fulfillment(of: [failed], timeout: 5)

        XCTAssertEqual(model.textStatus, .failed)
        XCTAssertNil(model.textFailure, "a bare status has no error to record yet")

        let recorded = PublicationLog(model.$textFailure)
        let arrived = recorded.expect(2, "the typed failure arrives", in: self)
        bridge.publish(.text(.failed(.refused(.notOpen))))
        await fulfillment(of: [arrived], timeout: 5)

        XCTAssertEqual(model.textFailure, .refused(.notOpen))
        XCTAssertEqual(model.textStatus, .failed)
        XCTAssertEqual(log.count, 2, "and the status did not repaint to the value it already held")

        bridge.publish(.text(.failed(.laneTerminal)))
        await settle()
        XCTAssertEqual(model.textFailure, .refused(.notOpen), "still the first one")
        XCTAssertEqual(recorded.count, 2)
    }

    // MARK: - 6. an ordinary conversation ending is not the end of the transcript

    /// `ended` and `refused` are conversation states, not lane failures: the
    /// history stays and the same authenticated link can open another one. A
    /// model that cleared on `ended` would delete a conversation the user is
    /// still reading, on a link that is still up.
    func testAnEndedOrRefusedConversationKeepsItsHistoryAndCanOpenAgain() async {
        for closing in [LinkTextStatus.ended, .refused] {
            let (bridge, model) = rig()
            await open(bridge, model)

            let log = PublicationLog(model.$textMessages)
            let first = log.expect(2, "the first conversation's message", in: self)
            bridge.publish(.text(.status(.open)))
            bridge.publish(.text(.received("before")))
            await fulfillment(of: [first], timeout: 5)
            let firstId = model.textMessages.first?.id

            let second = log.expect(3, "the second conversation's message", in: self)
            bridge.publish(.text(.status(closing)))
            bridge.publish(.text(.status(.waitingAccept)))
            bridge.publish(.text(.status(.open)))
            bridge.publish(.text(.received("after")))
            await fulfillment(of: [second], timeout: 5)

            XCTAssertEqual(model.textMessages.map(\.body), ["before", "after"],
                           "\(closing): the transcript survives the conversation")
            XCTAssertEqual(model.textStatus, .open)
            XCTAssertNil(model.textFailure, "\(closing) is not a lane failure")
            XCTAssertFalse(model.isTextFailed)
            guard let firstId, let secondId = model.textMessages.last?.id else {
                XCTFail("\(closing): both messages must be there to compare ids")
                continue
            }
            XCTAssertGreaterThan(secondId, firstId, "ids keep climbing across conversations")
        }
    }

    // MARK: - 7. the whole session ending stops everything

    /// The connection phase is terminal, and it is terminal for the lanes too.
    /// The runtime promises `ended` is its last event and the bridge drops what
    /// it is holding, so this is defence in depth against a transcript that kept
    /// growing on a screen whose session was over.
    func testAWholeSessionEndBlocksEveryLaterTextEvent() async {
        let (bridge, model) = rig()
        await open(bridge, model)

        let log = PublicationLog(model.$textMessages)
        let arrived = log.expect(2, "the conversation says one thing", in: self)
        bridge.publish(.text(.status(.open)))
        bridge.publish(.text(.received("kept")))
        await fulfillment(of: [arrived], timeout: 5)

        let status = PublicationLog(model.$textStatus)
        let failure = PublicationLog(model.$textFailure)
        bridge.publish(.ended(.linkEnded))
        await settle()

        bridge.publish(.text(.status(.failed)))
        bridge.publish(.text(.received("lost")))
        bridge.publish(.text(.failed(.linkEnded)))
        await settle()

        XCTAssertEqual(model.phase, .ended(.linkEnded))
        XCTAssertEqual(model.textStatus, .open, "the lane state freezes as the session ended")
        XCTAssertEqual(model.textMessages.map(\.body), ["kept"])
        XCTAssertNil(model.textFailure)
        XCTAssertEqual(status.count, 1, "nothing repainted the lane after the session ended")
        XCTAssertEqual(failure.count, 1)
        XCTAssertEqual(log.count, 2)
    }

    // MARK: - 8. the lane this slice still does not project

    /// The file lane and the committed batch belong to a later slice, and they
    /// must be inert for the transcript as well as for the connection phase.
    func testFileAndReceivedEventsTouchNeitherTheTranscriptNorThePhase() async {
        let (bridge, model) = rig()
        await open(bridge, model)

        let messages = PublicationLog(model.$textMessages)
        let status = PublicationLog(model.$textStatus)
        let phase = PublicationLog(model.$phase)

        let inert: [LinkSessionRuntimeEvent] = [
            .file(.inboundProgress(batch: 1, durableBytes: 8)),
            .file(.outboundFinished(batch: 1, ok: true)),
            .received(LinkReceivedBatch(batch: 1, files: [], container: nil)),
        ]
        for event in inert { bridge.publish(event) }
        await settle()

        XCTAssertEqual(model.textStatus, .idle)
        XCTAssertTrue(model.textMessages.isEmpty)
        XCTAssertNil(model.textFailure)
        XCTAssertEqual(model.phase, .open(peerId: "peer-text", sas: "424242"))
        XCTAssertEqual(messages.count, 1, "no file event may repaint the transcript")
        XCTAssertEqual(status.count, 1)
        XCTAssertEqual(phase.count, 1)
    }

    // MARK: - 9. what a view actually asks

    /// The composer is a question about BOTH states: an open conversation on a
    /// link that is not open yet is not something a user can type into, and
    /// neither is an open link with no conversation. The consent flags are the
    /// same question for the two states a user has to answer.
    func testTheComputedFactsReflectBothTheLinkAndTheLane() async {
        let (bridge, model) = rig()

        let log = PublicationLog(model.$textStatus)
        let early = log.expect(2, "a conversation before the link is open", in: self)
        bridge.publish(.text(.status(.open)))
        await fulfillment(of: [early], timeout: 5)
        XCTAssertFalse(model.canSendText, "an open conversation on a link that is not open yet")

        await open(bridge, model)
        XCTAssertTrue(model.canSendText)
        XCTAssertFalse(model.hasIncomingTextRequest)
        XCTAssertFalse(model.isWaitingForTextAccept)

        let asked = log.expect(3, "the peer asks", in: self)
        bridge.publish(.text(.status(.incomingRequest)))
        await fulfillment(of: [asked], timeout: 5)
        XCTAssertTrue(model.hasIncomingTextRequest)
        XCTAssertFalse(model.canSendText)

        let waiting = log.expect(4, "this side asks", in: self)
        bridge.publish(.text(.status(.waitingAccept)))
        await fulfillment(of: [waiting], timeout: 5)
        XCTAssertTrue(model.isWaitingForTextAccept)
        XCTAssertFalse(model.hasIncomingTextRequest)
        XCTAssertFalse(model.canSendText)

        let phase = PublicationLog(model.$phase)
        let ended = phase.expect(2, "the session ends", in: self)
        bridge.publish(.ended(.stopped))
        await fulfillment(of: [ended], timeout: 5)

        XCTAssertFalse(model.canSendText, "nothing is actionable once the session is over")
        XCTAssertFalse(model.hasIncomingTextRequest)
        XCTAssertFalse(model.isWaitingForTextAccept)
    }

    // MARK: - 10. lifetime

    /// The text projection changed no part of the binding: the model still
    /// arrives as the handler's `owner` parameter and is still held weakly, so a
    /// runtime that outlives its screen cannot keep that screen — or its whole
    /// transcript — alive.
    func testProjectingTextDoesNotMakeTheBridgeRetainTheModel() async {
        let bridge = LinkSessionEventBridge()
        weak var observed: LinkSessionPresentationModel?
        do {
            let model = bound(to: bridge)
            observed = model
            let log = PublicationLog(model.$textMessages)
            let arrived = log.expect(2, "the transcript is live", in: self)
            bridge.publish(.text(.status(.open)))
            bridge.publish(.text(.received("still here")))
            await fulfillment(of: [arrived], timeout: 5)
            XCTAssertEqual(model.textMessages.count, 1)
            log.detach()
        }

        XCTAssertNil(observed, "the bridge holds the model weakly")

        // And delivering into a model that has gone stays inert rather than a
        // crash, for text as for everything else.
        bridge.publish(.text(.received("into nothing")))
        await settle()
        bridge.invalidate()
        await settle()
    }

    // MARK: - 11. nothing here is reachable from production

    /// Both flags are still false and no shipping build speaks this transport.
    /// The source scan that proves nothing in the app sources CONSTRUCTS this
    /// model lives once, in
    /// `LinkSessionPresentationModelTests.testTheModelStaysUnreachableFromProduction`;
    /// running it a second time here would double a whole-tree walk to restate
    /// the same fact.
    func testTheTextProjectionShipsBehindTheSameClosedFlags() {
        XCTAssertFalse(LINK_BUILD_SUPPORT)
        XCTAssertFalse(LINK_TRANSPORT_REPLACEMENT_SUPPORTED)
    }
}
