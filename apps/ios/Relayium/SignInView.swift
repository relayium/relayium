import SwiftUI
import AuthenticationServices
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
/// from it.
///
/// Sign in with Apple is HERE too, and it is the real system control: an
/// `ASAuthorizationAppleIDRequest` presented by `SignInWithAppleButton`, whose
/// result is exchanged at `POST /api/auth/apple/native`. This is the one place
/// in either app that imports `AuthenticationServices` for an Apple ID — macOS
/// keeps its browser sign-in, which is a different mechanism and is labelled as
/// one.
struct SignInView: View {
    let form: SignInFormState

    @EnvironmentObject private var session: AccountSession
    /// Only the Apple button reads this: its two system styles are light-on-dark
    /// and dark-on-light, and Apple's guidance is to pick the one the background
    /// calls for rather than letting one of them lose its contrast.
    @Environment(\.colorScheme) private var colorScheme
    @State private var mode: AuthMode = .signIn
    @State private var draft = RegistrationDraft()
    /// The form's own refusal, as opposed to the server's — which arrives
    /// through `form.errorMessage`. Cleared on every submit and every mode
    /// change, so it can never describe something no longer on screen.
    @State private var localProblem: RegistrationProblem?
    /// The nonce and OAuth state of the ONE Apple authorization allowed to
    /// complete.
    ///
    /// Written when the system asks this view to configure a request, read once
    /// when that authorization completes, and cleared as it is read. Two rules
    /// follow from it, and both are the point:
    ///
    ///  * a completion arriving with nothing pending is REFUSED. It has no
    ///    nonce to be checked against, so sending it with a freshly minted one
    ///    would be sending a value the token cannot match — an attempt the
    ///    server must reject, reported to a user who did nothing wrong;
    ///  * a new request REPLACES a pending attempt, because it is a newer tap
    ///    and the system presents one authorization sheet at a time.
    ///
    /// It is deliberately not the same thing as `AccountSession`'s operation
    /// generation: that one supersedes in-flight NETWORK work, and this
    /// supersedes an authorization that has not reached the network at all.
    @State private var appleAttempt: AppleSignInAttempt?
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

            appleSection

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

    /// Sign in with Apple, below the password controls and visibly separated
    /// from them.
    ///
    /// Present in BOTH modes: an Apple authorization creates the account when
    /// there is none and signs in when there is, so hiding it on the
    /// create-account half would hide the shorter way to do exactly what that
    /// half is for. The system button carries Apple's own localized wording and
    /// picks it from the mode — "Sign in with" against "Sign up with" — which
    /// is why there is no catalog key for its label.
    ///
    /// It stays in the layout while the shared auth operation runs, disabled
    /// and dimmed rather than removed: a second authorization started over an
    /// in-flight exchange would race it for the same session, and a control
    /// that vanishes mid-submit takes the card's height with it. Hidden from
    /// VoiceOver while busy for the same reason the primary button is —
    /// opacity alone would leave an action that cannot be taken in the
    /// accessibility tree.
    private var appleSection: some View {
        VStack(spacing: 12) {
            HStack(spacing: 12) {
                line
                Text(L10n.t(.loginAppleDivider))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                line
            }
            // Hidden from VoiceOver: the button below is the control, and the
            // rule is a visual separator with nothing to announce.
            .accessibilityHidden(true)

            SignInWithAppleButton(mode == .register ? .signUp : .signIn) { request in
                let attempt = AppleSignInAttempt.fresh()
                appleAttempt = attempt
                // Full name and email are what Apple sends on the FIRST
                // authorization; without them a brand-new account could not
                // be created at all.
                request.requestedScopes = [.fullName, .email]
                // Raw, not hashed: Apple echoes this value verbatim in the
                // identity token's `nonce` claim and the server compares it
                // for equality.
                request.nonce = attempt.nonce
                // The nonce binds the token cryptographically; state binds the
                // callback to the attempt whose nonce this view still holds.
                request.state = attempt.state
                // A new attempt supersedes whatever the last one said.
                localProblem = nil
                session.dismissAccountAccessError()
            } onCompletion: { result in
                completeAppleSignIn(result)
            }
            // Apple's own two styles, picked by scheme so the control keeps the
            // contrast Apple designed it for in both.
            .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
            // Apple's minimum height, and the same visual weight as the primary
            // button above it.
            .frame(minHeight: 44)
            .frame(maxWidth: .infinity)
            .disabled(form.isBusy)
            .opacity(form.isBusy ? 0.4 : 1)
            .accessibilityHidden(form.isBusy)
        }
    }

    private var line: some View {
        Rectangle()
            .fill(Color.secondary.opacity(0.25))
            .frame(height: 1)
    }

    /// The result of one Apple authorization.
    ///
    /// Three outcomes, and the difference between them is what the user sees:
    /// a cancellation says nothing at all, a credential missing what the
    /// exchange needs says so without claiming a server refused it, and a
    /// complete credential goes to the session, which owns everything after.
    private func completeAppleSignIn(_ result: Result<ASAuthorization, Error>) {
        // A completion with no pending attempt is stale — an authorization this
        // view no longer holds a nonce for — and there is nothing honest to do
        // with it. A successful Apple credential is correlated below BEFORE the
        // attempt is consumed, so an older callback cannot erase a newer one.
        guard let attempt = appleAttempt else { return }

        switch result {
        case let .success(authorization):
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
                appleAttempt = nil
                session.reportAppleSignInFailure(AppleSignInError.unexpectedCredential)
                return
            }
            // `state` is the identity of the request, while `nonce` is the
            // cryptographic binding inside its token. Both are needed: without
            // this comparison, a late completion from an older request would be
            // sent with the newer request's nonce and look like a rejection.
            guard attempt.matches(returnedState: credential.state) else { return }
            appleAttempt = nil
            do {
                let fields = try AppleSignInCredential.read(
                    identityToken: credential.identityToken,
                    authorizationCode: credential.authorizationCode)
                // Apple sends the name on the first authorization only. Empty
                // afterwards, and empty is what the server is given — a name
                // derived from the address would be one this app made up.
                let name = AppleSignInName.format(givenName: credential.fullName?.givenName,
                                                  familyName: credential.fullName?.familyName)
                Task {
                    await session.logInWithApple(idToken: fields.idToken,
                                                 authorizationCode: fields.authorizationCode,
                                                 nonce: attempt.nonce,
                                                 name: name)
                }
            } catch {
                session.reportAppleSignInFailure(error)
            }
        case let .failure(error):
            appleAttempt = nil
            // Cancelling asks for nothing to happen, and an error sentence is
            // something happening. Everything else is reported.
            if (error as? ASAuthorizationError)?.code == .canceled { return }
            session.reportAppleSignInFailure(AppleSignInError.authorizationFailed)
        }
    }

    private func switchMode() {
        mode = mode.toggled
        // The refusal belonged to the other half. The typed fields stay: the
        // email is the same email either way, and retyping it on a phone is the
        // cost this one-form design exists to remove.
        localProblem = nil
        // An Apple attempt started under the old half is abandoned with it: its
        // completion would arrive against a form that has moved on, and the
        // guard in `completeAppleSignIn` is what makes dropping it safe.
        appleAttempt = nil
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
        // Snapshot the submitted form before the asynchronous session action.
        // Disabled state follows that action's published busy state and cannot
        // make later reads of these still-editable fields atomic.
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
}
