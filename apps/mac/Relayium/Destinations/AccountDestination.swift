import SwiftUI
import RelayiumKit
import RelayiumAppKit

/// The account destination — and the **only** file in the app allowed to switch
/// on `session.state`.
///
/// That restriction is the whole point of the round. The root view used to carry
/// this switch, so a user who was not signed in never saw the app at all: they
/// saw a sign-in form with two collapsed disclosure groups beneath it, and every
/// capability that genuinely works signed out was hidden under them. Moving the
/// switch here makes the account one destination among five rather than the door
/// to all of them.
struct AccountDestination: View {
    @EnvironmentObject private var session: AccountSession
    @EnvironmentObject private var navigation: AppNavigationModel

    var body: some View {
        DestinationScaffold(title: L10n.t(.navAccount),
                            contentMaxWidth: nil) {
            switch session.state {
            case .restoring:
                // Launch only. There is no form to preserve here, so a branch of
                // its own is free.
                ProgressView { Text(L10n.t(.accountRestoring)) }
                    .controlSize(.small)
                .frame(maxWidth: 720, alignment: .leading)

            case .loggedOut, .authenticating, .registering, .failed:
                // ONE branch for all four. Each branch of a ViewBuilder `switch`
                // is a distinct structural identity, so splitting these would make
                // SwiftUI tear the subtree down and rebuild it on every transition
                // — resetting `LoginView`'s `@State` fields and its MODE. That is
                // the round's primary flow: every wrong password would blank both
                // fields and make the user retype their email too, and a rejected
                // registration would drop the user back onto the sign-in half
                // with an error about a registration. "Busy" is a disabled
                // control inside the form, never a sibling view.
                VStack(spacing: 16) {
                    // Which states the form owns, and what each shows, is decided
                    // in `SignInPresentation`, where a test can read it — the
                    // same seam the iOS tab renders through.
                    if let form = SignInPresentation.form(for: session.state) {
                        LoginView(form: form)
                    }
                }
                .frame(maxWidth: 720)

            case let .unavailable(message):
                // We still hold a valid-looking token — offer a retry, not a form.
                SectionCard(title: L10n.t(.contentAccountLoadFailed)) {
                    InlineMessage(.failure, message)
                    HStack {
                        Button(L10n.t(.commonTryAgain)) { Task { await session.refresh() } }
                            .keyboardShortcut(.defaultAction)
                        Button(L10n.t(.commonSignOut)) { Task { await session.logOut() } }
                            .buttonStyle(.link)
                    }
                }
                .frame(maxWidth: 720, alignment: .leading)

            case let .emailUnverified(email):
                checkEmail(email: email)

            case let .pendingDeletion(purgeAfter, reactivateToken):
                notice(title: L10n.t(.contentPendingDeletionTitle),
                       body: L10n.t(.contentPendingDeletionBody, [
                           L10n.date(Date(timeIntervalSince1970: TimeInterval(purgeAfter)),
                                     dateStyle: .medium, timeStyle: .none),
                       ]),
                       actionTitle: L10n.t(.contentReactivate),
                       // The token is the whole button: it is what makes
                       // reactivation one click on a web session the frozen
                       // account cannot create.
                       url: AppEnvironment.reactivateWebURL(token: reactivateToken))

            case let .ready(user, usage):
                AccountView(user: user, usage: usage)
            }
            // Outside the `switch` over `session.state`, so the sign-in form,
            // the check-email screen and the ready account all end the same way.
            // A reader who cannot sign in is the one with the most questions.
            HelpCard(surface: .account)
        }
    }

    /// The account exists and cannot sign in until the link in its verification
    /// email has been opened.
    ///
    /// Reached two ways — a registration that just succeeded, and a sign-in
    /// against an unverified account — and it is the same screen for both. It
    /// used to offer "Open relayium.com", which was there because the app had no
    /// way to ask for another email; it now asks the server directly, and the
    /// only web step left is the link in the message itself.
    private func checkEmail(email: String) -> some View {
        SectionCard(title: L10n.t(.contentCheckEmailTitle)) {
            // The address is the user's own and is isolated, not translated.
            Text(L10n.t(.contentCheckEmailBody, [L10n.token(email)]))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            switch session.resendState {
            case .requested:
                // `.info`, not a success mark: the endpoint answers 200 whether
                // it sent anything or throttled the request, so this reports
                // what was asked for rather than what arrived.
                InlineMessage(.info, L10n.t(.contentResendVerificationSent))
            case let .failed(message):
                InlineMessage(.failure, message)
            case .idle, .sending:
                EmptyView()
            }

            HStack {
                // One slot, so the row does not jump, and no second request
                // while one is in flight — the button is simply not the control
                // on screen while it is.
                if isResending {
                    ProgressView { Text(L10n.t(.contentResendVerificationBusy)) }
                        .controlSize(.small)
                } else {
                    Button(L10n.t(.contentResendVerification)) {
                        Task { await session.resendVerification(email: email) }
                    }
                    .keyboardShortcut(.defaultAction)
                }
                Button(L10n.t(.contentBackToSignIn)) {
                    // The route that opened registration is remembered so a
                    // remounted form can honour it. Replace that one-shot intent
                    // before returning, or the new form would immediately flip
                    // back to registration.
                    navigation.rememberAccountIntent(.signIn)
                    Task { await session.logOut() }
                }
                    .buttonStyle(.link)
            }
        }
        .frame(maxWidth: 720, alignment: .leading)
    }

    private var isResending: Bool {
        if case .sending = session.resendState { return true }
        return false
    }

    private func notice(title: String,
                        body: String,
                        actionTitle: String,
                        url: URL) -> some View {
        SectionCard(title: title) {
            Text(body)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Button(actionTitle) { NSWorkspace.shared.open(url) }
                    .keyboardShortcut(.defaultAction)
                Button(L10n.t(.contentBackToSignIn)) { Task { await session.logOut() } }
                    .buttonStyle(.link)
            }
        }
        .frame(maxWidth: 720, alignment: .leading)
    }
}
