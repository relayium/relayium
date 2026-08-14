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

/// Which of the two the Send screen is currently offering.
///
/// App-scoped, and for the same reason `DirectModeSelection` is: SwiftUI tears
/// off-screen tabs down and rebuilds them, so a `@State` here would silently
/// reset the user's choice every time they checked their plan mid-send — and it
/// would reset it to the OTHER kind of send, which is the one distinction on
/// this screen that must not be made on the user's behalf.
///
/// It deliberately does NOT lock while work is running. Outstanding device
/// deliveries are rendered under both routes, so switching back to the link
/// flow hides nothing and stops nothing; a lock would only strand a user who
/// wanted to send something else while a delivery waited for an offline Mac.
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
