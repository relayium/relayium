import SwiftUI
import RelayiumKit
import RelayiumAppKit

struct ContentView: View {
    @EnvironmentObject private var session: AccountSession

    var body: some View {
        Group {
            switch session.state {
            case .restoring:
                // Launch only. There is no form to preserve here, so a branch of
                // its own is free.
                ProgressView().controlSize(.large)
            case .loggedOut, .authenticating, .failed:
                // ONE branch for all three. Each branch of a ViewBuilder `switch`
                // is a distinct structural identity, so splitting these would make
                // SwiftUI tear the subtree down and rebuild it on every transition
                // — resetting `LoginView`'s `@State` email and password. That is
                // the round's primary flow: every wrong password would blank both
                // fields and make the user retype their email too. "Busy" is a
                // disabled control inside the form, never a sibling view.
                LoginView(errorMessage: loginError, isBusy: isAuthenticating)
            case .unavailable(let message):
                // We still hold a valid-looking token — offer a retry, not a form.
                VStack(spacing: 12) {
                    Text("Couldn't load your account").font(.headline)
                    Text(message).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Button("Try again") { Task { await session.refresh() } }
                        .keyboardShortcut(.defaultAction)
                    Button("Sign out") { session.logOut() }.buttonStyle(.link)
                }
            case .emailUnverified(let email):
                noticeView(
                    title: "Check your email",
                    body: "We sent a verification link to \(email). Verify it, then sign in again.",
                    actionTitle: "Open relayium.com",
                    url: AppEnvironment.accountWebURL
                )
            case let .pendingDeletion(purgeAfter, reactivateToken):
                noticeView(
                    title: "This account is scheduled for deletion",
                    body: "It will be erased after \(Date(timeIntervalSince1970: TimeInterval(purgeAfter)).formatted(date: .abbreviated, time: .omitted)). Reactivate it on the web to keep it.",
                    actionTitle: "Reactivate on relayium.com",
                    // The token is the whole button: it is what makes reactivation
                    // one click on a web session the frozen account cannot create.
                    url: AppEnvironment.reactivateWebURL(token: reactivateToken)
                )
            case let .ready(user, usage):
                AccountView(user: user, usage: usage)
            }
        }
        .frame(minWidth: 380, minHeight: 420)
        .padding()
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

    private func noticeView(title: String, body: String, actionTitle: String, url: URL) -> some View {
        VStack(spacing: 12) {
            Text(title).font(.headline)
            Text(body).multilineTextAlignment(.center).foregroundStyle(.secondary)
            Button(actionTitle) { NSWorkspace.shared.open(url) }
            Button("Back to sign in") { session.logOut() }.buttonStyle(.link)
        }
    }
}
