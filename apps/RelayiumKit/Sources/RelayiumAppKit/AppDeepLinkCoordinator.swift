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

    private let navigation: AppNavigationModel
    private let download: CloudDownloadModel
    private let realtime: RealtimeSessionModel
    private let realtimeText: RealtimeTextSessionModel
    /// Live only while a link is waiting, and — see `watchForIdle` — subscribed
    /// to the busy BOUNDARIES rather than to every publish. Both halves matter:
    /// this way a waiting link costs a handful of wake-ups for the whole
    /// transfer it is waiting on, and a transfer with no link waiting costs
    /// nothing at all.
    private var watch: Set<AnyCancellable> = []

    public init(navigation: AppNavigationModel,
                download: CloudDownloadModel,
                realtime: RealtimeSessionModel,
                realtimeText: RealtimeTextSessionModel) {
        self.navigation = navigation
        self.download = download
        self.realtime = realtime
        self.realtimeText = realtimeText
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
        case let .realtime(code):
            guard code != nil else { return true }
            // BOTH, even though only one of them will end up carrying the
            // session. The URL does not say whether the sender chose files or
            // text, so the two fields have to stay in step — and prefilling the
            // idle half while the other half is mid-session would leave the two
            // pickers disagreeing about which code this device is joining.
            return !realtime.isBusy && !realtimeText.isBusy
        }
    }

    private func apply(_ link: AppDeepLink) {
        switch link {
        case let .download(url):
            download.linkText = url.absoluteString
            // Metadata and the encrypted manifest only. Nothing is written to
            // disk until the user chooses to save.
            download.resolve()
        case let .realtime(code):
            // A code-less link is FULLY handled by the selection its delivery
            // already made — which is why `canApply` calls it safe rather than
            // queueing it behind a live session. There is nothing to write here
            // and nothing left to wait for.
            if let code {
                realtime.updateJoinCode(code)
                realtimeText.updateJoinCode(code)
            }
        }
    }

    /// Nothing is waiting any more: drop the retained link and stop listening.
    private func settle() {
        waiting = nil
        watch.removeAll()
    }

    /// Listen for the models going quiet, without a view being mounted.
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
    /// user did. `busyChanges` maps `$state` and drops duplicates, so what
    /// arrives here is the boundaries themselves.
    private func watchForIdle() {
        guard watch.isEmpty else { return }
        for edges in [download.busyChanges,
                      realtime.busyChanges,
                      realtimeText.busyChanges] {
            // The edge's VALUE is deliberately ignored. Acting only on a falling
            // one would save a wake-up per transfer start and cost the property
            // that makes this safe: every edge re-asks `canApply`, which is the
            // whole question, rather than this closure deciding from one model
            // which of three the answer depends on. It also means the current
            // value each publisher emits on subscribe re-checks immediately.
            edges.sink { _ in
                // `@Published` fires on **willSet**, so the model still reads
                // its OLD state inside this closure — `busyChanges` carries the
                // new value, but `canApply` consults all three models and two of
                // them were not the ones that changed. The check therefore
                // happens on the next main-actor turn, when the new state is
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
