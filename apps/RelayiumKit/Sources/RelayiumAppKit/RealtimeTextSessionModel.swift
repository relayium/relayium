import Combine
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
    /// The same-network variant: an id the user picked off a roster instead of
    /// a code. `@MainActor` because the socket it reaches for lives on
    /// `LanDiscoveryModel`.
    private let makeNearbyConnection: @MainActor (_ peerId: String, _ role: Role, _ ice: ICEConfig) async throws -> RealtimePeerConnection
    /// The inbound half: a responder for a text offer that arrived on its own.
    private let makeInboundConnection: @MainActor (_ peerId: String, _ ice: ICEConfig) async throws -> RealtimePeerConnection
    /// How long a nearby connect waits for the chosen device to answer.
    private let nearbyAnswerTimeout: TimeInterval
    /// Read when the SAS lands, not captured at init: the user may flip the
    /// preference between sessions. Default OFF — see `VerificationPreference`.
    private let requiresVerification: () -> Bool
    private let now: () -> TimeInterval
    private let idleSeconds: TimeInterval
    private let idleSleep: @Sendable (_ nanoseconds: UInt64) async -> Void

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
                requiresVerification: @escaping () -> Bool = { false },
                now: @escaping () -> TimeInterval = { Date().timeIntervalSince1970 },
                idleSeconds: TimeInterval = TEXT_IDLE_SECONDS,
                // Optional rather than a defaulted closure literal — see
                // `realSleep`. `nil` means the real timer.
                idleSleep: (@Sendable (UInt64) async -> Void)? = nil,
                nearbyAnswerTimeout: TimeInterval = 30,
                makeNearbyConnection: @escaping @MainActor (String, Role, ICEConfig) async throws -> RealtimePeerConnection = { _, _, _ in
                    throw NearbyError.notScanning
                },
                makeInboundConnection: @escaping @MainActor (String, ICEConfig) async throws -> RealtimePeerConnection = { _, _ in
                    throw NearbyError.notScanning
                },
                makeConnection: @escaping (String, Role, ICEConfig) async throws -> RealtimePeerConnection) {
        self.pairClient = pairClient
        self.iceClient = iceClient
        self.requiresVerification = requiresVerification
        self.now = now
        self.idleSeconds = idleSeconds
        self.idleSleep = idleSleep ?? realSleep
        self.nearbyAnswerTimeout = nearbyAnswerTimeout
        self.makeNearbyConnection = makeNearbyConnection
        self.makeInboundConnection = makeInboundConnection
        self.makeConnection = makeConnection
        self.lastRefill = now()
    }

    public var isBusy: Bool { Self.isBusy(state) }

    /// The same answer as a function of the state alone, for a subscriber to
    /// `$state` — which publishes in `willSet`, while the model still reads its
    /// old value. One definition, delegated to, so the two cannot drift.
    nonisolated static func isBusy(_ state: RealtimeTextState) -> Bool {
        switch state {
        case .minting, .showingCode, .joining, .connecting, .verifying,
             .waitingAccept, .incomingRequest, .open:
            return true
        default:
            return false
        }
    }

    /// `isBusy`, published only when the answer CHANGES.
    ///
    /// An open session publishes on every message sent or received and on every
    /// keystroke in the draft — none of which is a state change at all — and
    /// walks `.minting`/`.joining`/`.connecting`/`.verifying`/`.open` without
    /// ceasing to be busy. Mapping `$state` drops the first kind outright and
    /// `removeDuplicates` collapses the second, which `objectWillChange` cannot
    /// do either of.
    ///
    /// Emits the current value on subscribe, like every `@Published`.
    ///
    /// Internal: `AppDeepLinkCoordinator` is the only subscriber and lives in
    /// this package. The app targets ask `isBusy` directly.
    var busyChanges: AnyPublisher<Bool, Never> {
        $state.map(Self.isBusy).removeDuplicates().eraseToAnyPublisher()
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

    /// Same-network message session with a device the user picked off the
    /// roster. No code is minted, none is joined, and no bearer token is
    /// involved — see `RealtimeSessionModel.connectNearby` for why `code: ""`
    /// is the whole mechanism rather than a placeholder.
    public func connectNearby(peerId: String, role: Role = .initiator) async {
        beginAttempt()
        let g = generation
        self.role = role
        // Deliberately left empty: `rejectedCodes` keys off the code a session
        // was started from, and a nearby session has none. `reject()` already
        // guards on that.
        activeCode = ""
        state = .connecting
        do {
            let ice = try await iceClient.fetch(code: "")
            guard g == generation else { return }
            let peer = try await makeNearbyConnection(peerId, role, ice)
            guard g == generation else { peer.close(); return }
            wire(peer, generation: g)
            connection = peer
            peer.start()
            armAnswerTimeout()
        } catch {
            guard g == generation else { return }
            if error as? RealtimeConnectionFactory.FactoryError == .unsupportedPeer {
                state = .unsupported
            } else {
                state = .failed(ErrorCopy.message(for: error))
            }
        }
    }

    /// Same-network receive: a device on this public address offered a text
    /// session and this Mac is answering it.
    ///
    /// The responder path is the existing one, unchanged: `onSAS` + `onOpen`
    /// reach `proceedAfterVerification`, which presents `incomingRequest` and —
    /// with advanced verification off, the default — accepts it immediately.
    /// Nothing is decrypted before that `accept()`, and nothing about this entry
    /// point changes when the preference is on.
    ///
    /// `handoff` replays the buffered offer (and whatever followed it) into the
    /// connection; see `RealtimeSessionModel.acceptNearby` for why it is called
    /// exactly here.
    @discardableResult
    public func acceptNearby(peerId: String,
                             handoff: @MainActor () -> Void = {}) async -> Bool {
        beginAttempt()
        let g = generation
        self.role = .responder
        // No code was involved, so none may be blacklisted by a later reject.
        activeCode = ""
        state = .connecting
        do {
            let ice = try await iceClient.fetch(code: "")
            guard g == generation else { return false }
            let peer = try await makeInboundConnection(peerId, ice)
            guard g == generation else { peer.close(); return false }
            wire(peer, generation: g)
            connection = peer
            peer.start()
            handoff()
            armAnswerTimeout()
            return true
        } catch {
            guard g == generation else { return false }
            state = .failed(ErrorCopy.message(for: error))
            return false
        }
    }

    /// Bounds a nearby connect the way `firstPeer`'s timeout bounds a code
    /// join: the peer is already known, so nothing else ever gives up on a
    /// device that is simply not listening.
    ///
    /// Reuses the idle-timer slot on purpose — `touch()` replaces it the moment
    /// the session becomes interactive, so the two can never both be live.
    private func armAnswerTimeout() {
        idleTask?.cancel()
        let g = generation
        let nanoseconds = UInt64(max(0, nearbyAnswerTimeout) * 1_000_000_000)
        let idleSleep = self.idleSleep
        idleTask = Task { [weak self] in
            await idleSleep(nanoseconds)
            guard !Task.isCancelled else { return }
            await MainActor.run {
                self?.apply(g) { model in
                    guard case .connecting = model.state else { return }
                    model.finish(.failed(ErrorCopy.message(for: NearbyError.noAnswer)))
                }
            }
        }
    }

    public func confirmSAS() {
        guard case .verifying = state else { return }
        proceedAfterVerification()
    }

    /// The one "this connection is cleared" transition, shared by the ON path
    /// (the user pressed "They match") and the OFF path (the
    /// commit-reveal-complete encrypted connection is open and there is nobody
    /// being asked — nothing has established WHO the peer is).
    ///
    /// `confirmTextSAS()` is called on the initiator in BOTH paths: it is what
    /// enables decryption on the transport, and it is not a display concern.
    private func proceedAfterVerification() {
        switch role {
        case .initiator:
            if peerRejected {
                finish(.refused)
            } else {
                state = peerAccepted ? .open(sas: sas) : .waitingAccept(sas: sas)
                connection?.confirmTextSAS()
            }
            touch()
        case .responder:
            state = .incomingRequest(sas: sas)
            touch()
            // With verification off, an incoming text request opens straight
            // into the composer. `accept()` is exactly the step the ON path
            // performs on a tap — nothing is decrypted any earlier, it simply
            // is not waiting on a decision that no displayed code informs.
            //
            // Deliberately narrow: this is a message session, whose whole
            // content is what the composer is about to show. It says nothing
            // about the FILE path, which is a separate decision per platform —
            // the browser keeps a per-batch Accept gesture, while this app
            // accepts an incoming manifest itself and writes into the
            // configured destination (Downloads by default; see
            // RealtimeSessionModel.startPendingReceive). Note that neither is a
            // confidentiality control: an unintended peer that wants the files
            // just accepts them.
            if !requiresVerification() { accept() }
        }
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
            errorMessage = L10n.t(.textMessageTooLong)
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
                    self.errorMessage = L10n.t(.textSendFailed)
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
            finish(.failed(L10n.t(.textSessionFailed)))
            return
        }
        guard takeRateToken() else {
            finish(.failed(L10n.t(.textTooManyMessages)))
            return
        }
        guard inboundCount + 1 <= TEXT_SESSION_MAX_MESSAGES,
              inboundBytes + framedBytes <= TEXT_SESSION_MAX_BYTES else {
            finish(.failed(L10n.t(.textSafetyLimits)))
            return
        }
        inboundCount += 1
        inboundBytes += framedBytes
        record(direction: .incoming, body: body, failed: false)
    }

    private func presentVerificationIfReady() {
        guard connectionOpened, !sas.isEmpty else { return }
        guard case .connecting = state else { return }
        guard requiresVerification() else {
            proceedAfterVerification()
            return
        }
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
        let idleSleep = self.idleSleep
        idleTask = Task { [weak self] in
            await idleSleep(nanoseconds)
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
