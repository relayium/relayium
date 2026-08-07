import SwiftUI
import RelayiumAppKit
import RelayiumKit

/// Same-network transfer: list the other devices in the code-less rendezvous
/// room and send to the ONE the user picks.
///
/// Deliberately not called "Bonjour" or "local network discovery" anywhere the
/// user can see: this joins the same signalling service the pairing-code flow
/// uses, without a code, and the server groups that room by the public IP it
/// observes. Nothing scans the LAN, and two devices behind the same carrier NAT
/// can therefore see each other without sharing a network in any sense the user
/// would recognise. That is exactly why this pane never picks a device: the
/// roster is "who else is on this address", not "who else is in this room".
struct NearbyPane: View {
    @ObservedObject var discovery: LanDiscoveryModel
    @ObservedObject var receive: NearbyReceiveModel
    @ObservedObject var fileModel: RealtimeSessionModel
    @ObservedObject var textModel: RealtimeTextSessionModel
    /// Files or text. The same choice the pairing-code destination asks, so it
    /// is held once, in `TransferPresence`, rather than answered twice.
    let mode: TransferMode

    /// Which destination is presenting the live session. Nearby and Pairing
    /// code drive the SAME two models, so exactly one of them may render one —
    /// this is what `DirectHubPane`'s local `nearbySession` flag used to say,
    /// moved to app scope so it survives the window's view tree.
    @EnvironmentObject private var presence: TransferPresence

    /// Files the OS opened with this app, waiting for whichever send surface
    /// they were addressed to. Read-only here: this pane takes its own batch and
    /// decides nothing about anybody else's.
    @EnvironmentObject private var fileOpenRouting: AppFileOpenCoordinator

    @StateObject private var selection = SelectionStore()
    @State private var stagingError: String?

    private var busy: Bool { presence.owner != nil || fileModel.isBusy || textModel.isBusy }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if presence.rendersSession(.nearby) {
                session
            } else {
                discoverySection
            }
        }
        // Files opened from Finder or dropped on the Dock icon. `task(id:)`
        // keyed on BOTH the batch and `busy`, because either can be the change
        // that makes adoption possible: a batch that arrived mid-transfer is
        // never republished, so keying on the batch alone would strand it.
        // Whether this pane may take it is `AppFileOpenCoordinator`'s answer,
        // not a rule re-derived here.
        .task(id: FileOpenAdoption(staged: fileOpenRouting.staged, busy: busy)) {
            adoptOpenedFiles()
        }
        // A session that ends by any route — Cancel, Done, a failure the user
        // dismissed — returns this pane to the roster rather than stranding it
        // on an empty session view.
        .onChange(of: fileModel.state) { state in
            if mode == .files, state == .idle { presence.release(.nearby) }
        }
        .onChange(of: textModel.state) { state in
            if mode == .text, state == .idle { presence.release(.nearby) }
        }
    }

    // MARK: - discovery

    private var discoverySection: some View {
        VStack(alignment: .leading, spacing: 10) {
            // No heading of its own: the `SectionCard` this sits in carries it,
            // and a card whose first line repeats its own title is the drift the
            // component vocabulary exists to stop.
            Text(L10n.t(.nearbyExplain))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 720, alignment: .leading)

            receiving

            // Staging is deliberately ABOVE and independent of the roster: a
            // drop must never be the thing that picks a device. Choosing what to
            // send and choosing who to send it to are two separate acts, and
            // only pressing Send combines them.
            if mode == .files { filesToSend }

            if case let .reconnecting(message) = discovery.state {
                InlineMessage(.warning, message)
                    .frame(maxWidth: 720, alignment: .leading)
            }

            if discovery.isScanning {
                roster
            } else if !discovery.isPaused {
                HStack {
                    Button(L10n.t(.nearbyLookAgain)) { discovery.start() }
                        .disabled(busy)
                    // `off` is waiting for the user and must not animate as if
                    // work were running. A dropped resident socket really does
                    // retry in the background, so only that state gets a
                    // labelled progress indicator.
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

            if let stagingError {
                InlineMessage(.failure, stagingError)
                    .frame(maxWidth: 720, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// What will be sent, staged before — and independently of — the device it
    /// will be sent to.
    @ViewBuilder
    private var filesToSend: some View {
        VStack(alignment: .leading, spacing: 6) {
            FileDropZone(store: selection, isBusy: busy) {
                Text(selection.summary ?? L10n.t(.nearbyDropHint))
                    .font(.caption).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            PendingFileList(files: selection.files)
            if let message = selection.error {
                InlineMessage(.failure, message)
            }
            if !selection.isEmpty {
                Button(L10n.t(.commonClear)) { selection.clear() }
                    .buttonStyle(.bordered)
                    .disabled(busy)
            }
        }
        .frame(maxWidth: 720, alignment: .leading)
    }

    /// Receiving is on by default and runs whether or not this pane is on
    /// screen, so this section's job is to say so plainly — including the part
    /// that is uncomfortable. A background receive that the user has to discover
    /// by finding a file in Downloads is worse than one they were told about.
    @ViewBuilder
    private var receiving: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(NearbyStatusPresentation.text(for: receive.state))
                    .font(.subheadline.weight(.semibold))
                Spacer()
                if discovery.isPaused {
                    Button(L10n.t(.nearbyResumeReceiving)) { discovery.resume() }
                } else {
                    Button(L10n.t(.nearbyPauseReceiving)) { discovery.pause() }
                        .disabled(busy)
                }
            }
            // The default is no prompt, by the same decision that made advanced
            // verification opt-in. Stating the consequence is not a contradiction
            // of that decision; hiding it would be.
            Text(L10n.t(discovery.isPaused ? .nearbyPausedBody : .nearbyListeningBody))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            // Where the files land, split out of the paragraph above in R3-F.
            // iOS renders the same paragraph and writes into its own container
            // instead, so one shared sentence naming Downloads would have been
            // false on the platform that gained this surface — and a user told
            // to look in a folder that does not exist is worse off than one who
            // was told nothing.
            if !discovery.isPaused {
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
            // A designed empty state rather than a grey caption: "no devices
            // yet" is the state a first-time user is most likely to be in, and
            // the copy is the one thing that tells them what to do about it.
            EmptyStateView(symbol: "dot.radiowaves.left.and.right",
                           title: L10n.t(.nearbyEmptyRoster))
        } else {
            VStack(alignment: .leading, spacing: 6) {
                // Keyed by peer id, never by position: the hub's roster order
                // is not stable, and a row that moves under the pointer between
                // two frames is how the wrong device gets picked.
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
            // user's: nothing in this pane preselects, not even when the room
            // happens to hold exactly one other device.
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
        .disabled(busy)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .accessibilityHint(L10n.t(.nearbyA11yChooseDevice))
    }

    @ViewBuilder
    private func actions(for device: NearbyDevice) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            // The peer's own name, already stripped of control and bidi
            // characters by `safeDisplayName`, and isolated rather than translated.
            Text(L10n.t(.nearbySendTo, [L10n.token(device.label)]))
                .font(.subheadline.weight(.semibold))
            switch mode {
            case .files:
                Text(selection.summary.map { L10n.t(.nearbySelectionSendHint, [$0]) }
                     ?? L10n.t(.nearbyAddFilesHint))
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                // Return sends. The precondition is on the button rather than
                // in the handler's head: with nothing staged, or with a session
                // already running, the default action is inert instead of firing
                // a send that `sendFiles()` would have to refuse.
                Button(L10n.t(.commonSend)) { sendFiles() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(selection.isEmpty || busy)
            case .text:
                Text(L10n.t(.nearbyTextIntent))
                    .font(.caption).foregroundStyle(.secondary)
                // The other half of the same `switch`, so the two defaults are
                // never on screen together: a mode is either files or text.
                Button(L10n.t(.nearbyStartMessageSession)) { startText() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy)
            }
            // Says what actually happens on the other end rather than implying a
            // human gate that is not there: file transfers stop at the browser's
            // own save prompt, message sessions open by themselves unless the
            // verification setting below is on.
            Text(L10n.t(.nearbyAcceptanceNote))
                .font(.caption2).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: 720, alignment: .leading)
    }

    // MARK: - the live session

    @ViewBuilder
    private var session: some View {
        VStack(alignment: .leading, spacing: 10) {
            sessionPeer
            switch mode {
            case .files:
                if case let .failed(message) = fileModel.state {
                    InlineMessage(.failure, message)
                }
                RealtimeFileSessionView(model: fileModel)
            case .text:
                RealtimeTextSessionView(model: textModel)
            }
            if !busy {
                Button(L10n.t(.nearbyBackToDevices)) { leaveSession() }
                    // This is not navigation: it tears down the connection,
                    // removes a partial receive, clears text history and drops
                    // the staged selection. Match iOS and publish that task
                    // boundary as a Button to both sighted and VoiceOver users.
                    .buttonStyle(.bordered)
                if mode == .text {
                    // Says so rather than surprising: leaving is the one action
                    // here that discards the local history the terminal view is
                    // still showing.
                    Text(L10n.t(.nearbyLeavingClearsHistory))
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder
    private var sessionPeer: some View {
        if let label = presence.sessionPeerLabel {
            VStack(alignment: .leading, spacing: 3) {
                Text(L10n.t(.nearbySessionWith, [L10n.token(label)]))
                    .font(.headline)
                Text(L10n.t(.nearbySessionPeerDisclaimer))
                    .font(.caption2).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - actions

    private func sendFiles() {
        // A second press while the first send is still setting up would stage a
        // second batch over the first and dial again. The button is disabled
        // while busy; this is the guard that does not depend on a redraw.
        guard !busy else { return }
        // Re-read rather than capturing the device at render time: the roster
        // is live, and a device that left between the list being drawn and this
        // button being pressed must not be dialled by a stale id.
        guard let device = discovery.selectedDevice else {
            stagingError = L10n.t(.nearbyDeviceGone)
            return
        }
        guard let expanded = selection.selection else {
            stagingError = selection.error ?? L10n.t(.nearbyAddFilesFirst)
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
        // Claimed before dialling, so the session this is about to start is
        // presented here. The claim can only be refused while another
        // destination owns a session. A concurrent inbound offer can win after
        // the last frame rendered, so refusal is enforced here, not by visibility.
        guard presence.claim(.nearby, mode: mode, peerLabel: device.label) else { return }
        fileModel.stageSend(sources: staged.sources, metas: staged.metas)
        Task { await fileModel.connectNearby(peerId: device.id, role: .initiator) }
    }

    private func startText() {
        guard let device = discovery.selectedDevice else {
            stagingError = L10n.t(.nearbyDeviceGone)
            return
        }
        stagingError = nil
        guard presence.claim(.nearby, mode: mode, peerLabel: device.label) else { return }
        Task { await textModel.connectNearby(peerId: device.id, role: .initiator) }
    }

    /// Stage a batch the OS opened, if this pane is the one it was addressed to
    /// and is free to take it.
    ///
    /// `add`, not `replace`: an opened file joins what the user already picked
    /// rather than discarding it, which is the same call the drop zone makes.
    private func adoptOpenedFiles() {
        guard let batch = fileOpenRouting.batch(for: .nearby, busy: busy) else { return }
        selection.add(batch.urls)
        fileOpenRouting.consume(batch)
    }

    private func leaveSession() {
        switch mode {
        case .files: fileModel.cancel()
        case .text: textModel.reset()
        }
        selection.clear()
        presence.release(.nearby)
    }
}
