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
                Button(L10n.t(.commonCancel)) { model.end() }
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
                Button(L10n.t(.sessionTheyDontMatch)) { model.rejectSAS() }
            }
        }
    }

    private func waiting(_ sas: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(L10n.t(.textWaitingAccept))
                .font(.subheadline.weight(.semibold))
            if verification.requiresSASConfirmation {
                Text(L10n.t(.textVerifiedPhrase, [L10n.token(sas)]))
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
            }
            ProgressView().controlSize(.small)
            Button(L10n.t(.commonEndSession)) { model.end() }
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
                Button(L10n.t(.commonReject)) { model.reject() }
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
                Button(L10n.t(.textClearHistory)) { model.clearHistory() }
                    .disabled(model.history.isEmpty)
                Spacer()
                Button(L10n.t(.commonEndSession)) { model.end() }
            }
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
                    Button(L10n.t(.textClearHistory)) { model.clearHistory() }
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
                Button(L10n.t(.commonCopy)) {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(message.body, forType: .string)
                }
                .buttonStyle(.link)
                .accessibilityLabel(L10n.t(message.direction == .outgoing
                                           ? .textCopySentMessage : .textCopyReceivedMessage))
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
