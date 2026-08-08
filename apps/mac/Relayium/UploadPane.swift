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

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
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
            if case .allowed = gate { selectionCard } else { gateCard }
        case .picked:
            if case .allowed = gate {
                selectionCard
                optionsCard
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
            if case .allowed = gate { selectionCard } else { gateCard }
        case let .done(link, expiresAt, keyWarning):
            linkReadyCard(link: link, expiresAt: expiresAt, keyWarning: keyWarning)
        case let .failed(message):
            failureCard(message)
        }
    }

    private var gateCard: some View {
        SectionCard(title: L10n.t(.uploadHeading)) {
            CapabilityGateView(gate: gate,
                               title: L10n.t(.gateSendLinkTitle),
                               body: L10n.t(.gateSendLinkBody),
                               onAccount: { navigation.selectAccount(intent: $0) })
        }
    }

    // MARK: - choosing

    private var selectionCard: some View {
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
    private var optionsCard: some View {
        SectionCard(title: L10n.t(.uploadExpiresAfter)) {
            HStack(spacing: 16) {
                Picker(L10n.t(.uploadExpiresAfter), selection: $model.ttl) {
                    ForEach(model.ttlChoices, id: \.self) { secs in
                        Text(TtlPresentation.label(seconds: secs)).tag(secs)
                    }
                }
                .labelsHidden()
                .frame(maxWidth: 220)
                Toggle(L10n.t(.uploadBurnAfterRead), isOn: $model.burnAfterRead)
            }
            // No `.disabled`: reaching this card at all means a file is chosen
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
            Button(L10n.t(.uploadSendAnother)) {
                copiedLink = nil
                model.reset()
            }
            .buttonStyle(.bordered)
        }
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
