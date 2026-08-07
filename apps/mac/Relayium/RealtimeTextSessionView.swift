import AppKit
import SwiftUI
import RelayiumAppKit
import RelayiumKit

/// The part of an ephemeral text session that looks the same however the peer
/// was reached: the SAS gate, the accept prompt, the composer, the terminal
/// notices and the retained local history.
///
/// Extracted from `RealtimeTextPane` so the nearby pane renders exactly the
/// same consent steps rather than a second, drifting copy of them. Renders
/// nothing for the states specific to how a session started (`.idle`,
/// `.minting`, `.showingCode`); each pane owns those.
struct RealtimeTextSessionView: View {
    @ObservedObject var model: RealtimeTextSessionModel
    /// Only used to decide whether the derived phrase is worth screen space.
    /// The model reaches the same preference for the behaviour; this view must
    /// not be the thing that decides whether a gate exists.
    @EnvironmentObject private var verification: VerificationPreference
    /// Presentation state only: keep the acknowledgement tied to one row by
    /// id, never by retaining a second copy of its plaintext body.
    @State private var copiedMessageID: Int?
    @State private var confirmingHistoryClear = false
    @State private var confirmingDraftDiscard = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            switch model.state {
            case .idle, .minting, .showingCode:
                EmptyView()
            case .failed, .ended, .refused, .unsupported:
                terminalMessage
                retainedHistory
            case .joining, .connecting:
                ProgressView(L10n.t(.textConnecting)).controlSize(.small)
                Button(L10n.t(.commonCancel)) { model.reset() }
            case let .verifying(sas):
                verify(sas)
            case let .waitingAccept(sas):
                waiting(sas)
            case let .incomingRequest(sas):
                incomingRequest(sas)
            case let .open(sas):
                session(sas)
            }

            if let message = model.errorMessage {
                InlineMessage(.failure, message)
            }
        }
        .onChange(of: model.history) { history in
            guard let copiedMessageID,
                  !history.contains(where: { $0.id == copiedMessageID }) else { return }
            self.copiedMessageID = nil
        }
        .confirmationDialog(
            L10n.t(.textClearHistoryConfirmTitle),
            isPresented: $confirmingHistoryClear,
            titleVisibility: .visible
        ) {
            Button(L10n.t(.textClearHistory), role: .destructive) { model.clearHistory() }
            Button(L10n.t(.commonCancel), role: .cancel) { confirmingHistoryClear = false }
        } message: {
            Text(L10n.t(.textClearHistoryConfirmBody))
        }
    }

    /// The model owns whether the draft can be sent; this is only what the
    /// counter renders, so the two cannot disagree about the threshold.
    private var overByteLimit: Bool { model.draftByteCount > TEXT_MAX_BYTES }

    private func verify(_ sas: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n.t(.textCheckMatches))
                .font(.subheadline.weight(.semibold))
            SecurityCodeText(code: sas, style: .verification)
            Text(L10n.t(.textCheckMatchesBody))
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack {
                Button(L10n.t(.sessionTheyMatch)) { model.confirmSAS() }
                    .buttonStyle(.borderedProminent)
                Button(L10n.t(.sessionTheyDontMatch), role: .destructive) { model.rejectSAS() }
                    .buttonStyle(.bordered)
            }
        }
    }

    private func waiting(_ sas: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            ProgressView { Text(L10n.t(.textWaitingAccept)) }
                .controlSize(.small)
            if verification.requiresSASConfirmation {
                Text(L10n.t(.textVerifiedPhrase, [L10n.token(sas)]))
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
            }
            Button(L10n.t(.commonEndSession), role: .destructive) { model.end() }
                .buttonStyle(.bordered)
        }
    }

    private func incomingRequest(_ sas: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(L10n.t(.textIncomingHeading))
                .font(.subheadline.weight(.semibold))
            if verification.requiresSASConfirmation {
                Text(L10n.t(.textVerifiedPhrase, [L10n.token(sas)]))
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
            }
            Text(L10n.t(.textNothingDecrypted))
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack {
                Button(L10n.t(.commonAccept)) { model.accept() }
                    .buttonStyle(.borderedProminent)
                Button(L10n.t(.commonReject), role: .destructive) { model.reject() }
                    .buttonStyle(.bordered)
            }
        }
    }

    private func session(_ sas: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(L10n.t(.textSessionHeading)).font(.headline)
                Spacer()
                if verification.requiresSASConfirmation {
                    Text(sas).font(.caption.monospaced()).foregroundStyle(.secondary)
                }
            }
            Text(L10n.t(.textNoServerHistory))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    if model.history.isEmpty {
                        Text(L10n.t(.textNoMessages))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(model.history) { message in
                        messageRow(message)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(minHeight: 120, maxHeight: 240)

            TextEditor(text: $model.draft)
                .font(.body.monospaced())
                .frame(minHeight: 72)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
                .accessibilityLabel(L10n.t(.textComposerLabel))

            HStack {
                // Over the limit the counter turns a colour AND grows a symbol.
                // Colour alone left the one control that explains why Send is
                // dead — the draft is too long — invisible to anyone who cannot
                // see it, and the two numbers beside it are what VoiceOver reads.
                if overByteLimit {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .accessibilityHidden(true)
                }
                Text(L10n.t(.textByteCounter, [L10n.number(model.draftByteCount),
                                               L10n.number(TEXT_MAX_BYTES)]))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(overByteLimit ? AnyShapeStyle(Color.orange)
                                                   : AnyShapeStyle(.secondary))
                Spacer()
                Button(L10n.t(.commonSend)) { model.sendDraft() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(!model.canSend)
            }

            Text(L10n.t(.textClipboardNotice))
                .font(.caption2)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            HStack {
                Button(L10n.t(.textClearHistory), role: .destructive) {
                    confirmingHistoryClear = true
                }
                    .disabled(model.history.isEmpty)
                Spacer()
                Button(L10n.t(.commonEndSession), role: .destructive) { endOrConfirmDraftDiscard() }
                    .buttonStyle(.bordered)
            }
        }
        .confirmationDialog(
            L10n.t(.textDiscardDraftConfirmTitle),
            isPresented: $confirmingDraftDiscard,
            titleVisibility: .visible
        ) {
            Button(L10n.t(.commonEndSession), role: .destructive) { model.end() }
            Button(L10n.t(.commonCancel), role: .cancel) { confirmingDraftDiscard = false }
        } message: {
            Text(L10n.t(.textDiscardDraftConfirmBody))
        }
    }

    private func endOrConfirmDraftDiscard() {
        if model.draft.isEmpty {
            model.end()
        } else {
            confirmingDraftDiscard = true
        }
    }

    @ViewBuilder
    private var retainedHistory: some View {
        if !model.history.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text(L10n.t(.textLocalHistoryHeading)).font(.headline)
                Text(L10n.t(.textLocalHistoryBody))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(model.history) { message in
                            messageRow(message)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(minHeight: 100, maxHeight: 200)
                HStack {
                    Text(L10n.t(.textClipboardNoticeShort))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button(L10n.t(.textClearHistory), role: .destructive) {
                        confirmingHistoryClear = true
                    }
                }
            }
        }
    }

    private func messageRow(_ message: RealtimeTextMessage) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(L10n.t(message.direction == .outgoing ? .textSent : .textReceived))
                    .font(.caption.weight(.semibold))
                if message.failed {
                    // A symbol, not a colour: this label is the only thing that
                    // distinguishes a message that went from one that did not.
                    Label(L10n.t(.textNotSent), systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                Spacer()
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(message.body, forType: .string)
                    copiedMessageID = message.id
                } label: {
                    Label(L10n.t(copiedMessageID == message.id ? .commonCopied : .commonCopy),
                          systemImage: copiedMessageID == message.id ? "checkmark" : "doc.on.doc")
                }
                .buttonStyle(.link)
                .accessibilityLabel(TextMessagePresentation.copyActionLabel(
                    direction: message.direction, copied: copiedMessageID == message.id))
                // Explicit system handoff: unlike Copy, Share does not first put
                // ephemeral plaintext into the clipboard. The system receives
                // the body only after the user opens this row's share sheet.
                ShareLink(item: message.body) {
                    Label(L10n.t(.commonShare), systemImage: "square.and.arrow.up")
                }
                .buttonStyle(.link)
                .accessibilityLabel(TextMessagePresentation.shareActionLabel(
                    direction: message.direction))
            }
            Text(message.body)
                .textSelection(.enabled)
                .font(.body.monospaced())
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(8)
        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
    }

    @ViewBuilder
    private var terminalMessage: some View {
        switch model.state {
        case let .failed(message):
            InlineMessage(.failure, message)
        case .refused:
            Text(L10n.t(.textRefused))
                .font(.callout).foregroundStyle(.secondary)
        case .unsupported:
            Text(L10n.t(.textUnsupported))
                .font(.callout).foregroundStyle(.secondary)
        case .ended:
            Text(L10n.t(.textEnded))
                .font(.callout).foregroundStyle(.secondary)
        default:
            EmptyView()
        }
    }
}
