import Foundation
import RelayiumShareKit

/// **One stop on the path a transfer takes: origin, encrypted middle, destination.**
///
/// The rail that renders these is the one piece of shared visual signature the
/// macOS surfaces have, and the whole reason it can be trusted is this type's
/// refusal to say more than the client knows:
///
///  - `progress` is an **optional**. `nil` means the rail is stating a route and
///    claiming nothing about how far along it anything is. That is the honest
///    answer on every surface whose model tracks no per-delivery position —
///    the Device Inbox's standing route, or a pairing screen before a peer
///    exists — and a `.pending`/`.reached` value there would be a fabricated
///    progress bar with a real one's authority.
///  - There is no `.direct`, `.relayed` or `.peerToPeer` stop. The middle of a
///    live transfer is `path.encryptedConnection` and stops there, because at
///    the moment this rail is drawn the client cannot tell a direct connection
///    from a TURN-relayed one, and a rail that guessed would be wrong on
///    exactly the networks a user most wants the truth about.
///  - Nothing here is a new product claim. Each string restates something the
///    same screen already says at length: the connection is verified and
///    encrypted, the stored copy is ciphertext Relayium cannot read, the key
///    rides inside the link.
public struct PathStop: Equatable, Identifiable, Sendable {
    /// How far a transfer has actually got, where — and only where — a model
    /// tracks it.
    public enum Progress: Equatable, Sendable {
        /// Finished. Never set from an assumption: a stop is `reached` only
        /// once the model that owns the step has published its completion.
        case reached
        /// Where the work is now.
        case current
        /// Not started. Rendered as an outline and never as a tick.
        case pending
    }

    public let id: Int
    /// An SF Symbol. Not localized and not decoration: it is the second carrier
    /// of the stop's meaning for anyone the tint alone does not reach.
    public let symbol: String
    /// The stop's name, already localized.
    public let title: String
    /// One live fact about this stop, already localized — the receive folder,
    /// say — or nil when there is nothing true to add.
    public let detail: String?
    /// nil when the rail states a route rather than a position along it.
    public let progress: Progress?

    public init(id: Int, symbol: String, title: String,
                detail: String? = nil, progress: Progress? = nil) {
        self.id = id
        self.symbol = symbol
        self.title = title
        self.detail = detail
        self.progress = progress
    }
}

/// The stops each macOS surface draws, derived from the state that surface's
/// model actually publishes.
///
/// A pure seam, in the package, so the rails are unit-tested against real model
/// states rather than eyeballed in a screenshot: the failure that matters is a
/// rail that shows a step complete before it is, and that is a mapping bug, not
/// a rendering one.
public enum PathRailPresentation {
    /// The rail's own accessibility name, so the stops read as one group rather
    /// than as loose fragments between the controls above and below them.
    public static func routeLabel(language: AppLanguage? = nil) -> String {
        L10n.t(.pathA11yRoute, language: language)
    }

    // MARK: - Send a link

    /// **The one rail with real progress, because the one model that tracks it.**
    ///
    /// `UploadState` publishes the whole task: nothing chosen, chosen,
    /// encrypting and uploading, and a finished link. So each stop's progress is
    /// read from it and from nothing else.
    ///
    /// `.failed` is deliberately NOT a fourth stop and does not advance
    /// anything: a failure leaves the user back at the step they can retry, and
    /// marking the upload stop `reached` because bytes had moved before it broke
    /// would be the exact false completion this type exists to prevent. The
    /// failure itself is stated in words by the pane, where it can be acted on.
    ///
    /// `.interrupted` and `.restarting` are the same argument: work has started
    /// and has not finished, which is precisely `current`.
    public static func storedSend(_ state: UploadState,
                                  language: AppLanguage? = nil) -> [PathStop] {
        let stage: Int
        switch state {
        case .idle, .failed, .picked, .checkingRecovery:
            stage = 0
        case .preparing, .uploading, .interrupted, .restarting:
            stage = 1
        case .done:
            stage = 2
        }
        let titles = [
            L10n.t(.pathThisMac, language: language),
            L10n.t(.pathEncryptedOnRelayium, language: language),
            L10n.t(.pathAnyoneWithLink, language: language),
        ]
        // nonlocalized: SF Symbol names
        let symbols = ["laptopcomputer", "lock.fill", "link"]
        return (0..<3).map { index in
            PathStop(id: index,
                     symbol: symbols[index],
                     title: titles[index],
                     progress: index < stage ? .reached
                             : index == stage ? .current : .pending)
        }
    }

    // MARK: - Device Inbox

    /// **A standing route, with no progress at all.**
    ///
    /// Every stop's `progress` is nil, and that is the whole point: the Device
    /// Inbox is not a task with a position — it is a permanent path that
    /// deliveries travel one at a time, and the live per-delivery state is
    /// already stated in words by the status badge directly above this rail.
    /// Giving the stops a progress would either duplicate that sentence or
    /// contradict it.
    ///
    /// The destination stop carries the one fact the route is useless without:
    /// which folder on this Mac, or that none is chosen yet.
    public static func deviceInbox(folder: InboxFolderSummary,
                                   language: AppLanguage? = nil) -> [PathStop] {
        [
            // nonlocalized: SF Symbol name
            PathStop(id: 0, symbol: "person.crop.circle",
                     title: L10n.t(.pathYourAccount, language: language)),
            // nonlocalized: SF Symbol name
            PathStop(id: 1, symbol: "lock.fill",
                     title: L10n.t(.pathEncryptedOnRelayium, language: language)),
            // nonlocalized: SF Symbol name
            PathStop(id: 2, symbol: "laptopcomputer",
                     title: L10n.t(.pathThisMac, language: language),
                     detail: InboxFolderPresentation.description(folder, language: language)),
        ]
    }

    // MARK: - Cross-network Transfer

    /// **Two ends and an encrypted middle, and no claim about the middle's
    /// shape.**
    ///
    /// Drawn on the connect screen, where there is no peer yet — so there is
    /// nothing to be part-way through and every `progress` is nil. What it is
    /// for is the one thing the screen's controls cannot show: that both ends
    /// are devices and the part in between is encrypted, whatever route it
    /// takes. Which route it takes is not knowable here, so it is not named.
    public static func crossNetwork(language: AppLanguage? = nil) -> [PathStop] {
        [
            // nonlocalized: SF Symbol name
            PathStop(id: 0, symbol: "laptopcomputer",
                     title: L10n.t(.pathThisMac, language: language)),
            // nonlocalized: SF Symbol name
            PathStop(id: 1, symbol: "lock.fill",
                     title: L10n.t(.pathEncryptedConnection, language: language)),
            // nonlocalized: SF Symbol name
            PathStop(id: 2, symbol: "macbook.and.iphone",
                     title: L10n.t(.pathOtherDevice, language: language)),
        ]
    }

    /// The same factual route for a LAN transfer: two devices with an encrypted
    /// connection between them, without inventing progress before a peer is
    /// selected or claiming that the path is direct rather than relayed.
    public static func lan(language: AppLanguage? = nil) -> [PathStop] {
        [
            // nonlocalized: SF Symbol name
            PathStop(id: 0, symbol: "laptopcomputer",
                     title: L10n.t(.pathThisMac, language: language)),
            // nonlocalized: SF Symbol name
            PathStop(id: 1, symbol: "lock.fill",
                     title: L10n.t(.pathEncryptedConnection, language: language)),
            // nonlocalized: SF Symbol name
            PathStop(id: 2, symbol: "macbook.and.iphone",
                     title: L10n.t(.pathOtherDevice, language: language)),
        ]
    }
}
