import SwiftUI
import RelayiumAppKit
import RelayiumKit

/// **Cross-network Transfer, before there is a peer**: mint a six-digit code or
/// type in somebody else's, and have the batch ready either way.
///
/// One connection method, and the one it is: a pairing code needs no shared
/// network, which is the whole reason this is not a card under LAN Transfer. The
/// screen says so in its own words rather than leaving the sidebar row to carry
/// the distinction alone.
///
/// ## Account asymmetry, unchanged
///
/// **Minting** a code reserves relay capacity billed to whoever created it, so
/// the create controls are wrapped in a gate and nothing else is. Joining
/// somebody else's code is account-free and is rendered and enabled identically
/// signed out — `MacSurfaceGuardTests` checks that the gate wraps only the
/// create half.
///
/// ## One code, one thing it is for
///
/// There are exactly two actions here — create a code, or connect with somebody
/// else's — and neither asks what kind of thing the connection will carry. That
/// matches the Web, which has had one Create and one Enter for as long as the
/// screen has existed, and it matches the server, which mints one code for both.
///
/// It replaces four buttons that asked the user to answer a question the code
/// cannot hold: create a code *for messages* or *for files*, join *messages* or
/// *files*. The distinction was never about the code. It was about which of two
/// legacy signalling generations the connection would use if the peer turned out
/// not to speak `link/1` — a property of a stranger's client, guessed at by a
/// person who could not see it, minutes before the peer arrived. On a `link/1`
/// peer, which is every current client, the answer was discarded entirely.
///
/// So the question is gone and the decision is not: `LinkWorkspaceModel`
/// resolves the legacy lane from what this side actually staged and what the
/// peer actually announced (`legacyFallbackMode`), at the one moment both are
/// known. A peer that announces exact `link/1` is promoted to
/// `TransferLinkPane`, where the distinction never existed.
struct CrossNetworkConnectPane: View {
    @ObservedObject var fileModel: RealtimeSessionModel
    @ObservedObject var textModel: RealtimeTextSessionModel
    /// The unified `link/1`. A pairing room is watched for a peer that speaks it
    /// before either legacy model starts; see `watch(code:…)`.
    @ObservedObject var link: LinkWorkspaceModel
    /// The app-scoped staged batch, shared with LAN Transfer.
    @ObservedObject var selection: SelectionStore
    let gate: AccountGate
    /// Re-reads the parent session at activation time; `gate` belongs to the
    /// render that drew the button and can already be stale.
    let accessNow: () -> AccountAccess?
    /// `TransferSurfacePresentation.acceptsNewSession` inverted — true while any
    /// route, including LAN Transfer, owns or retains a session.
    let sessionLocked: Bool

    @EnvironmentObject private var navigation: AppNavigationModel
    @EnvironmentObject private var presence: TransferPresence
    @EnvironmentObject private var fileOpenRouting: AppFileOpenCoordinator

    @State private var actionError: String?

    private let route = AppDestination.pairingCode

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            // The same statement the LAN screen makes, and for the same reason:
            // a disabled control has to say why it is disabled.
            if sessionLocked {
                InlineMessage(.info, L10n.t(.transferBusyElsewhere))
                    .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
                    .accessibilityIdentifier("transfer-busy-elsewhere")
            }
            // Two ends and an encrypted middle, and no claim about what shape
            // the middle takes: this build cannot tell a direct connection from
            // a relayed one, so the rail says encrypted and stops. There is no
            // peer yet either, so no stop is marked reached or current — see
            // `PathRailPresentation.crossNetwork`.
            PathRail(stops: PathRailPresentation.crossNetwork())
            pairingCode
            if let actionError {
                InlineMessage(.failure, actionError)
                    .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
            }
        }
        .task(id: FileOpenAdoption(staged: fileOpenRouting.staged, busy: sessionLocked)) {
            adoptOpenedFiles()
        }
    }

    // MARK: - pairing code

    /// **The code first, the explanation last.**
    ///
    /// The card used to open with `crossNetwork.explain` — five lines about the
    /// rendezvous service — above the two verbs that actually mint a code. The
    /// destination's header now carries the one-sentence version of the same
    /// fact ("same network not required"), so the paragraph is a footnote to the
    /// controls rather than a preface to them. It keeps its identifier: a
    /// runtime check that this screen states its own premise must go on
    /// passing.
    private var pairingCode: some View {
        SectionCard(title: L10n.t(.workspacePairingHeading)) {
            VStack(alignment: .leading, spacing: Metrics.inner) {
                if case .allowed = gate {
                    createControls
                } else {
                    // No greyed Create button. The gate names what is true and
                    // renders the one action that resolves it.
                    CapabilityGateView(gate: gate,
                                       title: L10n.t(.gateCreateCodeTitle),
                                       body: L10n.t(.gateCreateCodeBody),
                                       onAccount: { navigation.selectAccount(intent: $0) })
                }
                Divider()
                joinControls
                // Inside this card, and last, for the same reason it is on the
                // LAN screen: the create hint above points at it, and what a
                // connection carries is not a third way to connect.
                TransferStagingSection(selection: selection, isBusy: { sessionLocked })
                // The peer is not known yet, so neither the unified-link claim
                // nor the legacy one-lane warning is true here. Once a peer
                // appears, capability negotiation selects the link pane or the
                // legacy session pane; each states its actual connection shape.
                Divider()
                Text(L10n.t(.crossNetworkExplain))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
                    .accessibilityIdentifier("cross-network-explain")
            }
        }
    }

    /// **One action, and it needs nothing staged.**
    ///
    /// Minting first is deliberate and is the Web's own ordering: the code is
    /// what the other person is waiting for, and picking files before it exists
    /// leaves the sender with nothing to do while six digits sit unclaimed. The
    /// staging section below is where the batch is assembled, during the wait,
    /// and everything staged there travels on the connection when the peer
    /// arrives.
    private var createControls: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(L10n.t(.workspaceCreatePairingCode)) { createCode() }
                .buttonStyle(.borderedProminent)
                .disabled(sessionLocked)
                .accessibilityIdentifier("cross-network-create-code")
            Text(L10n.t(.workspaceCreatePairingCodeHint))
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// One field, one verb, and both models kept in step by the one binding.
    ///
    /// Both are still written because either may end up running the connection —
    /// which of them does is `LinkWorkspaceModel`'s answer, arrived at once the
    /// peer is known — and a code typed into one of them only would leave the
    /// other about to join a different room.
    private var joinControls: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                TextField(L10n.t(.commonCode), text: normalizedJoinCode)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 140)
                    .accessibilityLabel(L10n.t(.commonCode))
                    .accessibilityIdentifier("pairing.joinCode")
                // **The one keyboard default on this surface.** Create and
                // connect sit on screen together, and two `.defaultAction`
                // buttons is an undefined Return that SwiftUI resolves without
                // telling anyone which it picked. Connect takes it: its whole
                // precondition is one field, so the default is inert until
                // Return can only mean one thing, and it is the keystroke that
                // naturally ends typing a code.
                Button(L10n.t(.workspaceConnectWithCode)) { join() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!fileModel.canJoin || sessionLocked)
                    .accessibilityIdentifier("cross-network-join-code")
            }
            InlineMessage(.info, L10n.t(.directJoinNoAccountNeeded))
        }
    }

    /// Normalize inside the one state transition, and write BOTH models.
    ///
    /// Following a raw write with `onChange` can overwrite a newer paste or fast
    /// keystroke; writing only one model would leave the two join verbs
    /// disagreeing about which code this device is about to join, which is
    /// exactly the drift the shared field exists to remove.
    private var normalizedJoinCode: Binding<String> {
        Binding(
            get: { fileModel.joinCode },
            set: {
                fileModel.updateJoinCode($0)
                textModel.updateJoinCode($0)
            }
        )
    }

    // MARK: - actions

    private func createCode() {
        guard !sessionLocked else { return }
        // Validate and stage BEFORE the picker disappears. A batch is optional
        // here — a code with nothing behind it is an ordinary way to start a
        // conversation — but one the user DID pick and that cannot be read is a
        // refusal they are owed now, rather than a code that turns out to carry
        // nothing.
        var staged: (sources: [PlaintextSource], metas: [FileMeta])?
        if !selection.isEmpty {
            guard let ready = stage() else { return }
            staged = ready
        }
        // Rendering an allowed gate and activating its button are different
        // turns. Refuse if sign-out, expiry or account replacement won between
        // them; never mint with the bearer captured by the earlier render.
        guard let access = accessNow() else {
            // Do not turn the user's accepted Create into a silent no-op: take
            // them to the one surface that explains the live account state.
            navigation.selectAccount(intent: .signIn)
            return
        }
        actionError = nil
        // **`.files` is the surface's provisional lane, not a kind of code.**
        // One of the two legacy models has to hold the minted code and its
        // expiry so `TransferSessionPane` can render them, and the file lane is
        // the one that can carry a staged batch. If the peer turns out to be a
        // legacy TEXT peer, `adoptLegacyRoom` moves the surface to the text lane
        // and retires this one — see `RelayiumApp`.
        guard presence.beginSession(route, mode: .files) else { return }
        Task { await mintAndWatch(token: access.token, staged: staged) }
    }

    private func join() {
        guard !sessionLocked else { return }
        // Snapshot before ownership: the field remains editable until the
        // asynchronous model start publishes state. Reading it inside the Task
        // could turn one valid click into a different or incomplete code.
        let code = fileModel.joinCode
        guard fileModel.canJoin else { return }
        actionError = nil
        guard presence.beginSession(route, mode: .files) else { return }
        // A joiner ANSWERS on the legacy wire, so `.responder` is what the
        // fallback must use. Watched first, exactly as a minted code is.
        //
        // Nothing is staged, and that is a rule rather than an omission:
        // `RealtimeSessionModel.join(role: .responder)` tears its previous state
        // down for exactly this reason — a batch picked for one device must not
        // be uploaded to whoever's code the user typed next. Files still travel
        // in this direction once the connection exists, from the link pane's own
        // Send file, where the user aims them at a peer they can see.
        watch(code: code, legacyRole: .responder, staged: nil) {
            await fileModel.join(code: code)
        }
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

    /// Mint the code, then WATCH the room it names for a peer that speaks
    /// `link/1` — and let the legacy path take the room if none does.
    ///
    /// Minting stays where it was, on the model whose state the code, the QR and
    /// the expiry are rendered from: `LinkWorkspaceModel` never mints, and while
    /// it is only watching, `hasSession` is false so that surface stays on
    /// screen unchanged.
    ///
    /// The creator is the offerer on the legacy wire, so `.initiator` is what
    /// the fallback must use. A LINK computes its own role from the two room
    /// ids and ignores this one.
    private func mintAndWatch(token: String,
                              staged: (sources: [PlaintextSource], metas: [FileMeta])?) async {
        await fileModel.mintCode(token: token)
        guard case let .showingCode(code, _) = fileModel.state else { return }
        watch(code: code, legacyRole: .initiator, staged: staged) {
            // The legacy fallback stages the batch itself — `onLegacyFallbackBatch`
            // hands it back — so nothing is staged before the room has answered.
            await fileModel.join(code: code, role: .initiator)
        }
    }

    /// Watch a code, or fall straight back when this build cannot.
    ///
    /// `legacyStart` is the path that shipped before the unified link, and it
    /// runs unchanged when the link model refuses the room — a client with no
    /// pairing socket factory, or one already holding a session. That is what
    /// keeps "pairing code works" true regardless of which half answers.
    ///
    /// It is the FILE lane, and it has to be: this branch is reached before any
    /// peer exists, so the evidence `legacyFallbackMode` weighs — a staged batch,
    /// an announced capability — is either absent or already says files. The file
    /// lane is also the one that carries bytes in either direction, so it is the
    /// answer that forecloses least.
    private func watch(code: String,
                       legacyRole: Role,
                       staged: (sources: [PlaintextSource], metas: [FileMeta])?,
                       legacyStart: @escaping () async -> Void) {
        let watched = link.watchPairingCode(code,
                                            legacyRole: legacyRole,
                                            files: staged?.metas ?? [],
                                            sources: staged?.sources ?? [])
        guard !watched else { return }
        if let staged {
            fileModel.stageSend(sources: staged.sources, metas: staged.metas)
        }
        Task { await legacyStart() }
    }

    /// Stage a batch the OS opened, if this surface is free to take it. Both
    /// transfer routes share the same app-scoped selection, so switching from
    /// LAN before adoption must not strand the user's Dock drop.
    private func adoptOpenedFiles() {
        guard let batch = fileOpenRouting.batch(
            forAnyOf: AppDestination.macTransferRoutes, busy: sessionLocked)
        else { return }
        selection.add(batch.urls)
        fileOpenRouting.consume(batch)
    }
}
