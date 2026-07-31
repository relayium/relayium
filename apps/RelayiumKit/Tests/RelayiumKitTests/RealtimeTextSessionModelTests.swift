import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

private final class TextStubPair: PairCodeClient, @unchecked Sendable {
    var result = MintedCode(code: "K7M3X9", expiresAt: 1_800_000_000)
    func mint(token: String) async throws -> MintedCode { result }
}

private final class TextStubICE: ICEConfigClient, @unchecked Sendable {
    func fetch(code: String) async throws -> ICEConfig {
        ICEConfig(iceServers: [ICEServerConfig(urls: ["stun:test"])])
    }
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

@MainActor
final class RealtimeTextSessionModelTests: XCTestCase {
    private var clock: TimeInterval = 100
    private var connection = TextStubConnection()

    private func makeModel(idleSeconds: TimeInterval = 600) -> RealtimeTextSessionModel {
        clock = 100
        connection = TextStubConnection()
        let peer = connection
        return RealtimeTextSessionModel(
            pairClient: TextStubPair(),
            iceClient: TextStubICE(),
            now: { [weak self] in self?.clock ?? 0 },
            idleSeconds: idleSeconds,
            makeConnection: { _, _, _ in peer }
        )
    }

    private func settle() async {
        await Task.yield()
        await Task.yield()
    }

    private func openInitiator(_ model: RealtimeTextSessionModel) async {
        await model.join(code: "K7M3X9", role: .initiator)
        connection.onSAS?("brave-otter-lamp")
        connection.onOpen?()
        await settle()
        model.confirmSAS()
        connection.onControl?(.accept)
        await settle()
    }

    private func openResponder(_ model: RealtimeTextSessionModel) async {
        await model.join(code: "K7M3X9")
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
        XCTAssertEqual(code, "K7M3X9")

        await model.join(code: code, role: .initiator)
        XCTAssertTrue(connection.started)
        guard case .connecting = model.state else { return XCTFail("got \(model.state)") }
    }

    func testInitiatorCannotOpenUntilSASAndPeerAccept() async {
        let model = makeModel()
        await model.join(code: "K7M3X9", role: .initiator)
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

    func testAcceptArrivingBeforeSASConfirmationStillOpensSession() async {
        let model = makeModel()
        await model.join(code: "K7M3X9", role: .initiator)
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
        await model.join(code: "K7M3X9", role: .initiator)
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
        await model.join(code: "K7M3X9", role: .initiator)
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
        await model.join(code: "K7M3X9", role: .initiator)
        connection.onSAS?("six-words")
        connection.onOpen?()
        await settle()

        model.rejectSAS()
        XCTAssertEqual(connection.rejectTextCount, 1)
        guard case .ended = model.state else { return XCTFail("got \(model.state)") }
    }

    func testVerificationScreenEndsAfterIdleLimit() async {
        let model = makeModel(idleSeconds: 0.01)
        await model.join(code: "K7M3X9", role: .initiator)
        connection.onSAS?("six-words")
        connection.onOpen?()
        await settle()
        guard case .verifying = model.state else { return XCTFail("got \(model.state)") }

        try? await Task.sleep(nanoseconds: 30_000_000)
        await settle()
        guard case .ended = model.state else { return XCTFail("idle did not end: \(model.state)") }
    }

    func testChannelOpeningBeforeSASStillWaitsForVerificationPhrase() async {
        let model = makeModel()
        await model.join(code: "K7M3X9", role: .initiator)
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
        await model.join(code: "K7M3X9")
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
        await model.join(code: "K7M3X9")
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
        let model = makeModel(idleSeconds: 0.01)
        await openInitiator(model)
        connection.onText?("temporary", 30)
        await settle()
        XCTAssertEqual(model.history.count, 1)
        model.clearHistory()
        XCTAssertTrue(model.history.isEmpty)
        guard case .open = model.state else { return XCTFail("clear ended session") }

        try? await Task.sleep(nanoseconds: 30_000_000)
        await settle()
        guard case .ended = model.state else { return XCTFail("idle did not end: \(model.state)") }
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
        model.updateJoinCode("K7M3X9")
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
}
