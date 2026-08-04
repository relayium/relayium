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

private final class StubConnection: RealtimePeerConnection, @unchecked Sendable {
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

    private(set) var closeCount = 0

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
    func close() { closeCount += 1 }
}

/// Foreground-only, said by the app rather than only by the copy.
///
/// This app claims no `UIBackgroundModes` and no background `URLSession`, so a
/// direct session cannot survive being sent to the background: the DataChannel
/// dies with the process's foreground time, and what the user comes back to is a
/// progress bar that has not moved and a peer that has already given up. The
/// choice is between that and ending the session honestly with a sentence
/// saying why.
///
/// It lives here rather than in a `.onChange(of: scenePhase)` for the ordinary
/// reason and one sharper one. The ordinary reason: a view's modifier is not
/// reachable from `swift test`. The sharper one: `scenePhase` has THREE values
/// and only one of them means the app is gone. Presenting a document picker, a
/// share sheet, a `PhotosPicker` or the app switcher all produce `.inactive`,
/// and an implementation that treats `.inactive` as "we are leaving" cancels the
/// transfer the user is in the middle of setting up, at the exact moment they
/// tap **Choose Files**.
@MainActor
final class ForegroundSessionCoordinatorTests: XCTestCase {

    private var conn = StubConnection()

    private func makeFileModel() -> RealtimeSessionModel {
        let c = conn
        return RealtimeSessionModel(pairClient: StubPair(), iceClient: StubICE(),
                                    requiresVerification: { false },
                                    makeConnection: { _, _, _ in c })
    }

    private func makeTextModel() -> RealtimeTextSessionModel {
        let c = conn
        return RealtimeTextSessionModel(pairClient: StubPair(), iceClient: StubICE(),
                                        requiresVerification: { false },
                                        makeConnection: { _, _, _ in c })
    }

    private func settle() async { await Task.yield(); await Task.yield() }

    private func tempDir() throws -> URL {
        let d = FileManager.default.temporaryDirectory
            .appendingPathComponent("r3e-fg-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    /// A live receive, mid-transfer, with one chunk on disk.
    private func liveReceive(into dir: URL) async -> RealtimeSessionModel {
        conn = StubConnection()
        let model = makeFileModel()
        model.saveDirectory = dir
        await model.join(code: "483920")
        conn.onSAS?("x")
        conn.onOpen?()
        await settle()
        conn.onManifest?([FileMeta(name: "big.bin", size: 9)])
        conn.onFileChunk?([1, 2, 3])
        await settle()
        return model
    }

    // MARK: - .inactive is not .background

    /// The whole reason this is a typed phase rather than a boolean.
    func testInactiveDoesNotTouchALiveFileSession() async throws {
        let dir = try tempDir()
        let file = await liveReceive(into: dir)
        let coordinator = ForegroundSessionCoordinator(file: file, text: makeTextModel())

        coordinator.phaseChanged(to: .inactive)
        await settle()

        guard case .transferring = file.state else {
            return XCTFail("a document picker ended the transfer: \(file.state)")
        }
        XCTAssertNil(coordinator.interruption)
    }

    func testInactiveDoesNotTouchALiveTextSession() async {
        conn = StubConnection()
        let text = makeTextModel()
        await text.join(code: "483920")
        conn.onSAS?("x")
        conn.onOpen?()
        await settle()
        guard case .open = text.state else { return XCTFail("got \(text.state)") }

        let coordinator = ForegroundSessionCoordinator(file: makeFileModel(), text: text)
        coordinator.phaseChanged(to: .inactive)
        await settle()

        guard case .open = text.state else {
            return XCTFail("the share sheet ended the session: \(text.state)")
        }
        XCTAssertNil(coordinator.interruption)
    }

    // MARK: - .background ends what cannot survive it

    /// Cancelled AND cleaned up: a half-written file left in the receive folder
    /// is a file the Files app shows, under a name the manifest chose, with no
    /// indication that only part of it arrived.
    func testBackgroundCancelsALiveFileSessionAndRemovesThePartialWrite() async throws {
        let dir = try tempDir()
        let file = await liveReceive(into: dir)
        let coordinator = ForegroundSessionCoordinator(file: file, text: makeTextModel())

        coordinator.phaseChanged(to: .background)
        await settle()

        XCTAssertEqual(file.state, .idle, "the session outlived the foreground")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path), [],
                       "a partially received file was left in the receive folder")
        XCTAssertNotNil(coordinator.interruption,
                        "the session ended with no explanation")
    }

    /// Text ends but the transcript stays. The messages are already decrypted
    /// and already on screen; taking them away because the app was backgrounded
    /// destroys the only copy that ever existed — `RealtimeTextSessionModel`
    /// keeps no server-side history by design.
    func testBackgroundEndsALiveTextSessionButKeepsItsHistory() async {
        conn = StubConnection()
        let text = makeTextModel()
        await text.join(code: "483920")
        conn.onSAS?("x")
        conn.onOpen?()
        await settle()
        conn.onText?("from the other device", 24)
        await settle()
        XCTAssertEqual(text.history.count, 1)

        let coordinator = ForegroundSessionCoordinator(file: makeFileModel(), text: text)
        coordinator.phaseChanged(to: .background)
        await settle()

        XCTAssertEqual(text.state, .ended)
        XCTAssertEqual(text.history.count, 1, "backgrounding destroyed the only copy")
        XCTAssertNotNil(coordinator.interruption)
    }

    /// Nothing running: no notice. An interruption message on an app that was
    /// merely put away is noise, and noise is what teaches people to dismiss the
    /// one that matters.
    func testBackgroundWithNothingRunningSaysNothing() async {
        let coordinator = ForegroundSessionCoordinator(file: makeFileModel(),
                                                       text: makeTextModel())
        coordinator.phaseChanged(to: .background)
        await settle()
        XCTAssertNil(coordinator.interruption)
    }

    /// A finished receive is not a running session. Cancelling it would discard
    /// the writer that already returned, and the result — plus the share
    /// affordance built on it — would go with it.
    func testBackgroundLeavesACompletedReceiveAndItsFilesAlone() async throws {
        let dir = try tempDir()
        conn = StubConnection()
        let file = makeFileModel()
        file.saveDirectory = dir
        await file.join(code: "483920")
        conn.onSAS?("x")
        conn.onOpen?()
        await settle()
        conn.onManifest?([FileMeta(name: "whole.bin", size: 2)])
        conn.onFileChunk?([7, 8])
        conn.onDone?(true)
        await settle()
        guard case .completed = file.state else { return XCTFail("got \(file.state)") }

        let coordinator = ForegroundSessionCoordinator(file: file, text: makeTextModel())
        coordinator.phaseChanged(to: .background)
        await settle()

        guard case .completed = file.state else {
            return XCTFail("a finished receive was cancelled: \(file.state)")
        }
        XCTAssertEqual(try Data(contentsOf: dir.appendingPathComponent("whole.bin")),
                       Data([7, 8]), "the received file was deleted on backgrounding")
        XCTAssertNil(coordinator.interruption, "a finished transfer was reported as interrupted")
    }

    /// A retained terminal text state is left alone for the same reason, and its
    /// history with it.
    func testBackgroundLeavesAnAlreadyEndedTextSessionAlone() async {
        conn = StubConnection()
        let text = makeTextModel()
        await text.join(code: "483920")
        conn.onSAS?("x")
        conn.onOpen?()
        await settle()
        conn.onText?("hello", 8)
        await settle()
        text.end()

        let coordinator = ForegroundSessionCoordinator(file: makeFileModel(), text: text)
        coordinator.phaseChanged(to: .background)
        await settle()

        XCTAssertEqual(text.history.count, 1)
        XCTAssertNil(coordinator.interruption)
    }

    // MARK: - the notice

    /// It has to survive the return to the foreground, which is the only moment
    /// anybody can read it, and go away when the user says so.
    func testTheNoticeSurvivesTheReturnToForegroundAndIsDismissible() async throws {
        let dir = try tempDir()
        let file = await liveReceive(into: dir)
        let coordinator = ForegroundSessionCoordinator(file: file, text: makeTextModel())

        coordinator.phaseChanged(to: .background)
        coordinator.phaseChanged(to: .inactive)
        coordinator.phaseChanged(to: .active)
        await settle()
        XCTAssertNotNil(coordinator.interruption,
                        "the explanation was gone before the app was back on screen")

        coordinator.dismissInterruption()
        XCTAssertNil(coordinator.interruption)
    }

    /// Starting another session clears it: the sentence describes a session that
    /// is no longer the one on screen.
    func testStartingAnotherSessionClearsTheNotice() async throws {
        let dir = try tempDir()
        let file = await liveReceive(into: dir)
        let coordinator = ForegroundSessionCoordinator(file: file, text: makeTextModel())
        coordinator.phaseChanged(to: .background)
        await settle()
        XCTAssertNotNil(coordinator.interruption)

        coordinator.sessionStarting()
        XCTAssertNil(coordinator.interruption)
    }

    /// The copy is the shared catalog's, in the rendered language, and it says
    /// what happened and why rather than naming a lifecycle state.
    func testTheNoticeIsLocalisedCopyAndNotALifecycleString() async throws {
        let dir = try tempDir()
        let file = await liveReceive(into: dir)
        let coordinator = ForegroundSessionCoordinator(file: file, text: makeTextModel())
        coordinator.phaseChanged(to: .background)
        await settle()
        XCTAssertEqual(coordinator.interruption, L10n.t(.directInterrupted))
        for language in AppLanguage.allCases {
            let copy = L10n.t(.directInterrupted, language: language)
            XCTAssertFalse(copy.isEmpty)
            for apiName in ["scenePhase", "UIApplication", "%@"] {
                XCTAssertFalse(copy.contains(apiName),
                               "\(language) renders \(apiName) rather than what happened")
            }
        }
    }
}
