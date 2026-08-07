import SwiftUI
import UIKit
import UniformTypeIdentifiers
import RelayiumAppKit
import RelayiumKit

private struct PairingJoinLinkView: View {
    let url: URL
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L10n.t(.pairingJoinLink))
                .font(.footnote.weight(.semibold))
            Text(url.absoluteString)
                .font(.footnote.monospaced())
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)

            HStack {
                Button {
                    UIPasteboard.general.string = url.absoluteString
                    copied = true
                } label: {
                    Label(L10n.t(.commonCopy), systemImage: "doc.on.doc")
                }
                ShareLink(item: url) {
                    Label(L10n.t(.commonShare), systemImage: "square.and.arrow.up")
                }
            }
            .buttonStyle(.bordered)

            if copied {
                Label(L10n.t(.pairingLinkCopied), systemImage: "checkmark")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// R3-E: transfer straight to another device with six digits, across networks.
///
/// Two things about this screen are structural rather than stylistic, and both
/// are here because getting either wrong is invisible in a screenshot.
///
/// **The halves are gated differently, and that is a server-side fact.**
/// *Creating* a code reserves relay capacity billed to whoever created it, so it
/// needs an account; *joining* a code somebody else created reserves nothing and
/// reaches the transport with no credential at all. So the create half renders
/// an `AccountGate` when there is no account, and the join field beside it is
/// rendered and enabled exactly as it is when signed in — not greyed, not
/// hidden, and not behind a sign-in form. That is why this view takes the gate
/// rather than a bearer string: an empty-string token said "signed out", "still
/// restoring", "email unverified" and "this credential is broken" in the same
/// three grey pixels.
///
/// **Nothing about the session lives here.** The two models, the file selection
/// and its security scopes, the mode choice and the foreground lifecycle are all
/// app-scoped and handed in. A `TabView` mounts its tabs lazily and tears an
/// off-screen one down — the user checking their plan mid-transfer does exactly
/// that — so a view that owned any of them would end a live DataChannel, drop a
/// sandbox extension mid-read, or lose the transcript, on a tab switch.
///
/// It is also where the product says what it is for. A direct transfer needs
/// both devices open, which makes it excellent for text and small files and
/// genuinely worse than the stored **Send** tab for anything large — so that is
/// stated where the user is deciding, with the route out beside it, rather than
/// discovered ninety seconds into a transfer.
struct DirectView: View {
    @ObservedObject var file: RealtimeSessionModel
    @ObservedObject var text: RealtimeTextSessionModel
    @ObservedObject var selection: DirectSendSelection
    @ObservedObject var modes: DirectModeSelection
    @ObservedObject var foreground: ForegroundSessionCoordinator
    /// Which of the two direct tabs draws the session. R3-F's addition, and the
    /// reason it is needed here at all: Nearby drives the SAME two models, so
    /// rendered side by side the two tabs would show one transfer twice, each
    /// copy with its own Cancel and its own Done.
    @ObservedObject var presence: TransferPresence
    /// Tab selections handed down as closures, the same shape `SendView` uses
    /// for the account — which is what lets `RootView` stay ignorant of both.
    let onOpenSend: () -> Void
    let onOpenAccount: () -> Void
    /// Where the session actually is, when it is not here.
    let onShowSession: (AppDestination) -> Void

    @EnvironmentObject private var session: AccountSession
    @EnvironmentObject private var verification: VerificationPreference

    @State private var isChoosingFiles = false
    /// A failure to resolve the app's own receive folder. It happens before the
    /// model is involved at all, so it has no state case to live in, and it is
    /// cleared whenever a new attempt starts so it cannot outlive its cause.
    @State private var destinationError: String?
    @State private var confirmingLocalTextDone = false

    private var gate: AccountGate {
        AccountGate.from(session.state, bearer: session.bearerToken)
    }

    /// Derived on every render from the two live models rather than cached: a
    /// stored flag would be a second answer to a question they already answer.
    private var isLocked: Bool {
        DirectModeSelection.isLocked(file: file.state,
                                     text: text.state,
                                     sessionClaimed: presence.owner != nil)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    // The other direct tab is presenting the session. Say so and
                    // offer the way there rather than drawing a second copy of
                    // it — both tabs drive the same two models, so a second copy
                    // would be a second Cancel for one transfer.
                    if let owner = presence.owner, owner != .pairingCode {
                        busyElsewhere(owner)
                    } else {
                        Text(L10n.t(.navPairingCodeSubtitle))
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)

                        if let notice = foreground.interruption { interruption(notice) }

                        modePicker

                        switch modes.mode {
                        case .files: filesMode
                        case .text:  textMode
                        }

                        if !isLocked { largeFileRoute }
                        verificationSetting
                    }
                }
                .padding()
                // Leading, not centred: at the largest Dynamic Type sizes a
                // centred ragged column is unreadable.
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle(L10n.t(.tabDirect))
        }
        // `[.item, .folder]`, so a folder is choosable and its contents are
        // expanded inside the security scope `DirectSendSelection` starts before
        // anything enumerates them. Attached to the `NavigationStack` rather
        // than to the button, so presenting it does not depend on which arm of
        // the state switch happens to be on screen when the sheet returns.
        .fileImporter(isPresented: $isChoosingFiles,
                      allowedContentTypes: [.item, .folder],
                      allowsMultipleSelection: true) { result in
            // Straight to the app-scoped owner. The view never touches a
            // security scope, which is what keeps the start/stop balance out of
            // SwiftUI's hands entirely.
            selection.chooseFiles(result)
        }
        .confirmationDialog(
            L10n.t(.textDiscardLocalContentConfirmTitle),
            isPresented: $confirmingLocalTextDone,
            titleVisibility: .visible
        ) {
            Button(L10n.t(.commonDone), role: .destructive) { text.reset() }
            Button(L10n.t(.commonCancel), role: .cancel) {
                confirmingLocalTextDone = false
            }
        } message: {
            Text(L10n.t(.textDiscardLocalContentConfirmBody))
        }
    }

    // MARK: - the one choice

    /// Files or text, and it stops being the user's choice the moment either
    /// model owns a session — including a finished one, which still owns its
    /// result and its share sheet, and an ended text session, which still owns a
    /// transcript that exists nowhere else.
    ///
    /// `.disabled` is the courtesy; the refusal is `DirectModeSelection.select`,
    /// which re-reads both model states. SwiftUI still owns the binding behind a
    /// disabled control, so the mechanism cannot be the modifier.
    private var modePicker: some View {
        VStack(alignment: .leading, spacing: 6) {
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
            .accessibilityHint(L10n.t(.directModeMatchHint))
            Text(L10n.t(.directModeMatchHint))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("pairing-mode-match-hint")
        }
    }

    // MARK: - files

    @ViewBuilder
    private var filesMode: some View {
        switch file.state {
        // The start controls live only in idle. A failed session still owns its
        // dead connection (and possibly a partial receive), so starting again
        // before Done would bypass the cleanup boundary the mode lock promises.
        case .idle:
            createFiles
            joinCard(code: $file.joinCode,
                     normalize: { file.updateJoinCode($0) },
                     canJoin: file.canJoin,
                     showsAnonymousNote: shouldExplainAnonymousJoin,
                     action: joinToReceiveFiles)
        case let .failed(message):
            failureLine(message)
            PendingFileList(sessionFiles: file.sessionFiles)
            // `cancel`, not a bare reset: the failure may have left a partial
            // write to discard, and `.failed` still holds the dead connection.
            Button(L10n.t(.commonDone)) { file.cancel() }
                .buttonStyle(.bordered)
                .controlSize(.large)
        case .minting:
            ProgressView { Text(L10n.t(.directCreatingCode)) }
            PendingFileList(sessionFiles: file.sessionFiles)
            Button(L10n.t(.commonCancel)) { file.cancel() }
                .buttonStyle(.bordered)
                .controlSize(.large)
        case let .showingCode(code, expiresAt):
            // `cancel` alone. The staged batch inside the model goes with it,
            // but the SELECTION stays: cancelling a code nobody answered is not
            // a decision to send something else, and making the user find the
            // same folder again is a punishment for the peer being slow. The
            // next Create re-stages from the scope this still holds.
            //
            // The picker is also gone here, so keep the model-owned manifest
            // visible while the sender hands off the code. This is their last
            // chance to verify every file and size before a peer joins.
            PendingFileList(sessionFiles: file.sessionFiles)
            showing(code: code, expiresAt: expiresAt, mode: .files,
                    heading: L10n.t(.directGiveCode)) {
                file.cancel()
            }
        case .joining, .connecting, .verifying, .transferring, .completed:
            DirectFileSessionView(model: file, onDone: finishCompletedFileTransfer)
        }

        if let destinationError { failureLine(destinationError) }
    }

    /// Choose what to send, then create a code. Gated, because creating one is
    /// the half that costs an account.
    @ViewBuilder
    private var createFiles: some View {
        Text(L10n.t(.directSendHeading)).font(.headline)
        if case .allowed = gate {
            if let summary = selection.summary {
                HStack(spacing: 12) {
                    Text(summary).font(.subheadline)
                    Spacer(minLength: 0)
                    Button(L10n.t(.commonClear)) { selection.clear() }
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
            Button { createAndSend() } label: {
                Text(L10n.t(.directCreateCode)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            // What is missing is named by the line above, and adding it is one
            // tap away — unlike an account, which is why that gets a gate.
            .disabled(selection.isEmpty)
            .accessibilityHidden(selection.isEmpty)
        } else {
            capabilityGate
        }
    }

    // MARK: - text

    @ViewBuilder
    private var textMode: some View {
        switch text.state {
        case .idle:
            createText
            joinCard(code: $text.joinCode,
                     normalize: { text.updateJoinCode($0) },
                     canJoin: text.canJoin,
                     showsAnonymousNote: shouldExplainAnonymousJoin,
                     action: joinTextSession)
        // Every terminal state still owns the transcript that exists nowhere
        // else. Keep it on screen and expose only Done: showing the start
        // controls here would let a new session replace it without the explicit
        // discard the mode lock promises.
        case .failed, .ended, .refused, .unsupported:
            DirectTextSessionView(model: text)
            Button(L10n.t(.commonDone)) { finishTextOrConfirm() }
                .buttonStyle(.bordered)
                .controlSize(.large)
        case .minting:
            ProgressView { Text(L10n.t(.textCreatingCode)) }
            Button(L10n.t(.commonCancel)) { text.reset() }
                .buttonStyle(.bordered)
                .controlSize(.large)
        case let .showingCode(code, expiresAt):
            showing(code: code, expiresAt: expiresAt, mode: .text,
                    heading: L10n.t(.textGiveCode)) {
                text.reset()
            }
        case .joining, .connecting, .verifying, .waitingAccept, .incomingRequest, .open:
            DirectTextSessionView(model: text)
        }
    }

    @ViewBuilder
    private var createText: some View {
        Text(L10n.t(.textStartHeading)).font(.headline)
        if case .allowed = gate {
            Text(L10n.t(.textStartBody))
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button { createTextSession() } label: {
                Text(L10n.t(.textCreateCode)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        } else {
            capabilityGate
        }
    }

    // MARK: - shared pieces

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
        VStack(alignment: .leading, spacing: 12) {
            switch gate {
            case .allowed:
                EmptyView()

            case .loading:
                ProgressView { Text(L10n.t(.accountRestoring)) }

            case .signInRequired:
                Text(L10n.t(.gateCreateCodeTitle)).font(.subheadline.weight(.semibold))
                Text(L10n.t(.gateCreateCodeBody))
                    .font(.callout)
                    .foregroundStyle(.secondary)
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
                    .foregroundStyle(.secondary)
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
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                openAccountButton
            }
        }
    }

    /// Never a second copy of the session with its own Cancel — see the call
    /// site. `NearbyView` renders the same card from the other side.
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

    private var openAccountButton: some View {
        Button(action: onOpenAccount) {
            Text(L10n.t(.gateOpenAccount)).frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
    }

    /// The ordinary signed-out card already says joining needs no account. The
    /// other gate states describe loading, an outage, verification or deletion
    /// instead, so they still need the one-line explanation beside Join — as
    /// does a ready-account user. This removes one duplicate without hiding the
    /// anonymous capability behind an unrelated account problem.
    private var shouldExplainAnonymousJoin: Bool {
        switch gate {
        case .signInRequired: return false
        case .allowed, .loading, .unavailable, .verifyEmail, .pendingDeletion: return true
        }
    }

    /// The code to read onto the other device, and the wait.
    private func showing(code: String, expiresAt: Int64, mode: TransferMode, heading: String,
                         cancel: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(heading).font(.headline)
            PairingCodeText(code: code, style: .pairing)
            if let joinURL = productionPairingJoinURL(code: code, mode: mode) {
                PairingJoinLinkView(url: joinURL)
            }
            Text(L10n.t(.commonExpires, [
                L10n.date(Date(timeIntervalSince1970: TimeInterval(expiresAt)),
                          dateStyle: .none, timeStyle: .short),
            ]))
                .font(.footnote)
                .foregroundStyle(.secondary)
            Text(L10n.t(.pairingCodeExpiryNote))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("pairing-code-expiry-note")
            ProgressView { Text(L10n.t(.directWaitingForDevice)) }
            Text(L10n.t(.directKeepBothOpen))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button(L10n.t(.commonCancel), action: cancel)
                .buttonStyle(.bordered)
                .controlSize(.large)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// What the app could not carry into the background, said after the fact
    /// because that is the only moment it can be read.
    private func interruption(_ notice: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            failureLine(notice)
            Button(L10n.t(.commonDismiss)) { foreground.dismissInterruption() }
        }
    }

    /// The honest limit, and the way out of it.
    ///
    /// Shown only while nothing is running: mid-transfer it would be advice
    /// about a decision already made, next to a button that would take the user
    /// off the screen showing their own transfer.
    private var largeFileRoute: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n.t(.directLargeFilesTitle)).font(.subheadline.weight(.semibold))
            Text(L10n.t(.directLargeFilesBody))
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button(action: onOpenSend) {
                Text(L10n.t(.directOpenSend)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
        }
    }

    /// The advanced-verification setting, which belongs on the surface that uses
    /// it: a security control living only on the platform the user is not
    /// holding is a control they cannot turn on.
    ///
    /// Off by default — `VerificationPreference` owns that decision and states
    /// why. The two sentences below are the ones that keep the toggle from being
    /// read as "turn this on to be encrypted": the first says what it detects,
    /// the second says what it does not change. Locked while a session is live,
    /// because the models read the preference when the SAS arrives and flipping
    /// it mid-handshake would make the gate depend on timing.
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

    // MARK: - join (needs nothing)

    /// One join field for both modes.
    ///
    /// Two would be two places for the keyboard type, the content type and the
    /// normalization to drift, and the drift is silent: a field that works and
    /// one that eats a leading digit look identical. Each mode passes its own
    /// model's binding and its own `updateJoinCode`, so the text is normalized
    /// on every keystroke — which is what keeps `1` typeable as a first digit,
    /// because `normalizedPairingCode` filters the raw string rather than
    /// parsing a number.
    ///
    /// Nothing in here reads the account. That is the point of the whole
    /// destination and it is enforced by `IOSSurfaceGuardTests`.
    private func joinCard(code: Binding<String>,
                          normalize: @escaping (String) -> Void,
                          canJoin: Bool,
                          showsAnonymousNote: Bool,
                          action: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n.t(.directReceiveHeading)).font(.headline)
            TextField(L10n.t(.commonCode), text: code)
                .textFieldStyle(.roundedBorder)
                // A phone keyboard that opens on letters for a six-digit code
                // makes the user hunt for the number row every time; without the
                // content type, iOS never offers a code that arrived in a
                // message.
                .keyboardType(.numberPad)
                .textContentType(.oneTimeCode)
                .font(.title3.monospaced())
                .onChange(of: code.wrappedValue) { normalize($0) }
                .accessibilityLabel(L10n.t(.commonCode))
            Button(action: action) {
                Text(L10n.t(.commonJoin)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(!canJoin)
            .accessibilityHidden(!canJoin)
            if showsAnonymousNote {
                Text(L10n.t(.directJoinNoAccountNeeded))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - actions

    /// Receiving files: resolve where they go BEFORE opening a connection.
    ///
    /// The order is the correctness. `RealtimeSessionModel.saveDirectory`
    /// defaults to Downloads, which inside this container is a directory nobody
    /// has — so a join that ran first would connect, handshake, accept a
    /// manifest and only then discover it has nowhere to write, with the peer
    /// already sending. And there is deliberately no fallback: writing to the
    /// temporary directory instead would put the user's files somewhere iOS
    /// deletes without warning and the Files app never shows.
    private func joinToReceiveFiles() {
        destinationError = nil
        let code = file.joinCode
        guard file.canJoin else { return }
        let destination: URL
        do {
            destination = try ReceiveDestination.directory()
        } catch {
            // `.appFolder`, not the receive folder: the only failure this can
            // see is something occupying the name `Received`, which puts it
            // BESIDE the receive folder rather than inside it.
            destinationError = ReceiveDestinationCopy.message(for: error, in: .appFolder)
            return
        }
        file.saveDirectory = destination
        // Claimed before connecting, so the session this is about to start is
        // presented here. A refusal means Nearby already owns one and the card
        // above is already showing that instead.
        guard presence.beginSession(.pairingCode) else { return }
        foreground.sessionStarting()
        Task { await file.join(code: code) }
    }

    /// Sending files: stage inside the live security scope, mint, then dial as
    /// the initiator.
    ///
    /// Staging happens BEFORE the code is minted, so a selection that cannot be
    /// sent — too many files, a manifest too large for one frame, a file that
    /// will not open — costs the button rather than a minted code and a peer
    /// waiting on the other end.
    private func createAndSend() {
        destinationError = nil
        guard let staged = selection.stageForSend() else { return }
        // Re-read the computed gate at the instant of use. The `.allowed`
        // payload rendered into the button may predate a sign-out or account
        // transition; a credential is never a value a view action may cache.
        guard case let .allowed(access) = gate else {
            // The tap can arrive from an older allowed render. Preserve the
            // staged selection and show the live account remedy instead of
            // making Create appear broken.
            onOpenAccount()
            return
        }
        // Before anything is written to the shared model: a refused claim means
        // Nearby owns a session, and staging over its pending batch would be
        // this tab reaching into a transfer it is not even drawing.
        guard presence.beginSession(.pairingCode) else { return }
        foreground.sessionStarting()
        file.stageSend(sources: staged.sources, metas: staged.metas)
        Task { await mintAndSendFiles(token: access.token) }
    }

    /// Only a completed SEND owns the staged outbound selection. A receive may
    /// happen while a different future send is prepared, so Done leaves that
    /// selection alone. Failed sends never enter this completion path.
    private func finishCompletedFileTransfer() {
        if file.received == nil { selection.clear() }
        file.cancel()
    }

    private func mintAndSendFiles(token: String) async {
        await file.mintCode(token: token)
        guard case let .showingCode(code, _) = file.state else { return }
        await file.join(code: code, role: .initiator)
    }

    private func joinTextSession() {
        let code = text.joinCode
        guard text.canJoin else { return }
        guard presence.beginSession(.pairingCode) else { return }
        foreground.sessionStarting()
        Task { await text.join(code: code) }
    }

    private func createTextSession() {
        // Same live credential boundary as file create; joining remains outside
        // it and anonymous.
        guard case let .allowed(access) = gate else {
            // Match file creation: stale authorization has a visible recovery
            // path rather than swallowing the user's tap.
            onOpenAccount()
            return
        }
        guard presence.beginSession(.pairingCode) else { return }
        foreground.sessionStarting()
        Task { await mintAndJoinText(token: access.token) }
    }

    private func mintAndJoinText(token: String) async {
        await text.mintCode(token: token)
        guard case let .showingCode(code, _) = text.state else { return }
        await text.join(code: code, role: .initiator)
    }

    private func finishTextOrConfirm() {
        guard text.hasLocalContent else {
            text.reset()
            return
        }
        confirmingLocalTextDone = true
    }
}
