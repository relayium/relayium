import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

// MARK: - the owner a bridge paints
//
// A stand-in for the `@MainActor` Link presentation model that does not exist
// yet. It is a CLASS, and every test below binds it in the standard shape — the
// handler reaches it only through the supplied `owner` parameter, with no
// `[weak]` written anywhere — which is the shape whose weak capture the lifetime
// test watches it deallocate under. What the rest of them pin is that whatever
// this thing does from inside a delivery — publish again, invalidate, hold the
// main actor — the stream it sees stays single, ordered and finite.

@MainActor
private final class Recorder {
    /// Everything delivered, in delivery order.
    private(set) var events: [LinkSessionRuntimeEvent] = []
    /// Whether every delivery so far really arrived on the main thread.
    private(set) var alwaysOnMainThread = true
    /// The deepest this handler was ever entered. Anything above 1 means one
    /// delivery ran INSIDE another, which is the nesting the mailbox exists to
    /// make impossible.
    private(set) var maxDepth = 0
    private var depth = 0

    /// Run from inside the delivery, so a test can re-enter the bridge exactly
    /// where a real presentation model would.
    var duringDelivery: ((LinkSessionRuntimeEvent) -> Void)?
    /// Fulfilled when `events.count` reaches `expected`, so a test can wait for
    /// a delivery it expects to happen instead of guessing how many main-actor
    /// turns it takes.
    var arrival: XCTestExpectation?
    var expected = Int.max

    func record(_ event: LinkSessionRuntimeEvent) {
        depth += 1
        maxDepth = max(maxDepth, depth)
        alwaysOnMainThread = alwaysOnMainThread && Thread.isMainThread
        events.append(event)
        duringDelivery?(event)
        if events.count == expected { arrival?.fulfill() }
        depth -= 1
    }
}

/// Something a handler captures that is NOT the owner, so "invalidate clears the
/// handler" can be observed as a release rather than only as a silence — and so
/// "a second bind does not replace the stored closure" can be observed at all.
private final class Canary {}

@MainActor
final class LinkSessionEventBridgeTests: XCTestCase {

    // MARK: - helpers

    /// Wait for a delivery that MUST happen, rather than for a fixed number of
    /// main-actor turns that might not be enough on a loaded machine.
    private func arrival(of recorder: Recorder,
                         at count: Int,
                         _ description: String) -> XCTestExpectation {
        let arrived = expectation(description: description)
        recorder.arrival = arrived
        recorder.expected = count
        return arrived
    }

    /// Let every main-actor consumer that is already scheduled run, for the
    /// checks that assert something does NOT arrive.
    ///
    /// Not a sleep: `Task.yield()` puts this test behind whatever was enqueued
    /// before it on the main actor, and a drain runs to completion with no
    /// suspension of its own — so one turn is enough for one hop, and the extra
    /// turns cover a drain that schedules another. Bounded on purpose: a
    /// no-delivery property has nothing to wait for, so waiting longer only
    /// makes the suite slower, never more correct.
    private func settle(_ turns: Int = 4) async {
        for _ in 0..<turns { await Task.yield() }
    }

    private func digits(_ events: [LinkSessionRuntimeEvent]) -> [String] {
        events.map { event in
            if case let .sas(value) = event { return value }
            return "\(event)"
        }
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

    // MARK: - 1. events that arrive before there is anybody to paint

    /// The factory-time case: something is built, it reports, and the model
    /// binds afterwards. Nothing may be lost, and nothing may be delivered
    /// inline from `bind` — that would nest a whole stream inside whatever line
    /// constructed the model.
    func testEventsPublishedBeforeBindingAreDeliveredInOrderOnceBound() async {
        let bridge = LinkSessionEventBridge()
        bridge.publish(.sas("1"))
        bridge.publish(.opened(peerId: "peer", sas: "1"))

        let recorder = Recorder()
        let arrived = arrival(of: recorder, at: 2, "the buffered events arrive")
        bridge.bind(to: recorder) { owner, event in owner.record(event) }
        XCTAssertEqual(recorder.events, [], "binding must not deliver inline")

        await fulfillment(of: [arrived], timeout: 5)

        XCTAssertEqual(recorder.events, [.sas("1"), .opened(peerId: "peer", sas: "1")])
        XCTAssertEqual(recorder.maxDepth, 1)
    }

    /// Publishing with nobody bound queues rather than schedules: there is no
    /// consumer to run yet, and the drain those events get is the one `bind`
    /// starts.
    func testPublishingBeforeBindingSchedulesNothingUntilBind() async {
        let bridge = LinkSessionEventBridge()
        for n in 0..<10 { bridge.publish(.sas(String(n))) }
        XCTAssertEqual(bridge.scheduledDrains, 0, "no handler, so no consumer")

        let recorder = Recorder()
        let arrived = arrival(of: recorder, at: 10, "the whole backlog arrives")
        bridge.bind(to: recorder) { owner, event in owner.record(event) }
        XCTAssertEqual(bridge.scheduledDrains, 1, "bind starts exactly one")

        await fulfillment(of: [arrived], timeout: 5)
        XCTAssertEqual(digits(recorder.events), (0..<10).map(String.init))
    }

    // MARK: - 2. any thread in, one main-actor stream out

    /// One serial publisher off the main thread, so the admission order is the
    /// order this test wrote — and the delivery order has to be exactly it.
    func testBackgroundPublicationReachesTheMainActorInPublishedOrder() async {
        let bridge = LinkSessionEventBridge()
        let recorder = Recorder()
        let arrived = arrival(of: recorder, at: 100, "the last event arrives")
        bridge.bind(to: recorder) { owner, event in owner.record(event) }

        let publisher = DispatchQueue(label: "com.relayium.test.event-bridge-publisher")
        publisher.async {
            for n in 0..<100 { bridge.publish(.sas(String(n))) }
        }

        await fulfillment(of: [arrived], timeout: 5)

        XCTAssertEqual(digits(recorder.events), (0..<100).map(String.init))
        XCTAssertTrue(recorder.alwaysOnMainThread, "every delivery must be on the main thread")
        XCTAssertEqual(recorder.maxDepth, 1)
    }

    // MARK: - 3. a handler that publishes back

    /// A model that reacts to an event by asking the runtime for something —
    /// which produces another event — must not have that event nested inside the
    /// one it is still handling, and must not have it jump the queue.
    ///
    /// This is also the only proof anyone needs that no handler runs under the
    /// bridge's lock: `publish` from inside a delivery would deadlock on a
    /// non-recursive `NSLock` if it did.
    func testAHandlerMayPublishReentrantlyWithoutNestingOrReordering() async {
        let bridge = LinkSessionEventBridge()
        let recorder = Recorder()
        let arrived = arrival(of: recorder, at: 3, "the re-entrant event arrives too")
        bridge.bind(to: recorder) { owner, event in owner.record(event) }
        recorder.duringDelivery = { event in
            if case .sas("A") = event { bridge.publish(.sas("C")) }
        }

        bridge.publish(.sas("A"))
        bridge.publish(.sas("B"))
        await fulfillment(of: [arrived], timeout: 5)

        XCTAssertEqual(digits(recorder.events), ["A", "B", "C"],
                       "a re-entrant event queues BEHIND the one being delivered")
        XCTAssertEqual(recorder.maxDepth, 1, "it must not nest inside the current delivery")
    }

    /// A re-entrant publish must not start a SECOND consumer either: the drain
    /// that is running is the one that will pick the event up.
    func testAReentrantPublishDoesNotScheduleASecondConsumer() async {
        let bridge = LinkSessionEventBridge()
        let recorder = Recorder()
        let arrived = arrival(of: recorder, at: 2, "both events arrive")
        bridge.bind(to: recorder) { owner, event in owner.record(event) }
        recorder.duringDelivery = { event in
            if case .sas("A") = event { bridge.publish(.sas("C")) }
        }

        bridge.publish(.sas("A"))
        await fulfillment(of: [arrived], timeout: 5)

        XCTAssertEqual(digits(recorder.events), ["A", "C"])
        XCTAssertEqual(bridge.scheduledDrains, 1,
                       "the running drain consumes it; nothing new is scheduled")
    }

    // MARK: - 4. a burst

    /// The single-consumer property, stated where it is deterministic.
    ///
    /// The `scheduledDrains` check runs before this test ever suspends, so no
    /// drain can have run yet — every one of these events is admitted while a
    /// consumer is already scheduled and not yet started. A bridge that started a
    /// task per event would report 200 there and still pass every ordering test
    /// in this file on a quiet machine, because a shared FIFO queue hides the
    /// extra tasks.
    func testASynchronousBurstSchedulesExactlyOneConsumer() async {
        let bridge = LinkSessionEventBridge()
        let recorder = Recorder()
        let arrived = arrival(of: recorder, at: 200, "the whole burst arrives")
        bridge.bind(to: recorder) { owner, event in owner.record(event) }

        for n in 0..<200 { bridge.publish(.sas(String(n))) }
        XCTAssertEqual(bridge.scheduledDrains, 1, "one consumer for the whole burst")

        await fulfillment(of: [arrived], timeout: 5)

        XCTAssertEqual(digits(recorder.events), (0..<200).map(String.init))
        XCTAssertEqual(bridge.scheduledDrains, 1, "and it drained all of them")
        XCTAssertEqual(recorder.maxDepth, 1)
    }

    /// Many threads publishing at once. The bridge decides the order — no test
    /// can — so what is pinned here is that every event is delivered exactly
    /// once, without overlap, on the main thread.
    func testABurstFromManyThreadsIsDrainedWithoutOverlapOrLoss() async {
        let total = 200
        let bridge = LinkSessionEventBridge()
        let recorder = Recorder()
        let arrived = arrival(of: recorder, at: total, "the whole burst arrives")
        bridge.bind(to: recorder) { owner, event in owner.record(event) }

        await offMain {
            DispatchQueue.concurrentPerform(iterations: total) { n in
                bridge.publish(.sas(String(n)))
            }
        }
        await fulfillment(of: [arrived], timeout: 10)

        XCTAssertEqual(recorder.events.count, total, "every event exactly once")
        XCTAssertEqual(Set(digits(recorder.events)), Set((0..<total).map(String.init)))
        XCTAssertTrue(recorder.alwaysOnMainThread)
        XCTAssertEqual(recorder.maxDepth, 1, "one consumer at a time, never two")
    }

    /// No lost wakeup at the seam a racing publisher aims straight at: events
    /// admitted while a drain is finishing must either be taken by that drain or
    /// wake a new one, and "either" is the whole point — the count is what is
    /// pinned, not which consumer did it.
    func testEventsAdmittedAsADrainFinishesAreNeverStranded() async {
        let bridge = LinkSessionEventBridge()
        let recorder = Recorder()
        let arrived = arrival(of: recorder, at: 400, "both halves arrive")
        bridge.bind(to: recorder) { owner, event in owner.record(event) }

        // Two publishers whose windows overlap the drain that the other one
        // wakes, run repeatedly rather than once.
        await offMain {
            DispatchQueue.concurrentPerform(iterations: 2) { half in
                for n in 0..<200 { bridge.publish(.sas("\(half)-\(n)")) }
            }
        }
        await fulfillment(of: [arrived], timeout: 10)

        XCTAssertEqual(recorder.events.count, 400)
        XCTAssertEqual(recorder.maxDepth, 1)
    }

    // MARK: - 5. bound once

    /// A second `bind` must be inert in EVERY build, not just trapped in a debug
    /// one: a Release binary that quietly accepted it would hand this attempt's
    /// stream to a second owner and release the first owner's closure — running
    /// arbitrary `deinit` code — inside the bridge's critical section.
    ///
    /// So all three halves of "inert" are checked here: the second owner never
    /// receives anything, the first binding keeps receiving everything in order,
    /// and the stored closure is still literally the first one — which is what
    /// the surviving canary shows.
    func testASecondBindTakesNoDeliveryAndLeavesTheFirstBindingInPlace() async {
        let bridge = LinkSessionEventBridge()
        let first = Recorder()
        let second = Recorder()

        weak var observed: Canary?
        do {
            let canary = Canary()
            observed = canary
            bridge.bind(to: first) { owner, event in
                withExtendedLifetime(canary) {}
                owner.record(event)
            }
        }
        XCTAssertNotNil(observed, "the first handler is the stored one")

        let arrived = arrival(of: first, at: 2, "the first binding gets the whole stream")
        bridge.publish(.sas("1"))
        bridge.bind(to: second) { owner, event in owner.record(event) }
        XCTAssertNotNil(observed, "a second bind must not replace the stored closure")
        bridge.publish(.sas("2"))

        await fulfillment(of: [arrived], timeout: 5)
        await settle()

        XCTAssertEqual(digits(first.events), ["1", "2"], "the first binding is undisturbed")
        XCTAssertEqual(second.events, [], "the second binding never takes delivery")
    }

    /// And a refused bind must not touch the machinery either: no consumer of its
    /// own, and no second consumer for a backlog the first binding is already
    /// draining.
    func testASecondBindSchedulesNoConsumer() async {
        let bridge = LinkSessionEventBridge()
        let first = Recorder()
        let second = Recorder()
        let arrived = arrival(of: first, at: 1, "the backlog goes to the first binding")

        bridge.publish(.sas("1"))
        bridge.bind(to: first) { owner, event in owner.record(event) }
        XCTAssertEqual(bridge.scheduledDrains, 1)

        bridge.bind(to: second) { owner, event in owner.record(event) }
        XCTAssertEqual(bridge.scheduledDrains, 1, "a refused bind starts nothing")

        await fulfillment(of: [arrived], timeout: 5)
        await settle()

        XCTAssertEqual(digits(first.events), ["1"])
        XCTAssertEqual(second.events, [])
        XCTAssertEqual(bridge.scheduledDrains, 1)
    }

    // MARK: - 6. invalidation

    /// A retired attempt whose events had not been drained yet. The queue goes
    /// with it: this is what keeps a superseded runtime from repainting the
    /// model its replacement now owns.
    func testInvalidationBeforeTheDrainDeliversNothing() async {
        let bridge = LinkSessionEventBridge()
        let recorder = Recorder()
        bridge.publish(.sas("1"))
        bridge.bind(to: recorder) { owner, event in owner.record(event) }
        bridge.publish(.sas("2"))
        bridge.invalidate()

        await settle()

        XCTAssertEqual(recorder.events, [], "an already scheduled consumer must be inert")
    }

    /// Invalidated before anyone ever bound — the attempt that died between the
    /// factory and the screen. Binding afterwards is refused rather than queued.
    func testInvalidationBeforeBindingRefusesTheBinding() async {
        let bridge = LinkSessionEventBridge()
        bridge.publish(.sas("1"))
        bridge.invalidate()

        let recorder = Recorder()
        bridge.bind(to: recorder) { owner, event in owner.record(event) }
        bridge.publish(.sas("2"))
        await settle()

        XCTAssertEqual(recorder.events, [])
        XCTAssertEqual(bridge.scheduledDrains, 0, "a dead bridge starts no consumer")
    }

    /// Invalidated from inside a delivery — the model tearing its own session
    /// down as it paints the event that told it to. The event being handled
    /// finishes; everything behind it is dropped, including one published
    /// re-entrantly after the invalidation.
    func testInvalidationFromInsideADeliveryDropsTheRest() async {
        let bridge = LinkSessionEventBridge()
        let recorder = Recorder()
        // The event that invalidates is one this test positively expects, so it
        // is waited for rather than assumed to have fitted into `settle`'s turns.
        // Only the absence behind it is a no-delivery property.
        let arrived = arrival(of: recorder, at: 1, "the event that invalidates arrives")
        bridge.bind(to: recorder) { owner, event in owner.record(event) }
        recorder.duringDelivery = { event in
            guard case .sas("1") = event else { return }
            bridge.invalidate()
            bridge.publish(.sas("after-invalidate"))
        }

        bridge.publish(.sas("1"))
        bridge.publish(.sas("2"))
        bridge.publish(.sas("3"))
        await fulfillment(of: [arrived], timeout: 5)
        await settle()

        XCTAssertEqual(digits(recorder.events), ["1"])
    }

    /// Invalidated from another thread while the main actor is busy INSIDE a
    /// delivery. The event being handled finishes; nothing behind it arrives.
    func testInvalidationFromAnotherThreadDuringADeliveryStopsTheStream() async {
        let bridge = LinkSessionEventBridge()
        let recorder = Recorder()
        // As above: the delivery that the teardown thread races is expected, so
        // it is awaited. What `settle` then covers is only the absence behind it.
        let arrived = arrival(of: recorder, at: 1, "the delivery being raced arrives")
        bridge.bind(to: recorder) { owner, event in owner.record(event) }

        recorder.duringDelivery = { event in
            guard case .sas("1") = event else { return }
            // A real teardown thread, and the main actor is held right here
            // while it runs — so this can only complete if `invalidate` takes
            // nothing the delivery is holding.
            let done = DispatchSemaphore(value: 0)
            DispatchQueue.global().async {
                bridge.invalidate()
                done.signal()
            }
            XCTAssertEqual(done.wait(timeout: .now() + 5), .success,
                           "invalidate must not block on the running delivery")
        }

        bridge.publish(.sas("1"))
        bridge.publish(.sas("2"))
        bridge.publish(.sas("3"))
        await fulfillment(of: [arrived], timeout: 5)
        await settle()

        XCTAssertEqual(digits(recorder.events), ["1"])
    }

    /// Terminal, and from any thread: nothing published after the end is ever
    /// admitted, let alone delivered — including after a drain has already run
    /// to completion.
    func testNothingIsAdmittedAfterInvalidation() async {
        let bridge = LinkSessionEventBridge()
        let recorder = Recorder()
        let arrived = arrival(of: recorder, at: 1, "the live event arrives")
        bridge.bind(to: recorder) { owner, event in owner.record(event) }
        bridge.publish(.sas("1"))
        await fulfillment(of: [arrived], timeout: 5)
        XCTAssertEqual(digits(recorder.events), ["1"])
        let scheduledWhileLive = bridge.scheduledDrains

        bridge.invalidate()
        bridge.publish(.sas("2"))
        await offMain { bridge.publish(.ended(.stopped)) }
        await settle()

        XCTAssertEqual(digits(recorder.events), ["1"])
        XCTAssertEqual(bridge.scheduledDrains, scheduledWhileLive,
                       "a publish after the end wakes nothing")
    }

    /// Idempotent, including from several threads at once.
    func testInvalidationIsIdempotent() async {
        let bridge = LinkSessionEventBridge()
        let recorder = Recorder()
        let arrived = arrival(of: recorder, at: 1, "the live event arrives")
        bridge.bind(to: recorder) { owner, event in owner.record(event) }
        bridge.publish(.sas("1"))
        await fulfillment(of: [arrived], timeout: 5)

        bridge.invalidate()
        bridge.invalidate()
        await offMain {
            DispatchQueue.concurrentPerform(iterations: 16) { _ in bridge.invalidate() }
        }
        bridge.publish(.sas("2"))
        await settle()

        XCTAssertEqual(digits(recorder.events), ["1"])
    }

    /// `invalidate` never calls the handler — not for the events it is dropping,
    /// and not as some final notification. A retired attempt has nothing left to
    /// say to a model it no longer owns.
    func testInvalidationNeverCallsTheHandler() async {
        let bridge = LinkSessionEventBridge()
        let recorder = Recorder()
        bridge.bind(to: recorder) { owner, event in owner.record(event) }
        bridge.publish(.sas("1"))
        bridge.publish(.sas("2"))

        bridge.invalidate()

        XCTAssertEqual(recorder.events, [], "not even the queue it just dropped")
        await settle()
        XCTAssertEqual(recorder.events, [])
    }

    // MARK: - 7. lifetime

    /// The consumer the bridge schedules must not keep the bridge alive: a
    /// runtime released while its last drain is still queued has to be able to
    /// go, and the orphaned task has to become a no-op rather than a crash.
    ///
    /// Deterministic because nothing here suspends between `publish` and the end
    /// of the scope, so the drain provably has not run when the last strong
    /// reference goes away.
    func testABridgeWithAScheduledDrainCanDeallocate() async {
        let owner = Recorder()
        weak var observed: LinkSessionEventBridge?
        do {
            let bridge = LinkSessionEventBridge()
            observed = bridge
            bridge.bind(to: owner) { owner, event in owner.record(event) }
            bridge.publish(.sas("1"))
            XCTAssertEqual(bridge.scheduledDrains, 1, "a drain is queued and has not run")
            XCTAssertNotNil(observed)
        }

        XCTAssertNil(observed, "the scheduled consumer must hold the bridge weakly")
        await settle()
        XCTAssertEqual(owner.events, [], "and a bridge that is gone delivers nothing")
    }

    /// The STANDARD binding — the handler reaches the owner only through the
    /// supplied parameter — does not retain it. Note what this test does NOT
    /// write: there is no `[weak recorder]` anywhere in it, because the wrapper
    /// `bind` stores captures the explicit owner weakly itself, which is the
    /// whole reason the owner is a parameter of the handler rather than
    /// something the handler closes over.
    ///
    /// This is a claim about this shape only. A handler that separately captured
    /// the same object strongly in its body would be retained like any other
    /// capture, and no test could show otherwise — Swift offers no way to forbid
    /// it, so what is pinned here is the shape callers are told to use.
    func testTheStandardBindingDoesNotRetainTheOwnerWithoutAWeakCapture() async {
        let bridge = LinkSessionEventBridge()
        weak var observed: Recorder?
        do {
            let recorder = Recorder()
            observed = recorder
            let arrived = arrival(of: recorder, at: 1, "the event arrives")
            bridge.bind(to: recorder) { owner, event in owner.record(event) }
            bridge.publish(.sas("1"))
            await fulfillment(of: [arrived], timeout: 5)
            XCTAssertEqual(recorder.events.count, 1)
        }

        XCTAssertNil(observed, "the stored wrapper holds the owner weakly")

        // Delivering into an owner that is gone is inert rather than a crash.
        // The bridge stays live and terminable: an owner that went away is not
        // itself retirement, and `invalidate` is still the thing that ends this.
        bridge.publish(.sas("2"))
        await settle()
        bridge.invalidate()
        await settle()
    }

    /// `invalidate` clears the handler, so whatever it captured is released
    /// then — not whenever the runtime that holds this bridge happens to die.
    func testInvalidationReleasesTheHandler() {
        let bridge = LinkSessionEventBridge()
        let recorder = Recorder()
        weak var observed: Canary?
        do {
            let canary = Canary()
            observed = canary
            bridge.bind(to: recorder) { owner, event in
                withExtendedLifetime(canary) {}
                owner.record(event)
            }
        }
        XCTAssertNotNil(observed, "the handler is held while the bridge is live")

        bridge.invalidate()

        XCTAssertNil(observed, "invalidate must clear the handler")
    }
}
