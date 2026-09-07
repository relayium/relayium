import Foundation

/// A link anyone can open, or a delivery to one of the account's own devices.
///
/// The two are not variants of one thing and must never be collapsed into one
/// button that "does the right thing". They differ in who can read the files,
/// where the decryption key goes, and what a success means:
///
///  * a **link** publishes a stored object and puts the content key in the URL
///    fragment, so whoever holds that link can open it. Success means the
///    ciphertext is on the server;
///  * a **device delivery** seals the content key to one device's current public
///    key, produces no link at all, and is not finished until that device
///    reports it has written the files to disk.
///
/// So the choice is the user's, it is made before anything is encrypted, and
/// neither option is entered by default from the other's failure.
public enum SendRoute: String, Equatable, Sendable, CaseIterable {
    /// The existing anonymous capability link. Unchanged by P3A, and still the
    /// only way to send to somebody who is not this account.
    case link
    /// One of the account's own Macs or CLI receivers.
    case device
}

/// Which of the two a screen is currently offering.
///
/// **Composed by nothing, as of iOS 0.3.0, and kept deliberately.**
///
/// It existed for one surface: the iOS Send tab's segmented *As a link / To a
/// device* control. That control is gone, because the distinction above is not
/// one a user should be able to slide past — it is now made by WHICH
/// DESTINATION you are on, which is how macOS has always made it (see
/// `DeviceSendSection`, whose own comment cites the type above as its argument).
/// Send is stored links; a device delivery starts from that device's Device
/// Inbox conversation.
///
/// What remains is `SendRoute` itself — the shared statement of why the two are
/// different products, which both platforms' compositions are built to respect —
/// and this holder, which is the reversible half. Neither shell renders either
/// today; `InboxSendPresentation.label(for:)` and `.explanation(for:)`, and the
/// `send.chooseHow` copy behind them, are likewise unrendered rather than
/// deleted. If a surface ever needs to offer both again it must be app-scoped
/// for the reason `DirectModeSelection` is — SwiftUI tears off-screen surfaces
/// down, and a `@State` would silently reset the user's choice to the OTHER kind
/// of send.
@MainActor
public final class SendRouteSelection: ObservableObject {
    @Published public private(set) var route: SendRoute

    /// Defaults to the link, which is the flow that already existed. A default
    /// of `.device` would silently change what the Send button does for every
    /// existing user, including those with no device that can receive.
    public init(route: SendRoute = .link) {
        self.route = route
    }

    public func select(_ route: SendRoute) {
        self.route = route
    }
}
