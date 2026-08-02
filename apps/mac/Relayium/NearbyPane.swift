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
            Text("Nearby devices").font(.headline)
            Text("Devices running Relayium — the app or relayium.com — that reach the internet from the same public address as this Mac. Usually that means your Wi-Fi, but a carrier or VPN gateway can put strangers' devices on the list too. Relayium never scans your network; it asks its rendezvous service who else arrives from that address.")
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
                    Button("Look again") { discovery.start() }
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
                Text(selection.summary
                     ?? "Drop files or folders here, or click to choose. Nothing is sent until you pick a device below and press Send.")
                    .font(.caption).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let message = selection.error {
                Text(message).font(.callout).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !selection.isEmpty {
                Button("Clear") { selection.clear() }
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
                Text(receiveStatus).font(.subheadline.weight(.semibold))
                Spacer()
                if discovery.isPaused {
                    Button("Resume receiving") { discovery.resume() }
                } else {
                    Button("Pause receiving") { discovery.pause() }
                        .disabled(busy)
                }
            }
            // The default is no prompt, by the same decision that made advanced
            // verification opt-in. Stating the consequence is not a contradiction
            // of that decision; hiding it would be.
            Text(discovery.isPaused
                 ? "This Mac is not listening for nearby devices. It can still send, and pairing codes still work."
                 : "While Relayium is running, a device on this address can send files or start a message session without asking first. Files are written to your Downloads folder. Anything sharing this public address can try — pause receiving if that is not what you want.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let failure = receive.lastFailure {
                Text(failure).font(.caption).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Nearby receiving")
    }

    private var receiveStatus: String {
        switch receive.state {
        case .off: return "Nearby receiving: off"
        case .paused: return "Nearby receiving: paused"
        case .connecting: return "Nearby receiving: joining…"
        case .ready: return "Nearby receiving: ready"
        case .reconnecting: return "Nearby receiving: reconnecting…"
        case .active(.file): return "Receiving files from a nearby device…"
        case .active(.text): return "A nearby message session is open"
        }
    }

    @ViewBuilder
    private var roster: some View {
        if discovery.devices.isEmpty {
            Text("No other devices yet. Open relayium.com on the other device and leave the page open.")
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
                Text("Names come from the other device and are not proof of who it is. Compare verification codes below if that matters.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Nearby devices")
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
        .accessibilityHint("Choose this device to send to.")
    }

    @ViewBuilder
    private func actions(for device: NearbyDevice) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Send to \(device.label)").font(.subheadline.weight(.semibold))
            switch intent {
            case .files:
                Text(selection.summary.map { "\($0). Send it straight to that device." }
                     ?? "Add files or folders above, then send them straight to that device.")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Send") { sendFiles() }
                    .buttonStyle(.borderedProminent)
                    .disabled(selection.isEmpty || busy)
            case .text:
                Text("Opens an end-to-end encrypted message session. Nothing is stored on Relayium.")
                    .font(.caption).foregroundStyle(.secondary)
                Button("Start a message session") { startText() }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy)
            }
            // Says what actually happens on the other end rather than implying a
            // human gate that is not there: file transfers stop at the browser's
            // own save prompt, message sessions open by themselves unless the
            // verification setting below is on.
            Text("On relayium.com the other person still chooses where to save incoming files; a message session opens on their side without a prompt unless advanced verification is on for either device (below). This Mac accepts incoming nearby transfers the same way while receiving is on.")
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
                Button("Back to nearby devices") { leaveSession() }
                    .buttonStyle(.link)
                if intent == .text {
                    // Says so rather than surprising: leaving is the one action
                    // here that discards the local history the terminal view is
                    // still showing.
                    Text("Leaving clears this session's local message history.")
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
            stagingError = "That device is no longer nearby. Pick another one."
            return
        }
        guard let expanded = selection.selection else {
            stagingError = selection.error ?? "Add files or folders to send first."
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
            stagingError = "That device is no longer nearby. Pick another one."
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
