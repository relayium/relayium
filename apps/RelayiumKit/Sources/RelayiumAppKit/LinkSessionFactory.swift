import Foundation
import RelayiumKit
import WebRTC

/// The one place an application turns its own ingredients into ONE `link/1`
/// attempt: a signalling client, a peer, a role, an ICE configuration, an
/// authentication generation, a resolved receive directory and the room's
/// admission go in, and a `LinkSessionAttempt` comes out.
///
/// ## What it is for
///
/// Every piece below this line is complete and every one of them is unreachable,
/// because nothing assembles them: `WebRTCLinkTransport` establishes,
/// `webRTCLinkReplacementFactory` rebuilds, `LinkSessionRuntime` owns one
/// authenticated link and `LinkSessionAttempt` owns one screen's worth of it.
/// What none of them can state alone is which ingredients they must SHARE. That
/// is this enum, and it is deliberately nothing else.
///
/// It is the composition and only the composition. There is no policy here: it
/// decides no role, resolves no ICE server, opens no socket, creates no
/// directory, verifies no signal, moves no admission phase, and derives no key.
/// Everything it does is hand an existing decision to the layer that consumes
/// it, once.
///
/// ## The invariants it exists to make structural
///
/// **1. One socket, one ICE configuration, for the establishment AND for every
/// rebuild.** The initial transport and the replacement factory are built from
/// the SAME `signaling`, `iceServers`, `iceTransportPolicy` and `deadlines`
/// values, in one expression each, from one set of parameters. A rebuild issued
/// a second `SignalingClient` would offer into a socket nobody routes an answer
/// back through, and one issued different servers or a different transport
/// policy would be a second ICE decision for one link — silently divergent, and
/// only ever visible as a rebuild that fails on a network where the first
/// connection worked.
///
/// **2. One identity, and this layer never sees it.** Nothing here names
/// `LinkIdentity` or `LinkCodecs`. The initial transport derives the link's one
/// identity through commit/reveal, `LinkSessionRuntime` builds everything else
/// out of exactly the value the transport published, and the replacement factory
/// is HANDED that identity rather than the ingredients of one. So a second AEAD
/// sequence counting from zero under one pair of session keys stays
/// unrepresentable rather than merely avoided.
///
/// **3. One owner and one ordered event path.** The runtime is built INSIDE the
/// attempt's factory closure and is handed that attempt's own sink verbatim, so
/// a runtime assembled here reports to that attempt's bridge and to nothing
/// else. Nothing is observed, wrapped, tee'd or counted on the way past: a
/// second consumer of the event stream would be a second order, and two
/// independent hops can deliver a batch's progress before the offer it belongs
/// to.
///
/// **4. Assembled before started.** The builder must answer with a transport
/// that is not running, and this function never starts one: `LinkSessionRuntime`
/// writes all four callback slots in its own initializer and
/// `LinkSessionAttempt` binds the bridge and calls `start()` last. A transport
/// that arrived already started would be racing its own establishment against
/// the wiring that is supposed to hear it.
///
/// The window between a real transport being CONSTRUCTED and its callbacks being
/// written is not closed here, and cannot be: `WebRTCLinkTransport` claims its
/// signalling slot in its own initializer, so from that instant its queue can
/// receive a signal, while the four slots are `LinkSessionRuntime`'s to write —
/// which is exactly the arrangement that type documents and depends on. What
/// this layer owes is to make the window as narrow as a caller can: the two
/// constructions are adjacent, nothing between them does work, and neither
/// suspends. A `busy` reply already in flight when a link is assembled is
/// therefore the one signal that can reach a transport whose reporting slots do
/// not exist yet, and it ends that transport silently — the establishment
/// deadlines are what bound it, not this function.
///
/// **Recovery scheduling is not a decision here.** `LinkSessionRuntime` supplies
/// its own `LinkDispatchRecoveryScheduler`, and that default is production's;
/// this layer neither overrides it nor re-exposes it, because a second wake-up
/// policy for one link is the kind of thing that only shows up as a rebuild
/// window that expires at a different time than the coordinator believes.
///
/// **5. The receive directory is a SNAPSHOT the application resolved.** It is
/// taken once, by value, and travels straight to the runtime. This layer does
/// not create it, test it, or hold its security-scoped access open — resolving a
/// destination and keeping it reachable is the application's, and it is the only
/// thing that can. An unreachable directory is therefore refused by the batch
/// that needs it, where the user can be told which transfer failed, rather than
/// by an assembly that cannot know whether the directory will still be there
/// when the first byte arrives.
///
/// **6. Admission is forwarded, never driven.** The room's `LinkAdmission` is
/// passed through so it and `LinkRecoveryCoordinator`'s gap cannot disagree
/// about whether a rebuild is in flight. Nothing here calls
/// `didBeginEstablishing`, `didOpen`, `didFail` or `didClose`: those belong to
/// the room owner that routed the signal and decided this link should exist, and
/// making one of them from inside an assembly would be admission policy in the
/// layer that must not have any.
///
/// It is non-optional here even though the runtime accepts nil, because an
/// application that has a room has an admission — and this is the boundary where
/// that stops being a convention and becomes a signature.
///
/// ## What it is not
///
/// Unreachable from production, and not merely by convention: this enum is
/// INTERNAL to `RelayiumAppKit`, exactly as `LinkSessionAttempt` is, so neither
/// app target can name it at all. `LINK_BUILD_SUPPORT` and
/// `LINK_TRANSPORT_REPLACEMENT_SUPPORTED` are both still false, nothing outside
/// the tests calls `make`, and no `AppEnvironment`, view, iOS or macOS target
/// names it. What this closes is the hole `WebRTCLinkTransport` names by
/// name — "**Admission/factory integration.** Nothing constructs this class" —
/// and nothing more: no capability is advertised, no picker is opened, no
/// directory is chosen and no screen is presented.
enum LinkSessionFactory {

    // MARK: - the two seams
    //
    // They exist for this package's tests rather than as API: `make` below is
    // the whole surface anything else uses. Both are here for the same
    // reason `RealtimeConnectionFactory` injects its connection builder — what
    // goes wrong in an assembly is WHICH ingredients each half was given and in
    // what order it was allowed to run, and none of that is observable while the
    // step itself needs a live `RTCPeerConnection` and a second peer.

    /// Builds the initial transport for ONE establishment, unstarted.
    typealias InitialTransportBuilder = (_ signaling: SignalingClient,
                                         _ peerId: String,
                                         _ role: Role,
                                         _ iceServers: [RTCIceServer],
                                         _ iceTransportPolicy: RTCIceTransportPolicy,
                                         _ authenticationGeneration: Int,
                                         _ deadlines: LinkDeadlines)
    -> LinkInitialTransport

    /// Builds the factory that will produce every authenticated rebuild.
    typealias ReplacementFactoryBuilder = (_ signaling: SignalingClient,
                                           _ iceServers: [RTCIceServer],
                                           _ iceTransportPolicy: RTCIceTransportPolicy,
                                           _ deadlines: LinkDeadlines)
    -> LinkReplacementFactory

    /// The real one, and the only place a `link/1` establishment is constructed.
    static let liveInitialTransport: InitialTransportBuilder = {
        signaling, peerId, role, iceServers, iceTransportPolicy,
        authenticationGeneration, deadlines in
        WebRTCLinkTransport(signaling: signaling,
                            peerId: peerId,
                            role: role,
                            iceServers: iceServers,
                            iceTransportPolicy: iceTransportPolicy,
                            authenticationGeneration: authenticationGeneration,
                            deadlines: deadlines)
    }

    /// The real one, and the only place a rebuild factory is constructed.
    static let liveReplacementFactory: ReplacementFactoryBuilder = {
        signaling, iceServers, iceTransportPolicy, deadlines in
        webRTCLinkReplacementFactory(signaling: signaling,
                                     iceServers: iceServers,
                                     iceTransportPolicy: iceTransportPolicy,
                                     deadlines: deadlines)
    }

    // MARK: - the assembly

    /// Assemble ONE attempt. It is running by the time this returns — the
    /// attempt starts its runtime as the last act of its own initializer — and
    /// the caller owns it: an attempt that is dropped without `retire()` leaves
    /// a live link behind.
    ///
    /// - Parameters:
    ///   - signaling: the room's socket, used by this establishment AND by every
    ///     rebuild. Not owned here: this object installs no handler, sends
    ///     nothing and closes nothing.
    ///   - peerId: the peer `LinkAdmission` admitted.
    ///   - role: the deterministic role `LinkAdmission` decided. Never a
    ///     preference of this layer's — two initiators put two offers into one
    ///     pair of lanes.
    ///   - iceServers: the servers the room was issued, already resolved.
    ///   - iceTransportPolicy: relay-only or not, as the application decided it.
    ///     Required rather than defaulted, because the answer is a real
    ///     per-room decision and a default here would quietly become the
    ///     product's.
    ///   - authenticationGeneration: the owner's identity for THIS
    ///     authentication step, so a stale async result can never be accepted by
    ///     a later link to the same peer. Required for the same reason: the
    ///     counter belongs to the room owner, and defaulting every link to zero
    ///     would defeat it.
    ///   - receiveDirectory: the already-reachable, already-authorized parent
    ///     every inbound batch is written under, for the whole life of the
    ///     attempt. See invariant 5.
    ///   - admission: the room's one-link state. Forwarded, never driven — see
    ///     invariant 6.
    ///   - deadlines: the three establishment deadlines, applied to the first
    ///     transport and to every rebuild. The defaults are the deployed web
    ///     client's; overriding them is for tests.
    ///
    /// There is no failure path, and that is a property rather than an omission:
    /// every ingredient is already resolved by the time it arrives here, nothing
    /// below this line throws, and the one composition that could be invalid —
    /// a coordinator holding a different link's authentication — is
    /// unrepresentable because `LinkSessionRuntime` builds both halves from the
    /// single identity its transport published.
    @MainActor
    static func make(signaling: SignalingClient,
                     peerId: String,
                     role: Role,
                     iceServers: [RTCIceServer],
                     iceTransportPolicy: RTCIceTransportPolicy,
                     authenticationGeneration: Int,
                     receiveDirectory: URL,
                     admission: LinkAdmission,
                     deadlines: LinkDeadlines = LinkDeadlines())
    -> LinkSessionAttempt {
        make(signaling: signaling,
             peerId: peerId,
             role: role,
             iceServers: iceServers,
             iceTransportPolicy: iceTransportPolicy,
             authenticationGeneration: authenticationGeneration,
             receiveDirectory: receiveDirectory,
             admission: admission,
             deadlines: deadlines,
             buildInitialTransport: liveInitialTransport,
             buildReplacementFactory: liveReplacementFactory)
    }

    /// The composition, with the two things a unit test cannot have handed in.
    ///
    /// The seam exists for this package's tests, not as API: `make` above is
    /// the entry point anything else uses, and it is what binds both builders to
    /// the real thing.
    @MainActor
    static func make(signaling: SignalingClient,
                     peerId: String,
                     role: Role,
                     iceServers: [RTCIceServer],
                     iceTransportPolicy: RTCIceTransportPolicy,
                     authenticationGeneration: Int,
                     receiveDirectory: URL,
                     admission: LinkAdmission,
                     deadlines: LinkDeadlines,
                     buildInitialTransport: InitialTransportBuilder,
                     buildReplacementFactory: ReplacementFactoryBuilder)
    -> LinkSessionAttempt {
        // ONE configuration, read once and handed to both halves — see
        // invariant 1. The rebuild factory is built BEFORE the transport for no
        // reason other than reading order; neither can observe the other.
        let replacementFactory = buildReplacementFactory(signaling,
                                                         iceServers,
                                                         iceTransportPolicy,
                                                         deadlines)
        let transport = buildInitialTransport(signaling,
                                              peerId,
                                              role,
                                              iceServers,
                                              iceTransportPolicy,
                                              authenticationGeneration,
                                              deadlines)

        // The runtime is built INSIDE the attempt's factory closure, which is
        // the only way to obtain the sink — so the link assembled here reports
        // to this attempt's bridge and to nothing else. `sink` travels through
        // untouched: see invariant 3.
        return LinkSessionAttempt(runtime: { sink in
            LinkSessionRuntime(transport: transport,
                               receiveDirectory: receiveDirectory,
                               replacementFactory: replacementFactory,
                               admission: admission,
                               onEvent: sink)
        })
    }
}
