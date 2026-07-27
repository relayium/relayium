import AuthenticationServices
import AppKit

/// Presents the approval page and dismisses it when the caller says so.
///
/// `ASWebAuthenticationSession` is built around a callback scheme, and this flow
/// has no callback — the token arrives by polling `/api/cli/device/poll`. The
/// scheme below is therefore never reached, and the sheet is closed by
/// `dismiss()` once the poll succeeds. That reads like a bug without this
/// comment, so: it is the price of an in-app sheet that shares Safari's cookies,
/// which is what turns an existing relayium.com session into a one-click
/// approval instead of a second sign-in.
@MainActor
final class BrowserSignInPresenter: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?
    /// `cancel()` runs the completion handler too, so without this the sheet we
    /// close ourselves on success would report itself as a user cancellation —
    /// and cancel the login that had just succeeded.
    private var closingOurselves = false

    /// `onDismiss` fires only when the user closes the sheet themselves.
    func present(_ url: URL, onDismiss: @escaping () -> Void) {
        dismiss()
        closingOurselves = false
        let s = ASWebAuthenticationSession(url: url, callbackURLScheme: "relayium") { [weak self] _, _ in
            guard self?.closingOurselves != true else { return }
            // A closed sheet is a cancelled login, never an error.
            onDismiss()
        }
        s.presentationContextProvider = self
        // Shared cookies, not ephemeral: an existing relayium.com session is
        // what makes this one click.
        s.prefersEphemeralWebBrowserSession = false
        session = s
        s.start()
    }

    func dismiss() {
        guard let s = session else { return }
        session = nil          // cleared first, so the completion handler is a no-op
        s.cancel()
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        NSApplication.shared.keyWindow
            ?? NSApplication.shared.windows.first
            ?? ASPresentationAnchor()
    }
}
