import XCTest
@testable import RelayiumKit

/// The few `link/1` transport invariants that live inside the WebRTC layer
/// itself, where no object can be injected.
///
/// This file has deliberately shrunk. What used to be asserted here as source
/// strings — the queue's re-entrancy rules, candidate ordering, the deadlines —
/// is now decided by `LinkTransportQueue`, `LinkCandidateGate` and
/// `LinkEstablishmentWatchdog` and tested as behaviour, and the driver's own
/// failure and teardown ordering is exercised against the real class in
/// `WebRTCLinkTransportTests`. What is left is what genuinely cannot be
/// observed without two negotiating endpoints: what this driver asks
/// `RTCPeerConnection` for, in what order, and which generation its outbound
/// signals carry. A source guard is an honest second-best for those — it pins
/// the decision so a later edit has to be deliberate. It is NOT evidence that
/// the wire works: no native↔native or native↔Web run has been made against
/// this driver.
final class WebRTCLinkTransportSourceTests: XCTestCase {

    private func source() throws -> String {
        try RepoRoot.text(
            "apps/RelayiumKit/Sources/RelayiumKit/Realtime/WebRTCLinkTransport.swift")
    }

    /// The source with every comment removed.
    ///
    /// The guards below are about what the driver DOES, and this file explains
    /// its own reasoning at length — including, necessarily, the names of the
    /// things it deliberately does not set. Counting those explanations as code
    /// would make the guard fire on its own rationale, which is the fastest way
    /// to teach the next reader to delete it.
    private func code() throws -> String {
        try source()
            .components(separatedBy: "\n")
            .map { line -> String in
                guard let marker = line.range(of: "//") else { return line }
                return String(line[line.startIndex..<marker.lowerBound])
            }
            .joined(separator: "\n")
    }

    private func occurrences(of needle: String, in haystack: String) -> Int {
        haystack.components(separatedBy: needle).count - 1
    }

    // MARK: - two lanes, opened before the offer

    /// One negotiation must carry both lanes. Opening the text lane after the
    /// offer would ask the responder to expect a second round of DCEP it has no
    /// reason to wait for, and the publication barrier would never lift.
    func testBothLanesAreCreatedFromTheExactLabelListBeforeTheOfferIsMade() throws {
        let source = try self.code()
        XCTAssertFalse(source.isEmpty, "the driver source must be readable")
        XCTAssertTrue(source.contains("for label in LINK_CHANNEL_LABELS"),
                      "the lane list is the one constant, never a local literal")
        XCTAssertEqual(occurrences(of: "dataChannel(forLabel:", in: source), 1,
                       "exactly one creation site, driven by the label list")

        let created = try XCTUnwrap(source.range(of: "dataChannel(forLabel:"))
        let offered = try XCTUnwrap(source.range(of: "pc.offer(for:"))
        XCTAssertTrue(created.lowerBound < offered.lowerBound,
                      "both channels must exist before the offer is created")
    }

    /// Reliable and ordered. An AEAD sequence cannot tolerate a hole, and
    /// leaving `maxRetransmits`/`maxPacketLifeTime` unset is what makes the
    /// channel reliable — setting either turns it partial.
    func testLanesAreOrderedAndReliable() throws {
        let source = try self.code()
        XCTAssertTrue(source.contains("config.isOrdered = true"))
        XCTAssertFalse(source.contains("maxRetransmits"))
        XCTAssertFalse(source.contains("maxPacketLifeTime"))
    }

    // MARK: - only ever the link generation

    /// Every outbound signal this transport emits is tagged `link`, and its two
    /// SDP signals confirm exact `link/1`. An untagged one would be read by a
    /// deployed peer as a legacy file transfer.
    func testEveryOutboundSignalIsOnTheLinkGenerationWithExactCapability() throws {
        let source = try self.code()
        XCTAssertEqual(occurrences(of: "caps: [LINK_CAPABILITY]", in: source), 2,
                       "the offer and the answer, and nothing else, confirm the capability")
        XCTAssertTrue(source.contains("generation: .link"))
        for foreign in ["generation: .file", "generation: .text", "generation: .resume"] {
            XCTAssertFalse(source.contains(foreign), "\(foreign) is not this transport's")
        }
        XCTAssertFalse(source.contains("sdpSignal(kind:"),
                       "SDP goes out through linkSDPSignal, never the untagged builder")
    }

    // MARK: - the signalling slot

    /// Two connections overlap on one socket routinely. A closing older one
    /// must not be able to erase a NEWER one's handler, or the new session waits
    /// forever for an answer nobody routes to it.
    func testTheSignallingSlotIsClaimedAndReleasedByToken() throws {
        let source = try self.code()
        XCTAssertTrue(source.contains("signaling.installSignalHandler"))
        XCTAssertTrue(source.contains("signaling.removeSignalHandler(signalToken)"))
        XCTAssertFalse(source.contains("signaling.onSignal ="),
                       "the bare slot cannot express 'clear it only if it is still mine'")
    }

    // MARK: - candidate ordering

    /// Every candidate in either direction goes through its gate. A second path
    /// around either one would restore exactly the race the gates exist for,
    /// and no unit test above this file could see it.
    func testEveryCandidateGoesThroughItsGate() throws {
        let source = try self.code()
        XCTAssertEqual(occurrences(of: "sendCandidateLocked(", in: source), 3,
                       "one sender, called from the gate's two outcomes and the flush")
        XCTAssertEqual(occurrences(of: "localCandidates.admit(", in: source), 1)
        XCTAssertEqual(occurrences(of: "remoteCandidates.admit(", in: source), 1)
        XCTAssertEqual(occurrences(of: "pc.add(", in: source), 1,
                       "the only way a remote candidate reaches the PeerConnection")
        XCTAssertEqual(occurrences(of: "iceSignal(", in: source), 1,
                       "and the only way a local one reaches the wire")
    }

    /// Both roles, and only after the description they belong to is actually on
    /// the wire.
    func testBothRolesOpenTheLocalGateOnlyAfterSendingTheirDescription() throws {
        let source = try self.code()
        XCTAssertEqual(occurrences(of: "localDescriptionSentLocked()", in: source), 3,
                       "the offer path, the answer path, and the definition")
        for kind in ["offer", "answer"] {
            let sent = try XCTUnwrap(source.range(of: "linkSDPSignal(kind: \"\(kind)\""))
            let opened = try XCTUnwrap(source.range(of: "localDescriptionSentLocked()",
                                                    range: sent.upperBound..<source.endIndex))
            let between = source[sent.upperBound..<opened.lowerBound]
            XCTAssertFalse(between.contains("linkSDPSignal"),
                           "the \(kind) opens the gate before anything else happens")
        }
    }

    // MARK: - one terminal path

    /// Closed state and teardown before any client callback. A second place
    /// that set `closed` or called `onError`/`onClose` would be a second
    /// terminal path, and the ordering guarantee is exactly what cannot survive
    /// two of them.
    func testThereIsOneTerminalPathAndItClosesBeforeItCallsBack() throws {
        let source = try self.code()
        XCTAssertEqual(occurrences(of: "closed = true", in: source), 1)
        XCTAssertEqual(occurrences(of: "onError?(", in: source), 1)
        XCTAssertEqual(occurrences(of: "onClose?(", in: source), 1)

        let terminal = try XCTUnwrap(source.range(of: "private func terminateLocked"))
        let tail = String(source[terminal.upperBound...])
        let closedAt = try XCTUnwrap(tail.range(of: "closed = true"))
        let tornDownAt = try XCTUnwrap(tail.range(of: "teardownLocked()"))
        let erroredAt = try XCTUnwrap(tail.range(of: "onError?("))
        let closedCallbackAt = try XCTUnwrap(tail.range(of: "onClose?("))
        XCTAssertTrue(closedAt.lowerBound < tornDownAt.lowerBound)
        XCTAssertTrue(tornDownAt.lowerBound < erroredAt.lowerBound)
        XCTAssertTrue(erroredAt.lowerBound < closedCallbackAt.lowerBound)
    }

    /// Teardown drops the references a closed transport must not keep: the
    /// PeerConnection, the signalling token, and — through `LinkEstablishment`
    /// — the identity holding the link's session keys.
    func testTeardownClearsWhatAClosedTransportMustNotHold() throws {
        let source = try self.code()
        XCTAssertTrue(source.contains("pc = nil"))
        XCTAssertTrue(source.contains("self.signalToken = nil"))
        XCTAssertTrue(source.contains("establishment.close()"))
        XCTAssertTrue(source.contains("for channel in delegatedChannels"),
                      "including every channel a delegate was ever set on")
    }

    // MARK: - the deadline boundary

    /// Establishment is complete at the BARRIER, not when client code returns.
    ///
    /// The old shape disarmed after `LinkEstablishment.publish` had already run
    /// `onReady` and replayed the backlog, on the reasoning that no time can
    /// pass on a serial queue. That reasoning is false in the one direction
    /// that matters: the queue is occupied by the client's own callback, which
    /// may take as long as it likes, and the deadline it is racing is a wall
    /// clock. A consumer that spends a second building its lane consumers would
    /// have its finished, authenticated link torn down underneath it.
    func testTheWatchdogIsDisarmedAtTheBarrierNotAfterTheClientCallbacks() throws {
        let source = try self.code()
        let applied = try XCTUnwrap(source.range(of: "private func apply(_ step:"))
        let tail = String(source[applied.upperBound...])
        let end = try XCTUnwrap(tail.range(of: "\n    }"))
        let body = String(tail[tail.startIndex..<end.lowerBound])

        let disarmed = try XCTUnwrap(body.range(of: "disarmWatchdogLocked()"),
                                     "the barrier itself must disarm")
        let published = try XCTUnwrap(body.range(of: "publishLocked()"))
        XCTAssertTrue(disarmed.lowerBound < published.lowerBound,
                      "and it must do so before any client callback can run")

        let publish = try XCTUnwrap(source.range(of: "private func publishLocked()"))
        let publishTail = String(source[publish.upperBound...])
        let publishEnd = try XCTUnwrap(publishTail.range(of: "\n    }"))
        XCTAssertFalse(String(publishTail[publishTail.startIndex..<publishEnd.lowerBound])
                        .contains("disarmWatchdogLocked"),
                       "publication must not be the thing that decides it")
        XCTAssertEqual(occurrences(of: "publishLocked()", in: source), 2,
                       "one definition and one call site, so the barrier is the only way in")
    }

    /// Both halves of producing a description are asynchronous, and both
    /// completions come back on the queue the wake-up was waiting for. Each one
    /// must re-read the boundary before it continues setup: the first before it
    /// applies a local description, the second before that description leaves
    /// and its candidate gate opens.
    ///
    /// A source guard for the ORDER, because the window it protects is inside
    /// libwebrtc and cannot be interleaved from outside. That the guards
    /// actually stop an expired offer and an expired answer from reaching the
    /// wire is exercised against the real driver in `WebRTCLinkTransportTests`.
    func testEveryDescriptionCompletionChecksTheDeadlineBeforeContinuingSetup() throws {
        let source = try self.code()
        for (produce, kind) in [("pc.offer(for:", "offer"), ("pc.answer(for:", "answer")] {
            let produced = try XCTUnwrap(source.range(of: produce),
                                         "the \(kind) path must exist")
            let tail = String(source[produced.upperBound...])

            let setLocal = try XCTUnwrap(tail.range(of: "pc.setLocalDescription("))
            let onCreated = try XCTUnwrap(tail.range(of: "expiredLocked("),
                                          "the \(kind) completion must re-read the boundary")
            XCTAssertTrue(onCreated.lowerBound < setLocal.lowerBound,
                          "an expired establishment applies no local \(kind)")

            let sent = try XCTUnwrap(tail.range(of: "linkSDPSignal(kind: \"\(kind)\""))
            let onApplied = try XCTUnwrap(tail.range(of: "expiredLocked(",
                                                     range: setLocal.upperBound..<tail.endIndex),
                                          "the setLocalDescription completion must too")
            XCTAssertTrue(onApplied.lowerBound < sent.lowerBound,
                          "and an expired one puts no \(kind) on the wire")
        }
    }

    /// Every place the queue is handed back after an unbounded wait re-reads the
    /// clock — including the return of a client callback, which is the one the
    /// wake-up can never pre-empt because that callback is holding the queue.
    /// `onSAS` is the costly one: past it lies this side's own key disclosure
    /// and the publication that disarms the watchdog.
    func testTheRevealPathRechecksTheBoundaryAfterTheClientCallbackReturns() throws {
        let source = try self.code()
        let verified = try XCTUnwrap(source.range(of: "private func verifyRevealLocked"))
        let tail = String(source[verified.upperBound...])
        let end = try XCTUnwrap(tail.range(of: "\n    }"))
        let body = String(tail[tail.startIndex..<end.lowerBound])

        let sas = try XCTUnwrap(body.range(of: "onSAS?("))
        let rechecked = try XCTUnwrap(body.range(of: "expiredLocked(",
                                                 range: sas.upperBound..<body.endIndex),
                                      "the clock must be re-read after the callback returns")
        let revealed = try XCTUnwrap(body.range(of: "sendRevealLocked()"))
        let applied = try XCTUnwrap(body.range(of: "apply(step)"))
        XCTAssertTrue(rechecked.lowerBound < revealed.lowerBound,
                      "before this side discloses its own key")
        XCTAssertTrue(rechecked.lowerBound < applied.lowerBound,
                      "and before the step that would disarm the watchdog it outlived")
    }

    /// Only this establishment's own work may start this establishment's clock.
    /// Arming before the policy has filtered the signal put every transport in
    /// the room on a deadline started by traffic between two other peers.
    func testTheDeadlineIsArmedOnlyAfterThePolicyHasAcceptedTheSignal() throws {
        let source = try self.code()
        let handled = try XCTUnwrap(source.range(of: "private func handleLocked"))
        let tail = String(source[handled.upperBound...])
        let end = try XCTUnwrap(tail.range(of: "\n    }"))
        let body = String(tail[tail.startIndex..<end.lowerBound])

        let planned = try XCTUnwrap(body.range(of: "policy.plan("))
        let armed = try XCTUnwrap(body.range(of: "armWatchdogLocked("))
        XCTAssertTrue(planned.lowerBound < armed.lowerBound,
                      "the plan decides whether this signal is ours at all")
        XCTAssertEqual(occurrences(of: "policy.plan(", in: source), 1,
                       "and it is computed once, not once to arm and once to act")
    }

    // MARK: - queue discipline

    /// The queue's re-entrancy rules belong to `LinkTransportQueue`, which is
    /// unit-tested. This driver must not grow a second, unguarded answer to the
    /// same question.
    func testTheDriverOwnsNoRawQueue() throws {
        let source = try self.code()
        XCTAssertFalse(source.contains("DispatchQueue("),
                       "the queue is LinkTransportQueue's, guards included")
        XCTAssertFalse(source.contains("queue.sync("),
                       "the guarded helper is the only synchronous entry")
        XCTAssertTrue(source.contains("queue.nowOrLater"),
                      "close must be inline from a callback and asynchronous from outside")
    }

    /// `queue.async { [weak self] … }` forms a new weak reference, which traps
    /// on an `NSObject` subclass mid-deallocation; `queue.sync` deadlocks if the
    /// last release happened on the queue itself.
    func testDeinitNeverTouchesTheQueue() throws {
        let source = try self.code()
        let opened = try XCTUnwrap(source.range(of: "    deinit {"))
        let tail = String(source[opened.upperBound...])
        // Up to the member's own closing brace — the first one at member indent.
        let closed = try XCTUnwrap(tail.range(of: "\n    }"))
        let body = String(tail[tail.startIndex..<closed.lowerBound])
        XCTAssertFalse(body.contains("queue."), "deinit must tear down directly")
        XCTAssertTrue(body.contains("teardownLocked()"),
                      "and through the one teardown path, so nothing is forgotten")

        // …which is only safe because teardown itself touches no queue.
        let teardown = try XCTUnwrap(source.range(of: "private func teardownLocked"))
        let teardownTail = String(source[teardown.upperBound...])
        let teardownEnd = try XCTUnwrap(teardownTail.range(of: "\n    }"))
        XCTAssertFalse(String(teardownTail[teardownTail.startIndex..<teardownEnd.lowerBound])
                        .contains("queue."))
    }
}
