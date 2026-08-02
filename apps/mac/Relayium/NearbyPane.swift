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
    @ObservedObject var fileModel: RealtimeSessionModel
    @ObservedObject var textModel: RealtimeTextSessionModel
    let intent: Intent
    /// Owned by `DirectHubPane`, which hides the pairing-code section while a
    /// nearby session is on screen — the two would otherwise render the same
    /// model twice.
    @Binding var sessionActive: Bool

    @State private var picked: [URL] = []
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

            HStack {
                if discovery.isScanning {
                    Button("Stop looking") { discovery.stop() }
                    ProgressView().controlSize(.small)
                } else {
                    Button("Find nearby devices") { discovery.start() }
                        .disabled(busy)
                }
            }

            if case let .failed(message) = discovery.state {
                Text(message).font(.callout).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if discovery.isScanning {
                roster
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
                Text(picked.isEmpty ? "Choose files, then send them straight to that device."
                                    : "\(picked.count) file\(picked.count == 1 ? "" : "s") ready.")
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("Choose Files…") { chooseFiles() }
                    Button("Send") { sendFiles() }
                        .buttonStyle(.borderedProminent)
                        .disabled(picked.isEmpty || busy)
                }
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
            Text("On relayium.com the other person still chooses where to save incoming files; a message session opens on their side without a prompt unless advanced verification is on for either device (below). This Mac can send to a nearby device but cannot yet receive from one — use a pairing code below for that.")
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

    private func chooseFiles() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false      // folder recursion is out of scope
        if panel.runModal() == .OK {
            picked = panel.urls
            stagingError = nil
        }
    }

    private func sendFiles() {
        // Re-read rather than capturing the device at render time: the roster
        // is live, and a device that left between the list being drawn and this
        // button being pressed must not be dialled by a stale id.
        guard let device = discovery.selectedDevice else {
            stagingError = "That device is no longer nearby. Pick another one."
            return
        }
        let staged: (sources: [PlaintextSource], metas: [FileMeta])
        do {
            staged = try stageRealtimeFiles(picked)
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
        picked = []
        sessionActive = false
    }
}
