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
    /// Whether this gate is the whole screen or only part of one.
    ///
    /// The Device Inbox and Send a link are gated entire — signed out, the gate
    /// IS the destination — so their sign-in action is the page's primary exit
    /// and is drawn as one. The Cross-network screen gates only the half that
    /// spends an account: joining a code is right beside it and needs nothing,
    /// so a prominent Sign in there would outrank the control the reader can
    /// actually use.
    private let isWholeSurface: Bool
    private let onAccount: (AuthMode) -> Void

    @EnvironmentObject private var session: AccountSession

    /// `onAccount` selects the Account destination, on the half of its form the
    /// caller names. Passed in rather than reached for, so this component knows
    /// nothing about the navigation model.
    ///
    /// It takes the mode because **Create an account** used to open
    /// relayium.com. Routing it to the Account destination without saying which
    /// half to show would land the user on a sign-in form — a button that names
    /// one thing and produces another, which is the same defect as the greyed
    /// control this whole view exists to replace.
    init(gate: AccountGate, title: String, body: String,
         isWholeSurface: Bool = false,
         onAccount: @escaping (AuthMode) -> Void) {
        self.gate = gate
        self.title = title
        self.message = body
        self.isWholeSurface = isWholeSurface
        self.onAccount = onAccount
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
                ProgressView { Text(L10n.t(.accountRestoring)) }
                    .controlSize(.small)

            case .signInRequired:
                EmptyStateView(symbol: "person.crop.circle.badge.questionmark",
                               title: title,
                               body: message,
                               actionTitle: L10n.t(.gateSignIn),
                               actionIsProminent: isWholeSurface,
                               action: { onAccount(.signIn) })
                // Registration is in the app. This used to open relayium.com,
                // which was the only place an account could be created; it now
                // opens the same Account destination the button above does, on
                // its create-account half.
                Button(L10n.t(.gateCreateAccount)) { onAccount(.register) }
                .buttonStyle(.link)
                .accessibilityIdentifier("account.create")

            case let .unavailable(text):
                InlineMessage(.failure, text)
                exit(L10n.t(.commonTryAgain)) { Task { await session.refresh() } }

            case let .verifyEmail(email):
                Text(L10n.t(.contentCheckEmailTitle)).font(.headline)
                // The address is the user's own and is isolated, not translated.
                Text(L10n.t(.contentCheckEmailBody, [L10n.token(email)]))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                // To the Account destination, which owns the resend action and
                // the way back — not to a website, and not to a second copy of
                // the resend button that would have to keep its own busy state
                // in step with the first.
                exit(L10n.t(.gateOpenAccount)) { onAccount(.signIn) }

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
                exit(L10n.t(.contentReactivate)) {
                    NSWorkspace.shared.open(
                        AppEnvironment.reactivateWebURL(token: reactivateToken))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The one action a gated branch offers, drawn at the weight its scope
    /// earns.
    ///
    /// Every branch here except `.loading` ends in exactly one control, and on a
    /// whole-surface gate that control is the only thing on the screen — so it
    /// is the primary exit in all of them, not only in `.signInRequired`.
    /// Applying it per branch would have left a signed-out reader with a
    /// prominent Sign in and an unverified one with the same screenful of
    /// explanation and a control that looks incidental.
    ///
    /// A style and nothing more: no `keyboardShortcut(.defaultAction)`, because
    /// this view renders inside forms that own Return.
    @ViewBuilder
    private func exit(_ title: String, action: @escaping () -> Void) -> some View {
        if isWholeSurface {
            Button(title, action: action)
                .buttonStyle(.borderedProminent)
        } else {
            Button(title, action: action)
        }
    }
}
