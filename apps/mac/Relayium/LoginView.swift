import SwiftUI
import RelayiumAppKit

struct LoginView: View {
    var errorMessage: String? = nil

    @EnvironmentObject private var session: AccountSession
    @State private var email = ""
    @State private var password = ""

    private var canSubmit: Bool { !email.isEmpty && !password.isEmpty }

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

            if let errorMessage {
                Text(errorMessage)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button("Sign in", action: submit)
                .keyboardShortcut(.defaultAction)
                .disabled(!canSubmit)

            Button("Create an account on relayium.com") {
                NSWorkspace.shared.open(AppEnvironment.productionBaseURL)
            }
            .buttonStyle(.link)
        }
    }

    private func submit() {
        guard canSubmit else { return }
        Task { await session.logIn(email: email, password: password) }
    }
}
