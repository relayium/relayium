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
                ProgressView("Connecting a private text session…").controlSize(.small)
                Button("Cancel") { model.end() }
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
                Text(message).font(.callout).foregroundStyle(.red)
            }
        }
    }

    private func verify(_ sas: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Check this matches the other device")
                .font(.subheadline.weight(.semibold))
            Text(sas)
                .font(.system(size: 26, weight: .semibold, design: .monospaced))
                .textSelection(.enabled)
            Text("If it does not match exactly, someone may be intercepting the connection.")
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack {
                Button("They match") { model.confirmSAS() }
                    .buttonStyle(.borderedProminent)
                Button("They don't match") { model.rejectSAS() }
            }
        }
    }

    private func waiting(_ sas: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Waiting for the other device to accept…")
                .font(.subheadline.weight(.semibold))
            if verification.requiresSASConfirmation {
                Text("Verified phrase: \(sas)")
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
            }
            ProgressView().controlSize(.small)
            Button("End session") { model.end() }
        }
    }

    private func incomingRequest(_ sas: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("The other device wants to exchange text")
                .font(.subheadline.weight(.semibold))
            if verification.requiresSASConfirmation {
                Text("Verified phrase: \(sas)")
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
            }
            Text("No message has been decrypted or shown yet.")
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack {
                Button("Accept") { model.accept() }
                    .buttonStyle(.borderedProminent)
                Button("Reject") { model.reject() }
            }
        }
    }

    private func session(_ sas: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Private text session").font(.headline)
                Spacer()
                if verification.requiresSASConfirmation {
                    Text(sas).font(.caption.monospaced()).foregroundStyle(.secondary)
                }
            }
            Text("Relayium stores no message body or server-side history. Either device can still copy or retain text.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    if model.history.isEmpty {
                        Text("No messages yet.")
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
                .accessibilityLabel("Message")

            HStack {
                Text("\(model.draftByteCount.formatted()) / \(TEXT_MAX_BYTES.formatted()) UTF-8 bytes")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(model.draftByteCount > TEXT_MAX_BYTES ? .red : .secondary)
                Spacer()
                Button("Send") { model.sendDraft() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(!model.canSend)
            }

            Text("Copying places content on the system clipboard, where other apps or clipboard history tools may retain it.")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            HStack {
                Button("Clear history") { model.clearHistory() }
                    .disabled(model.history.isEmpty)
                Spacer()
                Button("End session") { model.end() }
            }
        }
    }

    @ViewBuilder
    private var retainedHistory: some View {
        if !model.history.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("Local session history").font(.headline)
                Text("This history remains only in this app's memory until you clear it or start another session.")
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
                    Text("Copying may leave content in the system clipboard or clipboard history.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Clear history") { model.clearHistory() }
                }
            }
        }
    }

    private func messageRow(_ message: RealtimeTextMessage) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(message.direction == .outgoing ? "Sent" : "Received")
                    .font(.caption.weight(.semibold))
                if message.failed {
                    Text("Not sent").font(.caption).foregroundStyle(.red)
                }
                Spacer()
                Button("Copy") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(message.body, forType: .string)
                }
                .buttonStyle(.link)
                .accessibilityLabel("Copy \(message.direction == .outgoing ? "sent" : "received") message")
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
            Text(message).font(.callout).foregroundStyle(.red)
        case .refused:
            Text("The other device refused this text session.")
                .font(.callout).foregroundStyle(.secondary)
        case .unsupported:
            Text("That device does not support Relayium text sessions yet. Update Relayium on both devices.")
                .font(.callout).foregroundStyle(.secondary)
        case .ended:
            Text("The text session ended. Local history remains visible until you clear or start another session.")
                .font(.callout).foregroundStyle(.secondary)
        default:
            EmptyView()
        }
    }
}
