import SwiftUI
import UniformTypeIdentifiers
import RelayiumAppKit
import RelayiumKit

/// R3-F: transfer to a device on this local network, with no code and no
/// account — and accept one that arrives the same way.
///
/// **This screen is composed over Bonjour, and every sentence it renders has to
/// be that wire's.** `RelayiumApp` builds the discovery graph through
/// `LocalNearbyEnvironment`, which drives `NetworkLocalPeerTransport`: this
/// device publishes and browses exactly `_relayium._tcp` on the local link it
/// has joined, and asks nothing outside that link who is nearby. So the roster
/// is *this network*, not a public address a server observed — and a browser on
/// the production host, which advertises no Bonjour service, can never be on it.
///
/// That is why the six sentences below are `nearbyIOS*` keys rather than the
/// shared ones beside them. macOS still runs the hub-backed code-less room, so
/// its public-address, carrier/VPN and open-the-site copy is still true there
/// and is deliberately left alone; rendering it here stated four things this
/// binary does not do, which is what a Release capture of this tab exposed.
///
/// The risk did not go away with the rendezvous, it changed shape: a café,
/// hotel or office network is shared, so the devices that answer can still
/// belong to strangers. The screen therefore opens with the half of that which
/// changes a decision and keeps the mechanism one tap away in a closed
/// disclosure, because as an always-open paragraph it pushed every control off
/// the first several screens at accessibility content sizes. Everything else
/// here follows from that same fact:
///
///  - **nothing is ever preselected**, not even when the roster holds exactly
///    one other entry — that is precisely the case where the only candidate
///    might be a stranger on a shared network;
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
/// **It adds one declaration, and both halves of this tab now need it.**
/// Reading the roster is itself a local-network operation — `_relayium._tcp`
/// browsed and advertised, still with no multicast entitlement and no address
/// scan — and connecting to the device the user picks is gated for the second
/// time: the session is built with `iceTransportPolicy = .all` and routinely
/// settles on the peer's address on this subnet. So `Info.plist` declares
/// `NSLocalNetworkUsageDescription` and iOS asks once, and its purpose string
/// names both actions rather than only the transfer. There is still no
/// background mode and no notification: `NearbyResidencyCoordinator` leaves the
/// link on `.background`, so an inbound session brings this tab forward in app,
/// because the app is open or the session does not exist. That limit is not
/// only a comment — it is the sentence `nearbyIOSListeningBody` states.
///
/// ## Two products behind one roster, chosen by the peer
///
/// A device that announced exact `link/1` gets the unified workspace: one
/// connection, verified once, carrying messages and repeated file/folder batches
/// in both directions. Everything else gets the legacy wire exactly as it
/// shipped. Which one is not a question put to the user — it is
/// `NearbyDevice.supportsLink`, the roster's record of what that peer said, and
/// `NearbyConnectPresentation` is the one place the screen reads it.
///
/// So the Files/Text picker is **hidden for a link peer**, because that
/// connection has no halves to pick between, and the two verbs collapse into one
/// Connect. It is untouched for a legacy peer, whose two generations genuinely
/// do not interoperate.
///
/// **Staging before connecting is kept**, on both. That is where this platform
/// still differs from macOS, deliberately: macOS removed pre-connect staging
/// because opening a picker inside a live Mac session costs nothing, while on
/// iOS the picker is a full-screen document browser. A batch staged before
/// Connect is ARMED on the link and released once the digits are answered —
/// never sent early, and never lost.
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
    /// The unified `link/1`, consulted per DEVICE rather than per screen: two
    /// devices in one room can legitimately differ, and a note above the roster
    /// could only ever be right about one of them.
    @ObservedObject var link: LinkWorkspaceModel
    /// The workspace's own post-connect picker. Separate from `selection` so a
    /// send made inside the session cannot replace the batch the user staged for
    /// a different device — see `RelayiumApp`.
    @ObservedObject var linkSelection: DirectSendSelection
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
    @State private var confirmingLocalTextLeave = false

    /// Anything running that a new action must not start over the top of.
    ///
    /// The link is the THIRD source and it has to be here: it uses neither
    /// legacy model, so both of them read `.idle` for a link's entire life, and
    /// without this the roster's rows and the Pause control would be live
    /// underneath a running connection.
    private var busy: Bool { file.isBusy || text.isBusy || link.connection.isActive }
    /// Ownership is published before an async start, so it cannot by itself
    /// mean there is already a task the user may leave. Terminal states remain
    /// non-idle and keep the exit visible after active work stops.
    private var hasRetainedSession: Bool {
        file.state != .idle || text.state != .idle
    }

    /// Derived on every render from the two live models rather than cached: a
    /// stored flag would be a second answer to a question they already answer.
    ///
    /// A link locks it through `sessionClaimed`: the link claims the surface
    /// through the same `TransferPresence`, so the preference toggle and the
    /// picker are locked for it without this needing a fourth argument.
    private var isLocked: Bool {
        DirectModeSelection.isLocked(file: file.state,
                                     text: text.state,
                                     sessionClaimed: presence.owner != nil)
    }

    /// Which of the three panes this tab draws, from the shared rule both
    /// platforms follow rather than from a second copy of it here.
    private var pane: TransferSurfacePane {
        TransferSurfacePresentation.pane(route: .nearby,
                                         owner: presence.owner,
                                         linkHasSession: link.hasSession)
    }

    var body: some View {
        NavigationStack {
            // The longest screen in the app: an explanation, a status card, a
            // roster of unknown length, a staging section and a session. At the
            // largest accessibility content sizes anything not in a `ScrollView`
            // puts its own action off the bottom with no way to reach it.
            ScrollView {
                VStack(alignment: .leading, spacing: Metrics.section) {
                    if let owner = presence.owner, owner != .nearby {
                        busyElsewhere(owner)
                    } else {
                        switch pane {
                        case .link:
                            // The interruption notice belongs above every pane:
                            // the app can be backgrounded out of a link exactly
                            // as it can out of a legacy session, and the notice
                            // is readable only after it is back on screen.
                            if let notice = foreground.interruption { interruption(notice) }
                            NearbyLinkWorkspaceView(link: link, selection: linkSelection)
                        case .legacySession:
                            session
                        case .connect:
                            discoverySection
                        }
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
        .confirmationDialog(
            L10n.t(.textDiscardLocalContentConfirmTitle),
            isPresented: $confirmingLocalTextLeave,
            titleVisibility: .visible
        ) {
            Button(L10n.t(.nearbyBackToDevices), role: .destructive) { leaveSession() }
            Button(L10n.t(.commonCancel), role: .cancel) {
                confirmingLocalTextLeave = false
            }
        } message: {
            Text(L10n.t(.textDiscardLocalContentConfirmBody))
        }
    }

    // MARK: - not this tab's session

    /// The other direct tab is presenting it. Say so and offer the way there —
    /// never a second copy of the session with its own Cancel, which is what
    /// rendering both would produce, since both drive the same two models.
    private func busyElsewhere(_ owner: AppDestination) -> some View {
        SectionCard(L10n.t(.presenceBusyTitle)) {
            Text(L10n.t(.presenceBusyBody))
                .font(.callout)
                .foregroundStyle(Palette.supportingLabel)
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

        // **The tab's one task, and the reason it is first.**
        //
        // Receiving is on by default and runs whether or not this tab is on
        // screen; sending is the thing a person opened this tab to DO. Before
        // this they were peers in one flat column — an explanation, a receiving
        // status with its own button, a mode picker, a chooser and a roster,
        // each twenty points below the last — so the screen had no primary
        // anything, and at accessibility content sizes the chooser was three
        // swipes down. The receiving card keeps every word it had; it is
        // second, not smaller.
        sendTask

        receiving

        Text(L10n.t(.nearbyNoAccountNeeded))
            .font(.footnote)
            .foregroundStyle(Palette.supportingLabel)
            .fixedSize(horizontal: false, vertical: true)

        verificationSetting
    }

    /// One card, two acts, one action.
    ///
    /// The rail states the route before either act: this device, an encrypted
    /// middle whose shape the client cannot prove, and the device the user
    /// picks. Staging stays deliberately ABOVE and independent of the roster —
    /// choosing what to send and choosing who to send it to are separate, and
    /// only Send combines them — which is what the two headings now say out
    /// loud instead of leaving it to the order.
    private var sendTask: some View {
        SectionCard(L10n.t(.nearbySendTaskTitle)) {
            PathRail(stops: PathRailPresentation.iosNearby())

            OpenSection(L10n.t(.nearbyWhatToSend)) {
                // **The picker is not always the right question.** For a peer
                // that announced exact `link/1` the connection carries messages
                // and files at once, so "files or text?" has no answer that
                // means anything — and whichever half the user picked, the
                // workspace would then ignore it. Hidden for that peer, kept for
                // every legacy one, and the rule lives in
                // `NearbyConnectPresentation` so `swift test` drives it.
                if NearbyConnectPresentation.showsModePicker(for: discovery.selectedDevice) {
                    modePicker
                }
                if NearbyConnectPresentation.showsStaging(for: discovery.selectedDevice,
                                                          mode: modes.mode) {
                    filesToSend
                }
            }

            OpenSection(L10n.t(.nearbyWhoToSend)) {
                if case let .reconnecting(message) = discovery.state {
                    failureLine(message)
                }
                roster
            }

            if let device = discovery.selectedDevice {
                actions(for: device)
            }

            if let actionError { failureLine(actionError) }
        }
    }

    /// **The claim that may never be behind a tap, and the paragraph that may.**
    ///
    /// The mechanism explanation is the honest one and none of it is dropped:
    /// one Bonjour service on the local link, no address scan, nothing outside
    /// that link asked. But as the first thing on the screen it cost the user
    /// everything below it — at the largest accessibility content sizes that one
    /// paragraph filled several screens before any control could be reached,
    /// which is how a safety notice turns into something scrolled past rather
    /// than read.
    ///
    /// So the part that changes a decision — a shared network is somebody
    /// else's network too, and the devices that answer can be strangers' —
    /// stays visible and stays short, and the mechanism moves into a disclosure
    /// that starts closed. The order changed; nothing was removed and nothing
    /// was softened.
    ///
    /// Both halves are `nearbyIOS*`. The shared keys beside them say the same
    /// two things about a public address and a carrier or VPN gateway, which is
    /// the macOS room's truth and not this one's.
    private var safetySummary: some View {
        VStack(alignment: .leading, spacing: Metrics.tight) {
            // The shared inline-message role rather than another grey
            // paragraph: it is the one thing on this screen a person has to
            // read before choosing a device, and a symbol is what tells it
            // apart from the explanation underneath it at a glance. `.info`,
            // not `.warning` — nothing has gone wrong, and spending the
            // warning colour here would leave the real failures below it
            // looking the same as the standing caution above them.
            InlineMessage(.info, L10n.t(.nearbyIOSSafetySummary))
            // Labelled, because a bare chevron says nothing about what it
            // hides — and a disclosure nobody opens is the same as deleting the
            // explanation.
            DisclosureGroup(isExpanded: $showsMechanism) {
                Text(L10n.t(.nearbyIOSExplain))
                    .font(.footnote)
                    .foregroundStyle(Palette.supportingLabel)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, Metrics.hairline)
            } label: {
                Text(L10n.t(.nearbyHowItWorks))
                    .font(.footnote)
                    .fixedSize(horizontal: false, vertical: true)
            }
            // Grey, not violet. A disclosure over an explanation is a control,
            // but it is not THE control: drawn in the accent it read as loud as
            // the task below it, which is the one thing the accent is for. The
            // chevron still says it opens.
            //
            // The role rather than the system grey, because `.tint` on a
            // `DisclosureGroup` colours the LABEL as well as the chevron — so
            // "How this list works" was being drawn in `Color.secondary` with no
            // `.foregroundStyle` anywhere near it to say so. A source audit
            // classified this as a control tint and was wrong; the Light system
            // audit rendered it and reported the sentence. Grey is preserved,
            // legibility is added, and the chevron comes along at 4.61:1.
            .tint(Palette.supportingLabel)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Receiving is on by default and runs whether or not this tab is on screen,
    /// so this section's job is to say so plainly — including the part that is
    /// uncomfortable. A transfer the user has to discover by finding a file is
    /// worse than one they were told about.
    /// One question, asked of the state that is actually on screen: is this
    /// device listening right now?
    ///
    /// `residency.isPaused` answers a different one — whether the user turned
    /// receiving off — and the two disagree. A destination failure returns
    /// before discovery ever starts, and `resume` on a model that was never
    /// resident lands in the same place: off, with no pause anywhere.
    private var isListening: Bool {
        !(receive.state == .paused || receive.state == .off)
    }

    /// The status IS the title, which is the whole hierarchy change here: the
    /// one question this card answers — is this device listening right now — is
    /// now the thing the eye lands on and the thing VoiceOver reads on entering
    /// the group, rather than a semibold line among five other lines.
    @ViewBuilder
    private var receiving: some View {
        SectionCard(NearbyStatusPresentation.text(for: receive.state)) {
            receivingBody
        }
    }

    @ViewBuilder
    private var receivingBody: some View {
        VStack(alignment: .leading, spacing: Metrics.tight) {
            // The default is no prompt, by the same decision that made advanced
            // verification opt-in. Stating the consequence is not a
            // contradiction of that decision; hiding it would be.
            Text(L10n.t(isListening ? .nearbyIOSListeningBody : .nearbyPausedBody))
                .font(.footnote)
                .foregroundStyle(Palette.supportingLabel)
                .fixedSize(horizontal: false, vertical: true)
            if isListening {
                // Where an unsolicited file lands, and it is the place this
                // platform actually has: the app's own folder, published to the
                // Files app. The Mac's sentence names Downloads, which is a
                // folder no iOS app has — which is why the location is its own
                // key rather than part of the paragraph above. It is a promise
                // about delivery, so it is made only while delivery can happen.
                Text(L10n.t(.nearbySavedToAppFolder))
                    .font(.footnote)
                    .foregroundStyle(Palette.supportingLabel)
                    .fixedSize(horizontal: false, vertical: true)
            }
            switch receive.state {
            case .paused:
                Button(L10n.t(.nearbyResumeReceiving)) { residency.resume() }
                    .borderedAction()
                    .controlSize(.large)
            case .connecting, .ready, .reconnecting, .active:
                Button(L10n.t(.nearbyPauseReceiving)) { residency.pause() }
                    .borderedAction()
                    .controlSize(.large)
                    .disabled(busy)
            case .off:
                // Look again, in the roster below, is the one recovery that
                // matches an off listener. Offering Pause here would be an
                // action against a state that already holds, and Resume would
                // undo a pause nobody took.
                EmptyView()
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
        VStack(alignment: .leading, spacing: Metrics.inner) {
            if let summary = selection.summary {
                HStack(spacing: Metrics.inner) {
                    // The staged batch is the answer to this section's own
                    // question, so it is stated at the weight of an answer
                    // rather than as another line of body text.
                    Text(summary).font(.subheadline.weight(.semibold))
                    Spacer(minLength: 0)
                    Button(L10n.t(.commonClear)) { selection.clear() }
                        .textAction()
                        .disabled(busy)
                }
                // One element, so VoiceOver reads "3 files" rather than
                // stopping on each fragment of the summary.
                .accessibilityElement(children: .combine)
            }
            PendingFileList(files: selection.selectedFiles)
            if let message = selection.errorMessage { failureLine(message) }
            // **Exactly one prominent control on the screen at a time.**
            //
            // With nothing staged this IS the task — Send below is disabled and
            // there is nothing else to press — so it is drawn as the action.
            // Once something is staged the emphasis moves to Send and this
            // becomes the ordinary way to change what is going: two prominent
            // buttons in one card is the same as none.
            if selection.isEmpty {
                Button { isChoosingFiles = true } label: {
                    Text(L10n.t(.commonChooseFilesOrFolders)).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(busy)
            } else {
                Button { isChoosingFiles = true } label: {
                    Text(L10n.t(.commonChooseFilesOrFolders)).frame(maxWidth: .infinity)
                }
                .borderedAction()
                .controlSize(.large)
                .disabled(busy)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var roster: some View {
        if discovery.isScanning {
            if discovery.devices.isEmpty {
                // The state a first-time user is most likely to be in, and the
                // copy is the one thing that tells them what to do about it.
                // The shared empty-state role, so this and the device list on
                // the Send tab are the same designed state rather than two
                // hand-built ones.
                // nonlocalized: SF Symbol name
                EmptyStateView(symbol: "dot.radiowaves.left.and.right",
                               message: L10n.t(.nearbyIOSEmptyRoster))
            } else {
                VStack(alignment: .leading, spacing: Metrics.inner) {
                    // Keyed by peer id, never by position: roster order is not
                    // stable — here it is whatever order the Bonjour browser
                    // resolved its results in — and a row that moves under the
                    // finger between two frames is how the wrong device gets
                    // tapped.
                    ForEach(discovery.devices) { device in
                        deviceRow(device)
                    }
                    Text(L10n.t(.nearbyNamesDisclaimer))
                        .font(.footnote)
                        .foregroundStyle(Palette.supportingLabel)
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
                .borderedAction()
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
            HStack(spacing: Metrics.inner) {
                // `actionLabel`, not `action`. This glyph is the FIRST carrier
                // of "this is the one you chose", and it sits on
                // `Palette.actionSurface` — the accent as a foreground on a
                // wash of itself, which is the pair a real screenshot measured
                // at 2.70:1 against the 3:1 a meaningful non-text graphic owes.
                // The label role clears it at 6.7:1 and is unchanged in Light.
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    // secondary-role: selection-state — the UNSELECTED checkbox. Non-text, and
                    // selection is also carried by the filled/hollow shape, not colour alone.
                    .foregroundStyle(selected ? Palette.actionLabel : Color.secondary)
                // The peer's own name, already stripped of control and bidi
                // characters by `safeDisplayName`.
                Text(device.label)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            // A row is a target before it is a label: 44pt is the platform's own
            // floor and a row that happens to measure less because the peer
            // named itself "TV" is a row somebody misses.
            .frame(minHeight: Metrics.hitTarget)
            .padding(.horizontal, Metrics.tight)
            // The second carrier of "this is the one you chose", after the
            // symbol. It is the accent at background weight — the one place a
            // tint may sit behind text — so selection survives a colour filter
            // and does not depend on telling a filled circle from an empty one.
            .background(selected ? Palette.actionSurface : Color.clear,
                        in: RoundedRectangle(cornerRadius: Metrics.corner, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .accessibilityHint(L10n.t(.nearbyA11yChooseDevice))
    }

    /// **One verb for a link peer, the two shipped verbs for a legacy one.**
    ///
    /// The link connection has nothing to choose between before it exists: it
    /// carries a conversation and as many batches as the user wants. So Connect
    /// is the only action, and what it does with a batch the user already staged
    /// is stated under it rather than left to be discovered — the files travel
    /// with the connection and are released once the digits are compared.
    ///
    /// A legacy peer keeps `Send` and `Start a message session` exactly as they
    /// shipped, because behind it there really are two non-interoperating
    /// generations and iOS really does stage first.
    @ViewBuilder
    private func actions(for device: NearbyDevice) -> some View {
        VStack(alignment: .leading, spacing: Metrics.inner) {
            Text(L10n.t(.nearbySendTo, [L10n.token(device.label)]))
                .font(.subheadline.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            switch NearbyConnectPresentation.sendChoice(for: device) {
            case .unifiedLink:
                linkActions(for: device)
            case .legacyLanes:
                legacyActions(for: device)
            }
            // Says what actually happens on the other end rather than implying
            // a human gate that is not there.
            Text(L10n.t(.nearbyIOSAcceptanceNote))
                .font(.footnote)
                .foregroundStyle(Palette.supportingLabel)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func linkActions(for device: NearbyDevice) -> some View {
        Text(L10n.t(.linkConnectToDeviceHint))
            .font(.footnote)
            .foregroundStyle(Palette.supportingLabel)
            .fixedSize(horizontal: false, vertical: true)
        Button { connectLink(to: device) } label: {
            Text(L10n.t(.linkConnectToDevice)).frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(busy)
        if !selection.isEmpty {
            // The one thing a staged batch needs said before Connect: it is not
            // being sent now, and it is not being dropped either.
            Text(L10n.t(.linkConnectCarriesStagedFiles))
                .font(.footnote)
                .foregroundStyle(Palette.supportingLabel)
                .fixedSize(horizontal: false, vertical: true)
        }
        // `actionError` is NOT rendered here: `sendTask` already draws it once,
        // below this whole group, and a second copy would put the same sentence
        // on screen twice for a link peer and once for a legacy one.
    }

    @ViewBuilder
    private func legacyActions(for device: NearbyDevice) -> some View {
        VStack(alignment: .leading, spacing: Metrics.inner) {
            switch modes.mode {
            case .files:
                Text(selection.summary.map { L10n.t(.nearbySelectionSendHint, [$0]) }
                     ?? L10n.t(.nearbyAddFilesHint))
                    .font(.footnote)
                    .foregroundStyle(Palette.supportingLabel)
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
                    .foregroundStyle(Palette.supportingLabel)
                    .fixedSize(horizontal: false, vertical: true)
                Button { startText() } label: {
                    Text(L10n.t(.nearbyStartMessageSession)).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(busy)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - the live session

    @ViewBuilder
    private var session: some View {
        VStack(alignment: .leading, spacing: Metrics.inner) {
            if let notice = foreground.interruption { interruption(notice) }
            sessionPeer
            switch modes.mode {
            case .files:
                if case let .failed(message) = file.state { failureLine(message) }
                DirectFileSessionView(model: file, onDone: finishCompletedFileTransfer)
            case .text:
                DirectTextSessionView(model: text)
            }
            if hasRetainedSession && !busy {
                Button(L10n.t(.nearbyBackToDevices)) { leaveOrConfirm() }
                    .borderedAction()
                    .controlSize(.large)
                if modes.mode == .text {
                    // Says so rather than surprising: leaving is the one action
                    // here that discards the local history the terminal view is
                    // still showing.
                    Text(L10n.t(.nearbyLeavingClearsHistory))
                        .font(.footnote)
                        .foregroundStyle(Palette.supportingLabel)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var sessionPeer: some View {
        if let label = presence.sessionPeerLabel {
            VStack(alignment: .leading, spacing: Metrics.hairline) {
                Text(L10n.t(.nearbySessionWith, [L10n.token(label)]))
                    .font(.headline)
                Text(L10n.t(.nearbySessionPeerDisclaimer))
                    .font(.footnote)
                    .foregroundStyle(Palette.supportingLabel)
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
        // In a card, untitled: the toggle's own label is the title, and the two
        // paragraphs under it are what it does and what it does NOT change.
        // Left loose at the bottom of the screen it was a wall of grey with no
        // boundary, which is how a setting starts reading as a footer.
        SectionCard {
            Toggle(L10n.t(.verifyToggle), isOn: Binding(
                get: { verification.requiresSASConfirmation },
                set: { if !isLocked { verification.requiresSASConfirmation = $0 } }
            ))
                .disabled(isLocked)
            Text(L10n.t(.verifyExplainWhat))
                .font(.footnote)
                .foregroundStyle(Palette.supportingLabel)
                .fixedSize(horizontal: false, vertical: true)
            Text(L10n.t(.verifyExplainEncryption))
                .font(.footnote)
                .foregroundStyle(Palette.supportingLabel)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// What the app could not carry into the background, said after the fact
    /// because that is the only moment it can be read.
    private func interruption(_ notice: String) -> some View {
        VStack(alignment: .leading, spacing: Metrics.tight) {
            failureLine(notice)
            Button(L10n.t(.commonDismiss)) { foreground.dismissInterruption() }
                .textAction()
        }
    }

    /// A failure line. The icon carries the label rather than sitting beside an
    /// unlabelled image, so VoiceOver reads the sentence and not "image".
    private func failureLine(_ message: String) -> some View {
        InlineMessage(.warning, message)
    }

    // MARK: - actions

    /// **The one action a `link/1` peer has**, and the only place this platform
    /// opens a unified connection.
    ///
    /// Four decisions, in this order, each made at ACTIVATION rather than at
    /// render — an announcement can arrive, a device can leave and a room can end
    /// between the frame that drew the button and the tap:
    ///
    ///  1. **Nothing is already running.** The button is disabled while busy;
    ///     this is the guard that does not depend on a redraw.
    ///  2. **The device is still there.** The roster is live, and a stale id is
    ///     how the wrong device gets dialled — by then it may belong to another.
    ///  3. **This peer can still speak `link/1`.** Asked of the model, not of the
    ///     `NearbyDevice` value this closure captured: `canLink` reads the room's
    ///     own registry, and an announcement can be revoked by a peer that
    ///     reloaded into a pairing room. A peer that cannot is NOT silently
    ///     handed the legacy path here — the button it was drawn for no longer
    ///     describes what would happen, so it refuses and says the device is
    ///     gone, and the next render draws that device's legacy verbs instead.
    ///  4. **The surface is claimed before dialling**, so the session this starts
    ///     is presented here and a concurrent inbound offer that wins loses the
    ///     claim rather than the render.
    ///
    /// The staged batch travels as an ARMED batch on the link. It is not sent
    /// here and it is not sent when the link opens either: `LinkWorkspaceModel`
    /// holds it behind the verification boundary and releases it once the digits
    /// are answered. `stageForSend` is what pins the descriptors, inside the live
    /// security scope, exactly as the legacy send does.
    private func connectLink(to device: NearbyDevice) {
        guard !busy else { return }
        guard let live = discovery.selectedDevice, live.id == device.id,
              link.canLink(peerId: live.id) else {
            actionError = L10n.t(.nearbyDeviceGone)
            return
        }
        // Staged only if the user chose something. An empty selection is the
        // ordinary case on a connect-first surface and must not be an error:
        // `stageForSend` writes `directChooseFilesFirst` for an empty store, and
        // reporting that here would refuse a connection nobody asked to carry
        // anything.
        var metas: [FileMeta] = []
        var sources: [PlaintextSource] = []
        if !selection.isEmpty {
            guard let staged = selection.stageForSend() else {
                actionError = selection.errorMessage ?? L10n.t(.nearbyAddFilesFirst)
                return
            }
            metas = staged.metas
            sources = staged.sources
        }
        actionError = nil
        guard presence.beginSession(.nearby, peerLabel: live.label) else { return }
        foreground.sessionStarting()
        guard !link.connect(peerId: live.id, peerLabel: live.label,
                            files: metas, sources: sources) else { return }
        // A refusal, and the two kinds are not the same thing to the user.
        //
        // `connect` refuses having ALREADY published a terminal reason when the
        // room went away — `.ended(.roomLost)` — and having published nothing at
        // all when the peer turned out not to be link-capable. Releasing the
        // surface in the first case would throw away the one sentence explaining
        // why, and drop the user back on a roster with no account of what
        // happened. So the surface is kept whenever the model is holding
        // something to show, and given back only when it is not.
        if link.hasSession { return }
        presence.release(.nearby)
        actionError = L10n.t(.linkNotReady)
    }

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
        guard presence.beginSession(.nearby, peerLabel: device.label) else { return }
        foreground.sessionStarting()
        file.stageSend(sources: staged.sources, metas: staged.metas)
        Task { await file.connectNearby(peerId: device.id, role: .initiator) }
    }

    /// A successful send should not return to the roster with the same batch
    /// still armed. A receive preserves any separately prepared outbound batch,
    /// and a failure stays untouched so the user can retry it.
    private func finishCompletedFileTransfer() {
        if file.received == nil { selection.clear() }
        file.cancel()
    }

    private func startText() {
        guard !busy else { return }
        guard let device = discovery.selectedDevice else {
            actionError = L10n.t(.nearbyDeviceGone)
            return
        }
        actionError = nil
        guard presence.beginSession(.nearby, peerLabel: device.label) else { return }
        foreground.sessionStarting()
        Task { await text.connectNearby(peerId: device.id, role: .initiator) }
    }

    /// Back to the roster. A failed outbound file task keeps its staged batch so
    /// retry does not begin with another picker trip. Completion and every text
    /// exit clear their consumed/local task state; file cancel still removes a
    /// receiver's partial write.
    private func leaveSession() {
        let preservesFailedFiles: Bool
        if modes.mode == .files, case .failed = file.state {
            preservesFailedFiles = true
        } else {
            preservesFailedFiles = false
        }
        switch modes.mode {
        case .files: file.cancel()
        case .text: text.reset()
        }
        if !preservesFailedFiles { selection.clear() }
        actionError = nil
        presence.release(.nearby)
    }

    private func leaveOrConfirm() {
        if modes.mode == .text, text.hasLocalContent {
            confirmingLocalTextLeave = true
        } else {
            leaveSession()
        }
    }
}
