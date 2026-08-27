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
        var code: PairingCodeModel { module.code }
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
            // **Exactly as `AppEnvironment.makeDirectLinkWorkspaceModel` builds
            // the shipped one.** This whole file is about a macOS module's
            // surface lifecycle, so a rig on the shared default would be
            // exercising the paused iOS composition's behaviour instead.
            legacyFallback: .terminateUnsupported,
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
        let module = TransferModule(route: .pairingCode, link: link,
                                    code: PairingCodeModel(client: pair))
        let rig = Rig(module: module, pair: pair, ice: ice, scheduler: scheduler)
        box = rig
        // **The app's own wiring, verbatim.** `RelayiumApp` sets exactly this,
        // and it is what makes the file lane go idle under a live link — the
        // transition the release rule has to survive.
        link.onPairingLinkActivated = { [weak module] in
            rig.handoffs += 1
            module?.code.cancel()
        }
        // **`adoptLegacyRoom` is deliberately NOT set**, exactly as `RelayiumApp`
        // no longer sets it. `rig.adopted` therefore stays empty for the life of
        // every test here, which is the assertion rather than an omission: this
        // module's link is built with `legacyFallback: .terminateUnsupported`,
        // so there is no hand-over for a callback to receive.
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
        XCTAssertTrue(rig.presence.beginSession(.pairingCode))
        await rig.code.mint(token: "acceptance")
        guard let code = rig.code.state.code else {
            XCTFail("the code model did not reach a shown code: \(rig.code.state)")
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
        XCTAssertEqual(rig.code.state, .idle,
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

    /// **A peer that cannot link terminates the room, and the surface is still
    /// released cleanly.**
    ///
    /// This test used to assert the opposite half of the same lifecycle: the
    /// room was HANDED to a legacy session and the surface had to stay claimed
    /// for the session it was handing over to. This module is built with
    /// `legacyFallback: .terminateUnsupported` — exactly as `AppEnvironment`
    /// builds the shipped one — so there is no hand-over and no session to hold
    /// the surface for.
    ///
    /// What has to hold instead is that the refusal is complete: nothing is
    /// adopted, the room's socket is closed, and the module can be released and
    /// used again rather than being left owning a surface with no session on it.
    func testAPeerThatCannotLinkTerminatesTheRoomAndFreesTheModule() async {
        let rig = makeRig()
        await createCode(rig)

        rig.welcome("aaa-mac")
        rig.announce("zzz-web", [TEXT_CAPABILITY])
        rig.roster(["zzz-web"])
        await settle()

        XCTAssertTrue(rig.adopted.isEmpty,
                      "the peer was handed a legacy session this build cannot compose")
        XCTAssertTrue(rig.link.unsupportedPairingPeer,
                      "the refusal was not published for the surface to state")
        XCTAssertEqual(rig.link.connection, .idle)
        XCTAssertNil(rig.link.handedOverPairing,
                     "a rendezvous was recorded for a hand-over that never happened")
        XCTAssertTrue(rig.channels[0].closed,
                      "the refused room's socket was left open")

        // The surface is still owned — the user is looking at a screen that has
        // something to say — and releasing it is a normal, complete operation
        // rather than one blocked by a room nobody closed.
        XCTAssertEqual(rig.presence.owner, .pairingCode,
                       "the refusal blanked the surface that has to state it")
        rig.module.cancelPairingCode()
        await settle()
        XCTAssertNil(rig.presence.owner, "the module could not be released after a refusal")
        XCTAssertFalse(rig.link.unsupportedPairingPeer,
                       "the refusal outlived the screen that showed it")
        XCTAssertTrue(rig.module.acceptsNewSession,
                      "a refused code left the module unable to start another")
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

        rig.code.cancel()
        await settle()

        XCTAssertEqual(rig.code.state, .idle)
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

        XCTAssertEqual(rig.code.state, .idle, "the model holding the code is still showing it")
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
        XCTAssertTrue(rig.presence.beginSession(.pairingCode))
        XCTAssertTrue(rig.link.watchPairingCode("771155", legacyRole: .responder))
        await settle()
        XCTAssertEqual(rig.code.state, .idle,
                       "a joiner that adopted no code starts with nothing shown")

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
            link: LinkWorkspaceModel(
                capabilities: PeerCapabilityRegistry(linkRoomActive: { true }),
                receiveDirectory: { self.directory },
                requiresVerification: { false },
                iceClient: nil,
                legacyFallback: .terminateUnsupported),
            code: PairingCodeModel(client: StubPair()))
        XCTAssertTrue(nearby.presence.beginSession(.nearby, peerLabel: "Studio Mac"))

        await createCode(rig)
        rig.module.cancelPairingCode()
        await settle()

        XCTAssertEqual(nearby.presence.owner, .nearby,
                       "cancelling a pairing code released the same-network surface")
        XCTAssertEqual(nearby.presence.sessionPeerLabel, "Studio Mac")
    }
}

/// **A pairing code cannot outlive the room it names, and a failed mint cannot
/// lock the screen.**
///
/// Both of these shipped as dead ends: a module that held its surface for ever,
/// and six digits with a QR over a socket that was already closed. They are
/// tested together because they are the same invariant from two directions —
/// the code's lifetime is the room's lifetime, and neither may strand the
/// surface.
@MainActor
final class TerminalPairingLifecycleTests: XCTestCase {

    private final class StubPair: PairCodeClient, @unchecked Sendable {
        var answer: MintedCode? = MintedCode(code: "483920", expiresAt: 4_102_444_800)
        func mint(token: String) async throws -> MintedCode {
            guard let answer else { throw AccountError.rateLimited }
            return answer
        }
    }
    private final class StubICE: ICEConfigClient, @unchecked Sendable {
        var config: ICEConfig? = ICEConfig(iceServers: [], relays: [])
        func fetch(code: String) async throws -> ICEConfig {
            guard let config else { throw AccountError.network }
            return config
        }
    }

    private var directory: URL!
    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("terminal-pairing-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: directory) }

    /// Sockets are opened by `watchPairingCode`, which runs long after the rig
    /// is built — so the channels are read through a reference rather than
    /// copied into a struct that would forever hold the empty list.
    private final class Sockets { var channels: [FakeWebSocketChannel] = [] }

    private struct Rig {
        let module: TransferModule
        let code: PairingCodeModel
        let link: LinkWorkspaceModel
        let pair: StubPair
        let ice: StubICE
        let sockets: Sockets
        var channels: [FakeWebSocketChannel] { sockets.channels }
    }

    /// The module wired exactly as `RelayiumApp` wires the Direct one — both
    /// pairing callbacks included, because the whole point is that the terminal
    /// one is no longer missing.
    private func makeRig() -> Rig {
        let pair = StubPair()
        let ice = StubICE()
        let directory = self.directory!
        let box = Sockets()
        let link = LinkWorkspaceModel(
            capabilities: PeerCapabilityRegistry(linkRoomActive: { true }),
            receiveDirectory: { directory },
            requiresVerification: { false },
            iceClient: ice,
            connectPairingSocket: { _ in
                let channel = FakeWebSocketChannel()
                let socket = SignalingClient(channel: channel, name: "Mac")
                channel.fireOpen()
                box.channels.append(channel)
                return socket
            },
            legacyFallback: .terminateUnsupported,
            localHello: linkOnlyCapsHello(linkRoomActive:))
        let code = PairingCodeModel(client: pair)
        let module = TransferModule(route: .pairingCode, link: link, code: code)
        link.onPairingLinkActivated = { [weak code] in code?.cancel() }
        link.onPairingRoomRetired = { [weak code] in code?.cancel() }
        return Rig(module: module, code: code, link: link, pair: pair, ice: ice,
                   sockets: box)
    }

    private func settle(_ turns: Int = 14) async {
        for _ in 0..<turns { await Task.yield() }
    }

    /// Everything `CrossNetworkConnectPane.createCode` + `PairingCodeStart`
    /// do, in their order.
    ///
    /// Inlined rather than called: `PairingCodeStart` lives in the macOS app
    /// target, which this package cannot import. The two steps are short and the
    /// ORDER is what matters here — claim, mint, watch — so a copy that got them
    /// wrong would fail these tests rather than hide behind them.
    private func createCode(_ rig: Rig) async {
        XCTAssertTrue(rig.module.presence.beginSession(.pairingCode))
        await rig.code.mint(token: "acceptance")
        if let minted = rig.code.state.code {
            _ = rig.link.watchPairingCode(minted, legacyRole: .initiator,
                                          files: [], sources: [])
        }
        await settle()
    }

    // MARK: - A. a failed mint

    /// **A failed mint keeps its message and still lets the user try again.**
    ///
    /// `.failed` is active on purpose, so the reason survives the app-scoped
    /// liveness observer. That is what held the surface — and with the surface
    /// held, `acceptsNewSession` was false, which is what disabled Create AND
    /// Join underneath the message. One failed mint made the screen permanently
    /// unusable.
    func testAFailedMintKeepsItsReasonAndStillLocksTheScreenUntilDismissed() async {
        let rig = makeRig()
        rig.pair.answer = nil

        await createCode(rig)

        guard case .failed = rig.code.state else {
            return XCTFail("a refused mint did not report a failure: \(rig.code.state)")
        }
        // The message survives, which is why the surface is still held.
        XCTAssertTrue(rig.module.retainsWork)
        XCTAssertEqual(rig.module.presence.owner, .pairingCode)
        XCTAssertFalse(rig.module.acceptsNewSession,
                       "this is the state the screen is locked in; if it is not "
                       + "reachable the recovery below is testing nothing")
    }

    /// …and dismissing is the recovery: idle code, idle link, released surface,
    /// and the next mint or join is permitted.
    func testDismissingAFailedMintFullyReleasesTheModule() async {
        let rig = makeRig()
        rig.pair.answer = nil
        await createCode(rig)

        rig.module.cancelPairingCode()
        await settle()

        XCTAssertEqual(rig.code.state, .idle, "the failure outlived its dismissal")
        XCTAssertEqual(rig.link.connection, .idle)
        XCTAssertNil(rig.module.presence.owner,
                     "a dismissed failure kept the surface, so the screen stays locked")
        XCTAssertFalse(rig.module.retainsWork)
        XCTAssertTrue(rig.module.acceptsNewSession,
                      "Create and Join are still disabled after the failure was dismissed")

        // And the next attempt really works.
        rig.pair.answer = MintedCode(code: "517341", expiresAt: 4_102_444_800)
        await createCode(rig)
        XCTAssertEqual(rig.code.state.code, "517341",
                       "the module could not mint again after recovering")
    }

    // MARK: - B. a room that ends without a link

    /// **A peer that cannot speak `link/1` retires the code with the room.**
    ///
    /// The refusal is retained — the user is owed the reason — but the digits,
    /// their QR and the "waiting for the other device" go, because the socket
    /// they belonged to is closed.
    func testAnUnsupportedPeerRetiresTheCodeButKeepsTheWarning() async {
        let rig = makeRig()
        await createCode(rig)
        XCTAssertEqual(rig.code.state.code, "483920", "the code was never shown")

        rig.channels[0].fire(Envelope(type: SignalType.welcome, name: "aaa-mac"))
        rig.channels[0].fire(Envelope(type: SignalType.signal, from: "zzz-web",
                                      data: capsField([TEXT_CAPABILITY])))
        rig.channels[0].fire(Envelope(type: SignalType.peers,
                                      peers: [Peer(id: "zzz-web", name: "peer")]))
        await settle()

        XCTAssertTrue(rig.link.unsupportedPairingPeer,
                      "the reason the code stopped is not on screen")
        XCTAssertEqual(rig.code.state, .idle,
                       "the digits and their QR outlived the room they named, over a "
                       + "closed socket, under a wait that would never end")
        XCTAssertEqual(rig.link.connection, .idle)
        XCTAssertTrue(rig.channels[0].closed)
    }

    /// A code the hub will not resolve ends the same way: the ending is shown,
    /// the digits are not.
    func testACodeThatCannotBeJoinedRetiresItsDigits() async {
        let rig = makeRig()
        rig.ice.config = nil

        await createCode(rig)
        await settle()

        XCTAssertEqual(rig.link.connection, .ended(.roomUnavailable),
                       "the unresolvable code did not reach its own ending")
        XCTAssertEqual(rig.code.state, .idle,
                       "a code the hub refused is still being offered")
    }

    /// …and Done on that ending returns the module completely, so the next
    /// attempt is permitted.
    func testDoneOnAnUnjoinableCodeReleasesTheModule() async {
        let rig = makeRig()
        rig.ice.config = nil
        await createCode(rig)
        await settle()

        rig.link.dismiss()
        await settle()

        XCTAssertEqual(rig.link.connection, .idle)
        XCTAssertNil(rig.module.presence.owner,
                     "dismissing an unjoinable code kept the surface claimed")
        XCTAssertTrue(rig.module.acceptsNewSession)
    }

    /// **The success path is unchanged**, and this is the control: a code that
    /// reaches a real `link/1` is retired by the activation callback, not by the
    /// retirement one, and the link keeps its session.
    func testASuccessfulLinkStillRetiresTheCodeAndKeepsItsSession() async {
        let rig = makeRig()
        await createCode(rig)

        rig.channels[0].fire(Envelope(type: SignalType.welcome, name: "aaa-mac"))
        rig.channels[0].fire(Envelope(type: SignalType.signal, from: "zzz-web",
                                      data: capsField([TEXT_CAPABILITY, LINK_CAPABILITY])))
        rig.channels[0].fire(Envelope(type: SignalType.peers,
                                      peers: [Peer(id: "zzz-web", name: "peer")]))
        await settle()

        XCTAssertEqual(rig.code.state, .idle, "a spent code stayed on screen")
        XCTAssertFalse(rig.link.unsupportedPairingPeer,
                       "a link/1 peer was reported as unsupported")
        XCTAssertTrue(rig.link.hasSession,
                      "the code was retired but no link took its place")
        XCTAssertEqual(rig.module.presence.owner, .pairingCode,
                       "retiring the code released the surface under a live link")
    }
}
