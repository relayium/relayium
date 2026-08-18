import Combine
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// **When a transfer module may give up its surface — and the two creator-side
/// paths where it must not.**
///
/// The invariant is one sentence: `presence.owner == nil` while a legacy model
/// or the `LinkWorkspaceModel` still retains work. Breaking it is not a cosmetic
/// disagreement. `TransferSurfacePresentation.pane` answers `.connect` for an
/// unowned surface, and `acceptsNewSession` answers false for a module whose
/// `sessionIsLiveOrRetained` is true, so the two together draw the connect
/// screen with `transfer.busyElsewhere` across it — over a `link/1` that is
/// still open and now has no exit anywhere in the window. Nothing on screen can
/// end it, and nothing in the process will: the app-scoped liveness observer
/// releases on the all-idle edge, which a live link never reaches. The user's
/// only recovery is relaunching.
///
/// Two creator paths reach it, and both are a view releasing on ONE lane's idea
/// of idle:
///
///  1. **The protocol handoff, LATENT.** `pairingPeerAnnounced` publishes a real
///     link attempt and only then calls `onPairingLinkActivated`, which cancels
///     the legacy model that had been rendering the creator's code. That lane
///     going `.idle` is the handoff completing, not the session ending. Measured
///     in the built app the shipped pane did not actually release here — both
///     publishes land in one main-actor turn, so the update that follows swaps
///     the session pane out for the link pane and the removed pane's `onChange`
///     never runs. That is update-ordering luck rather than a guarantee, so the
///     tests below pin the RULE and reproduce what an unguarded release would
///     produce, without claiming a user saw it by this route.
///  2. **Cancelling or expiring a creator's code — OBSERVED.** Ending only the
///     lane left `.watching(code:)` and its socket alive. `watchPairingCode`
///     refuses a second room while one is held, so the next code that process
///     minted was never watched — six digits nothing was listening on, and a
///     fall back to the legacy wire for whoever typed them. The real macOS
///     acceptance fails on exactly that against the shipped pane.
///
/// Everything here drives the PRODUCTION objects. The link runs a real
/// `LinkWorkspaceModel` over a fake socket the test feeds hub frames to, so the
/// handoff below is the product's own transition and not a rehearsal of it.
///
/// The runtime half is `RelayiumUITests.LocalSessionUITests`
/// `testCreatingAPairingCodeSurvivesTheLinkHandoffAndACancelledCode`, driven by
/// `scripts/macos-ui-session-acceptance.sh`. Run against the shipped pane it
/// fails with `legacyPeer=true` on the code minted after a cancel; run against
/// this change it passes, with both counterparts serving a real `link/1`.
@MainActor
final class TransferSurfaceReleaseTests: XCTestCase {

    // MARK: - doubles

    private final class StubPair: PairCodeClient, @unchecked Sendable {
        private let lock = NSLock()
        private var _codes: [String] = ["483920", "771155"]
        private var _minted: [String] = []
        var minted: [String] { lock.lock(); defer { lock.unlock() }; return _minted }

        func mint(token: String) async throws -> MintedCode {
            lock.lock()
            let code = _codes.isEmpty ? "999999" : _codes.removeFirst()
            _minted.append(code)
            lock.unlock()
            return MintedCode(code: code, expiresAt: 4_102_444_800)
        }
    }

    private final class StubICE: ICEConfigClient, @unchecked Sendable {
        private let lock = NSLock()
        private var _codes: [String] = []
        var codes: [String] { lock.lock(); defer { lock.unlock() }; return _codes }

        func fetch(code: String) async throws -> ICEConfig {
            lock.lock(); _codes.append(code); lock.unlock()
            return ICEConfig(iceServers: [
                ICEServerConfig(urls: ["stun:stun.relayium.test:3478"]),
            ])
        }
    }

    /// Fires nothing until a test says so. The capability window is the only
    /// timer these paths arm, and leaving it unfired is what keeps "the peer
    /// announced `link/1`" and "the peer never announced" two separate,
    /// deterministic cases rather than a race with a wall clock.
    private final class ManualScheduler: LinkRecoveryScheduler, @unchecked Sendable {
        private final class Box: @unchecked Sendable {
            private let lock = NSLock()
            private var value = false
            var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return value }
            func cancel() { lock.lock(); value = true; lock.unlock() }
        }

        private final class Handle: LinkRecoveryTimer {
            let box: Box
            init(box: Box) { self.box = box }
            func cancel() { box.cancel() }
        }

        private let lock = NSLock()
        private var pending: [(delay: TimeInterval, body: () -> Void, cancelled: Box)] = []

        func schedule(after delay: TimeInterval, _ body: @escaping () -> Void) -> LinkRecoveryTimer {
            let box = Box()
            lock.lock(); pending.append((delay, body, box)); lock.unlock()
            return Handle(box: box)
        }

        /// Fire every live timer whose delay is at most `delay`, once.
        func advance(to delay: TimeInterval) {
            lock.lock()
            let due = pending.filter { $0.delay <= delay && !$0.cancelled.isCancelled }
            pending.removeAll { $0.delay <= delay }
            lock.unlock()
            for item in due { item.body() }
        }
    }

    /// The transport a resolved `link/1` assembles onto. Nothing is sent through
    /// it here: what these tests need from an established link is only that the
    /// module still holds work, which every phase from `.requesting` onwards is.
    private final class StubTransport: LinkRoutableInitialTransport, @unchecked Sendable {
        private let lock = NSLock()
        var onSAS: ((String) -> Void)?
        var onReady: ((LinkIdentity) -> Void)?
        var onFrame: ((LinkLane, [UInt8]) -> Void)?
        var onError: ((Error) -> Void)?
        var onClose: (() -> Void)?
        private var _closed = false
        var isClosed: Bool { lock.lock(); defer { lock.unlock() }; return _closed }

        func start() {}
        func receive(from: String, signal: JSONValue) {}
        func send(_ bytes: [UInt8], on lane: LinkLane) throws {}
        func bufferedAmount(on lane: LinkLane) -> UInt64 { 0 }
        func close() { lock.lock(); _closed = true; lock.unlock() }
    }

    // MARK: - the module under test

    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("surface-release-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    /// A Cross-network module wired exactly the way `RelayiumApp` wires the
    /// Direct one, over a socket this test drives.
    @MainActor
    private final class Rig {
        let module: TransferModule
        let pair: StubPair
        let ice: StubICE
        let scheduler: ManualScheduler
        var channels: [FakeWebSocketChannel] = []
        var joinedCodes: [String] = []
        var adopted: [(peerId: String, role: Role, mode: TransferMode)] = []
        /// How many times the app's `onPairingLinkActivated` handoff ran.
        var handoffs = 0

        init(module: TransferModule, pair: StubPair, ice: StubICE, scheduler: ManualScheduler) {
            self.module = module
            self.pair = pair
            self.ice = ice
            self.scheduler = scheduler
        }

        var link: LinkWorkspaceModel { module.link }
        var files: RealtimeSessionModel { module.files }
        var presence: TransferPresence { module.presence }

        /// The hub's own frames, on the room's socket.
        func welcome(_ selfId: String) {
            channels.last?.fire(Envelope(type: SignalType.welcome, name: selfId))
        }

        func roster(_ ids: [String]) {
            channels.last?.fire(Envelope(type: SignalType.peers,
                                         peers: ids.map { Peer(id: $0, name: "peer") }))
        }

        func announce(_ peerId: String, _ caps: [String]) {
            channels.last?.fire(Envelope(type: SignalType.signal, from: peerId,
                                         data: .object(["caps": .array(caps.map(JSONValue.string))])))
        }
    }

    private func makeRig() -> Rig {
        let pair = StubPair()
        let ice = StubICE()
        let scheduler = ManualScheduler()
        let directory = self.directory!
        var box: Rig?
        let link = LinkWorkspaceModel(
            capabilities: PeerCapabilityRegistry(linkRoomActive: { true }),
            receiveDirectory: { directory },
            requiresVerification: { false },
            iceClient: ice,
            connectPairingSocket: { code in
                let channel = FakeWebSocketChannel()
                let socket = SignalingClient(channel: channel, name: "Mac")
                channel.fireOpen()
                box?.channels.append(channel)
                box?.joinedCodes.append(code)
                return socket
            },
            pairingRoomHandle: LinkRoomHandle(),
            scheduler: scheduler,
            assemble: { signaling, peerId, role, servers, relayOnly, generation,
                        directory, admission, signal in
                LinkSessionFactory.make(
                    signaling: signaling, peerId: peerId, role: role, iceServers: servers,
                    iceTransportPolicy: relayOnly ? .relay : .all,
                    authenticationGeneration: generation,
                    receiveDirectory: directory, admission: admission,
                    deadlines: LinkDeadlines(), initialSignal: signal,
                    buildInitialTransport: { _, _, _, _, _, _, _ in StubTransport() },
                    buildReplacementFactory: { _, _, _, _ in
                        { _ in throw LinkTransportError.notReady }
                    })
            })
        let module = TransferModule(
            route: .pairingCode,
            files: RealtimeSessionModel(pairClient: pair, iceClient: StubICE(),
                                        makeConnection: { _, _, _ in
                                            throw NearbyError.notScanning
                                        }),
            text: RealtimeTextSessionModel(pairClient: pair, iceClient: StubICE(),
                                           makeConnection: { _, _, _ in
                                               throw NearbyError.notScanning
                                           }),
            link: link)
        let rig = Rig(module: module, pair: pair, ice: ice, scheduler: scheduler)
        box = rig
        // **The app's own wiring, verbatim.** `RelayiumApp` sets exactly this,
        // and it is what makes the file lane go idle under a live link — the
        // transition the release rule has to survive.
        link.onPairingLinkActivated = { [weak module] in
            rig.handoffs += 1
            module?.files.cancel()
        }
        link.adoptLegacyRoom = { peerId, role, _, mode in
            rig.adopted.append((peerId, role, mode))
        }
        return rig
    }

    private func settle(_ turns: Int = 14) async {
        for _ in 0..<turns { await Task.yield() }
    }

    /// Everything `CrossNetworkConnectPane` + `PairingCodeStart` do for Create,
    /// in the order they do it: claim the surface, mint on the legacy model,
    /// then watch the room the code names.
    @discardableResult
    private func createCode(_ rig: Rig) async -> String {
        XCTAssertTrue(rig.presence.beginSession(.pairingCode, mode: .files))
        await rig.files.mintCode(token: "acceptance")
        guard case let .showingCode(code, _) = rig.files.state else {
            XCTFail("the legacy model did not reach a shown code: \(rig.files.state)")
            return ""
        }
        XCTAssertTrue(rig.link.watchPairingCode(code, legacyRole: .initiator),
                      "the model refused to watch the code it just minted")
        await settle()
        XCTAssertEqual(rig.link.connection, .watching(code: code))
        return code
    }

    // MARK: - 1. the rule itself

    /// **`retainsWork` is wider than `sessionIsLiveOrRetained`, by exactly one
    /// case, and that case is the whole defect.**
    ///
    /// A `.watching` pairing room is not a session — there is no peer, nothing
    /// to draw and nothing to refuse a second start for — but it IS work this
    /// module holds, and a release that ignored it stranded an open socket.
    func testTheReleaseRuleCountsEveryLaneIncludingAWatchedPairingRoom() {
        XCTAssertFalse(TransferModule.retainsWork(files: .idle, text: .idle, link: .idle),
                       "an idle module refuses to release its surface")

        for link in [LinkWorkspaceConnection.watching(code: "483920"),
                     .requesting,
                     .establishing(sas: nil),
                     .establishing(sas: "424242"),
                     .open(sas: "424242"),
                     .ended(.closed)] {
            XCTAssertTrue(TransferModule.retainsWork(files: .idle, text: .idle, link: link),
                          "the surface may be released while the link is \(link)")
        }
        // The legacy lanes, including their RETAINED terminal states: a
        // completed receive keeps its result view and its Reveal in Finder.
        for files in [RealtimeState.minting,
                      .showingCode("483920", expiresAt: 4_102_444_800),
                      .joining("483920"), .connecting, .verifying(sas: "424242"),
                      .transferring(done: 0, total: 1), .completed([]),
                      .failed("nope")] {
            XCTAssertTrue(TransferModule.retainsWork(files: files, text: .idle, link: .idle),
                          "the surface may be released while the file lane is \(files)")
        }
        for text in [RealtimeTextState.minting, .showingCode("483920", expiresAt: 4_102_444_800),
                     .joining("483920"), .connecting, .verifying(sas: "424242"),
                     .waitingAccept(sas: "424242"), .incomingRequest(sas: "424242"),
                     .open(sas: "424242"), .ended, .refused, .unsupported,
                     .failed("nope")] {
            XCTAssertTrue(TransferModule.retainsWork(files: .idle, text: text, link: .idle),
                          "the surface may be released while the text lane is \(text)")
        }
    }

    /// The app-scoped liveness observer and every surface-local release ask the
    /// SAME question, which is why the observer stayed right while the view went
    /// wrong. One rule, one place.
    func testTheLivenessObserverAndTheReleaseRuleCannotDisagree() async {
        let rig = makeRig()
        await createCode(rig)

        // The observer is the module's own subscription, installed in `init`.
        // A watched room keeps it live, so nothing releases here.
        await settle()
        XCTAssertEqual(rig.presence.owner, .pairingCode,
                       "the app-scoped observer released a surface holding a watched room")
        XCTAssertTrue(rig.module.retainsWork)
        XCTAssertFalse(rig.module.releaseSurfaceIfIdle(),
                       "a module holding a watched pairing room agreed to release its surface")
    }

    // MARK: - 2. the protocol handoff

    /// **The regression, end to end: a creator whose code resolves to `link/1`
    /// keeps its surface.**
    ///
    /// The file lane really does go `.idle` here — that is `RelayiumApp`'s own
    /// `onPairingLinkActivated`, running against a real transition — and the
    /// pane's `onChange` really does fire on it. What changed is only that the
    /// release now asks the module rather than the lane.
    func testTheLinkHandoffKeepsTheSurfaceWhenTheCodeModelIsRetired() async {
        let rig = makeRig()
        await createCode(rig)

        rig.welcome("aaa-mac")
        rig.announce("zzz-web", [TEXT_CAPABILITY, LINK_CAPABILITY])
        rig.roster(["zzz-web"])
        await settle()

        // The handoff happened: the legacy model that drew the code is retired,
        // and the link has a peer.
        XCTAssertEqual(rig.handoffs, 1,
                       "the pairing room did not resolve to link/1")
        XCTAssertEqual(rig.files.state, .idle,
                       "the code model was not retired, so this is not the handoff")
        XCTAssertTrue(rig.link.hasSession,
                      "the link published no session for the surface to keep")

        // …and this is the exact call `TransferSessionPane.onChange` makes on
        // that `.idle`. Before the repair it was `presence.release(route)`,
        // unconditionally.
        XCTAssertFalse(rig.module.releaseSurfaceIfIdle(),
                       "the link/1 handoff released the surface out from under a live link")
        await settle()

        XCTAssertEqual(rig.presence.owner, .pairingCode,
                       "the creator's surface was given up under a live link — the connect "
                       + "pane then draws transfer.busyElsewhere over a link with no exit")
        XCTAssertEqual(rig.module.pane, .link,
                       "the module draws its connect screen while holding a link session")
        XCTAssertFalse(rig.module.acceptsNewSession,
                       "a module holding a link offered to start a second session")
    }

    /// **The unguarded release, reproduced exactly, so the consequence is pinned
    /// rather than described.**
    ///
    /// `presence.release(route)` on the file lane's `.idle` edge is literally
    /// what `TransferSessionPane.onChange` used to call. Running it here after
    /// the handoff produces the invariant violation and both halves of the state
    /// it would put on screen: the connect pane (`pane == .connect`) with its
    /// lock explained (`!acceptsNewSession`, which is what renders
    /// `transfer.busyElsewhere`), over a link that is still holding work and has
    /// no exit on screen.
    ///
    /// **Deliberately not named "the shipped defect".** The built app did not
    /// take this branch, because the pane is swapped out for the link pane in
    /// the same update pass and its `onChange` is not delivered — see the type
    /// comment. What this pins is the state the rule exists to make unreachable,
    /// so a future change to that ordering cannot reintroduce it silently.
    ///
    /// It is a test about the PRIMITIVE, which is still correct and still
    /// needed — `TransferPresence.release` must go on refusing a non-owner. What
    /// changed is that no surface calls it unguarded any more, which
    /// `MacSurfaceGuardTests.testEveryPairingCodeExitGoesThroughTheOneModuleOperation`
    /// holds the pane to.
    func testAnUnguardedReleaseAfterTheHandoffViolatesTheInvariant() async {
        let rig = makeRig()
        await createCode(rig)
        rig.welcome("aaa-mac")
        rig.announce("zzz-web", [TEXT_CAPABILITY, LINK_CAPABILITY])
        rig.roster(["zzz-web"])
        await settle()

        // The old call, verbatim.
        rig.presence.release(.pairingCode)
        await settle()

        XCTAssertNil(rig.presence.owner)
        XCTAssertTrue(rig.module.retainsWork,
                      "owner == nil while the module still holds work is the violation, "
                      + "and this reproduction no longer produces it")
        XCTAssertTrue(rig.module.sessionIsLiveOrRetained)
        XCTAssertEqual(rig.module.pane, .connect,
                       "the connect pane is not drawn, so this is not the state the rule "
                       + "exists to make unreachable")
        XCTAssertFalse(rig.module.acceptsNewSession,
                       "the connect pane would not explain a lock, so transfer.busyElsewhere "
                       + "is not what the user would read")
        // …and nothing on that screen can end the link, which is why the only
        // recovery was relaunching: the app-scoped observer releases on the
        // all-idle edge, and a live link never reaches it.
        XCTAssertTrue(rig.link.hasSession)
    }

    /// **And the link is still disposable afterwards**, which is the half the
    /// user could not reach at all: leaving and dismissing returns the module to
    /// a connect phase that can start something.
    func testTheHandedOverLinkCanStillBeEndedAndTheSurfaceComesBack() async {
        let rig = makeRig()
        await createCode(rig)
        rig.welcome("aaa-mac")
        rig.announce("zzz-web", [TEXT_CAPABILITY, LINK_CAPABILITY])
        rig.roster(["zzz-web"])
        await settle()
        XCTAssertFalse(rig.module.releaseSurfaceIfIdle())

        // `TransferLinkPane`'s exit: leave, read the terminal reason, then Done.
        rig.link.leave()
        await settle()
        XCTAssertTrue(rig.module.retainsWork,
                      "an ended link's retained result gave the surface up before the "
                      + "user had dismissed it")
        XCTAssertEqual(rig.presence.owner, .pairingCode)

        rig.link.dismiss()
        await settle()
        XCTAssertEqual(rig.link.connection, .idle)
        XCTAssertNil(rig.presence.owner,
                     "a fully dismissed module kept a surface with nothing on it")
        XCTAssertTrue(rig.module.acceptsNewSession,
                      "the module cannot start a session after its link ended")
    }

    /// The legacy fallback is untouched: a peer that does not announce `link/1`
    /// still gets the room handed over, and the surface stays claimed for the
    /// legacy session built on it.
    func testALegacyPeerStillTakesTheRoomWithoutReleasingTheSurface() async {
        let rig = makeRig()
        await createCode(rig)

        rig.welcome("aaa-mac")
        rig.announce("zzz-web", [TEXT_CAPABILITY])
        rig.roster(["zzz-web"])
        await settle()

        XCTAssertEqual(rig.adopted.count, 1, "the legacy peer was not handed the room")
        XCTAssertEqual(rig.link.connection, .idle,
                       "a handed-over room left the link holding the connection too")
        XCTAssertNotNil(rig.link.handedOverPairing,
                        "the handed-over rendezvous was not recorded")
        XCTAssertEqual(rig.presence.owner, .pairingCode,
                       "the legacy fallback released the surface it was handing a session to")
    }

    // MARK: - 3. cancelling or expiring a creator's code

    /// **The retained room, stated as the thing that used to survive a Cancel.**
    ///
    /// Ending only the lane is exactly what the code screen's Cancel used to do.
    /// The module is left holding a watched room, so it may not release — and
    /// that refusal is the deterministic signature of the leak.
    func testEndingOnlyTheCodeLaneLeavesTheWatchedRoomAndRefusesToRelease() async {
        let rig = makeRig()
        let code = await createCode(rig)

        rig.files.cancel()
        await settle()

        XCTAssertEqual(rig.files.state, .idle)
        XCTAssertEqual(rig.link.connection, .watching(code: code),
                       "the watched room did not survive the lane's cancel, so this test "
                       + "no longer describes the defect it is about")
        XCTAssertFalse(rig.module.releaseSurfaceIfIdle(),
                       "the surface was released while a pairing room was still open, "
                       + "leaving owner == nil with the link still holding work")
        XCTAssertEqual(rig.presence.owner, .pairingCode)
        // And the consequence, at its source: the room cannot be replaced.
        XCTAssertFalse(rig.link.watchPairingCode("771155", legacyRole: .initiator),
                       "a second room was opened while the first was still held")
    }

    /// **The repair: one operation ends the lane AND the room, in that order,
    /// and only then releases.**
    func testCancellingACreatorsCodeEndsTheWatchedRoomAndReleasesTheSurface() async {
        let rig = makeRig()
        let code = await createCode(rig)
        XCTAssertEqual(rig.joinedCodes, [code])

        rig.module.cancelPairingCode()
        await settle()

        XCTAssertEqual(rig.files.state, .idle, "the lane holding the code is still running")
        XCTAssertEqual(rig.link.connection, .idle,
                       "the pairing room outlived the code it was opened for")
        XCTAssertTrue(rig.channels[0].closed,
                      "the room's socket was left open with nothing watching it")
        XCTAssertNil(rig.presence.owner, "a cancelled code kept the surface claimed")
        XCTAssertTrue(rig.module.acceptsNewSession,
                      "the connect screen is still refusing a new session after a cancel")
        XCTAssertEqual(rig.module.pane, .connect)
    }

    /// **The symptom a user actually reported, as a pass/fail:** cancel a code
    /// and create another one in the same process, and the new code is really
    /// watched — a real `link/1` room, not a silent legacy fallback.
    func testANewCodeAfterACancelIsWatchedInARoomOfItsOwn() async {
        let rig = makeRig()
        let first = await createCode(rig)
        rig.module.cancelPairingCode()
        await settle()

        let second = await createCode(rig)

        XCTAssertNotEqual(first, second, "the stub minted the same code twice")
        XCTAssertEqual(rig.joinedCodes, [first, second],
                       "the replacement code was never watched, so whoever typed it "
                       + "reaches a room this process is not in")
        XCTAssertEqual(rig.link.connection, .watching(code: second))
        XCTAssertEqual(rig.presence.owner, .pairingCode)

        // …and it establishes, which is the part a fallback would fail.
        rig.welcome("aaa-mac")
        rig.announce("zzz-web", [TEXT_CAPABILITY, LINK_CAPABILITY])
        rig.roster(["zzz-web"])
        await settle()
        XCTAssertTrue(rig.link.hasSession,
                      "the second code did not reach a link/1 session")
        XCTAssertTrue(rig.adopted.isEmpty,
                      "the second code fell back to the legacy wire")
    }

    /// The joiner's cancel — the one that was already correct — keeps behaving
    /// the same through the shared operation. Its lane is idle by construction,
    /// so ending it is a no-op and the room is what actually goes.
    func testAJoinersCancelStillEndsOnlyTheWatchedRoom() async {
        let rig = makeRig()
        XCTAssertTrue(rig.presence.beginSession(.pairingCode, mode: .files))
        XCTAssertTrue(rig.link.watchPairingCode("771155", legacyRole: .responder))
        await settle()
        XCTAssertEqual(rig.files.state, .idle, "a joiner's legacy lane starts idle")

        rig.module.cancelPairingCode()
        await settle()

        XCTAssertEqual(rig.link.connection, .idle)
        XCTAssertNil(rig.presence.owner)
        XCTAssertTrue(rig.pair.minted.isEmpty,
                      "the joiner's cancel reached a minting path it has no account for")
    }

    // MARK: - 4. what must NOT have changed

    /// **A genuinely concurrent second start is still refused.** The repair
    /// widens what counts as busy; it must not widen what counts as free.
    func testASecondSessionIsStillRefusedWhileTheFirstIsRunning() async {
        let rig = makeRig()
        await createCode(rig)

        XCTAssertFalse(rig.presence.beginSession(.pairingCode, mode: .files),
                       "a second create was admitted while a code was live")
        XCTAssertFalse(rig.module.acceptsNewSession,
                       "the connect controls were offered while a code was live")

        // Through the handoff, and still refused — now against a real link.
        rig.welcome("aaa-mac")
        rig.announce("zzz-web", [TEXT_CAPABILITY, LINK_CAPABILITY])
        rig.roster(["zzz-web"])
        await settle()
        XCTAssertFalse(rig.module.releaseSurfaceIfIdle())
        XCTAssertFalse(rig.presence.beginSession(.pairingCode, mode: .files),
                       "a second session was admitted while a link/1 was open")
        XCTAssertFalse(rig.module.acceptsNewSession)
    }

    /// A retained terminal legacy result still owns the surface: `.completed`
    /// keeps its result view, its Reveal in Finder and its drag-out promise, and
    /// the release rule must not reach past them either.
    func testARetainedTerminalLegacyResultStillHoldsTheSurface() async {
        let rig = makeRig()
        await createCode(rig)
        rig.module.cancelPairingCode()
        await settle()
        XCTAssertNil(rig.presence.owner)

        // A legacy session that reached a terminal state, with no link at all.
        XCTAssertTrue(rig.presence.beginSession(.pairingCode, mode: .files))
        XCTAssertTrue(TransferModule.retainsWork(files: .completed([]), text: .idle, link: .idle),
                      "a completed receive's retained result no longer holds the surface")
        XCTAssertTrue(TransferModule.retainsWork(files: .failed("nope"), text: .idle, link: .idle),
                      "a failed batch's retained manifest no longer holds the surface")
    }

    /// The other module is untouched by any of this: the repair is per module,
    /// and a release rule that reached app-wide would be the shared arbitration
    /// `TransferModule` exists to remove.
    func testNothingHereReachesTheOtherModule() async throws {
        let rig = makeRig()
        let nearby = TransferModule(
            route: .nearby,
            files: RealtimeSessionModel(pairClient: StubPair(), iceClient: StubICE(),
                                        makeConnection: { _, _, _ in
                                            throw NearbyError.notScanning
                                        }),
            text: RealtimeTextSessionModel(pairClient: StubPair(), iceClient: StubICE(),
                                           makeConnection: { _, _, _ in
                                               throw NearbyError.notScanning
                                           }),
            link: LinkWorkspaceModel(
                capabilities: PeerCapabilityRegistry(linkRoomActive: { true }),
                receiveDirectory: { self.directory },
                requiresVerification: { false },
                iceClient: nil))
        XCTAssertTrue(nearby.presence.beginSession(.nearby, mode: .files, peerLabel: "Studio Mac"))

        await createCode(rig)
        rig.module.cancelPairingCode()
        await settle()

        XCTAssertEqual(nearby.presence.owner, .nearby,
                       "cancelling a pairing code released the same-network surface")
        XCTAssertEqual(nearby.presence.sessionPeerLabel, "Studio Mac")
    }
}
