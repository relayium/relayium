import SwiftUI
import RelayiumAppKit

/// What a feature shows when it genuinely needs an account and does not have
/// one yet.
///
/// **No dead controls.** The pattern this replaces is
/// `.disabled(token.isEmpty)`: a greyed button states no reason and offers no
/// way forward, so the user is left to guess whether the feature is broken,
/// unavailable here, or waiting on them. Every case below names what is true and
/// renders the one action that resolves it.
///
/// `.allowed` is deliberately not a rendered case — a call site that hands this
/// view an allowed gate has forgotten to render the feature itself, which is a
/// programming error rather than a state the user can be in.
struct CapabilityGateView: View {
    private let gate: AccountGate
    private let title: String
    /// `body:` is the outward name; stored as `message` because `body` is
    /// already taken by `View`.
    private let message: String
    private let onSignIn: () -> Void

    @EnvironmentObject private var session: AccountSession

    /// `onSignIn` selects the Account destination. Passed in rather than reached
    /// for, so this component knows nothing about the navigation model.
    init(gate: AccountGate, title: String, body: String, onSignIn: @escaping () -> Void) {
        self.gate = gate
        self.title = title
        self.message = body
        self.onSignIn = onSignIn
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            switch gate {
            case .allowed:
                Color.clear
                    .frame(height: 0)
                    // nonlocalized: developer assertion, never rendered
                    .onAppear { assertionFailure("CapabilityGateView was handed .allowed") }

            case .loading:
                // Not the sign-in gate: the account may well be there, and the
                // app simply does not know yet.
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(L10n.t(.accountRestoring)).foregroundStyle(.secondary)
                }

            case .signInRequired:
                EmptyStateView(symbol: "person.crop.circle.badge.questionmark",
                               title: title,
                               body: message,
                               actionTitle: L10n.t(.gateSignIn),
                               action: onSignIn)
                Button(L10n.t(.gateCreateAccount)) {
                    NSWorkspace.shared.open(AppEnvironment.accountWebURL)
                }
                .buttonStyle(.link)

            case let .unavailable(text):
                InlineMessage(.failure, text)
                Button(L10n.t(.commonTryAgain)) { Task { await session.refresh() } }

            case let .verifyEmail(email):
                Text(L10n.t(.contentCheckEmailTitle)).font(.headline)
                // The address is the user's own and is isolated, not translated.
                Text(L10n.t(.contentCheckEmailBody, [L10n.token(email)]))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button(L10n.t(.contentOpenRelayium)) {
                    NSWorkspace.shared.open(AppEnvironment.accountWebURL)
                }

            case let .pendingDeletion(purgeAfter, reactivateToken):
                Text(L10n.t(.contentPendingDeletionTitle)).font(.headline)
                Text(L10n.t(.contentPendingDeletionBody, [
                    L10n.date(Date(timeIntervalSince1970: TimeInterval(purgeAfter)),
                              dateStyle: .medium, timeStyle: .none),
                ]))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                // The token is the whole button: it is what makes reactivation
                // one click on a web session the frozen account cannot create.
                Button(L10n.t(.contentReactivate)) {
                    NSWorkspace.shared.open(
                        AppEnvironment.reactivateWebURL(token: reactivateToken))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
