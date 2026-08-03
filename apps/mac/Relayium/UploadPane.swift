import SwiftUI
import UniformTypeIdentifiers
import RelayiumAppKit

struct UploadPane: View {
    @ObservedObject var model: CloudUploadModel
    let token: String

    /// The pane owns the selection; the model owns what is being uploaded. They
    /// are kept in step through `model.pick`, so the model still refuses an
    /// oversized file and still has something to return to after a cancel.
    @StateObject private var selection = SelectionStore()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n.t(.uploadHeading)).font(.headline)
            switch model.state {
            case .idle:
                dropZone(hint: L10n.t(.uploadDropHint))
            case .picked:
                dropZone(hint: selection.summary ?? L10n.t(.uploadReady))
                Button(L10n.t(.commonClear)) { selection.clear() }.buttonStyle(.link)
                options
                Button(L10n.t(.commonSend)) { model.start(token: token) }
                    .buttonStyle(.borderedProminent)
                    .disabled(token.isEmpty)
            case .uploading(let sent, let total):
                ProgressView(value: total > 0 ? Double(sent) / Double(total) : 0)
                Text(L10n.percent(done: sent, total: total) ?? L10n.t(.commonStarting))
                    .font(.caption).foregroundStyle(.secondary)
                Button(L10n.t(.commonCancel)) { model.cancel() }
            case .done(let link, let expiresAt, let keyWarning):
                Text(L10n.t(.uploadLinkReady)).font(.subheadline.weight(.semibold))
                // Exactly one statement about the key, decided in
                // UploadPresentation where it is tested. Which one is not
                // cosmetic: after a successful save the key really is on this
                // Mac and the Account tab can hand this link back, so the old
                // fixed "this link is the only copy" line was false on the
                // common path — and it contradicted the warning on the rare one.
                keyNotice(UploadPresentation.keyNotice(warning: keyWarning))
                HStack {
                    Text(link).textSelection(.enabled).lineLimit(1).truncationMode(.middle)
                    Button(L10n.t(.commonCopy)) {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(link, forType: .string)
                    }
                }
                Text(L10n.t(.commonExpires, [
                    L10n.date(Date(timeIntervalSince1970: TimeInterval(expiresAt)),
                              dateStyle: .medium, timeStyle: .short),
                ]))
                    .font(.caption).foregroundStyle(.secondary)
                Button(L10n.t(.uploadSendAnother)) { model.reset() }.buttonStyle(.link)
            case .failed(let message):
                Text(message).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                Button(L10n.t(.commonTryAgain)) { model.reset() }
            }
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
    }

    @ViewBuilder
    private func keyNotice(_ notice: UploadKeyNotice) -> some View {
        if notice.isWarning {
            Label(notice.text, systemImage: "exclamationmark.triangle")
                .font(.caption).foregroundStyle(.orange)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            Text(notice.text)
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var options: some View {
        HStack(spacing: 16) {
            Picker(L10n.t(.uploadExpiresAfter), selection: $model.ttl) {
                ForEach(model.ttlChoices, id: \.self) { secs in
                    Text(TtlPresentation.label(seconds: secs)).tag(secs)
                }
            }
            .frame(maxWidth: 220)
            Toggle(L10n.t(.uploadBurnAfterRead), isOn: $model.burnAfterRead)
        }
    }

    private func dropZone(hint: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            FileDropZone(store: selection, isBusy: model.isBusy) {
                Text(hint)
                    .font(.caption).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button(L10n.t(.commonChooseFilesOrFolders)) { chooseFilesOrFolders(into: selection) }
        }
    }
}
