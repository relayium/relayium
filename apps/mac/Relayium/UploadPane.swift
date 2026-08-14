import SwiftUI
import UniformTypeIdentifiers
import RelayiumAppKit

/// Stored send: encrypt here, upload the ciphertext, hand back a link whose
/// fragment carries the key.
///
/// Takes an `AccountGate` rather than `token: String`, and the difference is the
/// point. The empty-string bearer this replaces said "signed out", "still
/// restoring while the keychain is read", "email unverified" and "the credential
/// this app holds is broken" in one greyed Send button — `.disabled(token.isEmpty)`
/// — which stated no reason and offered no way forward. Sending a link is the
/// one half of this app that genuinely needs an account, because the ciphertext
/// sits on Relayium's servers until it expires and somebody is billed for it, so
/// it is worth saying which of those four things is true.
struct UploadPane: View {
    @ObservedObject var model: CloudUploadModel
    let gate: AccountGate

    /// The gate's remedy selects the account destination. Reached through the
    /// navigation model rather than through a callback because this pane is
    /// rendered by exactly one destination.
    @EnvironmentObject private var navigation: AppNavigationModel
    /// The rendered gate decides the card; the live session decides whether a
    /// click may spend a bearer. Those can differ for one SwiftUI delivery turn.
    @EnvironmentObject private var session: AccountSession
    /// Files the OS opened with this app. Read-only here — this pane takes only
    /// the batch addressed to it.
    @EnvironmentObject private var fileOpenRouting: AppFileOpenCoordinator

    /// The pane owns the selection; the model owns what is being uploaded. They
    /// are kept in step through `model.pick`, so the model still refuses an
    /// oversized file and still has something to return to after a cancel.
    @StateObject private var selection = SelectionStore()
    /// Copy confirmation belongs to the exact generated link. Keeping the
    /// string, rather than a bare flag, prevents a later upload from inheriting
    /// the previous result's confirmation.
    @State private var copiedLink: String?
    /// Copy confirmation for the CLI command, kept SEPARATE from the link's.
    ///
    /// They are two different things to put on the clipboard — a link to send
    /// somebody, and a command to run here — and one shared flag would
    /// acknowledge whichever was copied last beside both buttons. Keyed by the
    /// command string for the same reason `copiedLink` is keyed by the link: a
    /// later upload must not inherit the previous result's tick.
    @State private var copiedCommand: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.section) {
            // **The one rail in the app with real progress**, because this is
            // the one surface whose model publishes a position: chosen,
            // encrypting and uploading, link ready. Nothing is drawn as finished
            // that the model has not finished — a failure leaves the rail back
            // at the step the user can retry rather than crediting the bytes
            // that did move. See `PathRailPresentation.storedSend`.
            PathRail(stops: PathRailPresentation.storedSend(model.state))
            content
        }
        // The store owns "what the user chose"; the model owns "what is being
        // uploaded". Pushing on every revision keeps them one fact rather than
        // two — including the empty case, which has to reach `clearSelection`
        // and not `reset` (reset deliberately restores the last selection).
        .onChange(of: selection.revision) { _ in
            if let expanded = selection.selection {
                model.pick(expanded)
            } else if let message = selection.error {
                model.fail(message)
            } else {
                model.clearSelection()
            }
        }
        // Files opened from Finder or dropped on the Dock icon. Adopting into
        // `selection` is enough: the `onChange` above is what carries a staged
        // selection into the model, so this path does not — and must not — push
        // to the model itself, or an opened file would reach it by two routes.
        .task(id: FileOpenAdoption(staged: fileOpenRouting.staged, busy: model.isBusy)) {
            adoptOpenedFiles()
        }
    }

    /// Stage a batch the OS opened, if this pane is the one it was addressed to
    /// and is free to take it. `add`, not `replace` — the same call the drop
    /// zone makes.
    private func adoptOpenedFiles() {
        guard let batch = fileOpenRouting.batch(for: .storedSend, busy: model.isBusy)
        else { return }
        selection.add(batch.urls)
        fileOpenRouting.consume(batch)
    }

    /// The account gate applies only while a new upload can be started. Once
    /// bytes are moving, or a result/failure exists, that surface must remain
    /// visible even if the account changes in another destination — otherwise
    /// sign-out hides Cancel and can strand the only copy of a completed link.
    @ViewBuilder
    private var content: some View {
        switch model.state {
        case .idle:
            if case .allowed = gate { sendCard(showsOptions: false) } else { gateCard }
        case .picked:
            if case .allowed = gate {
                sendCard(showsOptions: true)
            } else {
                gateCard
            }
        case .checkingRecovery, .preparing, .restarting:
            // R3-G's durable recovery is the iOS app's: this pane is built with
            // no `PendingUploadSupport`, so neither state is reachable here.
            // Handled rather than defaulted, so adding a state to the shared
            // model stays a compile error on this platform instead of a silent
            // blank card.
            uploadingCard(sent: 0, total: 0)
        case let .uploading(sent, total):
            uploadingCard(sent: sent, total: total)
        case .interrupted:
            // Same: unreachable without a pending store. Falling back to the
            // selection keeps the user's files in front of them.
            if case .allowed = gate { sendCard(showsOptions: false) } else { gateCard }
        case let .done(link, expiresAt, keyWarning):
            linkReadyCard(link: link, expiresAt: expiresAt, keyWarning: keyWarning)
        case let .failed(message):
            failureCard(message)
        }
    }

    private var gateCard: some View {
        SectionCard(title: L10n.t(.uploadHeading)) {
            // The whole destination is behind this gate — there is no ungated
            // half of sending a link — so Sign in is the one thing to press on
            // the screen and is drawn as the primary exit.
            CapabilityGateView(gate: gate,
                               title: L10n.t(.gateSendLinkTitle),
                               body: L10n.t(.gateSendLinkBody),
                               isWholeSurface: true,
                               onAccount: { navigation.selectAccount(intent: $0) })
        }
    }

    // MARK: - choosing

    /// **One card, one task.** Choosing the files, deciding how long the link
    /// lives and sending it were two peer cards of equal weight, which read as
    /// two things to do rather than three steps of one. The options are now the
    /// second level of hierarchy inside the same card — an `OpenSection`, no
    /// second background — and they appear only once there is a selection for
    /// them to apply to.
    private func sendCard(showsOptions: Bool) -> some View {
        SectionCard(title: L10n.t(.uploadHeading)) {
            FileDropZone(store: selection, isBusy: { model.isBusy }) {
                if isEmptySelection {
                    EmptyStateView(symbol: "doc.badge.plus",
                                   title: L10n.t(.storedSendIdleTitle),
                                   body: L10n.t(.uploadDropHint))
                } else {
                    Text(selection.summary ?? L10n.t(.uploadReady))
                        .font(.callout)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            PendingFileList(files: visibleSelectedFiles)
            if let message = selection.error {
                InlineMessage(.failure, message)
            }
            HStack {
                Button(L10n.t(.commonChooseFilesOrFolders)) { chooseFilesOrFolders(into: selection) }
                if !selection.isEmpty {
                    Button(L10n.t(.commonClear)) { selection.clear() }
                        .buttonStyle(.bordered)
                }
            }
            if showsOptions { options }
        }
    }

    /// `.idle` with nothing in the store is the only state with nothing to name.
    /// A `.picked` selection made through the model rather than the store still
    /// has something to say, so it falls through to the summary line.
    private var isEmptySelection: Bool {
        guard case .idle = model.state else { return false }
        return selection.summary == nil
    }

    /// Ordinarily the store and model name the same selection. Recovery and
    /// model-driven picks can legitimately populate only the model, so use that
    /// derived state when the pane's store has no list of its own.
    private var visibleSelectedFiles: [SelectedFile] {
        selection.files.isEmpty ? model.selectedFiles : selection.files
    }

    // MARK: - how long it lives

    /// TTL and burn together, because both answer one question — how long this
    /// link keeps working — and the choice is made before the bytes go out
    /// rather than recovered afterwards. `ttlChoices` is already capped to the
    /// plan's retention by `StoredSendDestination`.
    ///
    /// The picker's own label is hidden rather than removed: the card title
    /// already says it, and a control with no accessibility label at all would
    /// read as "pop-up button" and nothing else.
    private var options: some View {
        OpenSection(title: L10n.t(.uploadExpiresAfter)) {
            HStack(spacing: Metrics.section) {
                Picker(L10n.t(.uploadExpiresAfter), selection: $model.ttl) {
                    ForEach(model.ttlChoices, id: \.self) { secs in
                        Text(TtlPresentation.label(seconds: secs)).tag(secs)
                    }
                }
                .labelsHidden()
                .frame(maxWidth: 220)
                Toggle(L10n.t(.uploadBurnAfterRead), isOn: $model.burnAfterRead)
            }
            // No `.disabled`: reaching this group at all means a file is chosen
            // and the gate is `.allowed`, so there is nothing left to be missing.
            Button(L10n.t(.commonSend)) { send() }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
        }
    }

    private func send() {
        guard let token = session.bearerToken, !token.isEmpty,
              case .allowed = AccountGate.from(session.state, bearer: token) else {
            model.fail(L10n.t(.errorCloudUnauthorized))
            return
        }
        model.start(token: token)
    }

    // MARK: - running

    private func uploadingCard(sent: Int, total: Int) -> some View {
        SectionCard(title: L10n.t(.uploadHeading)) {
            ProgressView(value: total > 0 ? Double(sent) / Double(total) : 0)
                .accessibilityLabel(L10n.t(.uploadHeading))
                .accessibilityValue(
                    L10n.percent(done: sent, total: total) ?? L10n.t(.commonStarting))
            Text(L10n.percent(done: sent, total: total) ?? L10n.t(.commonStarting))
                .font(.caption).foregroundStyle(.secondary)
            Text(L10n.t(.uploadMacKeepOpen))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            PendingFileList(sessionFiles: model.sessionFiles)
            Button(L10n.t(.commonCancel)) { model.cancel() }
        }
    }

    // MARK: - terminal

    private func linkReadyCard(link: String, expiresAt: Int64, keyWarning: String?) -> some View {
        SectionCard(title: L10n.t(.uploadLinkReady)) {
            PendingFileList(sessionFiles: model.sessionFiles)
            // Exactly one statement about the key, decided in
            // UploadPresentation where it is tested. Which one is not
            // cosmetic: after a successful save the key really is on this
            // Mac and the Account destination can hand this link back, so the
            // old fixed "this link is the only copy" line was false on the
            // common path — and it contradicted the warning on the rare one.
            keyNotice(UploadPresentation.keyNotice(warning: keyWarning))
            // A capability result is not incidental metadata: show the entire
            // host, object id and fragment key before it is copied or shared.
            Text(link)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                // One stable address for the result. A window-wide predicate
                // over every descendant times out on macOS — the same limit
                // batches 94 and 102 hit — and this also gives assistive
                // technology something to point at.
                .accessibilityIdentifier("storedSend.resultLink")
            HStack {
                Button(L10n.t(.commonCopy)) {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(link, forType: .string)
                    copiedLink = link
                }
                ShareLink(item: link) {
                    Label(L10n.t(.commonShare), systemImage: "square.and.arrow.up")
                }
                if copiedLink == link {
                    Label(L10n.t(.pairingLinkCopied), systemImage: "checkmark")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.bordered)
            Text(L10n.t(.commonExpires, [
                L10n.date(Date(timeIntervalSince1970: TimeInterval(expiresAt)),
                          dateStyle: .medium, timeStyle: .short),
            ]))
                .font(.caption).foregroundStyle(.secondary)
            cliCommand(link: link)
            Button(L10n.t(.uploadSendAnother)) {
                copiedLink = nil
                copiedCommand = nil
                model.reset()
            }
            .buttonStyle(.bordered)
        }
    }

    /// **The same thing this window just did, as a command.**
    ///
    /// The web has shown this since stored send existed; the Mac app showed only
    /// the link, so a reader who works in a terminal had to compose the command
    /// themselves — and the natural way to compose it is to paste the link
    /// unquoted, which is the one way to get it wrong. `#` opens a comment in
    /// every POSIX shell, so the key is silently discarded and the download fails
    /// complaining about something else.
    ///
    /// The quoting itself is `StoredLinkCommandPresentation`, held byte-for-byte
    /// against the web's `shQuote` by its own tests. This file only renders it.
    ///
    /// Monospaced, selectable, and forced into left-to-right reading order —
    /// through `L10n.token`, the isolate the whole app uses for technical values,
    /// rather than by overriding the layout direction, which is a per-scene
    /// decision this file is not allowed to make.
    private func cliCommand(link: String) -> some View {
        let command = StoredLinkCommandPresentation.downCommand(link: link)
        return VStack(alignment: .leading, spacing: 8) {
            Text(L10n.t(.storedSendCliHeading))
                .font(.subheadline.weight(.semibold))
            Text(L10n.token(command))
                .font(.system(.body, design: .monospaced))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("storedSend.cliCommand")
            HStack {
                // Its own button and its own acknowledgement. The clipboard now
                // holds a command, not the link, and saying "Copied" beside the
                // link would be describing the wrong thing.
                Button(L10n.t(.storedSendCliCopy)) {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(command, forType: .string)
                    copiedCommand = command
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("storedSend.cliCopy")
                if copiedCommand == command {
                    Label(L10n.t(.commonCopied), systemImage: "checkmark")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            // Both halves are things the reader cannot see for themselves: why
            // the quotes are not decoration, and that a command carrying a
            // capability key is written to a history file by default.
            InlineMessage(.warning, L10n.t(.storedSendCliWarning))
            Link(L10n.t(.storedSendCliDocs), destination: AppEnvironment.cliWebURL)
                .font(.caption)
                .accessibilityIdentifier("storedSend.cliDocs")
        }
        .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
    }

    private func failureCard(_ message: String) -> some View {
        SectionCard(title: L10n.t(.uploadHeading)) {
            InlineMessage(.failure, message)
            PendingFileList(sessionFiles: model.sessionFiles)
            // `reset` rather than `clearSelection`: a failure must not make the
            // user choose every file again.
            Button(L10n.t(.commonTryAgain)) { model.reset() }
        }
    }

    @ViewBuilder
    private func keyNotice(_ notice: UploadKeyNotice) -> some View {
        if notice.isWarning {
            InlineMessage(.warning, notice.text)
        } else {
            Text(notice.text)
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
