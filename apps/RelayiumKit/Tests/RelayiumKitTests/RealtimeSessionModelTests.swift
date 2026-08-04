import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

// MARK: - stubs

private final class StubPair: PairCodeClient, @unchecked Sendable {
    var result = MintedCode(code: "483920", expiresAt: 1800000000)
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
    var onText: ((String, Int) -> Void)?
    var onControl: ((RealtimeControl) -> Void)?
    var onClose: (() -> Void)?
    var onError: ((Error) -> Void)?

    private(set) var started = false
    private(set) var closeCount = 0
    private(set) var sentMetas: [FileMeta] = []
    private(set) var completeCount = 0
    private(set) var acceptCount = 0
    private(set) var rejectCount = 0

    func start() { started = true }
    func send(sources: [PlaintextSource], metas: [FileMeta]) { sentMetas = metas }
    func accept() { acceptCount += 1 }
    func reject() { rejectCount += 1 }
    func complete() { completeCount += 1 }
    func confirmTextSAS() {}
    func acceptText() {}
    func rejectText() {}
    func sendText(_ body: String, completion: @escaping (Error?) -> Void) { completion(nil) }
    var textBufferedAmount: UInt64 { 0 }
    func close() { closeCount += 1 }
}

@MainActor
final class RealtimeSessionModelTests: XCTestCase {
    private var pair = StubPair()
    private var ice = StubICE()
    private var conn = StubConnection()

    /// `verify` is the advanced-verification preference. It defaults to TRUE
    /// here, not to the product default, because most of the cases below are
    /// about what the blocking gate does — and a helper that silently made them
    /// all take the ungated path would leave the gate untested while every
    /// assertion still passed. The default-OFF behaviour has its own section.
    private func makeModel(verify: Bool = true) -> RealtimeSessionModel {
        pair = StubPair(); ice = StubICE(); conn = StubConnection()
        let c = conn
        return RealtimeSessionModel(pairClient: pair, iceClient: ice,
                                    requiresVerification: { verify },
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
        XCTAssertEqual(code, "483920")
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

    func testJoinCodeUsesTheSameFilteringAsADeepLink() {
        let m = makeModel()
        m.updateJoinCode("48 39-20x")
        XCTAssertEqual(m.joinCode, "483920")
        XCTAssertTrue(m.canJoin)
        m.updateJoinCode("4839")
        XCTAssertFalse(m.canJoin)
    }

    func testJoinFetchesICEWithTheCode() async {
        let m = makeModel()
        await m.join(code: "483920")
        XCTAssertEqual(ice.fetchedCodes, ["483920"])
        XCTAssertTrue(conn.started)
    }

    /// TURN credentials only come back for a live code, so a failed fetch means
    /// the transfer would silently be STUN-only. Fail before connecting.
    func testICEFailureStopsBeforeConnecting() async {
        let m = makeModel()
        ice.error = AccountError.rateLimited
        await m.join(code: "483920")
        guard case .failed = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertFalse(conn.started, "connected despite having no ICE servers")
    }

    // MARK: - SAS, with advanced verification OFF (the product default)

    /// `onSAS` fires on the SIGNALLING channel, as soon as the peer's reveal
    /// verifies — which can be BEFORE the DataChannel finishes opening. Nothing
    /// may be written until both have happened: the send path does not check
    /// readyState, so an early manifest is dropped by WebRTC and the transfer
    /// stalls with no error at all.
    ///
    /// The blocking gate used to hide this (a human takes seconds, and the
    /// channel was always open by the time they clicked). With verification off
    /// there is no such pause, so the ordering is pinned here in both modes.
    func testNothingIsSentUntilTheDataChannelIsOpen() async {
        for verify in [false, true] {
            let m = makeModel(verify: verify)
            m.stageSend(sources: [], metas: [])
            await m.join(code: "483920")

            conn.onSAS?("brave-otter-lamp")
            await settle()
            guard case .connecting = m.state else {
                return XCTFail("verify=\(verify): moved on before the channel opened: \(m.state)")
            }
            XCTAssertTrue(conn.sentMetas.isEmpty, "verify=\(verify): sent before the channel opened")

            conn.onOpen?()
            await settle()
            if verify {
                guard case .verifying = m.state else { return XCTFail("got \(m.state)") }
            } else {
                guard case .transferring = m.state else { return XCTFail("got \(m.state)") }
            }
        }
    }

    /// And in the other order, which is the common one.
    func testOpenBeforeSASAlsoAdvances() async {
        let m = makeModel(verify: false)
        await m.join(code: "483920")
        conn.onOpen?()
        await settle()
        guard case .connecting = m.state else { return XCTFail("advanced with no SAS yet: \(m.state)") }
        conn.onSAS?("x")
        await settle()
        guard case .transferring = m.state else { return XCTFail("got \(m.state)") }
    }

    /// The default has to be the default. Constructed WITHOUT the parameter, so
    /// this fails if the shipped default is ever flipped by an edit elsewhere.
    func testVerificationIsOffByDefault() async {
        pair = StubPair(); ice = StubICE(); conn = StubConnection()
        let c = conn
        let m = RealtimeSessionModel(pairClient: pair, iceClient: ice,
                                     makeConnection: { _, _, _ in c })
        await m.join(code: "483920")
        conn.onSAS?("brave-otter-lamp")
        conn.onOpen?()
        await settle()
        if case .verifying = m.state { XCTFail("blocked on the SAS with verification off") }
    }

    /// A staged send goes out as soon as the commit-reveal-complete encrypted
    /// connection is ready — no human has vouched for who the peer is.
    func testUnverifiedSenderStagesAndSendsWithoutAGate() async {
        let m = makeModel(verify: false)
        m.stageSend(sources: [], metas: [])
        await m.join(code: "483920")
        conn.onSAS?("brave-otter-lamp")
        conn.onOpen?()
        await settle()
        guard case .transferring = m.state else { return XCTFail("got \(m.state)") }
    }

    /// And a receiver accepts as soon as the manifest lands, rather than after a
    /// gate nobody was shown.
    func testUnverifiedReceiverAcceptsWhenTheManifestArrives() async throws {
        let m = makeModel(verify: false)
        m.saveDirectory = try tempDir()
        await m.join(code: "483920")
        conn.onSAS?("x")
        conn.onOpen?()
        await settle()
        XCTAssertEqual(conn.acceptCount, 0, "accepted before the peer offered anything")

        conn.onManifest?([FileMeta(name: "a.txt", size: 3)])
        await settle()
        XCTAssertEqual(conn.acceptCount, 1)
        guard case .transferring = m.state else { return XCTFail("got \(m.state)") }
    }

    /// The derived SAS is kept in both modes. Turning the preference on must be
    /// a display decision, not something that needs a fresh handshake.
    func testDerivedSASIsRetainedEvenWhenNotShown() async {
        let m = makeModel(verify: false)
        await m.join(code: "483920")
        conn.onSAS?("brave-otter-lamp")
        conn.onOpen?()
        await settle()
        XCTAssertEqual(m.sasCode, "brave-otter-lamp")
    }

    /// Cryptographic failure is not gated on the preference. With verification
    /// off, a DONE that does not match still destroys the transfer.
    func testTamperStillFailsWithVerificationOff() async throws {
        let m = makeModel(verify: false)
        m.saveDirectory = try tempDir()
        await m.join(code: "483920")
        conn.onSAS?("x")
        conn.onOpen?()
        await settle()
        conn.onManifest?([FileMeta(name: "a.txt", size: 3)])
        await settle()
        conn.onFileChunk?([1, 2, 3])
        await settle()
        conn.onDone?(false)
        await settle()
        guard case .failed = m.state else { return XCTFail("tampered DONE accepted: \(m.state)") }
        XCTAssertFalse(FileManager.default.fileExists(atPath: m.saveDirectory.appendingPathComponent("a.txt").path))
    }

    // MARK: - SAS, with advanced verification ON

    /// With the preference on, nothing moves until a human confirms.
    func testSASBlocksUntilConfirmed() async {
        let m = makeModel()
        await m.join(code: "483920")
        conn.onSAS?("brave-otter-lamp")
        conn.onOpen?()
        await settle()
        guard case let .verifying(sas) = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertEqual(sas, "brave-otter-lamp")
        XCTAssertTrue(conn.sentMetas.isEmpty, "sent before the SAS was confirmed")
    }

    func testConfirmMovesOn() async {
        let m = makeModel()
        await m.join(code: "483920")
        conn.onSAS?("x")
        conn.onOpen?()
        await settle()
        m.confirmSAS()
        if case .verifying = m.state { XCTFail("still blocked after confirming") }
    }

    /// Reject closes the connection. A mismatched SAS is what a man-in-the-middle
    /// looks like, so there is no "try again on this connection".
    func testRejectClosesTheConnection() async {
        let m = makeModel()
        await m.join(code: "483920")
        conn.onSAS?("x")
        conn.onOpen?()
        await settle()
        m.rejectSAS()
        XCTAssertEqual(conn.rejectCount, 1)
        XCTAssertEqual(conn.closeCount, 1)
        guard case .idle = m.state else { return XCTFail("got \(m.state)") }
    }

    func testPeerRejectWhileVerifyingDoesNotLeaveFakeProgress() async {
        let m = makeModel()
        await m.join(code: "483920")
        conn.onSAS?("x")
        conn.onOpen?()
        await settle()

        conn.onControl?(.reject)
        conn.onClose?()
        await settle()
        guard case let .failed(message) = m.state else {
            return XCTFail("got \(m.state)")
        }
        XCTAssertTrue(message.lowercased().contains("declined"))
    }

    func testDisconnectWhileVerifyingFailsInsteadOfHanging() async {
        let m = makeModel()
        await m.join(code: "483920")
        conn.onSAS?("x")
        conn.onOpen?()
        await settle()

        conn.onClose?()
        await settle()
        guard case .failed = m.state else { return XCTFail("got \(m.state)") }
    }

    // MARK: - receiving

    func testReceiverKeepsSASGateAndSendsAcceptOnlyAfterConfirmation() async throws {
        let m = makeModel()
        m.saveDirectory = try tempDir()
        await m.join(code: "483920")
        conn.onSAS?("brave-otter-lamp")
        conn.onOpen?()
        await settle()

        conn.onManifest?([FileMeta(name: "a.txt", size: 3)])
        await settle()
        guard case let .verifying(sas) = m.state else {
            return XCTFail("manifest bypassed the SAS gate: \(m.state)")
        }
        XCTAssertEqual(sas, "brave-otter-lamp")
        XCTAssertEqual(conn.acceptCount, 0, "accepted before the user confirmed the SAS")
        XCTAssertFalse(FileManager.default.fileExists(atPath: m.saveDirectory.appendingPathComponent("a.txt").path),
                       "receiving a manifest must not touch disk before SAS consent")

        m.confirmSAS()
        guard case .transferring = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertEqual(conn.acceptCount, 1)
    }

    func testReceiverConfirmedBeforeManifestAcceptsWhenManifestArrives() async throws {
        let m = makeModel()
        m.saveDirectory = try tempDir()
        await m.join(code: "483920")
        conn.onSAS?("x")
        conn.onOpen?()
        await settle()
        m.confirmSAS()
        XCTAssertEqual(conn.acceptCount, 0)

        conn.onManifest?([FileMeta(name: "a.txt", size: 3)])
        await settle()
        XCTAssertEqual(conn.acceptCount, 1)
        guard case let .transferring(done, total) = m.state else {
            return XCTFail("got \(m.state)")
        }
        XCTAssertEqual(done, 0)
        XCTAssertEqual(total, 3)
    }

    func testReceiverWriterFailureRejectsAndClosesBeforeTransfer() async {
        let m = makeModel()
        m.saveDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("missing-\(UUID().uuidString)")
        await m.join(code: "483920")
        conn.onSAS?("x")
        conn.onOpen?()
        await settle()
        m.confirmSAS()

        conn.onManifest?([FileMeta(name: "a.txt", size: 3)])
        await settle()

        XCTAssertEqual(conn.rejectCount, 1)
        XCTAssertEqual(conn.acceptCount, 0)
        XCTAssertEqual(conn.closeCount, 1)
        guard case .failed = m.state else { return XCTFail("got \(m.state)") }
    }

    func testWritesIncomingFilesAndCompletes() async throws {
        let dir = try tempDir()
        let m = makeModel()
        m.saveDirectory = dir
        await m.join(code: "483920")
        conn.onSAS?("x")
        conn.onOpen?()
        await settle()
        m.confirmSAS()
        conn.onManifest?([FileMeta(name: "a.txt", size: 3), FileMeta(name: "b.txt", size: 2)])
        conn.onFileChunk?([1, 2, 3, 4])
        await settle()
        conn.onFileChunk?([5])
        conn.onDone?(true)
        await settle()
        guard case .transferring = m.state else { return XCTFail("completed before every file DONE: \(m.state)") }
        conn.onDone?(true)
        await settle()
        guard case let .completed(urls) = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertEqual(try Data(contentsOf: urls[0]), Data([1, 2, 3]))
        XCTAssertEqual(try Data(contentsOf: urls[1]), Data([4, 5]))
    }

    /// A transport error that arrives AFTER the receive completed must not
    /// delete the files.
    ///
    /// This is the shape of a real data-loss bug observed on a running build:
    /// the sender sees `complete`, the app shows the received file, and roughly
    /// fifteen seconds later — when the peer connection finally tears itself
    /// down and reports an error — `onError` discarded the writer and replaced
    /// the terminal `.completed` with a failure. The file the user had already
    /// been shown, and had been told to reveal in Finder, vanished from disk.
    ///
    /// `.completed` is terminal and its bytes belong to the user. A late error
    /// on a connection that has already finished its job describes the
    /// connection, not the transfer, and `onClose` already knows that (it guards
    /// on `isBusy`). `onError` did not.
    func testALateTransportErrorCannotDeleteACompletedReceive() async throws {
        let dir = try tempDir()
        let m = makeModel()
        m.saveDirectory = dir
        await m.join(code: "483920")
        conn.onSAS?("x")
        conn.onOpen?()
        await settle()
        m.confirmSAS()
        conn.onManifest?([FileMeta(name: "a.txt", size: 3)])
        conn.onFileChunk?([1, 2, 3])
        conn.onDone?(true)
        await settle()
        guard case let .completed(urls) = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertEqual(try Data(contentsOf: urls[0]), Data([1, 2, 3]))

        // The connection dies afterwards, as every connection eventually does.
        conn.onError?(HandshakeError.mitm)
        await settle()

        guard case let .completed(after) = m.state else {
            return XCTFail("a late transport error replaced the terminal result: \(m.state)")
        }
        XCTAssertEqual(after, urls, "the completed result must keep naming the same files")
        XCTAssertTrue(FileManager.default.fileExists(atPath: urls[0].path),
                      "the received file was deleted after it had been handed to the user")
        XCTAssertEqual(try Data(contentsOf: urls[0]), Data([1, 2, 3]),
                       "the received file's bytes must survive a late transport error")
    }

    /// The same rule for a late close, which reaches the same writer by another
    /// path. Already guarded by `isBusy`; asserted so the guard cannot be
    /// dropped without a red test.
    func testALateCloseCannotDeleteACompletedReceive() async throws {
        let dir = try tempDir()
        let m = makeModel()
        m.saveDirectory = dir
        await m.join(code: "483920")
        conn.onSAS?("x")
        conn.onOpen?()
        await settle()
        m.confirmSAS()
        conn.onManifest?([FileMeta(name: "a.txt", size: 3)])
        conn.onFileChunk?([1, 2, 3])
        conn.onDone?(true)
        await settle()
        guard case let .completed(urls) = m.state else { return XCTFail("got \(m.state)") }

        conn.onClose?()
        await settle()

        guard case .completed = m.state else {
            return XCTFail("a late close replaced the terminal result: \(m.state)")
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: urls[0].path),
                      "the received file was deleted by a late close")
    }

    /// A late error must not overwrite the FIRST failure's reason either. The
    /// user acts on the message they were given; replacing "the peer declined"
    /// with whatever the socket said on its way out turns a specific diagnosis
    /// into a generic one.
    ///
    /// The first failure is a peer REJECT rather than a tampered DONE because
    /// only REJECT leaves the generation alone. `failReceive` tears the session
    /// down, which bumps the generation, so every later callback is dropped by
    /// `apply`'s generation check before the terminal-state guard is ever
    /// consulted — a test written that way stays green with the guard deleted.
    /// This one reaches `onError` on the live generation, so the guard is the
    /// only thing keeping the message the user was shown.
    func testALateTransportErrorDoesNotRewriteAnEarlierFailure() async throws {
        let m = makeModel()
        m.saveDirectory = try tempDir()
        await m.join(code: "483920")
        conn.onSAS?("x")
        conn.onOpen?()
        await settle()
        m.confirmSAS()
        conn.onManifest?([FileMeta(name: "a.txt", size: 3)])
        conn.onFileChunk?([1, 2, 3])
        conn.onControl?(.reject)     // the peer declines: the first, specific failure
        await settle()
        guard case let .failed(first) = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertTrue(first.lowercased().contains("declined"),
                      "the captured failure has to be the reject, not something else: \(first)")

        conn.onError?(HandshakeError.mitm)
        await settle()

        guard case let .failed(after) = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertEqual(after, first, "a late error rewrote the failure the user was already shown")
    }

    /// A folder receive, end to end through the model: the tree is rebuilt under
    /// a container named after the folder that was sent, and that container —
    /// not the loose files — is what Finder gets handed.
    func testFolderReceiveRebuildsTheTreeUnderItsOwnContainer() async throws {
        let dir = try tempDir()
        let m = makeModel()
        m.saveDirectory = dir
        await m.join(code: "483920")
        conn.onSAS?("x")
        conn.onOpen?()
        await settle()
        m.confirmSAS()
        conn.onManifest?([
            FileMeta(name: "a.txt", size: 3, path: "trip/day1/a.txt"),
            FileMeta(name: "b.txt", size: 2, path: "trip/b.txt"),
        ])
        conn.onFileChunk?([1, 2, 3])
        conn.onDone?(true)
        await settle()
        conn.onFileChunk?([4, 5])
        conn.onDone?(true)
        await settle()
        guard case let .completed(urls) = m.state else { return XCTFail("got \(m.state)") }
        let base = dir.standardized.path
        XCTAssertEqual(urls.map { String($0.standardized.path.dropFirst(base.count + 1)) },
                       ["trip/day1/a.txt", "trip/b.txt"])
        XCTAssertEqual(try Data(contentsOf: urls[0]), Data([1, 2, 3]))
        XCTAssertEqual(try Data(contentsOf: urls[1]), Data([4, 5]))
        let container = try XCTUnwrap(m.receivedContainer)
        XCTAssertEqual(container.lastPathComponent, "trip")
        XCTAssertEqual(m.received?.dragURLs, [container])
    }

    // MARK: - a retry inherits nothing from the session it replaced

    /// A retry must reach readiness on its OWN two callbacks.
    ///
    /// `advanceWhenReady` needs both a SAS and an open DataChannel. Retiring a
    /// connection used to leave `sasCode` and `connectionOpened` set, so the
    /// very first callback of the new session could combine with the dead one's
    /// state and clear the transfer — one peer's `onOpen` plus a different
    /// peer's SAS.
    func testARetryNeedsItsOwnSASAndOpenNotThePreviousSessions() async {
        let m = makeModel()
        await m.join(code: "483920")
        conn.onSAS?("old-sas")
        conn.onOpen?()
        await settle()
        guard case .verifying = m.state else { return XCTFail("got \(m.state)") }

        // The session dies and the user retries directly.
        await m.join(code: "483920")
        XCTAssertEqual(m.sasCode, "", "the dead session's SAS survived the retry")
        guard case .connecting = m.state else { return XCTFail("got \(m.state)") }

        // Only the SAS: not enough on its own.
        conn.onSAS?("new-sas")
        await settle()
        guard case .connecting = m.state else {
            return XCTFail("advanced on a SAS alone: \(m.state)")
        }
        // Now the channel opens too.
        conn.onOpen?()
        await settle()
        guard case .verifying(let sas) = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertEqual(sas, "new-sas")
    }

    /// The same, with the two callbacks in the other order — they genuinely
    /// arrive either way, and the fix must not depend on which comes first.
    func testARetryNeedsItsOwnSASAndOpenInTheOtherOrder() async {
        let m = makeModel()
        await m.join(code: "483920")
        conn.onSAS?("old-sas")
        conn.onOpen?()
        await settle()

        await m.join(code: "483920")
        conn.onOpen?()
        await settle()
        guard case .connecting = m.state else {
            return XCTFail("advanced on an open alone, using the old SAS: \(m.state)")
        }
        conn.onSAS?("new-sas")
        await settle()
        guard case .verifying = m.state else { return XCTFail("got \(m.state)") }
    }

    /// A retry must not install — or ACCEPT — the previous peer's manifest.
    ///
    /// `pendingReceive` and `incoming` used to survive the retirement, so
    /// confirming the SAS on the NEW connection ran `startPendingReceive` for
    /// files the new peer had never offered, and sent it CTRL_ACCEPT.
    func testARetryCannotInheritOrAcceptThePreviousPendingReceive() async throws {
        let dir = try tempDir()
        let m = makeModel()
        m.saveDirectory = dir
        await m.join(code: "483920")
        conn.onSAS?("old")
        conn.onOpen?()
        await settle()
        // The manifest lands while the user is still reading the SAS gate, so
        // the receive is pending but not started.
        conn.onManifest?([FileMeta(name: "theirs.txt", size: 4)])
        await settle()
        XCTAssertEqual(m.incoming.count, 1)

        await m.join(code: "483920")
        XCTAssertTrue(m.incoming.isEmpty, "the previous peer's manifest survived the retry")

        conn.onSAS?("new")
        conn.onOpen?()
        await settle()
        let acceptsBefore = conn.acceptCount
        m.confirmSAS()
        await settle()
        XCTAssertEqual(conn.acceptCount, acceptsBefore,
                       "the retry ACCEPTed a manifest the new peer never sent")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path), [],
                       "the retry created files for the previous peer's manifest")
    }

    /// A retry keeps the staged outbound selection — re-picking files is not a
    /// safety measure, and it is the whole reason a user retries — including the
    /// byte total the progress bar is drawn from.
    func testARetryKeepsTheStagedSendAndItsTotal() async {
        let m = makeModel(verify: false)
        m.stageSend(sources: [DataSource(name: "a.txt", bytes: [1, 2, 3])],
                    metas: [FileMeta(name: "a.txt", size: 3)])
        await m.join(code: "483920", role: .initiator)
        conn.onSAS?("x")
        conn.onOpen?()
        await settle()

        await m.join(code: "483920", role: .initiator)
        conn.onSAS?("y")
        conn.onOpen?()
        await settle()
        guard case .transferring(_, let total) = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertEqual(total, 3, "the staged send's byte total was lost across the retry")
        XCTAssertEqual(conn.sentMetas.map(\.name), ["a.txt"])
    }

    // MARK: - a RESPONDER join never inherits a staged outbound selection

    /// The stale-outbound hazard, and the direction `retirePreviousConnection`
    /// deliberately does not cover.
    ///
    /// `pendingSend` survives a retry on purpose — re-picking files is not a
    /// safety measure and it is the whole reason a user retries. But `join`
    /// takes a ROLE, and only one of its two values is a retry. A user who
    /// staged files, created a code, watched it fail or expire, and then typed
    /// the OTHER device's code to receive instead is not retrying anything: they
    /// are the responder now, and `proceedAfterVerification` sends whatever is
    /// pending. Without a clear here, the files they staged for a peer that
    /// never arrived go to the peer whose code they just joined — a disclosure
    /// nobody chose, on a path that looks like receiving.
    ///
    /// Same rule `acceptNearby` already enforces with the full `teardown`, on
    /// the entry point iOS actually has.
    func testAResponderJoinDropsAStagedOutboundSelection() async {
        let m = makeModel(verify: false)
        m.stageSend(sources: [DataSource(name: "private.txt", bytes: [1, 2, 3])],
                    metas: [FileMeta(name: "private.txt", size: 3)])
        await m.join(code: "483920")            // role defaults to .responder
        conn.onSAS?("x")
        conn.onOpen?()
        await settle()
        XCTAssertTrue(conn.sentMetas.isEmpty,
                      "a receive sent files staged for somebody else")
        guard case .transferring(_, let total) = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertEqual(total, 0,
                       "the receive inherited the staged send's byte total")
    }

    /// The realistic sequence, end to end: stage, create (initiator), the peer
    /// never answers, then join the other device's code to receive.
    func testAFailedCreateFollowedByAReceiveSendsNothing() async {
        let m = makeModel(verify: false)
        m.stageSend(sources: [DataSource(name: "private.txt", bytes: [1, 2, 3])],
                    metas: [FileMeta(name: "private.txt", size: 3)])
        await m.join(code: "111111", role: .initiator)
        conn.onError?(RealtimeError.tamper)
        await settle()
        guard case .failed = m.state else { return XCTFail("got \(m.state)") }

        await m.join(code: "222222")            // now the receiving direction
        conn.onSAS?("y")
        conn.onOpen?()
        await settle()
        XCTAssertTrue(conn.sentMetas.isEmpty,
                      "a receive after a failed create sent the old files")
    }

    /// And the responder clear must not be reachable through the initiator, or
    /// it would take the retry behaviour with it. This is the same claim
    /// `testARetryKeepsTheStagedSendAndItsTotal` makes, restated as the negative
    /// half of the rule above so the two cannot be "fixed" together.
    func testAnInitiatorJoinStillKeepsTheStagedSelection() async {
        let m = makeModel(verify: false)
        m.stageSend(sources: [DataSource(name: "a.txt", bytes: [1, 2, 3])],
                    metas: [FileMeta(name: "a.txt", size: 3)])
        await m.join(code: "483920", role: .initiator)
        await m.join(code: "483920", role: .initiator)
        conn.onSAS?("x")
        conn.onOpen?()
        await settle()
        XCTAssertEqual(conn.sentMetas.map(\.name), ["a.txt"])
    }

    /// Retrying after a partial receive removes the debris; retrying after a
    /// COMPLETED one must not delete what the user just received.
    func testARetryDiscardsAPartialReceiveButKeepsACompletedOne() async throws {
        let partialDir = try tempDir()
        let m = makeModel(verify: false)
        m.saveDirectory = partialDir
        await m.join(code: "483920")
        conn.onSAS?("x")
        conn.onOpen?()
        await settle()
        conn.onManifest?([FileMeta(name: "half.bin", size: 9)])
        conn.onFileChunk?([1, 2, 3])
        await settle()
        await m.join(code: "483920")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: partialDir.path), [],
                       "a partial receive was left on disk by the retry")

        let doneDir = try tempDir()
        let m2 = makeModel(verify: false)
        m2.saveDirectory = doneDir
        await m2.join(code: "483920")
        conn.onSAS?("x")
        conn.onOpen?()
        await settle()
        conn.onManifest?([FileMeta(name: "whole.bin", size: 2)])
        conn.onFileChunk?([7, 8])
        conn.onDone?(true)
        await settle()
        guard case .completed = m2.state else { return XCTFail("got \(m2.state)") }
        await m2.join(code: "483920")
        XCTAssertEqual(try Data(contentsOf: doneDir.appendingPathComponent("whole.bin")),
                       Data([7, 8]), "the retry deleted a completed receive")
    }

    /// A new session does not inherit the last one's container.
    ///
    /// `received` is gated on `.completed`, so nothing surfaces a stale one
    /// today; clearing it at the point the previous connection is retired is
    /// what keeps that true rather than incidental.
    func testANewSessionDoesNotInheritTheLastOnesContainer() async throws {
        let dir = try tempDir()
        let m = makeModel()
        m.saveDirectory = dir
        await m.join(code: "483920")
        conn.onSAS?("x")
        conn.onOpen?()
        await settle()
        m.confirmSAS()
        conn.onManifest?([FileMeta(name: "a.txt", size: 1, path: "trip/a.txt")])
        conn.onFileChunk?([1])
        conn.onDone?(true)
        await settle()
        XCTAssertNotNil(m.receivedContainer)

        await m.join(code: "483920")
        XCTAssertNil(m.receivedContainer, "a new session inherited the previous container")
        XCTAssertNil(m.received)
    }

    /// A hostile manifest path is refused before anything is written, the peer
    /// is told, and the destination the user chose is left exactly as it was.
    func testFolderReceiveRefusesATraversingPathWithoutWriting() async throws {
        let dir = try tempDir()
        let m = makeModel()
        m.saveDirectory = dir
        await m.join(code: "483920")
        conn.onSAS?("x")
        conn.onOpen?()
        await settle()
        m.confirmSAS()
        conn.onManifest?([FileMeta(name: "a.txt", size: 3, path: "../escape.txt")])
        await settle()
        guard case .failed = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertEqual(conn.rejectCount, 1)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path), [])
        XCTAssertNil(m.received)
    }

    /// A flat receive is unchanged — no container, and the drag payload is the
    /// files themselves.
    func testFlatReceiveStillLandsDirectlyWithNoContainer() async throws {
        let dir = try tempDir()
        let m = makeModel()
        m.saveDirectory = dir
        await m.join(code: "483920")
        conn.onSAS?("x")
        conn.onOpen?()
        await settle()
        m.confirmSAS()
        conn.onManifest?([FileMeta(name: "a.txt", size: 1)])
        conn.onFileChunk?([1])
        conn.onDone?(true)
        await settle()
        guard case let .completed(urls) = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertNil(m.receivedContainer)
        XCTAssertEqual(m.received?.dragURLs, urls)
        XCTAssertEqual(urls[0].deletingLastPathComponent().standardized.path, dir.standardized.path)
    }

    // MARK: - the sender's end of a transfer

    /// A sender never receives a DONE frame — its own — so CTRL_COMPLETE is the
    /// only thing that tells it the batch landed. Without this the send sits in
    /// `.transferring` forever and the peer's disconnect turns a success into
    /// "The other device disconnected."
    func testSenderCompletesOnTheCompleteControl() async {
        let m = makeModel()
        m.stageSend(sources: [DataSource(name: "a.txt", bytes: [1, 2, 3])], metas: [FileMeta(name: "a.txt", size: 3)])
        await m.join(code: "483920", role: .initiator)
        conn.onSAS?("x")
        conn.onOpen?()
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
        m.stageSend(sources: [DataSource(name: "a.txt", bytes: [1, 2, 3])], metas: [FileMeta(name: "a.txt", size: 3)])
        await m.join(code: "483920", role: .initiator)
        conn.onSAS?("x")
        conn.onOpen?()
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
        await m.join(code: "483920")
        conn.onSAS?("x")
        conn.onOpen?()
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
        await m.join(code: "483920")
        conn.onSAS?("x")
        conn.onOpen?()
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
        await m.join(code: "483920")
        conn.onSAS?("x")
        conn.onOpen?()
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
        await m.join(code: "483920")
        conn.onSAS?("x")
        conn.onOpen?()
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

    /// `.failed` is a state the session STAYS in, so the error keeps its place
    /// on screen instead of blinking past. The cost of that is that the macOS
    /// destinations treat "not `.idle`" as "somebody is presenting a session"
    /// and keep the other one on its "shown elsewhere" card — so the pane's
    /// **Done** has to land the model back on `.idle`, and `cancel` is the call
    /// that does it from a failure as much as from a live transfer.
    func testCancelClearsAFailureBackToIdle() async {
        let m = makeModel()
        pair.error = AccountError.notSignedIn
        await m.mintCode(token: "")
        guard case .failed = m.state else { return XCTFail("got \(m.state)") }
        m.cancel()
        guard case .idle = m.state else { return XCTFail("Done left the session owned: \(m.state)") }
    }

    /// A callback from a session the user has left must not repaint the screen.
    func testSupersededCallbacksAreIgnored() async {
        let m = makeModel()
        await m.join(code: "483920")
        m.cancel()
        conn.onSAS?("late")
        conn.onOpen?()
        await settle()
        guard case .idle = m.state else { return XCTFail("a superseded callback landed: \(m.state)") }
    }

    // MARK: - errors

    func testConnectionErrorSurfacesAsCopy() async {
        let m = makeModel()
        await m.join(code: "483920")
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

        let joining = Task { await m.join(code: "483920", role: .initiator) }
        await settle()

        // Still on screen: this is the whole point of the state.
        guard case let .showingCode(code, _) = m.state else {
            return XCTFail("the code stopped being shown while waiting: \(m.state)")
        }
        XCTAssertEqual(code, "483920")

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

        let joining = Task { await m.join(code: "483920") }
        await settle()
        guard case .joining = m.state else { return XCTFail("got \(m.state)") }

        await gate.open()
        _ = await joining.value
    }
}
