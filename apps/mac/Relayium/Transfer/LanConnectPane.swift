import SwiftUI
import RelayiumAppKit
import RelayiumKit

/// Same-network transfer before a connection exists: whether this Mac can be
/// reached, what it is called and where it is, and which nearby devices this
/// one can open a connection to.
///
/// **Connect first.** There is nothing to stage here — no picker, no composer,
/// no dragged batch — because what a device chooses is chosen inside the
/// connection it opened. The one verb on a chosen device is Connect.
struct LanConnectPane: View {
    @ObservedObject var module: TransferModule
    @ObservedObject var discovery: LanDiscoveryModel
    @ObservedObject var receive: NearbyReceiveModel
    /// `TransferModule.acceptsNewSession` inverted — **this module's answer and
    /// nobody else's**. A pairing-code session owned by the other destination
    /// does not lock this screen; only this module's own live or retained
    /// session does, which is the second-start refusal it exists to be.
    let sessionLocked: Bool

    private var link: LinkWorkspaceModel { module.link }
    private var presence: TransferPresence { module.presence }

    @State private var actionError: String?
    /// Read while listening and emptied otherwise, so a stopped screen cannot
    /// describe a network this Mac may have left. View state and nothing
    /// longer-lived: an address inventory is a fingerprint of somebody's home
    /// network, and it is never stored, logged or sent.
    @State private var localAddresses: [LocalNetworkAddress] = []

    private let route = AppDestination.nearby

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.section) {
            // Why every control below is inert. A greyed control with no
            // stated reason is the dead end this app's design rules forbid.
            if sessionLocked {
                InlineMessage(.info, L10n.t(.transferBusyElsewhere))
                    .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
                    .accessibilityIdentifier("transfer-busy-elsewhere")
            }
            receiving
            if case let .reconnecting(message) = discovery.state {
                InlineMessage(.warning, message)
                    .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
            }
            // A route, not progress: before a device is chosen the client can
            // truthfully name both endpoints and the encryption, and nothing
            // else — no stop is complete and no path is promised to be direct.
            PathRail(stops: PathRailPresentation.lan())
            thisMac
            sameNetwork
            InlineMessage(.info, L10n.t(.nearbyNoAccountNeeded))
                .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
            if let actionError {
                InlineMessage(.failure, actionError)
                    .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
            }
        }
        // **No Finder/Dock adoption here.** This screen stages nothing before a
        // connection exists, so a batch the OS opened has nowhere to land on it;
        // `AppRouting.destination(forOpenedFiles:)` sends those to Stored Send.
        //
        // Addresses are re-measured periodically while listening and immediately
        // on every socket edge: a DHCP renewal or an interface change does not
        // have to tear down the room socket, so reconnect alone can leave a
        // stale address on screen indefinitely.
        .task(id: LanIdentitySnapshot(listening: isListening,
                                      socket: discovery.announcedName)) {
            await refreshLocalAddressesWhileListening()
        }
    }

    /// Two facts, so a reconnect under a new name or a move to another network
    /// re-reads rather than leaving the previous socket's answer on screen.
    private struct LanIdentitySnapshot: Equatable {
        let listening: Bool
        let socket: String?
    }

    private func refreshLocalAddressesWhileListening() async {
        guard isListening, discovery.announcedName != nil else {
            localAddresses = []
            return
        }
        while !Task.isCancelled {
            let next = LocalAddressInventory.current()
            if next != localAddresses {
                localAddresses = next
            }
            do {
                try await Task.sleep(nanoseconds: 5_000_000_000)
            } catch {
                return
            }
        }
    }

    /// The roster, and the one way onto a device in it.
    ///
    /// The names disclaimer is the card's footnote rather than an ⓘ: it is what
    /// a name on this list does NOT prove, and a security caveat a reader has to
    /// press for is a caveat most readers never see. What the list IS — which
    /// devices arrive from this public address and why — is the explanation, and
    /// that folds.
    ///
    /// **Drawn only when it holds something**, which is `hasRosterContent`. The
    /// card's three arms are a roster while this Mac is scanning, a Start
    /// control while it is not scanning and not paused, and the chosen device's
    /// actions — and a user who presses Pause in the status head above satisfies
    /// none of them. `CardRows` with no rows is zero points tall, so the card
    /// still drew its own background, border and 11pt corners around nothing: a
    /// sliver of chrome between the caption and the names footnote, in a state
    /// the user had just asked for. There is nothing to explain in its place
    /// either — the head directly above says this Mac is not listening and
    /// carries the Resume that changes it, and a second copy of that sentence
    /// down here would be the duplicated status this pane has already had to
    /// remove once.
    @ViewBuilder
    private var sameNetwork: some View {
        if hasRosterContent {
            rosterCard
        }
    }

    /// Whether the card below has an arm to draw. The same three conditions its
    /// rows are written in, in the same order, so a fourth row cannot be added
    /// without this answering for it.
    private var hasRosterContent: Bool {
        discovery.isScanning || !discovery.isPaused || discovery.selectedDevice != nil
    }

    private var rosterCard: some View {
        SectionCard(title: L10n.t(.workspaceSameNetworkHeading),
                    footnote: L10n.t(.nearbyNamesDisclaimer),
                    explanation: L10n.t(.nearbyExplain),
                    rows: true) {
            CardRows {
                if discovery.isScanning {
                    roster
                } else if !discovery.isPaused {
                    CardBlockRow {
                        HStack(spacing: Metrics.tight) {
                            // **Start receiving, because that is what it does.**
                            // `discovery.start()` opens the room socket rather
                            // than rescanning a roster, and the status above
                            // reads *off* until it is pressed — so a label
                            // naming a search would say the app is looking while
                            // nothing is listening.
                            Button(L10n.t(.nearbyStartReceiving)) { discovery.start() }
                                .disabled(sessionLocked)
                            // `off` is waiting for the user and must not animate
                            // as if work were running. Only a dropped resident
                            // socket really does retry in the background.
                            if case .reconnecting = discovery.state {
                                ProgressView { Text(L10n.t(.nearbyReconnecting)) }
                                    .controlSize(.small)
                            }
                        }
                    }
                }
                if let device = discovery.selectedDevice {
                    CardBlockRow {
                        actions(for: device)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .contain)
            .accessibilityLabel(L10n.t(.nearbyA11yDevices))
        }
    }

    /// What this Mac is called and where it is: the first-viewport answer to
    /// "can the other side find me", above the card that holds the roster.
    private var thisMac: some View {
        SectionCard(title: L10n.t(.nearbyThisMacHeading),
                    footnote: L10n.t(.nearbyAddressesPrivacyNote),
                    rows: true) {
            CardRows {
                CardBlockRow(explanation: identityCaption,
                             subject: L10n.t(.nearbyThisMacHeading)) {
                    identity
                }
                CardBlockRow(explanation: L10n.t(.nearbyAddressesNotGroupingNote),
                             subject: L10n.t(.nearbyLocalAddressesHeading)) {
                    addresses
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .contain)
            .accessibilityLabel(L10n.t(.nearbyA11yThisMac))
        }
    }

    /// Whether this Mac can be reached right now, and the one control that
    /// changes it: the single status head this screen is allowed.
    ///
    /// The state sentence stays on the page rather than folding — a listening
    /// Mac accepts a stranger's transfer without asking first, and that is a
    /// consent a reader must not have to press for.
    private var receiving: some View {
        VStack(alignment: .leading, spacing: Metrics.tight) {
            StatusHero(symbol: "dot.radiowaves.left.and.right",
                       title: NearbyStatusPresentation.text(for: receive.state),
                       detail: L10n.t(receive.state == .paused || receive.state == .off
                                      ? .nearbyPausedBody : .nearbyListeningBody),
                       isActive: isListening) {
                switch receive.state {
                case .paused:
                    Button(L10n.t(.nearbyResumeReceiving)) { discovery.resume() }
                case .connecting, .ready, .reconnecting, .active:
                    Button(L10n.t(.nearbyPauseReceiving)) { discovery.pause() }
                        .disabled(sessionLocked)
                case .off:
                    EmptyView()
                }
            }
            if !(receive.state == .paused || receive.state == .off) {
                Text(L10n.t(.nearbySavedToDownloads))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, Metrics.caption)
            }
            if let failure = receive.lastFailure {
                InlineMessage(.warning, failure)
                    .padding(.horizontal, Metrics.caption)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L10n.t(.nearbyA11yReceiving))
        .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
    }

    /// The socket's answer while there is one, and the configured name
    /// otherwise — never the configured name presented as what peers see.
    @ViewBuilder
    private var identity: some View {
        if let announced = discovery.announcedName, isListening {
            Text(L10n.token(announced))
                .font(.title3.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .accessibilityIdentifier("lan-announced-name")
        } else {
            VStack(alignment: .leading, spacing: Metrics.hairline) {
                Text(L10n.token(AppEnvironment.deviceName()))
                    .font(.title3.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("lan-configured-name")
                Text(L10n.t(isStarting ? .nearbyIdentityAnnouncing : .nearbyIdentityNotListening))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("lan-identity-unavailable")
            }
        }
    }

    /// What the name is: set when Relayium joins the network while it is
    /// listening, and what the next join will use while it is not.
    private var identityCaption: String {
        discovery.announcedName != nil && isListening
            ? L10n.t(.nearbyAnnouncedNameCaption)
            : L10n.t(.nearbyConfiguredNameCaption)
    }

    @ViewBuilder
    private var addresses: some View {
        if localAddresses.isEmpty {
            Text(L10n.t(.nearbyNoLocalAddresses))
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("lan-local-addresses-empty")
        } else {
            VStack(alignment: .leading, spacing: Metrics.hairline) {
                Text(L10n.t(.nearbyLocalAddressesHeading))
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(localAddresses) { address in
                    Text(L10n.t(.nearbyLocalAddressRow,
                                [L10n.token(address.text), L10n.token(address.interfaceName)]))
                        .font(.callout.monospaced())
                        .textSelection(.enabled)
                        .accessibilityIdentifier("lan-local-address")
                }
            }
        }
    }

    private var isStarting: Bool {
        switch receive.state {
        case .connecting, .reconnecting: return true
        case .off, .paused, .ready, .active: return false
        }
    }

    private var isListening: Bool {
        switch receive.state {
        case .ready, .active: return true
        case .off, .paused, .connecting, .reconnecting: return false
        }
    }

    /// One row per device, plus the empty answer — which is a real answer here
    /// rather than a blank: the other side may simply not be running Relayium.
    ///
    /// `CardRowList` rather than a mapped array: a peer keeps its own view
    /// across arrivals, departures and reordering, so nothing attached to a row
    /// follows a position instead of a device.
    @ViewBuilder
    private var roster: some View {
        if discovery.devices.isEmpty {
            CardBlockRow {
                EmptyStateView(symbol: "dot.radiowaves.left.and.right",
                               title: L10n.t(.nearbyEmptyRosterTitle),
                               body: L10n.t(.nearbyEmptyRosterOpen),
                               link: EmptyStateLink(
                                title: L10n.token(AppEnvironment.transferHost),
                                url: AppEnvironment.transferBaseURL,
                                accessibilityHint: L10n.t(.nearbyEmptyRosterOpenHint),
                                identifier: "lan-empty-roster-site"))
            }
        } else {
            CardRowList(discovery.devices) { device in
                deviceRow(device)
            }
        }
    }

    private func deviceRow(_ device: NearbyDevice) -> some View {
        let chosen = discovery.selectedId == device.id
        return Button {
            if chosen { discovery.clearSelection() } else { discovery.select(device.id) }
        } label: {
            HStack(spacing: Metrics.tight) {
                Image(systemName: chosen ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(chosen ? Palette.actionLabel : Color.secondary)
                Text(device.label)
                Spacer()
            }
            .padding(.vertical, Metrics.rowVertical)
            .padding(.horizontal, Metrics.rowHorizontal)
            // A whole-row control, so it takes the platform hit floor rather
            // than the compact row height — which is also the taller row the
            // reference draws for a device.
            .frame(minHeight: Metrics.hitTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(sessionLocked)
        .accessibilityAddTraits(chosen ? [.isSelected] : [])
        .accessibilityHint(L10n.t(.nearbyA11yChooseDevice))
    }

    /// What a chosen device gets. A device that announced exact `link/1` is told
    /// what one connection carries and given the verb; one that did not gets a
    /// STATEMENT where its Connect button would be — not a disabled button,
    /// which says "not now" when the truth is "not this device". It stays on the
    /// roster, because a device visible on the network and missing from the app
    /// is a worse answer than one that explains itself.
    @ViewBuilder
    private func actions(for device: NearbyDevice) -> some View {
        VStack(alignment: .leading, spacing: Metrics.tight) {
            Text(L10n.t(.nearbySendTo, [L10n.token(device.label)]))
                .font(.callout.weight(.semibold))
            if device.supportsLink {
                Button(L10n.t(.workspaceConnectToDevice)) { connect(to: device) }
                    .buttonStyle(.borderedProminent)
                    .disabled(sessionLocked)
                    .accessibilityIdentifier("lan-connect-device")
                Text(L10n.t(.workspaceConnectToDeviceHint))
                    .font(.subheadline).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(L10n.t(.nearbyAcceptanceNote))
                    .font(.subheadline).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                InlineMessage(.info, L10n.t(.linkOneConnectionNote))
                    .accessibilityIdentifier("lan-device-connection-note")
            } else {
                InlineMessage(.warning, L10n.t(.errorRealtimeLegacyPeer))
                    .accessibilityIdentifier("lan-device-unsupported")
            }
        }
        .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
    }

    private func connect(to device: NearbyDevice) {
        guard !sessionLocked else { return }
        guard let live = discovery.selectedDevice, live.id == device.id else {
            actionError = L10n.t(.nearbyDeviceGone)
            return
        }
        actionError = nil
        guard link.canLink(peerId: live.id) else {
            actionError = L10n.t(.errorRealtimeLegacyPeer)
            return
        }
        guard presence.beginSession(route, peerLabel: live.label) else { return }
        if !link.connect(peerId: live.id, peerLabel: live.label) {
            presence.release(route)
        }
    }
}
