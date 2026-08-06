import Foundation
import RelayiumKit

/// The owner of ONE room's ONE `link/1` establishment: it announces the
/// establishment to `LinkAdmission`, holds the single assembly that results, and
/// releases the room when that attempt ends without ever having published.
///
/// ## What it is for
///
/// Every layer below this one is complete, and each drives exactly the admission
/// transition it is the only layer able to know:
///
///  - `LinkSessionRuntime` claims `didOpen`, because it is the first thing that
///    knows one authenticated identity published with both lanes bound under it;
///  - `LinkRecoveryCoordinator` drives every transition AFTER that — interrupt,
///    replace, close, fail — because it owns the gap and the terminal reason.
///
/// What nothing owned is the establishment itself. Between `didBeginEstablishing`
/// and a publication that may never come there is no coordinator, so an
/// establishment that fails, is closed by the peer, or is stopped locally left
/// `LinkAdmission` stuck at `.connecting` — a room that answers every later peer
/// `busy` on behalf of a link that does not exist and never will, for the rest of
/// the session. `LinkSessionRuntimeTests` names that gap explicitly. This is the
/// thing that closes it, and it is deliberately nothing else.
///
/// ## The invariants it exists to make structural
///
/// **1. One establishment, one assembly, one owner.** `begin` refuses while an
/// establishment is held, so this object cannot come to hold two attempts, two
/// controls or two peers. The one-link rule itself is `LinkAdmission`'s and is
/// decided before anything reaches here — this is the object that makes the
/// decision's CONSEQUENCE single, not a second copy of the rule.
///
/// **2. It announces the establishment and nothing else about admission's
/// future.** `begin` calls `didBeginEstablishing`, which is the one transition
/// that belongs to whoever decided this link should exist. It never calls
/// `didOpen` — that is the runtime's, and duplicating it would refill the peer's
/// leave budget on a link that did not just authenticate — and it never calls
/// `didInterrupt`, `didReplaceTransport`, `didBeginReplacingTransport` or
/// `didEndReplacingTransport`, all of which belong to the coordinator's gap.
///
/// **3. It releases the room only when nobody else will.** A terminal event that
/// followed a publication has already moved admission through the coordinator, so
/// this object does nothing at all. A terminal event with no publication behind it
/// has moved nothing, so this object makes exactly one transition. Which one is
/// the honest reading of the reason, and it matches what the coordinator would
/// have chosen for the same shape of ending: a failure leaves a failed link, a
/// clean close or a local stop leaves the room free.
///
/// **4. A superseded callback changes nothing.** Every lifecycle callback carries
/// the generation of the establishment it belongs to and is dropped unless that
/// establishment is still the one held. Retiring an attempt silences its bridge,
/// so the ordinary path produces no late callback at all; the generation is what
/// covers the paths that are not ordinary — a handler that begins the next
/// establishment re-entrantly, and any second terminal report that reaches the
/// attempt's own once-guard from an unexpected direction.
///
/// **5. It resolves no ingredient.** No ICE server, no transport policy, no
/// receive directory, no deadline, no signalling client and no feature flag: the
/// caller supplies `assemble`, and everything that composition needs is already
/// resolved by the time it is called. That is the same split `LinkSessionFactory`
/// makes one layer down, for the same reason — a room that resolved a directory
/// or picked a policy would be a second place those decisions are made.
///
/// ## What it deliberately does NOT do yet
///
/// **It routes nothing.** Nothing here reads a signal, calls `LinkAdmission.route`
/// or `ensure`, answers `busy`, sends a request, times one out, or subscribes to a
/// socket. `begin` is called by something that has ALREADY decided — that decision,
/// its request/timeout lifecycle and the socket epoch it belongs to are the next
/// slice, and this object is shaped to be driven by it rather than to contain it.
///
/// **A departure during establishment ends nothing.** `peerDeparted` below
/// forwards to the link, which ignores it until there is a coordinator to hear it.
/// Cancelling an establishment because its peer left the roster is a routing
/// decision — it needs the roster, which this object does not have — so it is
/// named here rather than half-made.
///
/// ## What it is not
///
/// Unreachable from production. It is INTERNAL to `RelayiumAppKit`, nothing
/// outside the tests constructs one, no `AppEnvironment`, view, iOS or macOS
/// target names it, and `LINK_BUILD_SUPPORT` and
/// `LINK_TRANSPORT_REPLACEMENT_SUPPORTED` are both still false. Owning a lifecycle
/// is not the same as being reachable, and this slice is deliberately only the
/// first.
@MainActor
final class LinkRoomSession {

    /// Turns one admitted decision into one assembled link.
    ///
    /// A seam rather than a direct call to `LinkSessionFactory`, and that is
    /// invariant 5: the socket, the ICE configuration, the transport policy, the
    /// receive directory and the deadlines belong to the application that
    /// resolved them, and threading them through this object would make it the
    /// second place they are chosen. Its caller closes over them and this object
    /// never sees one.
    ///
    /// - Parameters:
    ///   - peerId: the peer admission admitted.
    ///   - role: the deterministic role admission decided.
    ///   - initialSignal: the one signal the router already consumed on this
    ///     link's behalf, or nil.
    typealias Assemble = (_ peerId: String,
                          _ role: Role,
                          _ initialSignal: JSONValue?) -> LinkSessionAssembly

    /// One establishment, as this object holds it.
    private struct Establishment {
        /// Which establishment this is — see invariant 4.
        let generation: Int
        let peerId: String
        let assembly: LinkSessionAssembly
        /// Whether an authenticated link ever published on it. The whole terminal
        /// decision turns on this: it is what says whether the coordinator exists
        /// and has therefore already released the room.
        var published: Bool
    }

    private let admission: LinkAdmission
    private let assemble: Assemble
    private var current: Establishment?
    /// Monotonic, never reused, and bumped only when an establishment begins.
    private var generation = 0

    /// - Parameters:
    ///   - admission: the room's one-link state, the SAME object the assembled
    ///     link is given. Two would let this object announce an establishment
    ///     that the link's own open, interrupt and close never reach.
    ///   - assemble: see `Assemble`.
    init(admission: LinkAdmission, assemble: @escaping Assemble) {
        self.admission = admission
        self.assemble = assemble
    }

    // MARK: - what an owner above may read
    //
    // Snapshots, and only ever that. Nothing below acts on one.

    /// The peer whose establishment is held, or nil.
    var peerId: String? { current?.peerId }

    /// Whether an authenticated link has published on the held establishment.
    var isPublished: Bool { current?.published ?? false }

    /// The screen's owner for the held establishment, for a UI layer that does
    /// not exist yet. Read-only: retirement is `end()`, because an attempt
    /// retired behind this object's back would leave it holding a dead link and
    /// admission holding a room nobody will release.
    var attempt: LinkSessionAttempt? { current?.assembly.attempt }

    // MARK: - the establishment

    /// Announce and assemble ONE establishment.
    ///
    /// Answers false — and does nothing whatsoever — while one is already held.
    /// That refusal is not the one-link rule: `LinkAdmission` decided that before
    /// this call, and a second establishment reaching here at all would mean the
    /// router had already gone wrong. It is the backstop that keeps the mistake
    /// from becoming two live attempts, two controls and an admission announcing
    /// the second peer while the first link is still open.
    ///
    /// The order inside is fixed. Admission is moved FIRST, so that from the
    /// instant anything can be assembled the room already says `.connecting` for
    /// this peer: the assembly starts a transport, and a transport can publish —
    /// and therefore claim `didOpen` — before this function returns. Announcing
    /// afterwards would overwrite that open with a connecting.
    @discardableResult
    func begin(peerId: String, role: Role, initialSignal: JSONValue? = nil) -> Bool {
        begin(peerId: peerId, role: role, initialSignal: initialSignal, alreadyAdmitted: false)
    }

    /// Begin an establishment the caller has ALREADY claimed the room for.
    ///
    /// `LinkAdmission.admitEstablishment` moves the phase to `.connecting` in the
    /// same critical section as the test that authorised it, which is the only
    /// way a router acting on `route`'s answer can be safe against two offers in
    /// one socket burst. A caller that used it has therefore already made the one
    /// announcement this object would otherwise make, and making it a second time
    /// would re-enter `didBeginEstablishing` — clearing the timed-out mark the
    /// reservation just consumed and re-announcing a phase that is already true.
    ///
    /// Everything else is identical, including the refusal when an establishment
    /// is already held: a caller that reserved the room and then finds this
    /// object busy has a router bug, and the backstop is the same one.
    @discardableResult
    func beginAdmitted(peerId: String, role: Role, initialSignal: JSONValue? = nil) -> Bool {
        begin(peerId: peerId, role: role, initialSignal: initialSignal, alreadyAdmitted: true)
    }

    private func begin(peerId: String,
                       role: Role,
                       initialSignal: JSONValue?,
                       alreadyAdmitted: Bool) -> Bool {
        guard current == nil else { return false }
        generation += 1
        let mine = generation

        if !alreadyAdmitted { admission.didBeginEstablishing(peerId: peerId, role: role) }
        let assembly = assemble(peerId, role, initialSignal)
        current = Establishment(generation: mine, peerId: peerId,
                                assembly: assembly, published: false)

        // Installed after the assembly and before returning to the runloop, which
        // is soon enough by the bridge's own contract: it never delivers inline,
        // so everything the runtime published while `assemble` ran is waiting for
        // the next main-actor turn. Weak, because this object owns the attempt
        // and an attempt that owned it back would be a cycle neither can break.
        assembly.attempt.onLifecycle = { [weak self] event in
            self?.attemptReported(event, generation: mine)
        }
        return true
    }

    /// End the held establishment: retire the attempt, then release the room if
    /// nothing else is going to.
    ///
    /// Idempotent, and the only way this object gives up an establishment other
    /// than the link ending on its own.
    ///
    /// **Retiring is what makes the second half necessary.** `retire()` silences
    /// the attempt's bridge before it stops the runtime, so the `ended` this
    /// teardown produces is never delivered and `attemptReported` will not run —
    /// deliberately, because a retired attempt has nothing left to say to anybody.
    /// The room still has to be released, so it is released here, on the same
    /// rule: a published link has already gone through the coordinator's
    /// `didClose` inside that same `retire()`, and an unpublished one has gone
    /// through nothing at all.
    func end() {
        guard let session = current else { return }
        current = nil

        session.assembly.attempt.retire()

        // The published case is the coordinator's: `retire()` reached
        // `LinkSessionRuntime.stop()`, which ended the held link through
        // `LinkRecoveryCoordinator.stop()`, which released the room. A second
        // release here would be this object making a transition it does not own.
        guard !session.published else { return }
        // Nothing else exists to do it. A deliberate local end leaves the room
        // FREE rather than failed, which is the same reading the coordinator
        // gives its own `.cancelled`.
        admission.didClose()
    }

    // MARK: - the room's seam onto the held link
    //
    // Two pass-throughs, and no third decision. Each exists so a router can reach
    // the link without being handed the attempt, the runtime or the coordinator —
    // see `LinkSessionRoomControl`, which is where they stop being this object's.
    // Neither verifies, answers, compares a peer or moves a phase: those already
    // live in the layer that owns them, and a copy here would be a second policy
    // that can silently diverge from the authoritative one.

    /// Hand the held link an inbound `resume` offer. Inert with no link held, and
    /// inert inside the link until it has a coordinator to verify against.
    func receiveResumeOffer(from: String, signal: JSONValue) {
        current?.assembly.control.receiveResumeOffer(from: from, signal: signal)
    }

    /// The peer left the room, or announced an authenticated departure.
    ///
    /// Forwarded to the held link, which ignores it unless it is that link's own
    /// peer. It does NOT cancel an establishment that has not published — see
    /// "What it deliberately does NOT do yet".
    func peerDeparted(_ peerId: String) {
        current?.assembly.control.peerDeparted(peerId)
    }

    // MARK: - what the link reports

    /// One lifecycle fact from the attempt this object owns.
    ///
    /// `generation` is the establishment it was installed for. Anything older is
    /// dropped whole: the attempt it belongs to is not the one held, so neither
    /// its publication nor its ending is a fact about the room as it is now — and
    /// acting on one would move an admission that a LATER establishment is
    /// already using.
    private func attemptReported(_ event: LinkSessionLifecycle, generation: Int) {
        guard var session = current, session.generation == generation else { return }

        switch event {
        case .opened:
            // `LinkSessionRuntime` has already moved admission to `.open` — see
            // its invariant 6. This object only records that it happened, because
            // that is what decides who releases the room at the end.
            session.published = true
            current = session

        case let .ended(reason):
            // The slot is cleared BEFORE the room is released, so a handler that
            // reacts by beginning the next establishment finds this object empty
            // and its own admission call lands after this one rather than under
            // it.
            current = nil
            release(after: reason, published: session.published)
        }
    }

    /// Release the room, if this object is the only thing that can.
    private func release(after reason: LinkSessionRuntimeEnd, published: Bool) {
        // Everything after a publication is the coordinator's: it ended the link
        // and it chose `.closed` or `.failed` from the reason the gap actually
        // had, which is finer than anything readable here. Making a second call
        // would at best repeat it and at worst overwrite it.
        guard !published else { return }

        switch reason {
        case .establishmentFailed:
            // The transport failed before it ever published. A failed link, the
            // same reading `LinkRecoveryCoordinator` gives a transport that died
            // with an error.
            admission.didFail()

        case .establishmentClosed:
            // The peer hung up during establishment. Clean, and the room is free
            // — the coordinator's own `.declined` with no error says the same.
            admission.didClose()

        case .stopped:
            // A stop that reached the runtime rather than this object's `end()`.
            // The room is free: a local stop is not a fault.
            //
            // One shape of this ending has already released the room — the stop
            // that wins the race against a publication in flight, where the
            // half-built coordinator is discarded through its own `stop()`. That
            // repeat is inert rather than tolerated by luck: `didClose` assigns
            // idle and clears counters that are, on an admission it has already
            // closed, exactly the values they already hold. And it cannot land on
            // a LATER establishment, because that one would carry a newer
            // generation and this callback would have been dropped above.
            admission.didClose()

        case .wiringFailed:
            // Structurally unreachable — `LinkSessionRuntime.publish` records why
            // — and, if it were reached, already released: that path builds a
            // coordinator, fails to bind it, and stops it, which closes the room
            // on the way out. This is the one unpublished ending that must NOT be
            // answered here.
            break

        case .linkEnded:
            // The held link ending, which cannot happen without a publication —
            // there is no held link before one. Named rather than defaulted, so
            // that a new case in `LinkSessionRuntimeEnd` has to be decided here
            // instead of falling into whichever branch a `default` happened to
            // sit in.
            break
        }
    }
}
