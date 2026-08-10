import SwiftUI
import RelayiumAppKit
import RelayiumKit

/// **LAN Transfer, before there is a peer**: who is on this network, and what to
/// have ready for them.
///
/// One connection method and nothing else. The pairing-code controls that used
/// to sit in a second card on the same screen are a destination of their own
/// again — the two have opposite preconditions (this one needs the same network
/// and no account; that one needs an account to mint, while a shared network is
/// not required), and a screen showing both had to explain both before the user could
/// pick either.
///
/// ## The segmented Files/Text picker is still gone
///
/// This screen never asks "files or text?" as a mode. Each action states its own
/// kind, and **a message is the default one**: `Send a message` needs nothing
/// staged and is the prominent action on a chosen device, with the file action
/// beside it. That the kind still has to be decided at the moment of connecting
/// is not a presentation choice on the legacy wire — a file transfer and an
/// ephemeral text session are separate signalling generations, and a peer handed
/// the wrong one waits for a manifest that never arrives — so the choice is
/// attached to the verb the user presses, which is the last honest place for it.
///
/// **For a peer that announced exact `link/1` the kind is not a choice at all.**
/// Both verbs open the SAME connection: `Send a message` with nothing staged,
/// `Send files` with the staged batch armed, and everything afterwards happens
/// inside `TransferLinkPane` without another verification. The two buttons stay
/// because they are two intents, not two transports.
struct LanConnectPane: View {
    @ObservedObject var discovery: LanDiscoveryModel
    @ObservedObject var receive: NearbyReceiveModel
    @ObservedObject var fileModel: RealtimeSessionModel
    @ObservedObject var textModel: RealtimeTextSessionModel
    /// The unified `link/1`. Consulted per DEVICE rather than per action: a peer
    /// that announced it takes one connection for both verbs, and one that did
    /// not keeps the two legacy paths untouched.
    @ObservedObject var link: LinkWorkspaceModel
    /// The app-scoped staged batch, shared with the Cross-network destination so
    /// a change of mind about how to connect does not discard what to send.
    @ObservedObject var selection: SelectionStore
    /// `TransferSurfacePresentation.acceptsNewSession` inverted, computed by the
    /// destination. It is true while ANY route owns or retains a session —
    /// including the Cross-network one — which is what stops a second session
    /// being started from the screen the first one is not on.
    let sessionLocked: Bool

    @EnvironmentObject private var presence: TransferPresence
    @EnvironmentObject private var fileOpenRouting: AppFileOpenCoordinator

    @State private var actionError: String?

    /// This destination's own route. Named once, so the ownership claim, the
    /// release and the opened-file batch all address the same one.
    private let route = AppDestination.nearby

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            // Why every control below is inert. One session is arbitrated
            // between the two transfer destinations, so the screen that does not
            // own it disables everything — and a greyed control with no stated
            // reason is the dead end this app's design rules forbid. The sidebar
            // marks the row the session is actually on.
            if sessionLocked {
                InlineMessage(.info, L10n.t(.transferBusyElsewhere))
                    .frame(maxWidth: 720, alignment: .leading)
                    .accessibilityIdentifier("transfer-busy-elsewhere")
            }
            sameNetwork
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
        .task(id: FileOpenAdoption(staged: fileOpenRouting.staged, busy: sessionLocked)) {
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
                            .disabled(sessionLocked)
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

                // Inside this card, and last: the sentences above point at it
                // ("Choose files or folders below…"), and staging is what this
                // connection carries rather than a third way to send anything.
                Divider()
                TransferStagingSection(selection: selection, isBusy: { sessionLocked })
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
                        .disabled(sessionLocked)
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
        .disabled(sessionLocked)
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
                .disabled(sessionLocked)
                .accessibilityIdentifier("lan-send-message")
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
                // the pairing-code create controls get a gate instead.
                .disabled(selection.isEmpty || sessionLocked)
                .accessibilityIdentifier("lan-send-files")
            // Says what actually happens on the other end rather than implying a
            // human gate that is not there.
            Text(L10n.t(.nearbyAcceptanceNote))
                .font(.caption2).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            // What THIS device's connection will carry, attached to that device
            // rather than to the screen. The two verbs above open one connection
            // for a peer that announced exact `link/1` and two separate ones for
            // a peer that did not, and only the peer decides which — so a note
            // above the roster could only ever be right about one of them.
            InlineMessage(.info, L10n.t(device.supportsLink
                                        ? .linkOneConnectionNote
                                        : .workspaceOneConnectionNote))
                .accessibilityIdentifier("lan-device-connection-note")
        }
        .frame(maxWidth: 720, alignment: .leading)
    }

    // MARK: - actions

    private func startMessage(with device: NearbyDevice) {
        guard !sessionLocked else { return }
        // Re-read rather than capturing the device at render time: the roster is
        // live, and a device that left between the list being drawn and this
        // button being pressed must not be dialled by a stale id.
        guard let live = discovery.selectedDevice, live.id == device.id else {
            actionError = L10n.t(.nearbyDeviceGone)
            return
        }
        actionError = nil
        // Asked at ACTIVATION rather than at render: an announcement can arrive,
        // or a room can end, between the frame that drew this button and the
        // press. `canLink` is the exact-capability predicate and the only thing
        // that decides which of the two products this peer gets.
        guard !link.canLink(peerId: live.id) else {
            guard presence.beginSession(route, peerLabel: live.label) else { return }
            if !link.connect(peerId: live.id, peerLabel: live.label) {
                presence.release(route)
            }
            return
        }
        guard presence.beginSession(route, mode: .text, peerLabel: live.label) else { return }
        Task { await textModel.connectNearby(peerId: live.id, role: .initiator) }
    }

    private func sendFiles(to device: NearbyDevice) {
        // A second press while the first send is still setting up would stage a
        // second batch over the first and dial again. The button is disabled
        // while locked; this is the guard that does not depend on a redraw.
        guard !sessionLocked else { return }
        guard let live = discovery.selectedDevice, live.id == device.id else {
            actionError = L10n.t(.nearbyDeviceGone)
            return
        }
        guard let staged = stage() else { return }
        // Claimed before dialling, so the session this starts is presented here.
        // A concurrent inbound offer can win after the last frame rendered, so
        // refusal is enforced here, not by visibility.
        guard !link.canLink(peerId: live.id) else {
            guard presence.beginSession(route, peerLabel: live.label) else { return }
            // ARMED, not sent: the batch crosses the verification boundary with
            // everything else, and `LinkWorkspaceModel` is what releases it.
            if !link.connect(peerId: live.id, peerLabel: live.label,
                             files: staged.metas, sources: staged.sources) {
                presence.release(route)
            }
            return
        }
        guard presence.beginSession(route, mode: .files, peerLabel: live.label) else { return }
        fileModel.stageSend(sources: staged.sources, metas: staged.metas)
        Task { await fileModel.connectNearby(peerId: live.id, role: .initiator) }
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

    /// Stage a batch the OS opened, if this surface is free to take it.
    ///
    /// `add`, not `replace`: an opened file joins what the user already picked
    /// rather than discarding it, which is the same call the drop zone makes.
    /// Both transfer routes share the same staged selection. This also adopts a
    /// batch originally addressed to the other transfer screen if the user
    /// switched connection method before this free pane could take it.
    private func adoptOpenedFiles() {
        guard let batch = fileOpenRouting.batch(
            forAnyOf: AppDestination.macTransferRoutes, busy: sessionLocked)
        else { return }
        selection.add(batch.urls)
        fileOpenRouting.consume(batch)
    }
}
