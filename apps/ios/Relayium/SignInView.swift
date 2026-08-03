import SwiftUI
import RelayiumAppKit

/// The sign-in form. It owns the typed email and password as `@State`, so it
/// must stay ONE view across typing, signing in and "that was wrong" — see
/// `AccountTab`, which renders it from exactly one place for that reason.
///
/// Password only. Sign in with Apple and the browser device flow are later
/// slices, and a disabled button for either would be a promise this app cannot
/// keep.
struct SignInView: View {
    let form: SignInFormState

    @EnvironmentObject private var session: AccountSession
    @Environment(\.openURL) private var openURL
    @State private var email = ""
    @State private var password = ""

    private var canSubmit: Bool { !email.isEmpty && !password.isEmpty && !form.isBusy }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(spacing: 12) {
                TextField(L10n.t(.loginEmail), text: $email)
                    .textContentType(.username)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField(L10n.t(.loginPassword), text: $password)
                    .textContentType(.password)
                    .submitLabel(.go)
                    .onSubmit(submit)
            }
            .textFieldStyle(.roundedBorder)
            .disabled(form.isBusy)

            if let message = form.errorMessage {
                // Ordinary text in reading order ABOVE the button, not a
                // decoration after it: it is what the user has to act on.
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // Same slot either way, so the form does not jump while it submits.
            // The hidden button is also hidden from VoiceOver — opacity alone
            // leaves it in the accessibility tree, offering an action that is
            // already running.
            ZStack {
                Button(action: submit) {
                    Text(L10n.t(.loginSignIn)).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(!canSubmit)
                .opacity(form.isBusy ? 0 : 1)
                .accessibilityHidden(form.isBusy)

                if form.isBusy {
                    ProgressView { Text(L10n.t(.loginSigningIn)) }
                }
            }

            Button(L10n.t(.loginCreateAccount)) { openURL(AppEnvironment.productionBaseURL) }
                .font(.callout)
                .disabled(form.isBusy)
        }
    }

    private func submit() {
        guard canSubmit else { return }
        Task { await session.logIn(email: email, password: password) }
    }
}
