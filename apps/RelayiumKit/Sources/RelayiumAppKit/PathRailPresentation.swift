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

    /// The same three stops, from a device that is not a Mac.
    ///
    /// One word differs — the origin — and it is the only word that could be
    /// false here. Everything else about a stored send is identical on both
    /// platforms, so the stage arithmetic is the macOS function's rather than a
    /// second copy that can drift from it: a rail that advanced differently on
    /// one platform would be the exact false-completion bug `PathStop` exists to
    /// prevent.
    public static func iosStoredSend(_ state: UploadState,
                                     language: AppLanguage? = nil) -> [PathStop] {
        storedSend(state, language: language).map { stop in
            guard stop.id == 0 else { return stop }
            return PathStop(id: stop.id,
                            // nonlocalized: SF Symbol name
                            symbol: "iphone",
                            title: L10n.t(.pathThisDevice, language: language),
                            detail: stop.detail,
                            progress: stop.progress)
        }
    }

    /// A delivery to one of the account's own devices, from the sending side.
    ///
    /// Not `deviceInbox`, which is the same route seen from the far end — that
    /// rail is drawn on the Mac that RECEIVES, so its origin is the account and
    /// its destination is that Mac. Here the user is the sender, and stating it
    /// the other way round would put this device at the end of a delivery it is
    /// about to start.
    ///
    /// No progress, for the reason every standing route has none: the middle
    /// stop is ciphertext waiting on Relayium, and the delivery list directly
    /// below states in words what each individual send is actually doing.
    public static func iosDeviceSend(language: AppLanguage? = nil) -> [PathStop] {
        [
            // nonlocalized: SF Symbol name
            PathStop(id: 0, symbol: "iphone",
                     title: L10n.t(.pathThisDevice, language: language)),
            // nonlocalized: SF Symbol name
            PathStop(id: 1, symbol: "lock.fill",
                     title: L10n.t(.pathEncryptedOnRelayium, language: language)),
            // nonlocalized: SF Symbol name.
            //
            // NOT the Mac rails' `macbook.and.iphone`, which SF Symbols first
            // shipped in iOS 16.1 — one minor version above this app's 16.0
            // floor, where it would render as nothing at all and leave the far
            // end of the rail an empty circle. `laptopcomputer.and.iphone` is
            // the same pair of devices, back to iOS 14.
            PathStop(id: 2, symbol: "laptopcomputer.and.iphone",
                     title: L10n.t(.pathOtherDevice, language: language)),
        ]
    }

    /// A nearby transfer's standing route, from this device to the one the user
    /// picks, with an encrypted middle and no claim about its shape.
    ///
    /// Every `progress` is nil, for `lan`'s reason: the rail is drawn while the
    /// roster is still being chosen from, so there is no position to be part of
    /// the way along — and it must not imply that picking a device has already
    /// connected to it.
    public static func iosNearby(language: AppLanguage? = nil) -> [PathStop] {
        [
            // nonlocalized: SF Symbol name
            PathStop(id: 0, symbol: "iphone",
                     title: L10n.t(.pathThisDevice, language: language)),
            // nonlocalized: SF Symbol name
            PathStop(id: 1, symbol: "lock.fill",
                     title: L10n.t(.pathEncryptedConnection, language: language)),
            // nonlocalized: SF Symbol name — `iosDeviceSend` records why this is
            // not the Mac rails' `macbook.and.iphone`.
            PathStop(id: 2, symbol: "laptopcomputer.and.iphone",
                     title: L10n.t(.pathOtherDevice, language: language)),
        ]
    }

    /// A pairing-code transfer's standing route — which is the SAME route the
    /// nearby rail states, deliberately drawn from the same function.
    ///
    /// The two direct destinations differ only in how the two devices find each
    /// other: six digits read onto the other device, or a rendezvous room
    /// grouped by the public address the server observes. Neither of those is a
    /// stop. Both ends are still devices, the middle is still an encrypted
    /// connection whose shape the client cannot prove, and both surfaces drive
    /// the same two models — so a second copy of these three stops would be free
    /// to drift from the one the user reaches in two taps.
    ///
    /// Every `progress` is nil for the reason every standing route's is, and
    /// here the temptation is sharper than anywhere else: a code that has been
    /// created is not a device that has answered it, and a rail that advanced on
    /// `.showingCode` would draw the far end of a transfer nobody has joined.
    public static func iosPairingCode(language: AppLanguage? = nil) -> [PathStop] {
        iosNearby(language: language)
    }

    // MARK: - Device Inbox

    /// **A standing route, with no progress at all — and no second copy of a
    /// fact another section owns.**
    ///
    /// Every stop's `progress` is nil, and that is the whole point: the Device
    /// Inbox is not a task with a position — it is a permanent path that
    /// deliveries travel one at a time, and the live per-delivery state is
    /// already stated in words by the status badge directly above this rail.
    /// Giving the stops a progress would either duplicate that sentence or
    /// contradict it.
    ///
    /// The destination stop used to carry the receive folder as its detail, and
    /// that is the same argument pointed the other way. The surface has a folder
    /// section a short scroll below with the authoritative answer and the two
    /// buttons that change it, so the rail was printing "No folder chosen" — or
    /// an entire path, wrapped — twice on one screen, in the smaller of the two
    /// type sizes, where nothing could be done about it. A rail states the shape
    /// of the route; the section states the fact.
    public static func deviceInbox(language: AppLanguage? = nil) -> [PathStop] {
        [
            // nonlocalized: SF Symbol name
            PathStop(id: 0, symbol: "person.crop.circle",
                     title: L10n.t(.pathYourAccount, language: language)),
            // nonlocalized: SF Symbol name
            PathStop(id: 1, symbol: "lock.fill",
                     title: L10n.t(.pathEncryptedOnRelayium, language: language)),
            // nonlocalized: SF Symbol name
            PathStop(id: 2, symbol: "laptopcomputer",
                     title: L10n.t(.pathThisMac, language: language)),
        ]
    }

    /// The same route as `deviceInbox`, seen from an iPhone or iPad.
    ///
    /// One stop differs and it is the destination: `pathThisMac` names the
    /// wrong machine on a phone, and the glyph beside it draws a laptop. Both
    /// are read by somebody deciding whether the thing in their hand is where
    /// their file will land, which is the one question the rail exists to
    /// answer.
    ///
    /// Derived from `deviceInbox` rather than written out, exactly as
    /// `iosStoredSend` derives from `storedSend`: the origin and the encrypted
    /// middle are the same route and must stay one statement, so a later change
    /// to the shared shape reaches both platforms.
    public static func iosDeviceInbox(language: AppLanguage? = nil) -> [PathStop] {
        deviceInbox(language: language).map { stop in
            guard stop.id == 2 else { return stop }
            return PathStop(id: stop.id,
                            // nonlocalized: SF Symbol name
                            symbol: "iphone",
                            title: L10n.t(.pathThisDevice, language: language),
                            detail: stop.detail,
                            progress: stop.progress)
        }
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
