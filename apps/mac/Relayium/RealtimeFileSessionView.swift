import SwiftUI
import RelayiumAppKit
import RelayiumKit

/// The part of a realtime file session that looks the same however the peer was
/// reached: connecting, the SAS gate, progress, completion.
///
/// Extracted so the pairing-code pane and the nearby pane cannot drift — in
/// particular so the verification gate is rendered by ONE view. A second copy
/// of `verifying` is a second place for "They don't match" to lose its weight,
/// or to quietly stop being reached at all.
///
/// Renders nothing for the states that are specific to how a session started
/// (`.idle`, `.failed`, `.minting`, `.showingCode`); each pane owns those.
struct RealtimeFileSessionView: View {
    @ObservedObject var model: RealtimeSessionModel

    var body: some View {
        switch model.state {
        case .idle, .failed, .minting, .showingCode:
            EmptyView()
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
    }

    /// Reached only with advanced verification ON. With it off the model goes
    /// straight from `connecting` to `transferring`, so this view is simply
    /// never built — the gate is a model state, not a hidden button here.
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
}
