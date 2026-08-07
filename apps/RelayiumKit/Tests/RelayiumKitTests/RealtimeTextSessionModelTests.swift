import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

private final class TextStubPair: PairCodeClient, @unchecked Sendable {
    var result = MintedCode(code: "483920", expiresAt: 1_800_000_000)
    var gate: TextMintGate?
    func mint(token: String) async throws -> MintedCode {
        if let gate { return await gate.wait() }
        return result
    }
}

private actor TextMintGate {
    private var resultContinuation: CheckedContinuation<MintedCode, Never>?
    private var startContinuations: [CheckedContinuation<Void, Never>] = []
    private var started = false

    func wait() async -> MintedCode {
        started = true
        startContinuations.forEach { $0.resume() }
        startContinuations = []
        return await withCheckedContinuation { resultContinuation = $0 }
    }

    func waitUntilStarted() async {
        if started { return }
        await withCheckedContinuation { startContinuations.append($0) }
    }

    func release(_ result: MintedCode) {
        resultContinuation?.resume(returning: result)
        resultContinuation = nil
    }
}

private final class TextStubICE: ICEConfigClient, @unchecked Sendable {
    func fetch(code: String) async throws -> ICEConfig {
        ICEConfig(iceServers: [ICEServerConfig(urls: ["stun:test"])])
    }
}

private actor TextICEGate {
    private var resultContinuation: CheckedContinuation<ICEConfig, Never>?
    private var startContinuations: [CheckedContinuation<Void, Never>] = []
    private var started = false

    func wait() async -> ICEConfig {
        started = true
        startContinuations.forEach { $0.resume() }
        startContinuations = []
        return await withCheckedContinuation { resultContinuation = $0 }
    }

    func waitUntilStarted() async {
        if started { return }
        await withCheckedContinuation { startContinuations.append($0) }
    }

    func release() {
        resultContinuation?.resume(returning: ICEConfig(
            iceServers: [ICEServerConfig(urls: ["stun:late"])]))
        resultContinuation = nil
    }
}

private final class GatedTextICE: ICEConfigClient, @unchecked Sendable {
    let gate = TextICEGate()
    func fetch(code: String) async throws -> ICEConfig { await gate.wait() }
}

private final class TextStubConnection: RealtimePeerConnection, @unchecked Sendable {
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
    private(set) var acceptTextCount = 0
    private(set) var rejectTextCount = 0
    private(set) var confirmTextSASCount = 0
    private(set) var closeCount = 0
    private(set) var sentBodies: [String] = []
    var nextSendError: Error?
    var holdSend = false
    var pendingSend: ((Error?) -> Void)?
    var holdInboundUntilSASConfirmation = false
    var pendingInbound: [(String, Int)] = []
    var textBufferedAmount: UInt64 = 0

    func start() { started = true }
    func send(sources: [PlaintextSource], metas: [FileMeta]) {}
    func accept() {}
    func reject() {}
    func complete() {}
    func confirmTextSAS() {
        confirmTextSASCount += 1
        let pending = pendingInbound
        pendingInbound = []
        for (body, bytes) in pending {
            onText?(body, bytes)
        }
    }
    func acceptText() { acceptTextCount += 1 }
    func rejectText() { rejectTextCount += 1 }
    func sendText(_ body: String, completion: @escaping (Error?) -> Void) {
        sentBodies.append(body)
        if holdSend {
            pendingSend = completion
        } else {
            completion(nextSendError)
        }
    }
    func close() { closeCount += 1 }

    func receiveText(_ body: String, framedBytes: Int) {
        if holdInboundUntilSASConfirmation, confirmTextSASCount == 0 {
            pendingInbound.append((body, framedBytes))
        } else {
            onText?(body, framedBytes)
        }
    }
}

private actor TextIdleGate {
    private var released = false
    private var started = false
    private var continuations: [CheckedContinuation<Void, Never>] = []
    private var startContinuations: [CheckedContinuation<Void, Never>] = []
    private var requestedNanoseconds: [UInt64] = []

    func wait(nanoseconds: UInt64) async {
        started = true
        requestedNanoseconds.append(nanoseconds)
        let startContinuations = self.startContinuations
        self.startContinuations = []
        for continuation in startContinuations { continuation.resume() }
        guard !released else { return }
        await withCheckedContinuation { continuations.append($0) }
    }

    func waitUntilStarted() async {
        guard !started else { return }
        await withCheckedContinuation { startContinuations.append($0) }
    }

    func release() {
        released = true
        let continuations = self.continuations
        self.continuations = []
        for continuation in continuations { continuation.resume() }
    }

    func requestedDurations() -> [UInt64] { requestedNanoseconds }
}

@MainActor
final class RealtimeTextSessionModelTests: XCTestCase {
    private var clock: TimeInterval = 100
    private var connection = TextStubConnection()

    /// `verify` defaults to TRUE, unlike the product, because most cases below
    /// exercise the blocking gate and a helper that quietly took the ungated
    /// path would leave it untested. Default-OFF has its own section.
    private func makeModel(
        verify: Bool = true,
        idleSeconds: TimeInterval = 600,
        idleSleep: @escaping @Sendable (UInt64) async -> Void = { nanoseconds in
            try? await Task.sleep(nanoseconds: nanoseconds)
        },
        pairClient: TextStubPair = TextStubPair(),
        iceClient: ICEConfigClient = TextStubICE()
    ) -> RealtimeTextSessionModel {
        clock = 100
        connection = TextStubConnection()
        let peer = connection
        return RealtimeTextSessionModel(
            pairClient: pairClient,
            iceClient: iceClient,
            requiresVerification: { verify },
            now: { [weak self] in self?.clock ?? 0 },
            idleSeconds: idleSeconds,
            idleSleep: idleSleep,
            makeConnection: { _, _, _ in peer }
        )
    }

    private func settle() async {
        await Task.yield()
        await Task.yield()
    }

    private func waitUntilEnded(_ model: RealtimeTextSessionModel) async {
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            if case .ended = model.state { return }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTFail("idle did not end: \(model.state)")
    }

    private func openInitiator(_ model: RealtimeTextSessionModel) async {
        await model.join(code: "483920", role: .initiator)
        connection.onSAS?("brave-otter-lamp")
        connection.onOpen?()
        await settle()
        model.confirmSAS()
        connection.onControl?(.accept)
        await settle()
    }

    private func openResponder(_ model: RealtimeTextSessionModel) async {
        await model.join(code: "483920")
        connection.onSAS?("brave-otter-lamp")
        connection.onOpen?()
        await settle()
        model.confirmSAS()
        model.accept()
    }

    func testMintKeepsCodeVisibleWhileInitiatorWaitsForPeer() async {
        let model = makeModel()
        await model.mintCode(token: "token")
        guard case let .showingCode(code, _) = model.state else {
            return XCTFail("got \(model.state)")
        }
        XCTAssertEqual(code, "483920")

        await model.join(code: code, role: .initiator)
        XCTAssertTrue(connection.started)
        guard case .connecting = model.state else { return XCTFail("got \(model.state)") }
    }

    func testResetWhileMintingIgnoresALateCode() async {
        let pair = TextStubPair()
        let gate = TextMintGate()
        pair.gate = gate
        let model = makeModel(pairClient: pair)
        let mint = Task { await model.mintCode(token: "token") }
        await gate.waitUntilStarted()
        XCTAssertEqual(model.state, .minting)

        model.reset()
        XCTAssertEqual(model.state, .idle)
        await gate.release(MintedCode(code: "999999", expiresAt: 1_900_000_000))
        await mint.value
        XCTAssertEqual(model.state, .idle, "a late mint response resurrected the cancelled task")
    }

    func testResetWhileShowingACodeIgnoresTheLateICEConfiguration() async {
        let ice = GatedTextICE()
        let model = makeModel(iceClient: ice)
        await model.mintCode(token: "token")
        guard case let .showingCode(code, _) = model.state else {
            return XCTFail("got \(model.state)")
        }

        let join = Task { await model.join(code: code, role: .initiator) }
        await ice.gate.waitUntilStarted()
        guard case .showingCode = model.state else { return XCTFail("got \(model.state)") }

        model.reset()
        XCTAssertEqual(model.state, .idle)
        await ice.gate.release()
        await join.value
        XCTAssertEqual(model.state, .idle, "late ICE resurrected a cancelled code")
        XCTAssertFalse(connection.started)
    }

    // MARK: - advanced verification OFF (the product default)

    /// Constructed WITHOUT the parameter, so this fails if the shipped default
    /// is ever flipped by an edit elsewhere.
    func testVerificationIsOffByDefault() async {
        clock = 100
        connection = TextStubConnection()
        let peer = connection
        let model = RealtimeTextSessionModel(
            pairClient: TextStubPair(),
            iceClient: TextStubICE(),
            now: { [weak self] in self?.clock ?? 0 },
            makeConnection: { _, _, _ in peer })
        await model.join(code: "483920", role: .initiator)
        connection.onSAS?("six-words")
        connection.onOpen?()
        await settle()
        if case .verifying = model.state { XCTFail("blocked on the SAS with verification off") }
    }

    /// The initiator still confirms on the TRANSPORT — that call is what enables
    /// decryption, and it is not a display concern — it simply does not wait for
    /// a human to look at a code first.
    func testUnverifiedInitiatorConfirmsTheTransportWithoutAskingTheUser() async {
        let model = makeModel(verify: false)
        await model.join(code: "483920", role: .initiator)
        connection.onSAS?("six-words")
        connection.onOpen?()
        await settle()
        guard case .waitingAccept = model.state else { return XCTFail("got \(model.state)") }
        XCTAssertEqual(connection.confirmTextSASCount, 1)

        connection.onControl?(.accept)
        await settle()
        guard case .open = model.state else { return XCTFail("got \(model.state)") }
    }

    /// An incoming text request opens straight into the composer. `acceptText`
    /// is exactly the step the ON path performs on a tap, so nothing is
    /// decrypted any earlier than the session already allowed.
    func testUnverifiedResponderAutoAcceptsIntoTheComposer() async {
        let model = makeModel(verify: false)
        await model.join(code: "483920", role: .responder)
        connection.onSAS?("six-words")
        connection.onOpen?()
        await settle()
        guard case .open = model.state else { return XCTFail("got \(model.state)") }
        XCTAssertEqual(connection.acceptTextCount, 1)
    }

    /// Opting in restores the explicit accept/reject pair in full.
    func testOptingInRestoresTheIncomingRequestGate() async {
        let model = makeModel(verify: true)
        await model.join(code: "483920", role: .responder)
        connection.onSAS?("six-words")
        connection.onOpen?()
        await settle()
        guard case .verifying = model.state else { return XCTFail("got \(model.state)") }
        XCTAssertEqual(connection.acceptTextCount, 0)

        model.confirmSAS()
        guard case .incomingRequest = model.state else { return XCTFail("got \(model.state)") }
        XCTAssertEqual(connection.acceptTextCount, 0, "accepted before the user chose")

        model.accept()
        guard case .open = model.state else { return XCTFail("got \(model.state)") }
        XCTAssertEqual(connection.acceptTextCount, 1)
    }

    func testInitiatorCannotOpenUntilSASAndPeerAccept() async {
        let model = makeModel()
        await model.join(code: "483920", role: .initiator)
        connection.onSAS?("six-words")
        await settle()
        guard case .connecting = model.state else {
            return XCTFail("SAS alone bypassed the channel-open gate: \(model.state)")
        }
        connection.onOpen?()
        await settle()
        guard case .verifying = model.state else { return XCTFail("got \(model.state)") }

        model.confirmSAS()
        guard case .waitingAccept = model.state else { return XCTFail("got \(model.state)") }

        connection.onControl?(.accept)
        await settle()
        guard case .open = model.state else { return XCTFail("got \(model.state)") }
    }

    func testResetWhileConnectingReturnsToIdleAndRejectsPeerCallbacks() async {
        let model = makeModel()
        await model.join(code: "483920", role: .initiator)
        guard case .connecting = model.state else { return XCTFail("got \(model.state)") }

        model.reset()
        XCTAssertEqual(model.state, .idle)
        XCTAssertEqual(connection.closeCount, 1)
        XCTAssertTrue(model.history.isEmpty)

        connection.onSAS?("late-phrase")
        connection.onOpen?()
        connection.onText?("late message", 32)
        await settle()
        XCTAssertEqual(model.state, .idle, "callbacks reopened the cancelled connection")
        XCTAssertTrue(model.history.isEmpty)
    }

    func testAcceptArrivingBeforeSASConfirmationStillOpensSession() async {
        let model = makeModel()
        await model.join(code: "483920", role: .initiator)
        connection.onSAS?("six-words")
        connection.onOpen?()
        await settle()
        guard case .verifying = model.state else { return XCTFail("got \(model.state)") }

        connection.onControl?(.accept)
        await settle()
        XCTAssertEqual(connection.confirmTextSASCount, 0)
        connection.holdInboundUntilSASConfirmation = true
        connection.receiveText("early", framedBytes: 26)
        await settle()
        XCTAssertTrue(model.history.isEmpty)

        model.confirmSAS()
        guard case .open = model.state else { return XCTFail("got \(model.state)") }
        await settle()
        XCTAssertEqual(connection.confirmTextSASCount, 1)
        XCTAssertEqual(model.history.map(\.body), ["early"])
    }

    func testAcceptedTextCallbackCanPromoteWaitingStateWithoutTaskOrdering() async {
        let model = makeModel()
        await model.join(code: "483920", role: .initiator)
        connection.onSAS?("six-words")
        connection.onOpen?()
        await settle()
        model.confirmSAS()
        guard case .waitingAccept = model.state else { return XCTFail("got \(model.state)") }

        // The transport only emits this callback after authenticated ACCEPT
        // and local SAS confirmation. Deliver it before the model's separate
        // ACCEPT task to model an executor reordering between adjacent events.
        connection.onText?("arrived-after-accept", 42)
        await settle()

        guard case .open = model.state else { return XCTFail("got \(model.state)") }
        XCTAssertEqual(model.history.map(\.body), ["arrived-after-accept"])
    }

    func testRejectArrivingBeforeSASConfirmationRefusesSession() async {
        let model = makeModel()
        await model.join(code: "483920", role: .initiator)
        connection.onSAS?("six-words")
        connection.onOpen?()
        await settle()
        guard case .verifying = model.state else { return XCTFail("got \(model.state)") }

        connection.onControl?(.reject)
        connection.onClose?()
        await settle()
        guard case .refused = model.state else { return XCTFail("got \(model.state)") }
        XCTAssertGreaterThan(connection.closeCount, 0)
    }

    func testInitiatorSASRejectionNotifiesPeer() async {
        let model = makeModel()
        await model.join(code: "483920", role: .initiator)
        connection.onSAS?("six-words")
        connection.onOpen?()
        await settle()

        model.rejectSAS()
        XCTAssertEqual(connection.rejectTextCount, 1)
        guard case .ended = model.state else { return XCTFail("got \(model.state)") }
    }

    func testVerificationScreenEndsAfterIdleLimit() async {
        let idleGate = TextIdleGate()
        let model = makeModel(
            idleSeconds: 42,
            idleSleep: { nanoseconds in await idleGate.wait(nanoseconds: nanoseconds) }
        )
        await model.join(code: "483920", role: .initiator)
        connection.onSAS?("six-words")
        connection.onOpen?()
        await settle()
        guard case .verifying = model.state else { return XCTFail("got \(model.state)") }

        await idleGate.waitUntilStarted()
        let requestedDurations = await idleGate.requestedDurations()
        XCTAssertEqual(requestedDurations, [42_000_000_000])
        await idleGate.release()
        await waitUntilEnded(model)
    }

    func testChannelOpeningBeforeSASStillWaitsForVerificationPhrase() async {
        let model = makeModel()
        await model.join(code: "483920", role: .initiator)
        connection.onOpen?()
        await settle()
        guard case .connecting = model.state else {
            return XCTFail("open alone bypassed the SAS gate: \(model.state)")
        }

        connection.onSAS?("six-words")
        await settle()
        guard case let .verifying(sas) = model.state else {
            return XCTFail("got \(model.state)")
        }
        XCTAssertEqual(sas, "six-words")
    }

    func testResponderAcceptsOnlyAfterSASConfirmationAndExplicitConsent() async {
        let model = makeModel()
        await model.join(code: "483920")
        connection.onSAS?("six-words")
        connection.onOpen?()
        await settle()
        XCTAssertEqual(connection.acceptTextCount, 0)

        model.confirmSAS()
        guard case .incomingRequest = model.state else { return XCTFail("got \(model.state)") }
        XCTAssertEqual(connection.acceptTextCount, 0)

        model.accept()
        XCTAssertEqual(connection.acceptTextCount, 1)
        guard case .open = model.state else { return XCTFail("got \(model.state)") }
    }

    func testInboundBeforeConsentFailsClosedAndNeverRendersBody() async {
        let model = makeModel()
        await model.join(code: "483920")
        connection.onSAS?("six-words")
        connection.onOpen?()
        await settle()
        connection.onText?("must-not-render", 36)
        await settle()
        XCTAssertTrue(model.history.isEmpty)
        guard case .failed = model.state else { return XCTFail("got \(model.state)") }
    }

    func testExactOutboundAndInboundBodiesStayInMemoryHistory() async {
        let model = makeModel()
        await openInitiator(model)
        let outbound = " \tfirst\n\nsecond\u{0} "
        model.draft = outbound
        model.sendDraft()
        await settle()
        XCTAssertEqual(connection.sentBodies, [outbound])
        XCTAssertEqual(model.history.map(\.body), [outbound])
        XCTAssertEqual(model.history.first?.direction, .outgoing)

        let inbound = "你好 e\u{301}\n"
        connection.onText?(inbound, inbound.utf8.count + 21)
        await settle()
        XCTAssertEqual(model.history.map(\.body), [outbound, inbound])
        XCTAssertEqual(model.history.last?.direction, .incoming)
    }

    func testOversizeDraftIsRefusedWithoutClearingOrSending() async {
        let model = makeModel()
        await openInitiator(model)
        model.draft = String(repeating: "你", count: TEXT_MAX_BYTES / 3 + 1)
        model.sendDraft()
        XCTAssertTrue(connection.sentBodies.isEmpty)
        XCTAssertFalse(model.draft.isEmpty)
        XCTAssertNotNil(model.errorMessage)
    }

    func testEmptyDraftCannotBeSentButWhitespaceCan() async {
        let model = makeModel()
        await openInitiator(model)
        XCTAssertFalse(model.canSend)

        model.draft = " \n"
        XCTAssertTrue(model.canSend, "exact whitespace is valid message content")
        model.sendDraft()
        await settle()
        XCTAssertEqual(connection.sentBodies, [" \n"])
    }

    func testBufferedOrFailedSendIsVisibleAsFailedHistory() async {
        let model = makeModel()
        await openInitiator(model)
        connection.textBufferedAmount = RealtimeConnection.textSendBufferMaximum + 1
        model.draft = "buffered"
        model.sendDraft()
        XCTAssertEqual(model.history.last?.failed, true)

        connection.textBufferedAmount = 0
        connection.nextSendError = RealtimeConnection.ConnectionError.textSendFailed
        model.draft = "not sent"
        model.sendDraft()
        await settle()
        XCTAssertEqual(model.history.last?.body, "not sent")
        XCTAssertEqual(model.history.last?.failed, true)
    }

    func testInboundRateGuardClosesOnTwentyFirstBurstMessage() async {
        let model = makeModel()
        await openResponder(model)
        for index in 0...20 {
            connection.onText?("m\(index)", 23)
            await settle()
        }
        XCTAssertEqual(model.history.count, TEXT_BURST)
        guard case .failed = model.state else { return XCTFail("got \(model.state)") }
        XCTAssertGreaterThan(connection.closeCount, 0)
    }

    func testInboundByteBudgetAndHistoryCap() async {
        let model = makeModel()
        await openResponder(model)
        for index in 0..<TEXT_HISTORY_MAX + 1 {
            clock += 1
            connection.onText?("m\(index)", 100)
            await settle()
        }
        XCTAssertEqual(model.history.count, TEXT_HISTORY_MAX)
        XCTAssertEqual(model.history.first?.body, "m1")

        for index in 0..<70 {
            clock += 1
            connection.onText?("extra\(index)", 65_557)
            await settle()
            if case .failed = model.state { break }
        }
        guard case .failed = model.state else { return XCTFail("byte budget did not close") }
    }

    func testIdleEndsOpenSessionAndClearHistoryDoesNotTouchConnection() async {
        let idleGate = TextIdleGate()
        let model = makeModel(
            idleSleep: { nanoseconds in await idleGate.wait(nanoseconds: nanoseconds) }
        )
        await openInitiator(model)
        connection.onText?("temporary", 30)
        await settle()
        XCTAssertEqual(model.history.count, 1)
        model.clearHistory()
        XCTAssertTrue(model.history.isEmpty)
        guard case .open = model.state else { return XCTFail("clear ended session") }

        await idleGate.waitUntilStarted()
        await idleGate.release()
        await waitUntilEnded(model)
    }

    func testEndingKeepsHistoryVisibleUntilClearOrNewSession() async {
        let model = makeModel()
        await openResponder(model)
        connection.onText?("keep locally", 33)
        await settle()

        model.end()
        XCTAssertEqual(model.history.map(\.body), ["keep locally"])
        guard case .ended = model.state else { return XCTFail("got \(model.state)") }

        model.clearHistory()
        XCTAssertTrue(model.history.isEmpty)
    }

    func testRejectedAndStaleCallbacksCannotReopenOrAppend() async {
        let model = makeModel()
        model.updateJoinCode("483920")
        await model.join(code: model.joinCode)
        connection.onSAS?("six-words")
        connection.onOpen?()
        await settle()
        model.confirmSAS()
        model.reject()
        XCTAssertEqual(connection.rejectTextCount, 1)
        XCTAssertFalse(model.canJoin, "a rejected code must not immediately prompt again")
        guard case .refused = model.state else { return XCTFail("got \(model.state)") }

        connection.onText?("late", 25)
        connection.onControl?(.accept)
        await settle()
        XCTAssertTrue(model.history.isEmpty)
        guard case .refused = model.state else { return XCTFail("stale callback landed") }
    }

    /// The other half of the decision above. Keeping the transcript on screen
    /// means the session sits in a terminal state rather than returning to
    /// `.idle`, and the macOS destinations read "not `.idle`" as "somebody is
    /// presenting a session" — which keeps the other destination on its "shown
    /// elsewhere" card. So the pane's **Done** has to reach `.idle`, and it is
    /// also the only thing that discards the retained history.
    ///
    /// `.ended` and `.refused` are the two terminal states a test can reach
    /// without a factory failure; `reset` does not branch on which one it is
    /// leaving, so `.failed` and `.unsupported` take the same path.
    func testResetClearsATerminalSessionBackToIdle() async {
        let ended = makeModel()
        await openResponder(ended)
        connection.onText?("keep locally", 33)
        await settle()
        ended.end()
        guard case .ended = ended.state else { return XCTFail("got \(ended.state)") }
        XCTAssertEqual(ended.history.map(\.body), ["keep locally"],
                       "the transcript must outlive the session that produced it")
        ended.reset()
        guard case .idle = ended.state else {
            return XCTFail("Done left the session owned: \(ended.state)")
        }
        XCTAssertTrue(ended.history.isEmpty, "Done is the deliberate discard")

        let refused = makeModel()
        await refused.join(code: "483920", role: .initiator)
        connection.onSAS?("six-words")
        connection.onOpen?()
        await settle()
        connection.onControl?(.reject)
        connection.onClose?()
        await settle()
        guard case .refused = refused.state else { return XCTFail("got \(refused.state)") }
        refused.reset()
        guard case .idle = refused.state else {
            return XCTFail("Done left the session owned: \(refused.state)")
        }
    }

    func testDelayedSendCompletionAfterEndIsIgnored() async {
        let model = makeModel()
        await openInitiator(model)
        connection.holdSend = true
        model.draft = "late"
        model.sendDraft()
        model.end()
        connection.pendingSend?(nil)
        await settle()
        XCTAssertTrue(model.history.isEmpty)
        guard case .ended = model.state else { return XCTFail("got \(model.state)") }
    }

    func testConfirmedDraftDiscardClearsBeforeEnding() async {
        let model = makeModel()
        await openInitiator(model)
        model.draft = "work the user agreed to discard"

        model.discardDraftAndEnd()

        XCTAssertTrue(model.draft.isEmpty)
        guard case .ended = model.state else { return XCTFail("got \(model.state)") }
    }

    func testLocalContentIncludesEitherHistoryOrDraft() async {
        let model = makeModel()
        XCTAssertFalse(model.hasLocalContent)

        model.draft = "unsent"
        XCTAssertTrue(model.hasLocalContent)
        model.draft = ""

        await openInitiator(model)
        connection.onText?("received", 29)
        await settle()
        XCTAssertTrue(model.hasLocalContent)
    }
}
