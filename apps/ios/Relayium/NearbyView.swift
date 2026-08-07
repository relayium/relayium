import SwiftUI
import UniformTypeIdentifiers
import RelayiumAppKit
import RelayiumKit

/// R3-F: transfer to a device on this address, with no code and no account —
/// and accept one that arrives the same way.
///
/// **This is not "devices on your Wi-Fi", and saying so is the first thing the
/// screen does.** Nothing here scans the local network. The app joins
/// Relayium's code-less rendezvous room, and the server groups that room by the
/// public address it observes a device arriving from. Usually that is the
/// user's own Wi-Fi. Behind a carrier NAT or a shared VPN gateway it is not, and
/// the roster can hold devices belonging to strangers. The screen opens with the
/// half of that which changes a decision — the address can be shared with
/// strangers — and keeps the mechanism itself one tap away in a closed
/// disclosure, because as an always-open paragraph it pushed every control off
/// the first several screens at accessibility content sizes. Everything else
/// here follows from that same fact:
///
///  - **nothing is ever preselected**, not even when the room holds exactly one
///    other entry — that is precisely the case where the only candidate might be
///    a stranger;
///  - **names are labels**, peer-supplied and duplicated as a matter of course,
///    so the disclaimer sits under the list rather than in a help article;
///  - **receiving is opt-outable in one tap**, and what it means while it is on
///    is stated rather than left to be discovered by finding a file.
///
/// **It owns nothing.** Both realtime models, the file selection and its
/// security scopes, the files-or-text answer and the room socket are app-scoped
/// and handed in — the same objects the Direct tab drives. A `TabView` mounts
/// tabs lazily and tears an off-screen one down, so a view that owned any of
/// them would end a live DataChannel, drop a sandbox extension mid-read, or take
/// this device off the roster, on a tab switch.
///
/// **And it adds no capability.** No local-network usage description, no Bonjour
/// service, no multicast entitlement, no background mode and no notification: an
/// inbound session brings this tab forward in app, because the app is in the
/// foreground or the session does not exist.
struct NearbyView: View {
    @ObservedObject var file: RealtimeSessionModel
    @ObservedObject var text: RealtimeTextSessionModel
    @ObservedObject var selection: DirectSendSelection
    @ObservedObject var modes: DirectModeSelection
    @ObservedObject var foreground: ForegroundSessionCoordinator
    /// Which of the two direct tabs draws the session. Both drive the same
    /// models, so exactly one may render one — the other says where it is.
    @ObservedObject var presence: TransferPresence
    @ObservedObject var discovery: LanDiscoveryModel
    @ObservedObject var receive: NearbyReceiveModel
    /// Every residency action goes through here, because every one of them has
    /// an ordering: the receive folder is resolved and installed before this
    /// device is advertised as reachable.
    @ObservedObject var residency: NearbyResidencyCoordinator
    /// Navigating to whichever tab owns the session. A destination selection
    /// handed down, the same shape the Direct tab uses for Send and Account —
    /// which is what lets the shell stay ignorant of both.
    let onShowSession: (AppDestination) -> Void

    /// The advanced-verification preference, shared with every other surface
    /// that can start a session. Nothing account-shaped is declared here, and
    /// `IOSSurfaceGuardTests` checks that as a source property: both directions
    /// genuinely reach the transport with no credential.
    @EnvironmentObject private var verification: VerificationPreference

    @State private var isChoosingFiles = false
    /// The mechanism paragraph starts closed, every time the tab is built.
    ///
    /// Deliberately not persisted: this is a disclosure on a screen whose first
    /// job is to be usable, not a preference. Persisting "open" would restore
    /// exactly the layout this refinement exists to remove, on the content size
    /// where it hurts most.
    @State private var showsMechanism = false
    /// A refusal that happened before any session existed — no device selected,
    /// nothing staged, a batch that cannot be sent. Deliberately not a session
    /// state: nothing was connected, so a `.failed` session would offer a retry
    /// that retries nothing.
    @State private var actionError: String?

    private var busy: Bool { file.isBusy || text.isBusy }

    /// Derived on every render from the two live models rather than cached: a
    /// stored flag would be a second answer to a question they already answer.
    private var isLocked: Bool {
        DirectModeSelection.isLocked(file: file.state,
                                     text: text.state,
                                     sessionClaimed: presence.owner != nil)
    }

    var body: some View {
        NavigationStack {
            // The longest screen in the app: an explanation, a status card, a
            // roster of unknown length, a staging section and a session. At the
            // largest accessibility content sizes anything not in a `ScrollView`
            // puts its own action off the bottom with no way to reach it.
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let owner = presence.owner, owner != .nearby {
                        busyElsewhere(owner)
                    } else if presence.rendersSession(.nearby) {
                        session
                    } else {
                        discoverySection
                    }
                }
                .padding()
                // Leading, not centred: at the largest Dynamic Type sizes a
                // centred ragged column is unreadable.
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle(L10n.t(.navNearby))
        }
        // `[.item, .folder]`, so a folder is choosable and its contents are
        // expanded inside the security scope `DirectSendSelection` starts before
        // anything enumerates them. The same app-scoped owner the Direct tab
        // uses — one selection, one set of scopes, balanced once.
        .fileImporter(isPresented: $isChoosingFiles,
                      allowedContentTypes: [.item, .folder],
                      allowsMultipleSelection: true) { result in
            selection.chooseFiles(result)
        }
    }

    // MARK: - not this tab's session

    /// The other direct tab is presenting it. Say so and offer the way there —
    /// never a second copy of the session with its own Cancel, which is what
    /// rendering both would produce, since both drive the same two models.
    private func busyElsewhere(_ owner: AppDestination) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n.t(.presenceBusyTitle)).font(.headline)
            Text(L10n.t(.presenceBusyBody))
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button { onShowSession(owner) } label: {
                Text(L10n.t(.presenceShowIt)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
    }

    // MARK: - discovery

    @ViewBuilder
    private var discoverySection: some View {
        safetySummary

        if let notice = foreground.interruption { interruption(notice) }

        receiving

        modePicker

        // Staging is deliberately ABOVE and independent of the roster: choosing
        // what to send and choosing who to send it to are two separate acts, and
        // only the Send button combines them.
        if modes.mode == .files { filesToSend }

        if case let .reconnecting(message) = discovery.state {
            failureLine(message)
        }

        roster

        if let device = discovery.selectedDevice {
            Divider()
            actions(for: device)
        }

        if let actionError { failureLine(actionError) }

        Text(L10n.t(.nearbyNoAccountNeeded))
            .font(.footnote)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)

        verificationSetting
    }

    /// **The claim that may never be behind a tap, and the paragraph that may.**
    ///
    /// The mechanism explanation is the honest one and none of it is dropped:
    /// nothing is scanned, the room is grouped by the public address the server
    /// observes. But as the first thing on the screen it cost the user
    /// everything below it — at the largest accessibility content sizes that one
    /// paragraph filled several screens before any control could be reached,
    /// which is how a safety notice turns into something scrolled past rather
    /// than read.
    ///
    /// So the part that changes a decision — this address can be shared with
    /// strangers behind a carrier, VPN or shared gateway — stays visible and
    /// stays short, and the mechanism moves into a disclosure that starts
    /// closed. The order changed; nothing was removed and nothing was softened.
    private var safetySummary: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L10n.t(.nearbySafetySummary))
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            // Labelled, because a bare chevron says nothing about what it
            // hides — and a disclosure nobody opens is the same as deleting the
            // explanation.
            DisclosureGroup(isExpanded: $showsMechanism) {
                Text(L10n.t(.nearbyExplain))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 4)
            } label: {
                Text(L10n.t(.nearbyHowItWorks))
                    .font(.footnote)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Receiving is on by default and runs whether or not this tab is on screen,
    /// so this section's job is to say so plainly — including the part that is
    /// uncomfortable. A transfer the user has to discover by finding a file is
    /// worse than one they were told about.
    @ViewBuilder
    private var receiving: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(NearbyStatusPresentation.text(for: receive.state))
                .font(.subheadline.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            // The default is no prompt, by the same decision that made advanced
            // verification opt-in. Stating the consequence is not a
            // contradiction of that decision; hiding it would be.
            Text(L10n.t(residency.isPaused ? .nearbyPausedBody : .nearbyListeningBody))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if !residency.isPaused {
                // Where an unsolicited file lands, and it is the place this
                // platform actually has: the app's own folder, published to the
                // Files app. The Mac's sentence names Downloads, which is a
                // folder no iOS app has — which is why the location is its own
                // key rather than part of the paragraph above.
                Text(L10n.t(.nearbySavedToAppFolder))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if residency.isPaused {
                Button(L10n.t(.nearbyResumeReceiving)) { residency.resume() }
                    .buttonStyle(.bordered)
                    .controlSize(.large)
            } else {
                Button(L10n.t(.nearbyPauseReceiving)) { residency.pause() }
                    .buttonStyle(.bordered)
                    .controlSize(.large)
                    .disabled(busy)
            }
            // The folder could not be resolved, so this device is deliberately
            // NOT in the room. Retryable, because the cause is something in the
            // user's own Files app and the app may not tidy it away.
            if let problem = residency.destinationError {
                failureLine(problem)
                Button(L10n.t(.commonTryAgain)) { residency.retry() }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
            }
            if let failure = receive.lastFailure { failureLine(failure) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L10n.t(.nearbyA11yReceiving))
    }

    /// Files or text — the SAME question the Direct tab asks, held once in
    /// `DirectModeSelection`, and locked by it the moment either model owns a
    /// session. `.disabled` is the courtesy; the refusal is `select`, which
    /// re-reads both model states, because SwiftUI still owns the binding
    /// behind a disabled control.
    private var modePicker: some View {
        Picker(L10n.t(.hubTransferType), selection: Binding(
            get: { modes.mode },
            set: { modes.select($0,
                                file: file.state,
                                text: text.state,
                                sessionClaimed: presence.owner != nil) }
        )) {
            Text(L10n.t(.hubFiles)).tag(TransferMode.files)
            Text(L10n.t(.hubText)).tag(TransferMode.text)
        }
        .pickerStyle(.segmented)
        .disabled(isLocked)
        .accessibilityHint(L10n.t(.hubTransferTypeHint))
    }

    /// What will be sent, staged before — and independently of — the device it
    /// will be sent to.
    @ViewBuilder
    private var filesToSend: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let summary = selection.summary {
                HStack(spacing: 12) {
                    Text(summary).font(.subheadline)
                    Spacer(minLength: 0)
                    Button(L10n.t(.commonClear)) { selection.clear() }
                        .disabled(busy)
                }
                // One element, so VoiceOver reads "3 files" rather than
                // stopping on each fragment of the summary.
                .accessibilityElement(children: .combine)
            }
            PendingFileList(files: selection.selectedFiles)
            if let message = selection.errorMessage { failureLine(message) }
            Button { isChoosingFiles = true } label: {
                Text(L10n.t(.commonChooseFilesOrFolders)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .disabled(busy)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var roster: some View {
        if discovery.isScanning {
            if discovery.devices.isEmpty {
                // The state a first-time user is most likely to be in, and the
                // copy is the one thing that tells them what to do about it.
                VStack(alignment: .leading, spacing: 8) {
                    Image(systemName: "dot.radiowaves.left.and.right")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                    Text(L10n.t(.nearbyEmptyRoster))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    // Keyed by peer id, never by position: the hub's roster
                    // order is not stable, and a row that moves under the
                    // finger between two frames is how the wrong device gets
                    // tapped.
                    ForEach(discovery.devices) { device in
                        deviceRow(device)
                    }
                    Text(L10n.t(.nearbyNamesDisclaimer))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel(L10n.t(.nearbyA11yDevices))
            }
        } else if !residency.isPaused && residency.destinationError == nil {
            // Not in the room and not by the user's choice — a drop, or a
            // residency that has not finished starting. The explicit "look
            // again" belongs here rather than beside the pause control, which
            // is about a different decision.
            Button(L10n.t(.nearbyLookAgain)) { residency.refresh() }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .disabled(busy)
        }
    }

    private func deviceRow(_ device: NearbyDevice) -> some View {
        let selected = discovery.selectedId == device.id
        return Button {
            // Selection is explicit, one device at a time, and always the
            // user's: nothing here preselects, not even when the room happens
            // to hold exactly one other device.
            if selected { discovery.clearSelection() } else { discovery.select(device.id) }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                // The peer's own name, already stripped of control and bidi
                // characters by `safeDisplayName`.
                Text(device.label)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
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
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n.t(.nearbySendTo, [L10n.token(device.label)]))
                .font(.subheadline.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            switch modes.mode {
            case .files:
                Text(selection.summary.map { L10n.t(.nearbySelectionSendHint, [$0]) }
                     ?? L10n.t(.nearbyAddFilesHint))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button { sendFiles() } label: {
                    Text(L10n.t(.commonSend)).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(selection.isEmpty || busy)
            case .text:
                Text(L10n.t(.nearbyTextIntent))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button { startText() } label: {
                    Text(L10n.t(.nearbyStartMessageSession)).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(busy)
            }
            // Says what actually happens on the other end rather than implying
            // a human gate that is not there.
            Text(L10n.t(.nearbyAcceptanceNote))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - the live session

    @ViewBuilder
    private var session: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let notice = foreground.interruption { interruption(notice) }
            sessionPeer
            switch modes.mode {
            case .files:
                if case let .failed(message) = file.state { failureLine(message) }
                DirectFileSessionView(model: file)
            case .text:
                DirectTextSessionView(model: text)
            }
            if !busy {
                Button(L10n.t(.nearbyBackToDevices)) { leaveSession() }
                    .buttonStyle(.bordered)
                    .controlSize(.large)
                if modes.mode == .text {
                    // Says so rather than surprising: leaving is the one action
                    // here that discards the local history the terminal view is
                    // still showing.
                    Text(L10n.t(.nearbyLeavingClearsHistory))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var sessionPeer: some View {
        if let label = presence.sessionPeerLabel {
            VStack(alignment: .leading, spacing: 4) {
                Text(L10n.t(.nearbySessionWith, [L10n.token(label)]))
                    .font(.headline)
                Text(L10n.t(.nearbySessionPeerDisclaimer))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - shared pieces

    /// The advanced-verification setting, on the surface that uses it. Off by
    /// default — `VerificationPreference` owns that decision and states why.
    /// Locked while a session is live, because the models read the preference
    /// when the SAS arrives and flipping it mid-handshake would make the gate
    /// depend on timing.
    private var verificationSetting: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle(L10n.t(.verifyToggle), isOn: Binding(
                get: { verification.requiresSASConfirmation },
                set: { if !isLocked { verification.requiresSASConfirmation = $0 } }
            ))
                .disabled(isLocked)
            Text(L10n.t(.verifyExplainWhat))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text(L10n.t(.verifyExplainEncryption))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// What the app could not carry into the background, said after the fact
    /// because that is the only moment it can be read.
    private func interruption(_ notice: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            failureLine(notice)
            Button(L10n.t(.commonDismiss)) { foreground.dismissInterruption() }
        }
    }

    /// A failure line. The icon carries the label rather than sitting beside an
    /// unlabelled image, so VoiceOver reads the sentence and not "image".
    private func failureLine(_ message: String) -> some View {
        Label {
            Text(message)
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
        }
        .font(.callout)
        .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: - actions

    private func sendFiles() {
        // A second press while the first send is still setting up would stage a
        // second batch over the first and dial again. The button is disabled
        // while busy; this is the guard that does not depend on a redraw.
        guard !busy else { return }
        // Re-read rather than capturing the device at render time: the roster is
        // live, and a device that left between the row being drawn and this
        // button being pressed must not be dialled by a stale id — which by then
        // may belong to a different device entirely.
        guard let device = discovery.selectedDevice else {
            actionError = L10n.t(.nearbyDeviceGone)
            return
        }
        guard let staged = selection.stageForSend() else {
            actionError = selection.errorMessage ?? L10n.t(.nearbyAddFilesFirst)
            return
        }
        actionError = nil
        // Claimed BEFORE anything is written to the shared model, so the session
        // this is about to start is presented here — and so a refusal costs
        // nothing. A refusal means the other tab already owns a session, and
        // staging over its pending batch would be this tab reaching into a
        // transfer it is not even drawing.
        guard presence.claim(.nearby, peerLabel: device.label) else { return }
        foreground.sessionStarting()
        file.stageSend(sources: staged.sources, metas: staged.metas)
        Task { await file.connectNearby(peerId: device.id, role: .initiator) }
    }

    private func startText() {
        guard !busy else { return }
        guard let device = discovery.selectedDevice else {
            actionError = L10n.t(.nearbyDeviceGone)
            return
        }
        actionError = nil
        guard presence.claim(.nearby, peerLabel: device.label) else { return }
        foreground.sessionStarting()
        Task { await text.connectNearby(peerId: device.id, role: .initiator) }
    }

    /// Back to the roster. The explicit discard: the file model's `cancel`
    /// removes a partial write, the text model's `reset` drops the transcript,
    /// and the staged selection goes with them so the next send is a fresh
    /// choice rather than a repeat nobody asked for.
    private func leaveSession() {
        switch modes.mode {
        case .files: file.cancel()
        case .text: text.reset()
        }
        selection.clear()
        actionError = nil
        presence.release(.nearby)
    }
}
