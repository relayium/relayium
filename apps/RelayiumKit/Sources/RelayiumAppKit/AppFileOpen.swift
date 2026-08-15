import Foundation

/// Files the OS handed this app, together with the destination that will send
/// them.
///
/// The destination travels *with* the files rather than being re-derived by
/// whichever pane happens to look: three panes own three independent
/// `SelectionStore`s, so "which of you is this for" has to be one answer decided
/// once, not three panes each concluding it is them.
public struct OpenedFiles: Equatable, Sendable {
    public let destination: AppDestination
    public let urls: [URL]

    public init(destination: AppDestination, urls: [URL]) {
        self.destination = destination
        self.urls = urls
    }
}

/// The OS hand-off point for "open these files with Relayium" — a Finder
/// **Open With**, a drop on the Dock icon, or a double-click once Relayium is
/// the chosen handler.
///
/// It exists for the same reason `AppDeepLinkRouter` does, and one sharper one.
/// `application(_:open:)` can fire before any scene exists: dropping files on
/// the Dock icon of an app that is not running *is* the launch, and the OS
/// delivers them during it. `@Published` replays its current value to a late
/// subscriber, so the shell that mounts afterwards still sees them.
///
/// It holds URLs and nothing else. Where they go and what they mean is
/// `AppFileOpenCoordinator`'s, exactly as parsing-versus-applying is split on
/// the link path.
@MainActor
public final class AppFileOpenRouter: ObservableObject {
    /// Accepted file URLs waiting for the shell, or nil when nothing is waiting.
    ///
    /// Never an empty array: an open whose every URL was rejected leaves this
    /// alone rather than publishing `[]`, so a subscriber can treat non-nil as
    /// "there is something to do" without also checking the count.
    @Published public private(set) var pending: [URL]?

    public init() {}

    /// Accept one OS hand-off. Returns whether anything survived filtering.
    ///
    /// **Appends rather than replaces**, which is the opposite of the link
    /// router's newest-wins rule, and deliberately: two links are two things the
    /// user asked for and the older one is superseded, while two batches of
    /// files are two batches they want SENT. `SelectionStore.add` makes the same
    /// call for the same reason. De-duplication is by standardized path, so the
    /// same file opened twice stages once.
    @discardableResult
    public func open(_ urls: [URL]) -> Bool {
        // `droppedFileURL(from:)` already answers "is this a file URL, and what
        // is its canonical spelling" for the drop zone. Reusing it is what keeps
        // a folder dragged to the Dock and the same folder dropped on the window
        // from being two different staged items.
        let accepted = urls.compactMap { droppedFileURL(from: $0) }
        guard !accepted.isEmpty else { return false }
        var merged = pending ?? []
        var seen = Set(merged.map(\.path))
        for url in accepted where seen.insert(url.path).inserted {
            merged.append(url)
        }
        // Guard the write: a re-open of only files already pending must not
        // publish, or the shell re-delivers a batch it has already navigated for.
        guard merged != pending else { return false }
        pending = merged
        return true
    }

    /// Clear `pending` only if it is still exactly what the caller acted on.
    ///
    /// Same hazard the link router's expected-value `consume` exists for, and
    /// more likely here: selecting twenty files in Finder and choosing Open With
    /// can arrive as several calls, and a bare clear would drop the batches that
    /// landed while the first one's main-actor turn was still queued.
    public func consume(_ expected: [URL]) {
        guard pending == expected else { return }
        pending = nil
    }
}

/// Where opened files go, and what keeps them from landing on a surface that
/// cannot send them.
///
/// It mirrors `AppDeepLinkCoordinator`'s split — navigate now, hand to the
/// models when it is safe — with the safety question answered by the *pane*
/// rather than here. That is not a shortcut: "is this surface mid-transfer" is
/// three panes' own `busy`, and a coordinator that re-derived it would need all
/// three send models to answer a question each pane already has to hand.
///
/// It never sends. Opening a file is an instruction about *what*, never about
/// *to whom* — the device, the pairing code and the account are all still the
/// user's next choice, so this stages a selection and stops.
@MainActor
public final class AppFileOpenCoordinator: ObservableObject {
    /// The batch waiting for its destination's pane to take it.
    ///
    /// Retained rather than dropped when that pane is busy, and — unlike the
    /// link coordinator's `waiting` — public, because the pane it is addressed
    /// to is the reader. There is no privacy cost here that made the link
    /// version internal: a file URL is a path the user just chose in Finder, not
    /// a decryption key.
    @Published public private(set) var staged: OpenedFiles?

    private let navigation: AppNavigationModel

    public init(navigation: AppNavigationModel) {
        self.navigation = navigation
    }

    /// One batch from the OS: navigate now, stage for the pane that lands there.
    ///
    /// The selection write is unconditional, for the reason the link path's is:
    /// `AppNavigationModel.select` assigns and nothing else, and a Finder action
    /// that produced no visible response would read as the app ignoring it.
    public func deliver(_ urls: [URL]) {
        guard !urls.isEmpty else { return }
        let destination = AppRouting.destination(forOpenedFiles: navigation.selection)
        navigation.select(destination)
        // Merged under the destination decided *now*, and merged only with a
        // batch already addressed to that same destination.
        //
        // There used to be a second arm: the two macOS transfer routes were
        // separate screens over one staging context, so a batch waiting for LAN
        // Transfer was inherited by the pairing screen. Both are connect-first
        // now — neither stages anything before a session exists and neither
        // adopts an opened batch — so there is no shared context left to
        // inherit through, and the exception is gone rather than dormant.
        var merged = staged?.destination == destination ? staged?.urls ?? [] : []
        var seen = Set(merged.map(\.path))
        for url in urls where seen.insert(url.path).inserted {
            merged.append(url)
        }
        staged = OpenedFiles(destination: destination, urls: merged)
    }

    /// What this destination's pane should stage right now, or nil.
    ///
    /// The whole adoption rule, in one place rather than re-derived per pane —
    /// which is how the two halves drift apart.
    ///
    /// **Refused while that pane is busy, and retained rather than dropped.**
    /// A pane mid-transfer disables its drop zone, so staging into it from a
    /// side door would contradict the rule the user can see. Returning nil
    /// leaves `staged` alone, and the pane's `task(id:)` asks again the moment
    /// `busy` goes false — so the files land as soon as they legitimately can
    /// instead of being silently discarded.
    ///
    /// **One destination, exactly.** There was a `forAnyOf:` overload for the
    /// two macOS transfer routes, which shared one staging context; they are
    /// connect-first now and adopt nothing, so the widened form has no caller
    /// and is gone. A batch is taken by the pane it was addressed to or by
    /// nobody.
    public func batch(for destination: AppDestination, busy: Bool) -> OpenedFiles? {
        guard !busy, let staged, staged.destination == destination else { return nil }
        return staged
    }

    /// The addressed pane has staged these files. Clears only an exact match, so
    /// a batch that arrived during the pane's main-actor turn survives.
    public func consume(_ expected: OpenedFiles) {
        guard staged == expected else { return }
        staged = nil
    }
}

/// The two facts a send pane's adoption depends on, as one `Equatable` value.
///
/// It exists because `task(id:)` is the only macOS 13 tool for "re-run when this
/// changes", and adoption depends on **both** a new batch arriving and the pane
/// going idle. Keyed on the batch alone, a batch that arrived mid-transfer would
/// never be adopted: no later publish carries it, so nothing would re-ask.
public struct FileOpenAdoption: Equatable {
    public let staged: OpenedFiles?
    public let busy: Bool

    public init(staged: OpenedFiles?, busy: Bool) {
        self.staged = staged
        self.busy = busy
    }
}
