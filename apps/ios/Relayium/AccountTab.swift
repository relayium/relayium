import SwiftUI
import RelayiumKit
import RelayiumAppKit

/// The whole account surface, and the only place in the app that reads
/// `session.state`.
///
/// Every hand-off goes through SwiftUI's `openURL`: the macOS app's
/// `NSWorkspace.shared.open` does not exist here, and this is the platform's
/// own mechanism rather than a UIKit call smuggled into a view.
struct AccountTab: View {
    @EnvironmentObject private var session: AccountSession
    @Environment(\.openURL) private var openURL
    let onOpenStoredLink: (String) -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                content
                    .padding()
                    // Leading, not centred: at the largest Dynamic Type sizes a
                    // centred column becomes a ragged edge on both sides.
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle(L10n.t(.tabAccount))
        }
    }

    @ViewBuilder
    private var content: some View {
        // ONE call site for the form, so its typed email and password survive
        // every transition among .loggedOut, .authenticating and .failed.
        // Which states those are, and what each shows, is decided in
        // SignInPresentation, where a test can read it.
        if let form = SignInPresentation.form(for: session.state) {
            SignInView(form: form)
        } else {
            switch session.state {
            case .restoring:
                // Labelled rather than a bare spinner: VoiceOver reads nothing
                // from one, and on a full screen it says nothing to anybody.
                ProgressView { Text(L10n.t(.accountRestoring)) }

            case let .emailUnverified(email):
                checkEmail(email: email)

            case let .pendingDeletion(purgeAfter, reactivateToken):
                notice(title: L10n.t(.contentPendingDeletionTitle),
                       body: L10n.t(.contentPendingDeletionBody, [
                           L10n.date(Date(timeIntervalSince1970: TimeInterval(purgeAfter)),
                                     dateStyle: .medium, timeStyle: .none),
                       ]),
                       actionTitle: L10n.t(.contentReactivate),
                       // The token IS the button: a frozen account cannot sign
                       // in, and the fragment is what keeps the token out of the
                       // server's access log and out of any Referer.
                       url: AppEnvironment.reactivateWebURL(token: reactivateToken))

            case let .unavailable(message):
                // A token in hand that could not load an account. Offer a retry,
                // never a sign-in form — a form cannot fix a server being down.
                VStack(alignment: .leading, spacing: 12) {
                    Text(L10n.t(.contentAccountLoadFailed)).font(.headline)
                    Text(message)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Button(L10n.t(.commonTryAgain)) { Task { await session.refresh() } }
                        .buttonStyle(.borderedProminent)
                    Button(L10n.t(.commonSignOut)) { Task { await session.logOut() } }
                        .font(.callout)
                }

            case let .ready(user, usage):
                AccountSummaryView(user: user, usage: usage,
                                   onOpenStoredLink: onOpenStoredLink)

            case .loggedOut, .authenticating, .registering, .failed:
                // Unreachable: `SignInPresentation.form` is non-nil for exactly
                // these four, and the `if let` above took them. Listed rather
                // than defaulted so a new SessionState case is a compile error
                // here instead of a blank screen.
                EmptyView()
            }
        }
    }

    /// The account exists and cannot sign in until the link in its verification
    /// email has been opened.
    ///
    /// Reached two ways — a registration that just succeeded, and a sign-in
    /// against an unverified account — and it is the same screen for both, on
    /// both platforms. It used to offer "Open relayium.com", which existed
    /// because the app could not ask for another email; it now asks the server
    /// directly, and the only web step left is the link in the message itself.
    private func checkEmail(email: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n.t(.contentCheckEmailTitle)).font(.headline)
            // The address is the user's own: isolated, not translated.
            Text(L10n.t(.contentCheckEmailBody, [L10n.token(email)]))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            switch session.resendState {
            case .requested:
                // Not "sent": the endpoint answers 200 whether it emailed
                // anything or swallowed the request under its own throttle.
                Text(L10n.t(.contentResendVerificationSent))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            case let .failed(message):
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            case .idle, .sending:
                EmptyView()
            }

            // One slot, so the screen does not jump and no second request can
            // start while one is in flight: the button is not on screen then.
            // Labelled rather than a bare spinner — VoiceOver reads nothing
            // from one.
            if isResending {
                ProgressView { Text(L10n.t(.contentResendVerificationBusy)) }
            } else {
                Button(L10n.t(.contentResendVerification)) {
                    Task { await session.resendVerification(email: email) }
                }
                .buttonStyle(.borderedProminent)
            }

            Button(L10n.t(.contentBackToSignIn)) { Task { await session.logOut() } }
                .font(.callout)
        }
    }

    private var isResending: Bool {
        if case .sending = session.resendState { return true }
        return false
    }

    /// The state reached holding no usable session. "Back to sign in" is a
    /// sign-out, exactly as on macOS: the honest way back is to drop what is
    /// held rather than to pretend it works.
    private func notice(title: String, body: String,
                        actionTitle: String, url: URL) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.headline)
            Text(body)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button(actionTitle) { openURL(url) }
                .buttonStyle(.borderedProminent)
            Button(L10n.t(.contentBackToSignIn)) { Task { await session.logOut() } }
                .font(.callout)
        }
    }
}
