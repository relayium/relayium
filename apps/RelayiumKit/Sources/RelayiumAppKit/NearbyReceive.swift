import Combine
import Foundation
import RelayiumKit

/// What an inbound nearby session is carrying. Drives which UI the app puts on
/// screen, so a session that arrives while the picker was on the other mode
/// still shows itself.
public enum NearbyReceiveKind: Equatable {
    case file
    case text
}

/// What background receive is doing, as the menu bar and the nearby pane report
/// it. Every case is something the user could otherwise only find out by
/// discovering that a transfer did not arrive.
public enum NearbyReceiveState: Equatable {
    /// Not started (before launch wiring) or torn down.
    case off
    /// The user turned receiving off. Nothing is listening and nothing is
    /// reconnecting.
    case paused
    /// Joining the room: the socket is opening, or open without a `welcome`
    /// yet. Not reachable — this Mac has no peer id for anyone to offer to —
    /// and therefore not `ready`.
    case connecting
    /// In the room, listening. The default, and what "resident" means.
    case ready
    /// The socket dropped; a bounded-backoff retry is pending. Not receiving
    /// right now, and says so.
    case reconnecting
    /// A session that arrived on its own is running.
    case active(NearbyReceiveKind)
}

/// The socket an inbound attempt must be built on, and nothing else.
///
/// A peer id only means something inside the room that issued it. Reading "the
/// current room socket" at build time is therefore wrong in exactly the case
/// that matters: the socket dropped mid-setup and residency has already joined a
/// new room, where that id belongs to nobody — or, worse, to somebody else. This
/// holder is set to the socket the offer arrived on for the duration of the
/// attempt and is nil at every other moment, so a builder that reads it either
/// gets the right room or fails closed.
///
/// It exists as its own object because the session models take their builders as
/// closures at construction, before the receive model that owns the attempt
/// exists.
@MainActor
public final class InboundRoom {
    public internal(set) var signaling: SignalingClient?
    public init() {}
}

/// Answers an offer that this Mac did not ask for.
///
/// ## Why this is a separate object
///
/// `SignalingClient` has one `onSignal` slot and a live `RealtimeConnection`
/// owns it. A listener that has to hear the *next* unsolicited offer therefore
/// cannot live in that slot: it would be erased the moment a session started and
/// never come back. It lives in `addSignalListener` instead, alongside whatever
/// connection currently holds the slot.
///
/// ## What it will and will not answer
///
/// Only a real SDP offer in a generation this client implements
/// (`inboundOfferGeneration`). A resume offer, the web's `link` generation, an
/// answer, an ICE candidate, a reveal, and a text offer without exact `text/1`
/// all pass straight through. One session at a time, files and text mutually
/// exclusive with each other and with anything the local user started.
///
/// ## What it is not
///
/// The code-less room is grouped by the public IP the server observes, not by
/// the local network and not by any authenticated identity. An offer arriving
/// here means "something sharing this public address dialled us"; it does not
/// mean the sender is who its name says. Nothing in this file establishes peer
/// identity — only comparing the SAS out of band does, and that is off by
/// default (`VerificationPreference`).
@MainActor
public final class NearbyReceiveModel: ObservableObject, NearbyRoomObserver {
    @Published public private(set) var state: NearbyReceiveState = .off
    /// Non-nil while an inbound session is live. The UI reads this to select the
    /// Files or Text surface — an incoming file transfer must not be invisible
    /// because the segmented picker happened to be on Text.
    @Published public private(set) var activeKind: NearbyReceiveKind?
    /// The most recent inbound attempt that failed before a session existed.
    /// Deliberately not a peer name: names are peer-supplied labels.
    @Published public private(set) var lastFailure: String?

    private let fileModel: RealtimeSessionModel
    private let textModel: RealtimeTextSessionModel
    private let room: InboundRoom
    private let gate = InboundGate()
    private var subscription: SignalSubscription?
    private var signaling: SignalingClient?
    /// Bumped by every teardown, so a late `accept` from a socket that is gone
    /// cannot install a session on the current one.
    private var epoch = 0
    /// The kind of an attempt that has been claimed but whose model is not busy
    /// yet. Keeps the UI on the right surface across the build window.
    private var pendingKind: NearbyReceiveKind?
    private var roomState: LanDiscoveryState = .off

    /// Called when an inbound session starts, so the app layer can notify and
    /// bring the right surface forward. The model itself has no opinion about
    /// notifications — it does not import AppKit.
    public var onSessionStarted: ((NearbyReceiveKind) -> Void)?

    private var cancellables: Set<AnyCancellable> = []

    public init(fileModel: RealtimeSessionModel,
                textModel: RealtimeTextSessionModel,
                room: InboundRoom) {
        self.fileModel = fileModel
        self.textModel = textModel
        self.room = room
        // `@Published` fires on `willSet`, so the models still read their old
        // value inside the sink. Deferring one hop is what makes `refreshActivity`
        // see the settled state — and is the reason the gate's busy flag is
        // documented as advisory rather than authoritative.
        fileModel.$state
            .sink { [weak self] _ in Task { @MainActor in self?.refreshActivity() } }
            .store(in: &cancellables)
        textModel.$state
            .sink { [weak self] _ in Task { @MainActor in self?.refreshActivity() } }
            .store(in: &cancellables)
    }

    /// Follows the room's own lifecycle so the reported state cannot drift from
    /// it. Separate from `NearbyRoomObserver` because that protocol is about the
    /// socket object; this is about what the user is told.
    public func observe(_ discovery: LanDiscoveryModel) {
        discovery.$state
            .sink { [weak self] state in
                Task { @MainActor in self?.roomStateChanged(state) }
            }
            .store(in: &cancellables)
    }

    // MARK: - room lifecycle

    public func roomDidConnect(_ signaling: SignalingClient) {
        epoch += 1
        let mine = epoch
        subscription?.cancel()
        self.signaling = signaling
        // The gate keeps whatever it was holding — a live session survives a
        // roster socket being replaced, because by then the DataChannel no
        // longer needs signalling. An attempt still being *built* does not, and
        // `roomDidDisconnect` has already released it.
        // An interceptor, not a plain listener: the classifier decides which
        // frames are this router's and those must not continue to whatever
        // connection currently owns `onSignal`. Passing them on as well is two
        // concrete failures — a buffered frame delivered live *and* replayed, and
        // a new offer landing on a live `setRemoteDescription` as glare instead
        // of earning a busy reply.
        subscription = signaling.addSignalInterceptor { [weak self] from, data in
            // Runs on the socket's delivery queue, never the main actor. The
            // reservation below is taken here, synchronously, precisely because
            // hopping first would let two offers in one burst both find the gate
            // open.
            //
            // A dead router passes everything: the live connection's own frames
            // must keep flowing even if this model is gone.
            guard let self else { return .pass }
            switch self.gate.classify(from: from, data: data) {
            case .pass:
                return .pass
            case .consumedIntoBuffer, .consumedDuplicateOffer:
                return .consume
            case let .busy(generation):
                signaling.sendSignal(to: from,
                                     data: taggedSignal(busySignal(), generation: generation))
                return .consume
            case let .reserved(generation):
                Task { @MainActor [weak self] in
                    await self?.accept(peerId: from, generation: generation, epoch: mine)
                }
                return .consume
            }
        }
        refreshActivity()
    }

    public func roomDidDisconnect() {
        epoch += 1
        subscription?.cancel()
        subscription = nil
        signaling = nil
        // An attempt that has not been handed off yet cannot complete: its
        // answer and its candidates have nowhere to go. Release it so the next
        // socket is free to accept, and discard the buffer that was waiting for
        // a connection that will never be built.
        gate.releaseIfPending()
        // A builder that runs after this point must fail rather than reach for
        // whatever room we join next.
        room.signaling = nil
        pendingKind = nil
        refreshActivity()
    }

    /// Mirrors the discovery model's own lifecycle into what the user is told.
    /// Called by the app layer whenever that state changes.
    public func roomStateChanged(_ discovery: LanDiscoveryState) {
        roomState = discovery
        refreshActivity()
    }

    // MARK: - accepting

    private func accept(peerId: String, generation: RealtimeGeneration, epoch mine: Int) async {
        // The socket this offer arrived on is gone. `roomDidDisconnect` has
        // already released the reservation, so releasing again here could only
        // clobber an attempt the *new* socket has since claimed — and a busy
        // reply would be addressed to a peer id that only meant something in the
        // room we left.
        guard mine == epoch, let signaling else { return }
        // Second gate, on the actor that owns the truth. The reservation was
        // taken against a mirror of "is anything running", and that mirror is one
        // hop behind by construction: an outbound session the user started in
        // that hop is exactly what it cannot see. The web listener re-checks in
        // the same place and for the same reason.
        guard !isBusy else {
            gate.release()
            // Tell the initiator to stop waiting, in the generation it is
            // listening on: an untagged reply reaches a file initiator, a
            // `text: true` reply reaches a text one, and the wrong tag is
            // filtered out by the peer and costs it a full ICE timeout instead
            // of a clear "that device is busy".
            signaling.sendSignal(to: peerId,
                                 data: taggedSignal(busySignal(), generation: generation))
            return
        }
        let kind: NearbyReceiveKind = (generation == .text) ? .text : .file
        // A new attempt is under way, so the previous one's failure notice stops
        // being true right here. Left standing it reads as a report on the
        // session the user is now watching — and it never expires on its own,
        // so a single early failure would sit under a working listener for the
        // rest of the app's life.
        lastFailure = nil
        // Published before the connection exists so the surface the session will
        // appear on is already the one on screen — including when it fails, which
        // is a thing the user has to be able to see rather than a silent nothing.
        pendingKind = kind
        refreshActivity()
        onSessionStarted?(kind)
        // The responder is built on THIS socket or not at all.
        room.signaling = signaling
        let started: Bool
        switch kind {
        case .text:
            started = await textModel.acceptNearby(peerId: peerId) { [weak self] in
                self?.gate.handoff(to: signaling)
            }
        case .file:
            started = await fileModel.acceptNearby(peerId: peerId) { [weak self] in
                self?.gate.handoff(to: signaling)
            }
        }
        if !started, mine == epoch {
            // Every failure and cancel path lands here: the ICE fetch failed,
            // the builder threw (including the socket having gone away
            // underneath it, which is what makes an attempt fail closed rather
            // than build on a room the offer never came from), or a newer
            // session superseded this one while it was in flight. The
            // reservation must not survive any of them, or background receive is
            // dead until the app restarts.
            //
            // The epoch guard covers the *whole* of this, not just the release.
            // A stale attempt owns neither the reservation nor the screen: by
            // the time it unblocks, the room may have reconnected and a newer
            // inbound session may be running on the new socket. Publishing this
            // failure unconditionally painted "could not be set up" over a
            // transfer that was working — a message the user cannot dismiss,
            // about an attempt on a socket that no longer exists. The failure
            // that is genuinely theirs is still on the session model's own
            // state, and the room's own `reconnecting` explains the gap.
            gate.release()
            lastFailure = L10n.t(.nearbySetupFailed)
        }
        // The attempt is over either way; the connection, if there is one, holds
        // the socket itself. Leaving this set would let a *later* attempt build
        // against a room it did not come from.
        if room.signaling === signaling { room.signaling = nil }
        refreshActivity()
    }

    // MARK: - activity

    private var isBusy: Bool { fileModel.isBusy || textModel.isBusy }

    /// Re-reads the models and republishes both the gate's busy mirror and what
    /// the user is shown. Called by the app layer on every model state change,
    /// and by this model on every lifecycle edge.
    public func refreshActivity() {
        let busy = isBusy
        gate.setBusy(busy)
        if !busy {
            // A live session releases the gate by ending, not by being observed
            // — but a session that ended has to hand the gate back or nothing is
            // ever accepted again.
            gate.releaseIfLive()
            // An attempt still holding the gate is still inbound activity even
            // though no model reports busy yet; only an idle gate retires it.
            if !gate.isEngaged { pendingKind = nil }
        }

        if let kind = liveKind ?? pendingKind {
            activeKind = kind
            state = .active(kind)
            return
        }
        activeKind = nil
        switch roomState {
        case .off:
            state = .off
        case .paused:
            state = .paused
        case .reconnecting:
            state = .reconnecting
        case .connecting:
            // Reported as its own state rather than folded into `ready`.
            // Until `welcome` lands this Mac has no peer id, is not in anybody's
            // roster, and cannot be offered to — calling that "ready" is a claim
            // the app cannot back up, and it is indistinguishable on screen from
            // the case that actually matters: a room that never finishes
            // joining, where the user is told they are reachable forever.
            state = .connecting
        case .joined:
            state = .ready
        }
    }

    /// Which model is busy, if either. File wins an impossible tie only so this
    /// is total; the two are mutually exclusive by construction.
    private var liveKind: NearbyReceiveKind? {
        if fileModel.isBusy { return .file }
        if textModel.isBusy { return .text }
        return nil
    }

    public func clearFailure() { lastFailure = nil }
}

// MARK: - the gate

/// The synchronous half of inbound admission, and the only part of this feature
/// that runs off the main actor.
///
/// It exists because the decision "answer this offer" has to be made in the same
/// instant the offer is seen. Two offers arriving in one burst are delivered
/// back-to-back on the socket's queue; a gate that hopped to the main actor
/// before deciding would let both through and build two sessions on one
/// connection slot.
///
/// It also owns the buffer. From the instant an offer is reserved until the
/// connection that answers it exists, every further signal from that peer in
/// that generation is queued in arrival order — the ICE that follows an offer
/// across a LAN routinely beats an `/api/ice` round trip, and a dropped
/// candidate is a session that connects slowly or not at all.
final class InboundGate: @unchecked Sendable {
    /// Every case says what the caller must do with the frame *and* whether the
    /// frame may continue to the per-connection slot. The two used to be one
    /// `ignored` case covering both "not mine, let it through" and "mine, I have
    /// buffered it" — which meant a buffered frame was delivered to the live
    /// connection as well as replayed into it.
    enum Decision: Equatable {
        /// Not this router's business: an answer, a candidate or a reveal that
        /// belongs to whatever connection currently owns the slot. It must keep
        /// going, or the live session loses it.
        case pass
        /// Taken into the reserved attempt's buffer. `handoff` will replay it,
        /// so it must NOT also travel on to the slot.
        case consumedIntoBuffer
        /// A second offer from the peer we are already setting up. Dropped
        /// outright — not buffered, not answered. See `classify`.
        case consumedDuplicateOffer
        /// Tell the peer we cannot take it, in this generation — and stop it
        /// here. A new offer reaching a live connection is glare.
        case busy(RealtimeGeneration)
        /// Reserved; the caller must now build the responder. Stops here too:
        /// the buffer already holds this frame for the replay.
        case reserved(RealtimeGeneration)
    }

    private enum Phase {
        case idle
        /// An offer has been claimed and the responder is being built.
        case reserved(peer: String, generation: RealtimeGeneration, buffer: [(String, JSONValue)])
        /// The buffer has been replayed; the connection owns its own signals now.
        case live
    }

    /// The same cap, and the same reasoning, as `PendingSignals.capacity`:
    /// anything that can reach this room can push frames at us for the whole
    /// build window, and the signals worth keeping are the earliest ones.
    static let bufferCapacity = 256

    private let lock = NSLock()
    private var phase: Phase = .idle
    private var busy = false

    /// Mirrors "a session is running" from the main actor. Advisory: the
    /// authoritative re-check happens there, because this value is by
    /// construction one hop old.
    func setBusy(_ value: Bool) {
        lock.lock()
        busy = value
        lock.unlock()
    }

    func classify(from: String, data: JSONValue) -> Decision {
        lock.lock()

        // Buffering wins over everything. While an attempt is being built, that
        // peer's signals in that generation belong to it: the ICE that chases
        // the offer, and the reveal, all replayed in wire order.
        if case let .reserved(peer, generation, buffer) = phase,
           from == peer, signalGeneration(data) == generation {
            // …with one exception. A SECOND offer is not part of this session.
            // The reservation seeded the buffer with the first one, so buffering
            // another means `handoff` replays two offers into one responder and
            // drives `setRemoteDescription` twice on a connection still in
            // setup — the exact-once invariant this whole window exists to
            // protect. Dropped rather than answered busy: a busy reply here goes
            // to the peer whose legitimate first offer we are in the middle of
            // accepting, and would tell it to abort the attempt that is about to
            // succeed.
            if parseSDP(data)?.type == "offer" {
                lock.unlock()
                return .consumedDuplicateOffer
            }
            var next = buffer
            // Drop on overflow rather than evicting: the offer and the first
            // candidates are the ones that matter, and a flood behind them is
            // exactly what must not push them out.
            if next.count < Self.bufferCapacity { next.append((from, data)) }
            phase = .reserved(peer: peer, generation: generation, buffer: next)
            lock.unlock()
            return .consumedIntoBuffer
        }

        guard let offered = inboundOfferGeneration(data) else {
            // An answer, a candidate, a reveal, a resume or a link offer. None
            // of them opens a session here; a live connection reads its own off
            // `onSignal` directly.
            lock.unlock()
            return .pass
        }

        let engaged: Bool
        switch phase {
        case .idle: engaged = false
        case .reserved, .live: engaged = true
        }
        guard !engaged, !busy else {
            lock.unlock()
            return .busy(offered)
        }

        phase = .reserved(peer: from, generation: offered, buffer: [(from, data)])
        lock.unlock()
        return .reserved(offered)
    }

    /// Replays the buffered signals into the connection and goes live.
    ///
    /// The replay runs *inside* the lock on purpose. A signal delivered
    /// concurrently blocks in `classify` until this finishes and then sees
    /// `.live`, so it cannot be appended to a buffer that has already been
    /// drained — and because `SignalingClient` runs listeners before the
    /// per-connection slot, that same frame reaches the connection only after
    /// the replayed ones. Ordering is preserved without a second queue.
    ///
    /// Calling out under a lock is safe here and only here: the handler being
    /// invoked is `RealtimeConnection`'s, which filters and hops to its own
    /// serial queue. It does not re-enter this gate.
    func handoff(to signaling: SignalingClient) {
        lock.lock()
        guard case let .reserved(_, _, buffer) = phase else {
            lock.unlock()
            return
        }
        phase = .live
        let deliver = signaling.onSignal
        for (from, data) in buffer { deliver?(from, data) }
        lock.unlock()
    }

    /// Unconditional: the attempt is over, however it ended.
    func release() {
        lock.lock()
        phase = .idle
        lock.unlock()
    }

    /// Release only an attempt that never got its connection. A live session
    /// keeps the gate — it is the thing making us busy.
    func releaseIfPending() {
        lock.lock()
        if case .reserved = phase { phase = .idle }
        lock.unlock()
    }

    /// Release only a handed-off session. Called once the models report nothing
    /// running, so the next offer is accepted rather than told we are busy
    /// forever.
    func releaseIfLive() {
        lock.lock()
        if case .live = phase { phase = .idle }
        lock.unlock()
    }

    /// Test seam: what the gate is holding.
    var isEngaged: Bool {
        lock.lock(); defer { lock.unlock() }
        switch phase {
        case .idle: return false
        case .reserved, .live: return true
        }
    }
}
