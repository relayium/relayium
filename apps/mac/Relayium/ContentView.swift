import SwiftUI
import RelayiumKit
import RelayiumAppKit

struct ContentView: View {
    @EnvironmentObject private var session: AccountSession
    @EnvironmentObject private var uploadModel: CloudUploadModel
    @EnvironmentObject private var downloadModel: CloudDownloadModel
    @EnvironmentObject private var realtimeModel: RealtimeSessionModel
    @State private var showDownload = false

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
                // Still ONE branch: the VStack is a single structural identity,
                // so LoginView's @State survives every transition among the
                // three states, exactly as before.
                VStack(spacing: 16) {
                    LoginView(errorMessage: loginError, isBusy: isAuthenticating)
                    Divider()
                    // A share link that demands a signup is not a share link.
                    // fetchMeta and the blob route take no token, so receiving
                    // works here — only sending needs an account.
                    DisclosureGroup("I have a link", isExpanded: $showDownload) {
                        DownloadPane(model: downloadModel)
                    }
                }
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
                // Three tabs split by intent rather than transport: the
                // distinction a user makes is whether the other person is there
                // right now, and that is exactly the line between the two.
                TabView {
                    ScrollView {
                        DirectPane(model: realtimeModel, token: session.bearerToken ?? "")
                            .padding()
                    }
                    .tabItem { Label("Direct", systemImage: "bolt.horizontal") }

                    ScrollView {
                        VStack(alignment: .leading, spacing: 20) {
                            UploadPane(model: uploadModel, token: session.bearerToken ?? "")
                            Divider()
                            DownloadPane(model: downloadModel)
                        }
                        .padding()
                        // The retention cap decides which TTLs are offerable and
                        // only exists once usage has loaded. `task(id:)` rather
                        // than `onChange(of:initial:)`, which needs macOS 14
                        // while this app targets 13.
                        .task(id: usage.plan.retentionSecs) {
                            uploadModel.applyRetentionCap(usage.plan.retentionSecs)
                        }
                    }
                    .tabItem { Label("Link", systemImage: "link") }

                    ScrollView {
                        AccountView(user: user, usage: usage).padding()
                    }
                    .tabItem { Label("Account", systemImage: "person.crop.circle") }
                }
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
