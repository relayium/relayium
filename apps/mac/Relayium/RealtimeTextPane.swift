import AppKit
import SwiftUI
import RelayiumAppKit
import RelayiumKit

struct RealtimeTextPane: View {
    @ObservedObject var model: RealtimeTextSessionModel
    let token: String

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            switch model.state {
            case .idle:
                start
            case .failed, .ended, .refused, .unsupported:
                terminalMessage
                retainedHistory
                Divider()
                start
            case .minting:
                ProgressView("Creating a text code…").controlSize(.small)
            case let .showingCode(code, expiresAt):
                showing(code: code, expiresAt: expiresAt)
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

    private var start: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Start a text session").font(.headline)
                Text("Both devices stay online. Messages are end-to-end encrypted and kept only in this session's memory.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Create a text code") {
                    Task {
                        await model.mintCode(token: token)
                        guard case let .showingCode(code, _) = model.state else { return }
                        await model.join(code: code, role: .initiator)
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(token.isEmpty)
                if token.isEmpty {
                    Text("Sign in to create a code. Joining someone else's code does not require an account.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Divider()

            VStack(alignment: .leading, spacing: 6) {
                Text("Join a text session").font(.headline)
                HStack {
                    TextField("Code", text: $model.joinCode)
                        .textFieldStyle(.roundedBorder)
                        .frame(maxWidth: 140)
                        .onChange(of: model.joinCode) { model.updateJoinCode($0) }
                    Button("Join") {
                        Task { await model.join(code: model.joinCode) }
                    }
                    .disabled(!model.canJoin)
                }
                Text("A pairing code does not reveal its type. Choose Text here only when the sender started a text session.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func showing(code: String, expiresAt: Int64) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Give this text code to the other device")
                .font(.subheadline.weight(.semibold))
            Text(code)
                .font(.system(size: 34, weight: .semibold, design: .monospaced))
                .textSelection(.enabled)
            Text("Expires \(Date(timeIntervalSince1970: TimeInterval(expiresAt)).formatted(date: .omitted, time: .shortened))")
                .font(.caption)
                .foregroundStyle(.secondary)
            QRCodeView(url: "\(AppEnvironment.productionBaseURL.absoluteString)/cross-network#c=\(code)")
            ProgressView("Waiting for the other device…").controlSize(.small)
            Button("Cancel") { model.end() }
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
            Text("Verified phrase: \(sas)")
                .font(.caption.monospaced())
                .textSelection(.enabled)
            ProgressView().controlSize(.small)
            Button("End session") { model.end() }
        }
    }

    private func incomingRequest(_ sas: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("The other device wants to exchange text")
                .font(.subheadline.weight(.semibold))
            Text("Verified phrase: \(sas)")
                .font(.caption.monospaced())
                .textSelection(.enabled)
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
                Text(sas).font(.caption.monospaced()).foregroundStyle(.secondary)
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
