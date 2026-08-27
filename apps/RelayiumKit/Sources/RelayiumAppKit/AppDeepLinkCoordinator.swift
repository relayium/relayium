import Combine
import Foundation

/// Everything that happens after the OS hands this app a Universal Link, in one
/// object outside the view layer.
///
/// It lives here, in the shared layer, rather than in one app target, for the
/// reason `AppRouting` does: the decision is not SwiftUI's and is not one
/// platform's. Both shells drive it — iOS through `RootView`, macOS through
/// `AppShellView` — and each of them does exactly two things with a link:
/// `deliver` it, then consume it one turn later. macOS used to apply links
/// inline instead, with no refusal at all; adopting this object is what closed
/// that.
///
/// `AppDeepLinkRouter` answers "is this a link we may act on at all" and holds
/// the parsed result. This answers the two questions that come next, and they
/// are deliberately separate:
///
///  1. **Where to go.** One `AppRouting.destination(for:)` write, made the
///     moment the link arrives and never again. Navigation is the user's own
///     tap on a link, so it is not something to hold back — and it must not be
///     replayed later, which is the whole reason application is split out.
///  2. **What to put in the models.** A link's field write and, for a download,
///     its `resolve()` are the half that can destroy work: `resolve()` restarts
///     a transfer, and `updateJoinCode` overwrites the code a live session is
///     running on. So they are refused while the work they would interrupt is
///     in flight, retained, and applied once it is safe.
///
/// **Deferred application never navigates.** That is the contract that keeps
/// "the later event wins" true: a link that arrives during a live transfer
/// selects its destination once, and if the user (or an unsolicited nearby
/// session) moves somewhere else during the wait, the field write that lands
/// afterwards leaves them there. A second selection would be the app yanking the
/// screen away minutes after anybody asked it to.
///
/// It never joins, and it never downloads. A pairing code is prefilled and a
/// stored link is resolved to its *encrypted* metadata and manifest — both are
/// reversible reads that show the user what they opened. Starting the transfer
/// stays a tap, because a link is an invitation and the device it landed on may
/// not be the one the user meant.
@MainActor
public final class AppDeepLinkCoordinator: ObservableObject {
    /// A valid link whose model write could not be made when it arrived, kept
    /// until the work it must not interrupt has stopped.
    ///
    /// At most one, and it is always the newest: a second link arriving during
    /// the wait replaces it rather than queueing behind it. Two links are two
    /// things the user asked for, and the older one is the one they have already
    /// moved on from.
    ///
    /// It is also the ONLY link this object ever holds, and it is cleared the
    /// moment it is written. Nothing keeps a history of what has been applied,
    /// and that is a privacy rule rather than tidiness: a download link IS the
    /// decryption key — `/d/<id>#k=<key>` — so a list of everything this app has
    /// ever opened would be a list of file keys living for the life of the
    /// process, readable by anything with a reference to the coordinator and
    /// present in any memory capture, for no purpose the user asked for. What a
    /// link did is proved by what the models hold and by the requests it caused;
    /// `AppDeepLinkCoordinatorTests` asserts it there.
    ///
    /// Internal, not public: nothing outside this package renders it, and a
    /// public reader would be a second way to learn a decryption key.
    @Published private(set) var waiting: AppDeepLink?

    /// **Where a pairing code from a link is written, and what has to be quiet
    /// before writing it.**
    ///
    /// A seam rather than a stored pair of models, because the two platforms
    /// keep the join field in different places and neither should have to know
    /// about the other's. iOS still types into the two legacy models — its
    /// pairing surface is still theirs — and macOS types into a
    /// `PairingCodeModel`, because its legacy transports are deleted and the
    /// field moved with the code.
    ///
    /// It is deliberately NOT an optional model or a platform `#if`: an
    /// optional would make every call site unwrap something that is always
    /// present on the platform it runs on, and a conditional would put the
    /// decision here instead of at the composition that actually knows.
    private struct CodeSink {
        /// Write the code into whatever holds the join field.
        let write: @MainActor (String) -> Void
        /// Whether the thing that would carry the session is mid-transfer.
        ///
        /// **Empty for a link-only composition, and that is not a gap.** A
        /// `PairingCodeModel` opens nothing, so it has no busy state to consult;
        /// what would be unsafe to write over is a session, and on macOS a live
        /// or retained one always owns its module's surface — which
        /// `presence.owner` already answers, for both platforms, in the same
        /// clause. The legacy pair contributes its own flags because a model can
        /// be busy in the window before ownership is taken.
        let isBusy: @MainActor () -> Bool
        /// The busy BOUNDARIES to wake on. Empty where `isBusy` is constant.
        let busyChanges: [AnyPublisher<Bool, Never>]
        /// Select files-or-text, for a legacy link that names one.
        let selectMode: @MainActor (TransferMode) -> Void
    }

    private let navigation: AppNavigationModel
    private let download: CloudDownloadModel
    private let code: CodeSink
    private let presence: TransferPresence
    /// Live only while a link is waiting, and — see `watchForIdle` — subscribed
    /// to the busy BOUNDARIES rather than to every publish. Both halves matter:
    /// this way a waiting link costs a handful of wake-ups for the whole
    /// transfer it is waiting on, and a transfer with no link waiting costs
    /// nothing at all.
    private var watch: Set<AnyCancellable> = []

    /// **The composition that still has the two legacy lanes.** iOS, and every
    /// existing caller.
    ///
    /// Unchanged in signature and in behaviour: it builds the seam above from
    /// exactly the models it always held, and every rule below reads the seam
    /// rather than the models, so the answers are the ones this initializer
    /// always produced.
    public init(navigation: AppNavigationModel,
                download: CloudDownloadModel,
                realtime: RealtimeSessionModel,
                realtimeText: RealtimeTextSessionModel,
                presence: TransferPresence,
                selectRealtimeMode: @escaping @MainActor (TransferMode) -> Void) {
        self.navigation = navigation
        self.download = download
        self.presence = presence
        self.code = CodeSink(
            write: { typed in
                // BOTH, even though only one of them will end up carrying the
                // session. A legacy URL does not say whether the sender chose
                // files or text, so the two fields have to stay in step.
                realtime.updateJoinCode(typed)
                realtimeText.updateJoinCode(typed)
            },
            isBusy: { realtime.isBusy || realtimeText.isBusy },
            busyChanges: [realtime.busyChanges, realtimeText.busyChanges],
            selectMode: selectRealtimeMode)
    }

    /// **The composition whose only transport is `link/1`.** macOS.
    ///
    /// A pairing code is held by a `PairingCodeModel` there, because the legacy
    /// transports that used to hold it are deleted — so there is one field to
    /// write and no lane to select.
    ///
    /// **No `selectRealtimeMode`, and that is the product decision rather than
    /// an omission.** `AppDeepLink.realtimeWithMode` is a link shape older
    /// senders still emit, and its `mode` names which of two legacy signalling
    /// generations to use. This composition has neither, and one `link/1`
    /// carries both lanes — so the code is honoured and the lane hint is
    /// ignored, which is exactly what a peer on this build would do with it
    /// anyway. Dropping the code as well would break a working link over a
    /// field that no longer means anything.
    public init(navigation: AppNavigationModel,
                download: CloudDownloadModel,
                pairingCode: PairingCodeModel,
                presence: TransferPresence) {
        self.navigation = navigation
        self.download = download
        self.presence = presence
        self.code = CodeSink(
            write: { [weak pairingCode] typed in pairingCode?.updateJoinCode(typed) },
            isBusy: { false },
            busyChanges: [],
            selectMode: { _ in })
    }

    /// One link from the OS: navigate now, write to the models now or later.
    ///
    /// The selection is unconditional. It is not a write that can lose anything
    /// — `AppNavigationModel.select` assigns and nothing else — and refusing it
    /// while a transfer ran would leave the user staring at the screen they were
    /// on, with no sign the link they tapped had been received at all.
    public func deliver(_ link: AppDeepLink) {
        navigation.select(AppRouting.destination(for: link))
        guard canApply(link) else {
            waiting = link
            watchForIdle()
            return
        }
        // A newer link that CAN be applied supersedes an older one still
        // waiting: the user has asked for this one instead.
        settle()
        apply(link)
    }

    /// The Account surface already holds a reconstructed stored link as text.
    /// Route it through the same parser, busy admission and one-shot retention
    /// policy as an OS-delivered Universal Link instead of letting either app
    /// target reimplement that security boundary.
    @discardableResult
    public func deliverStoredLink(_ rawLink: String) -> Bool {
        guard let url = URL(string: rawLink),
              let link = parseAppDeepLink(url),
              case .download = link else { return false }
        deliver(link)
        return true
    }

    /// Write a retained link into the models if the work it was waiting on has
    /// stopped. **No navigation write** — see the type's note.
    ///
    /// Re-reads `waiting` rather than taking a link, which is what makes a
    /// deferred call harmless when a newer link has arrived in the meantime: it
    /// applies whatever is waiting *now*, never the value some earlier turn saw.
    ///
    /// Internal: the only caller is `watchForIdle` below. `deliver` is the whole
    /// surface an app target needs.
    func applyIfSafe() {
        guard let link = waiting, canApply(link) else { return }
        settle()
        apply(link)
    }

    /// Whether writing this link into the models would interrupt live work.
    ///
    /// A code-less `/cross-network` link is always safe because it writes
    /// nothing: it is a request to look at the Direct surface, and clearing a
    /// code the user has already typed is the one thing it must not do.
    ///
    /// Internal: this is the coordinator's own rule, and a view answering it
    /// would be the shared policy re-derived where no test can reach it.
    func canApply(_ link: AppDeepLink) -> Bool {
        switch link {
        case .download:
            return !download.isBusy
        case let .realtime(typed):
            guard typed != nil else { return true }
            // Ownership plus whatever the composition's own field can be busy
            // with — see `CodeSink.isBusy`. The owner closes the earlier gap: a
            // surface is claimed synchronously, before any task has moved a
            // model out of idle, so a code cannot be prefilled under a session
            // that is starting.
            return presence.owner == nil && !code.isBusy()
        case .realtimeWithMode:
            return presence.owner == nil && !code.isBusy()
        }
    }

    private func apply(_ link: AppDeepLink) {
        switch link {
        case let .download(url):
            download.linkText = url.absoluteString
            // Metadata and the encrypted manifest only. Nothing is written to
            // disk until the user chooses to save.
            download.resolve()
        case let .realtime(typed):
            // A code-less link is FULLY handled by the selection its delivery
            // already made — which is why `canApply` calls it safe rather than
            // queueing it behind a live session. There is nothing to write here
            // and nothing left to wait for.
            if let typed { code.write(typed) }
        case let .realtimeWithMode(typed, mode):
            code.selectMode(mode)
            code.write(typed)
        }
    }

    /// Nothing is waiting any more: drop the retained link and stop listening.
    private func settle() {
        waiting = nil
        watch.removeAll()
    }

    /// Listen for the models going quiet and session ownership clearing,
    /// without a view being mounted.
    ///
    /// A `.task(id:)` on the shell would be the obvious shape and the wrong one:
    /// SwiftUI may tear an off-screen tab down and rebuild the tree at any time,
    /// and the interval this covers — a live transfer — is exactly when the user
    /// is most likely to be somewhere else in the app.
    ///
    /// **`busyChanges`, not `objectWillChange`.** The question here has exactly
    /// two answers and changes a handful of times per transfer, while the models
    /// publish continuously while working: a download republishes
    /// `.downloading(received:total:)` per chunk, and an open session publishes
    /// per message. Subscribing to every publish would spawn a main-actor `Task`
    /// for each one — thousands across a single download, every one of them
    /// asking a question whose answer is still "no" — so the stream of hops
    /// would grow with the size of the transfer rather than with anything the
    /// user did. The four streams map their state to one Boolean and drop
    /// duplicates, so what arrives here is the boundaries themselves.
    private func watchForIdle() {
        guard watch.isEmpty else { return }
        for edges in [download.busyChanges] + code.busyChanges + [presence.ownershipChanges] {
            // The edge's VALUE is deliberately ignored. Acting only on a falling
            // one would save a wake-up per transfer start and cost the property
            // that makes this safe: every edge re-asks `canApply`, which is the
            // whole question, rather than this closure deciding from one source
            // which of four the answer depends on. It also means the current
            // value each publisher emits on subscribe re-checks immediately.
            edges.sink { _ in
                // `@Published` fires on **willSet**, so the model still reads
                // its OLD state inside this closure — `busyChanges` carries the
                // new value, but `canApply` consults the models and ownership,
                // most of which were not the source that changed. The check
                // therefore happens on the next main-actor turn, when the new state is
                // actually stored. Same ordering both shells' deferred
                // `consume(_:)` exists for, and `AppDeepLinkTests` pins it on
                // the router.
                //
                // `applyIfSafe` re-reads `waiting`, so a hop that lands after a
                // newer link arrived, or after the link was applied, is a no-op
                // rather than a second write.
                Task { @MainActor [weak self] in self?.applyIfSafe() }
            }.store(in: &watch)
        }
    }
}
