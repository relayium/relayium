import XCTest
@testable import RelayiumKit

/// The few authenticated-replacement invariants that live inside the WebRTC
/// layer itself, where no object can be injected.
///
/// Everything decidable without a live peer is decided by `LinkResumePolicy`,
/// `LinkEstablishment`, `LinkCandidateGate`, `LinkDeadlineClock` and
/// `LinkTransportQueue`, and tested as behaviour. What is left is what genuinely
/// cannot be observed without two negotiating endpoints: what this driver asks
/// `RTCPeerConnection` for, in what order, and which generation its outbound
/// signals carry — plus the negative properties that matter most here, because
/// "it never constructs a key" is a claim about code that does not exist and no
/// runtime assertion can see the absence of a call.
///
/// A source guard is an honest second-best: it pins a decision so a later edit
/// has to be deliberate. It is NOT evidence that the wire works.
final class WebRTCLinkReplacementTransportSourceTests: XCTestCase {

    private var source: String {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // RelayiumKitTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // RelayiumKit
        let file = packageRoot.appendingPathComponent(
            "Sources/RelayiumKit/Realtime/WebRTCLinkReplacementTransport.swift")
        return (try? String(contentsOf: file, encoding: .utf8)) ?? ""
    }

    /// The source with every comment removed. The guards below are about what
    /// the driver DOES, and this file explains its own reasoning at length —
    /// including, necessarily, the names of the things it deliberately does not
    /// do. Counting those explanations as code would make the guard fire on its
    /// own rationale.
    private var code: String {
        source
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

    // MARK: - it constructs no cryptography

    /// The invariant this whole driver exists under: a replacement is handed one
    /// already-authenticated identity and constructs nothing that could produce
    /// a second one.
    ///
    /// A `LinkCodecs` built here would be a second AEAD sequence counting from
    /// zero under keys that have already been used — catastrophic for the file
    /// lane's AES-GCM — and a `HandshakeState` would be this transport
    /// negotiating trust it was given. Absence is not observable at runtime, so
    /// it is pinned here.
    func testTheDriverConstructsNoKeysCodecsOrHandshake() {
        let source = self.code
        XCTAssertFalse(source.isEmpty, "the driver source must be readable")
        for forbidden in ["HandshakeState", "LinkCodecs(", "generateKeyPair(", "deriveSession(",
                          "deriveResumeAuth(", "deriveTextKey(", "randomNonce(", "commitKey("] {
            XCTAssertFalse(source.contains(forbidden),
                           "\(forbidden) has no place in a transport-only replacement")
        }
    }

    /// No commit, no reveal, no SAS, no capability announcement. Each one would
    /// be a field on the wire that the deployed web `connectResumeLink` path
    /// does not send, and each one describes a trust step this transport did not
    /// perform. The SAS in particular: announcing it again would tell a user to
    /// re-verify an authentication that never changed.
    func testTheDriverEmitsNoCommitRevealSASOrCapability() {
        let source = self.code
        for forbidden in ["revealField(", "commitField(", "peerReveal(", "peerCommit(",
                          "recordPeerCommit(", "selfCommitBase64", "onSAS", ".sas",
                          "LINK_CAPABILITY", "caps:"] {
            XCTAssertFalse(source.contains(forbidden),
                           "\(forbidden) belongs to establishment, not to a rebuild")
        }
    }

    /// The inherited identity is handed to `LinkEstablishment` at construction,
    /// and there is exactly one construction site.
    ///
    /// This is the batch's central invariant and the one a unit test cannot
    /// reach: publication needs two OPEN `RTCDataChannel`s, which needs two
    /// negotiating endpoints, so "the transport this driver publishes carries
    /// the same `LinkCodecs`" is only observable from a live run. What IS
    /// observable is that the establishment was built `resuming:` that identity
    /// — and `LinkReplacementIdentityTests` then proves that such an
    /// establishment publishes the identity it was given, refuses a second one,
    /// and replays its backlog under the same codecs.
    ///
    /// An establishment built without it would look identical from outside and
    /// would simply never publish, because a rebuild verifies no reveal and so
    /// nothing would ever supply the identity the barrier waits for.
    func testTheEstablishmentIsBuiltUnderTheInheritedIdentity() {
        let source = self.code
        XCTAssertEqual(occurrences(of: "LinkEstablishment(", in: source), 1,
                       "one construction site, so there is no second way in")
        XCTAssertTrue(source.contains("LinkEstablishment(resuming: identity"),
                      "a rebuild is handed its identity; it can never derive one")
    }

    /// The clock is told the identity already exists, which is what retires the
    /// key-reveal window. Unobservable from outside for the same reason: the
    /// window only arms once both lanes are open.
    func testTheClockIsToldTheIdentityAlreadyExists() {
        let source = self.code
        XCTAssertEqual(occurrences(of: "LinkDeadlineClock(", in: source), 1)
        XCTAssertTrue(source.contains("identityPresent: true"),
                      "a rebuild waits for a transport, never for a reveal")
    }

    /// The handshake actions exist in this file EXACTLY once each, in the one
    /// case label that refuses them.
    ///
    /// They are part of the vocabulary `LinkSignalAction` shares with an
    /// establishment, and `LinkResumePolicy` cannot produce either — so the
    /// branch is unreachable and is written out rather than defaulted, which is
    /// what makes adding an action to that vocabulary a decision here instead of
    /// a silent no-op. A second occurrence would mean this driver had grown a
    /// way to act on one.
    func testTheHandshakeActionsAppearOnlyAsARefusal() throws {
        let source = self.code
        XCTAssertEqual(occurrences(of: ".recordPeerCommit", in: source), 1)
        XCTAssertEqual(occurrences(of: ".verifyPeerReveal", in: source), 1)
        XCTAssertTrue(source.contains("case .recordPeerCommit, .verifyPeerReveal, .fail:"),
                      "all three refusals share one branch, so none can be acted on alone")
    }

    /// The signing key is the one the inherited identity already carries. A
    /// second derivation site could be pointed at a key that does not belong to
    /// the codecs this rebuild is reusing.
    func testTheSigningKeyComesFromTheInheritedIdentity() {
        let source = self.code
        XCTAssertTrue(source.contains("identity.codecs.resumeAuthKey"))
        XCTAssertEqual(occurrences(of: "codecs.resumeAuthKey", in: source), 1,
                       "one place reads the key, and it is the identity's")
        for forbidden in ["signResume(", "verifyResume("] {
            XCTAssertFalse(source.contains(forbidden),
                           "signing and verification belong to the pure seams")
        }
    }

    // MARK: - two lanes, opened before the offer

    /// One negotiation must carry both lanes. Opening the text lane after the
    /// offer would ask the peer to expect a second round of DCEP it has no
    /// reason to wait for, and the publication barrier would never lift.
    func testBothLanesAreCreatedFromTheExactLabelListBeforeTheOfferIsMade() throws {
        let source = self.code
        XCTAssertTrue(source.contains("for label in LINK_CHANNEL_LABELS"),
                      "the lane list is the one constant, never a local literal")
        XCTAssertEqual(occurrences(of: "dataChannel(forLabel:", in: source), 1,
                       "exactly one creation site, driven by the label list")

        let created = try XCTUnwrap(source.range(of: "dataChannel(forLabel:"))
        let offered = try XCTUnwrap(source.range(of: "pc.offer(for:"))
        XCTAssertTrue(created.lowerBound < offered.lowerBound,
                      "both channels must exist before the offer is created")
    }

    /// Reliable and ordered. A reused AEAD sequence cannot tolerate a hole, and
    /// leaving `maxRetransmits`/`maxPacketLifeTime` unset is what makes the
    /// channel reliable — setting either turns it partial.
    func testLanesAreOrderedAndReliable() {
        let source = self.code
        XCTAssertTrue(source.contains("config.isOrdered = true"))
        XCTAssertFalse(source.contains("maxRetransmits"))
        XCTAssertFalse(source.contains("maxPacketLifeTime"))
    }

    // MARK: - only ever the resume generation, always signed

    /// Every outbound signal leaves through a builder that tags it `resume` and
    /// signs the complete tagged signal. A second path would be one that could
    /// put an untagged or unsigned signal on the wire — which the peer drops,
    /// silently, exactly as this side drops theirs.
    func testEveryOutboundSignalGoesThroughASigningBuilder() {
        let source = self.code
        XCTAssertEqual(occurrences(of: "resumeSDPSignal(kind: \"offer\"", in: source), 1)
        XCTAssertEqual(occurrences(of: "resumeSDPSignal(kind: \"answer\"", in: source), 1)
        XCTAssertEqual(occurrences(of: "resumeICESignal(", in: source), 1,
                       "the only way a local candidate reaches the wire")
        XCTAssertEqual(occurrences(of: "signaling.sendSignal(", in: source), 1,
                       "one send site, so every signal passes the same builder")

        for foreign in ["linkSDPSignal(", "sdpSignal(kind:", "iceSignal(", "taggedSignal(",
                        "generation: .", "busySignal(", "linkLeaveSignal("] {
            XCTAssertFalse(source.contains(foreign), "\(foreign) is not this transport's")
        }
    }

    // MARK: - exactly one negotiation

    /// This driver negotiates ONCE, and the absence of an ICE restart is a gate
    /// rather than an oversight.
    ///
    /// It is a deliberate divergence from `webrtc-core.ts`, which fires one
    /// restart offer as initiator on `disconnected` and which the web's own
    /// resume path inherits — so this is precisely the code a later reader
    /// assumes is present. Adding it here without first building a
    /// per-negotiation gate breaks three one-shot invariants at once:
    /// `LinkResumePolicy` refuses a second remote description before it even
    /// checks the tag, both `LinkCandidateGate`s are already open and would let
    /// a restart's candidates overtake the description they belong to, and
    /// `LinkEstablishment` has already published lanes whose AEAD sequences are
    /// running.
    ///
    /// Pinned here because absence is not observable at runtime: a driver that
    /// grew a restart would still pass every behavioural test in this batch,
    /// and would simply be unsafe on the second negotiation.
    func testTheDriverNegotiatesExactlyOnceAndNeverRestartsICE() {
        let source = self.code
        for forbidden in ["iceRestart", "restartIce", "RTCOfferAnswerOptions", ".disconnected"] {
            XCTAssertFalse(source.contains(forbidden),
                           "\(forbidden) needs a per-negotiation SDP/candidate gate first")
        }
        XCTAssertEqual(occurrences(of: "pc.offer(for:", in: source), 1,
                       "one offer for the transport's whole life")
        XCTAssertEqual(occurrences(of: "pc.answer(for:", in: source), 1)
        XCTAssertEqual(occurrences(of: "pc.setLocalDescription(", in: source), 2,
                       "one per role, and neither is reachable twice")
        XCTAssertEqual(occurrences(of: "pc.setRemoteDescription(", in: source), 1,
                       "one application site, guarded by the policy's once-only slots")
        XCTAssertTrue(
            source.contains("peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}"),
            "the renegotiation callback is answered with nothing, on purpose")
    }

    // MARK: - the signalling slot

    /// Two connections overlap on one socket routinely — most obviously the
    /// dying transport this one replaces. A closing older one must not be able
    /// to erase a NEWER one's handler.
    func testTheSignallingSlotIsClaimedAndReleasedByToken() {
        let source = self.code
        XCTAssertTrue(source.contains("signaling.installSignalHandler"))
        XCTAssertTrue(source.contains("signaling.removeSignalHandler(signalToken)"))
        XCTAssertFalse(source.contains("signaling.onSignal ="),
                       "the bare slot cannot express 'clear it only if it is still mine'")
    }

    // MARK: - candidate ordering

    /// Every candidate in either direction goes through its gate. A second path
    /// around either one would restore exactly the race the gates exist for.
    func testEveryCandidateGoesThroughItsGate() {
        let source = self.code
        XCTAssertEqual(occurrences(of: "sendCandidateLocked(", in: source), 3,
                       "one sender, called from the gate's two outcomes and the flush")
        XCTAssertEqual(occurrences(of: "localCandidates.admit(", in: source), 1)
        XCTAssertEqual(occurrences(of: "remoteCandidates.admit(", in: source), 1)
        XCTAssertEqual(occurrences(of: "pc.add(", in: source), 1,
                       "the only way a remote candidate reaches the PeerConnection")
    }

    /// Both roles, and only after the description they belong to is actually on
    /// the wire.
    func testBothRolesOpenTheLocalGateOnlyAfterSendingTheirDescription() throws {
        let source = self.code
        XCTAssertEqual(occurrences(of: "localDescriptionSentLocked()", in: source), 3,
                       "the offer path, the answer path, and the definition")
        for kind in ["offer", "answer"] {
            let sent = try XCTUnwrap(source.range(of: "resumeSDPSignal(kind: \"\(kind)\""))
            let opened = try XCTUnwrap(source.range(of: "localDescriptionSentLocked()",
                                                    range: sent.upperBound..<source.endIndex))
            XCTAssertFalse(source[sent.upperBound..<opened.lowerBound].contains("resumeSDPSignal"),
                           "the \(kind) opens the gate before anything else happens")
        }
    }

    /// A remote candidate reaches the PeerConnection only from the gate, and the
    /// gate is opened only by an applied remote description — which the policy
    /// only ever produces for a VERIFIED signal.
    func testRemoteCandidatesAreReleasedOnlyByAnAppliedDescription() throws {
        let source = self.code
        XCTAssertEqual(occurrences(of: "remoteCandidates.open()", in: source), 1)
        let applied = try XCTUnwrap(source.range(of: "pc.setRemoteDescription("))
        let released = try XCTUnwrap(source.range(of: "remoteCandidates.open()",
                                                  range: applied.upperBound..<source.endIndex))
        XCTAssertTrue(applied.lowerBound < released.lowerBound)
    }

    // MARK: - one terminal path

    /// Closed state and teardown before any client callback. A second place that
    /// set `closed` or called `onError`/`onClose` would be a second terminal
    /// path, and the ordering guarantee is exactly what cannot survive two.
    func testThereIsOneTerminalPathAndItClosesBeforeItCallsBack() throws {
        let source = self.code
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

    /// Teardown drops the references a closed transport must not keep — and here
    /// that includes the inherited identity, whose codecs hold the link's
    /// session-derived key material. The consumer owns its own reference from
    /// publication; a closed transport holding a second one keeps key material
    /// alive for an object with nothing left to do.
    func testTeardownClearsWhatAClosedTransportMustNotHold() {
        let source = self.code
        XCTAssertTrue(source.contains("pc = nil"))
        XCTAssertTrue(source.contains("self.signalToken = nil"))
        XCTAssertTrue(source.contains("establishment.close()"))
        XCTAssertTrue(source.contains("for channel in delegatedChannels"),
                      "including every channel a delegate was ever set on")
    }

    // MARK: - the deadline boundary

    /// A rebuild is complete at the BARRIER, not when client code returns. The
    /// queue is occupied by `onReady` and the replay, which are the consumer's
    /// own code and may take as long as they like, while the deadline they race
    /// is a clock.
    func testTheClockIsDisarmedAtTheBarrierNotAfterTheClientCallbacks() throws {
        let source = self.code
        let applied = try XCTUnwrap(source.range(of: "private func apply(_ step:"))
        let tail = String(source[applied.upperBound...])
        let end = try XCTUnwrap(tail.range(of: "\n    }"))
        let body = String(tail[tail.startIndex..<end.lowerBound])

        let disarmed = try XCTUnwrap(body.range(of: "disarmWatchdogLocked()"),
                                     "the barrier itself must disarm")
        let published = try XCTUnwrap(body.range(of: "publishLocked()"))
        XCTAssertTrue(disarmed.lowerBound < published.lowerBound,
                      "and it must do so before any client callback can run")
        XCTAssertEqual(occurrences(of: "publishLocked()", in: source), 2,
                       "one definition and one call site, so the barrier is the only way in")
    }

    /// Both halves of producing a description are asynchronous, and both
    /// completions come back on the queue the wake-up was waiting for. Each must
    /// re-read the boundary before it continues: the first before it applies a
    /// local description, the second before that description leaves and its
    /// candidate gate opens.
    func testEveryDescriptionCompletionChecksTheDeadlineBeforeContinuingSetup() throws {
        let source = self.code
        for (produce, kind) in [("pc.offer(for:", "offer"), ("pc.answer(for:", "answer")] {
            let produced = try XCTUnwrap(source.range(of: produce), "the \(kind) path must exist")
            let tail = String(source[produced.upperBound...])

            let setLocal = try XCTUnwrap(tail.range(of: "pc.setLocalDescription("))
            let onCreated = try XCTUnwrap(tail.range(of: "expiredLocked("),
                                          "the \(kind) completion must re-read the boundary")
            XCTAssertTrue(onCreated.lowerBound < setLocal.lowerBound,
                          "an expired rebuild applies no local \(kind)")

            let sent = try XCTUnwrap(tail.range(of: "resumeSDPSignal(kind: \"\(kind)\""))
            let onApplied = try XCTUnwrap(tail.range(of: "expiredLocked(",
                                                     range: setLocal.upperBound..<tail.endIndex),
                                          "the setLocalDescription completion must too")
            XCTAssertTrue(onApplied.lowerBound < sent.lowerBound,
                          "and an expired one puts no \(kind) on the wire")
        }
    }

    /// Only this rebuild's own work may start this rebuild's clock. Arming
    /// before the policy has filtered — and VERIFIED — the signal would let a
    /// signalling relay put every replacement in the room on a deadline it
    /// started, and then kill them with it.
    func testTheDeadlineIsArmedOnlyAfterThePolicyHasVerifiedTheSignal() throws {
        let source = self.code
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

    func testTheDriverOwnsNoRawQueue() {
        let source = self.code
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
        let source = self.code
        let opened = try XCTUnwrap(source.range(of: "    deinit {"))
        let tail = String(source[opened.upperBound...])
        let closed = try XCTUnwrap(tail.range(of: "\n    }"))
        let body = String(tail[tail.startIndex..<closed.lowerBound])
        XCTAssertFalse(body.contains("queue."), "deinit must tear down directly")
        XCTAssertTrue(body.contains("teardownLocked()"),
                      "and through the one teardown path, so nothing is forgotten")

        let teardown = try XCTUnwrap(source.range(of: "private func teardownLocked"))
        let teardownTail = String(source[teardown.upperBound...])
        let teardownEnd = try XCTUnwrap(teardownTail.range(of: "\n    }"))
        XCTAssertFalse(String(teardownTail[teardownTail.startIndex..<teardownEnd.lowerBound])
                        .contains("queue."))
    }
}
