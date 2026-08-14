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

    /// This Mac's own usable addresses, held for exactly as long as they are on
    /// screen.
    ///
    /// View state and nothing else: never written to `UserDefaults`, never
    /// logged, never sent anywhere, and emptied by the refresh task the moment
    /// the socket stops listening. An address inventory is a fingerprint
    /// of somebody's home network, and the app's only legitimate use for one is
    /// to show it to the person whose network it is.
    @State private var localAddresses: [LocalNetworkAddress] = []

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
                    .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
                    .accessibilityIdentifier("transfer-busy-elsewhere")
            }
            // This is a route, not transfer progress: before a device is chosen
            // the client can truthfully name both endpoints and encryption, but
            // it cannot mark any stop complete or promise a direct path.
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
        // Files opened from Finder or dropped on the Dock icon. `task(id:)` keyed
        // on BOTH the batch and `busy`, because either can be the change that
        // makes adoption possible: a batch that arrived mid-transfer is never
        // republished, so keying on the batch alone would strand it.
        .task(id: FileOpenAdoption(staged: fileOpenRouting.staged, busy: sessionLocked)) {
            adoptOpenedFiles()
        }
        // Re-measured periodically while listening, and immediately on every
        // socket edge. A DHCP renewal or interface change does not have to tear
        // down an existing WebSocket, so relying on reconnect alone can leave a
        // stale address visible indefinitely.
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

    /// Read while listening, cleared otherwise. The short periodic refresh
    /// covers address changes that do not force the room socket to reconnect;
    /// cancellation is owned by SwiftUI when the socket identity changes or the
    /// view disappears.
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

    // MARK: - same network

    /// **The roster first, the mechanism last.**
    ///
    /// This card used to open with `nearby.explain` — a five-line paragraph about
    /// how the rendezvous service groups devices — above the receive status,
    /// above the list of devices and above the verb that starts a transfer. It is
    /// a true and worth-having paragraph, and it was the first thing on the
    /// destination whose whole job is "pick the device and send". So the order is
    /// now what somebody came here to do: who can be reached, who is here, what
    /// to send them, and only then how the room is formed at all.
    ///
    /// What this Mac is CALLED left this card entirely: it is the identity card
    /// above, because it is the question somebody arrives with rather than a
    /// detail of the receive state it used to be filed under.
    ///
    /// The dividers that used to separate those groups are `OpenSection`s: the
    /// same second level of hierarchy, with the name attached to the group rather
    /// than floating above a line.
    private var sameNetwork: some View {
        SectionCard(title: L10n.t(.workspaceSameNetworkHeading)) {
            VStack(alignment: .leading, spacing: Metrics.inner) {
                receiving

                if case let .reconnecting(message) = discovery.state {
                    InlineMessage(.warning, message)
                        .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
                }

                if discovery.isScanning {
                    roster
                } else if !discovery.isPaused {
                    HStack {
                        // **Start receiving, because that is what it does.** It
                        // was `nearby.lookAgain` — "Look again" — which names a
                        // rescan of a roster that is already being listened for.
                        // `discovery.start()` is not a rescan: it opens the room
                        // socket, so it is also what makes this Mac reachable,
                        // and the status line directly above says *off* until it
                        // is pressed. A user reading "Look again" beside "off"
                        // is told the app is searching when nothing is
                        // listening. iOS keeps `nearby.lookAgain` for its own
                        // control, which really is a rescan.
                        Button(L10n.t(.nearbyStartReceiving)) { discovery.start() }
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

                // Inside this card: the sentences above point at it ("Choose
                // files or folders below…"), and staging is what this connection
                // carries rather than a third way to send anything.
                TransferStagingSection(selection: selection, isBusy: { sessionLocked })

                // How the room is formed at all. Reference rather than task, and
                // a footnote to the whole card rather than a group of its own —
                // so it gets a rule and no second title, and it is where
                // somebody whose device is missing from the list above will go
                // looking for it.
                Divider()
                Text(L10n.t(.nearbyExplain))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
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
                    // The matching recovery is Start receiving below. Offering
                    // Pause while the status says off is a contradictory action,
                    // and a second copy of the start control here would be two
                    // buttons for one decision.
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
        .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
    }

    // MARK: - what this Mac is on the network

    /// **What this Mac is called in the room, and which network it is actually
    /// on — as the first thing on the screen.**
    ///
    /// Two questions the receive surface could not answer, and both of them are
    /// what somebody asks when the device they expect is not in the roster.
    ///
    ///  - *Which of these is me?* The roster shows names, and this Mac's own name
    ///    was nowhere on the screen. The value shown is the one the CURRENT
    ///    socket announced — `LanDiscoveryModel` snapshots it at socket open —
    ///    not the live system name, because renaming the Mac changes the second
    ///    and not the first, and every other device in the room sees the first.
    ///  - *Am I on the network I think I am?* A Mac silently moved onto a guest
    ///    VLAN, a hotspot or a VPN looks identical to one that is fine. Its own
    ///    addresses are the only local evidence there is.
    ///
    /// ## Why it is a card of its own now
    ///
    /// It shipped as four `.caption` lines at the end of the receive-status
    /// block — under the listening sentence, under the Downloads promise, under
    /// any failure — in the same grey as the disclaimers that follow it. The one
    /// fact somebody reads this screen out loud for was the smallest type on it
    /// and below the fold on a 560pt window, and the two paragraphs explaining
    /// what it does not mean were the same size as the answer itself.
    ///
    /// So the name is the card's own primary line, at a size somebody can read
    /// across a desk; the addresses are the secondary line, monospaced and
    /// selectable because they are values to be transcribed rather than prose;
    /// and the disclaimers keep their `.caption2` at the bottom, where they
    /// qualify the answer instead of competing with it. The receive-status
    /// sentence stays exactly where it was, in the card below, and stays subtle:
    /// this card is identity, that one is state, and merging them is what made
    /// neither legible.
    ///
    /// ## The three states, and none of them is a guess
    ///
    /// The address list and the claim about what peers see require a live
    /// socket. The Mac's configured name does not: while receiving is off the
    /// card shows that name as the value Relayium will use on the next join, so
    /// the page still answers “what is this device called?” before the user
    /// starts anything. Once joined, the socket snapshot replaces it.
    ///
    ///  - **connecting or reconnecting**: this Mac is on its way into the room
    ///    and has no peer id yet, so it has no announced name to show and no
    ///    reachability to claim. There is nothing to do but wait, and the line
    ///    says so.
    ///  - **off or paused**: nothing is listening, so no other device can see
    ///    this Mac at all. The recovery is the button in the card below, which
    ///    the line points at rather than duplicating.
    ///
    /// The addresses are dropped the moment the socket stops — an address list
    /// is a fingerprint of somebody's home network, and this app writes it
    /// nowhere, sends it nowhere and keeps it no longer than the screen that
    /// shows it.
    private var thisMac: some View {
        SectionCard(title: L10n.t(.nearbyThisMacHeading)) {
            VStack(alignment: .leading, spacing: Metrics.tight) {
                identity
            }
            .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
            .accessibilityElement(children: .contain)
            .accessibilityLabel(L10n.t(.nearbyA11yThisMac))
        }
    }

    @ViewBuilder
    private var identity: some View {
        if let announced = discovery.announcedName, isListening {
            // The peer-supplied-name rules do not apply: this is our own
            // announcement. It is isolated rather than translated so a name
            // with Latin characters keeps its reading order inside Arabic.
            Text(L10n.token(announced))
                .font(.title3.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .accessibilityIdentifier("lan-announced-name")
            Text(L10n.t(.nearbyAnnouncedNameCaption))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            addresses
            // The two disclaimers this card cannot be honest without, kept
            // exactly where they were in the reading order — after the answer —
            // and in the smallest type on the card. They belong to the address
            // list and go with it: two paragraphs qualifying a list that is not
            // on screen are noise, and the state line above already says why it
            // is not.
            Text(L10n.t(.nearbyAddressesPrivacyNote))
                .font(.caption2)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text(L10n.t(.nearbyAddressesNotGroupingNote))
                .font(.caption2)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            Text(L10n.token(AppEnvironment.deviceName()))
                .font(.title3.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .accessibilityIdentifier("lan-configured-name")
            Text(L10n.t(.nearbyConfiguredNameCaption))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text(L10n.t(isStarting ? .nearbyIdentityAnnouncing : .nearbyIdentityNotListening))
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("lan-identity-unavailable")
        }
    }

    /// The secondary half: values, not prose. Monospaced so the octets line up
    /// and selectable so they can be copied into whatever is asking for them.
    @ViewBuilder
    private var addresses: some View {
        if localAddresses.isEmpty {
            Text(L10n.t(.nearbyNoLocalAddresses))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("lan-local-addresses-empty")
        } else {
            VStack(alignment: .leading, spacing: Metrics.hairline) {
                Text(L10n.t(.nearbyLocalAddressesHeading))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                ForEach(localAddresses) { address in
                    // Address and interface both isolated: they are technical
                    // values, and a bidi run would reorder the octets of one
                    // inside an Arabic sentence.
                    Text(L10n.t(.nearbyLocalAddressRow,
                                [L10n.token(address.text), L10n.token(address.interfaceName)]))
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                        // On the LEAF, never on the `ForEach`: a container
                        // identifier propagates down and renames what is
                        // inside it, which is the defect the Device Inbox
                        // pane has already lost two controls to.
                        .accessibilityIdentifier("lan-local-address")
                }
            }
        }
    }

    /// On its way into the room rather than staying out of it. `connecting` and
    /// `reconnecting` are the two states with no peer id yet and work actually
    /// in flight; `off` and `paused` are waiting for the user.
    private var isStarting: Bool {
        switch receive.state {
        case .connecting, .reconnecting: return true
        case .off, .paused, .ready, .active: return false
        }
    }

    /// The room has assigned this Mac a peer id and it can answer. `connecting`
    /// is deliberately excluded along with `reconnecting`: before `welcome`
    /// there is no peer id, so the receive model itself says this Mac is not yet
    /// reachable and the identity block must not imply otherwise.
    private var isListening: Bool {
        switch receive.state {
        case .ready, .active: return true
        case .off, .paused, .connecting, .reconnecting: return false
        }
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
        .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
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
