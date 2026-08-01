import SwiftUI
import UniformTypeIdentifiers
import RelayiumAppKit
import RelayiumKit

/// Peer-to-peer transfer: mint a code or join one, compare the phrase, send.
/// Holds no decisions — every state it renders is covered by
/// RealtimeSessionModelTests.
struct DirectPane: View {
    @ObservedObject var model: RealtimeSessionModel
    let token: String

    @State private var picked: [URL] = []
    @State private var stagingError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            switch model.state {
            case .idle, .failed:
                start
            case .minting:
                ProgressView("Creating a code…").controlSize(.small)
            case let .showingCode(code, expiresAt):
                showing(code: code, expiresAt: expiresAt)
            case .joining, .connecting:
                VStack(alignment: .leading, spacing: 8) {
                    ProgressView("Connecting…").controlSize(.small)
                    Button("Cancel") { model.cancel() }
                }
            case let .verifying(sas):
                verifying(sas)
            case let .transferring(done, total):
                transferring(done: done, total: total)
            case let .completed(urls):
                VStack(alignment: .leading, spacing: 8) {
                    Text("Transfer complete").font(.subheadline.weight(.semibold))
                    if !urls.isEmpty {
                        Button("Reveal in Finder") {
                            NSWorkspace.shared.activateFileViewerSelecting(urls)
                        }
                    }
                    Button("Done") { model.cancel() }.buttonStyle(.link)
                }
            }

            if case let .failed(message) = model.state {
                Text(message)
                    .font(.callout).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let stagingError {
                Text(stagingError)
                    .font(.callout).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - start

    private var start: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Send").font(.headline)
                Text(picked.isEmpty ? "Choose files, then create a code for the other device."
                                    : "\(picked.count) file\(picked.count == 1 ? "" : "s") ready.")
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("Choose Files…") { chooseFiles() }
                    Button("Create a code") { Task { await mintAndWait() } }
                        .buttonStyle(.borderedProminent)
                        .disabled(picked.isEmpty)
                }
            }

            Divider()

            VStack(alignment: .leading, spacing: 6) {
                Text("Receive").font(.headline)
                HStack {
                    TextField("Code", text: $model.joinCode)
                        .textFieldStyle(.roundedBorder)
                        .frame(maxWidth: 140)
                        .onChange(of: model.joinCode) { model.updateJoinCode($0) }
                    Button("Join") { Task { await model.join(code: model.joinCode) } }
                        .disabled(!model.canJoin)
                }
            }
        }
    }

    private func showing(code: String, expiresAt: Int64) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Give this code to the other device").font(.subheadline.weight(.semibold))
            Text(code)
                .font(.system(size: 34, weight: .semibold, design: .monospaced))
                .textSelection(.enabled)
            Text("Expires \(Date(timeIntervalSince1970: TimeInterval(expiresAt)).formatted(date: .omitted, time: .shortened))")
                .font(.caption).foregroundStyle(.secondary)
            QRCodeView(url: "\(AppEnvironment.productionBaseURL.absoluteString)/cross-network#c=\(code)")
            Text("Or scan this on a phone.").font(.caption).foregroundStyle(.secondary)
            ProgressView("Waiting for the other device…").controlSize(.small)
            Button("Cancel") { model.cancel() }
        }
    }

    // MARK: - the SAS gate

    private func verifying(_ sas: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Check this matches").font(.subheadline.weight(.semibold))
            Text(sas)
                .font(.system(size: 26, weight: .semibold, design: .monospaced))
                .textSelection(.enabled)
            Text("The other device should be showing exactly this. If it isn't, someone may be intercepting the connection.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            // Equally weighted on purpose: a visually secondary reject is a
            // reject nobody presses, on the one screen where pressing it is the
            // entire point.
            HStack {
                Button("They match") { model.confirmSAS() }
                    .buttonStyle(.borderedProminent)
                Button("They don't match") { model.rejectSAS() }
            }
        }
    }

    private func transferring(done: Int, total: Int) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ProgressView(value: total > 0 ? Double(done) / Double(total) : 0)
            Text(total > 0 ? "\(done * 100 / total)%" : "Starting…")
                .font(.caption).foregroundStyle(.secondary)
            ForEach(model.incoming, id: \.name) { f in
                Text(safeDisplayName(f.name)).font(.caption).foregroundStyle(.secondary)
            }
            Button("Cancel") { model.cancel() }
        }
    }

    // MARK: - actions

    private func chooseFiles() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false      // folder recursion is out of scope
        if panel.runModal() == .OK {
            picked = panel.urls
            stagingError = nil
        }
    }

    private func mintAndWait() async {
        await model.mintCode(token: token)
        guard case let .showingCode(code, _) = model.state else { return }
        stageAndJoin(code: code)
    }

    private func stageAndJoin(code: String) {
        guard !picked.isEmpty, picked.count <= MAX_FILES else {
            stagingError = "Choose between 1 and \(MAX_FILES) files."
            model.cancel()
            return
        }
        var sources: [PlaintextSource] = []
        var metas: [FileMeta] = []
        do {
            for url in picked {
                let s = try FileURLSource(url: url)
                sources.append(s)
                metas.append(FileMeta(name: s.name, size: s.size))
            }
            _ = try validateRealtimeFiles(metas)
        } catch {
            stagingError = "Couldn't open every selected file. Nothing was sent. \(error.localizedDescription)"
            model.cancel()
            return
        }
        stagingError = nil
        model.stageSend(sources: sources, metas: metas)
        Task { await model.join(code: code, role: .initiator) }
    }
}
