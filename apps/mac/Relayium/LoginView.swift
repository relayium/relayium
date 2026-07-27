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

    private var canSubmit: Bool { !email.isEmpty && !password.isEmpty && !isBusy }

    var body: some View {
        VStack(spacing: 16) {
            Text("Relayium").font(.largeTitle.weight(.semibold))

            VStack(spacing: 8) {
                TextField("Email", text: $email)
                    .textContentType(.username)
                    .disableAutocorrection(true)
                SecureField("Password", text: $password)
                    .textContentType(.password)
                    .onSubmit { submit() }
            }
            .textFieldStyle(.roundedBorder)
            .frame(maxWidth: 280)
            .disabled(isBusy)

            if let errorMessage {
                Text(errorMessage)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // Same slot either way, so the form doesn't jump while it submits.
            ZStack {
                Button("Sign in", action: submit)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canSubmit)
                    .opacity(isBusy ? 0 : 1)
                if isBusy { ProgressView().controlSize(.small) }
            }

            Button("Create an account on relayium.com") {
                NSWorkspace.shared.open(AppEnvironment.productionBaseURL)
            }
            .buttonStyle(.link)
            .disabled(isBusy)
        }
    }

    private func submit() {
        guard canSubmit else { return }
        Task { await session.logIn(email: email, password: password) }
    }
}
