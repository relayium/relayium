import SwiftUI
import RelayiumAppKit

/// The account form: sign in, and create an account, in one view.
///
/// It owns the typed fields AND the mode as `@State`, so it must stay ONE view
/// across typing, signing in, creating an account and "that was wrong" — see
/// `AccountTab`, which renders it from exactly one place for that reason.
///
/// Registration happens HERE, against `POST /api/auth/register`. The one web
/// step left is the link inside the verification email, which is the server's
/// own confirmation endpoint: this app does not intercept it and mints nothing
/// from it. Sign in with Apple remains a later slice, and a disabled button for
/// it would be a promise this app cannot keep.
struct SignInView: View {
    let form: SignInFormState

    @EnvironmentObject private var session: AccountSession
    @State private var mode: AuthMode = .signIn
    @State private var draft = RegistrationDraft()
    /// The form's own refusal, as opposed to the server's — which arrives
    /// through `form.errorMessage`. Cleared on every submit and every mode
    /// change, so it can never describe something no longer on screen.
    @State private var localProblem: RegistrationProblem?
    /// Only the confirmation field is ever focused programmatically — see
    /// `passwordReturn()`. Everything else is the keyboard's own business.
    @FocusState private var confirmFocused: Bool

    private var canSubmit: Bool {
        SignInPresentation.canSubmit(mode: mode, draft: draft, isBusy: form.isBusy)
    }

    /// What is typed now beats what the last attempt returned.
    private var errorMessage: String? {
        if let localProblem { return L10n.t(localProblem.messageKey) }
        return form.errorMessage
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: mode == .signIn
                      ? "person.crop.circle"
                      : "person.crop.circle.badge.plus")
                    .font(.title2)
                    .foregroundStyle(.tint)
                    .frame(width: 44, height: 44)
                    .background(Color.accentColor.opacity(0.12), in: Circle())
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(L10n.t(mode.titleKey))
                        .font(.title2.weight(.semibold))
                    Text(L10n.t(mode.bodyKey))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            VStack(spacing: 12) {
                if mode == .register {
                    TextField(L10n.t(.loginDisplayName), text: $draft.displayName)
                        .textContentType(.name)
                        .autocorrectionDisabled()
                }
                TextField(L10n.t(.loginEmail), text: $draft.email)
                    // Registration is an email-address field, while sign-in
                    // uses username so Password AutoFill can match an existing
                    // Relayium credential. Both still present the email
                    // keyboard and preserve exactly what the user types.
                    .textContentType(mode == .register ? .emailAddress : .username)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField(L10n.t(.loginPassword), text: $draft.password)
                    // `.newPassword` in register mode, so iOS offers to generate
                    // and save one instead of filling an existing one.
                    .textContentType(mode == .register ? .newPassword : .password)
                    .submitLabel(mode == .register ? .next : .go)
                    .onSubmit(passwordReturn)
                if mode == .register {
                    SecureField(L10n.t(.loginConfirmPassword), text: $draft.confirmPassword)
                        .textContentType(.newPassword)
                        .submitLabel(.go)
                        .focused($confirmFocused)
                        .onSubmit(submit)
                }
            }
            .textFieldStyle(.roundedBorder)
            .disabled(form.isBusy)

            if let errorMessage {
                // Ordinary text in reading order ABOVE the button, not a
                // decoration after it: it is what the user has to act on.
                Text(errorMessage)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // Same slot either way, so the form does not jump while it submits.
            // The hidden button is also hidden from VoiceOver — opacity alone
            // leaves it in the accessibility tree, offering an action that is
            // already running. The busy label names the operation that is
            // actually in flight, never the other one.
            ZStack {
                Button(action: submit) {
                    Text(L10n.t(mode.submitTitleKey)).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(!canSubmit)
                .opacity(form.isBusy ? 0 : 1)
                .accessibilityHidden(form.isBusy)

                if let busyTitle = form.activity.busyTitleKey {
                    ProgressView { Text(L10n.t(busyTitle)) }
                }
            }

            Button(L10n.t(mode.switchTitleKey)) { switchMode() }
                .font(.callout)
                .disabled(form.isBusy)
        }
        .padding(20)
        .background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 20))
        .overlay {
            RoundedRectangle(cornerRadius: 20)
                .stroke(Color.secondary.opacity(0.14), lineWidth: 1)
        }
    }

    private func switchMode() {
        mode = mode.toggled
        // The refusal belonged to the other half. The typed fields stay: the
        // email is the same email either way, and retyping it on a phone is the
        // cost this one-form design exists to remove.
        localProblem = nil
        session.dismissAccountAccessError()
    }

    /// Return from the password field.
    ///
    /// In create-account mode the key is labelled *next*, and it has to mean it:
    /// submitting there is refused for an empty confirmation, so a plain
    /// `submit()` would be a keystroke that silently does nothing on the one
    /// field whose whole point is that it is typed twice.
    private func passwordReturn() {
        guard mode == .register, draft.confirmPassword.isEmpty else { return submit() }
        confirmFocused = true
    }

    private func submit() {
        guard canSubmit else { return }
        localProblem = nil
        switch mode {
        case .signIn:
            Task { await session.logIn(email: draft.email, password: draft.password) }
        case .register:
            // Checked here so a mistyped confirmation costs no round trip and no
            // rate-limit budget. The server enforces the same password rule
            // regardless; this only stops the trip.
            if let problem = SignInPresentation.problem(in: draft) {
                localProblem = problem
                return
            }
            Task {
                await session.register(email: draft.email,
                                       password: draft.password,
                                       displayName: draft.displayName)
            }
        }
    }
}
