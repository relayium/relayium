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
                notice(title: L10n.t(.contentCheckEmailTitle),
                       // The address is the user's own: isolated, not translated.
                       body: L10n.t(.contentCheckEmailBody, [L10n.token(email)]),
                       actionTitle: L10n.t(.contentOpenRelayium),
                       url: AppEnvironment.accountWebURL)

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
                AccountSummaryView(user: user, usage: usage)

            case .loggedOut, .authenticating, .failed:
                // Unreachable: `SignInPresentation.form` is non-nil for exactly
                // these three, and the `if let` above took them. Listed rather
                // than defaulted so a new SessionState case is a compile error
                // here instead of a blank screen.
                EmptyView()
            }
        }
    }

    /// The two states reached holding no usable session. "Back to sign in" is a
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
