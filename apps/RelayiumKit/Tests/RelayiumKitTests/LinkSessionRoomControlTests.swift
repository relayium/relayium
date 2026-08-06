import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

// MARK: - the recording runtime
//
// The control's question is not the runtime's: what it owes is that each of the
// three ROOM verbs reaches the link it was made for, exactly once, with the
// arguments it was given, and that nothing reaches a link that is gone. So the
// double here records rather than negotiates — the verbs' own behaviour is
// `LinkRecoveryCoordinator`'s and is pinned in its own suite.

private final class RecordingRecoveryControl: LinkSessionRecoveryControl {
    /// Every call, in order, so "once, and in this order" is one assertion.
    private(set) var calls: [String] = []
    private(set) var resumeOffers: [(from: String, signal: JSONValue)] = []
    private(set) var departures: [String] = []
    private(set) var joins: [String] = []
    /// The completion the last `joinRecovery` was handed, so a test can prove it
    /// travelled through rather than being wrapped or dropped.
    private(set) var lastJoinCompletion: ((Result<LinkIdentity, Error>) -> Void)?
    /// What this runtime answers `joinRecovery` with.
    var joinAnswer: LinkRecoveryJoin = .joined

    func receiveResumeOffer(from: String, signal: JSONValue) {
        calls.append("resume")
        resumeOffers.append((from, signal))
    }

    func peerDeparted(_ peerId: String) {
        calls.append("departed")
        departures.append(peerId)
    }

    func joinRecovery(peerId: String,
                      _ complete: @escaping (Result<LinkIdentity, Error>) -> Void)
    -> LinkRecoveryJoin {
        calls.append("join")
        joins.append(peerId)
        lastJoinCompletion = complete
        return joinAnswer
    }
}

@MainActor
final class LinkSessionRoomControlTests: XCTestCase {

    private let sendKey = [UInt8](repeating: 0x31, count: 32)
    private let recvKey = [UInt8](repeating: 0x32, count: 32)

    private func identity(peerId: String = "peer-control") -> LinkIdentity {
        LinkIdentity(peerId: peerId, role: .responder, sas: "313131",
                     codecs: LinkCodecs(sendKey: sendKey, recvKey: recvKey),
                     authenticationGeneration: 3)
    }

    private func resumeSignal(_ sdp: String = "v=0 rebuild") -> JSONValue {
        .object(["resume": .bool(true),
                 "sdp": .object(["type": .string("offer"), "sdp": .string(sdp)]),
                 "auth": .string(String(repeating: "a", count: LINK_LEAVE_AUTH_LENGTH))])
    }

    // MARK: - 1. exact forwarding

    /// Each verb reaches the runtime once, with what it was given and nothing
    /// added. A control that re-decided any of these — dropped a departure for a
    /// peer it thought was wrong, or answered a resume offer itself — would be a
    /// second routing policy beside `LinkRecoveryCoordinator`'s, and the two can
    /// only ever disagree silently.
    func testEachRoomVerbReachesTheRuntimeVerbatimAndOnce() {
        let runtime = RecordingRecoveryControl()
        let control = LinkSessionRoomControl(runtime: runtime)
        let signal = resumeSignal()

        control.receiveResumeOffer(from: "peer-a", signal: signal)
        control.peerDeparted("peer-b")
        control.joinRecovery(peerId: "peer-c") { _ in }

        XCTAssertEqual(runtime.calls, ["resume", "departed", "join"],
                       "each verb reached the runtime exactly once, in issue order")
        XCTAssertEqual(runtime.resumeOffers.count, 1)
        XCTAssertEqual(runtime.resumeOffers.first?.from, "peer-a")
        XCTAssertEqual(runtime.resumeOffers.first?.signal, signal,
                       "the signal is forwarded byte for byte")
        XCTAssertEqual(runtime.departures, ["peer-b"])
        XCTAssertEqual(runtime.joins, ["peer-c"])
    }

    /// The join answer is the runtime's own, unwrapped. A control that
    /// substituted one would be telling a room owner that intent had landed on a
    /// rebuild that never registered it.
    func testJoinRecoveryAnswersWithTheRuntimesOwnDecision() {
        let runtime = RecordingRecoveryControl()
        let control = LinkSessionRoomControl(runtime: runtime)

        for answer in [LinkRecoveryJoin.joined, .busy, .unavailable] {
            runtime.joinAnswer = answer
            XCTAssertEqual(control.joinRecovery(peerId: "peer-control") { _ in }, answer)
        }
    }

    /// The completion travels through untouched, and is the one the runtime
    /// resolves. Wrapping it — to count, to hop, to filter — would be a second
    /// place a rebuilt link's identity could be lost or delivered twice.
    func testTheJoinCompletionIsTheCallersOwn() {
        let runtime = RecordingRecoveryControl()
        let control = LinkSessionRoomControl(runtime: runtime)
        var delivered: [LinkIdentity] = []

        control.joinRecovery(peerId: "peer-control") { result in
            if case let .success(identity) = result { delivered.append(identity) }
        }
        runtime.lastJoinCompletion?(.success(identity()))

        XCTAssertEqual(delivered.count, 1, "resolved exactly once, by the runtime")
        XCTAssertEqual(delivered.first?.peerId, "peer-control")
    }

    // MARK: - 2. it cannot extend a session's life

    /// The runtime is held weakly. The attempt is the only strong owner, so a
    /// coordinator that keeps a control around after its attempt is gone leaks a
    /// handle — never a live link, a PeerConnection or a TURN allocation.
    func testTheControlHoldsItsRuntimeWeakly() {
        weak var observed: RecordingRecoveryControl?
        var control: LinkSessionRoomControl?
        do {
            let runtime = RecordingRecoveryControl()
            observed = runtime
            control = LinkSessionRoomControl(runtime: runtime)
            XCTAssertNotNil(observed)
            XCTAssertEqual(control?.isLive, true)
        }

        XCTAssertNil(observed, "the control was not an owner")
        XCTAssertEqual(control?.isLive, false, "and says so")
    }

    /// Every verb is inert once the link is gone, and `joinRecovery` answers
    /// `.unavailable` — which is exactly what the runtime itself answers for a
    /// link with no gap to join. A room owner therefore has one behaviour to
    /// reason about rather than two, and a signal that arrives a moment after a
    /// retirement is indistinguishable from one that arrives a moment after the
    /// link ended, because those are the same thing.
    func testEveryVerbIsInertOnceTheRuntimeIsGone() {
        var control: LinkSessionRoomControl!
        do {
            let runtime = RecordingRecoveryControl()
            runtime.joinAnswer = .joined
            control = LinkSessionRoomControl(runtime: runtime)
        }

        control.receiveResumeOffer(from: "peer-a", signal: resumeSignal())
        control.peerDeparted("peer-a")
        var resolved = false

        XCTAssertEqual(control.joinRecovery(peerId: "peer-a") { _ in resolved = true },
                       .unavailable,
                       "no link, no gap to join")
        XCTAssertFalse(resolved, "and nothing invents an outcome for it")
        XCTAssertFalse(control.isLive)
    }

    /// A control made for no runtime at all behaves as one whose runtime has
    /// gone. `LinkSessionFactory` never produces one — the attempt calls its
    /// builder synchronously — but the terminal state has to be the same state,
    /// not a second one with its own behaviour.
    func testAControlWithNoRuntimeIsTheSameTerminalState() {
        let control = LinkSessionRoomControl(runtime: nil)

        control.receiveResumeOffer(from: "peer-a", signal: resumeSignal())
        control.peerDeparted("peer-a")

        XCTAssertEqual(control.joinRecovery(peerId: "peer-a") { _ in }, .unavailable)
        XCTAssertFalse(control.isLive)
    }

    // MARK: - 3. the seams stay where they were put

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

    /// …/apps/RelayiumKit/Tests/RelayiumKitTests/<this file> → …/apps
    private var appsRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    /// Every Swift source under the app targets, as code with comments removed.
    private func appSources() throws -> [(name: String, code: String)] {
        let roots = [appsRoot.appendingPathComponent("RelayiumKit/Sources"),
                     appsRoot.appendingPathComponent("ios"),
                     appsRoot.appendingPathComponent("mac")]
        var sources: [(String, String)] = []
        for root in roots {
            guard FileManager.default.fileExists(atPath: root.path) else { continue }
            let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)?
                .compactMap { $0 as? URL }
                .filter { $0.pathExtension == "swift" }
            for file in try XCTUnwrap(files) {
                sources.append((file.lastPathComponent,
                                code((try? String(contentsOf: file, encoding: .utf8)) ?? "")))
            }
        }
        XCTAssertGreaterThan(sources.count, 50, "the scan really reached the app sources")
        return sources
    }

    private func appSource(_ name: String) throws -> String {
        let url = appsRoot
            .appendingPathComponent("RelayiumKit/Sources/RelayiumAppKit/\(name)")
        let source = code(try String(contentsOf: url, encoding: .utf8))
        XCTAssertFalse(source.isEmpty, "\(name) must be readable")
        return source
    }

    /// Both flags are still false, and the ONLY thing that builds a control is
    /// `LinkSessionFactory` — which nothing reaches either. A second builder
    /// would be a second handle on one link, made by something that is not the
    /// assembly and therefore cannot know whether an attempt owns it.
    func testTheControlStaysUnreachableFromProduction() throws {
        XCTAssertFalse(LINK_BUILD_SUPPORT)
        XCTAssertFalse(LINK_TRANSPORT_REPLACEMENT_SUPPORTED)

        for source in try appSources() where source.name != "LinkSessionFactory.swift" {
            XCTAssertFalse(source.code.contains("LinkSessionRoomControl("),
                           "\(source.name) builds a room control, which is the factory's")
            XCTAssertFalse(source.code.contains("LinkSessionAssembly("),
                           "\(source.name) builds an assembly, which is the factory's")
        }
    }

    /// The room's three verbs did NOT arrive in the screen's vocabulary. That
    /// exclusion is the reason this type exists: `LinkSessionCommands` is what a
    /// presentation layer may call, and an inbound resume offer, a departed peer
    /// and mid-gap intent are signalling facts a screen must not be able to
    /// invent.
    func testTheCommandSeamStillExcludesEveryRoomVerb() throws {
        let attempt = try appSource("LinkSessionAttempt.swift")

        for verb in ["receiveResumeOffer", "peerDeparted", "joinRecovery"] {
            XCTAssertFalse(attempt.contains(verb),
                           "the command seam must not gain \(verb)")
        }
    }

    /// And the control is the mirror of that: the three room verbs, and no
    /// command, no lifetime and no projection. A control that could `stop()` a
    /// runtime would be a second thing able to end one link; one that could send
    /// would be a second, unowned writer on a screen's lane.
    func testTheControlCarriesNothingButTheThreeRoomVerbs() throws {
        let source = try appSource("LinkSessionRoomControl.swift")

        for forbidden in ["LinkSessionCommands", "LinkSessionPresentationModel",
                          "LinkFilePresentationModel", "LinkSessionEventBridge",
                          "sendText", "enqueueFiles", "acceptInboundBatch",
                          "func start", "func stop", "func retire",
                          "LinkAdmission", "SignalingClient", "deinit"] {
            XCTAssertFalse(source.contains(forbidden),
                           "the room control must not name \(forbidden)")
        }
        XCTAssertTrue(source.contains("private weak var runtime"),
                      "and it must not be an owner")
    }
}
