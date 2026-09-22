import SwiftUI
import UIKit
import UniformTypeIdentifiers
import RelayiumAppKit
import RelayiumKit

private struct PairingJoinLinkView: View {
    let url: URL
    @State private var copied = false

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        // Level two of the card that holds the code: the same six digits, in the
        // form a browser can open. It was a hand-rolled semibold footnote over a
        // stack with a literal `8` — the exact thing `OpenSection` exists to be,
        // and now it announces as a group to VoiceOver rather than as three
        // controls loose among the code, the expiry and Cancel.
        OpenSection(L10n.t(.pairingJoinLink)) {
            Text(url.absoluteString)
                .font(.footnote.monospaced())
                // The link is a handoff result, not decorative metadata. Let
                // it wrap so the user can inspect the complete host, mode and
                // code before copying or sharing it.
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)

            // Full width and `.large`, matching the stored link's own handoff on
            // the Send tab. Two natural-width capsules were under the 44pt floor
            // on the axis a thumb actually misses, and at accessibility content
            // sizes the second one left the row entirely.
            //
            // **And one per row once two of them no longer fit.** Half of a 375pt
            // iPhone's content width is about 150 points, and at Accessibility 3
            // the word beside its symbol is wider than that: on a real SE build
            // these read "Co / py" and "Sh / are", broken mid-word, on the two
            // controls the entire handoff depends on. The threshold is every
            // accessibility size rather than the one that was photographed,
            // because Accessibility 1 and 2 sit inside the same margin. Same
            // buttons, same order, same styles; only the axis changes, and it
            // changes with the reader's own setting, exactly as the path rail
            // above it turns.
            Group {
                if typeSize.isAccessibilitySize {
                    VStack(spacing: Metrics.tight) { copyButton; shareButton }
                } else {
                    HStack(spacing: Metrics.tight) { copyButton; shareButton }
                }
            }
            .borderedAction()
            .controlSize(.large)

            if copied {
                Label(L10n.t(.pairingLinkCopied), systemImage: "checkmark")
                    .font(.footnote)
                    .foregroundStyle(Palette.supportingLabel)
            }
        }
        // This view can retain its structural identity if a later generated
        // code replaces the URL. Never let yesterday's Copy feedback certify
        // a link that has not been copied.
        .onChange(of: url) { _ in copied = false }
    }

    /// The one pasteboard write in this whole file, and it is inside the action
    /// of a button the user pressed. Nothing here ever reads the pasteboard.
    private var copyButton: some View {
        Button {
            UIPasteboard.general.string = url.absoluteString
            copied = true
        } label: {
            Label(L10n.t(.commonCopy), systemImage: "doc.on.doc")
                .frame(maxWidth: .infinity)
        }
    }

    private var shareButton: some View {
        ShareLink(item: url) {
            Label(L10n.t(.commonShare), systemImage: "square.and.arrow.up")
                .frame(maxWidth: .infinity)
        }
    }
}

/// A six-digit field whose visible UIKit value is settled before SwiftUI is
/// notified. Re-publishing an ObservableObject for every digit can rebuild a
/// SwiftUI TextField while the keyboard is still delivering one paste or burst
/// of keystrokes; the remaining input then lands on stale editing state.
private struct PairingCodeInput: UIViewRepresentable {
    @Binding var text: String
    let label: String

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeUIView(context: Context) -> UITextField {
        let field = UITextField()
        field.delegate = context.coordinator
        field.borderStyle = .roundedRect
        field.keyboardType = .numberPad
        field.textContentType = .oneTimeCode
        field.font = .monospacedDigitSystemFont(
            ofSize: UIFont.preferredFont(forTextStyle: .title3).pointSize,
            weight: .regular
        )
        field.adjustsFontForContentSizeCategory = true
        field.accessibilityLabel = label
        return field
    }

    func updateUIView(_ field: UITextField, context: Context) {
        context.coordinator.parent = self
        guard field.text != text else { return }
        field.text = text
        if let end = field.position(from: field.beginningOfDocument,
                                    offset: text.utf16.count) {
            field.selectedTextRange = field.textRange(from: end, to: end)
        }
    }

    final class Coordinator: NSObject, UITextFieldDelegate {
        var parent: PairingCodeInput

        init(parent: PairingCodeInput) { self.parent = parent }

        func textField(_ field: UITextField,
                       shouldChangeCharactersIn range: NSRange,
                       replacementString replacement: String) -> Bool {
            let current = field.text ?? ""
            guard let editRange = Range(range, in: current) else { return false }
            let raw = current.replacingCharacters(in: editRange, with: replacement)
            let normalized = normalizedPairingCode(raw)

            // Set the live control first. SwiftUI may synchronously publish and
            // render when the binding changes, but it can only reconcile to the
            // value already displayed here; no remaining input event is lost.
            field.text = normalized
            parent.text = normalized

            let rawPrefixEnd = min(range.location + replacement.utf16.count,
                                   raw.utf16.count)
            let rawPrefix = String(decoding: raw.utf16.prefix(rawPrefixEnd), as: UTF16.self)
            let caretOffset = normalizedPairingCode(rawPrefix).utf16.count
            if let caret = field.position(from: field.beginningOfDocument,
                                          offset: caretOffset) {
                field.selectedTextRange = field.textRange(from: caret, to: caret)
            }
            return false
        }
    }
}

/// Cross-network transfer: six digits, then ONE connection that carries files
/// and messages.
///
/// **Connect first.** This screen used to ask "Files or Text?" and stage a batch
/// before a code existed, and then ran one of two single-lane legacy sessions.
/// A code carries no type, so that question asked the user to guess what a
/// stranger's client had chosen — and the lanes it chose between stopped
/// reaching anybody: macOS and the Web refuse a pairing peer that does not
/// announce `link/1`, so iOS `0.3.2` was told by an up-to-date Mac that it was
/// "running an older version". The rule is now the one macOS, the Web and
/// Android already follow: create or enter a code, the room is watched as a
/// `link/1` client, and what the connection carries is chosen inside the
/// workspace once the user can see who they reached.
///
/// Two things about this screen are structural rather than stylistic.
///
/// **The halves are gated differently, and that is a server-side fact.**
/// *Creating* a code reserves relay capacity billed to whoever created it, so it
/// needs an account; *joining* a code somebody else created reserves nothing and
/// reaches the transport with no credential at all. So the create half renders
/// an `AccountGate` when there is no account, and the join field beside it is
/// rendered and enabled exactly as it is when signed in. That is why this view
/// takes the gate rather than a bearer string.
///
/// **Nothing about the session lives here.** The module — its code, its link and
/// its presence — the workspace's file selection and the foreground lifecycle
/// are all app-scoped and handed in. A `TabView` tears an off-screen tab down,
/// and a view that owned any of them would end a live connection on a tab
/// switch.
struct DirectView: View {
    /// The Cross-network module: `code`, the `link` watching its room, and the
    /// `presence` only this route can claim. Observed as one object — it relays
    /// all three — so this view redraws on exactly the edges they publish.
    @ObservedObject var module: TransferModule
    /// The workspace's own post-connect picker. Nothing is chosen before a
    /// connection exists, so this is never read outside the link pane.
    @ObservedObject var selection: DirectSendSelection
    /// The one owner of the receive folder. A link can be handed files by the
    /// peer at any moment, so the destination is resolved and installed HERE,
    /// before a room is watched, and the link reads it back from this model —
    /// one resolver, read rather than repeated.
    let receiving: RealtimeSessionModel
    @ObservedObject var foreground: ForegroundSessionCoordinator
    /// Tab selections handed down as closures, the same shape `SendView` uses
    /// for the account — which is what lets `RootView` stay ignorant of both.
    let onOpenSend: () -> Void
    let onOpenAccount: () -> Void

    @EnvironmentObject private var session: AccountSession

    @State private var isScanning = false
    /// Set by a scan that filled the field, and shown only while the field still
    /// holds exactly what the scan put there.
    @State private var scanFilledCode: String?
    /// A failure to resolve the app's own receive folder. It happens before any
    /// model is involved, so it has no state case to live in, and it is cleared
    /// whenever a new attempt starts so it cannot outlive its cause.
    @State private var destinationError: String?

    private var code: PairingCodeModel { module.code }
    private var link: LinkWorkspaceModel { module.link }

    private var gate: AccountGate {
        AccountGate.from(session.state, bearer: session.bearerToken)
    }

    /// Anything live or retained in this module: a code being minted or shown, a
    /// refusal or failure not yet dismissed, or a link that still holds a
    /// session. Derived on every render rather than cached.
    private var isLocked: Bool {
        module.presence.owner != nil || module.sessionIsLiveOrRetained
    }

    var body: some View {
        NavigationStack {
            DestinationPage {
                // Above every pane: the app can be backgrounded out of a link or
                // out of a waiting code, and the notice is readable only after
                // it is back on screen.
                if let notice = foreground.interruption { interruption(notice) }
                switch module.pane {
                case .link:
                    NearbyLinkWorkspaceView(link: link, selection: selection)
                case .connect:
                    connectPhase
                }
            }
            .navigationTitle(L10n.t(.navCrossNetworkShort))
            // **Always inline.** "Cross-network" is the widest destination name,
            // and a one-line large title truncates it at accessibility text sizes.
            // Switching to inline only at those sizes moved the page 52 pt when the
            // size changed, and the bar did not return to a large title afterwards.
            // One mode keeps the complete title and a stable layout at every
            // Dynamic Type size. History: docs/ios-ui-alignment.md.
            .navigationBarTitleDisplayMode(.inline)
        }
        // On the `NavigationStack`, so which arm of the state switch is rendered
        // must not decide whether the sheet can return.
        .sheet(isPresented: $isScanning) {
            PairingScannerView { result in
                applyScan(result)
                isScanning = false
            }
        }
    }

    // MARK: - the connect phase

    /// Everything before a peer: the two ways to start, a code that is waiting,
    /// and whatever the last attempt left to read.
    @ViewBuilder
    private var connectPhase: some View {
        // Only while there is still a choice to make. It says what a
        // cross-network transfer IS, which is advice about a decision — so once
        // a code is being minted or is waiting for a peer it is preamble above
        // the thing the user is actually watching.
        if !isLocked { positioning }

        // **The peer turned up and could not speak `link/1`.** Above the
        // controls, because it is the answer to the action the user just took
        // and the controls below are how they try again. It is a statement about
        // the OTHER device — after `0.4.0` that can only be an older build — and
        // it names what would fix it.
        if link.unsupportedPairingPeer {
            VStack(alignment: .leading, spacing: Metrics.tight) {
                failureLine(L10n.t(link.pairingPeerIsCli ? .errorRealtimeCliPeer : .errorRealtimeLegacyPeer))
                    .accessibilityIdentifier("pairing-peer-unsupported")
                Button(L10n.t(.commonDismiss)) { module.cancelPairingCode() }
                    .textAction()
                    .accessibilityIdentifier("pairing-peer-unsupported-dismiss")
            }
        }

        switch code.state {
        case let .showing(live, expiresAt):
            liveCode(live, expiresAt: expiresAt)
        case .minting:
            SectionCard(L10n.t(.workspaceCreatePairingCode)) {
                ProgressView { Text(L10n.t(.directCreatingCode)) }
                Button(L10n.t(.commonCancel)) { module.cancelPairingCode() }
                    .borderedAction()
                    .controlSize(.large)
                    .accessibilityIdentifier("pairing-code-minting-cancel")
            }
        case .idle, .failed:
            createCard
            joinCard
        }

        if case let .failed(message) = code.state {
            VStack(alignment: .leading, spacing: Metrics.tight) {
                failureLine(message)
                    .accessibilityIdentifier("pairing-code-failed")
                // `cancelPairingCode`, not a bare reset: a failed mint still
                // holds this module's surface, and giving it back is what makes
                // the controls above usable again.
                Button(L10n.t(.commonDismiss)) { module.cancelPairingCode() }
                    .textAction()
                    .accessibilityIdentifier("pairing-code-failed-dismiss")
            }
        }
        if let destinationError { failureLine(destinationError) }

        if !isLocked { largeFileRoute }
        VerificationSettingCard(isLocked: isLocked)
    }

    /// **What a cross-network transfer is, stated once, above both halves that
    /// use it.**
    ///
    /// Outside a card and above the two task cards, because it belongs to
    /// neither of them: create and join are the two ends of the SAME route. The
    /// rail is `iosPairingCode` — never a Mac rail, which says "This Mac".
    private var positioning: some View {
        StatusHero(symbol: "globe", // nonlocalized: SF Symbol name
                   detail: L10n.t(.navPairingCodeSubtitle),
                   isActive: true) {
            PathRail(stops: PathRailPresentation.iosPairingCode())
        }
    }

    // MARK: - create (needs an account)

    /// One control, and no question before it. There is no Files/Text picker and
    /// no chooser: a code carries no type and the link carries both lanes, so
    /// the hint says what happens AFTER connecting instead of asking the user to
    /// decide it now.
    private var createCard: some View {
        SectionCard(L10n.t(.workspaceCreatePairingCode)) {
            if case .allowed = gate {
                Text(L10n.t(.workspaceCreatePairingCodeHint))
                    .font(.callout)
                    .foregroundStyle(Palette.supportingLabel)
                    .fixedSize(horizontal: false, vertical: true)
                Button { createCode() } label: {
                    Text(L10n.t(.directCreateCode)).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                // The exact negation of the `acceptsNewSession` guard the action
                // re-asks at the instant of use. Drawn ONLY for a module that
                // holds work with these controls still on screen — a failed mint
                // nobody has dismissed — where it was a live-looking button that
                // silently did nothing. macOS refuses the same state visibly.
                .disabled(isLocked)
                .accessibilityIdentifier("pairing-code-create")
            } else {
                capabilityGate
            }
        }
    }

    /// No greyed Create button. Each gate state names what is true and offers
    /// the action that can resolve THAT state, which on this platform lives in
    /// the Account tab — never a second account form grown here.
    ///
    /// Keeping the switch exhaustive is the reason this view takes an
    /// `AccountGate` at all. Flattening loading, an unverified address, an
    /// outage and a frozen account into “sign in” would give four users the
    /// wrong diagnosis and the wrong next action.
    @ViewBuilder
    private var capabilityGate: some View {
        VStack(alignment: .leading, spacing: Metrics.inner) {
            switch gate {
            case .allowed:
                EmptyView()

            case .loading:
                ProgressView { Text(L10n.t(.accountRestoring)) }

            case .signInRequired:
                Text(L10n.t(.gateCreateCodeTitle)).font(.subheadline.weight(.semibold))
                Text(L10n.t(.gateCreateCodeBody))
                    .font(.callout)
                    .foregroundStyle(Palette.supportingLabel)
                    .fixedSize(horizontal: false, vertical: true)
                openAccountButton

            case let .unavailable(message):
                failureLine(message)
                Button(L10n.t(.commonTryAgain)) { Task { await session.refresh() } }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)

            case let .verifyEmail(email):
                Text(L10n.t(.contentCheckEmailTitle)).font(.subheadline.weight(.semibold))
                Text(L10n.t(.contentCheckEmailBody, [L10n.token(email)]))
                    .font(.callout)
                    .foregroundStyle(Palette.supportingLabel)
                    .fixedSize(horizontal: false, vertical: true)
                openAccountButton

            case let .pendingDeletion(purgeAfter, _):
                Text(L10n.t(.contentPendingDeletionTitle))
                    .font(.subheadline.weight(.semibold))
                Text(L10n.t(.contentPendingDeletionBody, [
                    L10n.date(Date(timeIntervalSince1970: TimeInterval(purgeAfter)),
                              dateStyle: .medium, timeStyle: .none),
                ]))
                    .font(.callout)
                    .foregroundStyle(Palette.supportingLabel)
                    .fixedSize(horizontal: false, vertical: true)
                openAccountButton
            }
        }
    }

    private var openAccountButton: some View {
        Button(action: onOpenAccount) {
            Text(L10n.t(.gateOpenAccount)).frame(maxWidth: .infinity)
        }
        .borderedAction()
        .controlSize(.large)
    }

    // MARK: - the code, and the wait

    /// **The code to read onto the other device, and the wait.**
    ///
    /// One card, and the order is the handoff: the code, when it dies, the same
    /// code as a link, the wait, and the way out. A JOINED code is the same card
    /// with the halves that belong to a creator removed — `PairingCodeModel`
    /// adopts typed digits with no deadline, and a joiner has nobody to hand the
    /// code or its link on to.
    ///
    /// The deadline is a live countdown and an expired code says so and offers a
    /// replacement, the rule macOS follows. A wall-clock "expires 14:32" left a
    /// dead code on screen looking exactly like a live one.
    private func liveCode(_ live: String, expiresAt: Int64) -> some View {
        let created = expiresAt > 0
        return SectionCard(L10n.t(created ? .directGiveCode : .workspaceJoinHeading)) {
            PairingCodeText(code: live, style: .pairing)
            TimelineView(.periodic(from: .now, by: 1)) { tick in
                let deadline = PairingCodeExpiry.presentation(expiresAt: expiresAt,
                                                              now: tick.date)
                VStack(alignment: .leading, spacing: Metrics.inner) {
                    if let countdown = deadline.countdown {
                        Text(L10n.t(.pairingCodeExpiresIn, [countdown]))
                            .font(.footnote)
                            .foregroundStyle(Palette.supportingLabel)
                            .monospacedDigit()
                            .accessibilityIdentifier("pairing-code-countdown")
                    }
                    if deadline.isUsable {
                        if created {
                            Text(L10n.t(.pairingCodeExpiryNote))
                                .font(.footnote)
                                .foregroundStyle(Palette.supportingLabel)
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityIdentifier("pairing-code-expiry-note")
                            // No mode in the link: the code names a room, and
                            // the room carries both lanes.
                            if let joinURL = transferPairingJoinURL(code: live) {
                                PairingJoinLinkView(url: joinURL)
                            }
                        }
                        ProgressView { Text(L10n.t(.directWaitingForDevice)) }
                        Text(L10n.t(.directKeepBothOpen))
                            .font(.footnote)
                            .foregroundStyle(Palette.supportingLabel)
                            .fixedSize(horizontal: false, vertical: true)
                        Button(L10n.t(.commonCancel)) { module.cancelPairingCode() }
                            .borderedAction()
                            .controlSize(.large)
                            .accessibilityIdentifier("pairing-code-cancel")
                    } else {
                        expiredCode
                    }
                }
            }
        }
    }

    /// An expired code, and the two ways out of it. Regenerating needs the same
    /// account creating did, so the offer is drawn only for a gate that would
    /// honour it.
    @ViewBuilder
    private var expiredCode: some View {
        InlineMessage(.warning, L10n.t(.pairingCodeExpired))
            .accessibilityIdentifier("pairing-code-expired")
        if case .allowed = gate {
            Button { regenerate() } label: {
                Text(L10n.t(.pairingNewCode)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .accessibilityIdentifier("pairing-code-regenerate")
        }
        Button(L10n.t(.commonCancel)) { module.cancelPairingCode() }
            .borderedAction()
            .controlSize(.large)
            .accessibilityIdentifier("pairing-code-expired-cancel")
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

    /// The honest limit, and the way out of it.
    ///
    /// Shown only while nothing is running: mid-transfer it would be advice
    /// about a decision already made, next to a button that would take the user
    /// off the screen showing their own transfer.
    private var largeFileRoute: some View {
        // A card, and a `.borderedAction()` button inside it. It is a real offer
        // with a real destination, so it gets the same boundary the two tasks
        // above it have — but it never takes the prominent fill away from the
        // task the user came for.
        SectionCard(L10n.t(.directLargeFilesTitle)) {
            Text(L10n.t(.directLargeFilesBody))
                .font(.callout)
                .foregroundStyle(Palette.supportingLabel)
                .fixedSize(horizontal: false, vertical: true)
            Button(action: onOpenSend) {
                Text(L10n.t(.directOpenSend)).frame(maxWidth: .infinity)
            }
            .borderedAction()
            .controlSize(.large)
        }
    }

    /// A failure line. The icon carries the label rather than sitting beside an
    /// unlabelled image, so VoiceOver reads the sentence and not "image".
    private func failureLine(_ message: String) -> some View {
        InlineMessage(.warning, message)
    }

    // MARK: - join (needs nothing)

    /// The ordinary signed-out card already says joining needs no account. The
    /// other gate states describe loading, an outage, verification or deletion
    /// instead, so they still need the one-line explanation beside Join — as
    /// does a ready-account user.
    private var shouldExplainAnonymousJoin: Bool {
        switch gate {
        case .signInRequired: return false
        case .allowed, .loading, .unavailable, .verifyEmail, .pendingDeletion: return true
        }
    }

    /// One join field, normalized in the binding setter before state changes. A
    /// second asynchronous `onChange` write can race fast typing, paste, or
    /// one-time-code AutoFill and overwrite newer digits with an older partial
    /// value.
    ///
    /// Nothing in here reads the account. That is the point of the whole
    /// destination and it is enforced by `IOSSurfaceGuardTests`.
    private var joinCard: some View {
        let typed = Binding(
            get: { code.joinCode },
            set: { code.updateJoinCode($0) }
        )
        // Its own card, beside the create card and never inside it. The two are
        // gated differently and that asymmetry is the destination's whole point,
        // so a signed-out user sees an account card above a Join card that
        // works, rather than one screen that appears to need signing in.
        return SectionCard(L10n.t(.workspaceJoinHeading)) {
            PairingCodeInput(text: typed, label: L10n.t(.commonCode))
            // **The camera is offered beside the field, never instead of it.**
            // It is the tap that separates app launch from the system camera
            // prompt, which is why nothing above it touches `AVCaptureDevice`.
            Button { isScanning = true } label: {
                Label(L10n.t(.pairingScanCode), systemImage: "qrcode.viewfinder")
                    .frame(maxWidth: .infinity)
            }
            .borderedAction()
            .controlSize(.large)
            if let scanFilledCode, code.joinCode == scanFilledCode {
                InlineMessage(.info, L10n.t(.pairingScanFilled))
            }
            Button { join() } label: {
                Text(L10n.t(.workspaceConnectWithCode)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            // Two independent refusals: an incomplete code, and a module that
            // is still holding work. Only the first hides the control — an
            // unreachable field is not worth announcing — while the second
            // leaves it readable beside the failure that caused it.
            .disabled(isLocked || !code.canJoin)
            .accessibilityHidden(!code.canJoin)
            .accessibilityIdentifier("pairing-code-join")
            if shouldExplainAnonymousJoin {
                Text(L10n.t(.directJoinNoAccountNeeded))
                    .font(.footnote)
                    .foregroundStyle(Palette.supportingLabel)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - actions

    /// **What a scanned join link is allowed to do, which is fill a field.**
    ///
    /// `PairingScanPolicy` has already refused everything that is not a
    /// `relayium.com` realtime link carrying a complete six-digit code, so what
    /// arrives here is exactly what the keyboard could have produced, and it is
    /// normalized through the same `updateJoinCode` a keystroke goes through.
    ///
    /// **There is deliberately no `join` on this path.** A QR code is printed by
    /// anybody and photographed by accident; a scanner that connected would let
    /// a poster on a wall start a session on a phone that was merely pointed at
    /// it. A mode hint in an older link is ignored: the room carries both lanes.
    private func applyScan(_ result: PairingScanResult) {
        code.updateJoinCode(result.code)
        scanFilledCode = result.code
    }

    /// Resolve where received files go BEFORE opening a room.
    ///
    /// The order is the correctness, and on a link it applies to BOTH halves:
    /// whoever created the code can be sent files exactly as the joiner can. A
    /// room watched first would connect, handshake, accept a batch and only then
    /// discover it has nowhere to write, with the peer already sending. There is
    /// deliberately no fallback: the temporary directory is somewhere iOS deletes
    /// without warning and the Files app never shows.
    private func installReceiveDestination() -> Bool {
        destinationError = nil
        do {
            receiving.saveDirectory = try ReceiveDestination.directory()
            return true
        } catch {
            // `.appFolder`, not the receive folder: the only failure this can
            // see is something occupying the name `Received`, which puts it
            // BESIDE the receive folder rather than inside it.
            destinationError = ReceiveDestinationCopy.message(for: error, in: .appFolder)
            return false
        }
    }

    private func createCode() {
        guard module.acceptsNewSession else { return }
        // Re-read the computed gate at the instant of use. The `.allowed`
        // payload rendered into the button may predate a sign-out or account
        // transition; a credential is never a value a view action may cache.
        guard case let .allowed(access) = gate else {
            onOpenAccount()
            return
        }
        guard installReceiveDestination() else { return }
        link.dismissUnsupportedPairingPeer()
        // Claimed before minting, so the code this is about to create is drawn
        // here and a second start is refused while the mint is in flight.
        guard module.presence.beginSession(.pairingCode) else { return }
        foreground.sessionStarting()
        Task { await CrossNetworkPairingStart(module: module).createAndWatch(token: access.token) }
    }

    private func join() {
        guard module.acceptsNewSession else { return }
        let typed = code.joinCode
        guard code.canJoin else { return }
        guard installReceiveDestination() else { return }
        link.dismissUnsupportedPairingPeer()
        guard module.presence.beginSession(.pairingCode) else { return }
        foreground.sessionStarting()
        CrossNetworkPairingStart(module: module).joinAndWatch(code: typed)
    }

    private func regenerate() {
        guard case let .allowed(access) = gate else {
            onOpenAccount()
            return
        }
        foreground.sessionStarting()
        Task { await CrossNetworkPairingStart(module: module).regenerate(token: access.token) }
    }
}
