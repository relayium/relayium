import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

// MARK: - stubs

private final class StubPair: PairCodeClient, @unchecked Sendable {
    var result = MintedCode(code: "K7M3X9", expiresAt: 1800000000)
    var error: Error?
    func mint(token: String) async throws -> MintedCode {
        if let e = error { throw e }
        return result
    }
}

private final class StubICE: ICEConfigClient, @unchecked Sendable {
    var result = ICEConfig(iceServers: [ICEServerConfig(urls: ["stun:s:3478"])])
    var error: Error?
    private(set) var fetchedCodes: [String] = []
    func fetch(code: String) async throws -> ICEConfig {
        fetchedCodes.append(code)
        if let e = error { throw e }
        return result
    }
}

/// Stands in for RealtimeConnection, which needs WebRTC and a live peer.
private final class StubConnection: RealtimePeerConnection, @unchecked Sendable {
    var onSAS: ((String) -> Void)?
    var onOpen: (() -> Void)?
    var onManifest: (([FileMeta]) -> Void)?
    var onFileChunk: (([UInt8]) -> Void)?
    var onProgress: ((Int) -> Void)?
    var onDone: ((Bool) -> Void)?
    var onControl: ((RealtimeControl) -> Void)?
    var onClose: (() -> Void)?
    var onError: ((Error) -> Void)?

    private(set) var started = false
    private(set) var closeCount = 0
    private(set) var sentMetas: [FileMeta] = []
    private(set) var completeCount = 0

    func start() { started = true }
    func send(sources: [PlaintextSource], metas: [FileMeta]) { sentMetas = metas }
    func complete() { completeCount += 1 }
    func close() { closeCount += 1 }
}

@MainActor
final class RealtimeSessionModelTests: XCTestCase {
    private var pair = StubPair()
    private var ice = StubICE()
    private var conn = StubConnection()

    private func makeModel() -> RealtimeSessionModel {
        pair = StubPair(); ice = StubICE(); conn = StubConnection()
        let c = conn
        return RealtimeSessionModel(pairClient: pair, iceClient: ice,
                                    makeConnection: { _, _, _ in c })
    }

    /// Callbacks hop to the main actor because the real connection delivers them
    /// from its own queue. Tests have to let that hop run.
    private func settle() async { await Task.yield(); await Task.yield() }

    private func tempDir() throws -> URL {
        let d = FileManager.default.temporaryDirectory
            .appendingPathComponent("g3-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    // MARK: - minting

    func testMintShowsTheCodeAndExpiry() async {
        let m = makeModel()
        await m.mintCode(token: "tok")
        guard case let .showingCode(code, expiresAt) = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertEqual(code, "K7M3X9")
        XCTAssertEqual(expiresAt, 1800000000)
    }

    /// Signed out is not "something went wrong": the copy has to explain that
    /// receiving still works, which is why it is its own AccountError case.
    func testMintWhileSignedOutExplainsItself() async {
        let m = makeModel()
        pair.error = AccountError.notSignedIn
        await m.mintCode(token: "")
        guard case let .failed(msg) = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertTrue(msg.lowercased().contains("sign in"))
        XCTAssertTrue(msg.lowercased().contains("receive"))
    }

    // MARK: - joining and ICE

    func testJoinFetchesICEWithTheCode() async {
        let m = makeModel()
        await m.join(code: "K7M3X9")
        XCTAssertEqual(ice.fetchedCodes, ["K7M3X9"])
        XCTAssertTrue(conn.started)
    }

    /// TURN credentials only come back for a live code, so a failed fetch means
    /// the transfer would silently be STUN-only. Fail before connecting.
    func testICEFailureStopsBeforeConnecting() async {
        let m = makeModel()
        ice.error = AccountError.rateLimited
        await m.join(code: "K7M3X9")
        guard case .failed = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertFalse(conn.started, "connected despite having no ICE servers")
    }

    // MARK: - SAS

    /// The whole point of the round: nothing moves until a human confirms.
    func testSASBlocksUntilConfirmed() async {
        let m = makeModel()
        await m.join(code: "K7M3X9")
        conn.onSAS?("brave-otter-lamp")
        await settle()
        guard case let .verifying(sas) = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertEqual(sas, "brave-otter-lamp")
        XCTAssertTrue(conn.sentMetas.isEmpty, "sent before the SAS was confirmed")
    }

    func testConfirmMovesOn() async {
        let m = makeModel()
        await m.join(code: "K7M3X9")
        conn.onSAS?("x")
        await settle()
        m.confirmSAS()
        if case .verifying = m.state { XCTFail("still blocked after confirming") }
    }

    /// Reject closes the connection. A mismatched SAS is what a man-in-the-middle
    /// looks like, so there is no "try again on this connection".
    func testRejectClosesTheConnection() async {
        let m = makeModel()
        await m.join(code: "K7M3X9")
        conn.onSAS?("x")
        await settle()
        m.rejectSAS()
        XCTAssertEqual(conn.closeCount, 1)
        guard case .idle = m.state else { return XCTFail("got \(m.state)") }
    }

    // MARK: - receiving

    func testWritesIncomingFilesAndCompletes() async throws {
        let dir = try tempDir()
        let m = makeModel()
        m.saveDirectory = dir
        await m.join(code: "K7M3X9")
        conn.onSAS?("x")
        await settle()
        m.confirmSAS()
        conn.onManifest?([FileMeta(name: "a.txt", size: 3), FileMeta(name: "b.txt", size: 2)])
        conn.onFileChunk?([1, 2, 3, 4])
        await settle()
        conn.onFileChunk?([5])
        conn.onDone?(true)
        await settle()
        guard case let .completed(urls) = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertEqual(try Data(contentsOf: urls[0]), Data([1, 2, 3]))
        XCTAssertEqual(try Data(contentsOf: urls[1]), Data([4, 5]))
    }

    // MARK: - the sender's end of a transfer

    /// A sender never receives a DONE frame — its own — so CTRL_COMPLETE is the
    /// only thing that tells it the batch landed. Without this the send sits in
    /// `.transferring` forever and the peer's disconnect turns a success into
    /// "The other device disconnected."
    func testSenderCompletesOnTheCompleteControl() async {
        let m = makeModel()
        m.stageSend(sources: [], metas: [FileMeta(name: "a.txt", size: 3)])
        await m.join(code: "K7M3X9", role: .initiator)
        conn.onSAS?("x")
        await settle()
        m.confirmSAS()
        conn.onControl?(.complete)
        await settle()
        guard case .completed = m.state else { return XCTFail("got \(m.state)") }
    }

    /// The peer hanging up after it has confirmed the batch is the normal end of
    /// a send, not a failure.
    func testPeerDisconnectAfterCompleteIsNotAFailure() async {
        let m = makeModel()
        m.stageSend(sources: [], metas: [FileMeta(name: "a.txt", size: 3)])
        await m.join(code: "K7M3X9", role: .initiator)
        conn.onSAS?("x")
        await settle()
        m.confirmSAS()
        conn.onControl?(.complete)
        await settle()
        conn.onClose?()
        await settle()
        guard case .completed = m.state else { return XCTFail("got \(m.state)") }
    }

    /// The mirror image: our receiver has to send CTRL_COMPLETE, or the peer —
    /// native or the web sender, which waits on exactly this — never finishes.
    func testReceiverTellsThePeerTheBatchLanded() async throws {
        let dir = try tempDir()
        let m = makeModel()
        m.saveDirectory = dir
        await m.join(code: "K7M3X9")
        conn.onSAS?("x")
        await settle()
        m.confirmSAS()
        conn.onManifest?([FileMeta(name: "a.txt", size: 3)])
        conn.onFileChunk?([1, 2, 3])
        await settle()
        conn.onDone?(true)
        await settle()
        XCTAssertEqual(conn.completeCount, 1)
    }

    /// A batch that failed its integrity check must not be confirmed to the peer.
    func testReceiverDoesNotConfirmAFailedBatch() async throws {
        let dir = try tempDir()
        let m = makeModel()
        m.saveDirectory = dir
        await m.join(code: "K7M3X9")
        conn.onSAS?("x")
        await settle()
        m.confirmSAS()
        conn.onManifest?([FileMeta(name: "a.txt", size: 3)])
        conn.onFileChunk?([1, 2, 3])
        await settle()
        conn.onDone?(false)
        await settle()
        XCTAssertEqual(conn.completeCount, 0)
    }

    /// A failed integrity check must not leave files that look complete.
    func testFailedDoneDiscardsWhatWasWritten() async throws {
        let dir = try tempDir()
        let m = makeModel()
        m.saveDirectory = dir
        await m.join(code: "K7M3X9")
        conn.onSAS?("x")
        await settle()
        m.confirmSAS()
        conn.onManifest?([FileMeta(name: "a.txt", size: 3)])
        conn.onFileChunk?([1, 2, 3])
        await settle()
        conn.onDone?(false)
        await settle()
        guard case .failed = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("a.txt").path))
    }

    // MARK: - cancel

    func testCancelClosesAndDiscards() async throws {
        let dir = try tempDir()
        let m = makeModel()
        m.saveDirectory = dir
        await m.join(code: "K7M3X9")
        conn.onSAS?("x")
        await settle()
        m.confirmSAS()
        conn.onManifest?([FileMeta(name: "a.txt", size: 9)])
        conn.onFileChunk?([1, 2, 3])
        await settle()
        m.cancel()
        XCTAssertEqual(conn.closeCount, 1)
        guard case .idle = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("a.txt").path))
    }

    /// A callback from a session the user has left must not repaint the screen.
    func testSupersededCallbacksAreIgnored() async {
        let m = makeModel()
        await m.join(code: "K7M3X9")
        m.cancel()
        conn.onSAS?("late")
        await settle()
        guard case .idle = m.state else { return XCTFail("a superseded callback landed: \(m.state)") }
    }

    // MARK: - errors

    func testConnectionErrorSurfacesAsCopy() async {
        let m = makeModel()
        await m.join(code: "K7M3X9")
        conn.onError?(HandshakeError.mitm)
        await settle()
        // What the message *says* is ErrorCopy's job and is asserted there.
        guard case .failed = m.state else { return XCTFail("got \(m.state)") }
    }
}

/// Lets a test hold `makeConnection` suspended so the state *while waiting for
/// a peer* can be asserted, without sleeping on a wall clock.
private actor ConnectGate {
    private var cont: CheckedContinuation<Void, Never>?
    private var opened = false
    func wait() async {
        if opened { return }
        await withCheckedContinuation { self.cont = $0 }
    }
    func open() {
        opened = true
        cont?.resume()
        cont = nil
    }
}

extension RealtimeSessionModelTests {
    /// The sender mints a code and then joins its own room to wait there. Those
    /// are two steps of one action, and the second used to overwrite the first:
    /// `.showingCode` became `.joining`, so the pane replaced the code and its
    /// QR with "Connecting…" before either had been on screen for a frame.
    ///
    /// The user is then holding nothing to type into the other device, and the
    /// wait can only end in the 120s timeout.
    func testSenderKeepsShowingTheCodeWhileWaitingForAPeer() async {
        let gate = ConnectGate()
        let pair = StubPair(), ice = StubICE(), conn = StubConnection()
        let m = RealtimeSessionModel(pairClient: pair, iceClient: ice,
                                     makeConnection: { _, _, _ in
                                         await gate.wait()
                                         return conn
                                     })

        await m.mintCode(token: "tok")
        guard case .showingCode = m.state else { return XCTFail("mint: got \(m.state)") }

        let joining = Task { await m.join(code: "K7M3X9", role: .initiator) }
        await settle()

        // Still on screen: this is the whole point of the state.
        guard case let .showingCode(code, _) = m.state else {
            return XCTFail("the code stopped being shown while waiting: \(m.state)")
        }
        XCTAssertEqual(code, "K7M3X9")

        await gate.open()
        _ = await joining.value
        await settle()
        guard case .connecting = m.state else { return XCTFail("after peer: got \(m.state)") }
    }

    /// The receiver has no code to display — it typed one — so it must still
    /// show progress rather than sit on an empty screen.
    func testReceiverStillShowsConnecting() async {
        let gate = ConnectGate()
        let pair = StubPair(), ice = StubICE(), conn = StubConnection()
        let m = RealtimeSessionModel(pairClient: pair, iceClient: ice,
                                     makeConnection: { _, _, _ in
                                         await gate.wait()
                                         return conn
                                     })

        let joining = Task { await m.join(code: "K7M3X9") }
        await settle()
        guard case .joining = m.state else { return XCTFail("got \(m.state)") }

        await gate.open()
        _ = await joining.value
    }
}
