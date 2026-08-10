import Combine
import Foundation
// For the TEXT lane's own vocabulary — `LinkTextStatus` and
// `LinkTextDriverError` — which this projection mirrors rather than restates.
import RelayiumKit

/// Where one `link/1` attempt is in its CONNECTION lifecycle, as a screen would
/// state it.
///
/// Three cases, and they are the three a view genuinely renders differently:
/// something is being established and there may or may not be digits to compare
/// yet, a link is open under an authenticated peer, or the attempt is over for a
/// reason. Anything finer — which transport, which rebuild, how far along
/// establishment is — is `LinkSessionRuntime`'s business and has no separate
/// appearance.
///
/// `sas` is optional in `establishing` and not in `open`, because that is what
/// the runtime promises: `opened` carries the digits it authenticated on, so an
/// open link always has them, while an establishing one has them only once the
/// transport has emitted them.
///
/// `ended` carries `LinkSessionRuntimeEnd` verbatim rather than a rendered
/// string. Turning a reason into words is a later slice's job, and a message
/// baked in here would be one this type could not localize and a view could not
/// override.
public enum LinkSessionConnectionPhase: Equatable {
    /// Working on it. `sas` is the digits to compare, once there are any.
    case establishing(sas: String?)
    /// Both lanes are open under one authenticated identity.
    case open(peerId: String, sas: String)
    /// Terminal.
    case ended(LinkSessionRuntimeEnd)
}

/// One line of an authenticated `link/1` conversation, as a transcript would
/// list it.
///
/// Three fields, and nothing that could be rendered from them. There is no
/// timestamp, because nothing in `link/1` carries one and a receive-time clock
/// read here would be a fact this model invented; there is no status, because a
/// message this object holds has already been authenticated and delivered.
///
/// `id` is assigned by the model that holds the list and means only "this entry,
/// in this model": it is not a sequence number, not a wire identifier, and it
/// does not survive the model. Its whole job is to give SwiftUI a stable
/// identity for a list whose entries are otherwise free to repeat — two
/// identical bodies really are two messages, and a view that de-duplicated them
/// by content would hide the second one.
public struct LinkTextMessage: Equatable, Identifiable {

    /// Who said it.
    ///
    /// **The two arrive from different places, and that is the shape of the
    /// lane rather than an asymmetry here.** Nothing in `LinkTextDriverEvent`
    /// reports this side's own messages — the driver's `received` is inbound
    /// plaintext and its send path answers the CALLER rather than the event
    /// stream — so an `incoming` entry is created from the event stream and an
    /// `outgoing` one only from `recordOutgoing`, which the attempt owner calls
    /// once the runtime has accepted a send. Nothing here fabricates either.
    public enum Direction: Equatable {
        case incoming
        case outgoing
    }

    /// Model-local, monotonic, and never reused. See the note above.
    public let id: Int
    public let direction: Direction
    /// Exactly what crossed the lane: no trimming, no normalisation.
    public let body: String
}

/// The `@MainActor` projection of ONE attempt's connection lifecycle and of its
/// TEXT lane.
///
/// ## What it is, and what it deliberately is not
///
/// It is the presentation layer above `LinkSessionEventBridge`, and it is
/// exactly one thing: `LinkSessionRuntimeEvent` in, published state out. It owns
/// no runtime, builds nothing, **sends nothing**, and cannot end an attempt or a
/// conversation. A caller hands it a bridge that is already the attempt's, and
/// this object's whole visible surface is what a view would bind to.
///
/// That it cannot send is a decision, not an oversight. There is no `send`, no
/// `accept`, no `decline` and no reference to a runtime to call one on: commands
/// belong to `LinkSessionAttempt`, which owns this model's whole lifetime. The
/// one thing that owner tells this object is `recordOutgoing`, and it is not a
/// command — it is the transcript entry a send has already EARNED, handed over
/// after the runtime accepted it, because the runtime's event stream carries no
/// record of this side's own messages.
///
/// **`file` and `received` are ignored here, on purpose.** They are the other
/// lane and the committed-batch report, and they have their own projection:
/// `LinkFilePresentationModel`. Neither object knows the other exists — their
/// one owner hands both the same ordered stream and each ignores what is not
/// its own — because a transfer list folded in here would tie a file screen's
/// correctness to the conversation's.
///
/// The two states it does hold are kept apart for the same reason: a
/// conversation that fails or ends is not a link that failed or ended, so the
/// text lane never writes `phase`, and a whole-session `ended` freezes both.
///
/// ## Threading
///
/// Everything here is main-actor isolated, and the hop the runtime's contract
/// demands is the bridge's: it delivers on the main actor, in publication order,
/// one at a time. So `apply` is an ordinary main-actor method with no
/// synchronization of its own, and a view may read this state directly.
///
/// ## Lifetime
///
/// It holds nothing: no bridge, no runtime, no other projection. **It does not
/// bind either**, and that is deliberate — one bridge belongs to one attempt and
/// is bound ONCE, by that attempt, which then hands each event to the
/// projections it owns. A model that bound for itself would be a second thing
/// competing for the one binding the moment a second projection existed, and the
/// loser would silently paint nothing.
///
/// **There is no `deinit` teardown, and that is a decision rather than an
/// omission.** Retiring an attempt is `LinkSessionEventBridge.invalidate` plus
/// the runtime's own `stop()`, and both belong to the owner or factory that
/// built them. Calling `invalidate` from this object's `deinit` would end a live
/// attempt merely because a screen was dismissed, and it would do it from
/// whichever thread released the last reference — actor-isolated cleanup at
/// exactly the boundary that cannot promise isolation. Delivering into a model
/// that has gone is already a no-op.
@MainActor
public final class LinkSessionPresentationModel: ObservableObject {

    /// The connection. Everything a view asks below is a reading of this and of
    /// the three text properties.
    @Published public private(set) var phase: LinkSessionConnectionPhase = .establishing(sas: nil)

    // MARK: - the TEXT lane

    /// The conversation the user is looking at, exactly as the driver states it.
    /// The driver emits `status` only on a real change, so this is a mirror
    /// rather than a second state machine.
    @Published public private(set) var textStatus: LinkTextStatus = .idle

    /// The transcript, oldest first. Append-only for the life of the attempt:
    /// an ordinary conversation `ended` or `refused` closes a conversation, not
    /// the history of one, and the same link can open another.
    @Published public private(set) var textMessages: [LinkTextMessage] = []

    /// Why the lane failed, as the typed value the driver reported and no more.
    /// Turning it into words is a later slice's job — a message baked in here
    /// would be one this type could not localize and a view could not override.
    ///
    /// `nil` while the lane has failed is a real state, not a placeholder: a
    /// lane can reach `failed` through a plain status change, which carries no
    /// error, before the driver's own `failed` arrives with one.
    @Published public private(set) var textFailure: LinkTextDriverError?

    /// Next `LinkTextMessage.id`. Monotonic for this model's whole life and
    /// never reset, including across conversations.
    private var nextTextMessageId = 0

    /// Nothing to wire. Events arrive through `apply`, which the attempt that
    /// owns this model calls for every event its one bridge delivers.
    public init() {}

    // MARK: - what a view asks

    /// The digits to compare, while there are any to compare. `nil` once the
    /// attempt is over: `ended` carries no identity, and a screen that kept
    /// showing digits for a finished session would be inviting a comparison
    /// against nothing.
    public var sas: String? {
        switch phase {
        case let .establishing(sas): return sas
        case let .open(_, sas): return sas
        case .ended: return nil
        }
    }

    /// The authenticated peer, once there is one.
    public var peerId: String? {
        guard case let .open(peerId, _) = phase else { return nil }
        return peerId
    }

    public var isOpen: Bool {
        guard case .open = phase else { return false }
        return true
    }

    public var isEnded: Bool {
        guard case .ended = phase else { return false }
        return true
    }

    /// Whether this lane is over. Deliberately NOT gated on the link: a lane
    /// that failed stays failed, and a screen reporting why still has to be able
    /// to say so after the session itself has ended.
    ///
    /// It is also the terminal guard `applyText` reads, which is why it is a
    /// reading of `textStatus` rather than of `textFailure` — a bare
    /// `status(.failed)` has no error to read.
    public var isTextFailed: Bool { textStatus == .failed }

    /// Whether a composer may accept typing.
    ///
    /// Both states, because either alone is a composer that cannot send: an
    /// open conversation on a link that is still establishing has nowhere to
    /// put a message, and an open link with no conversation would have the
    /// session refuse one. This is an enablement fact only — nothing here sends,
    /// and the driver still owns every limit that decides whether a particular
    /// message is accepted.
    public var canSendText: Bool { isOpen && textStatus == .open }

    /// The peer asked for a conversation and this side has not answered. What a
    /// consent prompt appears on, so it is gated on the link too: a request on
    /// an attempt that is over is not something a user can still accept.
    public var hasIncomingTextRequest: Bool { isOpen && textStatus == .incomingRequest }

    /// This side asked and the peer has not answered.
    public var isWaitingForTextAccept: Bool { isOpen && textStatus == .waitingAccept }

    // MARK: - the projection

    /// One event, one phase decision.
    ///
    /// Called by `LinkSessionAttempt` — the one object that binds this attempt's
    /// bridge — for every event that bridge delivers, on the main actor, in
    /// publication order, one at a time.
    func apply(_ event: LinkSessionRuntimeEvent) {
        // Terminal means terminal. The runtime promises `ended` is its last
        // event and the bridge drops whatever it was holding, so this guard
        // should be unreachable — it is here because the alternative failure is
        // a session visibly reopening on a screen that had already ended, and a
        // one-line guard is cheaper than the promise it double-checks.
        guard !isEnded else { return }

        switch event {
        case let .sas(digits):
            // Only while establishing. `opened` carries the digits it
            // authenticated on, so a later `sas` has nothing to add and
            // accepting one would drag an open link back to "connecting".
            guard case .establishing = phase else { return }
            phase = .establishing(sas: digits)

        case let .opened(peerId, sas):
            // Whether or not a `sas` came first: this event is self-contained,
            // and requiring the earlier one would strand a screen on
            // "establishing" for a link that is already open.
            phase = .open(peerId: peerId, sas: sas)

        case let .ended(reason):
            phase = .ended(reason)

        case let .text(event):
            // The TEXT lane, which is a projection of its own and deliberately
            // never touches `phase`: a conversation that fails or ends is not a
            // link that failed or ended, and folding one into the other would
            // close a screen whose file lane is still working.
            applyText(event)

        case .file, .received:
            // The file lane and the committed batch. `LinkFilePresentationModel`
            // projects these, from the same delivery; see the note on this type
            // for why they are not squeezed into a connection phase.
            break
        }
    }

    /// One text event, one lane decision.
    private func applyText(_ event: LinkTextDriverEvent) {
        switch event {
        case let .failed(error):
            // Handled BEFORE the terminal guard, because a lane can already be
            // `failed` from a bare status change that carried no error, and the
            // driver's own report is what supplies it. Only the first one is
            // kept: the driver promises at most one `failed`, and if that ever
            // stopped being true the useful value is the failure that started
            // this, not whatever fell out of it afterwards.
            if textFailure == nil { textFailure = error }
            // Guarded rather than assigned unconditionally: re-assigning the
            // value it already holds would publish, and a view that repainted
            // its whole transcript for a state that did not change is the cost.
            if !isTextFailed { textStatus = .failed }

        case let .status(status):
            // Terminal for this lane, defensively. The driver does not emit a
            // status after `failed`, and the alternative failure is a lane that
            // says "open" again on a screen that has already reported it broken.
            guard !isTextFailed else { return }
            textStatus = status

        case let .received(body):
            guard !isTextFailed else { return }
            append(.incoming, body)
        }
    }

    // MARK: - what only the attempt owner knows

    /// Record one message THIS side sent, after the runtime accepted it.
    ///
    /// The runtime's event stream has no successful-send event — the lane
    /// answers the CALLER instead — so the only object that can honestly create
    /// an outgoing entry is the one that made the call and saw it return.
    /// `LinkSessionAttempt` is that object, it is this model's owner, and it is
    /// the only caller of this method.
    ///
    /// It is not a command and takes no decision: whether the message may be
    /// sent was already answered, by the lane, before this runs. Nothing here
    /// trims, normalises or de-duplicates — for the same reason `received` does
    /// not — and there is no "sending" state, because nothing below reports a
    /// per-message acknowledgement this model could resolve one with.
    ///
    /// **The two terminal guards are defence in depth.** A live runtime refuses
    /// every send once its session or its lane is over, so an accepted send
    /// cannot coincide with either frozen state. If one ever did, the visible
    /// failure would be a transcript that grew on a screen that had already
    /// reported the session, or the conversation, finished — so the freeze wins.
    func recordOutgoing(_ body: String) {
        guard !isEnded, !isTextFailed else { return }
        append(.outgoing, body)
    }

    /// One transcript entry, in the one id space both directions share.
    ///
    /// Verbatim, including duplicates and — if an impossible producer ever sent
    /// one — an empty body. The session refuses empty bodies and the driver owns
    /// every size and rate limit, so a second policy here could only disagree
    /// with the one that is authoritative; what it would actually do is silently
    /// drop a message one side was told had been delivered.
    private func append(_ direction: LinkTextMessage.Direction, _ body: String) {
        textMessages.append(LinkTextMessage(id: nextTextMessageId,
                                            direction: direction,
                                            body: body))
        nextTextMessageId += 1
    }
}
