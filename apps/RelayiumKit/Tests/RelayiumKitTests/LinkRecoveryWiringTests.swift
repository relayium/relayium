import XCTest
import WebRTC
@testable import RelayiumKit

/// A socket that is never opened. Enough to construct a `SignalingClient`, which
/// is all a factory contract needs: nothing here negotiates.
private final class SilentChannel: WebSocketChannel {
    var onOpen: (() -> Void)?
    var onText: ((String) -> Void)?
    var onClose: (() -> Void)?
    var isOpen: Bool { false }
    func send(_ text: String) {}
    func close() {}
}

/// The transport a link was on before the gap. Nothing here negotiates.
private final class FakeHandle: LinkTransportHandle {
    private(set) var closeCount = 0
    func close() { closeCount += 1 }
}

/// Transports the factory built, readable from a live driver's own queue as
/// well as the test's.
private final class Built {
    private let lock = NSLock()
    private var transports: [LinkReplacementTransport] = []

    func append(_ transport: LinkReplacementTransport) {
        lock.lock(); defer { lock.unlock() }
        transports.append(transport)
    }

    var all: [LinkReplacementTransport] {
        lock.lock(); defer { lock.unlock() }
        return transports
    }
}

/// The seam between the recovery coordinator and the real WebRTC driver.
///
/// `LinkRecoveryCoordinatorTests` proves the orchestration against fakes, which
/// is the only way to make timers, staleness and ordering ordinary unit tests.
/// What that cannot prove is that the seam fits the object it exists for — a
/// protocol the production driver does not satisfy, or a factory that hands the
/// driver anything other than the held identity, would leave every one of those
/// tests green and recovery unbuildable.
final class LinkRecoveryWiringTests: XCTestCase {

    private func identity(role: Role = .initiator) -> LinkIdentity {
        LinkIdentity(peerId: "peer-b",
                     role: role,
                     sas: "424242",
                     codecs: LinkCodecs(sendKey: [UInt8](repeating: 3, count: 32),
                                        recvKey: [UInt8](repeating: 5, count: 32)),
                     authenticationGeneration: 2)
    }

    /// The production drivers ARE the seam's types. A conformance that had to be
    /// adapted by a shim would mean the coordinator was written against a shape
    /// the real driver does not have.
    func testTheProductionDriversConformToTheRecoverySeams() {
        XCTAssertTrue(WebRTCLinkReplacementTransport.self is LinkReplacementTransport.Type)
        XCTAssertTrue(WebRTCLinkReplacementTransport.self is LinkTransportHandle.Type)
        XCTAssertTrue(WebRTCLinkTransport.self is LinkTransportHandle.Type)
    }

    /// The real factory builds a real replacement transport, and the coordinator
    /// can drive it: this is the constructor contract the fakes stand in for.
    func testTheProductionFactoryBuildsADrivableReplacement() throws {
        let signaling = SignalingClient(channel: SilentChannel(), name: "peer-a")
        let factory = webRTCLinkReplacementFactory(signaling: signaling, iceServers: [])
        let held = identity()

        let transport = try factory(held)
        defer { transport.close() }

        XCTAssertTrue(transport is WebRTCLinkReplacementTransport)
        // Installing the coordinator's forwarding callbacks must be possible
        // through the seam alone, before anything is started.
        transport.onReady = { _ in }
        transport.onFrame = { _, _ in }
        transport.onError = { _ in }
        transport.onClose = {}
    }

    /// A coordinator wired to the real factory reaches the real driver: losing
    /// the transport holds the gap and allocates an actual
    /// `WebRTCLinkReplacementTransport`, not merely a protocol value a fake also
    /// satisfies.
    ///
    /// Deliberately tolerant of how many attempts the window produced. A live
    /// driver with no signalling under it may fail its own attempt at any moment
    /// on its private queue, and this test is about the seam, not the cadence —
    /// which `LinkRecoveryCoordinatorTests` pins deterministically.
    func testACoordinatorOnTheRealFactoryAllocatesARealAttempt() {
        let held = identity()
        let signaling = SignalingClient(channel: SilentChannel(), name: "peer-a")
        let current = FakeHandle()
        let real = webRTCLinkReplacementFactory(signaling: signaling, iceServers: [])
        let built = Built()
        let coordinator = LinkRecoveryCoordinator(
            identity: held,
            current: current,
            factory: { identity in
                let transport = try real(identity)
                built.append(transport)
                return transport
            },
            scheduler: LinkDispatchRecoveryScheduler(queue: DispatchQueue(label: "test")))
        var attached: LinkReplacementTransport?
        coordinator.onTransportLost = { _ in true }
        coordinator.onAttach = { _, transport in attached = transport }
        defer { coordinator.stop() }

        coordinator.transportTerminated(current, error: LinkTransportError.peerConnectionFailed)

        XCTAssertEqual(coordinator.phase, .interrupted)
        XCTAssertEqual(current.closeCount, 1)
        XCTAssertNil(attached, "nothing may publish before a rebuild is ready")
        let all = built.all
        XCTAssertGreaterThanOrEqual(all.count, 1, "the real factory was never reached")
        XCTAssertTrue(all[0] is WebRTCLinkReplacementTransport)
    }

    // MARK: - source guards

    private var wiringSource: String {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // RelayiumKitTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // RelayiumKit
        let file = packageRoot.appendingPathComponent(
            "Sources/RelayiumKit/Realtime/WebRTCLinkRecovery.swift")
        return (try? String(contentsOf: file, encoding: .utf8)) ?? ""
    }

    private func code(_ source: String) -> String {
        source
            .components(separatedBy: "\n")
            .map { line -> String in
                guard let marker = line.range(of: "//") else { return line }
                return String(line[line.startIndex..<marker.lowerBound])
            }
            .joined(separator: "\n")
    }

    /// The factory passes the held identity through and constructs nothing that
    /// could produce a second one. Absence is not observable at runtime, so it
    /// is pinned here — a factory that derived keys would hand a "rebuild" a
    /// second `LinkCodecs`, which is two AEAD sequences under one pair of
    /// session keys.
    func testTheProductionFactoryConstructsNoCryptography() {
        let source = code(wiringSource)
        XCTAssertFalse(source.isEmpty, "the wiring source must be readable")
        for forbidden in ["HandshakeState", "LinkCodecs(", "generateKeyPair(", "deriveSession(",
                          "deriveResumeAuth(", "deriveTextKey(", "LinkIdentity("] {
            XCTAssertFalse(source.contains(forbidden),
                           "\(forbidden) has no place in a transport-replacement factory")
        }
    }

    private var coordinatorSource: String {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let file = packageRoot.appendingPathComponent(
            "Sources/RelayiumKit/Realtime/LinkRecovery.swift")
        return (try? String(contentsOf: file, encoding: .utf8)) ?? ""
    }

    /// The pure coordinator stays pure: it must be buildable and testable with
    /// no WebRTC under it at all, which is what makes its timers, staleness and
    /// ordering ordinary unit tests rather than a two-peer run.
    func testTheCoordinatorSourceImportsNoWebRTC() {
        let source = coordinatorSource
        XCTAssertFalse(source.isEmpty, "the coordinator source must be readable")
        XCTAssertFalse(code(source).contains("import WebRTC"))
    }

    /// The coordinator constructs no cryptography either. It HOLDS one identity
    /// and hands it to a factory; a `LinkCodecs` built here would be the second
    /// AEAD sequence the whole feature exists to prevent.
    func testTheCoordinatorConstructsNoCryptography() {
        let source = code(coordinatorSource)
        XCTAssertFalse(source.isEmpty, "the coordinator source must be readable")
        for forbidden in ["HandshakeState", "LinkCodecs(", "generateKeyPair(", "deriveSession(",
                          "deriveResumeAuth(", "deriveTextKey(", "LinkIdentity("] {
            XCTAssertFalse(source.contains(forbidden),
                           "\(forbidden) has no place in a recovery coordinator")
        }
    }

    /// Every cheap refusal runs BEFORE the HMAC on an inbound rebuild offer.
    ///
    /// Pinned as source order because the property is a COST, and cost is the
    /// one thing an assertion cannot see: moving the verification above the
    /// phase, peer, role, shape, length or slot checks leaves every behavioural
    /// test in `LinkRecoveryCoordinatorTests` green while handing a forged flood
    /// one HMAC per message. The slot check in particular has to stay ahead of
    /// it, or a duplicate offer — which a genuine peer retransmitting produces —
    /// buys verification work for a rebuild that is already running, and it must
    /// read the RESERVATION (`attemptSlotIsFree`) rather than a claimed
    /// transport, or an offer arriving while the factory is still building finds
    /// a slot that is taken but does not say so.
    func testCheapRefusalsPrecedeTheHMACOnInboundRebuildOffers() {
        let source = code(coordinatorSource)
        guard let body = source.range(of: "public func receiveResumeOffer") else {
            return XCTFail("receiveResumeOffer is no longer where this guard looks")
        }
        let tail = String(source[body.lowerBound...])
        guard let hmac = tail.range(of: "resumeSignalIsAuthentic(") else {
            return XCTFail("the inbound offer path no longer verifies a tag")
        }
        let beforeHMAC = String(tail[tail.startIndex..<hmac.lowerBound])
        for cheap in ["phase == .interrupted",
                      "from == identity.peerId",
                      "identity.role == .responder",
                      "signalGeneration(signal) == .resume",
                      "parseSDP(signal)?.type == \"offer\"",
                      "LINK_AUTH_TAG_LENGTH",
                      "attemptSlotIsFree"] {
            XCTAssertTrue(beforeHMAC.contains(cheap),
                          "\(cheap) must be decided before an HMAC is spent")
        }
    }
}
