import SwiftUI
import RelayiumAppKit
import RelayiumKit

/// Paste a link, see what it holds, save it, hand it to the rest of iOS.
///
/// The view holds no transport, path or business rule. Every one of those lives
/// in `CloudDownloadModel` and the helpers around it, which is what makes this
/// flow identical to the macOS pane's below the surface and lets `swift test`
/// cover the parts that can be wrong.
///
/// Two things it is responsible for, and they are the reason it is not a thin
/// wrapper:
///
/// * the burn-after-read warning is rendered in `.ready`, ABOVE the download
///   action, so it is read before the network call that consumes the link
///   rather than explaining afterwards what was spent;
/// * the share affordance is built from `model.received`, which is non-nil only
///   in `.done`, which the model reaches only after `ManifestWriter.finish()`
///   returned. Nothing here can offer a half-written file.
struct ReceiveView: View {
    @ObservedObject var model: CloudDownloadModel

    /// A failure to resolve the app's own receive folder, which happens before
    /// the model is involved at all and therefore has no state case to live in.
    /// Cleared whenever a new attempt starts, so it cannot outlive its cause.
    @State private var destinationError: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if !model.isComplete {
                        linkField
                    }
                    if let destinationError {
                        failure(destinationError)
                    }
                    stateSection
                }
                .padding()
                // Leading, not centred: with the largest Dynamic Type sizes the
                // column becomes a single ragged edge, and a centred one is
                // unreadable.
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle(L10n.t(.downloadHeading))
        }
    }

    // MARK: - input

    private var linkField: some View {
        VStack(alignment: .leading, spacing: 12) {
            // An ordinary text field, with the system's own paste affordance.
            // The app never reads `UIPasteboard` itself: a receive app that
            // silently inspects the clipboard at launch is doing exactly what
            // this product promises not to do, and iOS would show the paste
            // notification for it.
            TextField(L10n.t(.downloadLinkPlaceholder), text: $model.linkText, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...3)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .onSubmit(resolve)
                .disabled(model.isBusy)
            Button(action: resolve) {
                Text(L10n.t(.downloadOpen)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(model.linkText.isEmpty || model.isBusy)
        }
    }

    // MARK: - the model's states

    @ViewBuilder
    private var stateSection: some View {
        switch model.state {
        case .idle:
            VStack(alignment: .leading, spacing: 12) {
                Label {
                    Text(L10n.t(.downloadIdleHint))
                } icon: {
                    Image(systemName: "link")
                }
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)

                Label {
                    Text(L10n.t(.downloadNoAccountNeeded))
                } icon: {
                    Image(systemName: "person.crop.circle.badge.checkmark")
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }

        case .resolving:
            VStack(alignment: .leading, spacing: 12) {
                // Labelled rather than a bare spinner: on a screen with nothing
                // else on it a spinner says nothing, and VoiceOver reads
                // nothing at all.
                ProgressView { Text(L10n.t(.downloadResolving)) }
                cancelButton
            }

        case .ready(let manifest, let expiresAt, let burn):
            ready(manifest, expiresAt: expiresAt, burnAfterRead: burn)

        case .downloading(let received, let total):
            VStack(alignment: .leading, spacing: 12) {
                ProgressView(value: Double(received), total: Double(max(total, 1))) {
                    Text(L10n.t(.downloadInProgress))
                } currentValueLabel: {
                    if let percent = L10n.percent(done: received, total: total) {
                        Text(percent)
                    }
                }
                PendingFileList(sessionFiles: model.sessionFiles)
                cancelButton
            }

        case .done(let urls):
            done(fileCount: urls.count)

        case .failed(let message):
            VStack(alignment: .leading, spacing: 12) {
                failure(message)
                PendingFileList(sessionFiles: model.sessionFiles)
                // The same conditional the macOS pane renders, from the same
                // model API. This screen used to show the sentence and nothing
                // else, including for a dropped connection — leaving the user to
                // work out that re-opening the link is what repeats resolution,
                // and offering nothing at all once the transfer itself had
                // started. Which failures are worth repeating is the model's
                // decision, on the typed error, not something inferred here from
                // the text above.
                if model.canRetry {
                    Button { model.retry() } label: {
                        Text(L10n.t(.commonTryAgain)).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.large)
                }
            }
        }
    }

    /// What the link holds, decided on before anything is spent.
    private func ready(_ manifest: StoredManifest, expiresAt: Int64,
                       burnAfterRead: Bool) -> some View {
        let total = manifest.files.reduce(0) { $0 + $1.size }
        return VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 8) {
                Text(DownloadPresentation.manifestSummary(fileCount: manifest.files.count,
                                                          totalBytes: Int64(total)))
                    .font(.headline)
                // By index, not by name: a folder upload keeps its hierarchy in
                // `name`, so two entries can share a leaf and duplicate ids
                // would silently drop a row from the list the user is deciding
                // on.
                ForEach(Array(manifest.files.enumerated()), id: \.offset) { _, file in
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Text(FileIdentityPresentation.name(for: file))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Text(L10n.bytes(Int64(file.size))).fixedSize()
                    }
                    .font(.callout)
                    .foregroundStyle(.secondary)
                }
            }
            if burnAfterRead {
                // Stated before it costs something, not as a footnote after.
                Label {
                    Text(L10n.t(.downloadBurnNotice))
                } icon: {
                    Image(systemName: "flame.fill").foregroundStyle(.orange)
                }
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            }
            Text(L10n.t(.commonExpires, [
                L10n.date(Date(timeIntervalSince1970: TimeInterval(expiresAt)),
                          dateStyle: .medium, timeStyle: .short),
            ]))
                .font(.footnote)
                .foregroundStyle(.secondary)
            Button(action: save) {
                Text(L10n.t(.downloadReceive)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
    }

    /// Finished, on disk, and shareable — in that order.
    private func done(fileCount: Int) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Label {
                Text(DownloadPresentation.savedSummary(fileCount: fileCount))
            } icon: {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
            }
            .font(.headline)
            PendingFileList(sessionFiles: model.sessionFiles)
            // Through `ReceiveDestinationCopy`, not `L10n` directly: the route
            // it names is the one the failures name, derived from the same two
            // constants, so the done state cannot come to point at a different
            // folder than the errors do.
            Text(ReceiveDestinationCopy.savedLocation())
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            // `dragURLs`, not the file list: a folder or multi-file receive
            // offers its CONTAINER as one item, so Save to Files copies the
            // tree in one piece. Sharing the individual files would flatten at
            // the destination exactly the hierarchy the transfer preserved.
            if let payload = model.received, !payload.dragURLs.isEmpty {
                ShareLink(items: payload.dragURLs) {
                    Text(L10n.t(.commonShare)).frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
            }
            Button {
                destinationError = nil
                model.dismissResult()
            } label: {
                Text(L10n.t(.commonDone)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
        }
    }

    private func failure(_ message: String) -> some View {
        Label {
            Text(message)
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
        }
        .font(.callout)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var cancelButton: some View {
        Button(L10n.t(.commonCancel), action: model.cancel)
    }

    // MARK: - actions

    private func resolve() {
        destinationError = nil
        model.resolve()
    }

    /// The destination is the app's own folder rather than one the user picks
    /// per transfer, so it is resolved here and handed to the model unchanged.
    /// Everything the model then does with it — refuse a taken flat name, step a
    /// received folder aside, never merge, never overwrite, clean up a failed
    /// write — is the shared behaviour, not an iOS variant.
    ///
    /// `.appFolder`, not the default: the only failure this `catch` can see is
    /// something occupying the name `Received`, which puts it BESIDE the receive
    /// folder rather than inside it. Recovery copy that named
    /// `Relayium/Received` would send the user into a folder that, in this
    /// failure, is not a folder at all.
    private func save() {
        destinationError = nil
        do {
            model.download(into: try ReceiveDestination.directory())
        } catch {
            destinationError = ReceiveDestinationCopy.message(for: error, in: .appFolder)
        }
    }
}
