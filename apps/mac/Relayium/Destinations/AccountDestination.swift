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

    var body: some View {
        DestinationScaffold(title: L10n.t(.navAccount),
                            subtitle: L10n.t(.navAccountSubtitle),
                            contentMaxWidth: nil) {
            switch session.state {
            case .restoring:
                // Launch only. There is no form to preserve here, so a branch of
                // its own is free.
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(L10n.t(.accountRestoring)).foregroundStyle(.secondary)
                }
                .frame(maxWidth: 720, alignment: .leading)

            case .loggedOut, .authenticating, .failed:
                // ONE branch for all three. Each branch of a ViewBuilder `switch`
                // is a distinct structural identity, so splitting these would make
                // SwiftUI tear the subtree down and rebuild it on every transition
                // — resetting `LoginView`'s `@State` email and password. That is
                // the round's primary flow: every wrong password would blank both
                // fields and make the user retype their email too. "Busy" is a
                // disabled control inside the form, never a sibling view.
                // Still ONE branch: the VStack is a single structural identity,
                // so LoginView's @State survives every transition among the
                // three states, exactly as before.
                VStack(spacing: 16) {
                    LoginView(errorMessage: loginError, isBusy: isAuthenticating)
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
                notice(title: L10n.t(.contentCheckEmailTitle),
                       // The address is the user's own and is isolated, not
                       // translated.
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
                       // The token is the whole button: it is what makes
                       // reactivation one click on a web session the frozen
                       // account cannot create.
                       url: AppEnvironment.reactivateWebURL(token: reactivateToken))

            case let .ready(user, usage):
                AccountView(user: user, usage: usage)
            }
        }
    }

    /// The error to show on the form, or `nil` while there is nothing to report.
    /// Derived rather than switched on, so the form stays one view — see above.
    private var loginError: String? {
        if case let .failed(message) = session.state { return message }
        return nil
    }

    private var isAuthenticating: Bool {
        if case .authenticating = session.state { return true }
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
