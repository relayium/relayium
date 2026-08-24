import AuthenticationServices
import RelayiumAppKit
import RelayiumKit
import RelayiumStoreKit
import SwiftUI

/// **The Mac App Store build's half of the distribution seam.**
///
/// A member of the `RelayiumAppStore` target and of nothing else. It declares
/// the same names as `DirectDistribution.swift` — which is a member of
/// `Relayium` and of nothing else — so the shared scene, settings window,
/// account screen and version gate compile into either product unchanged.
///
/// **This file is the only place `RelayiumStoreKit` is imported by an app, and
/// the only place a purchase model is assembled.** Both facts are structural:
/// the direct target does not compile this file, so it cannot link the adapter
/// and cannot construct a model however its source is edited.
///
/// What is deliberately absent, and why each absence is load-bearing:
///
///   - **No `import Sparkle`.** The App Store is this build's update mechanism.
///     A second one is grounds for rejection, and Sparkle additionally needs a
///     `temporary-exception.mach-lookup` sandbox entitlement that App Store
///     review does not grant. The MAS entitlements file has no such exception,
///     and `StoreKitLinkageTests` checks both halves.
///   - **No product identifiers.** They come from the server's catalog, over an
///     authenticated request, keyed by this bundle's own identity. A binary that
///     carried them could be shipped pointing at a product no row maps — a
///     failure that lands after the customer has been charged.
enum AppDistribution {
    /// Distributed by Apple, updated by the App Store, billed by StoreKit.
    static let channel: AppDistributionChannel = .macAppStore

    /// The one purchase model in the process, built for the app's lifetime.
    ///
    /// **App-scoped, not screen-scoped, and that is the whole reason this
    /// returns an object the scene keeps.** The model drains the store's update
    /// stream, which is how a renewal, a refund, an Ask-to-Buy approval and — the
    /// case that matters — a purchase interrupted by a crash reach the account.
    /// Every one of those can arrive while no window is open; this app's window
    /// is closable without ending the process, so a model owned by the account
    /// screen would be absent for exactly the intervals it exists to cover.
    ///
    /// Neither closure is state this model may hold. The bearer is read at the
    /// moment of use, because a token captured when a purchase sheet opened can
    /// be revoked before the user finishes with it; the refresh is the session's
    /// own, so what the app renders after a purchase is the SERVER's answer and
    /// never this model's.
    @MainActor
    static func makeSubscriptionModel(
        bearer: @escaping @MainActor () -> String?,
        refreshAccount: @escaping @MainActor () async -> Void
    ) -> AppleSubscriptionModel? {
        // The bundle identity is read from the running bundle rather than
        // written down here, so it cannot drift from what the signed binary
        // actually is — which is also the identity Apple puts in the signed
        // transaction the server verifies. A bundle that cannot name itself is
        // broken beyond anything this surface should paper over, so it gets no
        // model rather than one that asks the server about "".
        guard let bundleID = Bundle.main.bundleIdentifier, !bundleID.isEmpty else { return nil }
        // **The purchase-continuation capability, which is what makes a
        // cancelled sheet recoverable.** Without it a user who opens the
        // StoreKit sheet and presses Cancel can never buy again: the server has
        // armed one dispatch for the authority generation and nothing resolves
        // it.
        //
        // A locked or unavailable keychain leaves this nil. The model remains
        // present so Restore Purchases and Manage Subscription still work, but
        // its production policy refuses to arm a new sheet rather than silently
        // falling back to the cancellation-deadlocking one-shot protocol.
        let continuation = AppEnvironment.makeApplePurchaseContinuation()
        return AppleSubscriptionModel(
            store: StoreKitSubscriptionStore(),
            billing: AppEnvironment.makeAppleBillingService(),
            bundleID: bundleID,
            bearer: bearer,
            refreshAccount: refreshAccount,
            continuation: continuation?.repository,
            appInstanceID: continuation?.appInstanceID,
            purchaseDispatchPolicy: .durableContinuationRequired)
    }
}

/// The App Store build has no updater of its own: the App Store updates it.
///
/// An empty type rather than a missing one, because the shared scene owns a
/// value of this name and hands it to the settings window. Nothing is started,
/// nothing is observed, and no update-related code runs in this product.
@MainActor
final class AppUpdates {
    /// Where the version policy's Update button goes in this build.
    ///
    /// **A fixed literal, and it has to be.** The direct build hands this action
    /// to Sparkle; this one has no updater and cannot install anything, so the
    /// most it can honestly do is open the App Store's own Updates page — which
    /// is why the button beside it reads "Open the App Store" rather than
    /// "Update Now". The address is compiled in and comes from nowhere else: the
    /// policy document carries no URL of any kind, and this is the seam where an
    /// attacker-supplied one would otherwise be spent.
    // nonlocalized: the App Store's own URL scheme, never displayed
    static let updatesPage = URL(string: "macappstore://showUpdatesPage")!

    func startUpdate() {
        NSWorkspace.shared.open(Self.updatesPage)
    }
}

/// No "Check for Updates…" item in the app menu.
///
/// `EmptyView` inside `CommandGroup` contributes no menu item at all, which is
/// the correct App Store behaviour: an item that opened a Sparkle window would
/// be a second update mechanism, and one that did nothing would be worse.
struct AppUpdatesMenuItem: View {
    let updates: AppUpdates

    var body: some View { EmptyView() }
}

/// No **Updates** tab in the settings window.
///
/// `EmptyView` inside `TabView` contributes no tab, so the window is the General
/// tab alone. What the direct build's pane offers — an automatic-check toggle, a
/// last-checked timestamp, a check-now button — are all the App Store's to
/// decide in this product, and restating them here would be three controls that
/// describe nothing this app does.
struct AppUpdatesSettingsTab: View {
    let updates: AppUpdates

    var body: some View { EmptyView() }
}

/// **Native Sign in with Apple — the Mac App Store build's control.**
///
/// Its twin in `DirectDistribution.swift` is an `EmptyView`, and the difference
/// is target MEMBERSHIP rather than an `#if`: the direct target does not compile
/// this file, so it cannot contain `ASAuthorizationAppleIDRequest` however its
/// source is edited. That is the same mechanism, and the same reasoning, that
/// keeps Sparkle out of this build and StoreKit out of that one — an absence
/// enforced by the project rather than by a conditional somebody can flip.
///
/// It matters here for a concrete reason: `com.apple.developer.applesignin` is
/// an entitlement Apple grants per provisioning profile. The direct build's
/// profile does not carry it, and a Developer ID binary that called
/// `ASAuthorizationController` would fail at runtime in front of the user rather
/// than at build time in front of an engineer.
///
/// **This is additive, never a replacement.** `LoginView` renders the browser
/// device-flow sign-in unconditionally in every distribution, this control
/// included; a Mac App Store user gets both. `MacAppleSignInGuardTests` reads
/// the sources and the project file to keep all of that true.
///
/// The exchange itself is deliberately not reimplemented: the nonce, the OAuth
/// `state` correlation, the credential read and `AccountSession.logInWithApple`
/// are the same hardened path the iOS app has shipped, and duplicating any of it
/// here would be a second copy of security-sensitive logic to keep correct.
struct AppleSignInSection: View {
    /// Which half of the form is showing. Apple's own control carries the
    /// wording — "Sign in with" against "Sign up with" — which is why there is
    /// no catalog key for its label.
    let mode: AuthMode
    /// The shared auth operation is running. The control stays in the layout,
    /// disabled: a second authorization started over an in-flight exchange would
    /// race it for the same session, and a control that vanishes mid-submit
    /// takes the card's height with it.
    let isBusy: Bool

    @EnvironmentObject private var session: AccountSession
    /// Apple's two system styles are light-on-dark and dark-on-light; the
    /// guidance is to pick the one the background calls for.
    @Environment(\.colorScheme) private var colorScheme
    /// The nonce and OAuth state of the ONE authorization allowed to complete.
    /// A completion whose `state` does not match this is a late callback from an
    /// attempt the view has moved on from, and is dropped.
    @State private var attempt: AppleSignInAttempt?

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
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
                let fresh = AppleSignInAttempt.fresh()
                attempt = fresh
                // Full name and email are what Apple sends on the FIRST
                // authorization; without them a brand-new account could not be
                // created at all.
                request.requestedScopes = [.fullName, .email]
                // Raw, not hashed: Apple echoes this value verbatim in the
                // identity token's `nonce` claim and the server compares it for
                // equality. A SHA-256 would never match.
                request.nonce = fresh.nonce
                // The nonce binds the token cryptographically; `state` binds the
                // callback to the attempt this view still holds a nonce for.
                request.state = fresh.state
                session.dismissAccountAccessError()
            } onCompletion: { result in
                complete(result)
            }
            .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
            .frame(height: 28)
            .frame(maxWidth: 280)
            .disabled(isBusy)
            .opacity(isBusy ? 0.4 : 1)
            // Opacity alone would leave an action that cannot be taken in the
            // accessibility tree.
            .accessibilityHidden(isBusy)
            .accessibilityIdentifier("account.apple")
        }
    }

    /// The rule either side of "or". The system's own separator colour rather
    /// than a chosen opacity, so it tracks Increase Contrast.
    private var line: some View {
        Rectangle()
            .fill(Color.primary.opacity(0.10))
            .frame(height: 1)
            .frame(maxWidth: 120)
    }

    /// The result of one Apple authorization.
    ///
    /// Three outcomes, and the difference between them is what the user sees: a
    /// cancellation says nothing at all, a credential missing what the exchange
    /// needs says so without claiming a server refused it, and a complete
    /// credential goes to the session, which owns everything after.
    private func complete(_ result: Result<ASAuthorization, Error>) {
        // A completion with no pending attempt is stale — an authorization this
        // view no longer holds a nonce for — and there is nothing honest to do
        // with it.
        guard let attempt else { return }

        switch result {
        case let .success(authorization):
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
                self.attempt = nil
                session.reportAppleSignInFailure(AppleSignInError.unexpectedCredential)
                return
            }
            // Correlated BEFORE the attempt is consumed, so an older callback
            // cannot erase a newer pending authorization. Without this
            // comparison a late completion would be sent with the NEWER
            // request's nonce and come back looking like a server rejection.
            guard attempt.matches(returnedState: credential.state) else { return }
            self.attempt = nil
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
            self.attempt = nil
            // Cancelling asks for nothing to happen, and an error sentence is
            // something happening. Everything else is reported.
            if (error as? ASAuthorizationError)?.code == .canceled { return }
            session.reportAppleSignInFailure(AppleSignInError.authorizationFailed)
        }
    }
}
