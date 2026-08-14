import Combine
import Foundation
import RelayiumKit
import WebRTC

// Everything in this file is macOS-only, and that is the same decision
// `LINK_BUILD_SUPPORT` records one module down rather than a second one.
//
// `RelayiumAppKit` is linked by BOTH apps. A composition that merely happened
// not to be called on iOS would still be one `import` away from being called,
// and the failure it would produce is not a compile error — it is an iPhone
// that announces `link/1`, invites a peer into a two-lane link, and cannot
// answer the offer it asked for. Compiling it out is what makes "only macOS
// composes production link/1" a property of the binary instead of a convention.
//
// Turning iOS on means giving it a surface, a receive destination and its own
// acceptance evidence, and it means editing both this directive and the
// constant. It is not this batch.
#if os(macOS)

/// Where the Workspace's ONE `link/1` attempt is, as a screen states it.
///
/// Deliberately coarser than `LinkSessionConnectionPhase`, and it exists because
/// a room owner knows two things a link projection cannot: that this side is
/// still ASKING a larger-id peer to offer, and why an attempt that never became
/// a link is over. `LinkSessionPresentationModel.phase` starts at `establishing`
/// because by the time it exists something is being established; `requesting`
/// happens before there is anything to project.
public enum LinkWorkspaceConnection: Equatable {
    /// No attempt. The Workspace shows its connect surface.
    case idle
    /// A pairing-code room is joined and is being watched for a peer that
    /// speaks `link/1`. Nothing is claimed yet: the peer may still turn out to
    /// be legacy, and then this room is handed to the path that ships today.
    case watching(code: String)
    /// This side is the larger id, so it may not offer. One immediate request
    /// plus the router's bounded retries are in flight.
    case requesting
    /// A transport is being built. `sas` is the digits to compare, once the
    /// handshake has produced them.
    case establishing(sas: String?)
    /// Both lanes are open under one authenticated identity.
    case open(sas: String)
    /// Terminal, with the reason the user is owed.
    case ended(LinkWorkspaceEnding)

    /// Whether this object is doing anything at all — including watching a room
    /// nothing has been claimed in yet, which is what stops a second `connect`
    /// or a second code from starting underneath one.
    public var isActive: Bool {
        switch self {
        case .watching, .requesting, .establishing, .open: return true
        case .idle, .ended: return false
        }
    }

    /// Whether an attempt has been CLAIMED for a peer. `watching` is deliberately
    /// false: no peer has been admitted, no admission has been moved, and the
    /// legacy path may still take the room.
    public var hasPeer: Bool {
        switch self {
        case .requesting, .establishing, .open, .ended: return true
        case .idle, .watching: return false
        }
    }

    /// The pairing code this room joined, or nil for the same-network room.
    public var pairingCode: String? {
        guard case let .watching(code) = self else { return nil }
        return code
    }

    public var isOpen: Bool {
        guard case .open = self else { return false }
        return true
    }
}

/// Why the Workspace's link attempt is over.
///
/// Every case is something the user can act on, and none of them is a guess:
/// each is produced by exactly one observed transition. In particular there is
/// no "reconnecting" — `LINK_TRANSPORT_REPLACEMENT_SUPPORTED` is false, so a
/// transport that dies after the link opened is terminal, and this type says so
/// rather than implying a recovery no code performs.
public enum LinkWorkspaceEnding: Equatable {
    /// The peer answered `busy`: it already has a link, to us or to somebody
    /// else.
    case refused
    /// This side asked and the peer never offered inside the router's bound.
    case timedOut
    /// The room refused the attempt outright — it is holding a link for another
    /// peer, or the app would not give this one the Workspace.
    case unavailable
    /// The transport failed: before publication, or after it, which without
    /// replacement support is the same terminal answer with a different cause.
    case failed
    /// A clean end: the peer left, hung up, or this side did.
    case closed
    /// The user compared the digits and said they did not match. Distinct from
    /// `closed` because it is the one ending that means "something may be
    /// wrong", and the screen says so.
    case verificationRejected
    /// The room socket went away before the link ever opened, so the
    /// establishment could not finish. A link that HAD opened is not ended by
    /// this — see `roomDidDisconnect`.
    case roomLost
    /// A relayed link reached the bound its TURN credential states.
    ///
    /// Its own case, and not `failed`, because nothing went wrong: the
    /// allocation the server issued has a lifetime and this one ran out. The
    /// remedy is a new code, and the copy says so rather than inviting the user
    /// to retry something that will end the same way.
    case relayExpired
    /// The pairing code could not be joined at all — no ICE configuration, or a
    /// socket that never opened.
    case roomUnavailable
}

/// The one verification boundary a link has.
///
/// Per LINK, not per batch and not per message — which is the whole point of the
/// unified wire and the property the Workspace's copy promises. Once
/// `confirmed`, every later batch and every later message on the same link
/// crosses it without asking again; a new link starts over.
public enum LinkWorkspaceVerification: Equatable {
    /// The user's preference is off, so nothing is held.
    case notRequired
    /// Digits are on screen. Everything outbound, and every inbound consent, is
    /// held until the user answers.
    case pending(sas: String)
    /// Answered yes, once, for this link.
    case confirmed
}

/// The Workspace's owner of ONE same-network `link/1`: one authenticated
/// connection carrying an always-available text lane and repeated file/folder
/// batches, behind one verification boundary for the whole link.
///
/// ## What it is for
///
/// Everything below this object already existed and none of it was reachable.
/// `LinkRoomRouter` decides and claims on the socket's delivery queue,
/// `LinkRoomSession` owns the one establishment, `LinkSessionFactory` composes
/// the transport, and `LinkSessionAttempt` owns the runtime and both
/// projections. What none of them could state is which ROOM they belong to,
/// where received files land, what the peer is called on screen, and what the
/// user is allowed to do before the digits have been compared. That is this
/// object, and it is deliberately nothing else: it opens no socket, derives no
/// key, writes no byte and renders nothing.
///
/// ## The room it belongs to
///
/// The Workspace can own either the code-less same-network room or the one
/// pairing-code room opened by `watchPairingCode`. In both cases it follows one
/// existing signaling socket: one room, one socket, one link. Pairing-code rooms
/// keep that same socket when an older peer requires the legacy fallback.
///
/// The capability registry is that model's too, READ rather than copied. Two
/// registries would let the roster row the user is looking at ("this device can
/// do the unified workspace") disagree with the routing decision made a moment
/// later.
///
/// ## The invariants it exists to make structural
///
/// **1. One link, and one admission.** `LinkAdmission` is constructed here and
/// handed to the router, the session and every assembled link, so the claim, the
/// publication and the release are all the same object's. Nothing in this file
/// moves an admission phase.
///
/// **2. A healthy data channel survives signalling loss.** `roomDidDisconnect`
/// detaches the router ONLY while nothing has published. Once a link is open its
/// lanes are an SCTP association that no longer needs the room, so the socket
/// going away is reported (`signalingLost`) and nothing is torn down. The
/// consequence is stated rather than hidden: no NEW link can be established
/// until the open one ends, because attaching the router to the next socket
/// would replace the epoch that link was admitted under and end it. That is what
/// `pendingSocket` is for.
///
/// **3. Verification is one boundary and it fails closed.** While `verification`
/// is `pending`, nothing outbound is released — not a message, not the batch the
/// user armed before connecting — and no inbound offer or conversation request
/// may be consented to. `confirmSAS` is the only way past it and `rejectSAS`
/// ends the link. The preference is read ONCE, at the first digits this link
/// produced, exactly as the legacy models read it: flipping it mid-handshake
/// must not decide the gate.
///
/// **4. Nothing is claimed that the lane did not accept.** Every command
/// forwards to `LinkSessionAttempt`, which records a transcript entry or a batch
/// row only after the runtime returned. A refusal reaches the user as
/// `actionError` and changes no projection.
///
/// **5. An inbound link is admitted by the app, not by this object.**
/// `LinkAdmission`'s `canAcceptLink` runs on the socket's delivery queue, so it
/// reads a lock-guarded mirror rather than the main actor. That mirror is
/// advisory by construction — it is one hop behind whatever the user just did —
/// so the authoritative answer is asked again on the main actor and a link that
/// loses there is ended at once. Same two-stage shape as `InboundGate`, for the
/// same reason.
///
/// ## What it deliberately does not do
///
/// **It never falls back.** A peer that has not announced exact `link/1` is not
/// this object's business at all: `canLink` answers false, the Workspace uses
/// the existing legacy text or file path, and nothing here is constructed,
/// offered or announced for that peer. That is the whole downgrade boundary, and
/// it is `PeerCapabilityRegistry.supports` rather than a second rule here.
@MainActor
public final class LinkWorkspaceModel: ObservableObject, NearbyRoomObserver {

    // MARK: - what a view binds to

    @Published public private(set) var connection: LinkWorkspaceConnection = .idle
    @Published public private(set) var verification: LinkWorkspaceVerification = .notRequired
    /// The peer's roster label, snapshotted when the attempt began. Presentation
    /// only: peer ids route, names are peer-supplied and never identity.
    @Published public private(set) var peerLabel: String?
    /// The room socket went away while this link was open. The link still works;
    /// what is gone is any chance of recovering it if the transport dies too.
    @Published public private(set) var signalingLost = false
    /// The last command a lane refused, already localized. Cleared by the next
    /// command that is accepted.
    @Published public private(set) var actionError: String?
    /// A message this side typed that the lane never took, handed back so the
    /// composer can restore it.
    ///
    /// It exists because the ONE thing a user cannot recover is text they wrote
    /// and watched disappear. A draft is held for the conversation's consent
    /// round trip, and if the peer declines there is nothing to deliver and
    /// nothing to retry — so the words go back to the field rather than into a
    /// log. Consumed exactly once by `takeReturnedDraft()`.
    @Published public private(set) var returnedDraft: String?

    /// Take the handed-back draft, once. The composer owns it from here.
    public func takeReturnedDraft() -> String? {
        defer { returnedDraft = nil }
        return returnedDraft
    }
    /// The conversation and the connection, as the attempt projects them.
    @Published public private(set) var textModel: LinkSessionPresentationModel?
    /// The transfer, as the attempt projects it. A separate object, because a
    /// file lane that failed closed leaves a live link carrying a live
    /// conversation.
    @Published public private(set) var fileModel: LinkFilePresentationModel?
    /// The relayed link's bound, or nil when nothing relays.
    ///
    /// Present for a pairing-code room that was issued TURN credentials, and
    /// absent for the same-network room, whose credentials are dropped before a
    /// link is built. A view renders `warnAt` as a warning and `deadlineAt` as
    /// the moment this link stops.
    @Published public private(set) var relayDeadline: RelayDeadline?
    /// Whether the relayed link has passed its warning boundary and is inside
    /// the last few minutes of the credential it was issued.
    @Published public private(set) var relayExpiringSoon = false

    /// Take the pairing-code room this peer turned out not to be able to link
    /// in, and run the legacy session on it.
    ///
    /// Set once by the app layer. The socket is still open and still this
    /// object's; the callee builds its connection on it through
    /// `RealtimeConnectionFactory.connectInRoom`. Nil in a headless test, where
    /// the fallback is observed rather than performed.
    ///
    /// `mode` is this object's own answer — see `legacyFallbackMode` — and never
    /// a verb the user pressed. The callee has to move the surface to it as well
    /// as start the session, because the lane it names may not be the one the
    /// code was minted in.
    public var adoptLegacyRoom: ((_ peerId: String,
                                  _ role: Role,
                                  _ config: ICEConfig,
                                  _ mode: TransferMode) -> Void)?

    /// The socket of the pairing room this object currently owns, for the ONE
    /// caller that needs it: the legacy connection the fallback builds.
    ///
    /// Read at call time, never captured. A builder that held a socket from a
    /// previous code would dial a peer id that means nothing in the room it is
    /// actually in.
    public var pairingRoomSignaling: SignalingClient? { pairing?.signaling }

    /// Every file the user has armed and not yet had released, flattened across
    /// however many batches are waiting. Held, never sent.
    ///
    /// The screen renders this as one "staged, waiting for verification" line;
    /// the BATCHES are kept apart underneath, because each is a separate thing
    /// the lane will number and the user chose separately.
    public var armedFiles: [FileMeta] { armedBatches.flatMap(\.files) }

    /// The app's answer to "may an inbound link take the Workspace right now".
    ///
    /// Set once by the app layer, exactly like `NearbyReceiveModel`'s
    /// `shouldAcceptSession`, and called on the MAIN ACTOR as the authoritative
    /// second gate. `nil` preserves headless behaviour where no presentation
    /// arbitration exists.
    public var shouldAcceptLink: ((String) -> Bool)?

    /// Whether an unsolicited link may be admitted at all, as the socket's
    /// delivery queue sees it.
    ///
    /// Advisory and one hop behind on purpose — see invariant 5. The app writes
    /// it whenever surface ownership changes; the value it holds while a user
    /// action is in flight is exactly the value that cannot be trusted, and the
    /// main-actor re-check is what covers that.
    public func setAvailableForInboundLink(_ value: Bool) {
        gate.setAvailable(value)
    }

    /// Keep the advisory mirror in step with the app's own ownership fact.
    ///
    /// Subscribed here rather than in the scene because the App struct is a
    /// value type with nowhere durable to keep a cancellable, and because the
    /// subscription must outlive the window exactly as the link does.
    public func observeAvailability(_ available: AnyPublisher<Bool, Never>) {
        availabilityObserver = available.sink { [weak self] value in
            self?.setAvailableForInboundLink(value)
        }
    }

    /// Close a handed-over pairing room when nothing owns the Workspace.
    ///
    /// The fallback deliberately leaves the code's socket open, because the
    /// legacy connection is built on it. This is the other end of that: the
    /// surface returning to its connect phase is the one honest signal that the
    /// session it served is over.
    public func observeSurfaceIdle(_ idle: AnyPublisher<Bool, Never>) {
        surfaceIdleObserver = idle.sink { [weak self] isIdle in
            guard isIdle else { return }
            self?.releaseHandedOverPairingRoom()
        }
    }

    /// Where an unsolicited peer's roster label comes from. Set by the app so a
    /// link nobody picked is named the same way the roster named it.
    public func resolvePeerLabel(_ resolve: @escaping (String) -> String) {
        peerLabelResolver = resolve
    }

    // MARK: - what the room is made of

    private let capabilities: PeerCapabilityRegistry
    private let admission: LinkAdmission
    private let gate = LinkAcceptanceGate()
    private let socketBox = LinkSocketBox()
    /// The registry of the room that is currently routed.
    ///
    /// `LinkAdmission.supportsLink` runs on the socket's delivery queue, so it
    /// cannot read a main-actor property — and it must read the ACTIVE room's
    /// announcements, not the same-network model's. A code room's peers are in
    /// its own registry, and answering from the wrong one is how a pairing peer
    /// that announced `link/1` gets refused as unsupported.
    private let activeCapabilities = LinkCapabilityBox()
    private let receiveDirectory: () -> URL
    private let requiresVerification: () -> Bool
    private let assemble: Assemble

    /// Builds one link for an admitted peer.
    ///
    /// A seam rather than a direct call to `LinkSessionFactory`, for the same
    /// reason `LinkRoomSession` has one: the socket, the ICE configuration and
    /// the receive directory are this object's to resolve, and a unit test
    /// cannot have a live `RTCPeerConnection` or a second browser.
    typealias Assemble = @MainActor (_ signaling: SignalingClient,
                                     _ peerId: String,
                                     _ role: Role,
                                     _ iceServers: [RTCIceServer],
                                     _ relayOnly: Bool,
                                     _ authenticationGeneration: Int,
                                     _ receiveDirectory: URL,
                                     _ admission: LinkAdmission,
                                     _ initialSignal: JSONValue?) -> LinkSessionAssembly

    private var session: LinkRoomSession!

    /// The socket the router is listening to.
    ///
    /// Cleared only alongside `router.detach()`, which is why a link that
    /// outlives its room keeps a non-nil (dead) socket here: the link was
    /// admitted under that epoch, its leave payload is addressed with that
    /// self id, and `signalingLost` — not a nil socket — is what states the
    /// truth about it.
    private var attached: SignalingClient?
    /// A socket that arrived while an open link still belonged to the previous
    /// epoch. Attached when that link ends — see invariant 2.
    private var pendingSocket: SignalingClient?

    /// The STUN-only servers a same-network link is built with, resolved once
    /// per process.
    ///
    /// Credentials are dropped by `nearbyICEServers`, so a link in this room
    /// cannot allocate a TURN relay and therefore has no relay lifetime to
    /// bound. That is why this batch needs no equivalent of the Web's
    /// `relay-deadline.ts` — and precisely why a pairing-code link would.
    private var iceSnapshot: [ICEServerConfig] = []
    private let iceClient: ICEConfigClient?
    /// Opens the socket for one pairing code. Injected rather than built here
    /// for the reason every other seam in this file is: a unit test cannot have
    /// a hub, and the URL this resolves against belongs to the application.
    /// Nil on a client with no pairing-code surface, which then simply cannot
    /// watch a code.
    private let connectPairingSocket: ((String) -> SignalingClient)?
    /// Where the pairing room's socket is published for the ONE other reader it
    /// has: the legacy connection the fallback builds. Holding it there rather
    /// than here is what lets that connection outlive this object's attempt —
    /// see `LinkRoomHandle`.
    private let pairingRoomHandle: LinkRoomHandle
    /// Every bounded wait this object arms: the capability window, the relay
    /// warning and the relay deadline. One scheduler so a test can drive all
    /// three without a clock.
    private let scheduler: LinkRecoveryScheduler
    /// Read rather than captured, and injected for the same reason: a deadline
    /// derived from a real clock cannot be asserted.
    private let now: () -> Date
    private var iceTask: Task<Void, Never>?

    /// Bumped by every attempt, so a request settlement, a projection change or
    /// an availability re-check belonging to an older one changes nothing.
    private var generation = 0
    /// Identifies THIS authentication step to every assembled link, so a stale
    /// async result can never be accepted by a later link to the same peer.
    private var authenticationGeneration = 0
    private var requestObserver: LinkRequestOperation.ObserverToken?
    private var projectionObservers: Set<AnyCancellable> = []
    private var availabilityObserver: AnyCancellable?
    private var surfaceIdleObserver: AnyCancellable?
    /// A message the user typed before the conversation was open. Sent once the
    /// lane accepts it, handed back if the conversation is refused.
    private var pendingMessage: String?
    /// The batches waiting behind the verification boundary, in the order the
    /// user chose them.
    ///
    /// A QUEUE rather than one slot: a second armed batch is a second thing the
    /// user asked for, and replacing the first would lose work with no error and
    /// no way to tell. Published so a view repaints when one is added, released
    /// or cancelled.
    @Published private var armedBatches: [ArmedBatch] = []

    /// One armed batch. `sources` is pristine: `PlaintextSource` is a value type
    /// over a class-held descriptor, so copying the array is what makes every
    /// attempt the driver makes — including a resumed one — start at offset zero
    /// while the pinned descriptor stays the one staging opened.
    private struct ArmedBatch {
        let files: [FileMeta]
        let sources: [PlaintextSource]
    }
    private var peerLabelResolver: ((String) -> String)?
    /// The attempt this object is painting. Held weakly and only to forward
    /// commands: `LinkRoomSession` is the owner and `leave()` is the only exit.
    private weak var attemptBinding: LinkSessionAttempt?

    // MARK: - construction

    /// - Parameters:
    ///   - capabilities: the ROOM's registry, owned by `LanDiscoveryModel`. Read,
    ///     never written: this object announces nothing.
    ///   - receiveDirectory: resolved by the application and snapshotted per
    ///     link. Not created or tested here — an unreachable directory is
    ///     refused by the batch that needs it, where the user can be told which
    ///     transfer failed.
    ///   - requiresVerification: read at the moment the digits arrive, never
    ///     captured, so flipping the preference applies to the next link rather
    ///     than the next launch.
    ///   - iceClient: the code-less `/api/ice`, fetched once and filtered to
    ///     STUN.
    public convenience init(capabilities: PeerCapabilityRegistry,
                            receiveDirectory: @escaping () -> URL,
                            requiresVerification: @escaping () -> Bool,
                            iceClient: ICEConfigClient?,
                            connectPairingSocket: ((String) -> SignalingClient)? = nil,
                            pairingRoomHandle: LinkRoomHandle? = nil) {
        self.init(capabilities: capabilities,
                  receiveDirectory: receiveDirectory,
                  requiresVerification: requiresVerification,
                  iceClient: iceClient,
                  connectPairingSocket: connectPairingSocket,
                  pairingRoomHandle: pairingRoomHandle,
                  assemble: LinkWorkspaceModel.liveAssembly)
    }

    /// The real composition, and the only place a Workspace link is built.
    static let liveAssembly: Assemble = {
        signaling, peerId, role, iceServers, relayOnly, authenticationGeneration,
        receiveDirectory, admission, initialSignal in
        LinkSessionFactory.make(signaling: signaling,
                                peerId: peerId,
                                role: role,
                                iceServers: iceServers,
                                // The ROOM's answer, never this layer's. A
                                // same-network room is STUN-only and host
                                // candidates are the point; a pairing room that
                                // was issued a relay must not spend the ICE
                                // timeout on direct candidates first.
                                iceTransportPolicy: relayOnly ? .relay : .all,
                                authenticationGeneration: authenticationGeneration,
                                receiveDirectory: receiveDirectory,
                                admission: admission,
                                initialSignal: initialSignal)
    }

    init(capabilities: PeerCapabilityRegistry,
         receiveDirectory: @escaping () -> URL,
         requiresVerification: @escaping () -> Bool,
         iceClient: ICEConfigClient?,
         connectPairingSocket: ((String) -> SignalingClient)? = nil,
         pairingRoomHandle: LinkRoomHandle? = nil,
         scheduler: LinkRecoveryScheduler = LinkDispatchRecoveryScheduler(),
         now: @escaping () -> Date = Date.init,
         assemble: @escaping Assemble) {
        self.capabilities = capabilities
        self.receiveDirectory = receiveDirectory
        self.requiresVerification = requiresVerification
        self.iceClient = iceClient
        self.connectPairingSocket = connectPairingSocket
        // Defaulted to a private one rather than to a shared singleton: a model
        // with no app-supplied handle still owns its room's socket, it simply
        // has no legacy path to hand it to.
        self.pairingRoomHandle = pairingRoomHandle ?? LinkRoomHandle()
        self.scheduler = scheduler
        self.now = now
        self.assemble = assemble

        // Both predicates run on the SOCKET's delivery queue, so neither may
        // touch the main actor. `LinkSocketBox` and `PeerCapabilityRegistry` are
        // lock-guarded for exactly that reason, and `SignalingClient.selfId` has
        // its own lock. Read at call time rather than captured: the socket is
        // replaced on every reconnect, and a peer's announcement can arrive
        // after the roster row it belongs to.
        let gate = self.gate
        let socketBox = self.socketBox
        let active = self.activeCapabilities
        active.registry = capabilities
        self.admission = LinkAdmission(
            selfId: { socketBox.selfId },
            supportsLink: { active.supportsLink($0) },
            canAcceptLink: { _ in gate.isAvailable })

        self.session = LinkRoomSession(admission: admission) { [weak self] peerId, role, signal in
            guard let self else {
                // Structurally unreachable: this object owns the router that
                // drives the session, and both stop with it. The honest fallback
                // is still an assembly, so the room is not left claiming a link
                // that was never built — `LinkRoomSession.begin` has no failure
                // path — and the only way to produce one without an owner would
                // be a second composition. There is none.
                // nonlocalized: a developer assertion for a structurally unreachable state
                preconditionFailure("LinkRoomSession outlived its LinkWorkspaceModel")
            }
            return self.buildAssembly(peerId: peerId, role: role, initialSignal: signal)
        }
    }

    /// The router for the room that is currently attached, or nil.
    ///
    /// Built per ROOM rather than once, because `LinkRoomRouter` reads its
    /// capability registry at construction and a code room's registry is its
    /// own. One router at a time is the same one-room rule everything else here
    /// obeys; `attach` is the only place one is made.
    private var router: LinkRoomRouter?

    private func makeRouter(_ capabilities: PeerCapabilityRegistry) -> LinkRoomRouter {
        LinkRoomRouter(admission: admission,
                       capabilities: capabilities,
                       session: session,
                       scheduler: scheduler)
    }

    // MARK: - the room's socket

    public func roomDidConnect(_ signaling: SignalingClient) {
        // An OPEN link belongs to the epoch it was admitted under. Attaching the
        // router here would bump that epoch and end it — see invariant 2 — so
        // the new socket waits, and `attachPending` takes it when the link is
        // over. A PAIRING room is the same rule for a different reason: this
        // object routes one room at a time, and the code room is the one the
        // user is looking at.
        guard !holdsLiveLink, pairing == nil else {
            pendingSocket = signaling
            return
        }
        attach(signaling, ice: nil)
    }

    public func roomDidDisconnect() {
        // A pairing room is not the discovery model's to end. Its socket is this
        // object's own and its lifetime is the code's.
        guard pairing == nil else {
            pendingSocket = nil
            return
        }
        pendingSocket = nil
        guard !holdsLiveLink else {
            // The lanes are an SCTP association; they do not need the room. What
            // is gone is the ability to recover this link if the transport dies
            // too, and the screen says exactly that rather than pretending.
            signalingLost = true
            return
        }
        let wasAttempting = connection.isActive
        // Nothing has published, so this establishment cannot finish: its answer
        // and its candidates have nowhere to go. Fail closed rather than leave
        // the room connecting to a peer nothing can reach.
        router?.detach()
        router = nil
        session.end()
        attached = nil
        socketBox.client = nil
        if wasAttempting { finish(.roomLost) }
    }

    /// Route one room, and record the ICE a link built in it must use.
    ///
    /// `ice` is nil for the code-less same-network room, whose configuration is
    /// fetched once per process and filtered to STUN — see `loadICEIfNeeded`.
    /// A pairing room passes its own, credentials included, because a code is
    /// the authorisation that pays for relayed bytes.
    private func attach(_ signaling: SignalingClient,
                        ice: ICEConfig?,
                        capabilities roomCapabilities: PeerCapabilityRegistry? = nil) {
        let registry = roomCapabilities ?? capabilities
        activeCapabilities.registry = registry
        router?.detach()
        router = makeRouter(registry)
        attached = signaling
        socketBox.client = signaling
        signalingLost = false
        if let ice {
            roomICE = RoomICE(servers: ice.iceServers,
                              // Relay-only when a relay was issued, which is the
                              // rule `RealtimeConnectionFactory.make` already
                              // applies to a code room: spending the ICE timeout
                              // on direct candidates it will not get is how a
                              // cross-network connection fails slowly.
                              relayOnly: ice.iceServers.contains { server in
                                  server.urls.contains {
                                      let url = $0.lowercased()
                                      return url.hasPrefix("turn:") || url.hasPrefix("turns:")
                                  }
                              })
        } else {
            roomICE = nil
        }
        router?.attach(to: signaling)
        if ice == nil { loadICEIfNeeded() }
    }

    private func attachPending() {
        guard let socket = pendingSocket else { return }
        pendingSocket = nil
        attach(socket, ice: nil)
    }

    /// What a link built in the CURRENT room is configured with.
    ///
    /// Nil means the same-network room, whose STUN-only snapshot is
    /// `iceSnapshot`. A pairing room's is per code and is never cached across
    /// codes: TURN credentials are ephemeral and one code's must never build
    /// another's link.
    private struct RoomICE {
        let servers: [ICEServerConfig]
        let relayOnly: Bool
    }
    private var roomICE: RoomICE?

    /// Whether an authenticated link has published and has not ended.
    private var holdsLiveLink: Bool { session.isPublished }

    /// The roster changed. Forwarded so the router can withdraw an ask to a
    /// device that vanished. Never a teardown: representative presence is not
    /// physical-link authority.
    public func roomRosterChanged(peerIds: Set<String>) {
        router?.rosterChanged(peerIds: peerIds)
    }

    /// A server `left(peer)` frame: physical departure authority, and the one
    /// signal that may end the exact lifecycle bound to that id.
    public func roomPeerLeft(_ peerId: String) {
        router?.peerLeft(peerId)
    }

    // MARK: - a pairing-code room

    /// How long a joined code waits for its peer to say what it speaks.
    ///
    /// The same five seconds `RealtimeConnectionFactory.connectNearby` already
    /// waits for `text/1`, and for the same reason: a hello is an unacknowledged
    /// frame that repeats a bounded number of times, so the window has to cover
    /// the retries and no more. What elapses at the end of it is not an error —
    /// it is the answer "this peer is legacy", and the legacy path takes the
    /// room.
    public static let pairingCapabilityWait: TimeInterval = 5

    /// One pairing-code room, as this object holds it.
    ///
    /// Everything in here is scoped to ONE code. The registry above all: a peer
    /// id means nothing outside the room that issued it, and TURN credentials
    /// are ephemeral, so nothing here is reused across codes.
    private final class PairingRoom {
        let code: String
        /// The role the LEGACY path must use if the fallback fires. It is the
        /// verb the user pressed — creating a code offers, joining one answers —
        /// and it is not `linkRole`'s: that rule is the link's and is computed
        /// from the two room ids.
        ///
        /// It is the ONE thing about the fallback the user still decides, and it
        /// is not a product choice: which of the two actions they took is a fact,
        /// not a question. Which LANE the fallback runs is no longer theirs —
        /// see `legacyFallbackMode`.
        let legacyRole: Role
        let signaling: SignalingClient
        let capabilities: PeerCapabilityRegistry
        let config: ICEConfig
        var announcer: LinkCapabilityAnnouncer?
        var capsSubscription: SignalSubscription?
        /// The per-peer capability windows. Cancelled the moment a peer is
        /// decided, which is why they are kept APART from the relay bound: that
        /// bound belongs to the room's credential and outlives every decision
        /// made in it.
        var timers: [LinkRecoveryTimer] = []
        /// The relayed link's warning and deadline. Cancelled only when the room
        /// itself ends.
        var relayTimers: [LinkRecoveryTimer] = []
        /// Peers this room has already decided about, so a second roster frame
        /// cannot start a second capability window or a second fallback.
        var decided: Set<String> = []
        var resolved = false

        init(code: String, legacyRole: Role,
             signaling: SignalingClient, capabilities: PeerCapabilityRegistry,
             config: ICEConfig) {
            self.code = code
            self.legacyRole = legacyRole
            self.signaling = signaling
            self.capabilities = capabilities
            self.config = config
        }

        /// Main-actor isolated because `LinkCapabilityAnnouncer` is, and the
        /// only caller — `endPairingRoom` — already is too.
        @MainActor
        func retire() {
            timers.forEach { $0.cancel() }
            timers.removeAll()
            relayTimers.forEach { $0.cancel() }
            relayTimers.removeAll()
            capsSubscription?.cancel()
            capsSubscription = nil
            announcer?.stop()
            announcer = nil
            capabilities.reset()
        }
    }

    private var pairing: PairingRoom?
    private var pairingTask: Task<Void, Never>?

    /// Join a pairing code and watch it for a peer that speaks `link/1`.
    ///
    /// ## What this owns that nothing did before
    ///
    /// **The socket.** `RealtimeConnectionFactory.make` opens one inside the call
    /// that builds a legacy connection, so before this there was no room object
    /// above a code and therefore nowhere for a long-lived link to live. This is
    /// that object: one socket per code, opened here, routed by the same
    /// `LinkRoomRouter` the same-network room uses, and handed to the legacy path
    /// intact when the peer turns out not to speak the protocol.
    ///
    /// **The credential's lifetime.** A relayed link is bounded by the TURN REST
    /// expiry `/api/ice` issued — see `RelayDeadline` — and this arms both the
    /// warning and the terminal deadline from it. Without that a relayed link
    /// does not end when its allocation lapses; it silently stops moving bytes.
    ///
    /// ## The three outcomes, and none of them is a guess
    ///
    ///  1. The peer announces exact `link/1` inside `pairingCapabilityWait`: the
    ///     router is asked to establish, and everything afterwards is the same
    ///     unified session the same-network room produces.
    ///  2. The peer announces something else, or nothing, before the window
    ///     elapses: `adoptLegacyRoom` is called with the room's own socket, peer
    ///     and configuration, and this object steps out of the way.
    ///  3. The code could not be joined at all: `.ended(.roomUnavailable)`.
    ///
    /// **There is no `mode` parameter, and that is the product decision this
    /// carries.** A pairing code names a rendezvous, not a kind of transfer: the
    /// server mints one code for both, the Web has exactly one Create and one
    /// Enter action, and asking a macOS user to pick "messages" or "files"
    /// before there is a peer was asking them to guess what a stranger's client
    /// speaks. Outcome 1 never needed the answer — one link carries both lanes.
    /// Outcome 2 does, and it is now derived from evidence rather than from a
    /// question; see `legacyFallbackMode`.
    ///
    /// - Parameters:
    ///   - code: the live pairing code, already minted or typed.
    ///   - legacyRole: what the fallback must use — see `PairingRoom.legacyRole`.
    ///   - files/sources: a batch to arm, exactly as `connect` arms one.
    @discardableResult
    public func watchPairingCode(_ code: String,
                                 legacyRole: Role,
                                 files: [FileMeta] = [],
                                 sources: [PlaintextSource] = []) -> Bool {
        guard !connection.isActive, pairing == nil else { return false }
        guard let iceClient, let connect = connectPairingSocket else { return false }

        beginAttempt(peerLabel: code)
        if !files.isEmpty { armBatch(files: files, sources: sources) }
        connection = .watching(code: code)

        let mine = generation
        pairingTask = Task { [weak self] in
            let config = try? await iceClient.fetch(code: code)
            await MainActor.run {
                guard let self, self.generation == mine else { return }
                self.pairingTask = nil
                guard let config else {
                    self.finish(.roomUnavailable)
                    return
                }
                self.openPairingRoom(code: code, legacyRole: legacyRole,
                                     config: config, connect: connect, generation: mine)
            }
        }
        return true
    }

    private func openPairingRoom(code: String,
                                 legacyRole: Role,
                                 config: ICEConfig,
                                 connect: (String) -> SignalingClient,
                                 generation mine: Int) {
        let socket = connect(code)
        // Its OWN registry, and the room rule is read at call time so a scope
        // change takes effect on the next decision rather than the next launch.
        let capabilities = PeerCapabilityRegistry(
            linkRoomActive: { linkRoomActive(isCodelessRoom: false) })
        let room = PairingRoom(code: code, legacyRole: legacyRole,
                               signaling: socket, capabilities: capabilities,
                               config: config)
        room.announcer = LinkCapabilityAnnouncer(
            registry: capabilities,
            linkRoomActive: { linkRoomActive(isCodelessRoom: false) },
            send: { [weak socket] peerId, signal in socket?.sendSignal(to: peerId, data: signal) })
        // A listener, never an interceptor: a hello must keep travelling to
        // whatever else is on this socket, and it must not compete with the link
        // router for a frame.
        room.capsSubscription = socket.addSignalListener { [weak self] from, data in
            Task { @MainActor in
                guard let self, self.generation == mine, let room = self.pairing else { return }
                guard room.capabilities.record(peerId: from, signal: data) else { return }
                room.announcer?.didHearFrom(peerId: from)
                self.pairingPeerAnnounced(from, generation: mine)
            }
        }
        socket.onPeers = { [weak self] peers in
            Task { @MainActor in self?.pairingRosterChanged(peers, generation: mine) }
        }
        socket.onClose = { [weak self] in
            Task { @MainActor in self?.pairingRoomClosed(generation: mine) }
        }
        socket.onPeerLeft = { [weak self] peerId in
            Task { @MainActor in
                guard let self, self.generation == mine else { return }
                self.router?.peerLeft(peerId)
            }
        }

        pairing = room
        // Published for the fallback BEFORE anything can decide the peer is
        // legacy: `adoptLegacyRoom` runs on a later turn, and a handle that were
        // still empty then would make the fallback refuse a room it is holding.
        pairingRoomHandle.signaling = socket
        attach(socket, ice: config, capabilities: capabilities)
        armRelayDeadline(config)
    }

    /// The room's roster. Every peer in it is greeted, and the FIRST one this
    /// room has not decided about starts the capability window.
    private func pairingRosterChanged(_ peers: [Peer], generation mine: Int) {
        guard generation == mine, let room = pairing, !room.resolved else { return }
        let selfId = room.signaling.selfId ?? ""
        let others = peers.map(\.id).filter { !$0.isEmpty && $0 != selfId }
        room.capabilities.retain(others)
        room.announcer?.rosterChanged(peerIds: others)
        router?.rosterChanged(peerIds: Set(others))
        for peerId in others where !room.decided.contains(peerId) {
            room.decided.insert(peerId)
            armCapabilityWindow(peerId, generation: mine)
            // A peer that announced before its roster frame arrived is already
            // decidable, and waiting five seconds to notice would be five
            // seconds of nothing on screen.
            pairingPeerAnnounced(peerId, generation: mine)
        }
    }

    /// One bounded wait per peer. What elapses at the end of it is an ANSWER —
    /// "this peer does not speak link/1" — not a failure.
    private func armCapabilityWindow(_ peerId: String, generation mine: Int) {
        guard let room = pairing else { return }
        let timer = scheduler.schedule(after: Self.pairingCapabilityWait) { [weak self] in
            Task { @MainActor in
                self?.fallBackToLegacy(peerId: peerId, generation: mine)
            }
        }
        room.timers.append(timer)
    }

    private func pairingPeerAnnounced(_ peerId: String, generation mine: Int) {
        guard generation == mine, let room = pairing, !room.resolved else { return }
        guard room.capabilities.supports(peerId, LINK_CAPABILITY) else {
            // Announced, and NOT this protocol. The answer is already known, so
            // the window is not worth waiting out.
            let announced = room.capabilities.supports(peerId, TEXT_CAPABILITY)
            if announced { fallBackToLegacy(peerId: peerId, generation: mine) }
            return
        }
        room.resolved = true
        room.timers.forEach { $0.cancel() }
        room.timers.removeAll()
        // From here it is the ordinary unified path: the router decides the role
        // from the two room ids, claims the room, and assembles.
        beginLinkAttempt(peerId: peerId, peerLabel: room.code)
        // `beginLinkAttempt` publishes a real link session synchronously before
        // this fires. The pairing-code surface may therefore retire the legacy
        // model that minted or held the code without passing through an all-idle
        // state that would release this room underneath the new link.
        onPairingLinkActivated?()
    }

    /// **Which lane a legacy peer gets, decided from evidence rather than from a
    /// question nobody could answer.**
    ///
    /// The shipped wire has two generations and they do not interoperate: a file
    /// session offers with no capability at all, a text session announces
    /// `text/1` and refuses to build until the peer announces it back
    /// (`RealtimeConnectionFactory.connectInRoom`). So *something* has to pick,
    /// and until this batch it was the user, before there was a peer, out of two
    /// buttons that named a distinction the code itself does not carry.
    ///
    /// Two facts decide it instead, in this order:
    ///
    ///  1. **This side has a batch armed.** Then the answer is files whatever the
    ///     peer said. A staged batch is the user's stated intent, it is the one
    ///     thing a text lane cannot carry at all, and the file lane moves bytes
    ///     in either direction.
    ///  2. **The peer announced exact `text/1`.** On the shipped native wire that
    ///     announcement is only ever sent BY a text session — `Mode.file` has no
    ///     local capabilities — so it is a direct statement of what the peer is
    ///     doing. A current Web peer never reaches here at all: it announces
    ///     `link/1` and takes outcome 1.
    ///
    /// Anything else is files, and that is the honest reading rather than a
    /// coin toss: a legacy peer that announced NOTHING is a file peer by
    /// construction, and answering it with a text offer would guarantee the one
    /// failure this decision exists to avoid.
    ///
    /// The one case it can still get wrong is a stale Web tab, which broadcasts
    /// `text/1` at roster level whatever its user is doing. It is no worse than
    /// the guess it replaces — the user picking "Join files" against a stranger's
    /// message code was the same coin — and it is bounded: a mismatched lane
    /// reaches a truthful terminal state (`.unsupported`) rather than a hang.
    private func legacyFallbackMode(peerId: String, room: PairingRoom) -> TransferMode {
        guard armedBatches.isEmpty else { return .files }
        return room.capabilities.supports(peerId, TEXT_CAPABILITY) ? .text : .files
    }

    /// Hand this room to the path that ships today. Exactly once per room.
    private func fallBackToLegacy(peerId: String, generation mine: Int) {
        guard generation == mine, let room = pairing, !room.resolved else { return }
        room.resolved = true
        // Read BEFORE `armedBatches` is cleared below: the batch the user staged
        // is the first and strongest input to the decision.
        let mode = legacyFallbackMode(peerId: peerId, room: room)
        room.timers.forEach { $0.cancel() }
        room.timers.removeAll()

        // The router stops routing, but the SOCKET stays open and stays this
        // object's: `adoptLegacyRoom` builds its connection on it. Closing it
        // here and letting the legacy path open another is what would strand a
        // creator that had already offered to the id this room joined with.
        router?.detach()
        router = nil
        attached = nil
        socketBox.client = nil
        roomICE = nil
        // The room object is given up but the SOCKET is not: `pairingRoomHandle`
        // holds it, and the legacy connection is built on it. `pairing` is
        // cleared without `endPairingRoom`, whose job is to close a socket
        // nobody took.
        room.retire()
        pairing = nil
        pairingTask?.cancel()
        pairingTask = nil
        connection = .idle
        peerLabel = nil
        relayDeadline = nil
        relayExpiringSoon = false
        let armed = armedBatches
        armedBatches = []
        // Handed back to the caller, which staged it: the legacy models have
        // their own staging and this object must not enqueue into one.
        onLegacyFallbackBatch?(armed.flatMap(\.files), armed.flatMap(\.sources))
        adoptLegacyRoom?(peerId, room.legacyRole, room.config, mode)
    }

    /// A batch the user armed before the room resolved, handed back when the
    /// room turns out to be legacy. Nothing is lost and nothing is sent twice.
    public var onLegacyFallbackBatch: (([FileMeta], [PlaintextSource]) -> Void)?

    /// The watched pairing room resolved to `link/1`, after `hasSession` became
    /// true. macOS uses this to retire the legacy model that rendered the code;
    /// otherwise that stale `.showingCode` state reappears when the link ends.
    public var onPairingLinkActivated: (() -> Void)?

    /// Close a room that was handed to the legacy path once nothing is using it.
    ///
    /// The hand-over deliberately leaves the socket open — the connection built
    /// on it needs it — so something has to close it afterwards, and the only
    /// honest signal is the Workspace returning to its connect phase. The app
    /// calls this from the same ownership fact that drives inbound availability.
    public func releaseHandedOverPairingRoom() {
        guard pairing == nil, !connection.isActive else { return }
        pairingRoomHandle.release()
    }

    private func pairingRoomClosed(generation mine: Int) {
        guard generation == mine, pairing != nil else { return }
        guard !holdsLiveLink else {
            signalingLost = true
            return
        }
        endPairingRoom()
        if connection.isActive { finish(.roomLost) }
    }

    /// Close the code's socket and forget everything scoped to it.
    private func endPairingRoom() {
        guard let room = pairing else { return }
        pairing = nil
        pairingTask?.cancel()
        pairingTask = nil
        room.retire()
        router?.detach()
        router = nil
        attached = nil
        socketBox.client = nil
        roomICE = nil
        room.signaling.onPeers = nil
        room.signaling.onClose = nil
        room.signaling.onPeerLeft = nil
        // Closed here because this object still owns it: the legacy fallback
        // does NOT come through here — it clears `pairing` itself and leaves the
        // socket in the handle for the connection being built on it.
        if pairingRoomHandle.signaling === room.signaling { pairingRoomHandle.signaling = nil }
        room.signaling.close()
        relayDeadline = nil
        relayExpiringSoon = false
    }

    // MARK: - the relayed link's bound

    /// Arm the warning and the terminal deadline the issued credential states.
    ///
    /// Derived ONCE, here, from the configuration this room was handed — see
    /// `relayDeadline(for:now:)` for why re-deriving it later against a stepped
    /// clock would move the boundary under a live link. Nothing is armed when
    /// nothing relays, which is every same-network room and a STUN-only code.
    private func armRelayDeadline(_ config: ICEConfig) {
        guard let deadline = RelayiumKit.relayDeadline(for: config, now: now()) else { return }
        relayDeadline = deadline
        relayExpiringSoon = false
        let mine = generation
        let warnIn = max(0, deadline.warnAt.timeIntervalSince(now()))
        let endIn = max(0, deadline.deadlineAt.timeIntervalSince(now()))
        pairing?.relayTimers.append(scheduler.schedule(after: warnIn) { [weak self] in
            Task { @MainActor in
                guard let self, self.generation == mine else { return }
                self.relayExpiringSoon = true
            }
        })
        pairing?.relayTimers.append(scheduler.schedule(after: endIn) { [weak self] in
            Task { @MainActor in
                guard let self, self.generation == mine else { return }
                // Terminal BEFORE the credential dies rather than after. A link
                // left running past it does not fail — it stops moving bytes,
                // which is the one outcome a user cannot diagnose.
                self.leave(ending: .relayExpired)
            }
        })
    }

    // MARK: - ICE

    /// One fetch per process, at the first room join.
    ///
    /// STUN only, credentials dropped, exactly as `connectNearby` does it: a
    /// code-less `/api/ice` is STUN-only by construction today, and this keeps
    /// that a property of the client rather than a promise about the server. A
    /// link assembled before it lands uses host candidates alone, which is what
    /// actually carries a same-network connection.
    private func loadICEIfNeeded() {
        guard iceSnapshot.isEmpty, iceTask == nil, let iceClient else { return }
        iceTask = Task { [weak self] in
            let config = try? await iceClient.fetch(code: "")
            await MainActor.run {
                guard let self else { return }
                self.iceTask = nil
                guard let config else { return }
                self.iceSnapshot = RealtimeConnectionFactory.nearbyICEServers(config.iceServers)
            }
        }
    }

    // MARK: - starting one

    /// Whether this peer has announced exact `link/1` in a room that allows it.
    ///
    /// The whole downgrade boundary. A false answer is not a degraded link — it
    /// means this peer is not part of this feature and the Workspace's existing
    /// legacy paths own it.
    public func canLink(peerId: String) -> Bool {
        capabilities.supports(peerId, LINK_CAPABILITY)
    }

    /// Open the Workspace's link to one peer.
    ///
    /// Refuses rather than queues while an attempt is live: one link at a time
    /// is `LinkAdmission`'s rule, and this is the surface obeying it.
    ///
    /// `files` is the batch the user had staged when they pressed. It is ARMED,
    /// not sent — see invariant 3.
    @discardableResult
    public func connect(peerId: String,
                        peerLabel: String,
                        files: [FileMeta] = [],
                        sources: [PlaintextSource] = []) -> Bool {
        guard !connection.isActive else { return false }
        guard canLink(peerId: peerId) else { return false }
        guard attached != nil, !signalingLost else {
            beginAttempt(peerLabel: peerLabel)
            finish(.roomLost)
            return false
        }

        beginAttempt(peerLabel: peerLabel)
        if !files.isEmpty { armBatch(files: files, sources: sources) }
        beginLinkAttempt(peerId: peerId, peerLabel: peerLabel)
        return true
    }

    /// Ask the room for a link to one peer.
    ///
    /// Shared by the same-network path, where the user picked the device off a
    /// roster, and the pairing-code path, where the room resolved which peer is
    /// link-capable. Both arrive here having already claimed the attempt; what
    /// this adds is the one `ensure` and the observer on its outcome.
    private func beginLinkAttempt(peerId: String, peerLabel: String) {
        self.peerLabel = peerLabel
        if !connection.hasPeer { connection = .requesting }
        let mine = generation
        guard let router else {
            // No room is routed, so nothing can be asked. Refusing here is the
            // same answer `connect`'s own guard gives, one layer in.
            finish(.roomLost)
            return
        }
        let operation = router.ensure(peerId: peerId)
        // Settlement can already have happened — `ensure` answers synchronously
        // for an unsupported or busy room — and `observe` then calls back inline,
        // which is why the hop below reads the generation rather than the state.
        requestObserver = operation.observe { [weak self] outcome in
            Task { @MainActor in self?.requestSettled(outcome, generation: mine) }
        }
    }

    /// Arm one batch, replacing nothing. See `armedBatches`.
    private func armBatch(files: [FileMeta], sources: [PlaintextSource]) {
        armedBatches.append(ArmedBatch(files: files, sources: sources))
    }

    private func beginAttempt(peerLabel: String) {
        generation += 1
        authenticationGeneration += 1
        projectionObservers.removeAll()
        self.peerLabel = peerLabel
        actionError = nil
        verification = .notRequired
        pendingMessage = nil
        armedBatches = []
        textModel = nil
        fileModel = nil
        attemptBinding = nil
        connection = .requesting
    }

    private func requestSettled(_ outcome: LinkRequestOperation.Outcome, generation mine: Int) {
        guard mine == generation else { return }
        switch outcome {
        case .establishing:
            // The room is building something. Whether that is an establishment
            // this side offered or one the peer answered is not this layer's
            // business; the attempt's own projection says what happened.
            if case .requesting = connection { connection = .establishing(sas: nil) }
        case .refused:
            finishUnestablished(.refused)
        case .timedOut:
            finishUnestablished(.timedOut)
        case .cancelled:
            // A room epoch ended, or the peer left the roster. Both already have
            // a truthful ending on the path that caused them; this settlement is
            // the echo, and re-finishing would overwrite the better reason.
            finishUnestablished(.closed)
        }
    }

    /// A request outcome may only end an attempt that never reached a link. Once
    /// an attempt has a projection, that projection's `ended` is the reason, and
    /// the request's echo must not overwrite it.
    private func finishUnestablished(_ reason: LinkWorkspaceEnding) {
        guard connection.isActive, attemptBinding == nil else { return }
        session.end()
        finish(reason)
    }

    // MARK: - assembling one

    /// Build the link the router admitted, and take the app's authoritative
    /// answer about whether it may have the Workspace.
    private func buildAssembly(peerId: String,
                               role: Role,
                               initialSignal: JSONValue?) -> LinkSessionAssembly {
        // UNSOLICITED means nothing on this side had an attempt yet: the peer's
        // offer, or its request, is what created this one.
        let unsolicited = !connection.isActive
        if unsolicited {
            beginAttempt(peerLabel: peerLabelResolver?(peerId) ?? peerId)
        }
        connection = .establishing(sas: nil)
        let mine = generation

        // Non-nil by construction: `LinkRoomSession.begin` is reached only from
        // the router, and the router routes only while it is attached — a socket
        // this object cleared has already had `router.detach()` called on it. The
        // fallback is a socket that is already closed rather than a crash or an
        // assembly nobody can produce: an establishment on it sends nothing,
        // hears nothing, and reaches the same truthful `establishmentFailed` its
        // own deadlines would have produced on a dead room.
        let signaling = attached ?? LinkWorkspaceModel.detachedSignaling()
        let assembly = assemble(signaling,
                                peerId,
                                role,
                                (roomICE?.servers ?? iceSnapshot).map(rtcServer),
                                roomICE?.relayOnly ?? false,
                                authenticationGeneration,
                                receiveDirectory(),
                                admission,
                                initialSignal)

        attemptBinding = assembly.attempt
        textModel = assembly.attempt.model
        fileModel = assembly.attempt.fileModel
        observe(assembly.attempt.model, generation: mine)

        // Invariant 5: the advisory gate answered on the socket's queue; this is
        // the authoritative answer. It runs on the NEXT main-actor turn because
        // `LinkRoomSession.begin` still owns this one and must be allowed to
        // finish installing the establishment it is about to hold.
        if unsolicited, let shouldAcceptLink, !shouldAcceptLink(peerId) {
            Task { @MainActor [weak self] in
                guard let self, self.generation == mine else { return }
                self.leave(ending: .unavailable)
            }
        }
        return assembly
    }

    /// Follow the attempt's own projection rather than its event stream.
    ///
    /// `LinkSessionAttempt.onLifecycle` belongs to `LinkRoomSession` — it is
    /// installed immediately after `assemble` returns, and a second claimant
    /// would silently take the room's own two facts away from it. The projection
    /// is fed from the SAME ordered delivery, one hop earlier, so following it is
    /// the same information without a second owner.
    private func observe(_ model: LinkSessionPresentationModel, generation mine: Int) {
        model.$phase
            .sink { [weak self] phase in
                Task { @MainActor in self?.phaseChanged(phase, generation: mine) }
            }
            .store(in: &projectionObservers)
        model.$textStatus
            .sink { [weak self] status in
                Task { @MainActor in self?.textStatusChanged(status, generation: mine) }
            }
            .store(in: &projectionObservers)
    }

    private func phaseChanged(_ phase: LinkSessionConnectionPhase, generation mine: Int) {
        guard mine == generation else { return }
        switch phase {
        case let .establishing(sas):
            if case .open = connection { return }
            connection = .establishing(sas: sas)
            if let sas { armVerificationIfNeeded(sas) }
        case let .open(_, sas):
            connection = .open(sas: sas)
            armVerificationIfNeeded(sas)
            releaseHeldWork()
        case let .ended(reason):
            finish(ending(for: reason))
        }
    }

    private func textStatusChanged(_ status: LinkTextStatus, generation mine: Int) {
        guard mine == generation else { return }
        switch status {
        case .open:
            flushPendingMessage()
        case .refused, .ended, .failed:
            // The draft the user typed is theirs and is handed back rather than
            // discarded; nothing here has claimed it was delivered.
            if let held = pendingMessage {
                actionError = L10n.t(.linkMessagesDeclined)
                returnedDraft = held
                pendingMessage = nil
            }
        case .incomingRequest:
            // The peer asked to talk on a link this side already consented to.
            // See `admitConversation` — the answer is not a question.
            admitConversation()
        case .idle, .waitingAccept:
            break
        }
    }

    /// The preference is read ONCE per link, at the first digits this link
    /// produced. Reading it again on `opened` would let a preference flipped
    /// mid-handshake decide the gate, which is exactly the timing dependency the
    /// legacy models avoid.
    private func armVerificationIfNeeded(_ digits: String) {
        guard verification == .notRequired, !digits.isEmpty else { return }
        guard requiresVerification() else { return }
        verification = .pending(sas: digits)
    }

    private func ending(for reason: LinkSessionRuntimeEnd) -> LinkWorkspaceEnding {
        switch reason {
        case .establishmentFailed, .wiringFailed: return .failed
        case .establishmentClosed, .stopped: return .closed
        case .linkEnded:
            // An open link that ended on its own. `LinkSessionRuntimeEnd` cannot
            // say WHY — the cause is a `LinkRecoveryError` the lane owner
            // consumed — but the room can: `LinkRecoveryCoordinator` releases a
            // clean close as `.closed` and a failure as `.failed`, and this
            // object owns the `LinkAdmission` both land on. Read here rather
            // than guessed, and read after the projection's own `ended`, which
            // the bridge delivers on a later main-actor turn than the release.
            return admission.phase == .failed ? .failed : .closed
        }
    }

    // MARK: - the verification boundary

    public var isVerificationPending: Bool {
        if case .pending = verification { return true }
        return false
    }

    /// The digits the user is being asked to compare, or nil.
    public var sasToCompare: String? {
        guard case let .pending(sas) = verification else { return nil }
        return sas
    }

    /// The user compared the digits and they matched. Idempotent, and the only
    /// way held work is released.
    public func confirmSAS() {
        guard case .pending = verification else { return }
        verification = .confirmed
        actionError = nil
        releaseHeldWork()
    }

    /// They did not match. Terminal, and named as its own ending so the screen
    /// can say why rather than reporting an ordinary hangup.
    public func rejectSAS() {
        guard case .pending = verification else { return }
        leave(ending: .verificationRejected)
    }

    /// Whether the link will take work right now.
    public var acceptsWork: Bool { connection.isOpen && !isVerificationPending }

    /// Everything held behind the boundary, released once and in one order: the
    /// armed batch first, because it is what the user asked for before they were
    /// asked anything, then a message they typed while waiting.
    private func releaseHeldWork() {
        guard acceptsWork else { return }
        releaseArmedBatches()
        // A request that arrived while the digits were on screen was held, not
        // refused. It is admitted here rather than by the status observer,
        // because the status has not changed — the BOUNDARY has.
        admitConversation()
        if pendingMessage != nil { flushOrOpenConversation() }
    }

    /// Every armed batch, in the order the user chose them, and each cleared
    /// from the queue BEFORE it is handed over — so a lane that refuses one
    /// leaves an `actionError` rather than a batch that is both armed and
    /// enqueued.
    private func releaseArmedBatches() {
        guard !armedBatches.isEmpty, let attempt = attemptBinding else { return }
        let waiting = armedBatches
        armedBatches = []
        for batch in waiting {
            enqueue(files: batch.files, sources: batch.sources, on: attempt)
        }
    }

    // MARK: - the conversation

    /// Whether the composer may accept typing.
    ///
    /// Deliberately true before a conversation exists: pressing Send is what
    /// OPENS one, so a composer disabled until the peer had consented would be a
    /// composer nobody could ever use. What it is NOT true for is a link that is
    /// not open, or one whose digits have not been compared.
    public var canCompose: Bool { acceptsWork }

    /// Whether the peer is being asked, right now, to accept a conversation this
    /// side opened. What the composer's "waiting" note renders on.
    public var isWaitingForConversation: Bool {
        textModel?.textStatus == .waitingAccept || pendingMessage != nil
    }

    /// Send one message, opening the conversation if this is the first.
    ///
    /// The lane's consent step is preserved exactly: the peer sees a request and
    /// answers it. What this removes is the user having to know that — the draft
    /// is held for the one round trip and sent the instant the lane says open.
    public func send(message body: String) {
        guard !body.isEmpty else { return }
        guard acceptsWork else {
            actionError = L10n.t(.linkNotReady)
            return
        }
        pendingMessage = body
        flushOrOpenConversation()
    }

    private func flushOrOpenConversation() {
        guard let attempt = attemptBinding, let status = textModel?.textStatus else { return }
        switch status {
        case .open:
            flushPendingMessage()
        case .idle, .ended, .refused, .failed:
            do {
                try attempt.openTextConversation()
                actionError = nil
            } catch {
                returnedDraft = pendingMessage
                pendingMessage = nil
                actionError = ErrorCopy.message(for: error)
            }
        case .waitingAccept, .incomingRequest:
            // Already asked, or being asked. The draft waits for the answer.
            break
        }
    }

    private func flushPendingMessage() {
        guard acceptsWork, let body = pendingMessage, let attempt = attemptBinding else { return }
        do {
            try attempt.sendText(body)
            pendingMessage = nil
            actionError = nil
        } catch {
            returnedDraft = pendingMessage
            pendingMessage = nil
            actionError = ErrorCopy.message(for: error)
        }
    }

    /// **Take the peer's conversation request, because it was already answered.**
    ///
    /// A link is entered on purpose. One side minted a pairing code and passed it
    /// on, or typed a code they were given, or picked a named device off a roster
    /// — and then both sides compared six digits out loud. Asking again, in a
    /// two-button strip three lines high, was asking a user to consent to talking
    /// to the person they had just verified they were talking to. Every real
    /// answer was yes, and the one thing the prompt reliably did was leave the
    /// peer's `waitingAccept` spinner running until somebody noticed it.
    ///
    /// What did NOT move is the boundary that matters. This is admission, not
    /// authorisation, and it is bounded by exactly three facts, each of which is
    /// re-read here rather than assumed by whoever called:
    ///
    ///  - **`acceptsWork`** — the link is open AND the digits are answered. While
    ///    `verification` is `pending` nothing is admitted, and `releaseHeldWork`
    ///    is the only thing that revisits it. So a request that arrives during
    ///    the SAS is held, exactly as an armed batch is, and a link the user
    ///    rejects is torn down having admitted nothing.
    ///  - **an attempt** — `attemptBinding` is nil before a link is assembled and
    ///    again the instant `finish` runs, so a request settling after the
    ///    session ended reaches no lane.
    ///  - **the lane's own state** — `incomingRequest` and nothing else, so this
    ///    is idempotent and cannot re-answer a conversation that is already open.
    ///
    /// It stays deliberately narrow: the file lane's `acceptInboundBatch` is
    /// untouched, because accepting a manifest releases a write to this user's
    /// disk and is a decision about content rather than about the connection.
    private func admitConversation() {
        guard acceptsWork,
              let attempt = attemptBinding,
              textModel?.textStatus == .incomingRequest else { return }
        do { try attempt.acceptTextConversation(); actionError = nil }
        catch { actionError = ErrorCopy.message(for: error) }
    }

    // MARK: - the transfer

    /// Queue one more batch on the SAME link. No new code, no new digits.
    ///
    /// Held behind the verification boundary while it is pending, and ARMED
    /// rather than dropped — the user asked for this batch and is owed it once
    /// they have answered.
    public func send(files: [FileMeta], sources: [PlaintextSource]) {
        guard !files.isEmpty else { return }
        // ARMED for every state that is not ready YET, and refused only for one
        // that never will be. A batch chosen while the link is still
        // establishing, or while the digits are unanswered, is an intent the
        // user is owed once the link can take it — dropping it there would lose
        // work silently, and sending it would be the leak this gate exists to
        // prevent.
        guard let attempt = attemptBinding, acceptsWork else {
            guard connection.isActive else {
                actionError = L10n.t(.linkNotReady)
                return
            }
            armedBatches.append(ArmedBatch(files: files, sources: sources))
            actionError = nil
            return
        }
        enqueue(files: files, sources: sources, on: attempt)
    }

    private func enqueue(files: [FileMeta],
                         sources: [PlaintextSource],
                         on attempt: LinkSessionAttempt) {
        do {
            // `stage` must answer with PRISTINE sources for every attempt the
            // driver makes, including a resumed one. `PlaintextSource` is a
            // value type over a class-held descriptor, so returning the captured
            // array hands back copies whose read offset is zero while the pinned
            // descriptor — the thing that stops the bytes being swapped between
            // consent and transmission — is the same one staging opened.
            try attempt.enqueueFiles(files: files) { sources }
            attempt.pumpFiles()
            actionError = nil
        } catch {
            actionError = ErrorCopy.message(for: error)
        }
    }

    /// Consent to the peer's manifest. Held behind the verification boundary:
    /// accepting a batch is releasing a write to this user's disk.
    public func acceptInboundBatch() {
        guard acceptsWork, let attempt = attemptBinding else { return }
        attempt.acceptInboundBatch()
    }

    public func rejectInboundBatch() { attemptBinding?.rejectInboundBatch() }

    public func cancelOutboundBatch() { attemptBinding?.cancelOutboundBatch() }

    public func cancelQueuedBatch(_ batch: Int) { attemptBinding?.cancelQueuedBatch(batch) }

    /// Drop a batch the user armed before the digits were compared. The one
    /// cancel with no lane behind it, because the lane never saw it.
    public func cancelArmedBatch() {
        armedBatches = []
    }

    // MARK: - the exit

    /// End the link, whatever state it is in. Idempotent.
    public func leave() { leave(ending: .closed) }

    private func leave(ending reason: LinkWorkspaceEnding) {
        guard connection.isActive else { return }
        // Retires the attempt and releases the room. The attempt's bridge is
        // silenced first, so the teardown produces no projection change and this
        // reason is the one the screen keeps.
        session.end()
        finish(reason)
    }

    /// Return to idle and keep the terminal reason on screen.
    ///
    /// The projections are deliberately KEPT: a committed batch's Reveal in
    /// Finder, a failed batch's manifest and the transcript the user was reading
    /// all outlive the link, exactly as the legacy models' terminal states do.
    /// `dismiss()` is what clears them.
    private func finish(_ reason: LinkWorkspaceEnding) {
        requestObserver?.cancel()
        requestObserver = nil
        projectionObservers.removeAll()
        // A message the lane never took goes back to the user, not into the
        // ending. The link is over; the words are still theirs.
        if let held = pendingMessage { returnedDraft = held }
        pendingMessage = nil
        attemptBinding = nil
        armedBatches = []
        if case .pending = verification { verification = .notRequired }
        // The code's socket goes with the attempt it existed for. A room left
        // open would keep this device in a pairing room nobody is looking at,
        // and its TURN credential would keep counting down against nothing.
        endPairingRoom()
        connection = .ended(reason)
        attachPending()
    }

    /// The user is done looking at the finished session.
    public func dismiss() {
        guard case .ended = connection else { return }
        connection = .idle
        textModel = nil
        fileModel = nil
        peerLabel = nil
        actionError = nil
        verification = .notRequired
        // `signalingLost` is deliberately NOT cleared. It is a fact about the
        // ROOM, not about the session the user just dismissed, and clearing it
        // here would let the next `connect` pass its own guard and send a
        // request into a socket that is gone — a thirty-second timeout instead
        // of an immediate, truthful refusal. Only attaching a live socket
        // clears it.
        attachPending()
    }

    /// Whether the Workspace should be rendering this object at all: a live
    /// attempt, or a terminal one whose result the user has not dismissed.
    ///
    /// **`watching` is deliberately false.** A joined code with no peer yet is
    /// not a link session — it is the pairing surface the user is already
    /// looking at, with its code, its QR and its expiry — and taking the screen
    /// there would replace that with an empty link pane and then, if the peer
    /// turned out to be legacy, replace it back. The link pane appears when
    /// there is a peer to name.
    public var hasSession: Bool {
        switch connection {
        case .idle, .watching: return false
        case .requesting, .establishing, .open, .ended: return true
        }
    }
}

/// A signalling client on a channel that is already closed.
///
/// The unreachable branch of `buildAssembly`, given a value instead of a crash.
/// It is deliberately a real `SignalingClient` rather than an optional threaded
/// through `LinkRoomSession`: making assembly failable would give the room a
/// refusal path whose admission release nothing currently performs, which is a
/// worse failure than an establishment that times out.
extension LinkWorkspaceModel {
    static func detachedSignaling() -> SignalingClient {
        SignalingClient(channel: ClosedWebSocketChannel(), name: "")
    }
}

/// Open nothing, send nothing, deliver nothing. `isOpen` is false from the
/// first instant, so `SignalingClient` never reports a join and nothing built on
/// it can mistake it for a room.
final class ClosedWebSocketChannel: WebSocketChannel {
    var onOpen: (() -> Void)?
    var onText: ((String) -> Void)?
    var onClose: (() -> Void)?
    var isOpen: Bool { false }
    func send(_ text: String) {}
    func close() {}
}

/// The active room's capability registry, readable from the socket's delivery
/// queue.
///
/// `LinkAdmission.supportsLink` is consulted while routing an inbound frame,
/// off the main actor, and the answer depends on WHICH room is attached: a
/// pairing code's announcements live in its own registry, which is discarded
/// with the code. `PeerCapabilityRegistry` is itself lock-guarded; what this
/// adds is a lock-guarded reference to whichever one is current.
final class LinkCapabilityBox: @unchecked Sendable {
    private let lock = NSLock()
    private var _registry: PeerCapabilityRegistry?

    var registry: PeerCapabilityRegistry? {
        get { lock.lock(); defer { lock.unlock() }; return _registry }
        set { lock.lock(); _registry = newValue; lock.unlock() }
    }

    func supportsLink(_ peerId: String) -> Bool {
        registry?.supports(peerId, LINK_CAPABILITY) ?? false
    }
}

/// The advisory half of inbound link admission: one boolean, readable from the
/// socket's delivery queue.
///
/// It exists for the reason `InboundGate` records — the decision has to be made
/// in the same instant the signal is seen, and hopping to the main actor first
/// would let two offers in one burst both find the room open. It is deliberately
/// nothing more than a mirror; the authoritative answer is asked again on the
/// main actor.
final class LinkAcceptanceGate: @unchecked Sendable {
    private let lock = NSLock()
    private var available = true

    var isAvailable: Bool {
        lock.lock(); defer { lock.unlock() }
        return available
    }

    func setAvailable(_ value: Bool) {
        lock.lock()
        available = value
        lock.unlock()
    }
}

/// The room socket, readable from the socket's own delivery queue.
///
/// `LinkAdmission.selfId` is consulted while routing an inbound frame, which
/// happens off the main actor, so the model's `attached` property — which is
/// main-actor isolated — cannot answer it. This holds the same reference behind
/// a lock. `SignalingClient.selfId` has a lock of its own, so reading through
/// this is safe from any thread.
final class LinkSocketBox: @unchecked Sendable {
    private let lock = NSLock()
    private var _client: SignalingClient?

    var client: SignalingClient? {
        get { lock.lock(); defer { lock.unlock() }; return _client }
        set { lock.lock(); _client = newValue; lock.unlock() }
    }

    var selfId: String { client?.selfId ?? "" }
}

#endif
