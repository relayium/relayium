import AppKit
import SwiftUI
import RelayiumAppKit
import RelayiumKit

/// Pairing-code half of an ephemeral text session: mint a code, or join one.
/// Everything from "a peer has been reached" onwards is
/// `RealtimeTextSessionView`, shared with the nearby pane.
///
/// Gated exactly like `DirectPane`, and for the same server-side reason:
/// minting reserves relay capacity billed to the account that created it,
/// joining reserves nothing. The join field is rendered and enabled identically
/// signed out.
struct RealtimeTextPane: View {
    @ObservedObject var model: RealtimeTextSessionModel
    /// Not `token: String`. The hand-rolled `if token.isEmpty` hint this
    /// replaces could only ever say one thing, and said it even when the real
    /// reason was a broken credential or an unverified address.
    let gate: AccountGate

    @EnvironmentObject private var navigation: AppNavigationModel
    @EnvironmentObject private var presence: TransferPresence

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            switch model.state {
            case .idle:
                createCard
                joinCard
            case .failed, .ended, .refused, .unsupported:
                RealtimeTextSessionView(model: model)
                // None of these four is `.idle`, so the dead connection and
                // retained transcript still belong to this task. Expose only
                // the explicit cleanup boundary: start controls here would let
                // a new session replace the history before the user chose Done.
                Button(L10n.t(.commonDone)) { model.reset() }
                    .buttonStyle(.bordered)
            case .minting:
                SectionCard(title: L10n.t(.textStartHeading)) {
                    ProgressView(L10n.t(.textCreatingCode)).controlSize(.small)
                    Button(L10n.t(.commonCancel)) { model.reset() }
                        .buttonStyle(.bordered)
                }
            case let .showingCode(code, expiresAt):
                SectionCard(title: L10n.t(.textStartHeading)) {
                    showing(code: code, expiresAt: expiresAt)
                }
            case .joining, .connecting, .verifying, .waitingAccept,
                 .incomingRequest, .open:
                RealtimeTextSessionView(model: model)
            }
        }
    }

    // MARK: - create (needs an account)

    private var createCard: some View {
        SectionCard(title: L10n.t(.textStartHeading)) {
            if case let .allowed(access) = gate {
                VStack(alignment: .leading, spacing: 6) {
                    Text(L10n.t(.textStartBody))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Button(L10n.t(.textCreateCode)) { createCode(token: access.token) }
                        .buttonStyle(.borderedProminent)
                }
            } else {
                CapabilityGateView(gate: gate,
                                   title: L10n.t(.gateCreateCodeTitle),
                                   body: L10n.t(.gateCreateCodeBody),
                                   onAccount: { navigation.selectAccount(intent: $0) })
            }
        }
    }

    private func showing(code: String, expiresAt: Int64) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n.t(.textGiveCode))
                .font(.subheadline.weight(.semibold))
            SecurityCodeText(code: code, style: .pairing)
            Text(L10n.t(.commonExpires, [
                L10n.date(Date(timeIntervalSince1970: TimeInterval(expiresAt)),
                          dateStyle: .none, timeStyle: .short),
            ]))
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(L10n.t(.pairingCodeExpiryNote))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("pairing-code-expiry-note")
            if let joinURL = productionPairingJoinURL(code: code, mode: .text) {
                PairingCodeHandoffView(url: joinURL) { model.reset() }
            }
        }
    }

    // MARK: - join (needs nothing)

    /// The one keyboard default in the text mode of this destination, chosen for
    /// the reason `DirectPane.joinCard` records at length: create and join are on
    /// screen together, so exactly one of them may own Return, and only join has
    /// a precondition a single field settles. Both modes answer Return the same
    /// way, so the keystroke does not change meaning with the mode picker.
    private var joinCard: some View {
        SectionCard(title: L10n.t(.textJoinHeading)) {
            HStack {
                TextField(L10n.t(.commonCode), text: $model.joinCode)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 140)
                    // Six digits, normalized on every keystroke by the model —
                    // which is also what keeps a leading 1 typeable.
                    .onChange(of: model.joinCode) { model.updateJoinCode($0) }
                Button(L10n.t(.commonJoin)) { join() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!model.canJoin)
            }
            InlineMessage(.info, L10n.t(.directJoinNoAccountNeeded))
        }
    }

    // MARK: - actions

    private func join() {
        // Capture the validated intent before claim. An incomplete value read
        // after the Task starts is refused by the text model without leaving
        // idle, which would otherwise strand the synchronous ownership claim.
        let code = model.joinCode
        guard model.canJoin else { return }
        // Claimed before connecting, so the session this starts is presented
        // here rather than in Nearby, which drives the same model.
        guard presence.beginSession(.pairingCode, mode: .text) else { return }
        Task { await model.join(code: code) }
    }

    private func createCode(token: String) {
        guard presence.beginSession(.pairingCode, mode: .text) else { return }
        Task { await mintAndWait(token: token) }
    }

    private func mintAndWait(token: String) async {
        await model.mintCode(token: token)
        guard case let .showingCode(code, _) = model.state else { return }
        await model.join(code: code, role: .initiator)
    }
}
