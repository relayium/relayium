import SwiftUI
import RelayiumAppKit
import RelayiumKit

/// Opening a stored link: paste it, see what is in it, save it.
///
/// **Nothing here consults the account.** A stored link is downloaded with no
/// credential of any kind — `AnonymousCapabilityTests` proves that at the
/// transport, request by request — and this file holds no session object so it
/// cannot start.
///
/// Every state is designed. `.idle` used to render `EmptyView()`: a link field
/// above a blank rectangle, saying nothing about what to paste or why the key
/// never leaves the client. `.resolving` was a bare spinner with no label,
/// `.downloading` a progress bar with no figure, and `.failed` a red line with
/// no way out.
struct DownloadPane: View {
    @ObservedObject var model: CloudDownloadModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !model.isComplete {
                HStack {
                    TextField(L10n.t(.downloadLinkPlaceholder), text: $model.linkText)
                        .textFieldStyle(.roundedBorder)
                        .accessibilityLabel(L10n.t(.downloadLinkPlaceholder))
                        .accessibilityIdentifier("receive.link")
                        .onSubmit { model.resolve() }
                        .disabled(model.isBusy)
                    // Empty means the missing prerequisite is the field beside it,
                    // and supplying it is one paste away. Busy is different: this
                    // model already owns a writer and Cancel handle, so another
                    // Open must wait rather than replace them.
                    Button(L10n.t(.downloadOpen)) { model.resolve() }
                        .keyboardShortcut(.defaultAction)
                        .disabled(model.linkText.isEmpty || model.isBusy)
                }
            }
            switch model.state {
            case .idle:
                // The hint IS the state: it names the one action and the reason
                // this destination needs nothing else — the key rides in the
                // fragment, which never reaches a server.
                EmptyStateView(symbol: "link", title: L10n.t(.downloadIdleHint))
            case .resolving:
                ProgressView(L10n.t(.downloadResolving)).controlSize(.small)
                Button(L10n.t(.commonCancel)) { model.cancel() }
                    .buttonStyle(.bordered)
            case .ready(let manifest, let expiresAt, let burn):
                let total = manifest.files.reduce(0) { $0 + $1.size }
                Text(DownloadPresentation.manifestSummary(fileCount: manifest.files.count,
                                                          totalBytes: Int64(total)))
                    .font(.subheadline.weight(.semibold))
                // By index, not by name: a folder upload keeps its hierarchy in
                // `name`, so two entries can share a leaf and duplicate ids
                // would silently drop a row from the list the user is deciding
                // on.
                ForEach(Array(manifest.files.enumerated()), id: \.offset) { _, f in
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Text(FileIdentityPresentation.name(for: f))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            // The manifest is the user's confirmation before
                            // Save. A long relative path must remain inspectable.
                            .fixedSize(horizontal: false, vertical: true)
                        Text(L10n.bytes(Int64(f.size))).fixedSize()
                    }
                    .font(.caption).foregroundStyle(.secondary)
                }
                if burn {
                    // Stated before it costs something, not as a footnote after.
                    InlineMessage(.warning, L10n.t(.downloadBurnNotice))
                }
                Text(L10n.t(.commonExpires, [
                    L10n.date(Date(timeIntervalSince1970: TimeInterval(expiresAt)),
                              dateStyle: .medium, timeStyle: .short),
                ]))
                    .font(.caption).foregroundStyle(.secondary)
                Button(L10n.t(.downloadSave)) { chooseDestination() }
                    .buttonStyle(.borderedProminent)
            case .downloading(let received, let total):
                ProgressView(value: total > 0 ? Double(received) / Double(total) : 0)
                    .accessibilityLabel(L10n.t(.downloadInProgress))
                    .accessibilityValue(
                        L10n.percent(done: received, total: total) ?? L10n.t(.commonStarting))
                Text(L10n.percent(done: received, total: total) ?? L10n.t(.downloadInProgress))
                    .font(.caption).foregroundStyle(.secondary)
                PendingFileList(sessionFiles: model.sessionFiles)
                Button(L10n.t(.commonCancel)) { model.cancel() }
            case .done(let urls):
                Text(DownloadPresentation.savedSummary(fileCount: urls.count))
                    .font(.subheadline.weight(.semibold))
                if let payload = model.received {
                    ReceivedResultView(payload: payload)
                }
                PendingFileList(sessionFiles: model.sessionFiles)
                // Addressed, because "Done" is the most reused word in the app
                // and this one ends a task that has bytes on disk behind it: the
                // acceptance path that proves it returns to the empty entry —
                // and proves it does NOT delete what was saved — must be able to
                // name this button rather than whichever Done a query found.
                Button(L10n.t(.commonDone)) { model.dismissResult() }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("download.done")
            case .failed(let message):
                InlineMessage(.failure, message)
                PendingFileList(sessionFiles: model.sessionFiles)
                // Offered only where the model says a second attempt can end
                // differently, and it repeats the work that actually failed —
                // resolution, or the transfer into the folder already chosen.
                //
                // This used to be unconditional and hard-wired to `resolve()`:
                // the same button for a burnt link, a 404 and a dropped
                // connection, and after a failure mid-transfer it walked the
                // user back to a confirmation card they had already accepted.
                // The rule lives in `CloudDownloadModel`, on the typed error, so
                // it is testable and does not depend on which of nine languages
                // the message above is in. A corrected link still needs no
                // button at all: the field and its Open action are always there.
                if model.canRetry {
                    Button(L10n.t(.commonTryAgain)) { model.retry() }
                }
            }
        }
    }

    private func chooseDestination() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        panel.prompt = L10n.t(.downloadSavePanelPrompt)
        if panel.runModal() == .OK, let dir = panel.url { model.download(into: dir) }
    }
}
