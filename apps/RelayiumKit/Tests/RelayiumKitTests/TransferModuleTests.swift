import Combine
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// **Two transfer modules that share nothing.**
///
/// The owner's requirement, stated as behaviour: a same-network connection has
/// to survive a visit to the Cross-network screen and still be connected on
/// return, a pairing connection has to survive a visit to the LAN screen the
/// same way, and cancelling one must not touch the other.
///
/// Navigation is not modelled here, and deliberately: on macOS navigating is one
/// assignment to `AppNavigationModel.selection` and touches no model at all
/// (`AppNavigationModel.select` is asserted to do exactly that in
/// `AppRoutingTests`). What actually decided whether a session survived it was
/// *what a screen could reach* — one shared `TransferPresence` over one shared
/// set of models. So these assertions are about that: what each module owns,
/// what it can lock, and what its exit reaches.
///
/// The runtime half — a built app with two live connections, navigated between
/// and cancelled one at a time — is `RelayiumUITests.LocalSessionUITests` and
/// `scripts/macos-ui-session-acceptance.sh`.
@MainActor
final class TransferModuleTests: XCTestCase {
    private var directories: [URL] = []

    override func tearDownWithError() throws {
        for directory in directories {
            try? FileManager.default.removeItem(at: directory)
        }
        directories = []
    }

    // MARK: - building a module out of drivable parts

    private final class StubPair: PairCodeClient {
        func mint(token: String) async throws -> MintedCode {
            MintedCode(code: "483920", expiresAt: 4_102_444_800)
        }
    }

    private final class StubICE: ICEConfigClient {
        func fetch(code: String) async throws -> ICEConfig { throw AccountError.network }
    }

    private func temporaryDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("module-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        directories.append(directory)
        return directory
    }

    /// A module whose parts are all drivable and none of which reach a network.
    ///
    /// The models are the PRODUCTION types — only their clients are stubs — so
    /// what is under test is the module's own wiring rather than a rehearsal of
    /// it.
    private func makeModule(route: AppDestination) throws -> TransferModule {
        let directory = try temporaryDirectory()
        return TransferModule(
            route: route,
            link: LinkWorkspaceModel(capabilities: PeerCapabilityRegistry(linkRoomActive: { true }),
                                     receiveDirectory: { directory },
                                     requiresVerification: { false },
                                     iceClient: nil,
                                     legacyFallback: .terminateUnsupported),
            code: PairingCodeModel(client: StubPair()))
    }

    private func makeModules() throws -> (nearby: TransferModule, direct: TransferModule) {
        (try makeModule(route: .nearby), try makeModule(route: .pairingCode))
    }

    // MARK: - the independence itself

    /// The property the whole change exists for: a session claimed in one module
    /// leaves the other module completely free.
    ///
    /// Before the split there was one `TransferPresence`, so this claim made
    /// `acceptsNewSession` false on BOTH destinations — which is what a user
    /// experienced as "the other screen is dead while I am connected here".
    func testASessionInOneModuleLeavesTheOtherFreeToStartOne() throws {
        let (nearby, direct) = try makeModules()

        XCTAssertTrue(nearby.presence.beginSession(.nearby, mode: .files,
                                                   peerLabel: "Studio Mac"))
        XCTAssertEqual(nearby.presence.owner, .nearby)
        XCTAssertNil(direct.presence.owner,
                     "a same-network claim took ownership of the pairing surface")
        XCTAssertFalse(nearby.acceptsNewSession,
                       "a module must still refuse a second session of its own")
        XCTAssertTrue(direct.acceptsNewSession,
                      "a same-network session locked the pairing screen")

        // And the same in the other direction, at the same time — which is the
        // state the shared presence could never be in.
        XCTAssertTrue(direct.presence.beginSession(.pairingCode, mode: .files))
        XCTAssertEqual(nearby.presence.owner, .nearby)
        XCTAssertEqual(direct.presence.owner, .pairingCode)
    }

    /// Each module draws its own session and never the other's.
    func testEachModuleDrawsOnlyItsOwnSession() throws {
        let (nearby, direct) = try makeModules()
        nearby.presence.beginSession(.nearby, mode: .files)

        XCTAssertEqual(nearby.pane, .connect,
                       "a claim with no link session yet draws the connect surface")
        XCTAssertEqual(direct.pane, .connect,
                       "the pairing screen rendered a session belonging to LAN Transfer")
        XCTAssertTrue(nearby.presence.rendersSession(.nearby))
        XCTAssertFalse(direct.presence.rendersSession(.nearby),
                       "the pairing module claims to render a same-network session")
    }

    /// Navigating away and back is, on this platform, exactly "read the module
    /// again" — the destination is rebuilt from the same app-scoped object. So
    /// the property to hold is that nothing about reading it changes it.
    func testReadingAModuleRepeatedlyNeverEndsItsSession() throws {
        let (nearby, direct) = try makeModules()
        nearby.presence.beginSession(.nearby, mode: .files, peerLabel: "Studio Mac")
        direct.presence.beginSession(.pairingCode, mode: .text)

        // Ten rebuilds of both screens, in the order a user alternating between
        // them would produce.
        for _ in 0..<10 {
            _ = nearby.pane
            _ = nearby.acceptsNewSession
            _ = nearby.sessionIsLiveOrRetained
            _ = direct.pane
            _ = direct.acceptsNewSession
            _ = direct.sessionIsLiveOrRetained
        }

        XCTAssertEqual(nearby.presence.owner, .nearby)
        XCTAssertEqual(nearby.presence.mode, .files)
        XCTAssertEqual(nearby.presence.sessionPeerLabel, "Studio Mac")
        XCTAssertEqual(direct.presence.owner, .pairingCode)
        XCTAssertEqual(direct.presence.mode, .text)
    }

    /// The reconstruction claim a rebuilt destination makes is idempotent for
    /// its own module and cannot reach the other's.
    ///
    /// This is the shape `AppShellView`'s `reconcileIncoming` takes when the
    /// window is closed and reopened while a same-network session is running.
    func testAReconstructionClaimTouchesOnlyItsOwnModule() throws {
        let (nearby, direct) = try makeModules()
        nearby.presence.beginSession(.nearby, mode: .files, peerLabel: "Studio Mac")
        direct.presence.beginSession(.pairingCode, mode: .files)

        XCTAssertTrue(nearby.presence.claim(.nearby, mode: .files))
        XCTAssertEqual(nearby.presence.sessionPeerLabel, "Studio Mac")
        XCTAssertEqual(direct.presence.owner, .pairingCode,
                       "rebuilding the LAN screen disturbed the pairing session")
    }

    // MARK: - cancelling one module

    /// **Cancel is scoped, and Quit is not.** The two verbs the owner asked to be
    /// distinguishable.
    func testCancellingOneModuleLeavesTheOtherSessionExactlyWhereItWas() throws {
        let (nearby, direct) = try makeModules()
        nearby.presence.beginSession(.nearby, mode: .files, peerLabel: "Studio Mac")
        direct.presence.beginSession(.pairingCode, mode: .text)

        nearby.cancelEverything()

        XCTAssertNil(nearby.presence.owner, "a module's own cancel must give up its surface")
        XCTAssertEqual(direct.presence.owner, .pairingCode,
                       "cancelling LAN Transfer ended the pairing session too")
        XCTAssertEqual(direct.presence.mode, .text,
                       "cancelling one module repointed the other's lane")
        XCTAssertTrue(nearby.acceptsNewSession,
                      "a cancelled module cannot start a new session")
    }

    /// And the whole-app teardown really does reach both — the quit guard's job,
    /// and the one place that is allowed to do it.
    func testTheAppWideTeardownEndsBothModules() throws {
        let (nearby, direct) = try makeModules()
        nearby.presence.beginSession(.nearby, mode: .files)
        direct.presence.beginSession(.pairingCode, mode: .files)

        TransferModules(nearby: nearby, direct: direct).cancelEverything()

        XCTAssertNil(nearby.presence.owner)
        XCTAssertNil(direct.presence.owner)
    }

    /// A module reports activity and typed text for itself alone; the container
    /// is the only thing that answers for both.
    func testActivityAndTextAreReportedPerModuleAndOnlyAggregatedByTheContainer() throws {
        let (nearby, direct) = try makeModules()
        let modules = TransferModules(nearby: nearby, direct: direct)

        XCTAssertFalse(modules.isBusy)
        XCTAssertFalse(modules.hasLocalText)
        XCTAssertEqual(modules.module(for: .nearby)?.route, .nearby)
        XCTAssertEqual(modules.module(for: .pairingCode)?.route, .pairingCode)
        for route in [AppDestination.storedSend, .storedReceive, .deviceInbox, .account] {
            XCTAssertNil(modules.module(for: route),
                         "\(route) is not a transfer module and must not resolve to one")
        }
        XCTAssertEqual(modules.all.map(\.route), [.nearby, .pairingCode])
    }

    // MARK: - liveness, per module

    /// Ownership is released on the module's own all-idle edge and on nothing
    /// else — including the other module reaching it.
    func testOwnershipIsReleasedOnThisModulesOwnIdleEdgeOnly() throws {
        let (nearby, direct) = try makeModules()
        let nearbyLiveness = PassthroughSubject<Bool, Never>()
        let directLiveness = PassthroughSubject<Bool, Never>()
        // Replaces the module's own subscription, which is what a real session
        // would drive. The point under test is the SCOPE of the release, so the
        // source is substituted and the wiring is not.
        nearby.presence.observeSessionLiveness(nearbyLiveness.eraseToAnyPublisher())
        direct.presence.observeSessionLiveness(directLiveness.eraseToAnyPublisher())

        nearby.presence.beginSession(.nearby, mode: .files)
        direct.presence.beginSession(.pairingCode, mode: .files)
        nearbyLiveness.send(true)
        directLiveness.send(true)

        directLiveness.send(false)
        XCTAssertNil(direct.presence.owner, "the pairing module kept a surface with nothing on it")
        XCTAssertEqual(nearby.presence.owner, .nearby,
                       "a pairing session ending released the same-network surface")

        nearbyLiveness.send(false)
        XCTAssertNil(nearby.presence.owner)
    }

    /// A module built with somebody else's presence is the one construction that
    /// would quietly restore the shared arbitration, so the two the app builds
    /// must not be able to.
    func testTwoModulesNeverShareOnePresence() throws {
        let (nearby, direct) = try makeModules()
        XCTAssertFalse(nearby.presence === direct.presence)
        XCTAssertFalse(nearby.link === direct.link)
        XCTAssertFalse(nearby.code === direct.code,
                       "one code model would let a code minted on the pairing screen "
                       + "appear on the same-network one")
    }

    /// Observing a module redraws for its own objects and not for the other's.
    ///
    /// The relay is what lets a view observe one module instead of four objects;
    /// a relay that forwarded both modules would put every pairing keystroke
    /// through the LAN screen's body.
    func testAModulePublishesItsOwnChangesAndNotTheOtherModulesChanges() throws {
        let (nearby, direct) = try makeModules()
        var nearbyChanges = 0
        var directChanges = 0
        let subscriptions = [
            nearby.objectWillChange.sink { _ in nearbyChanges += 1 },
            direct.objectWillChange.sink { _ in directChanges += 1 },
        ]
        defer { subscriptions.forEach { $0.cancel() } }

        direct.presence.beginSession(.pairingCode, mode: .files)

        XCTAssertGreaterThan(directChanges, 0,
                             "a module did not republish its own presence's change")
        XCTAssertEqual(nearbyChanges, 0,
                       "a change in one module redrew the other module's screen")
    }

    // MARK: - the inbound-availability gate

    /// **A module watching its own pairing room must ADMIT the peer that code
    /// names.**
    ///
    /// This is the deterministic half of a shipped defect the built-App run
    /// found. `LinkAdmission.route` answers an inbound link request arriving
    /// into an idle room with `.busy` whenever `canAcceptLink` is false, and
    /// that predicate is fed from the module's surface ownership. A watched
    /// pairing room is exactly that idle room. Minting or joining a code claims
    /// the surface BEFORE the room is watched, so from the moment a code existed
    /// the gate said "busy" to everybody — including the one peer the room was
    /// opened for.
    ///
    /// Whether it mattered depended on `linkRole`: the smaller hub id must
    /// offer, so only when this side was the offerer did the peer send a request
    /// and get refused. The hub assigns ids at random, so the shipped symptom is
    /// a cross-network pairing that fails about half the time with no error on
    /// either screen — measured exactly once as `link: requesting` followed by
    /// `ended(refused)` on a counterpart, against an app still drawing its code.
    ///
    /// Nothing in the repository could catch it: the only macOS pairing endpoint
    /// any acceptance drives is the headless `AppPairLinkHost`, which has no
    /// `TransferPresence` and never installs this observer at all.
    func testAWatchedPairingRoomAdmitsThePeerItsCodeNames() {
        // The defect, stated as the case that used to be false.
        XCTAssertTrue(
            TransferModule.acceptsInboundLink(owner: .pairingCode,
                                              connection: .watching(code: "483920")),
            "a module watching its own code refuses the peer that code names")
        // The original rule, unchanged: nothing owns the surface, so an
        // unsolicited link may take it.
        for connection in [LinkWorkspaceConnection.idle, .ended(.closed)] {
            XCTAssertTrue(TransferModule.acceptsInboundLink(owner: nil,
                                                            connection: connection),
                          "an idle module refuses an unsolicited link: \(connection)")
        }
    }

    /// **And a module that has already admitted somebody still refuses.**
    ///
    /// The widening is scoped to `watching` on purpose. `requesting`,
    /// `establishing` and `open` all mean a peer has been admitted, and
    /// answering "available" in any of them would invite a SECOND peer into a
    /// module that holds one session — which is the opposite defect, and a worse
    /// one, because it interrupts a connection that is working.
    ///
    /// This answer is advisory, and staying strict here does NOT refuse the peer
    /// the module is already connecting to: `LinkAdmission` applies it only to a
    /// room bound to nobody, and answers `alreadyInFlight` to a request or offer
    /// from the exact peer it already holds. See
    /// `LinkAdmissionTests.testACrossingRequestFromThePeerBeingEstablishedWithSurvivesAClaimedSurface`.
    func testAModuleThatHasAdmittedAPeerStillRefusesTheNextOne() {
        for connection in [LinkWorkspaceConnection.requesting,
                           .establishing(sas: nil),
                           .establishing(sas: "123456"),
                           .open(sas: "123456"),
                           .ended(.closed),
                           .idle] {
            XCTAssertFalse(
                TransferModule.acceptsInboundLink(owner: .pairingCode, connection: connection),
                "a module holding its surface admitted a second link in \(connection)")
        }
        // Same for the Nearby module, whose link can never be `watching` at all:
        // its factory is handed no `connectPairingSocket`, so `watchPairingCode`
        // has nothing to open. The widening is therefore inert there by
        // construction rather than by this rule.
        XCTAssertFalse(TransferModule.acceptsInboundLink(owner: .nearby,
                                                         connection: .requesting))
    }

    /// The connection state the gate turns on, on its own.
    func testOnlyAWatchedPairingRoomReportsItself() {
        XCTAssertTrue(LinkWorkspaceConnection.watching(code: "483920").isWatchingPairingRoom)
        for other in [LinkWorkspaceConnection.idle, .requesting, .establishing(sas: nil),
                      .open(sas: "123456"), .ended(.closed)] {
            XCTAssertFalse(other.isWatchingPairingRoom,
                           "\(other) claims to be a watched pairing room")
        }
    }

    /// **The gate the app actually feeds, driven through the real transitions.**
    ///
    /// `TransferModule.acceptsInboundLink` is the rule; this is the wiring. The
    /// publisher has to reach `LinkWorkspaceModel`'s advisory gate, and it has to
    /// do it for the state the surface is really in when a peer asks — which is
    /// the ordering the shipped defect got wrong.
    ///
    /// `watchPairingCode` publishes `.watching` SYNCHRONOUSLY and opens the room
    /// in the same turn, so a client whose ICE never resolves parks the model in
    /// exactly the state under test — now with a live socket, because the join
    /// no longer waits for the configuration.
    ///
    /// The socket is therefore REAL here rather than a `preconditionFailure`.
    /// That is the changed contract, and asserting it is the point: the room is
    /// joined a round trip early, and the safety it used to get from the
    /// ordering of two statements now comes from the room's own relay gate. So
    /// this also pins the other half — for the whole of that window nothing is
    /// assembled and nothing this device authored reaches the wire beyond the
    /// join itself.
    func testTheAdvisoryGateFollowsTheModuleThroughAPairingWatch() throws {
        let directory = try temporaryDirectory()
        let channel = FakeWebSocketChannel()
        let link = LinkWorkspaceModel(
            capabilities: PeerCapabilityRegistry(linkRoomActive: { true }),
            receiveDirectory: { directory },
            requiresVerification: { false },
            iceClient: HangingICE(),
            connectPairingSocket: { _ in
                let socket = SignalingClient(channel: channel, name: "Mac")
                channel.fireOpen()
                return socket
            },
            pairingRoomHandle: LinkRoomHandle(),
            assemble: { _, _, _, _, _, _, _, _, _ in
                XCTFail("nothing may be assembled while the room has no configuration")
                fatalError()
            })
        let module = TransferModule(route: .pairingCode, link: link,
                                    code: PairingCodeModel(client: StubPair()))

        XCTAssertTrue(link.acceptsInboundLinkNow,
                      "an idle module refuses an unsolicited link")

        // Claiming the surface for a code closes the gate — this is the state
        // the shipped build then stayed in for the whole life of the code.
        module.presence.beginSession(.pairingCode)
        XCTAssertFalse(link.acceptsInboundLinkNow,
                       "a claimed surface still admits an unsolicited link")

        // …and watching the room the code names REOPENS it, for the peer that
        // code names. Without this the peer's request is answered `busy` and the
        // pairing fails on exactly the role assignments where the peer is the
        // one that asks.
        XCTAssertTrue(link.watchPairingCode("483920", legacyRole: .initiator),
                      "the model refused to watch a code at all")
        XCTAssertEqual(link.connection, .watching(code: "483920"))
        XCTAssertTrue(link.acceptsInboundLinkNow,
                      "a module watching its own pairing room refuses the peer that "
                      + "code names — the request is answered busy and the pairing "
                      + "fails with no error on either screen")

        // **The room is joined in the same turn, with the fetch still hanging.**
        //
        // This is the concurrency change stated as behaviour, and it is what
        // this test now costs a fake socket to say: the hub has been told this
        // side is in the code before `/api/ice` has answered anything, so the
        // roster, the capability hellos and the peer's own announcement all
        // start a round trip sooner. Under the previous order the socket did not
        // exist yet and this assertion could not be written at all.
        XCTAssertTrue(channel.isOpen, "the room was not joined until ICE answered")
        XCTAssertEqual(channel.sent.count, 1,
                       "the only frame a room with no configuration may author is its join")

        // …and the other half, which is what makes the first half safe. For the
        // whole of that window the relay gate is shut and the router's handoff
        // is held, so nothing is assembled — `assemble` above fails the test if
        // anything is — and this side authors nothing further on the wire.
        for _ in 0..<14 { RunLoop.current.run(until: Date()) }
        XCTAssertEqual(link.connection, .watching(code: "483920"),
                       "a room still waiting for its configuration left `watching` on its own")
        XCTAssertEqual(channel.sent.count, 1,
                       "a room with no configuration put a frame of its own on the wire")

        // Leaving the room closes it again: there is no code any more, and the
        // surface is still claimed until the pane releases it. The socket the
        // watch opened goes with it — under the previous order there was none to
        // leak, and now there is.
        link.leave()
        XCTAssertFalse(link.acceptsInboundLinkNow,
                       "a module that left its room still admits an inbound link")
        XCTAssertTrue(channel.closed,
                      "leaving a watched code left this device in its pairing room")
    }
}

/// An ICE client whose answer never arrives.
///
/// `watchPairingCode` now opens the room without waiting for it, so this parks a
/// model in `.watching` WITH a live socket and no configuration — the window the
/// relay gate exists to hold — without any network or any timing.
private struct HangingICE: ICEConfigClient {
    func fetch(code: String) async throws -> ICEConfig {
        try await Task.sleep(nanoseconds: 60_000_000_000)
        throw AccountError.network
    }
}

