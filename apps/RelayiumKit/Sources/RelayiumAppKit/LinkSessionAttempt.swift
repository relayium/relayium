import Combine
import Foundation
import RelayiumKit

// MARK: - the command seam

/// Everything ONE `link/1` attempt can be TOLD to do, as `LinkSessionRuntime`
/// already answers it.
///
/// Exactly that runtime's existing public shape, and that is the point: this
/// seam exists so command forwarding, transcript recording and retirement can be
/// exercised without two negotiating endpoints, not so a second dialect can grow
/// beside the runtime. A conformance that needed an adapter would mean this file
/// had been written against a runtime that does not exist.
///
/// It is deliberately the COMMANDS and nothing else. There is no event stream
/// here — the attempt receives events through the bridge it owns, and a second
/// path would be a second order — and there is no reader: `recoveryPhase`,
/// `textStatus` and `isEnded` are snapshots a presentation layer must not race
/// against its own projection.
///
/// The file lane's commands are absent for the same reason its projection is:
/// `enqueueFiles`, `pumpFiles` and the four batch verbs are only meaningful
/// against batch state a screen can point at, and that state belongs to the file
/// projection's own review boundary. Adding inert pass-throughs now would be an
/// API that slice would have to redefine.
///
/// The recovery seams — `receiveResumeOffer`, `peerDeparted`, `joinRecovery` —
/// are absent on purpose too, and permanently: they belong to the room and
/// admission owner, and routing them through a presentation object would put
/// signalling policy in the layer that must not have any.
protocol LinkSessionCommands: AnyObject {
    /// Begin establishing. Idempotent, and inert once the runtime has ended.
    func start()
    /// End the runtime, once, from any thread. Idempotent and terminal.
    func stop()

    /// Ask the peer for a conversation.
    func openTextConversation() throws
    /// Consent to the peer's request.
    func acceptTextConversation() throws
    /// Refuse the peer's request.
    func rejectTextConversation() throws
    /// End the current conversation. An ordering barrier, not a hangup.
    func endTextConversation() throws
    /// Seal and queue one message. Throwing means the lane did NOT take it.
    func sendText(_ body: String) throws
}

extension LinkSessionRuntime: LinkSessionCommands {}

// MARK: - the attempt

/// The one owner of ONE `link/1` attempt's runtime, event bridge and
/// presentation model: it assembles all three, forwards commands to the runtime,
/// records what the runtime accepted, and retires all three together, once.
///
/// ## What it is for
///
/// `LinkSessionRuntime` is the link, `LinkSessionEventBridge` is the hop onto the
/// main actor, and `LinkSessionPresentationModel` is the read-only projection —
/// and all three are complete. What none of them can state alone is who owns the
/// other two: who builds them in the one order that loses no event, who is
/// allowed to send, and who ends the attempt. That is this object, and it is
/// deliberately nothing else. It owns no UI, no admission, no signalling policy,
/// no picker and no directory selection.
///
/// ## The invariants it exists to make structural
///
/// **1. One attempt, one owner, one lifetime.** The bridge and the model are
/// built HERE and are not parameters: a caller cannot hand the same bridge to two
/// attempts, and the model this attempt paints is the model this attempt retires.
/// The runtime arrives through a FACTORY that is handed the bridge's own sink, so
/// a runtime built through this owner reports to this owner's bridge and to
/// nothing else. `LinkSessionAttemptTests` pins the "only builder" half as source
/// as well as behaviour, because a second construction elsewhere would be a
/// second thing able to retire — or to fail to retire — one attempt.
///
/// **2. Assembled before started.** The factory runs first, the model is bound
/// second, and `start()` is the LAST thing the initializer does. Nothing is lost
/// either way — the bridge buffers what a factory publishes eagerly, which is
/// exactly the case it documents — but the order is what keeps the buffer a
/// safety net rather than the mechanism.
///
/// **3. Commands are forwarded, never re-decided.** Every verb below resolves
/// this owner's liveness and then calls the runtime. It reads no lane state, adds
/// no size, rate or content rule, and re-wraps no refusal: `LinkTextDriverError`
/// and `LinkSessionRuntimeError` reach the caller exactly as the layer that
/// answered produced them. A composer that greys itself out is a view reading
/// `canSendText`; a command that never reached the lane because presentation
/// state disagreed with the lane's would be a second policy that can silently
/// diverge from the authoritative one.
///
/// **4. A transcript entry is earned, not predicted.** `sendText` records an
/// outgoing entry only after the runtime RETURNED, and any thrown refusal records
/// nothing. Showing a message the lane never took is the one transcript bug a
/// user cannot recover from, because they believe it was delivered.
///
/// **5. Retirement is exactly once, and a stale attempt is inert.** `retire()`
/// drops the stream and stops the runtime, and every command after it throws
/// `LinkSessionRuntimeError.ended` without reaching the runtime at all.
///
/// **6. Nothing here builds a link.** No key, no codec, no identity, no
/// transport, no crypto decision. Everything this object can act on arrives
/// already authenticated, through the factory it was handed — and the test suite
/// pins that as source, because it is the one property a later edit could break
/// while every behavioural test still passed.
///
/// ## Ordering
///
/// Everything here is main-actor isolated, and so is the model. A command
/// therefore runs to completion with no bridge delivery interleaved: between the
/// runtime answering `sendText` and the entry that answer earns, nothing can
/// repaint the model. That is what makes "a send accepted as the link ends under
/// it is still recorded, and recorded before the end" a fact rather than a race,
/// and it is why this object needs no lock of its own.
///
/// The reverse case — a runtime that accepts a command after its session or its
/// lane is over — cannot happen: the runtime refuses on its own typed state. The
/// model's terminal guards still refuse the entry, as defence in depth against a
/// transcript growing on a screen that has already reported the session finished.
///
/// ## Lifetime
///
/// This object holds the runtime, the bridge and the model strongly; the bridge
/// holds the model weakly through its structural weak-owner API, so nothing below
/// keeps the screen alive.
///
/// **`retire()` is the contract, and there is no `deinit` cleanup.** Retiring
/// ends the held link — which ends both lanes and discards an uncommitted
/// receive — and a `deinit` that did it would run that teardown from whichever
/// thread released the last reference, which is precisely the boundary that
/// cannot promise main-actor isolation. `LinkSessionRuntime` and
/// `LinkSessionPresentationModel` both make the same decision for the same
/// reason. The consequence is stated rather than hidden: an owner that drops an
/// attempt without retiring it leaves a live link behind.
///
/// **`retire()` drops the stream first and stops the runtime second.** The
/// teardown produces both lanes' terminal reports and one `ended`, and a retired
/// attempt has nothing left to say to a model it no longer owns — so the bridge
/// is silenced before anything can be produced, rather than relying on the main
/// actor not to run a drain in between. The model therefore freezes at the last
/// thing the link actually reported, which is why `isRetired` and `canSendText`
/// exist here: what this owner will still ACCEPT is its own answer, and not the
/// same question as what the link last said.
///
/// ## What it is not
///
/// Unreachable from production. `LINK_BUILD_SUPPORT` and
/// `LINK_TRANSPORT_REPLACEMENT_SUPPORTED` are both still false, nothing outside
/// the tests constructs one, and no `AppEnvironment`, view, iOS or macOS target
/// names it.
@MainActor
final class LinkSessionAttempt: ObservableObject {

    /// What a view binds to. Read-only, and this object is the only thing that
    /// writes to it other than the attempt's own event stream.
    ///
    /// A view observes BOTH — this attempt for what it will accept, the model for
    /// what the link reported. They are different questions and a retired attempt
    /// is where they visibly differ.
    let model: LinkSessionPresentationModel

    /// This attempt is over as far as commands are concerned. Terminal.
    ///
    /// Published, because it is the one fact about an attempt that changes
    /// without a runtime event: retirement is the owner's own act.
    ///
    /// It is the ANNOUNCEMENT of retirement rather than the switch — see
    /// `retired` immediately below for why those have to be two things.
    @Published private(set) var isRetired = false

    /// Retirement as this object acts on it, set before anything is torn down.
    ///
    /// **Two flags rather than one, and it is not redundancy.** `@Published`
    /// publishes in `willSet`, so a subscriber runs BEFORE the new value is
    /// stored — and the ordinary shape of a screen that tears itself down when
    /// its session ends is a subscriber that calls `retire()`. A guard that read
    /// the published property alone would still see "not retired" there, run the
    /// whole teardown a second time, and publish again on its way out: an
    /// unbounded recursion whose base case is a stack overflow.
    ///
    /// So this one is written first and is what every guard reads, and
    /// `isRetired` is written last, once there is really nothing left to tear
    /// down. They can only ever be observed to differ during `retire()` itself,
    /// and in the only direction that is safe: commands already refused, the view
    /// not yet told.
    private var retired = false

    /// The hop, and the thing `retire()` silences. Not a parameter: one bridge
    /// belongs to one attempt — see invariant 1.
    private let bridge: LinkSessionEventBridge

    /// The link. Held strongly for the whole life of this attempt, and reached
    /// only through `live()`.
    private let runtime: any LinkSessionCommands

    /// - Parameter build: makes the runtime for this attempt, and is handed the
    ///   sink it must report through. It is called exactly once, before the model
    ///   exists, and whatever it publishes is buffered rather than lost.
    ///
    ///   It is a factory rather than a finished runtime because that is what
    ///   makes "this attempt's runtime reports to this attempt's bridge"
    ///   structural: there is no way to obtain the sink except by being asked for
    ///   a runtime, and no way to hand this owner a runtime that reports
    ///   somewhere else. It is also where every key, codec, identity, transport
    ///   and directory decision stays — this layer supplies none of them.
    init(runtime build: (@escaping @Sendable (LinkSessionRuntimeEvent) -> Void)
         -> any LinkSessionCommands) {
        let bridge = LinkSessionEventBridge()
        // The sink captures the bridge and NOTHING else — not this attempt,
        // which does not exist yet, and not the model, which the bridge already
        // holds weakly.
        let runtime = build { [bridge] event in bridge.publish(event) }

        self.bridge = bridge
        self.runtime = runtime
        self.model = LinkSessionPresentationModel(bridge: bridge)

        // LAST. See invariant 2.
        runtime.start()
    }

    // MARK: - what this owner will accept

    /// Whether a composer may accept typing: both what the link reported and what
    /// this owner will still take. `model.canSendText` alone would keep a
    /// composer enabled on a retired attempt whose every send is going to throw.
    var canSendText: Bool { !retired && model.canSendText }

    // MARK: - the conversation
    //
    // Five forwarding calls and no sixth decision. Each refuses only for the one
    // thing this object knows that the runtime does not — that this attempt has
    // been retired — and everything else is the runtime's or the lane's own
    // answer, unwrapped.

    /// Ask the peer for a conversation.
    func openTextConversation() throws { try live().openTextConversation() }

    /// Consent to the peer's request.
    func acceptTextConversation() throws { try live().acceptTextConversation() }

    /// Refuse the peer's request.
    func rejectTextConversation() throws { try live().rejectTextConversation() }

    /// End the current conversation. An ordering barrier, not a hangup.
    func endTextConversation() throws { try live().endTextConversation() }

    /// Send one message, and record it only if the lane took it.
    ///
    /// The two lines are in this order and cannot be reordered: the runtime's
    /// answer is what the entry means. A throw leaves the transcript untouched —
    /// there is no optimistic entry to retract, and no "sending" state to
    /// invent, because nothing below reports a per-message acknowledgement this
    /// object could resolve one with.
    ///
    /// Both lines run on the main actor with no suspension between them, so no
    /// event can repaint the model in the gap. See "Ordering".
    func sendText(_ body: String) throws {
        let runtime = try live()
        try runtime.sendText(body)
        model.recordOutgoing(body)
    }

    // MARK: - lifetime

    /// Retire this attempt: stop painting, then end the link. Idempotent.
    ///
    /// Order matters and is explained under "Lifetime": the stream is dropped
    /// before the teardown can produce anything, so the model freezes at the last
    /// thing the link actually reported instead of racing a main-actor drain
    /// against this call.
    ///
    /// The switch is thrown FIRST — that is the part a re-entrant subscriber
    /// depends on, and `retired` explains why — and the announcement comes last,
    /// so anything that reacts to it is looking at a finished teardown. Only the
    /// first of those two is load-bearing; the second is honesty about what the
    /// published value means.
    func retire() {
        guard !retired else { return }
        retired = true

        bridge.invalidate()
        runtime.stop()

        isRetired = true
    }

    /// The runtime to act on, or the one refusal this object owns.
    ///
    /// `.ended` rather than a case of its own: from a caller's side a retired
    /// attempt IS an ended session, and a second vocabulary for the same terminal
    /// fact would be one more thing a view has to translate.
    private func live() throws -> any LinkSessionCommands {
        guard !retired else { throw LinkSessionRuntimeError.ended }
        return runtime
    }
}
