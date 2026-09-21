import Combine
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// **Replacing an expired pairing code, under the macOS composition.**
///
/// macOS 1.4.1 shipped `PairingCodeStart.regenerate` as three lines — leave the
/// dead room, dismiss it, mint — under a comment promising the code model never
/// passes through `.idle` and ownership is never touched. Neither was true.
/// `RelayiumApp` wires `onPairingRoomRetired = { directCode.cancel() }`, so
/// `leave()` retires the digits, `dismiss()` leaves the module holding nothing,
/// and the app-scoped liveness observer releases the surface. Nothing claimed it
/// again. The replacement code was minted and its room was watched — both
/// visible halves looked right — and the peer that linked on it was never drawn,
/// because `TransferModule.pane` answers `.connect` for a surface nobody owns.
/// It is the defect iOS repaired in `CrossNetworkPairingStart.regenerate`.
///
/// ## What this drives, and what it cannot
///
/// `swift test` cannot import the macOS app target, so `PairingCodeStart` is
/// out of reach. The Mac `regenerate` is now ONE statement that delegates to
/// `CrossNetworkPairingStart.regenerate`, which IS in this package:
///
///  - these tests drive that production type on a graph wired the way
///    `RelayiumApp` wires the Cross-network module — the three answers
///    `AppEnvironment.makeDirectLinkWorkspaceModel` gives and the two callbacks,
///    strong captures as written there;
///  - `MacSurfaceGuardTests.testReplacingAnExpiredCodeDelegatesToTheSharedRegenerate`
///    pins, as source text, that the Mac body is that delegation and nothing
///    else;
///  - `testTheRigIsWiredTheWayTheMacAppWiresIt` pins, as source text, the
///    wiring this rig reproduces.
///
/// Together that is the honest limit. What none of it proves is the built app:
/// nobody has yet let a code expire in a running Mac build, pressed New code and
/// joined the replacement.
@MainActor
final class MacPairingCodeRegenerateTests: XCTestCase {

    // MARK: - doubles

    private final class ManualScheduler: LinkRecoveryScheduler, @unchecked Sendable {
        private final class Handle: LinkRecoveryTimer { func cancel() {} }
        func schedule(after delay: TimeInterval, _ body: @escaping () -> Void) -> LinkRecoveryTimer {
            Handle()
        }
    }

    /// Distinct codes, and a mint that can be held open or made to fail — the
    /// same two properties `PairingLinkHandoffTests` needs, for the same reason:
    /// a reused code cannot show a second room, and an instant answer closes the
    /// window a Cancel or a second press actually lands in.
    private final class StubPair: PairCodeClient, @unchecked Sendable {
        var codes = ["483920", "774051"]

        private let lock = NSLock()
        private var issued = 0
        private var failing = false
        private var holding = false
        private var waiter: CheckedContinuation<Void, Never>?

        func holdNextMint() { lock.withLock { holding = true } }
        func failFromNowOn() { lock.withLock { failing = true } }

        func mint(token: String) async throws -> MintedCode {
            if lock.withLock({ defer { holding = false }; return holding }) {
                await withCheckedContinuation { waiting in
                    lock.withLock { waiter = waiting }
                }
            }
            if lock.withLock({ failing }) { throw AccountError.network }
            let code = lock.withLock { () -> String in
                defer { issued += 1 }
                return codes[min(issued, codes.count - 1)]
            }
            return MintedCode(code: code, expiresAt: 4_102_444_800)
        }

        func answerHeldMint() {
            let waiting = lock.withLock { () -> CheckedContinuation<Void, Never>? in
                defer { waiter = nil }
                return waiter
            }
            waiting?.resume()
        }
    }

    private final class StubICE: ICEConfigClient, @unchecked Sendable {
        func fetch(code: String) async throws -> ICEConfig {
            ICEConfig(iceServers: [ICEServerConfig(urls: ["stun:stun.relayium.test:3478"])])
        }
    }

    private final class QuietTransport: LinkRoutableInitialTransport, @unchecked Sendable {
        var onSAS: ((String) -> Void)?
        var onReady: ((LinkIdentity) -> Void)?
        var onFrame: ((LinkLane, [UInt8]) -> Void)?
        var onError: ((Error) -> Void)?
        var onClose: (() -> Void)?
        func start() {}
        func receive(from: String, signal: JSONValue) {}
        func send(_ bytes: [UInt8], on lane: LinkLane) throws {}
        func bufferedAmount(on lane: LinkLane) -> UInt64 { 0 }
        var negotiatedMaxMessageBytes: Double { DEFAULT_MAX_FRAME_BYTES }
        private(set) var isClosed = false
        func close() { isClosed = true }
    }

    // MARK: - the graph under test

    @MainActor
    private final class Rig {
        let module: TransferModule
        let pair: StubPair
        var channels: [FakeWebSocketChannel] = []
        var joinedCodes: [String] = []

        init(module: TransferModule, pair: StubPair) {
            self.module = module
            self.pair = pair
        }

        var link: LinkWorkspaceModel { module.link }
        var code: PairingCodeModel { module.code }
        /// The production type the Mac `regenerate` now calls.
        var start: CrossNetworkPairingStart { CrossNetworkPairingStart(module: module) }
    }

    private var directories: [URL] = []

    override func tearDown() async throws {
        for directory in directories { try? FileManager.default.removeItem(at: directory) }
        directories = []
    }

    /// The macOS Cross-network module, assembled the way `RelayiumApp` does it.
    ///
    /// Deliberately NOT `TransferModule.crossNetwork`: that is the iOS assembly.
    /// The Mac keeps its own spelling — the bare initializer and two callbacks
    /// that capture the code strongly — and a rig built on the shared one would
    /// be testing the other platform's graph.
    private func macRig() throws -> Rig {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("mac-regenerate-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        directories.append(directory)

        var box: Rig?
        let link = LinkWorkspaceModel(
            capabilities: PeerCapabilityRegistry(
                linkRoomActive: { linkRoomActive(isCodelessRoom: false) }),
            receiveDirectory: { directory },
            requiresVerification: { false },
            iceClient: StubICE(),
            connectPairingSocket: { code in
                let channel = FakeWebSocketChannel()
                let socket = SignalingClient(channel: channel, name: "Mac")
                channel.fireOpen()
                box?.channels.append(channel)
                box?.joinedCodes.append(code)
                return socket
            },
            pairingRoomHandle: LinkRoomHandle(),
            // The three answers `AppEnvironment.makeDirectLinkWorkspaceModel`
            // gives, pinned below as source text.
            legacyFallback: .terminateUnsupported,
            localHello: linkOnlyCapsHello(linkRoomActive:),
            pendingMessages: .refuseWhileWaiting,
            scheduler: ManualScheduler(),
            assemble: { signaling, peerId, role, servers, relayOnly, generation,
                        directory, admission, signal, _ in
                LinkSessionFactory.make(
                    signaling: signaling, peerId: peerId, role: role, iceServers: servers,
                    iceTransportPolicy: relayOnly ? .relay : .all,
                    authenticationGeneration: generation,
                    receiveDirectory: directory, admission: admission,
                    deadlines: LinkDeadlines(), initialSignal: signal,
                    buildInitialTransport: { _, _, _, _, _, _, _ in QuietTransport() },
                    buildReplacementFactory: { _, _, _, _ in
                        { _ in throw LinkTransportError.notReady }
                    })
            })
        let pair = StubPair()
        let directCode = PairingCodeModel(client: pair)
        let module = TransferModule(route: .pairingCode, link: link, code: directCode)
        // `RelayiumApp`, verbatim.
        link.onPairingLinkActivated = { directCode.cancel() }
        link.onPairingRoomRetired = { directCode.cancel() }
        let rig = Rig(module: module, pair: pair)
        box = rig
        return rig
    }

    private func settle(_ turns: Int = 20) async {
        for _ in 0..<turns { await Task.yield() }
    }

    /// `CrossNetworkConnectPane.createCode` + `PairingCodeStart.createAndWatch`,
    /// in their order: claim, mint, watch. Inlined for the reason
    /// `TransferSurfaceReleaseTests` records — the Mac starter cannot be
    /// imported — and it is only the way INTO the state under test.
    private func create(_ rig: Rig) async {
        XCTAssertTrue(rig.module.presence.beginSession(.pairingCode))
        await rig.code.mint(token: "token")
        guard let minted = rig.code.state.code else {
            return XCTFail("the first code was never minted: \(rig.code.state)")
        }
        XCTAssertTrue(rig.link.watchPairingCode(minted, legacyRole: .initiator,
                                                files: [], sources: []))
        await settle()
        XCTAssertEqual(rig.link.connection, .watching(code: "483920"))
        XCTAssertEqual(rig.module.presence.owner, .pairingCode)
    }

    /// A peer that speaks `link/1` turns up in one of this module's rooms —
    /// the newest unless a test names an older one.
    private func linkPeerArrives(_ rig: Rig, inRoom index: Int? = nil) async {
        let room = rig.channels[index ?? rig.channels.count - 1]
        room.fire(Envelope(type: SignalType.welcome, name: "aaa-mac"))
        room.fire(Envelope(type: SignalType.signal, from: "zzz-web",
                           data: .object(["caps": .array([.string(LINK_CAPABILITY)])])))
        room.fire(Envelope(type: SignalType.peers, peers: [Peer(id: "zzz-web", name: "peer")]))
        await settle()
    }

    // MARK: - the rig is the Mac's

    /// The rig above claims to be the macOS composition. This is what holds it
    /// to that: if `RelayiumApp` or the link factory change their answers, the
    /// behavioural cases below are about a graph nobody ships, and this says so.
    func testTheRigIsWiredTheWayTheMacAppWiresIt() throws {
        let app = try RepoRoot.text("apps/mac/Relayium/RelayiumApp.swift")
        for wiring in [
            "let directModule = TransferModule(route: .pairingCode, link: directLink, code: directCode)",
            "directLink.onPairingLinkActivated = { directCode.cancel() }",
            "directLink.onPairingRoomRetired = { directCode.cancel() }",
        ] {
            XCTAssertTrue(app.contains(wiring), "RelayiumApp no longer says: \(wiring)")
        }
        XCTAssertFalse(app.contains("directModule.presence.claim("),
                       "the app now re-claims the surface itself; re-read what this suite assumes")

        let environment = try RepoRoot.text(
            "apps/RelayiumKit/Sources/RelayiumAppKit/AppEnvironment.swift")
        let factory = try XCTUnwrap(environment
            .components(separatedBy: "public static func makeDirectLinkWorkspaceModel(")
            .dropFirst().first?.components(separatedBy: "\n    }").first)
        for answer in ["linkRoomActive: { linkRoomActive(isCodelessRoom: false) }",
                       "legacyFallback: .terminateUnsupported",
                       "localHello: linkOnlyCapsHello(linkRoomActive:)",
                       "pendingMessages: .refuseWhileWaiting"] {
            XCTAssertTrue(factory.contains(answer),
                          "the Mac direct link is no longer built with: \(answer)")
        }
    }

    // MARK: - the defect, kept as a control

    /// **CONTROL — the body macOS 1.4.1 shipped, transcribed, on this rig.**
    ///
    /// `link.leave(); link.dismiss(); await createAndWatch(token:)` is gone from
    /// the product; it is kept HERE so the suite records what was wrong and
    /// proves this rig can tell the difference. Every assertion below is the
    /// defect. If one of them stops holding, the graph has changed underneath
    /// the repair and the cases after this one need re-reading — it does not
    /// mean the old body became safe to restore.
    func testControl_TheShippedThreeLineBodyLosesTheSurfaceOnThisRig() async throws {
        let rig = try macRig()
        await create(rig)
        var states: [PairingCodeState] = []
        let watching = rig.code.$state.dropFirst().sink { states.append($0) }
        defer { watching.cancel() }

        rig.link.leave()
        XCTAssertEqual(rig.code.state, .idle,
                       "the old comment said the code model never passes through .idle")
        rig.link.dismiss()
        XCTAssertNil(rig.module.presence.owner,
                     "the old comment said ownership is never touched")
        await rig.code.mint(token: "token")
        let minted = try XCTUnwrap(rig.code.state.code)
        XCTAssertTrue(rig.link.watchPairingCode(minted, legacyRole: .initiator,
                                                files: [], sources: []))
        await settle()

        // Both visible halves look right…
        XCTAssertEqual(states, [.idle, .minting, .showing("774051", expiresAt: 4_102_444_800)])
        XCTAssertEqual(rig.joinedCodes, ["483920", "774051"])
        XCTAssertEqual(rig.link.connection, .watching(code: "774051"))
        // …over a surface nobody owns, whose own controls are refused.
        XCTAssertNil(rig.module.presence.owner)
        XCTAssertFalse(rig.module.acceptsNewSession)

        await linkPeerArrives(rig)
        XCTAssertTrue(rig.link.hasSession, "the control needs a peer that really linked")
        XCTAssertNil(rig.module.presence.owner)
        XCTAssertEqual(rig.module.pane, .connect,
                       "the defect: a linked peer on the replacement code is never drawn")
    }

    // MARK: - the repair

    /// **THE case: a peer that links on the REPLACEMENT code is drawn.**
    func testAPeerOnTheReplacementCodeOpensTheWorkspace() async throws {
        let rig = try macRig()
        await create(rig)

        await rig.start.regenerate(token: "token")
        await settle()

        XCTAssertEqual(rig.code.state.code, "774051", "the replacement code was never minted")
        XCTAssertEqual(rig.joinedCodes, ["483920", "774051"],
                       "the replacement code's room was not watched")
        XCTAssertEqual(rig.link.connection, .watching(code: "774051"))
        XCTAssertTrue(rig.channels[0].closed,
                      "the dead room's socket outlived the code that named it")
        XCTAssertFalse(rig.channels[1].closed)
        XCTAssertEqual(rig.module.presence.owner, .pairingCode,
                       "replacing a code gave away the surface it was replacing the code on")
        XCTAssertEqual(rig.module.pane, .connect, "a waiting code is still the connect surface")

        await linkPeerArrives(rig)
        XCTAssertTrue(rig.link.hasSession)
        XCTAssertEqual(rig.module.presence.owner, .pairingCode)
        XCTAssertEqual(rig.module.pane, .link,
                       "a peer linked on the replacement code and the workspace never opened")
        XCTAssertEqual(rig.code.state, .idle, "the spent replacement stayed on screen")
    }

    /// The order the action now has, observed rather than read: the dead room
    /// goes first (or the new one is refused), the claim is back BEFORE the
    /// mint suspends, and exactly one new room is opened, after the mint.
    func testTheDeadRoomGoesFirstAndTheClaimIsBackBeforeTheMintSuspends() async throws {
        let rig = try macRig()
        await create(rig)

        rig.pair.holdNextMint()
        let replacing = Task { await rig.start.regenerate(token: "token") }
        await settle()

        XCTAssertTrue(rig.channels[0].closed, "the mint started over a room still held")
        XCTAssertEqual(rig.link.connection, .idle)
        XCTAssertEqual(rig.code.state, .minting)
        XCTAssertEqual(rig.joinedCodes, ["483920"], "a room was opened before there was a code")
        XCTAssertEqual(rig.module.presence.owner, .pairingCode,
                       "the claim was not retaken before the mint suspended")

        rig.pair.answerHeldMint()
        await replacing.value
        await settle()
        XCTAssertEqual(rig.joinedCodes, ["483920", "774051"])
        XCTAssertEqual(rig.link.connection, .watching(code: "774051"))
    }

    /// The surface is held for the whole replacement, including the mint — so a
    /// second start is refused rather than raced.
    func testTheSurfaceIsHeldWhileAReplacementCodeIsStillBeingMinted() async throws {
        let rig = try macRig()
        await create(rig)

        rig.pair.holdNextMint()
        let replacing = Task { await rig.start.regenerate(token: "token") }
        await settle()

        XCTAssertEqual(rig.code.state, .minting)
        XCTAssertEqual(rig.module.presence.owner, .pairingCode,
                       "the surface was released under a replacement the user asked for")
        XCTAssertFalse(rig.module.acceptsNewSession,
                       "a second start was allowed while a replacement was minting")

        rig.pair.answerHeldMint()
        await replacing.value
        await settle()
        XCTAssertEqual(rig.module.pane, .connect)
        XCTAssertEqual(rig.link.connection, .watching(code: "774051"))
        XCTAssertEqual(rig.module.presence.owner, .pairingCode)
    }

    /// Cancel, pressed while the replacement is minting: the late answer writes
    /// no digits, opens no room, and the module is given back completely.
    func testCancellingWhileAReplacementIsMintingReopensNothing() async throws {
        let rig = try macRig()
        await create(rig)

        rig.pair.holdNextMint()
        let replacing = Task { await rig.start.regenerate(token: "token") }
        await settle()
        XCTAssertEqual(rig.code.state, .minting)

        rig.module.cancelPairingCode()
        rig.pair.answerHeldMint()
        await replacing.value
        await settle()

        XCTAssertEqual(rig.code.state, .idle,
                       "a cancelled replacement wrote its code onto a surface the user had left")
        XCTAssertEqual(rig.joinedCodes, ["483920"], "a cancelled replacement opened a room")
        XCTAssertEqual(rig.link.connection, .idle)
        XCTAssertNil(rig.module.presence.owner)
        XCTAssertTrue(rig.module.acceptsNewSession)
        XCTAssertTrue(rig.channels[0].closed)
    }

    /// A second press of New code during the mint is refused, not run.
    func testASecondReplacementPressedDuringAMintIsRefused() async throws {
        let rig = try macRig()
        await create(rig)

        rig.pair.holdNextMint()
        let replacing = Task { await rig.start.regenerate(token: "token") }
        await settle()
        XCTAssertEqual(rig.code.state, .minting)

        await rig.start.regenerate(token: "token")
        XCTAssertEqual(rig.code.state, .minting,
                       "a second press restarted the mint the first one was waiting on")

        rig.pair.answerHeldMint()
        await replacing.value
        await settle()
        XCTAssertEqual(rig.joinedCodes, ["483920", "774051"], "one replacement opened two rooms")
        XCTAssertEqual(rig.link.connection, .watching(code: "774051"))
        XCTAssertEqual(rig.module.presence.owner, .pairingCode)
    }

    /// An activation delivered from a card that a link has already replaced
    /// must not take that link down.
    func testAReplacementCannotTearDownALinkThatHasAlreadyClaimedThePeer() async throws {
        let rig = try macRig()
        await create(rig)
        await linkPeerArrives(rig)
        XCTAssertTrue(rig.link.hasSession)

        await rig.start.regenerate(token: "token")
        await settle()

        XCTAssertTrue(rig.link.hasSession, "a stale replacement ended a live link")
        XCTAssertEqual(rig.module.pane, .link)
        XCTAssertEqual(rig.joinedCodes, ["483920"], "a stale replacement opened a second room")
        XCTAssertEqual(rig.code.state, .idle, "a stale replacement drew digits over a live link")
        XCTAssertFalse(rig.channels[0].closed, "a stale replacement closed the live link's room")
    }

    /// **A replacement whose mint fails leaves a truthful screen.**
    ///
    /// The dead room is gone either way — it was dead. What must be true is
    /// that the failure is readable on a surface this module still owns, that
    /// no room was opened for digits that do not exist, and that dismissing it
    /// gives the module back so the user can try again.
    func testAFailedReplacementKeepsItsMessageAndDismissGivesTheSurfaceBack() async throws {
        let rig = try macRig()
        await create(rig)

        rig.pair.failFromNowOn()
        await rig.start.regenerate(token: "token")
        await settle()

        guard case .failed = rig.code.state else {
            return XCTFail("a failed replacement left no message: \(rig.code.state)")
        }
        XCTAssertEqual(rig.joinedCodes, ["483920"],
                       "a room was opened for a code that was never minted")
        XCTAssertTrue(rig.channels[0].closed)
        XCTAssertEqual(rig.link.connection, .idle)
        XCTAssertEqual(rig.module.presence.owner, .pairingCode,
                       "the failure is on a surface nobody owns, so nothing draws it as this module's")
        XCTAssertFalse(rig.module.acceptsNewSession,
                       "a second start was allowed over an unread failure")

        rig.module.cancelPairingCode()
        await settle()
        XCTAssertEqual(rig.code.state, .idle)
        XCTAssertNil(rig.module.presence.owner)
        XCTAssertTrue(rig.module.acceptsNewSession)
    }

    /// **A late event from the superseded room cannot touch the new code.**
    ///
    /// The peer that was given the OLD digits turns up in the old room after
    /// the replacement is on screen. That room is closed and detached: no link
    /// begins, the new digits stay, and the new room is still the one watched —
    /// and a peer on the NEW digits is then admitted normally.
    func testALatePeerInTheSupersededRoomCannotTouchTheReplacement() async throws {
        let rig = try macRig()
        await create(rig)
        await rig.start.regenerate(token: "token")
        await settle()

        await linkPeerArrives(rig, inRoom: 0)
        rig.channels[0].fireRemoteClose()
        await settle()

        XCTAssertFalse(rig.link.hasSession, "a peer in the superseded room began a link")
        XCTAssertEqual(rig.code.state.code, "774051",
                       "an event from the superseded room retired the replacement code")
        XCTAssertEqual(rig.link.connection, .watching(code: "774051"))
        XCTAssertFalse(rig.channels[1].closed)
        XCTAssertEqual(rig.module.presence.owner, .pairingCode)

        await linkPeerArrives(rig)
        XCTAssertTrue(rig.link.hasSession)
        XCTAssertEqual(rig.module.pane, .link)
    }
}
