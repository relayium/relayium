import Foundation

/// **What a Finder drag is allowed to do to a staged selection**, as a value a
/// `swift test` can produce rather than a decision spread across three views.
///
/// A drop is only another way to say *these files* — the same thing the picker
/// says. So it lands in the same `SelectionStore.add`, under the same expansion,
/// the same `MAX_FILES` bound, the same symlink refusal and the same plan and
/// account gates the Send button already applies. Nothing here sends anything,
/// and nothing here chooses a peer or a device: those decisions belong to the
/// surface the drop landed on, and a drop that made either of them is how files
/// go to the wrong machine.
///
/// What this type adds over "decode each item and stage what worked" is the one
/// rule that could not be expressed that way: **a batch is admitted whole or not
/// at all.** `droppedFileURL(from:)` returns nil for an item it cannot decode,
/// and the drop target used to `continue` past it — so a drag of four files
/// whose third item arrived unusable staged three, reported nothing, and left
/// the user to notice the gap in the manifest after pressing Send. Partial
/// admission is the one outcome a selection surface must not have.
public enum FileDropAdmission: Equatable {
    /// The surface owns work that the selection belongs to — a running transfer,
    /// an unverified link, a device that is no longer a legal target. Nothing is
    /// staged and nothing is said: the control that would explain it is the one
    /// the user can already see.
    case refusedBusy
    /// **The surface the drag landed on is no longer the surface it would be
    /// staged into.** Not the same thing as busy: the target that accepted this
    /// drop is gone, and the one now in its place is open, idle and perfectly
    /// willing — for a different peer, a different link or a different device.
    ///
    /// A view outlives the attempt it was drawn for. `TransferLinkPane` stays on
    /// screen through `.ended` and into the NEXT attempt, carrying the same
    /// `@StateObject SelectionStore`; so a drag that began on attempt N, over an
    /// N that ended while its item providers resolved, would find `acceptsWork`
    /// true again — for N+1 — and stage onto a peer the user never dropped
    /// anything on. `isBusy` cannot see that, because at the moment it is asked
    /// the surface is not busy. Only the identity of the target can.
    case refusedStaleContext
    /// The drag carried no `public.file-url` item at all. Not an error — AppKit
    /// only delivers providers for the types the target asked for, so this is an
    /// empty batch rather than a rejected one.
    case empty
    /// At least one item could not be decoded into a file URL. **No URL from
    /// this drag is staged**, including the ones that decoded perfectly well.
    case refusedUnreadable
    /// Every item decoded, in the order they were dropped.
    ///
    /// Order matters because it becomes manifest order: a set of promises
    /// resolved concurrently would produce a different manifest for the same
    /// drag each time, and the interop fixtures are written against a stable one.
    case accepted([URL])
}

/// **Which target a surface is serving, as a value that changes exactly when the
/// target does.**
///
/// Compared, never rendered and never parsed: the only question asked of it is
/// whether the thing the user dropped onto is still the thing that would be
/// staged into. A `String` rather than a protocol because the surfaces key on
/// different facts — an attempt counter on one, a device id on another — and the
/// adapter must not have to know which.
///
/// It is deliberately NOT the peer's *label*, which is peer-supplied and can
/// repeat, and not the connection *state*, which returns to the same value on
/// the next attempt. Both would compare equal across the exact substitution this
/// exists to catch.
public struct FileDropContext: Equatable, Sendable {
    public let id: String

    public init(_ id: String) { self.id = id }

    /// A surface whose destination cannot be replaced beneath a drop: it is
    /// fixed for the whole life of the view that accepted the drag, so there is
    /// nothing for a token to distinguish.
    ///
    /// Only for a surface where that is a structural fact, not a belief. The
    /// stored-upload zone qualifies — its destination is this account's own
    /// storage, chosen by nothing and unchanged by any connection. A surface
    /// holding a peer, a link or a device does NOT, however stable it looks.
    public static let fixed = FileDropContext("")
}

/// Decide what a resolved drag may do, from the item payloads and the live state
/// of the surface it landed on.
///
/// `isBusy` is passed as a value rather than read here because the caller has to
/// read it AFTER the item providers have resolved: AppKit accepts a drop before
/// the payload exists, and a transfer can start, a link can end or a device can
/// be revoked during that suspension. Admission at drop time is not authority to
/// mutate a selection that something else now owns.
///
/// **`droppedInto` and `nowServing` are the same question asked about identity
/// rather than about state**, and they are the reason busy alone is not enough.
/// Busy answers "may this surface be written to"; it cannot answer "is this
/// still the surface I dropped on". A link that ended and was replaced by a new
/// one is not busy — it is somebody else. See `refusedStaleContext`.
///
/// The stale check is FIRST, and that ordering is a claim about honesty rather
/// than cost: once the target has been substituted, `isBusy` describes the
/// *replacement*, and reporting the replacement's state as this batch's reason
/// would name a surface the user never dropped anything on.
///
/// Busy is then checked on its own, before any decoding. A batch refused because
/// the surface moved on is not also reported as unreadable — the items may have
/// been perfectly good, and naming the wrong reason is worse than naming none.
public func admitFileDrop(_ items: [Any?],
                          isBusy: Bool,
                          droppedInto: FileDropContext,
                          nowServing: FileDropContext) -> FileDropAdmission {
    guard droppedInto == nowServing else { return .refusedStaleContext }
    guard !isBusy else { return .refusedBusy }
    guard !items.isEmpty else { return .empty }
    var urls: [URL] = []
    for item in items {
        guard let url = droppedFileURL(from: item) else { return .refusedUnreadable }
        urls.append(url)
    }
    // Every item decoded but the list is still empty: not reachable through the
    // loop above, and named anyway so a future decoder that can yield nothing
    // for a non-nil item cannot turn an empty batch into an accepted one.
    guard !urls.isEmpty else { return .empty }
    return .accepted(urls)
}

/// A completion handler that may be invoked once, whoever invokes it and from
/// whichever queue.
///
/// `NSItemProvider.loadItem` runs a block supplied by the **drag source** — code
/// in another application, or another process's extension. Bridging that block
/// to `async` resumes a continuation, and resuming a continuation twice is a
/// runtime trap rather than a recoverable error: a buggy or hostile source could
/// terminate Relayium by calling its completion handler a second time. Nothing
/// about the drag payload is trusted, so neither is its arity.
///
/// Deliberately a class with a lock rather than an actor: the callback is
/// synchronous and may arrive on any queue, and an actor hop would put the
/// second call's decision after the first call's resume rather than before it.
public final class OneShotClaim: @unchecked Sendable {
    private let lock = NSLock()
    private var claimed = false

    public init() {}

    /// True exactly once, for exactly one caller.
    public func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !claimed else { return false }
        claimed = true
        return true
    }
}

/// **What a staged batch belongs to, and the moment it stops belonging to it.**
///
/// `admitFileDrop` closes the window *inside* one drag: the target is captured
/// while AppKit is still asking and compared again when the payload lands, so a
/// drop cannot be staged into a surface that was substituted while its item
/// providers resolved. That is half the rule. The other half is everything
/// AFTER: a batch that landed cleanly on attempt N, or was picked for device A,
/// sits in the surface's own `SelectionStore` — and that store outlives the
/// target whenever the view holding it is reused. `TransferLinkPane` renders
/// through `.ended` and into the next attempt, carrying the same store; a host
/// that renders a per-peer page without giving it an identity of its own does
/// the same thing across a device swap. Nothing in either case empties the
/// store, and the next press of Send puts a batch the user staged for somebody
/// else onto whoever is there now.
///
/// So the surface reports the target it is serving, on every render, and this
/// answers the one question the store cannot: **is this the same target the
/// staged batch was staged for.** Held as a value rather than written inline in
/// an `onChange` body so the rule can be driven by a test rather than only by a
/// running app.
///
/// **Where structural identity is available, it is the primary mechanism and
/// this is depth behind it.** `DeviceInboxSurface` now keys the device page with
/// an explicit `.id(peer.id)`, which resets every piece of state on it —
/// including the ones nobody has written yet — so under that host this type
/// never reports a substitution at all. It stays because identity is the HOST's
/// to apply: a second host, or a later refactor that drops the key, would
/// silently reinstate the defect, and `TransferLinkPane` has no equivalent —
/// the attempt it is serving changes underneath one continuously rendered pane.
///
/// It is deliberately NOT keyed on the surface's *state*. A link that ends is
/// still the same link, and discarding a batch because the connection dropped
/// would throw away work the user can still send when it comes back — the
/// substitution is a new attempt, which is a new identity, not an ended one.
@MainActor
public struct StagedSelectionLifetime {
    /// The last target reported, or `nil` before the surface has reported one.
    private var served: FileDropContext?

    public init() {}

    /// Report the target this surface is serving now.
    ///
    /// True exactly when the target was **substituted** — the caller must then
    /// discard what is staged and any refusal describing it, because both belong
    /// to a target that is no longer on screen.
    ///
    /// **The first report is never a substitution.** A surface that has just
    /// been built has staged nothing yet, and treating "I had no previous
    /// answer" as a change would discard a batch adopted before the first render
    /// — which is exactly what `adoptOpenedFiles` produces when the OS opens
    /// files into a launching app.
    public mutating func serving(_ target: FileDropContext) -> Bool {
        let previous = served
        served = target
        guard let previous else { return false }
        return previous != target
    }
}
