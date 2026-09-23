import SwiftUI
import RelayiumAppKit

/// Asks for a password-reset email (A18), and nothing more.
///
/// What it deliberately does NOT do is the reset itself. The emailed link opens
/// relayium.com's `/reset-password` page, which spends the one-time token,
/// knows when it has expired or been used, and sets the new password; the
/// server revokes the account's existing sessions in the same transaction. So
/// the app's part ends at "the request was accepted", and the way back is
/// signing in with the new password on the form this sheet was opened from.
///
/// The result sentence is the same for every address. `POST
/// /api/auth/password/forgot` answers 200 whether or not an account uses it,
/// and a sheet that said "no account found" would be the enumeration oracle the
/// endpoint refuses to be. A 429 or an outage reads as exactly that — never as a
/// wrong password, which nobody typed here.
struct PasswordResetRequestView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model = AppEnvironment.makePasswordResetRequestModel(
        transport: UITestMode.makeAccountTransport())
    @State private var email: String

    init(initialEmail: String) {
        _email = State(initialValue: initialEmail)
    }

    var body: some View {
        NavigationStack {
            DestinationPage {
                SectionCard(L10n.t(.loginResetTitle)) {
                    Text(L10n.t(.loginResetBody))
                        .font(.callout)
                        .foregroundStyle(Palette.supportingLabel)
                        .fixedSize(horizontal: false, vertical: true)

                    TextField(L10n.t(.loginEmail), text: $email)
                        .accessibilityLabel(L10n.t(.loginEmail))
                        .accessibilityIdentifier("account.resetEmail")
                        .textContentType(.username)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.send)
                        .onSubmit(send)
                        .textFieldStyle(.roundedBorder)
                        .disabled(model.isSending)

                    switch model.state {
                    case let .requested(address):
                        // `.info`: nothing went wrong, and the sentence claims
                        // acceptance, not delivery.
                        InlineMessage(.info, L10n.t(.loginResetRequested, [L10n.token(address)]))
                    case let .failed(message):
                        InlineMessage(.warning, message)
                    case .emailMissing:
                        InlineMessage(.warning, L10n.t(.loginErrorEmailMissing))
                    case .idle, .sending:
                        EmptyView()
                    }

                    // One slot: the progress line replaces the button, so a
                    // second tap cannot start a second request.
                    if model.isSending {
                        ProgressView { Text(L10n.t(.loginResetSending)) }
                            .frame(maxWidth: .infinity)
                    } else {
                        Button(action: send) {
                            Text(L10n.t(.loginResetSend)).frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .accessibilityIdentifier("account.resetSend")
                    }

                    Button(L10n.t(.contentBackToSignIn)) { dismiss() }
                        .font(.callout)
                        .textAction()
                        .frame(minHeight: Metrics.hitTarget)
                        .contentShape(Rectangle())
                        .accessibilityIdentifier("account.resetBack")
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.t(.commonCancel)) { dismiss() }
                }
            }
        }
        // A request still in flight when the sheet goes belongs to nobody.
        .onDisappear { model.cancel() }
    }

    private func send() {
        let submitted = email
        Task { await model.request(email: submitted) }
    }
}
