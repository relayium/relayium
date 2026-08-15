import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

// MARK: - stubs

private final class StubPair: PairCodeClient, @unchecked Sendable {
    func mint(token: String) async throws -> MintedCode {
        MintedCode(code: "483920", expiresAt: 1800000000)
    }
}

private final class StubICE: ICEConfigClient, @unchecked Sendable {
    func fetch(code: String) async throws -> ICEConfig {
        ICEConfig(iceServers: [ICEServerConfig(urls: ["stun:s:3478"])])
    }
}

/// Every close, in order, from BOTH the room socket and the transfer
/// connection, written into one log.
///
/// The order is the whole assertion for `.background`: leaving the room first
/// is what stops this device advertising itself as reachable while it is being
/// suspended, and it has to happen before the session cleanup that R3-E owns.
/// Two separate counters could not tell "both happened" from "they happened in
/// the right order".
private final class OrderLog: @unchecked Sendable {
    private let lock = NSLock()
    private var events: [String] = []
    func record(_ event: String) { lock.lock(); events.append(event); lock.unlock() }
    var all: [String] { lock.lock(); defer { lock.unlock() }; return events }
    /// Dropped after the arrange step. `openSocket` tears the previous epoch
    /// down first — including on the very first join — so an unreset log always
    /// opens with a `room-leave` and every ordering assertion would pass on it
    /// rather than on the transition under test.
    func reset() { lock.lock(); events = []; lock.unlock() }
}

private final class LoggingConnection: RealtimePeerConnection, @unchecked Sendable {
    var onSAS: ((String) -> Void)?
    var onOpen: (() -> Void)?
    var onManifest: (([FileMeta]) -> Void)?
    var onFileChunk: (([UInt8]) -> Void)?
    var onProgress: ((Int) -> Void)?
    var onDone: ((Bool) -> Void)?
    var onText: ((String, Int) -> Void)?
    var onControl: ((RealtimeControl) -> Void)?
    var onClose: (() -> Void)?
    var onError: ((Error) -> Void)?

    let log: OrderLog
    init(log: OrderLog) { self.log = log }

    func start() {}
    func send(sources: [PlaintextSource], metas: [FileMeta]) {}
    func accept() {}
    func reject() {}
    func complete() {}
    func confirmTextSAS() {}
    func acceptText() {}
    func rejectText() {}
    func sendText(_ body: String, completion: @escaping (Error?) -> Void) { completion(nil) }
    var textBufferedAmount: UInt64 { 0 }
    func close() { log.record("session") }
}

/// Stands in for the receive model's subscription to the room. The real
/// observer is `NearbyReceiveModel`; what this needs to see is only the edge —
/// the socket going away — and when it happened relative to everything else.
@MainActor
private final class RoomSpy: NearbyRoomObserver {
    let log: OrderLog
    init(log: OrderLog) { self.log = log }
    func roomDidConnect(_ signaling: SignalingClient) { log.record("room-connect") }
    func roomDidDisconnect() { log.record("room-leave") }
}

/// The ordering, the failure and the lifecycle rules that make iOS reachable —
/// in one object, because every one of them is invisible in a SwiftUI modifier.
///
/// Three decisions live here and nowhere else:
///
///  1. **The receive folder is resolved and installed BEFORE the room is
///     joined.** Joining is what advertises this device as reachable. A peer
///     that dials the instant we appear finds a model whose `saveDirectory`
///     still points at Downloads — a directory that does not exist in an iOS
///     container — and the failure lands after the manifest, with the sender
///     already transmitting.
///  2. **`.inactive` is not `.background`.** A document picker, a share sheet
///     and the app switcher all produce `.inactive`, which is to say it is
///     produced at the exact moment the user is choosing what to send. Anything
///     at all happening there is a defect; this asserts *nothing at all*, not
///     merely "the session survives".
///  3. **A pause is the user's and is sticky.** Coming back to the foreground
///     must not undo it, and must not clear a terminal session's retained
///     result or transcript either.
@MainActor
final class NearbyResidencyCoordinatorTests: XCTestCase {

    private var log = OrderLog()
    private var sockets = SocketLog()
    private var spy: RoomSpy?

    override func setUp() {
        super.setUp()
        log = OrderLog()
        sockets = SocketLog()
    }

    /// The socket delivers on its own queue and both the discovery model and
    /// the receive model hop to the main actor from there, so a state change
    /// crosses more than one suspension point before it can be read.
    private func settle() async { for _ in 0..<8 { await Task.yield() } }

    /// A discovery model whose every socket is recorded, so "exactly one room"
    /// is a count rather than an intention.
    private func makeDiscovery() -> LanDiscoveryModel {
        let opened = sockets
        let model = LanDiscoveryModel(connect: {
            let channel = opened.open()
            let client = SignalingClient(channel: channel, name: "iPhone")
            channel.fireOpen()
            return client
        })
        let observer = RoomSpy(log: log)
        spy = observer
        model.observer = observer
        return model
    }

    private func makeFileModel() -> RealtimeSessionModel {
        let recorded = log
        return RealtimeSessionModel(pairClient: StubPair(), iceClient: StubICE(),
                                    requiresVerification: { false },
                                    makeConnection: { _, _, _ in LoggingConnection(log: recorded) })
    }

    private func makeTextModel() -> RealtimeTextSessionModel {
        let recorded = log
        return RealtimeTextSessionModel(pairClient: StubPair(), iceClient: StubICE(),
                                        requiresVerification: { false },
                                        makeConnection: { _, _, _ in LoggingConnection(log: recorded) })
    }

    private func tempDir() throws -> URL {
        let d = FileManager.default.temporaryDirectory
            .appendingPathComponent("r3f-res-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    private struct Rig {
        let coordinator: NearbyResidencyCoordinator
        let discovery: LanDiscoveryModel
        let file: RealtimeSessionModel
        let text: RealtimeTextSessionModel
        let foreground: ForegroundSessionCoordinator
    }

    /// `resolve` is injected rather than hitting `ReceiveDestination.directory()`
    /// so a refusal is a case this test can stage — the real one needs something
    /// occupying the name `Received` inside an iOS container.
    private func makeRig(resolve: @escaping () throws -> URL) -> Rig {
        let discovery = makeDiscovery()
        let file = makeFileModel()
        let text = makeTextModel()
        let foreground = ForegroundSessionCoordinator(file: file, text: text, link: nil)
        let coordinator = NearbyResidencyCoordinator(discovery: discovery,
                                                     fileModel: file,
                                                     foreground: foreground,
                                                     resolveDestination: resolve)
        return Rig(coordinator: coordinator, discovery: discovery,
                   file: file, text: text, foreground: foreground)
    }

    private func welcome(_ index: Int = 0, id: String = "self-1") {
        sockets.channels[index].fireText(#"{"type":"welcome","name":"\#(id)","ip":"1.2.3.4"}"#)
    }

    // MARK: - the destination is installed before the room is joined

    /// Not "both happened": the `saveDirectory` read happens INSIDE the connect
    /// closure, which is the instant the socket is created. If the assignment
    /// came afterwards this reads the Downloads default and fails.
    func testTheReceiveFolderIsInstalledBeforeTheRoomIsJoined() async throws {
        let destination = try tempDir()
        let discovery: LanDiscoveryModel
        let file = makeFileModel()
        var directoryAtJoin: URL?
        let opened = sockets
        discovery = LanDiscoveryModel(connect: { [weak file] in
            directoryAtJoin = file?.saveDirectory
            let channel = opened.open()
            let client = SignalingClient(channel: channel, name: "iPhone")
            channel.fireOpen()
            return client
        })
        let foreground = ForegroundSessionCoordinator(file: file, text: makeTextModel(), link: nil)
        let coordinator = NearbyResidencyCoordinator(discovery: discovery,
                                                     fileModel: file,
                                                     foreground: foreground,
                                                     resolveDestination: { destination })
        coordinator.phaseChanged(to: .active)
        await settle()

        XCTAssertEqual(sockets.channels.count, 1, "the room was not joined")
        XCTAssertEqual(directoryAtJoin, destination,
                       "the room was joined while the model still pointed at the default folder")
        XCTAssertNil(coordinator.destinationError)
    }

    /// A destination that cannot be resolved leaves this device OFF the roster
    /// rather than reachable-and-unable-to-write, and says what to do about it.
    func testAnUnresolvableDestinationJoinsNothingAndExplainsItself() async throws {
        let rig = makeRig(resolve: { throw DownloadDestinationError.fileExists(name: "Received") })
        rig.coordinator.phaseChanged(to: .active)
        await settle()

        XCTAssertEqual(sockets.channels.count, 0,
                       "this device advertised itself as reachable with nowhere to write")
        XCTAssertEqual(rig.discovery.state, .off)
        let message = try XCTUnwrap(rig.coordinator.destinationError)
        XCTAssertEqual(message,
                       ReceiveDestinationCopy.message(
                           for: DownloadDestinationError.fileExists(name: "Received"),
                           in: .appFolder),
                       "the failure must render the Files-app recovery, not the folder-picker advice")
    }

    /// And the failure is retryable: the cause is something in the user's own
    /// Files app, so the app cannot fix it and must not make them relaunch.
    func testRetryAfterAFailureJoinsTheRoomAndClearsTheMessage() async throws {
        let destination = try tempDir()
        var fails = true
        let rig = makeRig(resolve: {
            if fails { throw DownloadDestinationError.fileExists(name: "Received") }
            return destination
        })
        rig.coordinator.phaseChanged(to: .active)
        await settle()
        XCTAssertNotNil(rig.coordinator.destinationError)

        fails = false
        rig.coordinator.retry()
        await settle()

        XCTAssertNil(rig.coordinator.destinationError)
        XCTAssertEqual(sockets.channels.count, 1)
        XCTAssertEqual(rig.file.saveDirectory, destination)
    }

    // MARK: - .inactive is a strict no-op

    /// Nothing at all — not a resolve, not a socket, not a session edge.
    ///
    /// Stated as "nothing happened" rather than "the session survived" because
    /// the two differ exactly where it matters: resolving the destination from
    /// an `.inactive` phase would run a filesystem call every time the file
    /// importer opens, and a failure there would put an error on screen behind
    /// the picker the user is looking at.
    func testInactiveDoesNothingAtAll() async throws {
        let destination = try tempDir()
        var resolves = 0
        let rig = makeRig(resolve: { resolves += 1; return destination })
        rig.coordinator.phaseChanged(to: .inactive)
        await settle()

        XCTAssertEqual(resolves, 0, "an inactive phase touched the filesystem")
        XCTAssertEqual(sockets.channels.count, 0)
        XCTAssertEqual(rig.discovery.state, .off)
        XCTAssertNil(rig.foreground.interruption)
    }

    func testInactiveLeavesAnAlreadyJoinedRoomAlone() async throws {
        let destination = try tempDir()
        let rig = makeRig(resolve: { destination })
        rig.coordinator.phaseChanged(to: .active)
        welcome()
        await settle()
        XCTAssertEqual(rig.discovery.state, .joined)
        log.reset()

        rig.coordinator.phaseChanged(to: .inactive)
        await settle()

        XCTAssertEqual(rig.discovery.state, .joined, "the picker took this device off the roster")
        XCTAssertEqual(sockets.channels.count, 1)
        XCTAssertEqual(log.all, [], "the picker produced a room or session edge")
    }

    // MARK: - background: leave the room, THEN clean the session up

    func testBackgroundLeavesTheRoomBeforeEndingALiveSession() async throws {
        let destination = try tempDir()
        let rig = makeRig(resolve: { destination })
        rig.coordinator.phaseChanged(to: .active)
        welcome()
        await settle()
        rig.file.saveDirectory = destination
        await rig.file.join(code: "483920")
        await settle()
        XCTAssertTrue(rig.file.isBusy)
        log.reset()

        rig.coordinator.phaseChanged(to: .background)
        await settle()

        let ordered = log.all.filter { $0 == "room-leave" || $0 == "session" }
        XCTAssertEqual(ordered.first, "room-leave",
                       "the session was torn down while this device was still advertising itself")
        XCTAssertTrue(ordered.contains("session"), "the live session was not ended")
        XCTAssertEqual(rig.discovery.state, .off)
        XCTAssertNotNil(rig.foreground.interruption,
                        "R3-E's explanation must still be published")
    }

    /// Backgrounding with nothing running still leaves the room: residency is
    /// the claim "you can send to this device now", and a suspended app cannot
    /// keep it.
    func testBackgroundLeavesTheRoomWithNoSessionRunning() async throws {
        let destination = try tempDir()
        let rig = makeRig(resolve: { destination })
        rig.coordinator.phaseChanged(to: .active)
        welcome()
        await settle()

        rig.coordinator.phaseChanged(to: .background)
        await settle()

        XCTAssertEqual(rig.discovery.state, .off)
        XCTAssertNil(rig.foreground.interruption,
                     "nothing was interrupted, so nothing may claim it was")
    }

    // MARK: - coming back

    func testReturningToActiveRejoinsTheRoom() async throws {
        let destination = try tempDir()
        let rig = makeRig(resolve: { destination })
        rig.coordinator.phaseChanged(to: .active)
        welcome()
        await settle()
        rig.coordinator.phaseChanged(to: .background)
        await settle()

        rig.coordinator.phaseChanged(to: .active)
        await settle()

        XCTAssertEqual(sockets.channels.count, 2, "the app came back unreachable")
        XCTAssertEqual(rig.discovery.state, .connecting)
    }

    /// The transcript is the only copy there is, and a completed receive still
    /// owns its result. Coming back to the foreground must not touch either.
    func testReturningToActiveDoesNotClearARetainedTerminalTextSession() async throws {
        let destination = try tempDir()
        let rig = makeRig(resolve: { destination })
        rig.coordinator.phaseChanged(to: .active)
        await settle()
        await rig.text.join(code: "483920")
        await settle()
        rig.coordinator.phaseChanged(to: .background)
        await settle()
        let interrupted = rig.foreground.interruption
        let terminal = rig.text.state

        rig.coordinator.phaseChanged(to: .active)
        await settle()

        XCTAssertEqual(rig.text.state, terminal,
                       "returning to the foreground reset a terminal text session")
        XCTAssertEqual(rig.foreground.interruption, interrupted,
                       "the explanation was cleared before the user could read it")
    }

    // MARK: - the user's pause is sticky

    func testAPauseSurvivesBackgroundAndAReturnToTheForeground() async throws {
        let destination = try tempDir()
        let rig = makeRig(resolve: { destination })
        rig.coordinator.phaseChanged(to: .active)
        welcome()
        await settle()
        rig.coordinator.pause()
        await settle()
        XCTAssertEqual(rig.discovery.state, .paused)
        let socketsWhilePaused = sockets.channels.count

        rig.coordinator.phaseChanged(to: .background)
        rig.coordinator.phaseChanged(to: .active)
        await settle()

        XCTAssertEqual(sockets.channels.count, socketsWhilePaused,
                       "the foreground undid a pause the user chose")
        XCTAssertEqual(rig.discovery.state, .paused)
        XCTAssertTrue(rig.coordinator.isPaused)
    }

    func testResumingRejoinsWithTheDestinationInstalledFirst() async throws {
        let destination = try tempDir()
        var resolves = 0
        let rig = makeRig(resolve: { resolves += 1; return destination })
        rig.coordinator.phaseChanged(to: .active)
        await settle()
        rig.coordinator.pause()
        await settle()
        let before = resolves

        rig.coordinator.resume()
        await settle()

        XCTAssertGreaterThan(resolves, before,
                             "resuming advertised this device without re-checking where files land")
        XCTAssertFalse(rig.coordinator.isPaused)
        XCTAssertEqual(rig.discovery.state, .connecting)
    }

    func testResumingIsRefusedWhileTheDestinationCannotBeResolved() async {
        let rig = makeRig(resolve: { throw DownloadDestinationError.fileExists(name: "Received") })
        rig.coordinator.pause()
        rig.coordinator.resume()
        await settle()

        XCTAssertEqual(sockets.channels.count, 0)
        XCTAssertNotNil(rig.coordinator.destinationError)
        XCTAssertTrue(rig.coordinator.isPaused,
                      "a refused resume must leave the pause it could not lift")
    }

    /// The explicit "look again": a user act, so it clears the pause the same
    /// way the macOS pane's button does. Pausing must not become a state the
    /// user can only leave through one button.
    func testLookingAgainClearsAPauseAndRejoins() async throws {
        let destination = try tempDir()
        let rig = makeRig(resolve: { destination })
        rig.coordinator.phaseChanged(to: .active)
        await settle()
        rig.coordinator.pause()
        await settle()

        rig.coordinator.refresh()
        await settle()

        XCTAssertFalse(rig.coordinator.isPaused)
        XCTAssertEqual(rig.discovery.state, .connecting)
        XCTAssertEqual(rig.file.saveDirectory, destination)
    }

    // MARK: - exactly one room

    /// Two sockets would put this device in the room twice, under two peer ids,
    /// and every other device would list it as two devices.
    func testRepeatedActivePhasesOpenExactlyOneSocket() async throws {
        let destination = try tempDir()
        let rig = makeRig(resolve: { destination })
        rig.coordinator.phaseChanged(to: .active)
        welcome()
        await settle()
        rig.coordinator.phaseChanged(to: .active)
        rig.coordinator.phaseChanged(to: .active)
        await settle()

        XCTAssertEqual(sockets.channels.count, 1, "this device joined the room more than once")
        XCTAssertEqual(rig.discovery.state, .joined)
    }

    func testRetryWhileAlreadyResidentOpensNoSecondSocket() async throws {
        let destination = try tempDir()
        let rig = makeRig(resolve: { destination })
        rig.coordinator.phaseChanged(to: .active)
        welcome()
        await settle()

        rig.coordinator.retry()
        await settle()

        XCTAssertEqual(sockets.channels.count, 1)
    }
}
