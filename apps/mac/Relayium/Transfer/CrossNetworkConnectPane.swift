import SwiftUI
import RelayiumAppKit
import RelayiumKit

/// **Cross-network Transfer, before there is a peer**: mint a six-digit code or
/// type in somebody else's, and have the batch ready either way.
///
/// One connection method, and the one it is: a pairing code needs no shared
/// network, which is the whole reason this is not a card under LAN Transfer. The
/// screen says so in its own words rather than leaving the sidebar row to carry
/// the distinction alone.
///
/// ## Account asymmetry, unchanged
///
/// **Minting** a code reserves relay capacity billed to whoever created it, so
/// the create controls are wrapped in a gate and nothing else is. Joining
/// somebody else's code is account-free and is rendered and enabled identically
/// signed out — `MacSurfaceGuardTests` checks that the gate wraps only the
/// create half.
///
/// ## Why the kind is still attached to the verb
///
/// A pairing code does not say what the peer who minted it chose, and this side
/// cannot probe: a speculative text offer is read by an older peer as a file
/// offer. So each verb states its own kind — for creating, because the legacy
/// wire puts files and messages on separate signalling generations; for joining,
/// because the joiner is stating what they were told to expect. A peer that
/// announces exact `link/1` after joining is promoted to `TransferLinkPane`,
/// where the distinction stops existing.
struct CrossNetworkConnectPane: View {
    @ObservedObject var fileModel: RealtimeSessionModel
    @ObservedObject var textModel: RealtimeTextSessionModel
    /// The unified `link/1`. A pairing room is watched for a peer that speaks it
    /// before either legacy model starts; see `watch(code:…)`.
    @ObservedObject var link: LinkWorkspaceModel
    /// The app-scoped staged batch, shared with LAN Transfer.
    @ObservedObject var selection: SelectionStore
    let gate: AccountGate
    /// Re-reads the parent session at activation time; `gate` belongs to the
    /// render that drew the button and can already be stale.
    let accessNow: () -> AccountAccess?
    /// `TransferSurfacePresentation.acceptsNewSession` inverted — true while any
    /// route, including LAN Transfer, owns or retains a session.
    let sessionLocked: Bool

    @EnvironmentObject private var navigation: AppNavigationModel
    @EnvironmentObject private var presence: TransferPresence
    @EnvironmentObject private var fileOpenRouting: AppFileOpenCoordinator

    @State private var actionError: String?

    private let route = AppDestination.pairingCode

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            // The same statement the LAN screen makes, and for the same reason:
            // a disabled control has to say why it is disabled.
            if sessionLocked {
                InlineMessage(.info, L10n.t(.transferBusyElsewhere))
                    .frame(maxWidth: 720, alignment: .leading)
                    .accessibilityIdentifier("transfer-busy-elsewhere")
            }
            pairingCode
            if let actionError {
                InlineMessage(.failure, actionError)
                    .frame(maxWidth: 720, alignment: .leading)
            }
        }
        .task(id: FileOpenAdoption(staged: fileOpenRouting.staged, busy: sessionLocked)) {
            adoptOpenedFiles()
        }
    }

    // MARK: - pairing code

    private var pairingCode: some View {
        SectionCard(title: L10n.t(.workspacePairingHeading)) {
            VStack(alignment: .leading, spacing: 12) {
                // The one thing this destination exists to say, said on the
                // destination: the two devices do not have to share a network.
                Text(L10n.t(.crossNetworkExplain))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: 720, alignment: .leading)
                    .accessibilityIdentifier("cross-network-explain")
                if case .allowed = gate {
                    createControls
                } else {
                    // No greyed Create button. The gate names what is true and
                    // renders the one action that resolves it.
                    CapabilityGateView(gate: gate,
                                       title: L10n.t(.gateCreateCodeTitle),
                                       body: L10n.t(.gateCreateCodeBody),
                                       onAccount: { navigation.selectAccount(intent: $0) })
                }
                Divider()
                joinControls
                // Inside this card, and last, for the same reason it is on the
                // LAN screen: the create hint above points at it, and what a
                // connection carries is not a third way to connect.
                Divider()
                TransferStagingSection(selection: selection, isBusy: { sessionLocked })
                // The peer is not known yet, so neither the unified-link claim
                // nor the legacy one-lane warning is true here. Once a peer
                // appears, capability negotiation selects the link pane or the
                // legacy session pane; each states its actual connection shape.
            }
        }
    }

    private var createControls: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(L10n.t(.workspaceCreateMessageCode)) { createCode(mode: .text) }
                .buttonStyle(.borderedProminent)
                .disabled(sessionLocked)
                .accessibilityIdentifier("cross-network-create-message-code")
            Text(L10n.t(.textStartBody))
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button(L10n.t(.workspaceCreateFileCode)) { createCode(mode: .files) }
                .buttonStyle(.bordered)
                .disabled(selection.isEmpty || sessionLocked)
                .accessibilityIdentifier("cross-network-create-file-code")
            Text(L10n.t(.workspaceCreateFileCodeHint))
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// One field, two verbs, and both models kept in step by the one binding.
    private var joinControls: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                TextField(L10n.t(.commonCode), text: normalizedJoinCode)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 140)
                    .accessibilityLabel(L10n.t(.commonCode))
                    .accessibilityIdentifier("pairing.joinCode")
                // **The one keyboard default on this surface.** Create and join
                // sit on screen together, and two `.defaultAction` buttons is an
                // undefined Return that SwiftUI resolves without telling anyone
                // which it picked. Join takes it: its whole precondition is one
                // field, so the default is inert until Return can only mean one
                // thing, and it is the keystroke that naturally ends typing a
                // code. Message-first decides which of the two join verbs gets it.
                Button(L10n.t(.workspaceJoinMessages)) { join(mode: .text) }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!textModel.canJoin || sessionLocked)
                    .accessibilityIdentifier("cross-network-join-messages")
                Button(L10n.t(.workspaceJoinFiles)) { join(mode: .files) }
                    .buttonStyle(.bordered)
                    .disabled(!fileModel.canJoin || sessionLocked)
                    .accessibilityIdentifier("cross-network-join-files")
            }
            Text(L10n.t(.workspaceJoinKindHint))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("cross-network-join-kind-hint")
            InlineMessage(.info, L10n.t(.directJoinNoAccountNeeded))
        }
    }

    /// Normalize inside the one state transition, and write BOTH models.
    ///
    /// Following a raw write with `onChange` can overwrite a newer paste or fast
    /// keystroke; writing only one model would leave the two join verbs
    /// disagreeing about which code this device is about to join, which is
    /// exactly the drift the shared field exists to remove.
    private var normalizedJoinCode: Binding<String> {
        Binding(
            get: { fileModel.joinCode },
            set: {
                fileModel.updateJoinCode($0)
                textModel.updateJoinCode($0)
            }
        )
    }

    // MARK: - actions

    private func createCode(mode: TransferMode) {
        guard !sessionLocked else { return }
        // Validate and stage BEFORE the picker disappears. Besides avoiding a
        // useless minted code for an unreadable selection, this gives minting and
        // handoff one model-owned manifest to keep visible throughout.
        var staged: (sources: [PlaintextSource], metas: [FileMeta])?
        if mode == .files {
            guard let ready = stage() else { return }
            staged = ready
        }
        // Rendering an allowed gate and activating its button are different
        // turns. Refuse if sign-out, expiry or account replacement won between
        // them; never mint with the bearer captured by the earlier render.
        guard let access = accessNow() else {
            // Do not turn the user's accepted Create into a silent no-op: take
            // them to the one surface that explains the live account state.
            navigation.selectAccount(intent: .signIn)
            return
        }
        actionError = nil
        guard presence.beginSession(route, mode: mode) else { return }
        switch mode {
        case .files:
            guard let staged else { return }
            Task { await mintAndWatch(mode: .files, token: access.token, staged: staged) }
        case .text:
            Task { await mintAndWatch(mode: .text, token: access.token, staged: nil) }
        }
    }

    private func join(mode: TransferMode) {
        guard !sessionLocked else { return }
        // Snapshot before ownership: the field remains editable until the
        // asynchronous model start publishes state. Reading it inside the Task
        // could turn one valid click into a different or incomplete code.
        switch mode {
        case .files:
            let code = fileModel.joinCode
            guard fileModel.canJoin else { return }
            actionError = nil
            guard presence.beginSession(route, mode: .files) else { return }
            // A joiner ANSWERS on the legacy wire, so `.responder` is what the
            // fallback must use. Watched first, exactly as a minted code is.
            watch(code: code, legacyRole: .responder, mode: .files, staged: nil) {
                await fileModel.join(code: code)
            }
        case .text:
            let code = textModel.joinCode
            guard textModel.canJoin else { return }
            actionError = nil
            guard presence.beginSession(route, mode: .text) else { return }
            watch(code: code, legacyRole: .responder, mode: .text, staged: nil) {
                await textModel.join(code: code)
            }
        }
    }

    /// Expand and open the staged batch, reporting the reason it could not be.
    private func stage() -> (sources: [PlaintextSource], metas: [FileMeta])? {
        guard let expanded = selection.selection else {
            actionError = selection.error ?? L10n.t(.nearbyAddFilesFirst)
            return nil
        }
        do {
            let staged = try stageRealtimeFiles(expanded.files)
            actionError = nil
            return staged
        } catch {
            actionError = ErrorCopy.message(for: error)
            return nil
        }
    }

    /// Mint the code, then WATCH the room it names for a peer that speaks
    /// `link/1` — and let the legacy path take the room if none does.
    ///
    /// Minting stays where it was, on the model whose state the code, the QR and
    /// the expiry are rendered from: `LinkWorkspaceModel` never mints, and while
    /// it is only watching, `hasSession` is false so that surface stays on
    /// screen unchanged.
    ///
    /// The creator is the offerer on the legacy wire, so `.initiator` is what
    /// the fallback must use. A LINK computes its own role from the two room
    /// ids and ignores this one.
    private func mintAndWatch(mode: TransferMode,
                              token: String,
                              staged: (sources: [PlaintextSource], metas: [FileMeta])?) async {
        switch mode {
        case .files:
            await fileModel.mintCode(token: token)
            guard case let .showingCode(code, _) = fileModel.state else { return }
            watch(code: code, legacyRole: .initiator, mode: .files, staged: staged) {
                // The legacy fallback for a FILE code stages the batch itself —
                // `onLegacyFallbackBatch` hands it back — so nothing is staged
                // before the room has answered.
                await fileModel.join(code: code, role: .initiator)
            }
        case .text:
            await textModel.mintCode(token: token)
            guard case let .showingCode(code, _) = textModel.state else { return }
            watch(code: code, legacyRole: .initiator, mode: .text, staged: nil) {
                await textModel.join(code: code, role: .initiator)
            }
        }
    }

    /// Watch a code, or fall straight back when this build cannot.
    ///
    /// `legacyStart` is the path that shipped before the unified link, and it
    /// runs unchanged when the link model refuses the room — a client with no
    /// pairing socket factory, or one already holding a session. That is what
    /// keeps "pairing code works" true regardless of which half answers.
    private func watch(code: String,
                       legacyRole: Role,
                       mode: TransferMode,
                       staged: (sources: [PlaintextSource], metas: [FileMeta])?,
                       legacyStart: @escaping () async -> Void) {
        let watched = link.watchPairingCode(code,
                                            legacyRole: legacyRole,
                                            mode: mode,
                                            files: staged?.metas ?? [],
                                            sources: staged?.sources ?? [])
        guard !watched else { return }
        if let staged, mode == .files {
            fileModel.stageSend(sources: staged.sources, metas: staged.metas)
        }
        Task { await legacyStart() }
    }

    /// Stage a batch the OS opened, if this surface is free to take it. Both
    /// transfer routes share the same app-scoped selection, so switching from
    /// LAN before adoption must not strand the user's Dock drop.
    private func adoptOpenedFiles() {
        guard let batch = fileOpenRouting.batch(
            forAnyOf: AppDestination.macTransferRoutes, busy: sessionLocked)
        else { return }
        selection.add(batch.urls)
        fileOpenRouting.consume(batch)
    }
}
