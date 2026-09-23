import AuthenticationServices
import UIKit

/// Presents the device-approval page and dismisses it when told to.
///
/// **Why `ASWebAuthenticationSession`, not `openURL` into Safari.** Three
/// properties, each of which the other route loses:
///
///  1. **The app stays in the foreground.** The sheet is presented over this
///     app, so the poll loop keeps running while the user approves. Handing
///     off to Safari suspends the app, parks the poll mid-sleep, and makes
///     "return to the app" a thing the user has to find their own way back to.
///  2. **It shares Safari's cookies** (`prefersEphemeralWebBrowserSession =
///     false`), so a relayium.com session the user already has turns approval
///     into one tap instead of a second sign-in.
///  3. **Closing it is observable.** The completion reports a user
///     cancellation, which this type turns into a cancelled login — the
///     "cancel" state the flow needs and a Safari hand-off cannot report.
///
/// Like macOS, the flow has no callback: the token arrives by polling
/// `/api/cli/device/poll`. The scheme below is therefore never reached, and the
/// sheet is closed by `dismiss()` once the poll succeeds. The page never
/// carries a credential back to the app, so there is nothing to intercept.
///
/// This file and `SignInView` are the only importers of
/// `AuthenticationServices`, and this one names no Apple ID type:
/// `IOSSurfaceGuardTests` holds both.
@MainActor
final class BrowserSignInPresenter: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    /// Whether the approval sheet is (as far as this presenter knows) on screen.
    var isPresenting: Bool { session != nil }

    /// `onDismiss` fires only when the USER closes the sheet — never for a
    /// sheet this presenter closes itself on success.
    func present(_ url: URL, onDismiss: @escaping () -> Void) {
        dismiss()
        var started: ASWebAuthenticationSession?
        let s = ASWebAuthenticationSession(url: url, callbackURLScheme: "relayium") { [weak self] _, _ in
            // Only the session still held reports. `dismiss()` clears the
            // reference BEFORE cancelling, so our own close (and any older
            // sheet) arrives here as a no-op instead of cancelling a login
            // that has just succeeded.
            guard let self, let started, self.session === started else { return }
            self.session = nil
            onDismiss()
        }
        started = s
        s.presentationContextProvider = self
        s.prefersEphemeralWebBrowserSession = false
        session = s
        if !s.start() {
            // The system refused to present (no window yet, another sheet up).
            // Reported as a dismissal, so the login does not wait for an
            // approval page nobody can see.
            session = nil
            onDismiss()
        }
    }

    func dismiss() {
        guard let s = session else { return }
        session = nil
        s.cancel()
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let active = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
        return active?.windows.first { $0.isKeyWindow } ?? active?.windows.first ?? ASPresentationAnchor()
    }
}
