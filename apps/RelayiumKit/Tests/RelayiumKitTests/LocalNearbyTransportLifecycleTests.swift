import XCTest
@testable import RelayiumLocalPeerKit

final class LocalNearbyTransportLifecycleTests: XCTestCase {
    func testStartAndStopAreTerminalAndIdempotent() {
        var state = LocalPeerTransportLifecycle()
        XCTAssertEqual(state.start(), .arm)
        XCTAssertEqual(state.start(), .ignore)
        XCTAssertEqual(state.stop(), .tearDown)
        XCTAssertEqual(state.stop(), .ignore)
        XCTAssertEqual(state.start(), .ignore)
        XCTAssertFalse(state.isDeliveringEvents)
    }

    func testOpenIsAnnouncedOnceAfterBothHalvesAreReady() {
        var state = LocalPeerTransportLifecycle()
        XCTAssertEqual(state.start(), .arm)
        XCTAssertEqual(state.browserBecameReady(), .ignore)
        XCTAssertTrue(state.isDeliveringEvents)
        XCTAssertEqual(state.listenerBecameReady(), .announce)
        XCTAssertEqual(state.listenerBecameReady(), .ignore)
        XCTAssertEqual(state.browserBecameReady(), .ignore)
        XCTAssertEqual(state.phase, .running)
    }

    /// A listener/browser pair that never reaches `ready` and never fails —
    /// the shape of a refused Local Network permission or a link that is not up
    /// — must still end the start, or the roster searches forever.
    func testAnArmingWindowThatNeverResolvesFailsExactlyOnce() {
        var state = LocalPeerTransportLifecycle()
        XCTAssertEqual(state.start(), .arm)
        XCTAssertEqual(state.startDeadlineElapsed(), .announce)
        XCTAssertEqual(state.phase, .failed)
        XCTAssertEqual(state.startDeadlineElapsed(), .ignore)
        XCTAssertEqual(state.fail(), .ignore)
        XCTAssertFalse(state.isDeliveringEvents)
    }

    /// The timer is armed for one epoch and cannot overrule a later one.
    func testAStaleStartDeadlineCannotUnseatAReadyOrStoppedTransport() {
        var running = LocalPeerTransportLifecycle()
        XCTAssertEqual(running.start(), .arm)
        XCTAssertEqual(running.listenerBecameReady(), .ignore)
        XCTAssertEqual(running.browserBecameReady(), .announce)
        XCTAssertEqual(running.startDeadlineElapsed(), .ignore)
        XCTAssertEqual(running.phase, .running)
        XCTAssertTrue(running.isDeliveringEvents)

        var stopped = LocalPeerTransportLifecycle()
        XCTAssertEqual(stopped.start(), .arm)
        XCTAssertEqual(stopped.stop(), .tearDown)
        XCTAssertEqual(stopped.startDeadlineElapsed(), .ignore)
        XCTAssertEqual(stopped.phase, .stopped)

        var failed = LocalPeerTransportLifecycle()
        XCTAssertEqual(failed.start(), .arm)
        XCTAssertEqual(failed.fail(), .announce)
        XCTAssertEqual(failed.startDeadlineElapsed(), .ignore)
    }

    func testFailureIsOneShotAndCancellationAfterStopIsSilent() {
        var active = LocalPeerTransportLifecycle()
        XCTAssertEqual(active.start(), .arm)
        XCTAssertEqual(active.fail(), .announce)
        XCTAssertEqual(active.fail(), .ignore)

        var stopped = LocalPeerTransportLifecycle()
        XCTAssertEqual(stopped.start(), .arm)
        XCTAssertEqual(stopped.stop(), .tearDown)
        XCTAssertEqual(stopped.fail(), .ignore)
    }
}
