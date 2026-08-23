import Combine
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

// MARK: - what a view would be watching
//
// Every positive delivery here is observed through the model's own `@Published`
// projection rather than by reading `phase` after a guessed number of turns:
// that is the thing a SwiftUI view subscribes to, so a model that assigned the
// right value without publishing it would be a screen that never repaints, and
// this recorder is what makes that a failure rather than a silence.
//
// It is lock-guarded and NOT `@MainActor` on purpose. The whole point of one of
// these tests is that deliveries land on the main actor; a recorder that could
// only be touched there would assume the property it is supposed to prove, and
// an implementation that published off the main thread would trip the
// thread-sanitizer run instead of failing an assertion with a readable message.

private final class PhaseLog: @unchecked Sendable {
    private let lock = NSLock()
    private var _phases: [LinkSessionConnectionPhase] = []
    private var _alwaysOnMainThread = true
    private var expected = Int.max
    private var arrival: XCTestExpectation?
    private var subscription: AnyCancellable?

    /// Note that `$phase` replays the current value on subscription, so the
    /// first entry is always the phase the model was in when this log attached.
    ///
    /// Only the subscribing is `@MainActor` — reaching a main-actor model's
    /// projected value has to be. Everything the subscription then delivers goes
    /// through `record`, which is not isolated at all, precisely so an
    /// implementation that published off the main actor could reach it and be
    /// caught rather than be rejected at compile time.
    @MainActor
    init(_ model: LinkSessionPresentationModel) {
        subscription = model.$phase.sink { [weak self] phase in
            self?.record(phase)
        }
    }

    private func record(_ phase: LinkSessionConnectionPhase) {
        lock.lock()
        _alwaysOnMainThread = _alwaysOnMainThread && Thread.isMainThread
        _phases.append(phase)
        let reached = _phases.count == expected
        let arrived = arrival
        lock.unlock()

        if reached { arrived?.fulfill() }
    }

    var phases: [LinkSessionConnectionPhase] {
        lock.lock(); defer { lock.unlock() }; return _phases
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
        let already = _phases.count >= count
        lock.unlock()

        if already { waited.fulfill() }
        return waited
    }

    /// Drop the subscription, for the lifetime test: nothing may be left holding
    /// anything of the model's when it checks whether the model went away.
    func detach() { subscription = nil }
}

@MainActor
final class LinkSessionPresentationModelTests: XCTestCase {

    // MARK: - helpers

    /// Let every main-actor consumer that is already scheduled run, for the
    /// checks that assert something does NOT arrive.
    ///
    /// Not a sleep: `Task.yield()` puts this test behind whatever was enqueued
    /// before it on the main actor, and the bridge's drain runs to completion
    /// with no suspension of its own — so one turn is enough for one hop, and
    /// the extra turns cover a drain that schedules another. Bounded on purpose:
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

    // MARK: - 1. what a screen opens as

    /// Before anything has been published there is no SAS, no peer, and nothing
    /// to compare — and the phase says exactly that rather than a stand-in for
    /// it. This is the state a view is built in, so it is pinned literally.
    func testTheInitialPhaseIsEstablishingWithNoSas() {
        let (_, model) = rig()

        XCTAssertEqual(model.phase, .establishing(sas: nil))
        XCTAssertNil(model.sas)
        XCTAssertNil(model.peerId)
        XCTAssertFalse(model.isOpen)
        XCTAssertFalse(model.isEnded)
    }

    /// The factory-time case the bridge exists for: something published before
    /// this model was constructed, let alone bound. Nothing may be lost — and
    /// nothing may arrive inline from the initializer, which would repaint a
    /// model in the middle of its own construction.
    func testASasPublishedBeforeTheModelExistsIsStillPainted() async {
        let bridge = LinkSessionEventBridge()
        bridge.publish(.sas("123456"))

        let model = bound(to: bridge)
        XCTAssertEqual(model.phase, .establishing(sas: nil),
                       "binding must not deliver inline")

        let log = PhaseLog(model)
        let arrived = log.expect(2, "the buffered SAS arrives", in: self)
        await fulfillment(of: [arrived], timeout: 5)

        XCTAssertEqual(model.phase, .establishing(sas: "123456"))
        XCTAssertEqual(model.sas, "123456")
        XCTAssertNil(model.peerId)
        XCTAssertFalse(model.isOpen)
    }

    // MARK: - 2. opening

    /// The ordinary path: digits first, then the link they authenticated.
    func testOpenedAfterASasCarriesThePeerAndTheDigits() async {
        let (bridge, model) = rig()
        let log = PhaseLog(model)
        let arrived = log.expect(3, "establishing, then open", in: self)

        bridge.publish(.sas("123456"))
        bridge.publish(.opened(peerId: "peer-a", sas: "123456"))
        await fulfillment(of: [arrived], timeout: 5)

        XCTAssertEqual(model.phase, .open(peerId: "peer-a", sas: "123456"))
        XCTAssertEqual(model.sas, "123456")
        XCTAssertEqual(model.peerId, "peer-a")
        XCTAssertTrue(model.isOpen)
        XCTAssertFalse(model.isEnded)
    }

    /// And with no SAS ever published. `opened` carries its own digits, so a
    /// model that only reached `open` by way of a previous `sas` would leave a
    /// screen stuck on "establishing" for a link that is already open.
    func testOpenedWithoutAnyPriorSasStillOpens() async {
        let (bridge, model) = rig()
        let log = PhaseLog(model)
        let arrived = log.expect(2, "open arrives on its own", in: self)

        bridge.publish(.opened(peerId: "peer-b", sas: "654321"))
        await fulfillment(of: [arrived], timeout: 5)

        XCTAssertEqual(model.phase, .open(peerId: "peer-b", sas: "654321"))
        XCTAssertEqual(model.sas, "654321")
        XCTAssertEqual(model.peerId, "peer-b")
    }

    /// A `sas` behind an `opened` must not drag an open link back to
    /// establishing. The runtime does not promise it cannot happen, and the
    /// visible cost of getting it wrong is a screen that closes itself.
    func testASasAfterOpenedDoesNotRegressThePhase() async {
        let (bridge, model) = rig()
        let log = PhaseLog(model)
        let opened = log.expect(2, "the link opens", in: self)

        bridge.publish(.opened(peerId: "peer-c", sas: "111111"))
        await fulfillment(of: [opened], timeout: 5)

        bridge.publish(.sas("999999"))
        await settle()

        XCTAssertEqual(model.phase, .open(peerId: "peer-c", sas: "111111"),
                       "an open link stays open, with the digits it opened on")
        XCTAssertEqual(log.phases.count, 2, "and nothing repainted")
    }

    // MARK: - 3. the hop

    /// The runtime delivers on whichever thread is draining. This model is
    /// `@MainActor`, and what a view needs is that every publication it sees
    /// happens there — including for an event produced off the main thread.
    func testDeliveryFromABackgroundPublisherLandsOnTheMainActor() async {
        let (bridge, model) = rig()
        let log = PhaseLog(model)
        let arrived = log.expect(3, "both events arrive", in: self)

        await offMain {
            bridge.publish(.sas("246810"))
            bridge.publish(.opened(peerId: "peer-d", sas: "246810"))
        }
        await fulfillment(of: [arrived], timeout: 5)

        XCTAssertTrue(log.alwaysOnMainThread, "every publication must be on the main thread")
        XCTAssertEqual(model.phase, .open(peerId: "peer-d", sas: "246810"))
    }

    // MARK: - 4. the end

    /// Every reason, from every phase this slice can be in, and each one is
    /// terminal. Enumerated rather than sampled: a later case added to
    /// `LinkSessionRuntimeEnd` that this projection dropped would be a session
    /// that never visibly ends.
    func testEveryEndReasonEndsTheModel() async {
        let ends: [LinkSessionRuntimeEnd] = [.stopped, .establishmentFailed,
                                             .establishmentClosed, .linkEnded, .wiringFailed]
        for end in ends {
            let (bridge, model) = rig()
            let log = PhaseLog(model)
            let arrived = log.expect(2, "\(end) arrives", in: self)

            bridge.publish(.ended(end))
            await fulfillment(of: [arrived], timeout: 5)

            XCTAssertEqual(model.phase, .ended(end))
            XCTAssertTrue(model.isEnded)
            XCTAssertFalse(model.isOpen)
            XCTAssertNil(model.sas, "\(end): a session that is over has nothing to compare")
            XCTAssertNil(model.peerId)
        }
    }

    /// An open link that ends, and then keeps talking. The runtime says `ended`
    /// is its last event and the bridge drops what it is holding, so this is
    /// defence in depth — and it is cheap defence against the one bug that would
    /// reopen a session on a screen that had already been dismissed.
    func testNothingRepaintsAfterTheEnd() async {
        let (bridge, model) = rig()
        let log = PhaseLog(model)
        let arrived = log.expect(3, "the link opens and then ends", in: self)

        bridge.publish(.opened(peerId: "peer-e", sas: "121212"))
        bridge.publish(.ended(.linkEnded))
        await fulfillment(of: [arrived], timeout: 5)

        bridge.publish(.sas("343434"))
        bridge.publish(.opened(peerId: "peer-f", sas: "343434"))
        bridge.publish(.ended(.stopped))
        bridge.publish(.text(.received("hi")))
        await settle()

        XCTAssertEqual(model.phase, .ended(.linkEnded), "the first end is the one that stands")
        XCTAssertEqual(log.phases.count, 3, "and nothing after it repainted")
    }

    // MARK: - 5. the lanes this slice does not project

    /// `text`, `file` and `received` belong to later presentation slices. Until
    /// one exists they must be inert here rather than half-projected into a
    /// connection phase that has no room for them.
    func testLaneAndReceivedEventsDoNotTouchTheConnectionPhase() async {
        let (bridge, model) = rig()
        let log = PhaseLog(model)

        let lane: [LinkSessionRuntimeEvent] = [
            .text(.received("hello")),
            .text(.status(.open)),
            .file(.inboundProgress(batch: 1, durableBytes: 8)),
            .file(.outboundFinished(batch: 1, ok: true)),
            .received(LinkReceivedBatch(batch: 1, files: [], container: nil)),
        ]

        for event in lane { bridge.publish(event) }
        await settle()
        XCTAssertEqual(model.phase, .establishing(sas: nil), "not while establishing")

        let opened = log.expect(2, "the link opens", in: self)
        bridge.publish(.opened(peerId: "peer-g", sas: "565656"))
        await fulfillment(of: [opened], timeout: 5)

        for event in lane { bridge.publish(event) }
        await settle()

        XCTAssertEqual(model.phase, .open(peerId: "peer-g", sas: "565656"), "and not while open")
        XCTAssertEqual(log.phases.count, 2, "no lane event may repaint the connection")
    }

    // MARK: - 6. order

    /// The bridge decides the order and this model must not re-decide it. What
    /// is pinned is the whole visible sequence, not just where it lands.
    func testThePhasesFollowThePublishedOrder() async {
        let (bridge, model) = rig()
        let log = PhaseLog(model)
        let arrived = log.expect(4, "the whole sequence arrives", in: self)

        bridge.publish(.sas("777777"))
        bridge.publish(.opened(peerId: "peer-h", sas: "777777"))
        bridge.publish(.text(.received("ignored")))
        bridge.publish(.ended(.stopped))
        await fulfillment(of: [arrived], timeout: 5)
        await settle()

        XCTAssertEqual(log.phases, [.establishing(sas: nil),
                                    .establishing(sas: "777777"),
                                    .open(peerId: "peer-h", sas: "777777"),
                                    .ended(.stopped)])
    }

    // MARK: - 7. lifetime

    /// The model binds with the bridge's structural weak-owner API, so a runtime
    /// that outlives the screen it was painting cannot keep that screen alive.
    /// The handler reaches the model only through the supplied `owner`
    /// parameter — there is no `[weak self]` written in the production
    /// initializer, and there must not need to be.
    func testTheBridgeDoesNotRetainTheModel() async {
        let bridge = LinkSessionEventBridge()
        weak var observed: LinkSessionPresentationModel?
        do {
            let model = bound(to: bridge)
            observed = model
            let log = PhaseLog(model)
            let arrived = log.expect(2, "the model is live and painting", in: self)
            bridge.publish(.opened(peerId: "peer-i", sas: "808080"))
            await fulfillment(of: [arrived], timeout: 5)
            XCTAssertTrue(model.isOpen)
            log.detach()
        }

        XCTAssertNil(observed, "the bridge holds the model weakly")

        // And delivering into a model that has gone is inert rather than a
        // crash. The bridge stays live and terminable: a screen that went away
        // is not itself retirement, which belongs to whoever owns the attempt.
        bridge.publish(.ended(.stopped))
        await settle()
        bridge.invalidate()
        await settle()
    }

    /// The model does not end the attempt on its way out. Retirement is the
    /// owner's — an `invalidate` from `deinit` would be actor-isolated cleanup
    /// run on whichever thread happened to release the last reference.
    ///
    /// Observable through `scheduledDrains`: an invalidated bridge refuses a
    /// publish outright and schedules nothing, while a live one still admits it
    /// and wakes its consumer, which then finds an owner that has gone.
    func testTheModelDoesNotInvalidateTheBridgeWhenItGoesAway() async {
        let bridge = LinkSessionEventBridge()
        do {
            let model = bound(to: bridge)
            XCTAssertFalse(model.isEnded)
        }
        await settle()

        let before = bridge.scheduledDrains
        bridge.publish(.ended(.stopped))
        XCTAssertEqual(bridge.scheduledDrains, before + 1,
                       "a bridge the model did not invalidate still admits events")
        await settle()
    }

    // MARK: - 8. nothing here is reachable from production

    /// Comments stripped, so a rule about code is not satisfied — or broken — by
    /// prose.
    private func code(_ source: String) -> String {
        source
            .components(separatedBy: "\n")
            .map { line -> String in
                guard let marker = line.range(of: "//") else { return line }
                return String(line[line.startIndex..<marker.lowerBound])
            }
            .joined(separator: "\n")
    }

    /// `apps/`, discovered rather than counted, and checked for existing.
    private var appsRoot: URL {
        get throws { try RepoRoot.apps() }
    }

    /// Nothing but its ONE owner — `LinkSessionAttempt` — constructs one. The
    /// macOS production Workspace reaches that attempt without adding a second
    /// lifetime for this projection.
    ///
    /// The exclusion is the invariant, not a concession to it: a second builder
    /// would be a second lifetime for one screen — two objects able to retire, or
    /// to fail to retire, the same attempt.
    func testTheModelKeepsOneConstructionPath() throws {
        // `LINK_BUILD_SUPPORT` is deliberately NOT asserted here. This suite's
        // subject is not the flag, and its value is per platform: a claim about
        // it in nineteen unrelated files is nineteen places to get the iOS
        // branch wrong. `PeerCapabilityRegistryTests` owns that contract, value
        // and source both.
        XCTAssertFalse(LINK_TRANSPORT_REPLACEMENT_SUPPORTED)

        // Each root must exist. `RepoRoot.directory` throws with the path it
        // wanted, where a missing root used to be skipped one line below and the
        // scan then reported clean over nothing.
        let roots = try ["apps/RelayiumKit/Sources", "apps/ios", "apps/mac"]
            .map { try RepoRoot.directory($0) }
        var scanned = 0
        // The files this guard is ABOUT, excluded from its own scan.
        let owners = ["LinkSessionPresentationModel.swift", "LinkSessionAttempt.swift"]
        for root in roots {
            for file in try RepoRoot.swiftFiles(in: root)
            where !owners.contains(file.lastPathComponent) {
                scanned += 1
                let text = code(try RepoRoot.text(of: file))
                XCTAssertFalse(text.contains("LinkSessionPresentationModel("),
                               "\(file.lastPathComponent) constructs a link presentation model")
            }
        }
        XCTAssertGreaterThan(scanned, 50, "the scan really reached the app sources")
    }

    /// The model claims no part of the stream's lifetime: it does not bind, does
    /// not hold a bridge, and does not end the attempt it paints. Pinned as
    /// source as well as behaviour — all three are edits a later slice could make
    /// while every behavioural test above still passed.
    ///
    /// **Not binding is the load-bearing one.** A bridge is bound ONCE, by the
    /// attempt, which fans each event out to both projections; a model that bound
    /// for itself would be a second claimant to that one binding, and the loser
    /// would silently paint nothing at all.
    func testTheModelNeitherBindsTheStreamNorRetiresTheAttempt() throws {
        let url = try appsRoot
            .appendingPathComponent("RelayiumKit/Sources/RelayiumAppKit/LinkSessionPresentationModel.swift")
        let source = code(try String(contentsOf: url, encoding: .utf8))
        XCTAssertFalse(source.isEmpty, "the model source must be readable")

        XCTAssertFalse(source.contains("bind(to:"),
                       "one bridge is bound once, by the attempt")
        XCTAssertFalse(source.contains("LinkSessionEventBridge"),
                       "and this model does not hold one")
        XCTAssertFalse(source.contains("deinit"),
                       "retiring the attempt belongs to the owner, not to a deallocation")
        XCTAssertFalse(source.contains("invalidate("),
                       "this model does not end the attempt it paints")
    }
}
