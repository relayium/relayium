import SwiftUI
import UIKit
import RelayiumAppKit
// For `TEXT_MAX_BYTES`, the per-message cap the wire format enforces. Read
// rather than restated: the counter beside Send and the rule that disables it
// must come from the same constant.
import RelayiumKit

/// The part of a direct TEXT session that looks the same however it started:
/// the verification gate, the accept prompt, the composer, the terminal notices
/// and the retained local transcript.
///
/// Every limit it renders belongs to `RealtimeTextSessionModel` — the per-message
/// byte cap, the per-session message and byte totals, the token-bucket rate
/// limit and the idle timeout. This view reads `canSend` and `draftByteCount`
/// rather than re-deriving either, so the counter beside Send and the rule that
/// disables it cannot disagree about the threshold.
///
/// **The one place in this app that writes the pasteboard.** It is a write the
/// user asked for, on the message the button belongs to, and there is no read
/// anywhere: an app that inspects the clipboard is doing exactly what this
/// product promises not to, and iOS raises its own paste notification for it
/// besides. `IOSSurfaceGuardTests` allows this single write by name and still
/// forbids every reading API.
struct DirectTextSessionView: View {
    @ObservedObject var model: RealtimeTextSessionModel
    /// Only decides whether the derived phrase is worth screen space. Whether a
    /// gate EXISTS is the model's decision, from the same preference — a view
    /// must not be the thing that answers that.
    @EnvironmentObject private var verification: VerificationPreference
    /// The row id is enough to render feedback; retaining the message here
    /// would duplicate plaintext after the model clears its in-memory history.
    @State private var copiedMessageID: Int?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            switch model.state {
            case .idle, .minting, .showingCode:
                EmptyView()
            case .failed, .ended, .refused, .unsupported:
                terminalMessage
                retainedHistory
            case .joining, .connecting:
                ProgressView { Text(L10n.t(.textConnecting)) }
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
                failureLine(message)
            }
        }
        .onChange(of: model.history) { history in
            guard let copiedMessageID,
                  !history.contains(where: { $0.id == copiedMessageID }) else { return }
            self.copiedMessageID = nil
        }
    }

    /// The model owns whether the draft can be sent; this is only what the
    /// counter renders, so the two cannot drift apart.
    private var overByteLimit: Bool { model.draftByteCount > TEXT_MAX_BYTES }

    private func verify(_ sas: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n.t(.textCheckMatches)).font(.headline)
            PairingCodeText(code: sas, style: .verification)
            Text(L10n.t(.textCheckMatchesBody))
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button(L10n.t(.sessionTheyMatch)) { model.confirmSAS() }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .frame(maxWidth: .infinity)
            Button(L10n.t(.sessionTheyDontMatch), role: .destructive) { model.rejectSAS() }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .frame(maxWidth: .infinity)
        }
    }

    private func waiting(_ sas: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            // The label IS the heading: a spinner beside a line of text that
            // says the same thing is one element read twice.
            ProgressView { Text(L10n.t(.textWaitingAccept)) }
            if verification.requiresSASConfirmation {
                Text(L10n.t(.textVerifiedPhrase, [L10n.token(sas)]))
                    .font(.footnote.monospaced())
                    .textSelection(.enabled)
            }
            Button(L10n.t(.commonEndSession)) { model.end() }
        }
    }

    /// Reached only with advanced verification ON. With it off — the default —
    /// `RealtimeTextSessionModel` accepts an incoming request itself the moment
    /// the encrypted connection is ready, and the composer is what appears. That
    /// is the existing responder semantics and this view does not change it:
    /// nothing is decrypted any earlier either way.
    private func incomingRequest(_ sas: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n.t(.textIncomingHeading)).font(.headline)
            if verification.requiresSASConfirmation {
                Text(L10n.t(.textVerifiedPhrase, [L10n.token(sas)]))
                    .font(.footnote.monospaced())
                    .textSelection(.enabled)
            }
            Text(L10n.t(.textNothingDecrypted))
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button(L10n.t(.commonAccept)) { model.accept() }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .frame(maxWidth: .infinity)
            Button(L10n.t(.commonReject), role: .destructive) { model.reject() }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .frame(maxWidth: .infinity)
        }
    }

    private func session(_ sas: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n.t(.textSessionHeading)).font(.headline)
            if verification.requiresSASConfirmation {
                Text(L10n.t(.textVerifiedPhrase, [L10n.token(sas)]))
                    .font(.footnote.monospaced())
                    .foregroundStyle(.secondary)
            }
            Text(L10n.t(.textNoServerHistory))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            // A `LazyVStack` inside the tab's own `ScrollView` rather than a
            // nested scroller: two scroll views on a phone is a region the user
            // cannot reliably reach past, and at the largest Dynamic Type sizes
            // an inner one with a fixed height shows about a line and a half.
            if model.history.isEmpty {
                Text(L10n.t(.textNoMessages))
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            LazyVStack(alignment: .leading, spacing: 10) {
                ForEach(model.history) { messageRow($0) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            composer

            Text(L10n.t(.textClipboardNotice))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            Button(L10n.t(.textClearHistory)) { model.clearHistory() }
                .disabled(model.history.isEmpty)
            Button(L10n.t(.commonEndSession), role: .destructive) { model.end() }
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField(L10n.t(.textComposerLabel), text: $model.draft, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(2...6)
                .accessibilityLabel(L10n.t(.textComposerLabel))
            HStack {
                // Over the limit the counter turns a colour AND grows a symbol.
                // Colour alone would leave the one control that explains why
                // Send is dead invisible to anyone who cannot see it, and the
                // two numbers beside it are what VoiceOver actually reads.
                if overByteLimit {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                        .accessibilityHidden(true)
                }
                Text(L10n.t(.textByteCounter, [L10n.number(model.draftByteCount),
                                               L10n.number(TEXT_MAX_BYTES)]))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(overByteLimit ? AnyShapeStyle(Color.orange)
                                                   : AnyShapeStyle(.secondary))
                Spacer(minLength: 0)
                Button(L10n.t(.commonSend)) { model.sendDraft() }
                    .buttonStyle(.borderedProminent)
                    .disabled(!model.canSend)
            }
        }
    }

    private func messageRow(_ message: RealtimeTextMessage) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(L10n.t(message.direction == .outgoing ? .textSent : .textReceived))
                    .font(.caption.weight(.semibold))
                if message.failed {
                    // A symbol, not a colour: this label is the only thing that
                    // distinguishes a message that went from one that did not.
                    Label(L10n.t(.textNotSent), systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                Spacer(minLength: 0)
                // The one pasteboard write in the app, and it happens only here,
                // on a tap, on the body of the message this row is showing. The
                // notice under the composer says what it costs; nothing reads
                // the pasteboard back, ever.
                Button {
                    UIPasteboard.general.string = message.body
                    copiedMessageID = message.id
                } label: {
                    Label(L10n.t(copiedMessageID == message.id ? .commonCopied : .commonCopy),
                          systemImage: copiedMessageID == message.id ? "checkmark" : "doc.on.doc")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(L10n.t(copiedMessageID == message.id
                    ? .commonCopied
                    : (message.direction == .outgoing
                       ? .textCopySentMessage : .textCopyReceivedMessage)))
            }
            Text(message.body)
                .textSelection(.enabled)
                .font(.body.monospaced())
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(10)
        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 10))
    }

    /// The transcript after the session is over.
    ///
    /// It survives every terminal state on purpose: these messages exist in no
    /// other copy — the model keeps none and the server was never given one — so
    /// a terminal notice that cleared itself would take them with it. Clearing
    /// is a button.
    @ViewBuilder
    private var retainedHistory: some View {
        if !model.history.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text(L10n.t(.textLocalHistoryHeading)).font(.headline)
                Text(L10n.t(.textLocalHistoryBody))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(model.history) { messageRow($0) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Text(L10n.t(.textClipboardNoticeShort))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button(L10n.t(.textClearHistory)) { model.clearHistory() }
            }
        }
    }

    @ViewBuilder
    private var terminalMessage: some View {
        switch model.state {
        case let .failed(message):
            failureLine(message)
        case .refused:
            Text(L10n.t(.textRefused)).font(.callout).foregroundStyle(.secondary)
        case .unsupported:
            Text(L10n.t(.textUnsupported)).font(.callout).foregroundStyle(.secondary)
        case .ended:
            Text(L10n.t(.textEnded)).font(.callout).foregroundStyle(.secondary)
        default:
            EmptyView()
        }
    }

    /// A failure line. The icon carries the label rather than sitting beside an
    /// unlabelled image, so VoiceOver reads the sentence and not "image".
    private func failureLine(_ text: String) -> some View {
        Label {
            Text(text)
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
        }
        .font(.callout)
        .fixedSize(horizontal: false, vertical: true)
    }
}
