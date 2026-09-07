import Combine
import Foundation
import RelayiumKit
import RelayiumShareKit

/// The subset of `RealtimeConnection` this model drives.
///
/// The concrete type needs WebRTC and a live peer, so nothing above it could be
/// tested without this seam — the same move `ResumableTransport` was for the
/// cloud uploader.
public protocol RealtimePeerConnection: AnyObject {
    var onSAS: ((String) -> Void)? { get set }
    var onOpen: (() -> Void)? { get set }
    var onManifest: (([FileMeta]) -> Void)? { get set }
    var onFileChunk: (([UInt8]) -> Void)? { get set }
    var onProgress: ((Int) -> Void)? { get set }
    var onDone: ((Bool) -> Void)? { get set }
    /// One authenticated kind-9 message and its framed byte count.
    var onText: ((String, Int) -> Void)? { get set }
    /// Accept/reject/complete. `complete` is how a sender — which never
    /// receives a DONE frame of its own — learns the batch landed.
    var onControl: ((RealtimeControl) -> Void)? { get set }
    var onClose: (() -> Void)? { get set }
    var onError: ((Error) -> Void)? { get set }

    func start()
    func send(sources: [PlaintextSource], metas: [FileMeta])
    func accept()
    func reject()
    /// Tell the peer the whole batch arrived and verified (CTRL_COMPLETE).
    func complete()
    /// Latch local SAS confirmation before an initiator may decrypt text.
    func confirmTextSAS()
    func acceptText()
    func rejectText()
    func sendText(_ body: String, completion: @escaping (Error?) -> Void)
    var textBufferedAmount: UInt64 { get }
    func close()
}

public enum RealtimeState: Equatable {
    case idle
    case minting
    case showingCode(String, expiresAt: Int64)
    case joining(String)
    case connecting
    /// Blocking on purpose: nothing is sent and nothing is written until the
    /// local user confirms the phrase matches the other device's.
    ///
    /// Only reached when the advanced-verification preference is ON. With it
    /// off (the default) the session goes straight from `connecting` to
    /// `transferring` — see `VerificationPreference` for why, and for what that
    /// does NOT change.
    case verifying(sas: String)
    case transferring(done: Int, total: Int)
    case completed([URL])
    case failed(String)
}

@MainActor
public final class RealtimeSessionModel: ObservableObject {
    @Published public private(set) var state: RealtimeState = .idle
    /// Files named by the incoming manifest, shown while transferring.
    @Published public private(set) var incoming: [FileMeta] = []
    /// Shared with the view so an OS handoff can prefill the same field without
    /// auto-joining or replacing an active connection.
    @Published public var joinCode: String = ""
    /// The SAS derived for the live connection, kept whether or not it is being
    /// shown. Turning the preference on must not require a renegotiation, and a
    /// UI that wants to display the code outside the blocking gate can read it.
    @Published public private(set) var sasCode: String = ""
    /// The directory this receive created for a folder transfer, if any.
    ///
    /// Kept beside `state` rather than folded into `.completed` so the existing
    /// `case completed([URL])` — and every test that matches on it — keeps
    /// meaning exactly what it did: the files that were written. What this adds
    /// is the ONE item Finder should be handed for a foldered result; see
    /// `receivedPayload`.
    @Published public private(set) var receivedContainer: URL?
    /// Where a received transfer is written. The pane sets it from a save panel.
    public var saveDirectory: URL = FileManager.default
        .urls(for: .downloadsDirectory, in: .userDomainMask).first
        ?? FileManager.default.temporaryDirectory

    private let pairClient: PairCodeClient
    private let iceClient: ICEConfigClient
    /// Async because building a real connection means connecting to signaling
    /// and waiting for the other device to appear on the code — there is no peer
    /// id to construct one with until then.
    private let makeConnection: (_ code: String, _ role: Role, _ iceServers: ICEConfig) async throws -> RealtimePeerConnection
    /// The same-network variant: the peer id is already known (the user picked
    /// it off a roster) and the socket already exists, so this takes an id
    /// rather than a code. `@MainActor` because the socket it reaches for lives
    /// on `LanDiscoveryModel`.
    private let makeNearbyConnection: @MainActor (_ peerId: String, _ role: Role, _ iceServers: ICEConfig) async throws -> RealtimePeerConnection
    /// The inbound half: a responder for an offer that arrived on its own. No
    /// role parameter, because there is only one role an unsolicited offer can
    /// be answered in.
    private let makeInboundConnection: @MainActor (_ peerId: String, _ iceServers: ICEConfig) async throws -> RealtimePeerConnection
    /// The pairing-code variant: a room this process ALREADY holds a socket for,
    /// because `LinkPairingRoom` opened it so a `link/1` could live there. The
    /// peer id and the ICE configuration are the room's, resolved before this is
    /// called, which is why neither is fetched here. See
    /// `RealtimeConnectionFactory.connectInRoom` for why the socket is handed
    /// over rather than reopened.
    private let makeRoomConnection: @MainActor (_ peerId: String, _ role: Role, _ iceServers: ICEConfig) async throws -> RealtimePeerConnection
    /// How long a nearby connect waits for the chosen device to answer.
    private let nearbyAnswerTimeout: TimeInterval
    /// What the answer-timeout says to DO about it, because the two platforms
    /// have two different answers. macOS times out on the hub-backed room,
    /// where a browser on the production host is a listening peer and the
    /// shared sentence is the right instruction; the iOS Local Nearby
    /// composition times out on `_relayium._tcp`, where a browser publishes no
    /// service and that instruction cannot work. Injected for the reason
    /// `LanDiscoveryModel.reconnectingCopy` is: one module, both platforms, and
    /// a `#if os(iOS)` here would change what a Mac-hosted test exercises.
    ///
    /// Internal rather than private so a guard test can read which sentence a
    /// COMPOSITION chose without opening a socket or waiting out a timer. What
    /// the factories pass is the half a driven timeout cannot show.
    let nearbyNoAnswerCopy: L10nKey
    private let sleep: @Sendable (UInt64) async -> Void
    /// Read at the moment the SAS arrives, not captured at init: the user may
    /// flip the preference between sessions without restarting the app.
    private let requiresVerification: () -> Bool

    private var connection: RealtimePeerConnection?
    private var writer: ManifestWriter?
    /// Carries its own total so a retry can restore `totalBytes` — which is
    /// shared with the inbound direction — without recomputing the manifest.
    private var pendingSend: (sources: [PlaintextSource], metas: [FileMeta], totalBytes: Int)?
    private var pendingReceive = false
    private var sasConfirmed = false
    /// The DataChannel is open. Tracked because `onSAS` fires on the SIGNALLING
    /// channel, as soon as the peer's reveal verifies — which can be before the
    /// DataChannel finishes opening. Nothing may be written until both are true:
    /// `transmit` does not check `readyState`, so a manifest sent early is
    /// dropped by WebRTC and the transfer stalls with no error.
    ///
    /// This used to be masked by the blocking SAS gate — a human takes seconds,
    /// and the channel was always open by the time they clicked. With
    /// verification off there is no such pause, so the ordering has to be
    /// explicit. Mirrors `RealtimeTextSessionModel.connectionOpened`.
    private var connectionOpened = false
    private var totalBytes = 0
    private var completedIncomingFiles = 0
    /// Operation identity: a callback from a session the user has left must not
    /// repaint a screen they have moved past.
    private var generation = 0
    private var answerTimeout: Task<Void, Never>?

    public init(pairClient: PairCodeClient,
                iceClient: ICEConfigClient,
                requiresVerification: @escaping () -> Bool = { false },
                nearbyAnswerTimeout: TimeInterval = 30,
                // Defaults to the shared sentence, so every caller that does
                // not name a transport keeps the wording it had.
                nearbyNoAnswerCopy: L10nKey = .errorNearbyNoAnswer,
                // Optional rather than a defaulted closure literal — see
                // `realSleep`. `nil` means the real timer.
                sleep: (@Sendable (UInt64) async -> Void)? = nil,
                makeNearbyConnection: @escaping @MainActor (String, Role, ICEConfig) async throws -> RealtimePeerConnection = { _, _, _ in
                    throw NearbyError.notScanning
                },
                makeInboundConnection: @escaping @MainActor (String, ICEConfig) async throws -> RealtimePeerConnection = { _, _ in
                    throw NearbyError.notScanning
                },
                makeRoomConnection: @escaping @MainActor (String, Role, ICEConfig) async throws -> RealtimePeerConnection = { _, _, _ in
                    // A client with no pairing room refuses rather than dialling
                    // one it does not have — the same shape, and the same
                    // reason, as the two nearby defaults above.
                    throw NearbyError.notScanning
                },
                makeConnection: @escaping (String, Role, ICEConfig) async throws -> RealtimePeerConnection) {
        self.pairClient = pairClient
        self.iceClient = iceClient
        self.requiresVerification = requiresVerification
        self.nearbyAnswerTimeout = nearbyAnswerTimeout
        self.nearbyNoAnswerCopy = nearbyNoAnswerCopy
        self.sleep = sleep ?? realSleep
        self.makeNearbyConnection = makeNearbyConnection
        self.makeInboundConnection = makeInboundConnection
        self.makeRoomConnection = makeRoomConnection
        self.makeConnection = makeConnection
    }

    /// A live session the quit guard must not let die silently.
    public var isBusy: Bool { Self.isBusy(state) }

    /// The same answer as a function of the state alone, for a subscriber to
    /// `$state` — which publishes in `willSet`, while the model still reads its
    /// old value. One definition, delegated to, so the two cannot drift.
    nonisolated static func isBusy(_ state: RealtimeState) -> Bool {
        switch state {
        case .idle, .failed, .completed: return false
        default: return true
        }
    }

    /// `isBusy`, published only when the answer CHANGES.
    ///
    /// A session walks `.minting` → `.showingCode` → `.joining` →
    /// `.connecting` → `.verifying` → `.transferring`, and republishes
    /// `.transferring(done:total:)` for every chunk it moves, without ever
    /// ceasing to be busy. An observer that only cares whether work is in flight
    /// wants the two boundaries, not that walk and not one wake-up per chunk, so
    /// `$state` is mapped and de-duplicated rather than `objectWillChange` being
    /// watched.
    ///
    /// Emits the current value on subscribe, like every `@Published`.
    ///
    /// Internal: `AppDeepLinkCoordinator` is the only subscriber and lives in
    /// this package. The app targets ask `isBusy` directly.
    var busyChanges: AnyPublisher<Bool, Never> {
        $state.map(Self.isBusy).removeDuplicates().eraseToAnyPublisher()
    }

    public var canJoin: Bool { isCompletePairingCode(joinCode) }

    /// Reveal/drag-out targets for a finished receive, or nil.
    ///
    /// Only ever non-nil in `.completed`, which is reached only after the
    /// writer's `finish()` returned — so nothing here is a promise of a file
    /// that is still being written. A sender's `.completed([])` (it received
    /// nothing) yields nil rather than an empty drag source.
    public var received: ReceivedPayload? {
        guard case let .completed(urls) = state, !urls.isEmpty else { return nil }
        return receivedPayload(files: urls, container: receivedContainer)
    }

    /// The manifest this surface should keep showing for the whole session.
    ///
    /// A sender owns `pendingSend`; a receiver owns `incoming`. Both survive
    /// through `.completed` until Done/Cancel tears the session down, so the UI
    /// never loses the answer to “which files?” when the picker disappears.
    public var sessionFiles: [FileMeta] {
        pendingSend?.metas ?? incoming
    }

    public func updateJoinCode(_ raw: String) {
        joinCode = normalizedPairingCode(raw)
    }

    // MARK: - starting a session

    /// Sender side: mint a code to show. Requires the bearer — the code's owner
    /// pays for traffic relayed through it.
    public func mintCode(token: String) async {
        generation += 1
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

    /// Both sides end up here: the sender once a peer arrives on its code, the
    /// receiver as soon as it has one to join.
    ///
    /// **The role decides how much of the previous attempt survives**, and that
    /// is a rule rather than hygiene.
    ///
    /// `.initiator` is the retry direction: this side minted the code and is
    /// dialling its own peer, so `retirePreviousConnection` deliberately keeps
    /// `pendingSend`. Re-picking the files is not a safety measure and it is the
    /// whole reason a user retries.
    ///
    /// `.responder` is not a retry of anything. It is somebody typing a code
    /// they were given, to RECEIVE — and `proceedAfterVerification` sends
    /// whatever is pending. A user who staged files, created a code, watched it
    /// fail or expire, and then joined the other device's code instead would
    /// otherwise upload that staged selection to the peer whose code they just
    /// typed: a disclosure nobody chose, reached through the action labelled
    /// Receive. So this direction takes the full `teardown`, which is the same
    /// clear `acceptNearby` already performs for the same reason on the
    /// unsolicited-offer path.
    public func join(code: String, role: Role = .responder) async {
        switch role {
        case .initiator: retirePreviousConnection()
        case .responder: teardown()
        }
        let g = generation
        // A sender minted this code and is already displaying it; the other
        // device has to read it off that screen, so replacing it with
        // "Connecting…" removes the one thing the wait depends on — and the
        // wait could then only ever end in the peer timeout.
        //
        // A receiver typed a code instead of minting one and has nothing to
        // display, so it gets progress.
        if !isShowing(code) { state = .joining(code) }
        do {
            // Fetched once per attempt, not per retry: /api/ice is limited to
            // 5/min per IP because guessing a live code steals its TURN
            // credentials.
            let servers = try await iceClient.fetch(code: code)
            guard g == generation else { return }
            let c = try await makeConnection(code, role, servers)
            guard g == generation else { c.close(); return }
            wire(c, generation: g)
            connection = c
            state = .connecting
            c.start()
        } catch {
            guard g == generation else { return }
            // Deliberately before any connection attempt: without ICE servers a
            // connection would fail later and blame the network.
            state = .failed(ErrorCopy.message(for: error))
        }
    }

    /// Same-network send: the peer id came from a roster entry the user picked,
    /// not from a code anybody typed.
    ///
    /// Nothing here mints, and nothing here needs a bearer token: the room is
    /// keyed by the public IP the server observes, and `/api/ice` without a code
    /// answers STUN-only to anyone. That is precisely why this works signed out,
    /// and why `code: ""` below is load-bearing rather than a placeholder.
    public func connectNearby(peerId: String, role: Role = .initiator) async {
        // Same leak as `acceptNearby` guards against, minus the pending-send
        // clear: a staged selection is exactly what this call is about to send,
        // so only the dead connection goes.
        retirePreviousConnection()
        let g = generation
        state = .connecting
        do {
            let servers = try await iceClient.fetch(code: "")
            guard g == generation else { return }
            let c = try await makeNearbyConnection(peerId, role, servers)
            guard g == generation else { c.close(); return }
            wire(c, generation: g)
            connection = c
            c.start()
            armAnswerTimeout(generation: g)
        } catch {
            guard g == generation else { return }
            state = .failed(ErrorCopy.message(for: error))
        }
    }


    /// Take over a pairing-code room whose peer turned out NOT to speak
    /// `link/1`, and run this device's ordinary file session on it.
    ///
    /// The socket is `LinkPairingRoom`'s and stays its: this call builds a
    /// connection on it and nothing here opens, closes or rejoins one. The peer
    /// id came from that room's roster and the role from the verb the user
    /// pressed — creating a code offers, joining one answers — so neither is
    /// re-derived. The ICE configuration is the one the room already fetched for
    /// the code, credentials included, because a pairing code is exactly the
    /// authorisation that pays for relayed bytes.
    ///
    /// Everything after the connection exists is the ordinary session: the same
    /// wiring, the same SAS gate, the same staged batch. A user who reached here
    /// sees the session they asked for; what they do not see is that the room
    /// was watched for a link first.
    public func adoptRoom(peerId: String, role: Role, config: ICEConfig) async {
        // The same retire the outbound nearby path makes, and for the same
        // reason: a staged selection is what this call is about to send, so only
        // a dead connection goes.
        retirePreviousConnection()
        let g = generation
        state = .connecting
        do {
            let c = try await makeRoomConnection(peerId, role, config)
            guard g == generation else { c.close(); return }
            wire(c, generation: g)
            connection = c
            c.start()
        } catch {
            guard g == generation else { return }
            state = .failed(ErrorCopy.message(for: error))
        }
    }

    /// Same-network receive: a device on this public address offered, and this
    /// Mac is answering. Nothing here was chosen by the local user, which is
    /// what every constraint below is about.
    ///
    /// `handoff` is called at the one instant it can be: after the connection
    /// exists and its callbacks are wired, and before this returns. That is when
    /// the router replays the offer it has been holding — plus any ICE that
    /// arrived behind it, which on a LAN is most of it — into the connection.
    /// Calling it earlier delivers frames to a model that cannot react; later
    /// costs the session its first candidates.
    ///
    /// Returns whether a connection was installed, so the caller can release its
    /// inbound reservation on every failure path without inferring it from
    /// state.
    @discardableResult
    public func acceptNearby(peerId: String,
                             handoff: @MainActor () -> Void = {}) async -> Bool {
        // Retire the previous session rather than overwrite it.
        //
        // A terminal file session — `.completed` or `.failed` — leaves its
        // connection retained, because nothing on those paths tears down. The
        // listener is admitted again as soon as the models stop reporting busy,
        // so the very next unsolicited offer used to reassign `connection` and
        // drop the old object on the floor: never closed, still holding its
        // RTCPeerConnection and its claim on the signalling slot, and released
        // by ARC at some arbitrary later moment — whose `deinit` then ran
        // against a socket the new session was using.
        //
        // Clearing `pendingSend` is the part that is a rule rather than
        // hygiene. Files the local user staged for an outbound transfer are
        // still pending after a session ends, and `proceedAfterVerification`
        // sends whatever is pending: without this, answering an offer would
        // upload that staged selection to a peer who dialled *us* and whom
        // nobody chose.
        teardown()
        let g = generation
        state = .connecting
        do {
            // Empty code, exactly as on the outbound nearby path: no code is
            // minted or joined, no bearer token is involved, and the answer is
            // STUN-only.
            let servers = try await iceClient.fetch(code: "")
            guard g == generation else { return false }
            let c = try await makeInboundConnection(peerId, servers)
            // Cancelled, or superseded by a newer session, while this was in
            // flight. The connection nobody is watching has to be closed rather
            // than left holding the socket and the peer.
            guard g == generation else { c.close(); return false }
            wire(c, generation: g)
            connection = c
            // A responder's `start` is a no-op (it has no offer to make); called
            // anyway so both nearby paths have one shape.
            c.start()
            handoff()
            // A peer that offers and then vanishes would otherwise leave this on
            // "Connecting…" for as long as the app is resident — which, for a
            // listener that is always on, is forever.
            armAnswerTimeout(generation: g)
            return true
        } catch {
            guard g == generation else { return false }
            state = .failed(ErrorCopy.message(for: error))
            return false
        }
    }

    /// Nothing else bounds a nearby connect. The code path spends its wait
    /// inside `firstPeer`, which times out; here the peer is already known, so
    /// a device that is not listening for incoming offers — or whose user never
    /// answers — leaves the pane on "Connecting…" for as long as the app runs.
    private func armAnswerTimeout(generation g: Int) {
        cancelAnswerTimeout()
        let sleep = self.sleep
        let nanoseconds = UInt64(max(0, nearbyAnswerTimeout) * 1_000_000_000)
        answerTimeout = Task { [weak self] in
            await sleep(nanoseconds)
            guard !Task.isCancelled else { return }
            await MainActor.run {
                self?.apply(g) { m in
                    // Anything that got as far as a SAS or a manifest has moved
                    // out of `.connecting`; only a silent peer is still here.
                    guard case .connecting = m.state else { return }
                    m.teardown()
                    m.state = .failed(ErrorCopy.nearbyNoAnswer(m.nearbyNoAnswerCopy))
                }
            }
        }
    }

    /// One place, so "the connect is over" and "the timer is gone" cannot drift
    /// apart. Called the moment the state leaves `.connecting`, and again by
    /// `teardown`.
    private func cancelAnswerTimeout() {
        answerTimeout?.cancel()
        answerTimeout = nil
    }

    private func isShowing(_ code: String) -> Bool {
        if case let .showingCode(shown, _) = state { return shown == code }
        return false
    }

    /// Queued until the handshake completes (commit-reveal + AEAD keys); with
    /// verification ON, also until the user confirms the SAS — see `confirmSAS`,
    /// which is the only step that says anything about the peer's identity.
    ///
    /// **This is the PRE-connect half, and the macOS transfer surfaces no longer
    /// reach it.** It stays, unchanged and reachable, because the
    /// inbound-adoption path (`LinkWorkspaceModel.onLegacyFallbackBatch`) still
    /// hands a batch back through it, because iOS still stages before
    /// connecting, and because a future re-enable of pre-staging must not have
    /// to rediscover the queueing rule. What a connect-first surface uses
    /// instead is `sendNow`, below.
    public func stageSend(sources: [PlaintextSource], metas: [FileMeta]) {
        guard sources.count == metas.count, let total = try? validateRealtimeFiles(metas) else {
            pendingSend = nil
            totalBytes = 0
            state = .failed(L10n.t(.sessionInvalidFileList))
            return
        }
        pendingSend = (sources, metas, total)
        totalBytes = total
    }

    /// **Whether a batch chosen right now would actually go anywhere.**
    ///
    /// Two independent properties, and each one is a way the send would
    /// otherwise be swallowed rather than refused:
    ///
    ///  - **The session is cleared and live.** A connection exists, its
    ///    DataChannel is open — `transmit` does not check `readyState`, so a
    ///    manifest written before it is dropped by WebRTC with no error and the
    ///    transfer stalls — the handshake is cleared, which with verification ON
    ///    means the user compared the phrase, and the state says so.
    ///  - **Nothing is already in flight in either direction.** One legacy file
    ///    session carries one manifest per side, and a second `send` would
    ///    interleave frames into a batch the peer is mid-way through
    ///    reassembling. That is why `pendingReceive` is here as well as
    ///    `pendingSend`: this side may be receiving, and a receive is exactly as
    ///    much "in flight" as a send.
    ///
    /// **"Cleared and live" is spelled with three clauses that are mutually
    /// redundant today, and that is measured rather than assumed.** They live in
    /// `sendRefusal` below, which this property is derived from, so the gate and
    /// the reason a caller is given cannot drift apart.
    /// `.transferring` is reachable from `.connecting` only through
    /// `proceedAfterVerification`, which requires `connectionOpened` and sets
    /// `sasConfirmed`; and nothing clears `connectionOpened` without also
    /// nulling `connection` (`releaseConnectionState`). So each of the three
    /// implies the others on every reachable path, and reverse mutations
    /// measured exactly that: deleting `connectionOpened` alone survives,
    /// deleting the `.transferring` requirement alone survives, deleting both
    /// together still survives — `sasConfirmed` alone holds the line — and only
    /// removing all three lets a manifest out before the channel opens, which
    /// `testSendNowIsRefusedUntilTheConnectionIsOpen` then catches.
    ///
    /// That is recorded rather than papered over, and it is the reason all three
    /// stay. They are not one derived answer written three times; they are three
    /// *named* conditions — `connectionOpened` means "the wire will carry a
    /// write", `sasConfirmed` means "a human said this is the right peer",
    /// `.transferring` means "this session is in the phase where bytes move".
    /// Today one implies the next. A transport that opened later than it does
    /// now, or a state added to the cleared set, would break that chain silently,
    /// and the cost of keeping the redundancy is a line — while the cost of
    /// trusting the chain is a manifest dropped by WebRTC with no error.
    public var canSendNow: Bool { sendRefusal == nil }

    /// **The same answer, with the reason kept.** `nil` means a batch handed
    /// over right now goes out; anything else is why it would not.
    ///
    /// The two clauses are the two above, in the same order, and this is the one
    /// place they are written — `canSendNow` is derived from it rather than
    /// stated a second time, because a gate and its explanation that can
    /// disagree is worse than no explanation. The reasons are separated because
    /// the user-visible sentences differ: a session carrying a transfer is a
    /// different thing from a session that is no longer cleared to carry one.
    public var sendRefusal: SendRefusal? {
        guard connection != nil, connectionOpened, sasConfirmed else { return .sessionNotReady }
        guard pendingSend == nil, !pendingReceive else { return .transferInFlight }
        if case .transferring = state { return nil }
        return .sessionNotReady
    }

    /// Why a `sendNow` did not put anything on the wire.
    public enum SendRefusal: Equatable, Sendable {
        /// The connection is gone, not open, not verified, or the session has
        /// left the phase where bytes move.
        case sessionNotReady
        /// A batch is already moving, in either direction, and this lane carries
        /// one at a time.
        case transferInFlight
        /// The batch itself could not be read or described; the model has also
        /// named it in `state`.
        case invalidFileList
    }

    /// What `sendNow` did. Returned rather than published, because the caller
    /// that raced is the one holding the files.
    public enum SendResult: Equatable, Sendable {
        case sent
        case refused(SendRefusal)
    }

    /// **The connect-first half: send a batch the user chose AFTER the session
    /// was already open.**
    ///
    /// The wire needs nothing new for this, and that is the point. A legacy file
    /// session that reaches `proceedAfterVerification` with nothing staged sits
    /// in `.transferring(done: 0, total: 0)` precisely because the peer's
    /// manifest may not have been staged yet either — `onManifest` installs the
    /// writer and sends ACCEPT whenever it arrives. This is the same event from
    /// the other side: a manifest emitted late, into a connection whose peer is
    /// already in that wait. Nothing about the shipped frame format, the
    /// handshake or the ACCEPT/DONE/COMPLETE control flow changes.
    ///
    /// What it does change is which surfaces can exist. Before it, a file-lane
    /// session was only ever useful to a side that had staged before connecting,
    /// so removing pre-connect staging would have left a legacy peer reachable
    /// and mute. Refused rather than queued when `canSendNow` is false: a
    /// connect-first surface only renders the picker when this is true, and a
    /// press that raced the answer must not become a silent no-op that the user
    /// reads as a sent file.
    ///
    /// **And "refused" is returned, not merely done.** The gate is rechecked
    /// here because it has to be: a system file picker is modal to the user, not
    /// to the session, so the peer can start its own transfer or drop the
    /// connection entirely between the press that opened the picker and the
    /// batch coming back out of it. At that moment the surface has already
    /// stopped rendering the send controls, so a `Void` refusal reaches the user
    /// as their chosen files silently vanishing. The caller holding those files
    /// is the only one that can say so, so it is told which of the two things
    /// happened. Refusal never becomes a queue: this session does not gain a
    /// second batch, and nothing is staged for a connection that does not exist.
    ///
    /// Deliberately **not** `@discardableResult`: dropping this value is the
    /// original defect, and the compiler should be the one that notices.
    public func sendNow(sources: [PlaintextSource], metas: [FileMeta]) -> SendResult {
        if let refusal = sendRefusal { return .refused(refusal) }
        guard sources.count == metas.count,
              let total = try? validateRealtimeFiles(metas) else {
            // Named, not swallowed. This is the user's own picked batch and the
            // reason it cannot be sent is theirs to see — the same treatment
            // `stageSend` gives an unreadable staged batch.
            state = .failed(L10n.t(.sessionInvalidFileList))
            return .refused(.invalidFileList)
        }
        // Recorded as `pendingSend` even though it is dispatched immediately:
        // it is what `sessionFiles` renders for the rest of the session, what
        // `retirePreviousConnection` restores on a retry, and what makes
        // `canSendNow` false while these bytes are moving.
        pendingSend = (sources, metas, total)
        totalBytes = total
        state = .transferring(done: 0, total: total)
        connection?.send(sources: sources, metas: metas)
        return .sent
    }

    // MARK: - the SAS gate

    public func confirmSAS() {
        guard case .verifying = state else { return }
        proceedAfterVerification()
    }

    /// Present the gate, or step past it, once BOTH the SAS is derived and the
    /// DataChannel is open. Called from `onSAS` and `onOpen`, which can arrive
    /// in either order.
    private func advanceWhenReady() {
        guard connectionOpened, !sasCode.isEmpty else { return }
        guard case .connecting = state else { return }
        // The device answered. Drop the give-up timer here rather than letting
        // it wake up half a minute later and find a state guard: a live SAS
        // gate that a user is reading, or a running transfer, must not have a
        // pending task whose only defence is that it checks `state` — the next
        // person to touch either of them has no reason to know it exists.
        cancelAnswerTimeout()
        if requiresVerification() {
            sasConfirmed = false
            state = .verifying(sas: sasCode)
        } else {
            proceedAfterVerification()
        }
    }

    /// The single "this connection is cleared to move bytes" transition, shared
    /// by the ON path (the user pressed "They match") and the OFF path (the
    /// commit-reveal-complete encrypted connection is ready, and nothing is
    /// waiting on a human). "Cleared" is about readiness, not about anyone
    /// having established WHO the peer is — only a compared SAS does that.
    private func proceedAfterVerification() {
        sasConfirmed = true
        if let p = pendingSend {
            state = .transferring(done: 0, total: totalBytes)
            connection?.send(sources: p.sources, metas: p.metas)
        } else if pendingReceive {
            startPendingReceive()
        } else {
            // The peer may not have staged its manifest yet. Keep progress on
            // screen; `onManifest` will install the writer and send ACCEPT.
            state = .transferring(done: 0, total: 0)
        }
    }

    private func startPendingReceive() {
        guard pendingReceive else { return }
        do {
            // A FOLDER receive gets its own directory; a flat batch keeps
            // landing straight in the save destination, exactly as before. See
            // `openReceiveWriter` for why the merge is refused.
            //
            // The fallback name is per session rather than fixed: a realtime
            // transfer has no id, and two multi-root folder receives in a row
            // must not race for the same directory name.
            let opened = try openReceiveWriter(
                parent: saveDirectory,
                files: incoming.map { WritableFile(name: $0.name, size: $0.size, path: $0.path) },
                fallbackName: "relayium-\(String(UUID().uuidString.prefix(8)).lowercased())")
            writer = opened.writer
            receivedContainer = opened.container
            completedIncomingFiles = 0
            state = .transferring(done: 0, total: totalBytes)
            connection?.accept()
        } catch {
            connection?.reject()
            teardown()
            state = .failed(ErrorCopy.message(for: error))
        }
    }

    /// Tells the peer, ends the session, and reports the error. Whatever the
    /// receive left on disk is disposed of by `teardown` → `releaseWriter`
    /// rather than here, so this path cannot decide that question differently
    /// from every other ending. It is only ever reached from a live session —
    /// the frame callbacks refuse to run once the state is terminal — and a
    /// writer it finds is therefore a partial one.
    private func failReceive(_ error: Error) {
        connection?.reject()
        teardown()
        state = .failed(ErrorCopy.message(for: error))
    }

    /// Closes the connection rather than returning to a picker. A mismatched
    /// phrase is what a man-in-the-middle looks like, and offering "try again"
    /// on the same connection would invite accepting it the second time.
    public func rejectSAS() {
        connection?.reject()
        teardown()
        state = .idle
    }

    /// **Done** and **Cancel** are the same button at two different moments,
    /// and this is the single call behind both: end the session and land the
    /// model back on `.idle`.
    ///
    /// It deliberately does not decide the fate of what was received. Removing
    /// an unfinished receive's debris is `releaseWriter`'s single rule, reached
    /// through `teardown`, and a finished one is not this call's to touch —
    /// completion has already let go of its writer.
    ///
    /// This used to discard first and tear down afterwards, so Done on the
    /// completion screen deleted the very transfer it was reporting. Physical
    /// run `9e8b8189` on a wired iPad pair read the received bytes and matched
    /// their SHA-256 while completion was on screen; the file was gone from
    /// `Documents/Received` the moment Done was pressed.
    public func cancel() {
        teardown()
        state = .idle
    }

    // MARK: - wiring

    private func wire(_ c: RealtimePeerConnection, generation g: Int) {
        // The handshake has completed and the SAS is derived. Whether that
        // becomes a screen depends on the preference; whether the handshake
        // itself held does not — commit-then-reveal already failed the
        // connection if the reveal did not match, before this ever fires. What
        // the preference does decide is whether anyone ever checks that the peer
        // on the other end is the intended one, which is what comparing the SAS
        // out of band — and only that — establishes.
        c.onSAS = { [weak self] sas in
            Task { @MainActor in
                self?.apply(g) { m in
                    m.sasCode = sas
                    m.sasConfirmed = false
                    m.advanceWhenReady()
                }
            }
        }
        c.onOpen = { [weak self] in
            Task { @MainActor in
                self?.apply(g) { m in
                    m.connectionOpened = true
                    m.advanceWhenReady()
                }
            }
        }
        c.onManifest = { [weak self] metas in
            Task { @MainActor in
                self?.apply(g) { m in
                    do {
                        m.totalBytes = try validateRealtimeFiles(metas)
                        m.incoming = metas
                        m.pendingReceive = true
                        if m.sasConfirmed {
                            m.startPendingReceive()
                        }
                    } catch {
                        m.failReceive(error)
                    }
                }
            }
        }
        c.onFileChunk = { [weak self] bytes in
            Task { @MainActor in
                self?.apply(g) { m in
                    do {
                        guard let writer = m.writer else { throw DownloadDestinationError.incomplete }
                        try writer.write(bytes)
                    } catch {
                        m.failReceive(error)
                    }
                }
            }
        }
        c.onProgress = { [weak self] done in
            Task { @MainActor in
                self?.apply(g) { $0.state = .transferring(done: done, total: $0.totalBytes) }
            }
        }
        c.onDone = { [weak self] ok in
            Task { @MainActor in
                self?.apply(g) { m in
                    // A DONE frame describes a transfer in flight, and once the
                    // session is terminal there is none. A peer that keeps
                    // sending must not be able to reopen the question: an extra
                    // frame ran `completedIncomingFiles` past the manifest into
                    // `failReceive`, which replaced the `.completed` result the
                    // user was looking at — the files still on disk, but no
                    // longer named by the state, so Reveal went with them. A
                    // late DONE(false) is the same move with a better story.
                    guard m.isBusy else { return }
                    guard ok else {
                        // The DONE hash did not match what arrived. Files that
                        // look complete are worse than none.
                        m.failReceive(RealtimeError.tamper)
                        return
                    }
                    m.completedIncomingFiles += 1
                    guard m.completedIncomingFiles <= m.incoming.count else {
                        m.failReceive(DownloadDestinationError.exceedsManifest)
                        return
                    }
                    guard m.completedIncomingFiles == m.incoming.count else { return }
                    let urls: [URL]
                    do {
                        guard let writer = m.writer else { throw DownloadDestinationError.incomplete }
                        urls = try writer.finish()
                        // The writer's job ended with that call, and holding on
                        // to it afterwards is what every deletion-after-the-fact
                        // bug on this path needed: a live handle to files that
                        // are now the user's. Dropping it here means no later
                        // frame, callback, teardown or session HAS one to
                        // discard through — the guarantee is structural rather
                        // than a state check each of those has to remember.
                        m.writer = nil
                    } catch {
                        m.failReceive(error)
                        return
                    }
                    // Only once the bytes are actually on disk, matching the
                    // web receiver (transfer-session.svelte.ts:458). The sender
                    // has no DONE frame of its own and waits on exactly this.
                    m.connection?.complete()
                    m.state = .completed(urls)
                }
            }
        }
        c.onControl = { [weak self] control in
            Task { @MainActor in
                self?.apply(g) { m in
                    // The same rule as DONE, in both of its directions. A late
                    // REJECT must not turn a receive the user has been shown
                    // into a failure, and a late COMPLETE must not overwrite
                    // that `.completed(urls)` with the sender's empty
                    // `.completed([])` — which is the same loss under a
                    // friendlier name, because `received`, and the Reveal and
                    // share affordances built on it, are those URLs.
                    guard m.isBusy else { return }
                    switch control {
                    case .complete:
                        m.state = .completed([])
                    case .reject:
                        // Not a teardown — the failure stays on screen with the
                        // connection still behind it — so this is the one place
                        // that releases the writer on its own. The guard above
                        // is what makes that safe to do unconditionally: a
                        // writer still held by a LIVE session never finished.
                        m.releaseWriter()
                        m.state = .failed(
                            ErrorCopy.message(for: RealtimeConnection.ConnectionError.rejected)
                        )
                    case .accept:
                        break
                    }
                }
            }
        }
        c.onError = { [weak self] err in
            Task { @MainActor in
                self?.apply(g) { m in
                    // Every connection eventually errors or closes, and that
                    // describes the connection, not a transfer that already
                    // ended. A terminal session keeps the result it reached.
                    guard m.isBusy else { return }
                    m.releaseWriter()
                    m.state = .failed(ErrorCopy.message(for: err))
                }
            }
        }
        c.onClose = { [weak self] in
            Task { @MainActor in
                self?.apply(g) { m in
                    // Every connection eventually errors or closes, and that
                    // describes the connection, not a transfer that already
                    // ended. A terminal session keeps the result it reached.
                    guard m.isBusy else { return }
                    m.releaseWriter()
                    m.state = .failed(L10n.t(.sessionPeerDisconnected))
                }
            }
        }
    }

    /// Every callback goes through here, so the generation check exists once.
    private func apply(_ g: Int, _ body: (RealtimeSessionModel) -> Void) {
        guard g == generation else { return }
        body(self)
    }

    /// Disposes of a receive that did not finish, and it is the only place that
    /// removes received bytes.
    ///
    /// A writer still held here is, by construction, one whose `finish()` never
    /// returned — completion drops the reference at the moment it succeeds — so
    /// what is on disk under it is a partial file bearing a name the user was
    /// shown, and it goes. There is deliberately no state check: this used to
    /// ask whether the session was `.completed`, which is a different question
    /// that happens to give the same answer most of the time. It gives the
    /// wrong one for a session that completed in the OTHER direction while an
    /// inbound receive was still partial, and `cancel()` skipped past it
    /// entirely by discarding before tearing down — which is how Done on the
    /// completion screen came to delete the transfer it was reporting.
    ///
    /// Every ending funnels through here instead of calling `discard()` itself,
    /// so this decision cannot be made a second time, differently, at a call
    /// site.
    private func releaseWriter() {
        writer?.discard()
        writer = nil
    }

    /// Ends the previous attempt's connection, and nothing else.
    ///
    /// A terminal state (`.completed`, `.failed`) does not tear down, so
    /// `connection` outlives it. Every entry point that installs a new one has
    /// to close the old one first or it is simply leaked — still holding an
    /// RTCPeerConnection and a claim on the signalling slot. This is the
    /// narrow version, for the paths that must preserve what the local user
    /// staged; `acceptNearby` uses the full `teardown` because an unsolicited
    /// session must not inherit any of it.
    private func retirePreviousConnection() {
        generation += 1
        releaseConnectionState()
        // `totalBytes` is shared by both directions, and `releaseConnectionState`
        // has just dropped whatever the inbound side put there. Restore what the
        // staged send declared, so a retry's progress bar is still its own.
        totalBytes = pendingSend?.totalBytes ?? 0
    }

    /// Everything that belongs to ONE connection: the connection, the handshake
    /// readiness that authorised it, and any receive it had started.
    ///
    /// All of it, not just the connection. A direct retry after a terminal
    /// failure — `join()` again on the same model — used to keep `sasCode`,
    /// `connectionOpened` and `sasConfirmed` from the dead session, so the very
    /// first callback of the NEW one could satisfy `advanceWhenReady` on the old
    /// session's readiness: one peer's `onOpen` combined with a different peer's
    /// SAS. It also kept `pendingReceive` and `incoming`, so the retry could
    /// install the PREVIOUS peer's manifest and send ACCEPT for files the new
    /// peer had never offered.
    ///
    /// What is deliberately preserved is `pendingSend`: the files the local user
    /// staged are the whole point of retrying, and re-picking them is not a
    /// safety measure. `teardown` clears that too, and it is what the two
    /// receiving directions use — an unsolicited inbound session, and a
    /// `.responder` join — because neither is a retry of the local user's send.
    private func releaseConnectionState() {
        cancelAnswerTimeout()
        connection?.close()
        connection = nil
        releaseWriter()
        sasCode = ""
        sasConfirmed = false
        connectionOpened = false
        pendingReceive = false
        completedIncomingFiles = 0
        incoming = []
        receivedContainer = nil
    }

    /// `retirePreviousConnection` plus the staged outbound selection.
    ///
    /// The extra clear is a rule rather than hygiene: `proceedAfterVerification`
    /// sends whatever is pending, so a session the local user did not start as a
    /// sender must not inherit files they staged for somebody else. Two entry
    /// points qualify — `acceptNearby` answering an unsolicited offer, and a
    /// `.responder` `join`, which is the action a user reaches through
    /// **Receive** after a create that failed.
    private func teardown() {
        generation += 1
        releaseConnectionState()
        pendingSend = nil
        totalBytes = 0
    }
}
