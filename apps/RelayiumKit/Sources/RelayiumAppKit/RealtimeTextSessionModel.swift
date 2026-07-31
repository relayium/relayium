import Foundation
import RelayiumKit

public let TEXT_SESSION_MAX_MESSAGES = 500
public let TEXT_SESSION_MAX_BYTES = 4 << 20
public let TEXT_HISTORY_MAX = 200
public let TEXT_BURST = 20
public let TEXT_PER_SECOND = 5.0
public let TEXT_IDLE_SECONDS: TimeInterval = 600

public struct RealtimeTextMessage: Identifiable, Equatable {
    public enum Direction: Equatable { case outgoing, incoming }

    public let id: Int
    public let direction: Direction
    public let body: String
    public let timestamp: TimeInterval
    public let failed: Bool
}

public enum RealtimeTextState: Equatable {
    case idle
    case minting
    case showingCode(String, expiresAt: Int64)
    case joining(String)
    case connecting
    case verifying(sas: String)
    case waitingAccept(sas: String)
    case incomingRequest(sas: String)
    case open(sas: String)
    case ended
    case refused
    case unsupported
    case failed(String)
}

/// In-memory-only state machine for one ephemeral text session.
@MainActor
public final class RealtimeTextSessionModel: ObservableObject {
    @Published public private(set) var state: RealtimeTextState = .idle
    @Published public private(set) var history: [RealtimeTextMessage] = []
    @Published public var joinCode = ""
    @Published public var draft = ""
    @Published public private(set) var errorMessage: String?

    private let pairClient: PairCodeClient
    private let iceClient: ICEConfigClient
    private let makeConnection: (_ code: String, _ role: Role, _ ice: ICEConfig) async throws -> RealtimePeerConnection
    private let now: () -> TimeInterval
    private let idleSeconds: TimeInterval

    private var connection: RealtimePeerConnection?
    private var role: Role = .responder
    private var sas = ""
    private var connectionOpened = false
    private var generation = 0
    private var idleTask: Task<Void, Never>?
    private var nextMessageID = 1
    private var inboundCount = 0
    private var inboundBytes = 0
    private var rateTokens = Double(TEXT_BURST)
    private var lastRefill: TimeInterval
    private var rejectedCodes: Set<String> = []
    private var activeCode = ""
    private var peerAccepted = false
    private var peerRejected = false

    public init(pairClient: PairCodeClient,
                iceClient: ICEConfigClient,
                now: @escaping () -> TimeInterval = { Date().timeIntervalSince1970 },
                idleSeconds: TimeInterval = TEXT_IDLE_SECONDS,
                makeConnection: @escaping (String, Role, ICEConfig) async throws -> RealtimePeerConnection) {
        self.pairClient = pairClient
        self.iceClient = iceClient
        self.now = now
        self.idleSeconds = idleSeconds
        self.makeConnection = makeConnection
        self.lastRefill = now()
    }

    public var isBusy: Bool {
        switch state {
        case .minting, .showingCode, .joining, .connecting, .verifying,
             .waitingAccept, .incomingRequest, .open:
            return true
        default:
            return false
        }
    }

    public var canJoin: Bool {
        isCompletePairingCode(joinCode) && !rejectedCodes.contains(joinCode)
    }

    public var draftByteCount: Int { draft.utf8.count }
    public var canSend: Bool {
        if case .open = state {
            return !draft.isEmpty && draftByteCount <= TEXT_MAX_BYTES
        }
        return false
    }

    public func updateJoinCode(_ raw: String) {
        joinCode = normalizedPairingCode(raw)
    }

    public func mintCode(token: String) async {
        beginAttempt()
        let g = generation
        state = .minting
        do {
            let minted = try await pairClient.mint(token: token)
            guard g == generation else { return }
            state = .showingCode(minted.code, expiresAt: minted.expiresAt)
        } catch {
            guard g == generation else { return }
            state = .failed(ErrorCopy.message(for: error))
        }
    }

    public func join(code: String, role: Role = .responder) async {
        let normalized = normalizedPairingCode(code)
        guard isCompletePairingCode(normalized),
              !rejectedCodes.contains(normalized) else { return }
        beginAttempt(preservingShownCode: role == .initiator)
        let g = generation
        self.role = role
        activeCode = normalized
        if !isShowing(normalized) { state = .joining(normalized) }
        do {
            let ice = try await iceClient.fetch(code: normalized)
            guard g == generation else { return }
            let peer = try await makeConnection(normalized, role, ice)
            guard g == generation else { peer.close(); return }
            wire(peer, generation: g)
            connection = peer
            state = .connecting
            peer.start()
        } catch {
            guard g == generation else { return }
            if error as? RealtimeConnectionFactory.FactoryError == .unsupportedPeer {
                state = .unsupported
            } else {
                state = .failed(ErrorCopy.message(for: error))
            }
        }
    }

    public func confirmSAS() {
        guard case .verifying = state else { return }
        switch role {
        case .initiator:
            if peerRejected {
                finish(.refused)
            } else {
                state = peerAccepted ? .open(sas: sas) : .waitingAccept(sas: sas)
                connection?.confirmTextSAS()
            }
        case .responder:
            state = .incomingRequest(sas: sas)
        }
        touch()
    }

    public func rejectSAS() {
        connection?.rejectText()
        finish(.ended)
    }

    public func accept() {
        guard case .incomingRequest = state else { return }
        // The model callback was installed in `wire` before this control is
        // sent; the connection also enables decryption before sending ACCEPT.
        state = .open(sas: sas)
        touch()
        connection?.acceptText()
    }

    public func reject() {
        guard case .incomingRequest = state else { return }
        if !activeCode.isEmpty { rejectedCodes.insert(activeCode) }
        connection?.rejectText()
        finish(.refused)
    }

    public func sendDraft() {
        let body = draft
        guard case .open = state, let connection else { return }
        guard body.utf8.count <= TEXT_MAX_BYTES else {
            errorMessage = "That message is too long. Send it as a file instead."
            return
        }
        if connection.textBufferedAmount > RealtimeConnection.textSendBufferMaximum {
            record(direction: .outgoing, body: body, failed: true)
            return
        }
        draft = ""
        let g = generation
        connection.sendText(body) { [weak self] error in
            Task { @MainActor in
                guard let self, g == self.generation else { return }
                self.record(direction: .outgoing, body: body, failed: error != nil)
                if error != nil {
                    self.errorMessage = "The message could not be sent."
                }
            }
        }
    }

    public func clearHistory() {
        history = []
    }

    public func end() {
        finish(.ended)
    }

    public func reset() {
        teardown()
        state = .idle
        history = []
        draft = ""
        errorMessage = nil
    }

    private func isShowing(_ code: String) -> Bool {
        if case let .showingCode(shown, _) = state { return shown == code }
        return false
    }

    private func beginAttempt(preservingShownCode: Bool = false) {
        generation += 1
        idleTask?.cancel()
        connection?.close()
        connection = nil
        history = []
        draft = ""
        errorMessage = nil
        nextMessageID = 1
        inboundCount = 0
        inboundBytes = 0
        rateTokens = Double(TEXT_BURST)
        lastRefill = now()
        sas = ""
        connectionOpened = false
        activeCode = ""
        peerAccepted = false
        peerRejected = false
        if !preservingShownCode { state = .idle }
    }

    private func wire(_ peer: RealtimePeerConnection, generation g: Int) {
        peer.onSAS = { [weak self] value in
            Task { @MainActor in
                self?.apply(g) {
                    $0.sas = value
                    $0.presentVerificationIfReady()
                }
            }
        }
        peer.onOpen = { [weak self] in
            Task { @MainActor in
                self?.apply(g) {
                    $0.connectionOpened = true
                    $0.presentVerificationIfReady()
                }
            }
        }
        peer.onText = { [weak self] body, framedBytes in
            Task { @MainActor in
                self?.apply(g) { $0.receive(body: body, framedBytes: framedBytes) }
            }
        }
        peer.onControl = { [weak self] control in
            Task { @MainActor in
                self?.apply(g) { model in
                    switch control {
                    case .accept:
                        model.peerAccepted = true
                        guard case .waitingAccept = model.state else { return }
                        model.state = .open(sas: model.sas)
                        model.touch()
                    case .reject:
                        model.peerRejected = true
                        guard case .waitingAccept = model.state else { return }
                        model.finish(.refused)
                    case .complete:
                        break
                    }
                }
            }
        }
        peer.onError = { [weak self] error in
            Task { @MainActor in
                self?.apply(g) { model in
                    if error as? RealtimeConnection.ConnectionError == .unsupportedPeer {
                        model.finish(.unsupported)
                    } else {
                        model.finish(.failed(ErrorCopy.message(for: error)))
                    }
                }
            }
        }
        peer.onClose = { [weak self] in
            Task { @MainActor in
                self?.apply(g) { model in
                    if model.peerRejected {
                        model.finish(.refused)
                    } else if model.isBusy {
                        model.finish(.ended)
                    }
                }
            }
        }
    }

    private func receive(body: String, framedBytes: Int) {
        // The concrete transport emits text only after peer ACCEPT and local
        // SAS confirmation. Promote this narrow state defensively so delivery
        // does not depend on FIFO scheduling between two unstructured
        // MainActor tasks created by adjacent DataChannel callbacks.
        if case .waitingAccept = state {
            peerAccepted = true
            state = .open(sas: sas)
        }
        guard case .open = state else {
            finish(.failed("The message session failed."))
            return
        }
        guard takeRateToken() else {
            finish(.failed("The other device sent too many messages."))
            return
        }
        guard inboundCount + 1 <= TEXT_SESSION_MAX_MESSAGES,
              inboundBytes + framedBytes <= TEXT_SESSION_MAX_BYTES else {
            finish(.failed("The message session exceeded its safety limits."))
            return
        }
        inboundCount += 1
        inboundBytes += framedBytes
        record(direction: .incoming, body: body, failed: false)
    }

    private func presentVerificationIfReady() {
        guard connectionOpened, !sas.isEmpty else { return }
        guard case .connecting = state else { return }
        state = .verifying(sas: sas)
        touch()
    }

    private func takeRateToken() -> Bool {
        let current = now()
        let elapsed = max(0, current - lastRefill)
        rateTokens = min(Double(TEXT_BURST), rateTokens + elapsed * TEXT_PER_SECOND)
        lastRefill = current
        guard rateTokens >= 1 else { return false }
        rateTokens -= 1
        return true
    }

    private func record(direction: RealtimeTextMessage.Direction,
                        body: String,
                        failed: Bool) {
        let message = RealtimeTextMessage(
            id: nextMessageID,
            direction: direction,
            body: body,
            timestamp: now(),
            failed: failed
        )
        nextMessageID += 1
        history.append(message)
        if history.count > TEXT_HISTORY_MAX {
            history.removeFirst(history.count - TEXT_HISTORY_MAX)
        }
        touch()
    }

    private func touch() {
        idleTask?.cancel()
        let g = generation
        let nanoseconds = UInt64(max(0, idleSeconds) * 1_000_000_000)
        idleTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: nanoseconds)
            guard !Task.isCancelled else { return }
            await MainActor.run {
                self?.apply(g) { model in
                    switch model.state {
                    case .verifying, .waitingAccept, .incomingRequest, .open:
                        break
                    default:
                        return
                    }
                    model.finish(.ended)
                }
            }
        }
    }

    private func finish(_ terminal: RealtimeTextState) {
        generation += 1
        idleTask?.cancel()
        idleTask = nil
        connection?.close()
        connection = nil
        state = terminal
    }

    private func teardown() {
        generation += 1
        idleTask?.cancel()
        idleTask = nil
        connection?.close()
        connection = nil
    }

    private func apply(_ expected: Int, _ body: (RealtimeTextSessionModel) -> Void) {
        guard expected == generation else { return }
        body(self)
    }
}
