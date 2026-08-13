import SwiftUI
import RelayiumAppKit

/// The account form: sign in, and create an account, in one view.
///
/// It owns the typed fields AND the mode as `@State`, so it must stay a single
/// view across "typing", "signing in", "creating an account" and "that was
/// wrong" — `AccountDestination` renders it from one `switch` branch and passes
/// the difference in as `form`. A sibling spinner view would reset every field
/// and drop a half-filled registration back onto the sign-in half.
///
/// Registration is performed HERE, against `POST /api/auth/register`. The only
/// web step left in the flow is the link inside the verification email, which is
/// the server's own confirmation endpoint — this app does not intercept it,
/// mints no token from it, and claims nothing about it.
struct LoginView: View {
    /// What the session says the form should show. One value rather than two
    /// properties, so "busy" and "why the last attempt failed" cannot disagree.
    var form: SignInFormState

    @EnvironmentObject private var session: AccountSession
    @EnvironmentObject private var navigation: AppNavigationModel
    @State private var mode: AuthMode = .signIn
    @State private var draft = RegistrationDraft()
    /// The form's own refusal — two passwords that differ, an empty address —
    /// as opposed to the server's, which arrives through `form.errorMessage`.
    /// Cleared on every submit and on every mode change, so it can never
    /// describe something that is no longer on screen.
    @State private var localProblem: RegistrationProblem?
    @FocusState private var confirmFocused: Bool
    @StateObject private var browserLogin = AppEnvironment.makeBrowserLoginModel(
        installationStore: UITestMode.makeInstallationIdentityStore())
    @State private var presenter = BrowserSignInPresenter()

    private var canSubmit: Bool {
        SignInPresentation.canSubmit(mode: mode, draft: draft, isBusy: form.isBusy)
    }

    /// The form's refusal wins over the session's: it is about what is typed
    /// right now, while the session's is about the attempt before it.
    private var errorMessage: String? {
        if let localProblem { return L10n.t(localProblem.messageKey) }
        return form.errorMessage
    }

    /// The browser sheet is up, or its poll loop is running.
    private var browserBusy: Bool {
        switch browserLogin.state {
        case .starting, .waiting: return true
        default: return false
        }
    }

    var body: some View {
        VStack(spacing: 20) {
            VStack(spacing: 6) {
                // The product name, not copy. nonlocalized: brand.
                Text("Relayium")
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(.tint)
                Text(L10n.t(mode.titleKey))
                    .font(.title2.weight(.semibold))
                Text(L10n.t(mode.bodyKey))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: 320)
            }

            VStack(spacing: 8) {
                if mode == .register {
                    displayNameField
                }
                emailField
                passwordField
                if mode == .register {
                    confirmationField
                }
            }
            .textFieldStyle(.roundedBorder)
            .frame(maxWidth: 280)
            .disabled(form.isBusy)

            if let errorMessage {
                // The reason an attempt did not work is the one message on this
                // form that must survive a colour filter, so it carries a symbol
                // like every other failure in the app.
                InlineMessage(.failure, errorMessage)
                    .frame(maxWidth: 280)
            }

            // Same slot either way, so the form doesn't jump while it submits,
            // and the label names the operation that is actually running.
            ZStack {
                Button(L10n.t(mode.submitTitleKey), action: submit)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canSubmit)
                    .opacity(form.isBusy ? 0 : 1)
                    .accessibilityHidden(form.isBusy)
                    .accessibilityIdentifier("account.submit")
                if let busyTitle = form.activity.busyTitleKey {
                    ProgressView { Text(L10n.t(busyTitle)) }
                        .controlSize(.small)
                }
            }

            // Sign-in only. The device flow signs an existing account in; it is
            // not a second way to create one, and offering it beside the
            // create-account fields would imply it was.
            if mode == .signIn {
                Divider().frame(maxWidth: 280)

                // Named for what it does. It used to say "Sign in with Apple",
                // which was a claim about a mechanism this app does not
                // implement — no entitlement, no `ASAuthorizationController`,
                // just relayium.com in a sheet and a poll of the device-code
                // endpoints. Whatever the user picks over there, including
                // Apple, is the browser's business.
                Button(L10n.t(.loginBrowserSignIn)) { startBrowserLogin() }
                    .disabled(form.isBusy || browserBusy)

                if case let .failed(message) = browserLogin.state {
                    InlineMessage(.failure, message)
                        .frame(maxWidth: 280)
                }
            }

            Button(L10n.t(mode.switchTitleKey)) { switchMode() }
                .buttonStyle(.link)
                .disabled(form.isBusy)
                .accessibilityIdentifier("account.switchMode")
        }
        .padding(28)
        .frame(maxWidth: 380)
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 20))
        .overlay {
            RoundedRectangle(cornerRadius: 20)
                .stroke(Color.primary.opacity(0.10), lineWidth: 1)
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
        // A capability gate's "Create an account" selects this destination and
        // names the half it promised. Keyed on the intent, so the user's own
        // mode switching is never overwritten by a value that has not changed.
        .task(id: navigation.accountIntent) {
            guard mode != navigation.accountIntent else { return }
            mode = navigation.accountIntent
            localProblem = nil
        }
    }

    // SwiftUI exposes the AppKit name/email/new-password content types only on
    // macOS 14, while Relayium still supports 13. Keep the visible form
    // identical there and add the Password AutoFill semantics where the API is
    // available, instead of raising the deployment target for metadata alone.
    @ViewBuilder private var displayNameField: some View {
        if #available(macOS 14, *) {
            TextField(L10n.t(.loginDisplayName), text: $draft.displayName)
                .accessibilityLabel(L10n.t(.loginDisplayName))
                .accessibilityIdentifier("account.name")
                .textContentType(.name)
                .disableAutocorrection(true)
        } else {
            TextField(L10n.t(.loginDisplayName), text: $draft.displayName)
                .accessibilityLabel(L10n.t(.loginDisplayName))
                .accessibilityIdentifier("account.name")
                .disableAutocorrection(true)
        }
    }

    @ViewBuilder private var emailField: some View {
        if #available(macOS 14, *), mode == .register {
            TextField(L10n.t(.loginEmail), text: $draft.email)
                .accessibilityLabel(L10n.t(.loginEmail))
                .accessibilityIdentifier("account.email")
                .textContentType(.emailAddress)
                .disableAutocorrection(true)
        } else {
            TextField(L10n.t(.loginEmail), text: $draft.email)
                .accessibilityLabel(L10n.t(.loginEmail))
                .accessibilityIdentifier("account.email")
                .textContentType(.username)
                .disableAutocorrection(true)
        }
    }

    @ViewBuilder private var passwordField: some View {
        if #available(macOS 14, *), mode == .register {
            SecureField(L10n.t(.loginPassword), text: $draft.password)
                .accessibilityLabel(L10n.t(.loginPassword))
                .accessibilityIdentifier("account.password")
                .textContentType(.newPassword)
                .onSubmit { passwordReturn() }
        } else {
            SecureField(L10n.t(.loginPassword), text: $draft.password)
                .accessibilityLabel(L10n.t(.loginPassword))
                .accessibilityIdentifier("account.password")
                .textContentType(.password)
                .onSubmit { passwordReturn() }
        }
    }

    @ViewBuilder private var confirmationField: some View {
        if #available(macOS 14, *) {
            SecureField(L10n.t(.loginConfirmPassword), text: $draft.confirmPassword)
                .accessibilityLabel(L10n.t(.loginConfirmPassword))
                .accessibilityIdentifier("account.confirmPassword")
                .textContentType(.newPassword)
                .focused($confirmFocused)
                .onSubmit { submit() }
        } else {
            SecureField(L10n.t(.loginConfirmPassword), text: $draft.confirmPassword)
                .accessibilityLabel(L10n.t(.loginConfirmPassword))
                .accessibilityIdentifier("account.confirmPassword")
                .focused($confirmFocused)
                .onSubmit { submit() }
        }
    }

    private func switchMode() {
        mode = mode.toggled
        // The refusal belonged to the other half of the form. The typed fields
        // stay: the email is the same email either way, and retyping it is the
        // cost this one-form design exists to remove.
        localProblem = nil
        navigation.rememberAccountIntent(mode)
        session.dismissAccountAccessError()
    }

    /// Return from the password field advances to confirmation while creating
    /// an account. A key that silently does nothing because confirmation is
    /// still empty is especially poor keyboard UX on macOS.
    private func passwordReturn() {
        guard mode == .register, draft.confirmPassword.isEmpty else { return submit() }
        confirmFocused = true
    }

    private func submit() {
        guard canSubmit else { return }
        // The task starts after this action returns. Keep the credentials and
        // registration profile the user submitted together rather than reading
        // fields that remain editable until the session publishes busy.
        let submitted = draft
        localProblem = nil
        switch mode {
        case .signIn:
            Task { await session.logIn(email: submitted.email,
                                       password: submitted.password) }
        case .register:
            // Checked here so a mistyped confirmation costs no round trip and no
            // rate-limit budget. The server enforces the same password rule
            // regardless; this only stops the trip.
            if let problem = SignInPresentation.problem(in: submitted) {
                localProblem = problem
                return
            }
            Task {
                await session.register(email: submitted.email,
                                       password: submitted.password,
                                       displayName: submitted.displayName)
            }
        }
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
