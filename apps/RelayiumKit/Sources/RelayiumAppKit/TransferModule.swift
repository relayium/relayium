import Combine
import Foundation
import RelayiumKit

/// Which of the two panes a macOS transfer destination draws.
///
/// **Two, where `TransferSurfacePane` has three.** That type keeps its
/// `legacySession` case and still needs it — the paused iOS implementation
/// renders one — but no macOS composition can reach one now: there is no legacy
/// transport on this platform to put in it. So macOS answers with this type
/// rather than promising never to return a case it can still name. A pane enum
/// whose third value is unreachable is an invitation to reach it again.
public enum LinkTransferPane: String, Equatable, Sendable {
    /// The connection method, and — on the Cross-network destination — the code
    /// this module has minted or joined while it waits for a peer.
    ///
    /// A watched pairing room is deliberately HERE rather than in a pane of its
    /// own. Six digits with no peer yet is not a session: the user is looking at
    /// the screen they started from with a code added to it, and moving them to
    /// an empty session pane would replace the one thing the wait depends on.
    case connect
    /// A real `link/1`: one authenticated connection carrying messages and files
    /// at once, behind one verification boundary.
    case link
}

/// One direct-transfer **module**: everything a single connection method owns,
/// and nothing another one shares.
///
/// ## Why this type exists
///
/// macOS ships two direct-transfer destinations — LAN Transfer (the code-less
/// same-network room) and Cross-network Transfer (a six-digit pairing code) —
/// and for several rounds they were two screens over **one** set of models: one
/// `RealtimeSessionModel`, one `RealtimeTextSessionModel`, one
/// `LinkWorkspaceModel`, arbitrated by one `TransferPresence`. That sharing was
/// never a product decision. It was an implementation detail, and it produced
/// three separate failures that all read to a user as "the app disconnected me":
///
///  1. **A session on one screen locked the other screen entirely.** Every
///     connect control on the destination that did not own the session was
///     disabled, so a user holding an open same-network connection could not
///     mint a pairing code at all — and the only way to get one was to end the
///     connection they were using.
///  2. **One `LinkWorkspaceModel` routed two different rooms.** A peer id means
///     nothing outside the room that issued it, so the same-network roster's
///     ordinary churn reached a pairing room's router: one device appearing or
///     leaving cancelled the request a code room had in flight. That is the
///     macOS-to-Web pairing oscillation `LinkWorkspaceModel.lanObserverOwnsRouter`
///     had to be introduced to suppress, and suppressing a cross-talk is not the
///     same thing as not having one.
///  3. **One Cancel could only ever mean one session.** With a single set of
///     models there is no such thing as "cancel this module": the exit ends
///     whatever the shared models hold.
///
/// A module is the repair for all three at once. Each one owns its own legacy
/// pair, its own `link/1` and its own `TransferPresence`, so the two are
/// independent by construction rather than by arbitration — navigating between
/// them is navigation and nothing else, and each screen's Cancel reaches exactly
/// the connection that screen is drawing.
///
/// ## App-scoped, never view-scoped
///
/// Everything here outlives the window. macOS keeps running with its unique
/// window closed (`applicationShouldTerminateAfterLastWindowClosed` is false and
/// the `MenuBarExtra` holds the process up), so a module whose lifetime was a
/// view's would end a live transfer the moment somebody pressed the close
/// button. That is the property the owner's requirement turns on: a session
/// survives navigation because nothing about navigation touches this object.
///
/// ## What it publishes
///
/// It holds no state of its own and declares no `@Published` property. What it
/// does is **relay** its four objects' `objectWillChange`, so a view can observe
/// one module and redraw for anything inside it. That is deliberately per
/// module: an event in the Nearby module redraws the Nearby destination and the
/// Nearby sidebar row, and nothing on the other screen — which is the same
/// granularity the four separate `@ObservedObject`s gave before, expressed once
/// instead of at every call site.
@MainActor
public final class TransferModule: ObservableObject {
    /// Which destination draws this module. `.nearby` or `.pairingCode`.
    ///
    /// Stored rather than inferred, because every ownership claim, release and
    /// refusal below is checked against it: a module that read "whoever owns the
    /// presence" could give up a surface that is not its own.
    public let route: AppDestination
    /// This module's unified `link/1` owner — **one room, for the life of the
    /// module.** The nearby module's follows the discovery model's code-less
    /// room socket; the direct module's opens and owns the socket a pairing code
    /// names. Neither can see the other's peer ids, which is the structural half
    /// of failure 2 above.
    public let link: LinkWorkspaceModel
    /// The six digits this module is showing, if any.
    ///
    /// Present on BOTH modules and empty on the Nearby one for the life of the
    /// process: same-network transfer has no code. It is unconditional rather
    /// than optional because a module with an optional half is a module every
    /// caller has to unwrap, and the one thing that could go wrong — a code
    /// minted on the Nearby screen — is prevented by that screen having no
    /// control that mints, which `MacSurfaceGuardTests` checks by name.
    public let code: PairingCodeModel
    /// Which surface inside THIS module presents its session.
    ///
    /// Still a `TransferPresence` rather than a bare flag, and still arbitrating:
    /// a module has one session, and `beginSession` is what refuses the second
    /// activation SwiftUI can deliver before an asynchronous start publishes any
    /// state. What changed is only its scope — the owner is this module's route
    /// or nobody, never the other module's.
    public let presence: TransferPresence

    /// - Parameters:
    ///   - route: the destination that draws this module.
    ///   - presence: injectable so a test can hand in a pre-claimed one. Nil —
    ///     every shipped launch — builds this module its own, and two modules
    ///     must never be given the same instance: that would restore the shared
    ///     arbitration this type exists to remove, and `TransferModuleTests`
    ///     checks it. It is an optional rather than a defaulted
    ///     `TransferPresence()` because a default argument is evaluated outside
    ///     this initializer's actor isolation and would not compile.
    public init(route: AppDestination,
                link: LinkWorkspaceModel,
                code: PairingCodeModel,
                presence: TransferPresence? = nil) {
        let presence = presence ?? TransferPresence()
        self.route = route
        self.link = link
        self.code = code
        self.presence = presence
        // The TWO liveness sources this module has, as one subscription. The
        // code is not decoration: a creator holds six digits on screen while the
        // link is only `.watching`, and for a moment before that while the mint
        // is in flight and the link is still `.idle`. A link-only observer would
        // release the surface under both.
        presence.observeSessions(code: code, link: link)
        // Both derived from this module's OWN ownership. Before modules existed
        // these read one app-wide presence, so an unsolicited link arriving on
        // the same-network room was refused because a pairing code was being
        // minted on another screen — a refusal the peer experienced as this Mac
        // being unreachable.
        let idle = presence.$owner.map { $0 == nil }.eraseToAnyPublisher()
        // **Availability is NOT the same question as surface-idle, and treating
        // them as one publisher was a shipped defect that refused about half of
        // all pairing attempts.**
        //
        // `LinkAdmission.route` answers an UNSOLICITED inbound link REQUEST —
        // one arriving into an idle room — with `.busy` whenever
        // `canAcceptLink` is false, and that predicate is fed from
        // here. A watched pairing room is exactly that idle room: a code has
        // been minted but no peer is bound yet, so this predicate is the whole
        // decision. Minting or joining a code claims this module's surface before
        // the room is watched — `CrossNetworkConnectPane` calls
        // `presence.beginSession` and then `watchPairingCode` — so from the
        // moment a code exists, `owner != nil` and the gate said "busy" to
        // everyone. Whether that mattered depended on `linkRole`: the smaller
        // hub id must offer, so only when THIS side was the offerer did the peer
        // send a request, and only then was the request refused. The hub assigns
        // ids at random, so the shipped symptom is a cross-network pairing that
        // fails about half the time with no error on either screen — this side
        // still drawing its code, the other side told the room is taken.
        //
        // Nothing in the repository could see it. The only macOS pairing
        // endpoint any acceptance drives is `AppPairLinkHost`, which is headless,
        // has no `TransferPresence` and therefore never installs this observer;
        // `native-web-pairing-acceptance.sh` proves both role assignments
        // against that host and passes. It took the built app joining a real
        // code to produce it.
        //
        // So the two questions are separated. A room this module opened with a
        // code is available for the peer that code names, because that peer is
        // the entire reason the room is open. Everything else is unchanged: a
        // request still has to come from a peer that announced `link/1` in this
        // room, `linkRole` still decides which side may offer, admission still
        // refuses a second peer while one is held, and the SAS is still compared.
        let available = presence.$owner
            .combineLatest(link.$connection)
            .map(Self.acceptsInboundLink)
            .eraseToAnyPublisher()
        link.observeAvailability(available)
        // Surface-idle keeps the STRICTER question, and has to. It closes a room
        // that was handed to the legacy path once nothing owns the surface, and
        // a watched pairing room is precisely a surface somebody owns.
        link.observeSurfaceIdle(idle)
        // The relay. `objectWillChange` fires before the value is written, which
        // is the contract SwiftUI already relies on for a directly observed
        // object, so forwarding it keeps a module-observing view redrawing on
        // exactly the same edges a four-object-observing one did.
        for child in [presence.objectWillChange.eraseToAnyPublisher(),
                      code.objectWillChange.eraseToAnyPublisher(),
                      link.objectWillChange.eraseToAnyPublisher()] {
            child.sink { [weak self] _ in self?.objectWillChange.send() }
                .store(in: &relays)
        }
    }

    /// Held for the module's life. It is the whole process's life in the app,
    /// and a test's for as long as the module is referenced.
    private var relays: Set<AnyCancellable> = []

    /// **Whether this module may admit an inbound `link/1` right now.**
    ///
    /// A free function of two facts rather than an expression buried in a
    /// `map`, because it is a correctness rule with a defect behind it and a
    /// rule nothing can call is a rule nothing can check.
    ///
    /// The first clause is the original one: nothing owns the surface, so an
    /// unsolicited link may take it. The second is the repair. Minting or
    /// joining a code claims this module's surface BEFORE the room is watched,
    /// so from the moment a code exists the first clause is false and
    /// `LinkAdmission.route` answered every inbound request into that still-idle
    /// room with `.busy`. `linkRole` decides which side asks, so the visible
    /// symptom was a cross-network pairing that failed roughly half the time —
    /// the half where this side was the offerer — with no error on either screen.
    ///
    /// A room this module opened with a code is available for the peer that code
    /// names, because that peer is the entire reason the room is open. It is
    /// deliberately `isWatchingPairingRoom` and not "the link is doing
    /// something": `.requesting`, `.establishing` and `.open` all mean a peer has
    /// already been admitted, and answering `available` then would invite a
    /// SECOND one into a module that holds one session.
    ///
    /// **That strictness is safe, and it is not what refuses the peer already
    /// being connected to.** This answer is ADVISORY: `LinkAdmission` consults
    /// it only for a room bound to nobody. A request or offer from the exact
    /// peer it already holds in `.requesting`/`.connecting` is answered
    /// `alreadyInFlight` without this predicate's answer being applied, so the
    /// crossing request a pairing produces cannot be refused here — the rule
    /// lives in the one object that knows both the phase and the peer, where a
    /// module observing only its own surface cannot forget it.
    static func acceptsInboundLink(owner: AppDestination?,
                                   connection: LinkWorkspaceConnection) -> Bool {
        owner == nil || connection.isWatchingPairingRoom
    }

    /// Anything live or retained in this module, and nothing about the other.
    ///
    /// "Retained" is load-bearing: a `.completed` receive keeps its result view,
    /// its Reveal in Finder and its drag-out promise, so the connect controls
    /// must stay refused until the user has actually left it.
    ///
    /// Deliberately NOT the release rule below. This answers "is there a session
    /// to draw, or to refuse a second start for", and `link.hasSession` is false
    /// for a `.watching` pairing room because a watched room is not a session:
    /// the code, its QR and its expiry are the legacy lane's `.showingCode`, and
    /// putting an empty link pane over them would be the wrong screen. Whether
    /// the surface may be GIVEN UP is a different question with a different
    /// answer — see `retainsWork`.
    public var sessionIsLiveOrRetained: Bool {
        code.state.isActive || link.hasSession
    }

    /// **Whether anything in this module still holds work, in ANY lane.**
    ///
    /// The one predicate that decides when this module's surface may be
    /// released, and the repair for a shipped invariant violation: `owner == nil`
    /// while a legacy model or the `LinkWorkspaceModel` still held work.
    ///
    /// Two creator-side paths reached that state, and both of them released the
    /// surface from a view that had looked at ONE lane:
    ///
    ///  1. **The protocol handoff — a LATENT one, and the reason this is a rule
    ///     rather than a patch.** A creator sits in `files == .showingCode` with
    ///     the room watched. When the peer announces `link/1`,
    ///     `pairingPeerAnnounced` publishes `.requesting` and only then calls
    ///     `onPairingLinkActivated`, which cancels the legacy model that was
    ///     rendering the code. The file lane going `.idle` is not the session
    ///     ending — it is the session being handed to the link — and a release
    ///     keyed on that lane alone gives the surface up under a live `link/1`.
    ///     `pane` then answers `.connect` for a module whose
    ///     `sessionIsLiveOrRetained` is true, so the connect screen draws
    ///     `transfer.busyElsewhere` over a link with no exit anywhere on it.
    ///
    ///     Measured in the built app, the shipped pane did NOT reach that state
    ///     on this path: both publishes land in one main-actor turn, so the one
    ///     SwiftUI update that follows already sees `linkHasSession`, swaps the
    ///     session pane out for the link pane, and the removed pane's `onChange`
    ///     is never delivered. That is a coincidence of update ordering, not a
    ///     guarantee — SwiftUI promises neither delivery nor suppression for a
    ///     view removed in the same pass, and the ordering only holds while
    ///     `beginLinkAttempt` publishes before the callback. So the release is
    ///     made safe here instead of being left to depend on it.
    ///  2. **Cancelling or expiring a creator's code — the observed failure.**
    ///     Ending only the legacy lane left `.watching(code:)` alive with its
    ///     socket. `watchPairingCode` refuses a second room while one is held,
    ///     so the NEXT code minted in that process was never watched and fell
    ///     back to the legacy wire; the real macOS acceptance reproduces exactly
    ///     that against the shipped pane. It is repaired at its source by
    ///     `cancelPairingCode()`; this predicate is what stops a partial cancel
    ///     from ever being mistaken for an idle module again.
    ///
    /// So the link contributes `connection != .idle` — WIDER than `hasSession`,
    /// because `.watching` is work this module holds even though nothing is
    /// drawn for it.
    ///
    /// It is the same predicate `TransferPresence.observeSessions(fileModel:
    /// textModel:link:)` subscribes to, expressed once so the app-scoped
    /// observer and every surface-local release cannot disagree — and they did:
    /// the observer was already right, and only the view was wrong.
    public static func retainsWork(files: RealtimeState,
                                   text: RealtimeTextState,
                                   link: LinkWorkspaceConnection) -> Bool {
        files != .idle || text != .idle || link != .idle
    }

    /// **The same rule for a composition whose only transport is `link/1`.**
    ///
    /// An overload rather than a replacement: the three-argument form above is
    /// what `TransferPresence.observeSessions(fileModel:textModel:link:)` reads
    /// and what the paused iOS implementation subscribes to, and it keeps
    /// answering exactly what it answers today.
    ///
    /// The code is a liveness source in its own right and the link is not enough
    /// without it. A creator holds six digits on screen while `connection` is
    /// only `.watching` — work the module holds with no session drawn for it —
    /// and, before the room is even joined, while a mint is in flight and
    /// `connection` is still `.idle`. A link-only predicate reports idle through
    /// both, and the app-scoped observer would release the surface under a code
    /// the user is reading out loud.
    ///
    /// `.failed` counts too, and that is not an oversight: a mint that failed is
    /// a message the user has not read yet, and releasing the surface would take
    /// it off screen before they could.
    public static func retainsWork(code: PairingCodeState,
                                   link: LinkWorkspaceConnection) -> Bool {
        code.isActive || link != .idle
    }

    /// This module's own answer to the rule above.
    public var retainsWork: Bool {
        Self.retainsWork(code: code.state, link: link.connection)
    }

    /// **Give this module's surface up — and only when nothing still holds
    /// work.**
    ///
    /// Always `presence.release(route)` and never `releaseAll()`: only the owner
    /// may let go, so naming this module's own route turns a stale caller into a
    /// refusal rather than into a blanked surface somebody else is drawing.
    ///
    /// Reports whether it actually released, so a caller that must not proceed
    /// on a still-busy module can tell the difference — and so a test can assert
    /// the refusal rather than infer it from an unchanged owner.
    @discardableResult
    public func releaseSurfaceIfIdle() -> Bool {
        guard !retainsWork else { return false }
        presence.release(route)
        return true
    }

    /// **End a pairing code this module opened: the legacy lane that holds the
    /// digits AND the `link/1` room watch that was opened alongside them.**
    ///
    /// Minting and joining both watch the room before there is a peer —
    /// `PairingCodeStart.createAndWatch` / `joinAndWatch` — so a cancel that
    /// ended only the lane rendering the code left `.watching(code:)` and its
    /// socket alive with nothing on screen pointing at them. The next code that
    /// process minted was then refused a room by `watchPairingCode`, minted
    /// digits nothing was watching, and fell back to the legacy wire.
    ///
    /// **The order is the correctness.** The lane goes first and the room
    /// second, and no intermediate state is all-idle: while the room is still
    /// watched `retainsWork` is true, so neither the release below nor the
    /// app-scoped liveness observer can give the surface up half way through —
    /// which is what `observeSurfaceIdle` would turn into closing a room the
    /// user had not finished with. `leave()` is idempotent and `dismiss()`
    /// clears only an ended connection, so both are safe on a module whose link
    /// never left `.idle` — a legacy fallback, or a joiner whose lane is the
    /// only thing to end.
    public func cancelPairingCode() {
        code.cancel()
        link.leave()
        link.dismiss()
        // A refusal the user has not read is not a reason to keep the surface,
        // but it IS the message the connect screen is about to draw — cleared
        // here because cancelling is the user acting on it.
        link.dismissUnsupportedPairingPeer()
        releaseSurfaceIfIdle()
    }

    /// Whether bytes are moving in this module. Asked by the sidebar marker and
    /// by the quit guard, and deliberately separate from ownership — a finished
    /// transfer still owns its surface while nothing is running.
    /// **A watched code is not busy**, and neither is a link that has ended:
    /// the question is whether quitting now would interrupt something, and the
    /// link's file lane is the only thing here that can be mid-byte.
    public var isBusy: Bool {
        guard link.connection.isOpen, let files = link.fileModel else { return false }
        return files.batches.contains { !$0.isTerminal }
    }

    /// The only copy of text the user has typed in this module, if any. The quit
    /// guard asks both modules, because quitting discards whichever module holds
    /// one.
    /// **The link's transcript is local-only and unrecoverable** —
    /// `link.historyIsLocal` says so on the surface — so any message at all,
    /// sent or received, is content a quit would destroy.
    public var hasLocalText: Bool { link.holdsLocalText }

    /// What this module's screen draws right now.
    /// Ownership alone decides whether this module draws anything;
    /// `link.hasSession` only picks which pane the owner draws. A claim with no
    /// published state yet still answers `.connect` — ownership is taken
    /// synchronously before the link can publish — and the connect surface draws
    /// the code, or nothing, for that window.
    public var pane: LinkTransferPane {
        guard presence.owner == route else { return .connect }
        return link.hasSession ? .link : .connect
    }

    /// Whether this module's connect controls may start something.
    ///
    /// Asked of THIS module only. A session on the other module is not a reason
    /// to refuse one here — that refusal was the shared-model era's, and it is
    /// exactly what the owner asked to have removed.
    public var acceptsNewSession: Bool {
        TransferSurfacePresentation.acceptsNewSession(
            owner: presence.owner, sessionIsLiveOrRetained: sessionIsLiveOrRetained)
    }

    /// End everything this module holds, and touch nothing outside it.
    ///
    /// The one path with no destination to ask — the quit guard's confirmed
    /// Quit, and a sign-out's teardown. It is deliberately the module's own
    /// `releaseAll`, not an app-wide one: an app-wide release would be a
    /// cross-module reach from the object whose whole purpose is not having one.
    ///
    /// Order matters. The link leaves before it is dismissed, because `dismiss`
    /// only clears a connection that has already ended; and ownership is given up
    /// last, so nothing observing this module sees an unowned surface while a
    /// model is still winding down.
    ///
    /// **`reset()` on the text lane rather than `end()`**, and that is a real
    /// difference. `end()` publishes `.ended` — a *retained terminal* state — so
    /// a module torn down that way still reports `sessionIsLiveOrRetained` and
    /// its connect controls stay refused for the rest of the process. That was
    /// invisible while the only caller was a quit that terminates immediately
    /// afterwards; it is not invisible for any other caller, and a teardown that
    /// leaves a module permanently unable to start a session is not a teardown.
    /// Discarding the text history with it is authorized: the only path here is
    /// a Quit the user confirmed against a prompt that names exactly that loss
    /// (`QuitPresentation.risk`).
    public func cancelEverything() {
        code.cancel()
        link.leave()
        link.dismiss()
        link.dismissUnsupportedPairingPeer()
        presence.releaseAll()
    }
}

/// The two modules macOS composes, injected once so a view can name the one it
/// draws.
///
/// A container rather than two `@EnvironmentObject`s, because SwiftUI's
/// environment is keyed by TYPE: two `TransferModule`s cannot both be in it, and
/// two wrapper types whose only difference is their name would be a distinction
/// nothing enforces. This way the shell reads `modules.nearby` and
/// `modules.direct` by name and hands each destination exactly one.
///
/// **macOS only.** iOS composes one shared set of models across its Nearby and
/// Direct tabs and one `TransferPresence` to arbitrate them; that is a
/// deliberately different product with a different surface budget, and giving it
/// a second full model graph is not this change's business.
@MainActor
public final class TransferModules: ObservableObject {
    public let nearby: TransferModule
    public let direct: TransferModule

    public init(nearby: TransferModule, direct: TransferModule) {
        self.nearby = nearby
        self.direct = direct
    }

    /// The module that draws `route`, or nil for a destination that draws none.
    ///
    /// No `default:` — a seventh destination has to state whether it is a
    /// transfer module rather than silently inherit "no".
    public func module(for route: AppDestination) -> TransferModule? {
        switch route {
        case .nearby:       return nearby
        case .pairingCode:  return direct
        case .storedSend, .storedReceive, .deviceInbox, .account: return nil
        }
    }

    /// Every module, for the paths that genuinely mean all of them: the quit
    /// guard's risk question and its confirmed teardown.
    public var all: [TransferModule] { [nearby, direct] }

    /// Whether ANY module has bytes moving.
    public var isBusy: Bool { all.contains { $0.isBusy } }

    /// Whether ANY module holds the only copy of typed text.
    public var hasLocalText: Bool { all.contains { $0.hasLocalText } }

    /// End every module. Used by the quit guard once the user has confirmed, and
    /// by nothing else — a per-module Cancel must never reach this.
    public func cancelEverything() { all.forEach { $0.cancelEverything() } }
}
