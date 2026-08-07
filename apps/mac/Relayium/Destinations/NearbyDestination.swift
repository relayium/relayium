import SwiftUI
import RelayiumAppKit

/// Same-network transfer, in both directions, and the only destination an
/// unsolicited session can arrive at.
///
/// **Nothing here consults the account, by name or by reference** — no
/// account object, no bearer, no login state — and `MacSurfaceGuardTests`
/// checks that as a source property rather than as an intention. The reason it
/// is worth a guard: the code-less rendezvous room mints nothing and `/api/ice`
/// answers it STUN-only, so both directions genuinely reach the transport with
/// no credential. The old shell hid all of it behind a sign-in form anyway,
/// which is the single most damaging thing it did.
struct NearbyDestination: View {
    @EnvironmentObject private var navigation: AppNavigationModel
    @EnvironmentObject private var presence: TransferPresence
    @EnvironmentObject private var verification: VerificationPreference
    @EnvironmentObject private var discovery: LanDiscoveryModel
    @EnvironmentObject private var receive: NearbyReceiveModel
    @EnvironmentObject private var fileModel: RealtimeSessionModel
    @EnvironmentObject private var textModel: RealtimeTextSessionModel

    private var busy: Bool { fileModel.isBusy || textModel.isBusy }

    /// True while any session at all is on a model — including one that has
    /// finished or failed and is still on screen waiting to be dismissed.
    /// `.idle` is the only state that means "there is nothing to present".
    private var anySessionLive: Bool {
        fileModel.state != .idle || textModel.state != .idle
    }

    private var sessionLocked: Bool {
        presence.owner != nil || anySessionLive
    }

    var body: some View {
        DestinationScaffold(title: L10n.t(.navNearby),
                            subtitle: L10n.t(.navNearbySubtitle),
                            contentMaxWidth: nil) {
            if let owner = presence.owner, owner != .nearby {
                busyElsewhere(owner)
            } else {
                modePicker
                SectionCard(title: L10n.t(.nearbyHeading)) {
                    NearbyPane(discovery: discovery,
                               receive: receive,
                               fileModel: fileModel,
                               textModel: textModel,
                               mode: presence.mode)
                }
                verificationSetting
            }
            InlineMessage(.info, L10n.t(.nearbyNoAccountNeeded))
                .frame(maxWidth: 720, alignment: .leading)
        }
        // A session nobody asked for decides its own kind, so the mode has to
        // follow it rather than the other way round. `task(id:)` rather than
        // `onChange`, because this window may have been closed when the session
        // started and rebuilt — with the mode back at its default — while it is
        // still running.
        .task(id: receive.activeKind) { followIncoming() }
    }

    /// Explicit intent selection: neither a roster entry nor a pairing code
    /// encodes whether the user means files or text, so the app must never
    /// guess. One question, asked once — the answer lives in `TransferPresence`
    /// and the pairing-code destination reads the same one.
    private var modePicker: some View {
        Picker(L10n.t(.hubTransferType), selection: Binding(
            get: { presence.mode },
            set: { presence.selectMode($0) }
        )) {
            Text(L10n.t(.hubFiles)).tag(TransferMode.files)
            Text(L10n.t(.hubText)).tag(TransferMode.text)
        }
        .pickerStyle(.segmented)
        .frame(maxWidth: 720, alignment: .leading)
        .disabled(sessionLocked)
        .accessibilityHint(L10n.t(.hubTransferTypeHint))
    }

    /// The other direct destination is presenting the session. Say so and offer
    /// the way to it — never a second copy of the session with its own Cancel,
    /// which is what rendering both would produce, since both drive the same two
    /// models.
    private func busyElsewhere(_ owner: AppDestination) -> some View {
        EmptyStateView(symbol: "arrow.left.arrow.right.circle",
                       title: L10n.t(.presenceBusyTitle),
                       body: L10n.t(.presenceBusyBody),
                       actionTitle: L10n.t(.presenceShowIt)) {
            navigation.select(owner)
        }
    }

    /// Moved here verbatim from the deleted `DirectHubPane`: it applies to both
    /// kinds of session, and a setting that only appears on the surface you are
    /// not looking at is a setting nobody finds. Locked while a session is live,
    /// because the models read it when the SAS arrives — flipping it
    /// mid-handshake would make the gate depend on timing.
    ///
    /// Deliberately not a `SectionCard`: the toggle's own sentence is the only
    /// truthful title such a card could carry, and a card that repeats its title
    /// as its first control reads worse than the plain group this already was.
    private var verificationSetting: some View {
        VStack(alignment: .leading, spacing: 6) {
            Toggle(L10n.t(.verifyToggle), isOn: Binding(
                get: { verification.requiresSASConfirmation },
                set: { if !sessionLocked { verification.requiresSASConfirmation = $0 } }
            ))
                .disabled(sessionLocked)
            Text(L10n.t(.verifyExplainWhat))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text(L10n.t(.verifyExplainEncryption))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(maxWidth: 720, alignment: .leading)
    }

    /// Puts an incoming session on screen in the mode that can render it.
    /// Without this, a file transfer arriving while the mode sat on Text shows
    /// the text pane's idle state and the transfer is invisible — and switching
    /// the picker by hand would be blocked, because it is disabled while busy.
    private func followIncoming() {
        guard let kind = receive.activeKind else { return }
        presence.claim(AppRouting.destination(forIncoming: kind),
                       mode: kind == .file ? .files : .text)
    }
}
