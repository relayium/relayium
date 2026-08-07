import SwiftUI
import UniformTypeIdentifiers
import RelayiumAppKit
import RelayiumKit

/// Peer-to-peer file transfer over a six-digit pairing code: mint one or join
/// one, optionally compare the phrase, send. Holds no decisions — every state it
/// renders is covered by RealtimeSessionModelTests, including whether
/// `.verifying` is reached at all.
///
/// The two halves are gated differently on purpose, and that asymmetry is the
/// whole point of taking an `AccountGate` here rather than a bearer string.
/// **Minting** needs an account, because the code's owner pays for the traffic
/// relayed through it. **Joining** needs nothing: the join field and its button
/// are rendered and enabled identically signed out, and the server never asks
/// this side for a credential.
struct DirectPane: View {
    @ObservedObject var model: RealtimeSessionModel
    /// Not `token: String`. An empty-string bearer said "signed out", "still
    /// restoring", "email unverified" and "the credential this app holds is
    /// broken" in the same three greyed pixels; this says which.
    let gate: AccountGate

    @EnvironmentObject private var navigation: AppNavigationModel
    @EnvironmentObject private var presence: TransferPresence
    /// Files the OS opened with this app. Read-only here — this pane takes only
    /// the batch addressed to it.
    @EnvironmentObject private var fileOpenRouting: AppFileOpenCoordinator

    @StateObject private var selection = SelectionStore()
    @State private var stagingError: String?

    private var fileAdoptionBusy: Bool { presence.owner != nil || model.isBusy }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            switch model.state {
            case .idle:
                createCard
                joinCard
            case .failed:
                // The failure below still owns its dead connection and may
                // own a partial receive. Starting again before Done would skip
                // the cleanup boundary and replace the task the user is still
                // reading, so the start controls return only after cancel.
                EmptyView()
            case .minting:
                SectionCard(title: L10n.t(.directSendHeading)) {
                    ProgressView(L10n.t(.directCreatingCode)).controlSize(.small)
                    PendingFileList(sessionFiles: model.sessionFiles)
                    Button(L10n.t(.commonCancel)) { model.cancel() }
                        .buttonStyle(.bordered)
                }
            case let .showingCode(code, expiresAt):
                SectionCard(title: L10n.t(.directSendHeading)) {
                    // The picker is gone, but this is the moment the sender is
                    // actually handing the code to somebody. Keep the staged
                    // manifest visible so they can still verify every name and
                    // size before the peer joins.
                    PendingFileList(sessionFiles: model.sessionFiles)
                    showing(code: code, expiresAt: expiresAt)
                }
            case .joining, .connecting, .verifying, .transferring, .completed:
                // Shared with the nearby pane: everything past "a peer has been
                // reached" is identical whether the peer came from a code or
                // from the same-network roster.
                RealtimeFileSessionView(model: model)
            }

            if case let .failed(message) = model.state {
                InlineMessage(.failure, message)
                PendingFileList(sessionFiles: model.sessionFiles)
                // `.failed` is not `.idle`, so presence stays owned and Nearby
                // keeps showing "this session is shown elsewhere" until Done.
                // Cancel rather than a bare state reset: the failure may have
                // left a partial write to discard.
                Button(L10n.t(.commonDone)) { model.cancel() }
                    .buttonStyle(.bordered)
            }
            if let stagingError {
                InlineMessage(.failure, stagingError)
            }
        }
        // Files opened from Finder or dropped on the Dock icon, for the same
        // reasons and by the same rule as Nearby's. Keyed on both the batch and
        // `busy`: a batch that arrived mid-session is never republished, so
        // keying on the batch alone would strand it here.
        .task(id: FileOpenAdoption(staged: fileOpenRouting.staged, busy: fileAdoptionBusy)) {
            adoptOpenedFiles()
        }
    }

    /// Stage a batch the OS opened, if this pane is the one it was addressed to
    /// and is free to take it. `add`, not `replace` — the same call the drop
    /// zone makes.
    private func adoptOpenedFiles() {
        guard let batch = fileOpenRouting.batch(for: .pairingCode, busy: fileAdoptionBusy)
        else { return }
        selection.add(batch.urls)
        fileOpenRouting.consume(batch)
    }

    // MARK: - create (needs an account)

    private var createCard: some View {
        SectionCard(title: L10n.t(.directSendHeading)) {
            if case let .allowed(access) = gate {
                staging(token: access.token)
            } else {
                // No greyed Create button. The gate names what is true and
                // renders the one action that resolves it.
                CapabilityGateView(gate: gate,
                                   title: L10n.t(.gateCreateCodeTitle),
                                   body: L10n.t(.gateCreateCodeBody),
                                   onAccount: { navigation.selectAccount(intent: $0) })
            }
        }
    }

    private func staging(token: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            FileDropZone(store: selection, isBusy: model.isBusy) {
                Text(selection.summary ?? L10n.t(.directDropHint))
                    .font(.caption).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            PendingFileList(files: selection.files)
            if let message = selection.error {
                InlineMessage(.failure, message)
            }
            HStack {
                Button(L10n.t(.commonChooseFilesOrFolders)) { chooseFilesOrFolders(into: selection) }
                if !selection.isEmpty {
                    Button(L10n.t(.commonClear)) { selection.clear() }
                        .buttonStyle(.bordered)
                }
                Button(L10n.t(.directCreateCode)) { Task { await mintAndWait(token: token) } }
                    .buttonStyle(.borderedProminent)
                    // What is missing is named by the drop zone directly above,
                    // and adding it is one drop away — unlike an account, which
                    // is why that one gets a gate instead.
                    .disabled(selection.isEmpty)
            }
        }
    }

    private func showing(code: String, expiresAt: Int64) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n.t(.directGiveCode)).font(.subheadline.weight(.semibold))
            SecurityCodeText(code: code, style: .pairing)
            Text(L10n.t(.commonExpires, [
                L10n.date(Date(timeIntervalSince1970: TimeInterval(expiresAt)),
                          dateStyle: .none, timeStyle: .short),
            ]))
                .font(.caption).foregroundStyle(.secondary)
            Text(L10n.t(.pairingCodeExpiryNote))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("pairing-code-expiry-note")
            if let joinURL = productionPairingJoinURL(code: code, mode: .files) {
                PairingCodeHandoffView(url: joinURL) { model.cancel() }
            }
        }
    }

    // MARK: - join (needs nothing)

    /// **The one keyboard default on this destination**, and the choice is worth
    /// writing down because create and join sit on screen together: two
    /// `.defaultAction` buttons is an undefined Return, resolved by SwiftUI
    /// without telling anyone which half it picked.
    ///
    /// Join takes it. Its whole precondition is one field, and `canJoin` decides
    /// it exactly — six digits are in or they are not — so the default is inert
    /// until Return can only mean one thing, and it is the keystroke that
    /// naturally ends typing a code. Create's precondition is an account *and* a
    /// staged selection, and it sits immediately above this field; as the default
    /// it would fire the wrong half on the keystroke that finishes the other one.
    /// Prominence still belongs to each card's own primary — the keyboard default
    /// is the narrower claim, and it goes to the half that can honour it.
    private var joinCard: some View {
        SectionCard(title: L10n.t(.directReceiveHeading)) {
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
        // Claimed before connecting, so the session this starts is presented
        // here rather than in Nearby, which drives the same model.
        guard presence.claim(.pairingCode, mode: .files) else { return }
        Task { await model.join(code: model.joinCode) }
    }

    private func mintAndWait(token: String) async {
        // Validate and stage before the picker disappears. Besides avoiding a
        // useless minted code for an unreadable selection, this gives minting
        // and handoff one model-owned manifest to keep visible throughout.
        guard let expanded = selection.selection else {
            stagingError = selection.error ?? L10n.t(.directChooseFilesFirst)
            return
        }
        let staged: (sources: [PlaintextSource], metas: [FileMeta])
        do {
            staged = try stageRealtimeFiles(expanded.files)
        } catch {
            stagingError = ErrorCopy.message(for: error)
            return
        }
        stagingError = nil
        guard presence.claim(.pairingCode, mode: .files) else { return }
        model.stageSend(sources: staged.sources, metas: staged.metas)
        await model.mintCode(token: token)
        guard case let .showingCode(code, _) = model.state else { return }
        Task { await model.join(code: code, role: .initiator) }
    }
}
