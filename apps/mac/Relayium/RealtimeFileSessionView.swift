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
                ProgressView(L10n.t(.sessionConnecting)).controlSize(.small)
                Button(L10n.t(.commonCancel)) { model.cancel() }
            }
        case let .verifying(sas):
            verifying(sas)
        case let .transferring(done, total):
            transferring(done: done, total: total)
        case .completed:
            VStack(alignment: .leading, spacing: 8) {
                Text(L10n.t(.sessionTransferComplete)).font(.subheadline.weight(.semibold))
                // Only a RECEIVE has a payload. A sender reaches `.completed`
                // with no URLs of its own, and offering it a drag source would
                // be offering files it never wrote.
                if let payload = model.received {
                    ReceivedResultView(payload: payload)
                }
                Button(L10n.t(.commonDone)) { model.cancel() }.buttonStyle(.link)
            }
        }
    }

    /// Reached only with advanced verification ON. With it off the model goes
    /// straight from `connecting` to `transferring`, so this view is simply
    /// never built — the gate is a model state, not a hidden button here.
    private func verifying(_ sas: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n.t(.sessionCheckMatches)).font(.subheadline.weight(.semibold))
            SecurityCodeText(code: sas, style: .verification)
            Text(L10n.t(.sessionCheckMatchesBody))
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            // Equally weighted on purpose: a visually secondary reject is a
            // reject nobody presses, on the one screen where pressing it is the
            // entire point.
            HStack {
                Button(L10n.t(.sessionTheyMatch)) { model.confirmSAS() }
                    .buttonStyle(.borderedProminent)
                Button(L10n.t(.sessionTheyDontMatch)) { model.rejectSAS() }
            }
        }
    }

    private func transferring(done: Int, total: Int) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ProgressView(value: Double(done), total: Double(max(total, 1))) {
                Text(L10n.t(.sessionTransferProgress))
            } currentValueLabel: {
                Text(L10n.percent(done: done, total: total) ?? L10n.t(.commonStarting))
            }
            // Keyed by index: a folder legitimately contains two files with the
            // same leaf name in different subdirectories, and `id: \.name` would
            // collapse them into one row (and warn about duplicate ids). The
            // relative path is what the user needs to see anyway.
            ForEach(Array(model.incoming.enumerated()), id: \.offset) { _, f in
                Text(safeDisplayName(f.path ?? f.name))
                    .font(.caption).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle)
            }
            Button(L10n.t(.commonCancel)) { model.cancel() }
        }
    }
}
