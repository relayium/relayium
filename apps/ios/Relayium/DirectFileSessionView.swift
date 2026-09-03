import SwiftUI
import RelayiumAppKit
import RelayiumKit

/// The part of a direct FILE session that looks the same however it started:
/// connecting, the verification gate, progress, and the result.
///
/// Extracted from `DirectView` for the reason `RealtimeFileSessionView` was
/// extracted on macOS — one view renders the gate, so "They don't match" cannot
/// quietly lose its weight in a second copy — and for one iOS-specific reason:
/// this screen is where the honest limit of the whole feature is stated, and
/// that sentence belongs beside the progress bar rather than on the screen the
/// user has already left.
///
/// Renders nothing for the states that belong to how a session started
/// (`.idle`, `.failed`, `.minting`, `.showingCode`); `DirectView` owns those.
struct DirectFileSessionView: View {
    @ObservedObject var model: RealtimeSessionModel
    let onDone: () -> Void

    var body: some View {
        switch model.state {
        case .idle, .minting, .showingCode:
            EmptyView()

        case .failed:
            fileList

        case .joining, .connecting:
            VStack(alignment: .leading, spacing: 12) {
                // Labelled, never a bare spinner: on this screen the spinner is
                // the only thing on it, and a bare one reads as nothing at all
                // to VoiceOver.
                ProgressView { Text(L10n.t(.sessionConnecting)) }
                fileList
                Button(L10n.t(.commonCancel)) { model.cancel() }
                    .borderedAction()
                    .controlSize(.large)
            }

        case let .verifying(sas):
            verifying(sas)

        case let .transferring(done, total):
            transferring(done: done, total: total)

        case .completed:
            completed
        }
    }

    /// Reached only with advanced verification ON. With it off — the default —
    /// the model goes straight from `connecting` to `transferring`, so this is
    /// never built: the gate is a model state, not a hidden control here.
    private func verifying(_ sas: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n.t(.sessionCheckMatches)).font(.headline)
            PairingCodeText(code: sas, style: .verification)
            Text(L10n.t(.sessionCheckMatchesBody))
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            fileList
            // Equally weighted on purpose. A visually secondary reject is a
            // reject nobody presses, on the one screen where pressing it is the
            // entire point — so both are full-width and only the confirm is
            // prominent, which is the strongest asymmetry this screen may carry.
            Button(L10n.t(.sessionTheyMatch)) { model.confirmSAS() }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .frame(maxWidth: .infinity)
            Button(L10n.t(.sessionTheyDontMatch), role: .destructive) { model.rejectSAS() }
                .borderedAction(.destructive)
                .controlSize(.large)
                .frame(maxWidth: .infinity)
        }
    }

    private func transferring(done: Int, total: Int) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            // Named as well as measured: two labelled progress views can be on
            // screen in this app at once, and "72%" on its own says nothing
            // about which transfer it belongs to.
            ProgressView(value: Double(done), total: Double(max(total, 1))) {
                Text(L10n.t(.sessionTransferProgress))
            } currentValueLabel: {
                Text(L10n.percent(done: done, total: total) ?? L10n.t(.commonStarting))
            }
            fileList
            // The foreground-only truth, said while it still matters rather than
            // afterwards as an explanation. There is no background transfer and
            // no resume behind it to soften it.
            Text(L10n.t(.directKeepBothOpen))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button(L10n.t(.commonCancel), role: .destructive) { model.cancel() }
                .borderedAction(.destructive)
                .controlSize(.large)
        }
    }

    private var completed: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label {
                Text(FileTransferCompletionPresentation.title(received: model.received != nil))
            } icon: {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
            }
            .font(.headline)

            fileList

            // Only a RECEIVE has a payload, and it is non-nil only in
            // `.completed`, which the model reaches only after
            // `ManifestWriter.finish()` returned. A sender reaches the same
            // state with no URLs of its own, and offering it a share sheet would
            // be offering files it never wrote.
            if let payload = model.received, !payload.dragURLs.isEmpty {
                // The same sentence the stored receive tab renders, from the
                // same two constants, so the app cannot come to name two receive
                // folders.
                Text(ReceiveDestinationCopy.savedLocation())
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                // `dragURLs`, not the file list: a folder or multi-file receive
                // offers its CONTAINER as one item, so *Save to Files* copies
                // the tree in one piece instead of flattening it.
                ShareLink(items: payload.dragURLs) {
                    Text(L10n.t(.commonShare)).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            }

            // `cancel()`, not a bare state reset: it is the one path that also
            // lets go of the connection a terminal state leaves retained.
            Button(L10n.t(.commonDone), action: onDone)
                .borderedAction()
                .controlSize(.large)
        }
    }

    @ViewBuilder
    private var fileList: some View {
        if !model.sessionFiles.isEmpty {
            LazyVStack(alignment: .leading, spacing: 10) {
                ForEach(Array(model.sessionFiles.enumerated()), id: \.offset) { _, file in
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Text(FileIdentityPresentation.name(for: file))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(L10n.bytes(Int64(file.size)))
                            .foregroundStyle(.secondary)
                            .fixedSize()
                    }
                    .font(.footnote)
                    .accessibilityElement(children: .combine)
                }
            }
            .padding(12)
            .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 10))
            .accessibilityElement(children: .contain)
        }
    }
}
