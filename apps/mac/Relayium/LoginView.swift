import SwiftUI
import RelayiumAppKit

/// The sign-in form. It owns the typed email and password as `@State`, so it must
/// stay a single view across "typing", "signing in" and "that was wrong" —
/// `ContentView` renders it from one `switch` branch and passes the difference in
/// as these two properties. A sibling spinner view would reset both fields.
struct LoginView: View {
    var errorMessage: String? = nil
    /// A sign-in is in flight: the form stays on screen, disabled, with the button
    /// replaced by a spinner in place.
    var isBusy: Bool = false

    @EnvironmentObject private var session: AccountSession
    @State private var email = ""
    @State private var password = ""
    @StateObject private var browserLogin = AppEnvironment.makeBrowserLoginModel()
    @State private var presenter = BrowserSignInPresenter()

    private var canSubmit: Bool { !email.isEmpty && !password.isEmpty && !isBusy }

    /// The browser sheet is up, or its poll loop is running.
    private var browserBusy: Bool {
        switch browserLogin.state {
        case .starting, .waiting: return true
        default: return false
        }
    }

    var body: some View {
        VStack(spacing: 16) {
            // The product name, not copy. nonlocalized: brand.
            Text("Relayium").font(.largeTitle.weight(.semibold))

            VStack(spacing: 8) {
                TextField(L10n.t(.loginEmail), text: $email)
                    .textContentType(.username)
                    .disableAutocorrection(true)
                SecureField(L10n.t(.loginPassword), text: $password)
                    .textContentType(.password)
                    .onSubmit { submit() }
            }
            .textFieldStyle(.roundedBorder)
            .frame(maxWidth: 280)
            .disabled(isBusy)

            if let errorMessage {
                // The reason a sign-in did not work is the one message on this
                // form that must survive a colour filter, so it carries a symbol
                // like every other failure in the app.
                InlineMessage(.failure, errorMessage)
                    .frame(maxWidth: 280)
            }

            // Same slot either way, so the form doesn't jump while it submits.
            ZStack {
                Button(L10n.t(.loginSignIn), action: submit)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canSubmit)
                    .opacity(isBusy ? 0 : 1)
                if isBusy { ProgressView().controlSize(.small) }
            }

            Divider().frame(maxWidth: 280)

            // Named for what the user wants, not for how it is delivered: the
            // password form is right above, so whoever presses this came for
            // Apple, and the page it opens leads with the Apple button.
            Button(L10n.t(.loginSignInWithApple)) { startBrowserLogin() }
                .disabled(isBusy || browserBusy)

            if case let .failed(message) = browserLogin.state {
                InlineMessage(.failure, message)
                    .frame(maxWidth: 280)
            }

            Button(L10n.t(.loginCreateAccount)) {
                NSWorkspace.shared.open(AppEnvironment.productionBaseURL)
            }
            .buttonStyle(.link)
            .disabled(isBusy)
        }
        // Opens the sheet as soon as the model publishes an approval URL, and
        // only then — the URL is not known until /api/cli/device/start returns.
        // `task(id:)` rather than `onChange(of:initial:)`, which needs macOS 14
        // while this app targets 13.
        .task(id: browserLogin.lastApprovalURL) {
            guard case let .waiting(url) = browserLogin.state else { return }
            presenter.present(url) {
                // The user closed the sheet: cancel the poll loop rather than
                // leaving it running against a code nobody will approve.
                browserLogin.cancel()
            }
        }
    }

    private func submit() {
        guard canSubmit else { return }
        Task { await session.logIn(email: email, password: password) }
    }

    private func startBrowserLogin() {
        Task {
            await browserLogin.begin { token in
                // Close the sheet before adopting, so the window the user ends
                // up looking at is the account screen, not a browser on /device.
                presenter.dismiss()
                Task { await session.adoptBearer(token) }
            }
        }
    }
}
