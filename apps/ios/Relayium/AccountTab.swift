import SwiftUI
import RelayiumKit
import RelayiumAppKit

/// The whole account surface, and the only place in the app that reads
/// `session.state`.
///
/// Every hand-off goes through SwiftUI's `openURL`: the macOS app's
/// `NSWorkspace.shared.open` does not exist here, and this is the platform's
/// own mechanism rather than a UIKit call smuggled into a view.
///
/// **Phase C: each state this router draws is one card.** Every arm but the
/// restore spinner is the same shape — a title, a sentence about what is true,
/// and one or two actions — and each was drawn as a bare column on an
/// otherwise empty screen, which reads as something that failed to load rather
/// than as the answer. They now carry the same card the rest of the app uses,
/// titled with the fact each state is about, and their statuses use the shared
/// inline-message roles rather than this file's own red and grey text.
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
                SectionCard(L10n.t(.contentAccountLoadFailed)) {
                    // The server's own sentence, in the shared failure role:
                    // this arm exists because something went wrong, and the
                    // symbol is what says so to a reader the colour does not
                    // reach.
                    InlineMessage(.warning, message)
                    Button { Task { await session.refresh() } } label: {
                        Text(L10n.t(.commonTryAgain)).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    // Secondary, and stays so: a load failure is usually not a
                    // reason to drop the credential, and a second full-width
                    // control here would look like a second first move.
                    Button(L10n.t(.commonSignOut)) { Task { await session.logOut() } }
                        .font(.callout)
                        .textAction()
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
        SectionCard(L10n.t(.contentCheckEmailTitle)) {
            // The address is the user's own: isolated, not translated.
            Text(L10n.t(.contentCheckEmailBody, [L10n.token(email)]))
                .font(.callout)
                .foregroundStyle(Palette.supportingLabel)
                .fixedSize(horizontal: false, vertical: true)

            switch session.resendState {
            case .requested:
                // Not "sent": the endpoint answers 200 whether it emailed
                // anything or swallowed the request under its own throttle.
                // `.info`, because nothing went wrong — spending the warning
                // role here would make a successful request look like the
                // failure below it.
                InlineMessage(.info, L10n.t(.contentResendVerificationSent))
            case let .failed(message):
                InlineMessage(.warning, message)
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
                Button { Task { await session.resendVerification(email: email) } } label: {
                    Text(L10n.t(.contentResendVerification)).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            }

            Button(L10n.t(.contentBackToSignIn)) { Task { await session.logOut() } }
                .font(.callout)
                .textAction()
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
        SectionCard(title) {
            // A scheduled deletion is something true the reader has to act on
            // before a date, so it carries the shared warning role rather than
            // being the same grey paragraph as an explanation.
            InlineMessage(.warning, body)
            Button { openURL(url) } label: {
                Text(actionTitle).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            Button(L10n.t(.contentBackToSignIn)) { Task { await session.logOut() } }
                .font(.callout)
                .textAction()
        }
    }
}
