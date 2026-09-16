import SwiftUI
import RelayiumAppKit
import RelayiumKit

/// **Cross-network Transfer, before there is a peer**: mint a six-digit code, or
/// type in somebody else's. That is the whole screen.
///
/// One connection method, and the one it is: a pairing code needs no shared
/// network, which is the whole reason this is not a card under LAN Transfer. The
/// screen says so in its own words rather than leaving the sidebar row to carry
/// the distinction alone.
///
/// ## Two choices, and nothing that could carry work
///
/// **Create a pairing code** and **enter one**, with a single verb behind the
/// field. No staged batch, no drop zone, no picker, no composer, and — the part
/// that is a rule rather than an omission — nothing on this pane that could hold
/// a file or a message until a peer arrives. Pairing is one workspace, not a
/// choice between a Files lane and a Text lane, and a workspace with no
/// connection in it has nothing to offer yet. What the connection carries is
/// chosen inside it, once the user can see who they reached.
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
/// So the question is gone and the decision is not: a peer that announces exact
/// `link/1` is promoted to `TransferLinkPane`, where the distinction never
/// existed, and a peer that announces anything else is unsupported — stated on
/// this pane, terminally, with no session started for it.
///
/// ## And the code lives here, not on a session pane
///
/// Six digits with no peer yet is not a session. It used to be rendered by a
/// `RealtimeSessionModel` parked in `.showingCode`, which took the screen away
/// from the surface the user had just acted on and coupled retiring the code to
/// ending a session. The code is a `PairingCodeModel` now and it is drawn right
/// here, under the controls that minted it.
struct CrossNetworkConnectPane: View {
    /// This screen's module, and the only one it can reach.
    @ObservedObject var module: TransferModule
    let gate: AccountGate
    /// Re-reads the parent session at activation time; `gate` belongs to the
    /// render that drew the button and can already be stale.
    let accessNow: () -> AccountAccess?
    /// Mint a REPLACEMENT for a code whose deadline has passed.
    ///
    /// Supplied by `CrossNetworkTransferDestination`, which holds the account
    /// gate: minting reserves relay capacity billed to an account, so the
    /// decision belongs to the surface that can answer for it.
    let regenerate: () -> Void
    /// `TransferModule.acceptsNewSession` inverted — true while THIS module owns
    /// or retains a session, and never because LAN Transfer does. A user with a
    /// same-network connection open can mint a code here; that was the whole
    /// point of splitting the modules.
    let sessionLocked: Bool

    /// The six digits, and their deadline. Holds no socket and decides nothing.
    private var code: PairingCodeModel { module.code }
    /// The unified `link/1`. The pairing room is watched for a peer that speaks
    /// it from the moment a code exists; see `PairingCodeStart`.
    private var link: LinkWorkspaceModel { module.link }
    private var presence: TransferPresence { module.presence }

    @EnvironmentObject private var navigation: AppNavigationModel

    @State private var actionError: String?
    /// Whether Copy code just acknowledged a copy. View state only.
    @State private var codeCopied = false

    private let route = AppDestination.pairingCode

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.section) {
            // The same statement the LAN screen makes, and for the same reason:
            // a disabled control has to say why it is disabled. It describes
            // this module's own retained session — the other destination cannot
            // put this screen into that state any more.
            if sessionLocked {
                InlineMessage(.info, L10n.t(.transferBusyElsewhere))
                    .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
                    .accessibilityIdentifier("transfer-busy-elsewhere")
            }
            // No route rail: the hero says what this is — a code, from
            // anywhere — and the Security group below says what the relay can
            // and cannot see, without claiming a direct path.
            // **The peer turned up and could not speak `link/1`.**
            //
            // Above the controls, because it is the answer to the action the
            // user just took, and the controls below it are how they try again.
            // It is a statement about the OTHER device, not a failure of this
            // one, and it names what would actually fix it.
            if link.unsupportedPairingPeer {
                VStack(alignment: .leading, spacing: 8) {
                    InlineMessage(.warning, L10n.t(.errorRealtimeLegacyPeer))
                        .accessibilityIdentifier("pairing-peer-unsupported")
                    Button(L10n.t(.commonDismiss)) { link.dismissUnsupportedPairingPeer() }
                        .buttonStyle(.referenceSecondary)
                        .accessibilityIdentifier("pairing-peer-unsupported-dismiss")
                }
                .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
            }
            switch code.state {
            case let .showing(live, _):
                liveCode(live)
            case .minting:
                // **A named wait with an escape**, not the create controls
                // greyed out. The mint is a real round trip; showing the button
                // that started it, disabled, says "you cannot do this" when the
                // truth is "it is happening".
                PairingHero {
                    ProgressView(L10n.t(.directCreatingCode)).controlSize(.small)
                    Button(L10n.t(.commonCancel)) { module.cancelPairingCode() }
                        .buttonStyle(.referenceSecondary)
                        .accessibilityIdentifier("pairing-code-minting-cancel")
                }
            case .idle, .failed:
                pairingCode
                joinSection
            }
            if case let .failed(message) = code.state {
                // **A failed mint needs a way out of itself.**
                //
                // `.failed` is deliberately ACTIVE — the message must survive the
                // app-scoped liveness observer, or it would be taken off screen
                // before it could be read — and that is what held the module's
                // surface. With the surface held, `sessionLocked` disabled BOTH
                // Create and Join underneath, so a single failed mint left
                // Cross-network transfer permanently unusable for the life of
                // the process, with the reason showing and nothing to press.
                //
                // Dismissing is the whole recovery: it returns the code to idle,
                // leaves whatever room was opened, and releases the surface —
                // after which the controls below are live again.
                VStack(alignment: .leading, spacing: 8) {
                    InlineMessage(.failure, message)
                        .accessibilityIdentifier("pairing-code-failed")
                    Button(L10n.t(.commonDismiss)) { module.cancelPairingCode() }
                        .buttonStyle(.referenceSecondary)
                        .accessibilityIdentifier("pairing-code-failed-dismiss")
                }
                .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
            }
            if let actionError {
                InlineMessage(.failure, actionError)
                    .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
            }
        }
        // **No Finder/Dock adoption here any more**, for the reason
        // `LanConnectPane` records: this pane stages nothing before a connection
        // exists, so a batch the OS opened has nowhere to land on it, and a pane
        // that quietly took one would be a pre-connect staging side door.
    }

    // MARK: - a live code

    /// **The code, its countdown, and the wait — on the screen that minted it.**
    ///
    /// Moved here from the deleted session pane, and
    /// unchanged in every respect the user can see. It was never a session: it
    /// is what this screen shows between "Create" and a peer arriving, and
    /// drawing it here is what stops a minted code from taking the user
    /// somewhere else and then bringing them back.
    ///
    /// `TimelineView(.periodic)` rather than a `Timer` and a `@State`: the view
    /// is a function of the current second, so there is no stored clock to fall
    /// out of step with the deadline, nothing to invalidate when this pane is
    /// torn down, and — the part that matters — the expiry branch is chosen by
    /// the same `PairingCodeExpiry` answer that hides the handoff, so the
    /// countdown and the controls cannot disagree about whether the code is
    /// alive. `PairingCodeExpiryTests` pins that answer on both sides of the
    /// second it changes.
    ///
    /// The digits sit OUTSIDE the timeline deliberately: an expired code stays
    /// legible, because the person looking at it is trying to work out whether
    /// the number they just read out was the right one.
    private func liveCode(_ live: String) -> some View {
        PairingHero {
            // Tiles and actions on one line when they fit, the actions under
            // the tiles when they do not. The tiles themselves never wrap.
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: 10) {
                    SecurityCodeText(code: live, style: .tiles)
                    Spacer(minLength: Metrics.inner)
                    codeActions(live)
                }
                VStack(alignment: .leading, spacing: Metrics.inner) {
                    SecurityCodeText(code: live, style: .tiles)
                    codeActions(live)
                }
            }
            TimelineView(.periodic(from: .now, by: 1)) { tick in
                let deadline = PairingCodeExpiry.presentation(
                    expiresAt: expiresAt, now: tick.date)
                VStack(alignment: .leading, spacing: 6) {
                    if let countdown = deadline.countdown {
                        Text(L10n.detail([L10n.t(.pairingCodeExpiresIn, [countdown]),
                                          L10n.t(.pairingPassItOn)]))
                            .font(.callout)
                            .foregroundStyle(Palette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                            // The digits do not reflow as they tick, which
                            // is the one thing a proportional face gets
                            // wrong here.
                            .monospacedDigit()
                            // LAST, so the identifier lands on the text
                            // element itself rather than on the wrapper
                            // `.monospacedDigit()` introduces.
                            .accessibilityIdentifier("pairing-code-countdown")
                    } else {
                        Text(L10n.t(.directGiveCode))
                            .font(.callout)
                            .foregroundStyle(Palette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Text(L10n.t(.pairingCodeExpiryNote))
                        .font(.subheadline)
                        .foregroundStyle(Palette.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("pairing-code-expiry-note")
                    if deadline.isUsable {
                        Color.clear.frame(height: 4).accessibilityHidden(true)
                        // **The wait and its escape live in the handoff card,
                        // and nowhere else on this page.** A second copy made
                        // two identically labelled elements and an ambiguous
                        // click for the offline suite.
                        if let joinURL = transferPairingJoinURL(code: live) {
                            PairingCodeHandoffView(url: joinURL,
                                                   cancel: { module.cancelPairingCode() })
                        }
                    } else {
                        expiredCode
                    }
                }
            }
        }
    }

    /// **New code and Copy code, and both are real.**
    ///
    /// New code mints a replacement through the same account-gated path an
    /// expired code uses, so it is offered only where minting can work and only
    /// for a code this Mac minted — a code typed in from somebody else is not
    /// this Mac's to replace. Copy code writes the six digits.
    @ViewBuilder
    private func codeActions(_ live: String) -> some View {
        // Read against the same deadline as the countdown: an expired code
        // offers its replacement in the expired notice below, and a dead code
        // is not something to copy, so neither action outlives the deadline.
        TimelineView(.periodic(from: .now, by: 1)) { tick in
            if PairingCodeExpiry.presentation(expiresAt: expiresAt, now: tick.date).isUsable {
                HStack(spacing: 7) {
                    if case .allowed = gate, expiresAt > 0 {
                        Button(L10n.t(.pairingNewCodeShort)) { regenerate() }
                            .buttonStyle(.referenceSecondary)
                            .accessibilityIdentifier("pairing-code-new")
                    }
                    Button(L10n.t(codeCopied ? .commonCopied : .pairingCopyCode)) { copyCode(live) }
                        .buttonStyle(.referencePrimary)
                        .accessibilityIdentifier("pairing-code-copy")
                }
            }
        }
    }

    private func copyCode(_ live: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(live, forType: .string)
        codeCopied = true
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_400_000_000)
            codeCopied = false
        }
    }

    /// The deadline the mint returned, or `0` for a code this device only
    /// typed — which `PairingCodeExpiry` already defines as usable and
    /// uncounted, because the joiner was never told when it dies.
    private var expiresAt: Int64 {
        guard case let .showing(_, expiresAt) = code.state else { return 0 }
        return expiresAt
    }

    /// **What an expired code offers instead of a link nobody can open.**
    ///
    /// The join URL, the QR and the wait all go, because every one of them is an
    /// invitation to use a code the server refuses — the QR especially, since
    /// scanning it produces an error on a phone with no explanation anywhere
    /// near this screen.
    ///
    /// What replaces them is one press that mints a fresh code, not a route back
    /// to the screen that mints. Sending the user elsewhere to press Create
    /// would be two steps to recover from a deadline the product chose.
    @ViewBuilder
    private var expiredCode: some View {
        VStack(alignment: .leading, spacing: 8) {
            InlineMessage(.warning, L10n.t(.pairingCodeExpired))
                .accessibilityIdentifier("pairing-code-expired")
            HStack(spacing: 8) {
                // Offered only where it can work. Joining is account-free but
                // MINTING is not, so a signed-out user gets Cancel alone rather
                // than a button whose only outcome is a trip to the account
                // screen.
                if case .allowed = gate {
                    Button(L10n.t(.pairingNewCode)) { regenerate() }
                        .buttonStyle(.referencePrimary)
                        .accessibilityIdentifier("pairing-code-regenerate")
                }
                Button(L10n.t(.commonCancel)) { module.cancelPairingCode() }
                    .buttonStyle(.referenceSecondary)
                    .accessibilityIdentifier("pairing-code-expired-cancel")
            }
        }
    }

    // MARK: - pairing code

    /// **The code first, the explanation last**, in the reference's hero.
    ///
    /// The toolbar's subtitle carries the one-line version of the premise
    /// ("anywhere · six-digit code"), so the paragraph is a footnote to the
    /// controls rather than a preface to them. It keeps its identifier: a
    /// runtime check that this screen states its own premise must go on
    /// passing.
    private var pairingCode: some View {
        PairingHero {
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
            Text(L10n.t(.crossNetworkExplain))
                .font(.callout)
                .foregroundStyle(Palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
                .accessibilityIdentifier("cross-network-explain")
        }
    }

    /// **One action, and there is nothing it could need.**
    ///
    /// The code is what the other person is waiting for, and it is the first and
    /// only thing this half of the screen produces. What the connection carries
    /// is chosen once it exists, in the workspace this code opens.
    private var createControls: some View {
        HStack(alignment: .center, spacing: Metrics.inner) {
            Text(L10n.t(.workspaceCreatePairingCodeHint))
                .font(.callout)
                .foregroundStyle(Palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: Metrics.tight)
            Button(L10n.t(.workspaceCreatePairingCode)) { createCode() }
                .buttonStyle(.referencePrimary)
                .disabled(sessionLocked)
                .accessibilityIdentifier("cross-network-create-code")
        }
    }

    /// The join half, as its own group: it needs no account and is rendered
    /// and enabled identically signed out, outside the gate above.
    private var joinSection: some View {
        SectionCard(title: L10n.t(.workspaceJoinHeading), rows: true) {
            CardRows {
                CardBlockRow {
                    joinControls
                }
            }
        }
    }

    /// One field, one verb, and one place the typed code lives.
    private var joinControls: some View {
        HStack(alignment: .center, spacing: 10) {
            TextField(L10n.t(.pairingCodePlaceholder), text: normalizedJoinCode)
                .textFieldStyle(.plain)
                .font(.body.monospaced())
                .padding(.horizontal, 10)
                .frame(width: 140)
                .frame(minHeight: 26)
                .background(RoundedRectangle(cornerRadius: Metrics.buttonCorner)
                    .fill(Palette.field))
                .overlay(RoundedRectangle(cornerRadius: Metrics.buttonCorner)
                    .strokeBorder(Palette.buttonBorder, lineWidth: 1))
                .accessibilityLabel(L10n.t(.commonCode))
                .accessibilityIdentifier("pairing.joinCode")
            Text(L10n.t(.directJoinNoAccountShort))
                .font(.subheadline)
                .foregroundStyle(Palette.textTertiary)
                .fixedSize(horizontal: false, vertical: true)
                .help(L10n.t(.directJoinNoAccountNeeded))
            Spacer(minLength: 0)
            // **The one keyboard default on this surface.** Create and
            // connect sit on screen together, and two `.defaultAction`
            // buttons is an undefined Return. Connect takes it: its whole
            // precondition is one field, so the default is inert until
            // Return can only mean one thing.
            Button(L10n.t(.workspaceConnectWithCode)) { join() }
                .buttonStyle(.referencePrimary)
                .keyboardShortcut(.defaultAction)
                .disabled(!code.canJoin || sessionLocked)
                .accessibilityIdentifier("cross-network-join-code")
        }
    }

    /// Normalize inside the one state transition.
    ///
    /// Following a raw write with `onChange` can overwrite a newer paste or a
    /// fast keystroke, which is why the filtering happens in the setter rather
    /// than behind it.
    private var normalizedJoinCode: Binding<String> {
        Binding(get: { code.joinCode }, set: { code.updateJoinCode($0) })
    }

    // MARK: - actions

    private func createCode() {
        guard !sessionLocked else { return }
        // Nothing is staged and nothing can be: this pane has no picker, so a
        // minted code carries the connection and only the connection.
        //
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
        link.dismissUnsupportedPairingPeer()
        // **No `mode:`, because there is no lane to choose.** A pairing code
        // names a rendezvous; what the connection carries is decided inside the
        // link it opens, and one link carries both. The claim that used to say
        // `.files` was picking which legacy model would hold the digits.
        guard presence.beginSession(route) else { return }
        Task { await mintAndWatch(token: access.token) }
    }

    private func join() {
        guard !sessionLocked else { return }
        // Snapshot before ownership: the field remains editable until the watch
        // publishes state. Reading it inside a later turn could turn one valid
        // click into a different or incomplete code.
        let typed = code.joinCode
        guard code.canJoin else { return }
        actionError = nil
        link.dismissUnsupportedPairingPeer()
        guard presence.beginSession(route) else { return }
        PairingCodeStart(module: module).joinAndWatch(code: typed)
    }

    /// Mint the code, then WATCH the room it names for a peer that speaks
    /// `link/1`.
    ///
    /// Minting stays on `PairingCodeModel`: `LinkWorkspaceModel` never mints,
    /// and while it is only watching, `hasSession` is false — so this surface
    /// stays on screen with the code drawn on it, which is exactly where the
    /// person reading the digits out needs it to be.
    ///
    /// The two steps live in `PairingCodeStart` because the expired-code branch
    /// above mints a REPLACEMENT and must not grow a second copy of them: a copy
    /// is how the two would come to disagree about whether the room is watched
    /// at all.
    private func mintAndWatch(token: String) async {
        await PairingCodeStart(module: module).createAndWatch(token: token)
    }
}

/// The pairing code's hero: the reference's violet-washed card with its
/// capitalised caption, holding whichever phase the code is in.
private struct PairingHero<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(L10n.t(.workspacePairingHeading))
                .font(.callout.weight(.semibold))
                .textCase(.uppercase)
                .foregroundStyle(Palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Metrics.heroPadding)
        .background(HeroSurface())
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L10n.t(.workspacePairingHeading))
    }
}
