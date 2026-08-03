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
    enum Intent { case files, text }

    @ObservedObject var discovery: LanDiscoveryModel
    @ObservedObject var receive: NearbyReceiveModel
    @ObservedObject var fileModel: RealtimeSessionModel
    @ObservedObject var textModel: RealtimeTextSessionModel
    let intent: Intent
    /// Owned by `DirectHubPane`, which hides the pairing-code section while a
    /// nearby session is on screen — the two would otherwise render the same
    /// model twice.
    @Binding var sessionActive: Bool

    @StateObject private var selection = SelectionStore()
    @State private var stagingError: String?

    private var busy: Bool { fileModel.isBusy || textModel.isBusy }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if sessionActive {
                session
            } else {
                discoverySection
            }
        }
        // A session that ends by any route — Cancel, Done, a failure the user
        // dismissed — returns this pane to the roster rather than stranding it
        // on an empty session view.
        .onChange(of: fileModel.state) { state in
            if intent == .files, state == .idle { sessionActive = false }
        }
        .onChange(of: textModel.state) { state in
            if intent == .text, state == .idle { sessionActive = false }
        }
    }

    // MARK: - discovery

    private var discoverySection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(L10n.t(.nearbyHeading)).font(.headline)
            Text(L10n.t(.nearbyExplain))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            receiving

            // Staging is deliberately ABOVE and independent of the roster: a
            // drop must never be the thing that picks a device. Choosing what to
            // send and choosing who to send it to are two separate acts, and
            // only pressing Send combines them.
            if intent == .files { filesToSend }

            if case let .reconnecting(message) = discovery.state {
                Text(message).font(.callout).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if discovery.isScanning {
                roster
            } else if !discovery.isPaused {
                HStack {
                    Button(L10n.t(.nearbyLookAgain)) { discovery.start() }
                        .disabled(busy)
                    ProgressView().controlSize(.small)
                }
            }

            if let device = discovery.selectedDevice {
                Divider()
                actions(for: device)
            }

            if let stagingError {
                Text(stagingError).font(.callout).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
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
            if let message = selection.error {
                Text(message).font(.callout).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !selection.isEmpty {
                Button(L10n.t(.commonClear)) { selection.clear() }
                    .buttonStyle(.link)
                    .disabled(busy)
            }
        }
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
            if let failure = receive.lastFailure {
                Text(failure).font(.caption).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L10n.t(.nearbyA11yReceiving))
    }

    @ViewBuilder
    private var roster: some View {
        if discovery.devices.isEmpty {
            Text(L10n.t(.nearbyEmptyRoster))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
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
            switch intent {
            case .files:
                Text(selection.summary.map { L10n.t(.nearbySelectionSendHint, [$0]) }
                     ?? L10n.t(.nearbyAddFilesHint))
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button(L10n.t(.commonSend)) { sendFiles() }
                    .buttonStyle(.borderedProminent)
                    .disabled(selection.isEmpty || busy)
            case .text:
                Text(L10n.t(.nearbyTextIntent))
                    .font(.caption).foregroundStyle(.secondary)
                Button(L10n.t(.nearbyStartMessageSession)) { startText() }
                    .buttonStyle(.borderedProminent)
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
    }

    // MARK: - the live session

    @ViewBuilder
    private var session: some View {
        VStack(alignment: .leading, spacing: 10) {
            switch intent {
            case .files:
                RealtimeFileSessionView(model: fileModel)
                if case let .failed(message) = fileModel.state {
                    Text(message).font(.callout).foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
            case .text:
                RealtimeTextSessionView(model: textModel)
            }
            if !busy {
                Button(L10n.t(.nearbyBackToDevices)) { leaveSession() }
                    .buttonStyle(.link)
                if intent == .text {
                    // Says so rather than surprising: leaving is the one action
                    // here that discards the local history the terminal view is
                    // still showing.
                    Text(L10n.t(.nearbyLeavingClearsHistory))
                        .font(.caption2).foregroundStyle(.secondary)
                }
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
        fileModel.stageSend(sources: staged.sources, metas: staged.metas)
        sessionActive = true
        Task { await fileModel.connectNearby(peerId: device.id, role: .initiator) }
    }

    private func startText() {
        guard let device = discovery.selectedDevice else {
            stagingError = L10n.t(.nearbyDeviceGone)
            return
        }
        stagingError = nil
        sessionActive = true
        Task { await textModel.connectNearby(peerId: device.id, role: .initiator) }
    }

    private func leaveSession() {
        switch intent {
        case .files: fileModel.cancel()
        case .text: textModel.reset()
        }
        selection.clear()
        sessionActive = false
    }
}
