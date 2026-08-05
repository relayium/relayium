import Combine
import Foundation

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
enum LinkSessionConnectionPhase: Equatable {
    /// Working on it. `sas` is the digits to compare, once there are any.
    case establishing(sas: String?)
    /// Both lanes are open under one authenticated identity.
    case open(peerId: String, sas: String)
    /// Terminal.
    case ended(LinkSessionRuntimeEnd)
}

/// The `@MainActor` projection of ONE attempt's connection lifecycle.
///
/// ## What it is, and what it deliberately is not
///
/// It is the first presentation slice above `LinkSessionEventBridge`, and it is
/// exactly one thing: `LinkSessionRuntimeEvent` in, `phase` out. It owns no
/// runtime, builds nothing, sends nothing, and cannot end an attempt. A caller
/// hands it a bridge that is already the attempt's, and this object's whole
/// visible surface is what a connection view would bind to.
///
/// **`text`, `file` and `received` are ignored here, on purpose.** They are the
/// two lanes and the committed-batch report, and each needs its own projection —
/// a transcript with its own ordering and limits, a transfer list with per-batch
/// progress, a received-files surface. Folding any of them into a connection
/// phase now would mean inventing semantics that the later slices would then
/// have to either duplicate or contradict, so this slice states the connection
/// and leaves the lanes to the models that will actually render them.
///
/// ## Threading
///
/// Everything here is main-actor isolated, and the hop the runtime's contract
/// demands is the bridge's: it delivers on the main actor, in publication order,
/// one at a time. So `apply` is an ordinary main-actor method with no
/// synchronization of its own, and a view may read `phase` directly.
///
/// ## Lifetime
///
/// The binding uses the bridge's structural weak-owner API — the model arrives
/// as the handler's `owner` parameter and is captured weakly by the wrapper the
/// bridge stores — so this object is not retained by the bridge, and a runtime
/// that outlives its screen cannot keep that screen alive. It does not hold the
/// bridge either: the attempt's lifetime belongs to whoever owns the runtime.
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
final class LinkSessionPresentationModel: ObservableObject {

    /// The one piece of state. Everything below is a reading of it.
    @Published private(set) var phase: LinkSessionConnectionPhase = .establishing(sas: nil)

    /// Binds to the attempt's bridge, which may already be holding events: one
    /// published before this model existed is delivered on the next main-actor
    /// turn rather than inline, so nothing repaints a model mid-construction.
    ///
    /// The bridge is not stored. This model paints an attempt; it does not own
    /// one.
    init(bridge: LinkSessionEventBridge) {
        bridge.bind(to: self) { owner, event in owner.apply(event) }
    }

    // MARK: - what a view asks

    /// The digits to compare, while there are any to compare. `nil` once the
    /// attempt is over: `ended` carries no identity, and a screen that kept
    /// showing digits for a finished session would be inviting a comparison
    /// against nothing.
    var sas: String? {
        switch phase {
        case let .establishing(sas): return sas
        case let .open(_, sas): return sas
        case .ended: return nil
        }
    }

    /// The authenticated peer, once there is one.
    var peerId: String? {
        guard case let .open(peerId, _) = phase else { return nil }
        return peerId
    }

    var isOpen: Bool {
        guard case .open = phase else { return false }
        return true
    }

    var isEnded: Bool {
        guard case .ended = phase else { return false }
        return true
    }

    // MARK: - the projection

    /// One event, one phase decision.
    private func apply(_ event: LinkSessionRuntimeEvent) {
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

        case .text, .file, .received:
            // The lanes and the committed batch. Later presentation slices
            // project these; see the note on this type for why they are not
            // squeezed into a connection phase now.
            break
        }
    }
}
