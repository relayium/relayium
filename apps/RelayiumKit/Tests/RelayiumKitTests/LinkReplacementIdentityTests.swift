import XCTest
@testable import RelayiumKit

/// One `LinkLaneChannel` with no WebRTC under it. The same fake
/// `LinkEstablishmentTests` uses; private to each file because a shared mutable
/// test double across suites is how one test's lane state leaks into another's.
private final class FakeLane: LinkLaneChannel {
    enum State { case connecting, open, closing, closed }

    let laneLabel: String
    var state: State
    private(set) var closeCount = 0
    var laneBufferedAmount: UInt64 = 0

    init(_ label: String, state: State = .open) {
        self.laneLabel = label
        self.state = state
    }

    var laneIsOpen: Bool { state == .open }
    var laneIsTerminal: Bool { state == .closing || state == .closed }

    @discardableResult
    func laneSend(_ bytes: [UInt8]) -> Bool { true }

    func laneClose() {
        closeCount += 1
        state = .closed
    }
}

/// What an authenticated `link/1` transport REPLACEMENT inherits, and what it is
/// therefore forbidden from constructing.
///
/// A replacement rebuilds the transport under an authentication that already
/// exists. The whole contract is that nothing identifying that authentication
/// changes: the same peer, the same deterministic role, the same six displayed
/// digits, the same authentication generation and — the one that is
/// catastrophic to get wrong — the same `LinkCodecs` object, because a link owns
/// exactly one `(content key, direction)` AEAD sequence for its whole life.
final class LinkReplacementIdentityTests: XCTestCase {

    private let sendKey = [UInt8](repeating: 1, count: 32)
    private let recvKey = [UInt8](repeating: 2, count: 32)

    private func identity(peerId: String = "peer-b",
                          role: Role = .initiator,
                          sas: String = "123456",
                          generation: Int = 3,
                          codecs: LinkCodecs? = nil) -> LinkIdentity {
        LinkIdentity(peerId: peerId,
                     role: role,
                     sas: sas,
                     codecs: codecs ?? LinkCodecs(sendKey: sendKey, recvKey: recvKey),
                     authenticationGeneration: generation)
    }

    // MARK: - the resume-auth key

    /// The key that authenticates a rebuild's signalling is derived from the
    /// link's own session keys, in the one place those keys already live.
    ///
    /// Deriving it anywhere else would mean handing the raw file session keys to
    /// a second call site, and would let a replacement be pointed at a key that
    /// does not belong to the codecs it is reusing.
    func testTheCodecsCarryTheResumeAuthKeyDerivedFromTheSessionKeys() {
        let codecs = LinkCodecs(sendKey: sendKey, recvKey: recvKey)
        XCTAssertEqual(codecs.resumeAuthKey, deriveResumeAuth(sendKey: sendKey, recvKey: recvKey))
        XCTAssertEqual(codecs.resumeAuthKey.count, 32)
    }

    /// crypto_kx hands the two peers mirrored secrets, and `deriveResumeAuth`
    /// sorts, so both ends of one link derive the SAME signalling key from their
    /// own codecs. Without this a rebuild could never be verified by the peer
    /// that did not offer it.
    func testBothPeersCodecsDeriveTheSameResumeAuthKey() {
        let mine = LinkCodecs(sendKey: sendKey, recvKey: recvKey)
        let theirs = LinkCodecs(sendKey: recvKey, recvKey: sendKey)
        XCTAssertEqual(mine.resumeAuthKey, theirs.resumeAuthKey)
    }

    /// Two different links never share the key, so a tag from one is worthless
    /// in the other — which is what makes cross-link replay a non-issue without
    /// any nonce of its own.
    func testADifferentLinksCodecsDeriveADifferentKey() {
        let mine = LinkCodecs(sendKey: sendKey, recvKey: recvKey)
        let other = LinkCodecs(sendKey: [UInt8](repeating: 8, count: 32),
                               recvKey: [UInt8](repeating: 9, count: 32))
        XCTAssertNotEqual(mine.resumeAuthKey, other.resumeAuthKey)
    }

    /// The same golden vector the web is held to.
    func testTheDerivedKeyMatchesTheGoldenVector() throws {
        let v = try Vectors.load()
        let codecs = LinkCodecs(sendKey: v.hex("session.aliceSend"),
                                recvKey: v.hex("session.aliceRecv"))
        XCTAssertEqual(codecs.resumeAuthKey, v.hex("resumeAuth.keyHex"))
    }

    /// The text lane's AEAD keys are per-direction and must NOT be confused with
    /// the symmetric signalling key. Sorting the text keys would collapse both
    /// directions onto one nonce counter; not sorting the signalling key would
    /// leave the two peers unable to verify each other.
    func testTheSignallingKeyIsDistinctFromEveryAEADKey() {
        let codecs = LinkCodecs(sendKey: sendKey, recvKey: recvKey)
        XCTAssertNotEqual(codecs.resumeAuthKey, codecs.textSendKey)
        XCTAssertNotEqual(codecs.resumeAuthKey, codecs.textRecvKey)
        XCTAssertNotEqual(codecs.textSendKey, codecs.textRecvKey)
    }

    // MARK: - what a replacement carries over

    func testReplacingTransportPreservesEverythingThatIdentifiesTheAuthentication() {
        let original = identity(peerId: "peer-b", role: .responder, sas: "654321", generation: 7)
        let next = original.replacingTransport()

        XCTAssertEqual(next.peerId, original.peerId)
        XCTAssertEqual(next.sas, original.sas)
        XCTAssertEqual(next.authenticationGeneration, original.authenticationGeneration,
                       "a rebuild is the same authentication step, not a later one")
        XCTAssertTrue(next.codecs === original.codecs,
                      "one link, one set of nonce-bearing codecs, for its whole life")
        XCTAssertEqual(next.codecs.resumeAuthKey, original.codecs.resumeAuthKey)
        switch (next.role, original.role) {
        case (.responder, .responder), (.initiator, .initiator): break
        default: XCTFail("a rebuild must not turn two peers into two offerers")
        }
    }

    // MARK: - a pre-authenticated establishment

    /// A replacement is handed its identity at construction. It never verifies a
    /// reveal, so `authenticated` is never called and the barrier is waiting on
    /// the lanes alone.
    func testAPreAuthenticatedEstablishmentPublishesOnTheLanesAlone() {
        let existing = identity()
        let establishment = LinkEstablishment(resuming: existing)
        XCTAssertTrue(establishment.identity?.codecs === existing.codecs)

        XCTAssertEqual(establishment.collect(FakeLane(LINK_FILE_CHANNEL)), .none,
                       "one lane is not a link")
        XCTAssertEqual(establishment.collect(FakeLane(LINK_TEXT_CHANNEL)), .publish)

        var published: LinkIdentity?
        XCTAssertTrue(establishment.publish(ready: { published = $0 }, frame: { _, _ in }))
        XCTAssertTrue(published?.codecs === existing.codecs)
        XCTAssertEqual(published?.sas, existing.sas)
        XCTAssertEqual(published?.authenticationGeneration, existing.authenticationGeneration)
    }

    /// The backstop that makes "a replacement constructs no codecs" structural
    /// rather than a promise: even if something above it produced a second
    /// identity, this one refuses it.
    func testAPreAuthenticatedEstablishmentRefusesASecondIdentity() {
        let existing = identity(sas: "111111")
        let establishment = LinkEstablishment(resuming: existing)

        XCTAssertEqual(establishment.authenticated(identity(sas: "222222")), .none)
        XCTAssertEqual(establishment.identity?.sas, "111111")
        XCTAssertTrue(establishment.identity?.codecs === existing.codecs)
    }

    /// Frames the peer sends on a rebuilt lane belong to codecs that already
    /// exist and whose receive sequence must stay continuous, so the same
    /// bounded capture and the same per-lane FIFO replay apply.
    func testAPreAuthenticatedEstablishmentStillCapturesAndReplaysPerLaneFIFO() {
        let establishment = LinkEstablishment(resuming: identity())
        _ = establishment.collect(FakeLane(LINK_FILE_CHANNEL))
        _ = establishment.collect(FakeLane(LINK_TEXT_CHANNEL))

        XCTAssertEqual(establishment.inbound(label: LINK_FILE_CHANNEL, frame: [1]), .captured)
        XCTAssertEqual(establishment.inbound(label: LINK_TEXT_CHANNEL, frame: [9]), .captured)
        XCTAssertEqual(establishment.inbound(label: LINK_FILE_CHANNEL, frame: [2]), .captured)

        var file: [[UInt8]] = []
        var text: [[UInt8]] = []
        establishment.publish(ready: { _ in }, frame: { lane, bytes in
            switch lane {
            case .file: file.append(bytes)
            case .text: text.append(bytes)
            }
        })
        XCTAssertEqual(file, [[1], [2]])
        XCTAssertEqual(text, [[9]])
    }

    /// Overflow is terminal on a rebuild for the reason it is terminal on a
    /// first connection, only more so: a dropped admitted frame is a hole in a
    /// receive sequence that has already been proven once.
    func testAPreAuthenticatedCaptureStillFailsClosedOnOverflow() {
        let establishment = LinkEstablishment(resuming: identity(),
                                              capture: LinkFrameCapture(limit: 4))
        _ = establishment.collect(FakeLane(LINK_FILE_CHANNEL))
        _ = establishment.collect(FakeLane(LINK_TEXT_CHANNEL))

        XCTAssertEqual(establishment.inbound(label: LINK_FILE_CHANNEL, frame: [1, 2, 3, 4]), .captured)
        XCTAssertEqual(establishment.inbound(label: LINK_TEXT_CHANNEL, frame: [5]),
                       .fail(.captureOverflow))
    }

    /// Still refused, still stated as a constant. This batch builds the
    /// replacement CONNECTION and nothing that decides when to use one: there is
    /// no atomic old/new swap, no retry orchestration, no durable file
    /// checkpoint, no RESUME_REQ/RESUME_START, no admission or factory
    /// integration and no UI.
    func testNeitherSupportConstantIsFlippedByThisBatch() {
        XCTAssertFalse(LINK_TRANSPORT_REPLACEMENT_SUPPORTED,
                       "a replacement connection is not a supported recovery path")
        // `LINK_BUILD_SUPPORT` is deliberately NOT asserted here. This suite's
        // subject is not the flag, and its value is per platform: a claim about
        // it in nineteen unrelated files is nineteen places to get the iOS
        // branch wrong. `PeerCapabilityRegistryTests` owns that contract, value
        // and source both.
    }

    // MARK: - the watchdog a replacement runs under

    /// A replacement has no key-reveal phase, so the window that describes one
    /// must never arm. `LinkDeadlineClockTests` covers the wiring; this pins the
    /// decision itself.
    func testAPreAuthenticatedWatchdogNeverArmsTheKeyRevealWindow() {
        var watchdog = LinkEstablishmentWatchdog(
            start: 0,
            deadlines: LinkDeadlines(setupHardCap: 900, noProgress: 30, keyReveal: 10),
            identityPresent: true)
        watchdog.note(.laneOpened(.file), at: 1)
        watchdog.note(.laneOpened(.text), at: 1)

        XCTAssertNil(watchdog.expiry(at: 500))
        XCTAssertEqual(watchdog.expiry(at: 900), .setup,
                       "the hard cap still bounds the total")
    }

    /// And an `authenticated` milestone that somehow arrived anyway buys nothing:
    /// the identity was already there, so there is no window for it to retire and
    /// no patience for it to extend.
    func testAPreAuthenticatedWatchdogTreatsAnAuthenticatedMilestoneAsARepeat() {
        var watchdog = LinkEstablishmentWatchdog(
            start: 0,
            deadlines: LinkDeadlines(setupHardCap: 900, noProgress: 30, keyReveal: 10),
            identityPresent: true)
        XCTAssertEqual(watchdog.note(.authenticated, at: 1), .unchanged)
    }
}
