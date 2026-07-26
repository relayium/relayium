import SwiftUI
import RelayiumKit
import RelayiumAppKit

struct ContentView: View {
    @EnvironmentObject private var session: AccountSession

    var body: some View {
        Group {
            switch session.state {
            case .restoring, .authenticating:
                ProgressView().controlSize(.large)
            case .loggedOut:
                LoginView()
            case .failed(let message):
                LoginView(errorMessage: message)
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
                    actionTitle: "Open relayium.com"
                )
            case .pendingDeletion(let purgeAfter, _):
                noticeView(
                    title: "This account is scheduled for deletion",
                    body: "It will be erased after \(Date(timeIntervalSince1970: TimeInterval(purgeAfter)).formatted(date: .abbreviated, time: .omitted)). Reactivate it on the web to keep it.",
                    actionTitle: "Reactivate on relayium.com"
                )
            case let .ready(user, usage):
                AccountView(user: user, usage: usage)
            }
        }
        .frame(minWidth: 380, minHeight: 420)
        .padding()
    }

    private func noticeView(title: String, body: String, actionTitle: String) -> some View {
        VStack(spacing: 12) {
            Text(title).font(.headline)
            Text(body).multilineTextAlignment(.center).foregroundStyle(.secondary)
            Button(actionTitle) { NSWorkspace.shared.open(AppEnvironment.productionBaseURL) }
            Button("Back to sign in") { session.logOut() }.buttonStyle(.link)
        }
    }
}
