import SwiftUI
import RelayiumAppKit
import RelayiumKit

/// Everything that happens **before** there is a peer: the two ways to reach
/// one, and the optional batch to have ready when you do.
///
/// ## The segmented Files/Text picker is gone, and what replaced it
///
/// The old surfaces asked "files or text?" *first*, as a mode above everything
/// else, and then disabled it the instant a session was claimed. It was the
/// wrong question in the wrong place twice over: it made a user who only wanted
/// to say something choose a transport mode first, and it made the answer look
/// like a property of the app rather than of the connection being opened.
///
/// Each action now states its own kind, and **a message is the default one**:
/// `Send a message` needs nothing staged and is the prominent action on a chosen
/// device, with the file and folder actions beside it. Nothing is preselected,
/// nothing is greyed out for a mode the user has not chosen, and staging files is
/// an intent you may express before or after picking how to connect.
///
/// That the *kind* still has to be decided at the moment of connecting is not a
/// presentation choice: the shipped wire puts a file transfer and an ephemeral
/// text session on separate signalling generations, and a peer that receives the
/// wrong one waits for a manifest that never arrives. So the choice is attached
/// to the verb the user presses, which is the last honest place for it.
///
/// ## Account asymmetry, unchanged
///
/// Same-network transfer in both directions needs no account; joining somebody
/// else's pairing code needs no account; **minting** one does, because the code's
/// owner pays for the traffic relayed through it. Only the create controls are
/// wrapped in a gate.
struct WorkspaceConnectPane: View {
    @ObservedObject var discovery: LanDiscoveryModel
    @ObservedObject var receive: NearbyReceiveModel
    @ObservedObject var fileModel: RealtimeSessionModel
    @ObservedObject var textModel: RealtimeTextSessionModel
    /// The surface's one staged batch — owned by `WorkspaceDestination`, so it
    /// survives this pane being replaced by the session it starts.
    @ObservedObject var selection: SelectionStore
    let gate: AccountGate
    /// Re-reads the parent session at activation time; `gate` belongs to the
    /// render that drew the button and can already be stale.
    let accessNow: () -> AccountAccess?

    @EnvironmentObject private var navigation: AppNavigationModel
    @EnvironmentObject private var presence: TransferPresence
    @EnvironmentObject private var fileOpenRouting: AppFileOpenCoordinator

    @State private var actionError: String?

    private var modelBusy: Bool { fileModel.isBusy || textModel.isBusy }
    /// Open With and Dock Drop also stop in the synchronous claim-before-start
    /// interval, without turning that ownership fact into permanent session busy.
    private var fileAdoptionBusy: Bool { presence.owner != nil || modelBusy }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            sameNetwork
            pairingCode
            staging
            InlineMessage(.info, L10n.t(.workspaceOneConnectionNote))
                .frame(maxWidth: 720, alignment: .leading)
                .accessibilityIdentifier("workspace-one-connection-note")
            InlineMessage(.info, L10n.t(.nearbyNoAccountNeeded))
                .frame(maxWidth: 720, alignment: .leading)
            if let actionError {
                InlineMessage(.failure, actionError)
                    .frame(maxWidth: 720, alignment: .leading)
            }
        }
        // Files opened from Finder or dropped on the Dock icon. `task(id:)` keyed
        // on BOTH the batch and `busy`, because either can be the change that
        // makes adoption possible: a batch that arrived mid-transfer is never
        // republished, so keying on the batch alone would strand it.
        .task(id: FileOpenAdoption(staged: fileOpenRouting.staged, busy: fileAdoptionBusy)) {
            adoptOpenedFiles()
        }
    }

    // MARK: - same network

    private var sameNetwork: some View {
        SectionCard(title: L10n.t(.workspaceSameNetworkHeading)) {
            VStack(alignment: .leading, spacing: 10) {
                Text(L10n.t(.nearbyExplain))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: 720, alignment: .leading)

                receiving

                if case let .reconnecting(message) = discovery.state {
                    InlineMessage(.warning, message)
                        .frame(maxWidth: 720, alignment: .leading)
                }

                if discovery.isScanning {
                    roster
                } else if !discovery.isPaused {
                    HStack {
                        Button(L10n.t(.nearbyLookAgain)) { discovery.start() }
                            .disabled(modelBusy)
                        // `off` is waiting for the user and must not animate as
                        // if work were running. A dropped resident socket really
                        // does retry in the background, so only that state gets
                        // a labelled progress indicator.
                        if case .reconnecting = discovery.state {
                            ProgressView { Text(L10n.t(.nearbyReconnecting)) }
                                .controlSize(.small)
                        }
                    }
                }

                if let device = discovery.selectedDevice {
                    Divider()
                    actions(for: device)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Receiving runs whether or not this pane is on screen, so this section's
    /// job is to say so plainly — including the part that is uncomfortable. A
    /// background receive the user has to discover by finding a file in
    /// Downloads is worse than one they were told about.
    @ViewBuilder
    private var receiving: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(NearbyStatusPresentation.text(for: receive.state))
                    .font(.subheadline.weight(.semibold))
                Spacer()
                switch receive.state {
                case .paused:
                    Button(L10n.t(.nearbyResumeReceiving)) { discovery.resume() }
                case .connecting, .ready, .reconnecting, .active:
                    Button(L10n.t(.nearbyPauseReceiving)) { discovery.pause() }
                        .disabled(modelBusy)
                case .off:
                    // The matching recovery is Look again below. Offering Pause
                    // while the status says off is a contradictory action.
                    EmptyView()
                }
            }
            Text(L10n.t(receive.state == .paused || receive.state == .off
                        ? .nearbyPausedBody : .nearbyListeningBody))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            // The same claim as the explanation above, so it follows the same
            // rendered state: an off listener was still promising a Downloads
            // delivery it could not make.
            if !(receive.state == .paused || receive.state == .off) {
                Text(L10n.t(.nearbySavedToDownloads))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let failure = receive.lastFailure {
                InlineMessage(.warning, failure)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L10n.t(.nearbyA11yReceiving))
        .frame(maxWidth: 720, alignment: .leading)
    }

    @ViewBuilder
    private var roster: some View {
        if discovery.devices.isEmpty {
            EmptyStateView(symbol: "dot.radiowaves.left.and.right",
                           title: L10n.t(.nearbyEmptyRoster))
        } else {
            VStack(alignment: .leading, spacing: 6) {
                // Keyed by peer id, never by position: the hub's roster order is
                // not stable, and a row that moves under the pointer between two
                // frames is how the wrong device gets picked.
                ForEach(discovery.devices) { device in
                    deviceRow(device)
                }
                Text(L10n.t(.nearbyNamesDisclaimer))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(L10n.t(.nearbyA11yDevices))
        }
    }

    private func deviceRow(_ device: NearbyDevice) -> some View {
        let selected = discovery.selectedId == device.id
        return Button {
            // Selection is explicit, one device at a time, and always the
            // user's: nothing here preselects, not even when the room happens to
            // hold exactly one other device.
            if selected { discovery.clearSelection() } else { discovery.select(device.id) }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                Text(device.label)
                Spacer()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(modelBusy)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .accessibilityHint(L10n.t(.nearbyA11yChooseDevice))
    }

    /// The message-first pair. Both verbs are on screen at once and neither is
    /// hidden behind a mode: what differs is only their preconditions, and the
    /// one with no precondition at all is the prominent one.
    @ViewBuilder
    private func actions(for device: NearbyDevice) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            // The peer's own name, already stripped of control and bidi
            // characters by `safeDisplayName`, and isolated rather than translated.
            Text(L10n.t(.nearbySendTo, [L10n.token(device.label)]))
                .font(.subheadline.weight(.semibold))
            Button(L10n.t(.workspaceSendMessage)) { startMessage(with: device) }
                .buttonStyle(.borderedProminent)
                .disabled(modelBusy)
                .accessibilityIdentifier("workspace-send-message")
            Text(L10n.t(.workspaceSendMessageHint))
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text(selection.summary.map { L10n.t(.nearbySelectionSendHint, [$0]) }
                 ?? L10n.t(.workspaceAddFilesHint))
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button(L10n.t(.workspaceSendFiles)) { sendFiles(to: device) }
                .buttonStyle(.bordered)
                // What is missing is named by the sentence directly above, and
                // adding it is one drop away — unlike an account, which is why
                // that one gets a gate instead.
                .disabled(selection.isEmpty || modelBusy)
                .accessibilityIdentifier("workspace-send-files")
            // Says what actually happens on the other end rather than implying a
            // human gate that is not there.
            Text(L10n.t(.nearbyAcceptanceNote))
                .font(.caption2).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: 720, alignment: .leading)
    }

    // MARK: - pairing code

    private var pairingCode: some View {
        SectionCard(title: L10n.t(.workspacePairingHeading)) {
            VStack(alignment: .leading, spacing: 12) {
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
            }
        }
    }

    private var createControls: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(L10n.t(.workspaceCreateMessageCode)) { createCode(mode: .text) }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("workspace-create-message-code")
            Text(L10n.t(.textStartBody))
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button(L10n.t(.workspaceCreateFileCode)) { createCode(mode: .files) }
                .buttonStyle(.bordered)
                .disabled(selection.isEmpty)
                .accessibilityIdentifier("workspace-create-file-code")
            Text(L10n.t(.workspaceCreateFileCodeHint))
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// One field, two verbs, and both models kept in step by the one binding.
    ///
    /// A pairing code does not say what the peer who minted it chose, and this
    /// side cannot probe: a speculative text offer is read by an older peer as a
    /// file offer. So the joiner states what they were told to expect, and the
    /// two buttons are that statement.
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
                    .disabled(!textModel.canJoin)
                    .accessibilityIdentifier("workspace-join-messages")
                Button(L10n.t(.workspaceJoinFiles)) { join(mode: .files) }
                    .buttonStyle(.bordered)
                    .disabled(!fileModel.canJoin)
                    .accessibilityIdentifier("workspace-join-files")
            }
            Text(L10n.t(.workspaceJoinKindHint))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("workspace-join-kind-hint")
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

    // MARK: - staging

    private var staging: some View {
        SectionCard(title: L10n.t(.workspaceStagingHeading)) {
            VStack(alignment: .leading, spacing: 6) {
                Text(L10n.t(.workspaceStagingOptional))
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("workspace-staging-optional")
                FileDropZone(store: selection, isBusy: { fileAdoptionBusy }) {
                    Text(selection.summary ?? L10n.t(.workspaceDropHint))
                        .font(.caption).foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                PendingFileList(files: selection.files)
                if let message = selection.error {
                    InlineMessage(.failure, message)
                }
                HStack {
                    Button(L10n.t(.commonChooseFilesOrFolders)) {
                        chooseFilesOrFolders(into: selection)
                    }
                    .accessibilityIdentifier("workspace-choose-files")
                    if !selection.isEmpty {
                        Button(L10n.t(.commonClear)) { selection.clear() }
                            .buttonStyle(.bordered)
                            .disabled(modelBusy)
                    }
                }
            }
            .frame(maxWidth: 720, alignment: .leading)
        }
    }

    // MARK: - actions

    private func startMessage(with device: NearbyDevice) {
        guard !modelBusy else { return }
        // Re-read rather than capturing the device at render time: the roster is
        // live, and a device that left between the list being drawn and this
        // button being pressed must not be dialled by a stale id.
        guard let live = discovery.selectedDevice, live.id == device.id else {
            actionError = L10n.t(.nearbyDeviceGone)
            return
        }
        actionError = nil
        guard presence.beginSession(.nearby, mode: .text, peerLabel: live.label) else { return }
        Task { await textModel.connectNearby(peerId: live.id, role: .initiator) }
    }

    private func sendFiles(to device: NearbyDevice) {
        // A second press while the first send is still setting up would stage a
        // second batch over the first and dial again. The button is disabled
        // while busy; this is the guard that does not depend on a redraw.
        guard !modelBusy else { return }
        guard let live = discovery.selectedDevice, live.id == device.id else {
            actionError = L10n.t(.nearbyDeviceGone)
            return
        }
        guard let staged = stage() else { return }
        // Claimed before dialling, so the session this starts is presented here.
        // A concurrent inbound offer can win after the last frame rendered, so
        // refusal is enforced here, not by visibility.
        guard presence.beginSession(.nearby, mode: .files, peerLabel: live.label) else { return }
        fileModel.stageSend(sources: staged.sources, metas: staged.metas)
        Task { await fileModel.connectNearby(peerId: live.id, role: .initiator) }
    }

    private func createCode(mode: TransferMode) {
        guard !modelBusy else { return }
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
        guard presence.beginSession(.pairingCode, mode: mode) else { return }
        switch mode {
        case .files:
            guard let staged else { return }
            fileModel.stageSend(sources: staged.sources, metas: staged.metas)
            Task { await mintAndJoinFiles(token: access.token) }
        case .text:
            Task { await mintAndJoinText(token: access.token) }
        }
    }

    private func join(mode: TransferMode) {
        // Snapshot before ownership: the field remains editable until the
        // asynchronous model start publishes state. Reading it inside the Task
        // could turn one valid click into a different or incomplete code.
        switch mode {
        case .files:
            let code = fileModel.joinCode
            guard fileModel.canJoin else { return }
            actionError = nil
            guard presence.beginSession(.pairingCode, mode: .files) else { return }
            Task { await fileModel.join(code: code) }
        case .text:
            let code = textModel.joinCode
            guard textModel.canJoin else { return }
            actionError = nil
            guard presence.beginSession(.pairingCode, mode: .text) else { return }
            Task { await textModel.join(code: code) }
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

    private func mintAndJoinFiles(token: String) async {
        await fileModel.mintCode(token: token)
        guard case let .showingCode(code, _) = fileModel.state else { return }
        Task { await fileModel.join(code: code, role: .initiator) }
    }

    private func mintAndJoinText(token: String) async {
        await textModel.mintCode(token: token)
        guard case let .showingCode(code, _) = textModel.state else { return }
        await textModel.join(code: code, role: .initiator)
    }

    /// Stage a batch the OS opened, if this surface is free to take it.
    ///
    /// `add`, not `replace`: an opened file joins what the user already picked
    /// rather than discarding it, which is the same call the drop zone makes.
    /// Both workspace routes are asked about, because a pairing-code deep link
    /// can have moved the selection to `.pairingCode` while the Dock drop that
    /// follows still belongs on this one screen.
    private func adoptOpenedFiles() {
        guard let batch = fileOpenRouting.batch(forAnyOf: AppDestination.macWorkspaceRoutes,
                                                busy: fileAdoptionBusy) else { return }
        selection.add(batch.urls)
        fileOpenRouting.consume(batch)
    }
}
