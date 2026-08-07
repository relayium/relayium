import Foundation
import RelayiumKit

/// The room's inbound `link/1` router: it interprets every signal one socket
/// delivers, claims the room for the one establishment that wins, and hands that
/// establishment to `LinkRoomSession` on the main actor without losing a frame
/// on the way.
///
/// ## What it is for
///
/// Everything under this line already exists and is complete.
/// `LinkAdmission` ANSWERS — it says establish, busy, leave, resume, ignore —
/// and its atomic claim takes the room. `LinkEstablishmentSignalBuffer` holds
/// what chases a consumed offer. `LinkRoomSession` announces one establishment,
/// assembles it and releases the room when nobody else will. What none of them
/// can do is the one thing that has to happen in a single instant on the
/// signalling delivery queue: decide, claim, and start holding — before the next
/// frame in the same burst is read.
///
/// That instant is this object, and it is deliberately nothing else.
///
/// ## The order, and why it is the order
///
/// One inbound frame, top to bottom:
///
/// 1. **Exact capability.** `PeerCapabilityRegistry.supports` with
///    `LINK_CAPABILITY`, which also carries the ROOM scope — so a relay that
///    forges a roster hello cannot make this router consume anything where link
///    mode is not allowed, and while the build flag is false it consumes nothing
///    anywhere. A peer that has not announced it exactly is passed through whole.
/// 2. **`LinkAdmission.route`, with NO lock of this object's held.** The
///    predicate `route` consults is owner code that may read the room back;
///    holding a lock across it is how the signalling queue deadlocks. It is also
///    what makes the eight-verification leave budget real: every departure is
///    routed before anything is forwarded, so a flood buys eight HMACs and not
///    one per message.
/// 3. **The claim and the buffer, indivisibly.** `admitEstablishment` runs under
///    this object's lock, and the buffer for the peer it admitted is installed in
///    the SAME critical section. `admitEstablishment` takes no callback and calls
///    nothing out, so it cannot re-enter — which is exactly why it, and only it,
///    may be called with the lock held. Without that indivisibility a candidate
///    arriving between the claim and the installation reaches a connection slot
///    the transport has not taken yet and is simply gone, and on a same-network
///    link those are the candidates that matter.
/// 4. **Then the hop, with the lock released.** `beginAdmitted` — never `begin`,
///    because the claim already made that announcement and remaking it would
///    clear the timed-out mark the claim just consumed — followed by exactly one
///    `drain`. One drain, because the buffer has exactly one owner and a second
///    would let a frame arriving mid-replay overtake the batch being handed over.
///
/// Everything the main actor does is queued HERE, in one order, and consumed by
/// one drain. `Task { @MainActor in … }` does not order two tasks against each
/// other, so a per-frame task would reorder the very candidates step 3 exists to
/// keep in order; `LinkSessionEventBridge` solves the identical problem the
/// identical way.
///
/// ## What it consumes, and what it must not
///
/// A frame is taken away from the socket's single per-connection slot only when
/// this establishment has taken responsibility for it — a captured or replayable
/// frame — or when it is a control this object acted on: an admitted offer, a
/// busy this side answered, a duplicate it dropped, a departure or rebuild offer
/// it forwarded. Everything else passes, and two of those are load-bearing:
///
///  - **a `busy` arriving while this side is connecting** is the peer refusing
///    the link being built. Admission ignores it, because it only cancels an
///    outstanding request; the establishing transport is what turns it into a
///    truthful failure instead of a deadline, and it reads the slot.
///  - **every legacy generation** — file, text, and the one-shot file resume —
///    belongs to connections that ship today. Swallowing one breaks a shipped
///    feature.
///
/// ## The socket epoch
///
/// A peer id only means something inside the room that issued it, so a new
/// socket is a new world. Replacing the epoch cancels the interceptor, retires
/// the buffer, and disposes of the establishment consistently: one that never
/// reached `beginAdmitted` is the router's own claim and is released here, and
/// one that did belongs to `LinkRoomSession`, which is asked to end it. That ask
/// is queued under the same lock acquisition that bumps the epoch, so it can
/// never be overtaken by a later epoch's handoff — and a handoff whose epoch has
/// gone assembles nothing at all, so stale main-actor work can neither build a
/// link nobody routes to nor release an admission the next epoch has claimed.
///
/// ## What this cut deliberately does NOT contain
///
/// Named rather than half-built, because each is its own contract:
///
///  - **The outbound request lifecycle.** Nothing here asks a smaller-id peer to
///    offer, times that ask out, or retries it. A bounded retry that matches the
///    Web client's — rather than one where a single lost request consumes two
///    attempts — is a separate decision, and `LinkAdmission.admitRequest`,
///    `didBeginRequesting` and `didRequestTimeOut` are its verbs, not this
///    object's. `requestRefused` is therefore routed and consumed, and the local
///    reaction to it belongs with the ask that earned it.
///  - **Roster entry points.** No peer list reaches this object, so a peer that
///    disappears from the room cancels nothing. Distinguishing a requested peer
///    that vanished from a server-confirmed departure of the bound peer needs the
///    roster, and giving this object half of it would produce a router that
///    cancels the wrong establishment.
///  - **The outbound authenticated leave.** This side never announces its own
///    departure. Signing one needs the link's resume key, which must not travel
///    through an intermediate layer; the coordinator that already holds it is
///    where that belongs.
///
/// ## What it is not
///
/// Unreachable from production. It is INTERNAL to `RelayiumAppKit`, nothing
/// outside the tests constructs one, no `AppEnvironment`, view, iOS or macOS
/// target names it, and `LINK_BUILD_SUPPORT` and
/// `LINK_TRANSPORT_REPLACEMENT_SUPPORTED` are both still false — so the
/// capability predicate in step 1 answers false for every peer in every room,
/// and a router that were somehow attached would pass every frame through
/// untouched.
final class LinkRoomRouter: @unchecked Sendable {

    /// One thing for the main actor to do, in the order this object decided it.
    private enum Work {
        /// Announce nothing, assemble the claimed establishment, drain once.
        case handoff(token: Int, peerId: String, role: Role, initialSignal: JSONValue)
        case receive(token: Int, from: String, signal: JSONValue)
        case resumeOffer(token: Int, from: String, signal: JSONValue)
        case leave(token: Int, from: String, to: String, auth: String)
        /// End whatever the room session holds.
        ///
        /// Deliberately carries NO token. It is queued in the same critical
        /// section that gives up the establishment it belongs to, and the queue
        /// is a total order, so by the time it runs the session still holds that
        /// establishment or nothing — never a later one.
        case endSession
    }

    /// One admitted establishment, as this object holds it.
    private struct Establishment {
        /// Monotonic and never reused, so a queued item can be told apart from
        /// the establishment that replaced it.
        let token: Int
        let epoch: Int
        let peerId: String
        let buffer: LinkEstablishmentSignalBuffer
        /// Whether the handoff has reached the point of calling `beginAdmitted`.
        ///
        /// Set in the critical section IMMEDIATELY before that call rather than
        /// after it, and that ordering is the whole point: a teardown racing the
        /// handoff must never have to guess whether a link was assembled. Before
        /// the flag, the claim is this object's to release; from the flag
        /// onwards, the room session owns it.
        var assembling: Bool
    }

    private let admission: LinkAdmission
    private let capabilities: PeerCapabilityRegistry
    private let session: LinkRoomSession

    private let lock = NSLock()
    /// The socket this router is listening to, and its epoch.
    private var signaling: SignalingClient?
    private var subscription: SignalSubscription?
    private var epoch = 0
    private var live: Establishment?
    private var nextToken = 0
    private var pending: [Work] = []
    /// Whether a drain owner is running. Cleared only in the critical section
    /// that observed the queue empty, so a wakeup cannot be lost.
    private var draining = false

    /// - Parameters:
    ///   - admission: the room's one-link state, the SAME object the session and
    ///     every assembled link are given. Two would let this object claim a room
    ///     the link's own open and close never reach.
    ///   - capabilities: the room's announcements, read at call time so joining
    ///     or leaving a pairing-code room takes effect on the next decision.
    ///   - session: the one owner of the one establishment this router hands off.
    init(admission: LinkAdmission,
         capabilities: PeerCapabilityRegistry,
         session: LinkRoomSession) {
        self.admission = admission
        self.capabilities = capabilities
        self.session = session
    }

    // MARK: - the socket epoch

    /// Listen to this socket, and stop listening to whatever came before it.
    func attach(to client: SignalingClient) {
        let mine = replaceEpoch(with: client)
        // Installed LAST, after the previous epoch's claim has been released, so
        // a frame on the new socket cannot be routed into a room the old epoch
        // still holds.
        let installed = client.addSignalInterceptor { [weak self] from, data in
            self?.intercept(from: from, signal: data, epoch: mine) ?? .pass
        }

        lock.lock()
        let stale = epoch != mine
        if !stale { subscription = installed }
        lock.unlock()

        if stale { installed.cancel() }
    }

    /// The socket is gone. Everything the epoch owned is given up, and nothing
    /// is routed until the next `attach`.
    func detach() {
        _ = replaceEpoch(with: nil)
    }

    /// End the current epoch and begin the next one. Answers the new epoch.
    private func replaceEpoch(with client: SignalingClient?) -> Int {
        lock.lock()
        epoch += 1
        let mine = epoch
        let retired = subscription
        subscription = nil
        signaling = client
        let held = live
        live = nil
        // Queued HERE, under the same acquisition that bumped the epoch, so no
        // later handoff can be ordered in front of it.
        let wake = (held?.assembling == true) ? enqueueLocked(.endSession) : false
        lock.unlock()

        retired?.cancel()
        if let held { relinquish(held) }
        if wake { wakeDrain() }
        return mine
    }

    // MARK: - one inbound frame

    private func intercept(from: String, signal: JSONValue, epoch: Int) -> SignalDisposition {
        // The socket that delivered this may already have been replaced; a frame
        // still in flight on it is not this room's.
        guard isCurrent(epoch) else { return .pass }
        // Exact, and room-scoped. Everything below this line is link mode.
        guard capabilities.supports(from, LINK_CAPABILITY) else { return .pass }

        // Deliberately with nothing of this object's held: `route` consults
        // owner-supplied predicates that may read the room back.
        switch admission.route(from: from, signal: signal) {
        case let .establish(role):
            return admit(peerId: from, role: role, initialSignal: signal, epoch: epoch)

        case .busy:
            answerBusy(to: from, epoch: epoch)
            return .consume

        case .alreadyInFlight:
            // A duplicate — a replayed offer, or a peer that sent twice. The
            // establishment already has the SDP it was built from, so this frame
            // is dropped whole rather than held: buffering it would spend a slot
            // of the bound on a frame the transport refuses, and then replay it
            // behind the candidates that chase the first one.
            return .consume

        case .requestRefused:
            // Admission has already failed the room. Reacting further belongs
            // with the ask that earned the refusal, which this cut does not make.
            return .consume

        case .resumeOffer:
            return forward(.resumeOffer(token: 0, from: from, signal: signal), epoch: epoch)

        case let .leave(auth):
            // The envelope's local recipient id is part of the bytes the tag
            // covers, so it travels unchanged — and a missing one is not
            // substitutable. Verifying against the wrong `to` is what would let a
            // relay reflect a departure back at its sender.
            guard let to = client(for: epoch)?.selfId, !to.isEmpty else { return .consume }
            return forward(.leave(token: 0, from: from, to: to, auth: auth), epoch: epoch)

        case .ignore:
            return offerToEstablishment(from: from, signal: signal, epoch: epoch)
        }
    }

    // MARK: - claiming the room

    /// The indivisible half of the decision: claim, then hold, then queue the
    /// handoff — all in one critical section.
    private func admit(peerId: String,
                       role: Role,
                       initialSignal: JSONValue,
                       epoch: Int) -> SignalDisposition {
        lock.lock()
        guard self.epoch == epoch else { lock.unlock(); return .pass }

        // A claim we have already made for this peer and have NOT handed over:
        // two frames of one burst were both read against an idle room. Redoing
        // it would throw away the buffer that is already holding this peer's
        // chase, and refusing the peer would refuse the link this side is
        // building for it.
        if let held = live, held.peerId == peerId, !held.assembling {
            lock.unlock()
            return .consume
        }

        // The only call to admission made under this lock, and the only one that
        // may be: it takes no callback and calls nothing out.
        guard admission.admitEstablishment(peerId: peerId, role: role) else {
            lock.unlock()
            // The room went to somebody else between the answer and the claim,
            // which is exactly when this peer is owed a truthful refusal.
            answerBusy(to: peerId, epoch: epoch)
            return .consume
        }

        // Anything still held is superseded by the claim just made. `route`
        // answers `establish` only for a room that is free, and a room is free
        // only once the establishment holding it has ended — so a handed-over
        // establishment still recorded here has already released itself through
        // the room session, and this object is simply the last to hear.
        //
        // It is asked to end all the same, and that ask is queued in this same
        // critical section so it can never be ordered behind the handoff below:
        // for an establishment that really is over the end is inert, and for the
        // one shape that is not — a duplicate claim racing its own handoff — it
        // is what stops the session from holding two.
        let superseded = live
        nextToken += 1
        let token = nextToken
        live = Establishment(token: token,
                             epoch: epoch,
                             peerId: peerId,
                             buffer: LinkEstablishmentSignalBuffer(peerId: peerId),
                             assembling: false)
        var wake = superseded?.assembling == true ? enqueueLocked(.endSession) : false
        wake = enqueueLocked(.handoff(token: token, peerId: peerId,
                                      role: role, initialSignal: initialSignal)) || wake
        lock.unlock()

        // Retired, never relinquished: the room now belongs to the claim above,
        // and releasing it here would free a room that is taken.
        superseded?.buffer.retire()
        if wake { wakeDrain() }
        return .consume
    }

    // MARK: - the frames that chase a consumed offer

    private func offerToEstablishment(from: String,
                                      signal: JSONValue,
                                      epoch: Int) -> SignalDisposition {
        lock.lock()
        guard self.epoch == epoch, let held = live else { lock.unlock(); return .pass }
        let buffer = held.buffer
        let token = held.token
        lock.unlock()

        switch buffer.accept(from: from, signal: signal) {
        case .rejected:
            // Nothing here claimed it: another peer's frame, another generation,
            // or admission's own vocabulary. It belongs to whoever the socket
            // would have given it to.
            return .pass

        case .captured:
            return .consume

        case .ready:
            // The assembly exists and nothing is queued ahead of this, but it
            // still travels the queue rather than the socket's slot: the slot is
            // last-writer-wins, and the buffer's contract is that a frame this
            // establishment took responsibility for reaches it and nothing else.
            return forward(.receive(token: 0, from: from, signal: signal), epoch: epoch)

        case .overflowed:
            // Terminal, and never a silent truncation. This establishment is
            // failed closed and the room it took is freed here — on the socket
            // queue, so the next peer's offer is admitted rather than refused on
            // behalf of a link that will never exist.
            failEstablishment(token: token)
            return .consume
        }
    }

    /// Queue one forward for the establishment this router currently holds.
    ///
    /// The token on the supplied work is a placeholder: it is stamped here, under
    /// the lock, with the establishment that is live at this instant, so a
    /// forward queued for one establishment is DROPPED rather than delivered if a
    /// later one has taken the room by the time the drain reaches it.
    ///
    /// That stamp covers everything after it and nothing before it, so the gap
    /// between deciding a frame and stamping it is worth naming: `route` decided
    /// a leave or a rebuild offer, and the buffer answered `ready` for a chased
    /// candidate, before this call. Nothing can install a different establishment
    /// in that gap. `admit` is the only writer that installs one, every inbound
    /// frame — including this one — reaches it on the socket's single delivery
    /// queue, and `URLSessionWebSocketChannel` re-arms its read only after the
    /// current frame has been routed. The other two writers of `live`,
    /// `replaceEpoch` and `failEstablishment`, only ever CLEAR it, and a cleared
    /// or re-epoched `live` is answered `.pass` on the line below. Serial
    /// delivery is the same assumption the claim in step 3 already rests on, and
    /// it is named here because this is the other place it is load bearing.
    private func forward(_ work: Work, epoch: Int) -> SignalDisposition {
        lock.lock()
        guard self.epoch == epoch, let held = live else { lock.unlock(); return .pass }
        let stamped: Work
        switch work {
        case let .receive(_, from, signal):
            stamped = .receive(token: held.token, from: from, signal: signal)
        case let .resumeOffer(_, from, signal):
            stamped = .resumeOffer(token: held.token, from: from, signal: signal)
        case let .leave(_, from, to, auth):
            stamped = .leave(token: held.token, from: from, to: to, auth: auth)
        case .handoff, .endSession:
            lock.unlock()
            return .pass
        }
        let wake = enqueueLocked(stamped)
        lock.unlock()

        if wake { wakeDrain() }
        return .consume
    }

    // MARK: - giving an establishment up

    /// Fail the held establishment, from any thread, and make sure exactly one
    /// thing releases the room.
    private func failEstablishment(token: Int) {
        lock.lock()
        guard let held = live, held.token == token else { lock.unlock(); return }
        live = nil
        let wake = held.assembling ? enqueueLocked(.endSession) : false
        lock.unlock()

        relinquish(held)
        if wake { wakeDrain() }
    }

    /// Give one establishment up for good, and release the room if nothing else
    /// will.
    ///
    /// The ONE release this layer owns. Every caller queues `.endSession` for an
    /// establishment that reached `beginAdmitted`, and the room session releases
    /// the room from there — through the coordinator for a link that published,
    /// and directly for one that did not. Anything earlier than `beginAdmitted`
    /// is a claim nothing else in the system has ever been told about, so this is
    /// the only thing that can free it.
    private func relinquish(_ held: Establishment) {
        held.buffer.retire()
        guard !held.assembling else { return }
        admission.didClose()
    }

    // MARK: - the one main-actor consumer

    /// Append, and answer whether this caller owes a wakeup. Callers hold `lock`.
    private func enqueueLocked(_ work: Work) -> Bool {
        pending.append(work)
        guard !draining else { return false }
        draining = true
        return true
    }

    private func wakeDrain() {
        // Outside the lock, always: a task construction under it would put an
        // executor hop inside this object's critical section.
        Task { @MainActor [weak self] in self?.drain() }
    }

    /// Takes one item at a time, with `lock` released across every call out, and
    /// exits only while holding the lock in the same critical section that
    /// observed the queue empty.
    @MainActor
    private func drain() {
        while true {
            lock.lock()
            guard !pending.isEmpty else {
                draining = false
                lock.unlock()
                return
            }
            let work = pending.removeFirst()
            let current = live?.token
            lock.unlock()

            switch work {
            case let .handoff(token, peerId, role, initialSignal):
                guard token == current else { continue }
                handOff(token: token, peerId: peerId, role: role, initialSignal: initialSignal)

            case let .receive(token, from, signal):
                guard token == current else { continue }
                session.receive(from: from, signal: signal)

            case let .resumeOffer(token, from, signal):
                guard token == current else { continue }
                session.receiveResumeOffer(from: from, signal: signal)

            case let .leave(token, from, to, auth):
                guard token == current else { continue }
                session.receiveLeave(from: from, to: to, auth: auth)

            case .endSession:
                session.end()
            }
        }
    }

    /// Assemble the claimed establishment and replay everything held for it.
    @MainActor
    private func handOff(token: Int,
                         peerId: String,
                         role: Role,
                         initialSignal: JSONValue) {
        lock.lock()
        guard var held = live, held.token == token else { lock.unlock(); return }
        held.assembling = true
        live = held
        lock.unlock()

        // `beginAdmitted`, never `begin`: the claim above already moved the room
        // to connecting for this peer in the same critical section as the test
        // that authorised it, and re-announcing would clear the timed-out mark
        // that claim consumed.
        guard session.beginAdmitted(peerId: peerId, role: role, initialSignal: initialSignal) else {
            // The session already holds an establishment, which means this
            // router and admission have disagreed. Give the claim up rather than
            // leave the room connecting to a link that was never built.
            failEstablishment(token: token)
            return
        }

        // Exactly one drain, and this is it.
        let complete = held.buffer.drain { from, signal in
            session.receive(from: from, signal: signal)
        }
        // False means the bound was exceeded part-way through the replay: what a
        // doomed transport already applied cannot matter, and the establishment
        // is failed closed.
        if !complete { failEstablishment(token: token) }
    }

    // MARK: - reaching the socket

    private func isCurrent(_ epoch: Int) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return self.epoch == epoch
    }

    private func client(for epoch: Int) -> SignalingClient? {
        lock.lock(); defer { lock.unlock() }
        return self.epoch == epoch ? signaling : nil
    }

    /// Tell one peer the room is taken, on the link generation so it reaches that
    /// peer's link lifecycle rather than a legacy file initiator.
    private func answerBusy(to peerId: String, epoch: Int) {
        client(for: epoch)?.sendSignal(to: peerId, data: linkBusySignal())
    }
}
