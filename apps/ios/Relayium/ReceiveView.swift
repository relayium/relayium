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
///
/// **Phase C: one card per step of the one task.** It was a flat column — a
/// field, a button, then whichever state the model was in, each twelve points
/// below the last with nothing to say where one thing stopped and the next
/// began. The manifest a person is deciding on had the same visual weight as
/// the sentence about what a Relayium link is. Now the link input is a card,
/// and each state that has content of its own is a card titled with the one
/// fact that state is about: what the link holds before saving, and what was
/// saved after. The two states that are only a wait — resolving and
/// downloading — stay uncarded, because a card around a progress bar is a box
/// around a sentence.
struct ReceiveView: View {
    @ObservedObject var model: CloudDownloadModel

    /// How to leave, when this screen is PRESENTED rather than browsed to.
    ///
    /// Nil is the browsed case and renders no control: a destination the user
    /// selected is one they leave by selecting another, and a Done button on it
    /// would be an exit from nowhere. Non-nil is the shell presenting this over
    /// the surface the user was on, where an explicit dismissal is required —
    /// a sheet that can only be closed by a swipe is a sheet a VoiceOver user
    /// cannot leave, and one whose only exit is the gesture leaves no way to say
    /// where the user goes back to.
    ///
    /// It is a closure rather than `@Environment(\.dismiss)` because dismissing
    /// this sheet is a NAVIGATION event: the shell's selection has to move back
    /// to the surface underneath, and a bare `dismiss()` would close the sheet
    /// while `AppNavigationModel` still said `.storedReceive` — leaving the next
    /// link a no-op change that raises nothing.
    var onDismiss: (() -> Void)?

    /// A failure to resolve the app's own receive folder, which happens before
    /// the model is involved at all and therefore has no state case to live in.
    /// Cleared whenever a new attempt starts, so it cannot outlive its cause.
    @State private var destinationError: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Metrics.section) {
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
            // **In the content layer, not the navigation bar — because of a
            // measured Dynamic Type failure, not taste.** The system audit of
            // this screen's PRESENTED form — the only form users now meet,
            // since `storedReceive` stopped being a tab — rejected a toolbar
            // Done with "Dynamic Type font sizes are partially unsupported",
            // and it was right: this platform's toolbar draws its buttons at a
            // fixed size and discards a `.font` given to the item or to its
            // label, which three instrumented runs confirmed pixel-identical.
            // This is the sheet's only explicit exit; a reader at an
            // accessibility text size would have found every word on the
            // screen scaled except the one that closes it. A safe-area inset
            // keeps it above the scrolled content — reachable however far the
            // page is scrolled, exactly the property the bar gave it — while
            // letting it scale like every other word on the screen.
            .safeAreaInset(edge: .top, alignment: .trailing, spacing: 0) {
                if let onDismiss {
                    Button(action: onDismiss) {
                        Text(L10n.t(.commonDone)).font(.body.weight(.semibold))
                    }
                    .textAction()
                    .padding(.horizontal)
                    .padding(.bottom, Metrics.tight)
                    .accessibilityIdentifier("stored-receive-done")
                }
            }
        }
    }

    // MARK: - input

    /// Untitled, and deliberately: the only honest title it could carry is
    /// "Receive files", which the navigation bar directly above it already
    /// says. That is the repetition the Mac's second audit removed, and the
    /// rule `SectionCard` is documented with.
    private var linkField: some View {
        SectionCard {
            // An ordinary text field, with the system's own paste affordance.
            // The app never reads `UIPasteboard` itself: a receive app that
            // silently inspects the clipboard at launch is doing exactly what
            // this product promises not to do, and iOS would show the paste
            // notification for it.
            TextField(L10n.t(.downloadLinkPlaceholder), text: $model.linkText, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                // Keep the purpose available after the placeholder disappears
                // behind pasted text, for VoiceOver and runtime acceptance.
                .accessibilityLabel(L10n.t(.downloadLinkPlaceholder))
                .accessibilityIdentifier("receive.link")
                .lineLimit(1...3)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                // `onSubmit` alone is a promise this field cannot keep. On a
                // vertical-axis TextField the Go key inserts a NEWLINE rather
                // than submitting, so the key the keyboard advertises did
                // nothing — and a link is pasted, which makes Go the natural way
                // to finish. Treat a newline as the submission it was meant to
                // be, and take it back out of the value so a wrapped link never
                // carries one.
                .onChange(of: model.linkText) { value in
                    guard value.contains("\n") else { return }
                    model.linkText = value.replacingOccurrences(of: "\n", with: "")
                    resolve()
                }
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
            // The shared empty-state role, and the same one the Mac's idle
            // download pane draws: a landmark, the fact that decides whether
            // this destination is the right one, and — as the detail line — the
            // reason it needs nothing else. It is the first thing anybody sees
            // in this app, so it is a designed state rather than two loose
            // labels under an empty field.
            // nonlocalized: SF Symbol name
            EmptyStateView(symbol: "link",
                           message: L10n.t(.downloadIdleHint),
                           detail: L10n.t(.downloadNoAccountNeeded))

        case .resolving:
            VStack(alignment: .leading, spacing: Metrics.inner) {
                // Labelled rather than a bare spinner: on a screen with nothing
                // else on it a spinner says nothing, and VoiceOver reads
                // nothing at all.
                ProgressView { Text(L10n.t(.downloadResolving)) }
                cancelButton
            }

        case .ready(let manifest, let expiresAt, let burn):
            ready(manifest, expiresAt: expiresAt, burnAfterRead: burn)

        case .downloading(let received, let total):
            VStack(alignment: .leading, spacing: Metrics.inner) {
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
            VStack(alignment: .leading, spacing: Metrics.inner) {
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
                    .borderedAction()
                    .controlSize(.large)
                }
            }
        }
    }

    /// What the link holds, decided on before anything is spent.
    ///
    /// The card's TITLE is the summary — "3 files · 12.4 MB" — which is the one
    /// question this state answers, and the same hierarchy move the nearby
    /// tab's receiving card made: VoiceOver announces it once on entering the
    /// group and then reads the manifest, instead of reading a headline, five
    /// rows, a caution, an expiry and a button as nine peers.
    private func ready(_ manifest: StoredManifest, expiresAt: Int64,
                       burnAfterRead: Bool) -> some View {
        let total = manifest.files.reduce(0) { $0 + $1.size }
        return SectionCard(DownloadPresentation.manifestSummary(
            fileCount: manifest.files.count, totalBytes: Int64(total))) {
            VStack(alignment: .leading, spacing: Metrics.tight) {
                // By index, not by name: a folder upload keeps its hierarchy in
                // `name`, so two entries can share a leaf and duplicate ids
                // would silently drop a row from the list the user is deciding
                // on.
                ForEach(Array(manifest.files.enumerated()), id: \.offset) { _, file in
                    HStack(alignment: .firstTextBaseline, spacing: Metrics.inner) {
                        Text(FileIdentityPresentation.name(for: file))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            // This is the pre-save consent surface. Preserve the
                            // complete relative path so a long name cannot hide
                            // which file the user is about to receive.
                            .fixedSize(horizontal: false, vertical: true)
                        Text(L10n.bytes(Int64(file.size))).fixedSize()
                    }
                    .font(.callout)
                    .foregroundStyle(.secondary)
                }
            }
            if burnAfterRead {
                // Stated before it costs something, not as a footnote after,
                // and in the shared warning role rather than this screen's own
                // flame: it is the same kind of statement the rest of the app
                // marks that way, and the symbol beside it carries the meaning
                // for a reader the orange does not reach.
                InlineMessage(.warning, L10n.t(.downloadBurnNotice))
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
    ///
    /// The card is untitled and the summary is its first line, which is the one
    /// place this flow deviates from "the state's fact is the card's title":
    /// the green check has to sit beside the sentence, and a `SectionCard`
    /// title is a `String`. So the Label carries the header trait instead, and
    /// VoiceOver still meets "Saved 3 files" on entering the group.
    private func done(fileCount: Int) -> some View {
        SectionCard {
            Label {
                Text(DownloadPresentation.savedSummary(fileCount: fileCount))
            } icon: {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
            }
            .font(.headline)
            .accessibilityAddTraits(.isHeader)
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
                .borderedAction()
                .controlSize(.large)
                .accessibilityIdentifier("received.share")
            }
            // Addressed, because "Done" is the most reused word in the app and
            // this one ends a task with bytes on disk behind it: the acceptance
            // path that proves it returns to the empty entry — and that it does
            // NOT delete what was saved — has to name this button rather than
            // whichever Done a query happened to find.
            Button {
                destinationError = nil
                model.dismissResult()
            } label: {
                Text(L10n.t(.commonDone)).frame(maxWidth: .infinity)
            }
            .borderedAction()
            .controlSize(.large)
            .accessibilityIdentifier("receive.done")
        }
    }

    /// Every failure this screen can state — a refused link, a transfer that
    /// stopped, a receive folder that could not be resolved — said the same way
    /// as every failure in the rest of the app. It was this file's own copy of
    /// the same six lines.
    private func failure(_ message: String) -> some View {
        InlineMessage(.warning, message)
    }

    private var cancelButton: some View {
        Button(L10n.t(.commonCancel), action: model.cancel)
            .borderedAction()
            .controlSize(.large)
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
