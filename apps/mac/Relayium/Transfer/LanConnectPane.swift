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
    /// Which address row just acknowledged a Copy. View state; the address
    /// itself is not kept here.
    @State private var copiedAddressID: LocalNetworkAddress.ID?

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
            // No route rail on this screen any more: the reference's status
            // head already says what the route is — this network, end-to-end
            // encrypted, no account — and says nothing about a direct path
            // this client cannot observe.
            thisMac
            sameNetwork
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
    /// The names caveat sits on the caption line, visible without pressing
    /// anything. What the list IS — which devices arrive from this public
    /// address and why — is the explanation, and that folds.
    ///
    /// **Drawn only when it holds something**, which is `hasRosterContent`. The
    /// card's three arms are a roster while this Mac is scanning, the reconnect
    /// status while a dropped socket retries, and the chosen device's actions —
    /// and a listener that is off or paused satisfies none of them; its one
    /// control is the switch in the status head above. `CardRows` with no rows is zero points tall, so the card
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
        discovery.isScanning || isRetrying || discovery.selectedDevice != nil
    }

    /// A dropped resident socket that is retrying on its own — real background
    /// work, and the one non-roster fact this card still carries.
    private var isRetrying: Bool {
        if case .reconnecting = discovery.state { return true }
        return false
    }

    private var rosterCard: some View {
        // The names caveat sits on the caption line, where the reference puts
        // it: visible without pressing anything, beside the list it is about.
        SectionCard(title: L10n.t(.workspaceSameNetworkHeading),
                    note: L10n.t(.nearbyNamesDisclaimerShort),
                    explanation: L10n.t(.nearbyExplain),
                    rows: true) {
            CardRows {
                if discovery.isScanning {
                    roster
                } else if isRetrying {
                    // **No Start button here.** The status head's switch is the
                    // one start, pause and resume control; a second Start in
                    // this card ran the same `discovery.start()` beside it. An
                    // `off` listener therefore draws no card at all, and only a
                    // dropped resident socket — which really is retrying in the
                    // background — says so here.
                    CardBlockRow {
                        ProgressView { Text(L10n.t(.nearbyReconnecting)) }
                            .controlSize(.small)
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
        .accessibilityHint(L10n.t(.nearbyNamesDisclaimer))
    }

    /// What this Mac is called and where it is: the first-viewport answer to
    /// "can the other side find me", above the card that holds the roster.
    private var thisMac: some View {
        SectionCard(title: L10n.t(.nearbyThisMacHeading),
                    footnote: thisMacFootnote,
                    rows: true) {
            CardRows {
                CardBlockRow(explanation: identityCaption,
                             subject: L10n.t(.nearbyThisMacHeading)) {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text(L10n.t(.nearbyVisibleNameLabel))
                            .font(.body)
                            .foregroundStyle(Palette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: Metrics.tight)
                        identity
                    }
                }
                // The full privacy statement lives behind this ⓘ; where files
                // land is said only under the card, and only while listening.
                CardBlockRow(explanation: [L10n.t(.nearbyAddressesPrivacyNote),
                                           L10n.t(.nearbyAddressesNotGroupingNote)]
                                .joined(separator: "\n\n"), // nonlocalized: paragraph break
                             subject: L10n.t(.nearbyLocalAddressesHeading)) {
                    addresses
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .contain)
            .accessibilityLabel(L10n.t(.nearbyA11yThisMac))
        }
    }

    /// What the addresses are not, and — while this Mac is listening — where an
    /// incoming file lands: the reference's single short line under the card.
    /// The full privacy statement is the address row's ⓘ.
    private var thisMacFootnote: String {
        if !(receive.state == .paused || receive.state == .off) {
            return L10n.detail([L10n.t(.nearbyAddressesPrivacyShort),
                                L10n.t(.nearbySavedToDownloadsShort)])
        }
        return L10n.t(.nearbyAddressesPrivacyShort)
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
                       detail: heroDetail,
                       isActive: isListening) {
                receivingSwitch
            }
            // The consent stays on the page rather than folding: a listening
            // Mac accepts a stranger's transfer without asking first, and a
            // reader must not have to press anything to learn that.
            if !(receive.state == .paused || receive.state == .off) {
                // Short and on the page; the full sentence is its tooltip and
                // its VoiceOver hint, and Help below explains it at length.
                Text(L10n.t(.nearbyListeningConsentShort))
                    .font(.subheadline)
                    .foregroundStyle(Palette.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, Metrics.caption)
                    .help(L10n.t(.nearbyListeningBody))
                    .accessibilityHint(L10n.t(.nearbyListeningBody))
                    .accessibilityIdentifier("lan-listening-consent")
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

    /// The reference's one supporting line while listening; what pausing
    /// leaves working while not.
    private var heroDetail: String {
        guard isListening else { return L10n.t(.nearbyPausedBody) }
        return L10n.detail([L10n.plural(.nearbyDevicesNearby, discovery.devices.count),
                            L10n.t(.nearbyEncryptedNoAccount)])
    }

    /// **The status head's switch is the residency control.** On means this
    /// Mac is listening or on its way into the room; flipping it runs exactly
    /// the call the old buttons ran for the state on screen — Start for a
    /// listener that is off, Resume for a paused one, Pause for a live one —
    /// and it names that action for VoiceOver and the pointer.
    private var receivingSwitch: some View {
        let on = receive.state != .paused && receive.state != .off
        let action: String
        switch receive.state {
        case .paused:
            action = L10n.t(.nearbyResumeReceiving)
        case .connecting, .ready, .reconnecting, .active:
            action = L10n.t(.nearbyPauseReceiving)
        case .off:
            action = L10n.t(.nearbyStartReceiving)
        }
        // No label content, for the reason `VerificationSetting` gives: the
        // hero's title says what this switch controls on screen, and the
        // explicit accessibility label below is its one spoken name.
        return Toggle(isOn: Binding(
            get: { on },
            set: { setReceiving($0) })) {
                EmptyView()
            }
            .toggleStyle(.switch)
            .labelsHidden()
            // Pausing would drop a session this module owns; resuming or
            // starting never can.
            .disabled(on && sessionLocked)
            .help(action)
            .accessibilityLabel(L10n.t(.nearbyA11yReceiving))
            .accessibilityHint(action)
            .accessibilityIdentifier("lan-receiving-switch")
    }

    private func setReceiving(_ on: Bool) {
        switch receive.state {
        case .paused:
            if on { discovery.resume() }
        case .connecting, .ready, .reconnecting, .active:
            // Re-checked here rather than trusted to `.disabled`: a click from
            // the previous render can land after a claim.
            if !on && !sessionLocked { discovery.pause() }
        case .off:
            if on { discovery.start() }
        }
    }

    /// The socket's answer while there is one, and the configured name
    /// otherwise — never the configured name presented as what peers see.
    @ViewBuilder
    private var identity: some View {
        if let announced = discovery.announcedName, isListening {
            Text(L10n.token(announced))
                .font(.body.weight(.medium))
                .foregroundStyle(Palette.text)
                .multilineTextAlignment(.trailing)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .accessibilityIdentifier("lan-announced-name")
        } else {
            VStack(alignment: .trailing, spacing: 1) {
                Text(L10n.token(AppEnvironment.deviceName()))
                    .font(.body.weight(.medium))
                    .foregroundStyle(Palette.text)
                    .multilineTextAlignment(.trailing)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("lan-configured-name")
                Text(L10n.t(isStarting ? .nearbyIdentityAnnouncing : .nearbyIdentityNotListening))
                    .font(.subheadline)
                    .foregroundStyle(Palette.textTertiary)
                    .multilineTextAlignment(.trailing)
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
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(L10n.t(.nearbyAddressLabel))
                    .font(.body)
                    .foregroundStyle(Palette.textSecondary)
                Spacer(minLength: Metrics.tight)
                Text(L10n.t(.nearbyNoLocalAddresses))
                    .font(.callout)
                    .foregroundStyle(Palette.textTertiary)
                    .multilineTextAlignment(.trailing)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("lan-local-addresses-empty")
            }
        } else {
            VStack(alignment: .leading, spacing: Metrics.hairline) {
                ForEach(Array(localAddresses.enumerated()), id: \.element.id) { index, address in
                    HStack(alignment: .center, spacing: 10) {
                        // One label for the group, on its first line only.
                        Text(L10n.t(.nearbyAddressLabel))
                            .font(.body)
                            .foregroundStyle(Palette.textSecondary)
                            .opacity(index == 0 ? 1 : 0)
                            .accessibilityHidden(index != 0)
                        Spacer(minLength: Metrics.tight)
                        Text(L10n.token(address.text))
                            .font(.callout.monospaced())
                            .foregroundStyle(Palette.text)
                            .textSelection(.enabled)
                            .accessibilityLabel(L10n.t(.nearbyLocalAddressRow,
                                                       [L10n.token(address.text),
                                                        L10n.token(address.interfaceName)]))
                            .accessibilityIdentifier("lan-local-address")
                        Text(L10n.token(address.interfaceName))
                            .font(.subheadline)
                            .foregroundStyle(Palette.textTertiary)
                            .accessibilityHidden(true)
                        Button(L10n.t(copiedAddressID == address.id ? .commonCopied : .commonCopy)) {
                            copyAddress(address)
                        }
                        .buttonStyle(.referenceSecondary)
                        .accessibilityLabel(L10n.detail([
                            L10n.t(copiedAddressID == address.id ? .commonCopied : .commonCopy),
                            L10n.token(address.text)]))
                        .accessibilityIdentifier("lan-local-address-copy")
                    }
                }
            }
        }
    }

    /// One explicit clipboard write of one address the user is looking at.
    ///
    /// Marked transient and concealed, so clipboard-history tools that honour
    /// those types do not keep a copy: the inventory itself is still never
    /// stored or logged by Relayium, and this is not a way for it to be.
    private func copyAddress(_ address: LocalNetworkAddress) {
        let board = NSPasteboard.general
        board.clearContents()
        board.setString(address.text, forType: .string)
        // nonlocalized: nspasteboard.org marker types
        board.setString("", forType: NSPasteboard.PasteboardType("org.nspasteboard.TransientType"))
        board.setString("", forType: NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"))
        copiedAddressID = address.id
        let copied = address.id
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_400_000_000)
            if copiedAddressID == copied { copiedAddressID = nil }
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
            HStack(spacing: 11) {
                ZStack {
                    RoundedRectangle(cornerRadius: 9)
                        .fill(Palette.actionSurface)
                    Image(systemName: "laptopcomputer.and.iphone")
                        .font(.callout)
                        .foregroundStyle(Palette.actionLabel)
                }
                .frame(width: Metrics.deviceChip, height: Metrics.deviceChip)
                .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(device.label)
                        .font(.body.weight(.medium))
                        .foregroundStyle(Palette.text)
                        .fixedSize(horizontal: false, vertical: true)
                    // Only what the roster knows: the device is announcing on
                    // this network now, and whether it can take a connection.
                    Text(L10n.t(device.supportsLink ? .nearbyDeviceOnline : .nearbyDeviceNeedsUpdate))
                        .font(.subheadline)
                        .foregroundStyle(Palette.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: Metrics.tight)
                Image(systemName: chosen ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(chosen ? Palette.actionLabel : Palette.textTertiary)
                    .accessibilityHidden(true)
            }
            .padding(.vertical, 11)
            .padding(.horizontal, Metrics.rowHorizontal)
            // A whole-row control, so it takes the platform hit floor rather
            // than the compact row height.
            .frame(minHeight: Metrics.hitTarget)
            .background(chosen ? Palette.rowHover : Color.clear)
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
            if device.supportsLink {
                HStack(alignment: .center, spacing: 10) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(L10n.t(.nearbySendTo, [L10n.token(device.label)]))
                            .font(.callout.weight(.semibold))
                            .foregroundStyle(Palette.text)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(L10n.t(.workspaceConnectToDeviceHint))
                            .font(.subheadline).foregroundStyle(Palette.textTertiary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: Metrics.tight)
                    Button(L10n.t(.workspaceConnectToDevice)) { connect(to: device) }
                        .buttonStyle(.referencePrimary)
                        .disabled(sessionLocked)
                        .accessibilityIdentifier("lan-connect-device")
                }
                Text(L10n.t(.nearbyAcceptanceNote))
                    .font(.subheadline).foregroundStyle(Palette.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
                InlineMessage(.info, L10n.t(.linkOneConnectionNote))
                    .accessibilityIdentifier("lan-device-connection-note")
            } else {
                Text(L10n.t(.nearbySendTo, [L10n.token(device.label)]))
                    .font(.callout.weight(.semibold))
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
