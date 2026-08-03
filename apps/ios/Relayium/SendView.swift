import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import RelayiumAppKit

/// Choose files, folders, photos or videos; encrypt them here; upload the
/// ciphertext to this account; hand the link to the share sheet.
///
/// Two layers, in this order: a gate that decides what is DRAWN, and beneath it
/// `CloudUploadModel`'s existing states, reused verbatim. Nothing about the
/// account is decided here — the gate is presentation only. Cancelling an
/// upload and clearing what an account owned is `SendSelectionModel`'s job,
/// driven by the session, and it happens whether or not this view has ever been
/// mounted. A gate that switched to "you need an account" while an upload
/// continued behind it would be hiding a live transfer; after isolation there is
/// nothing left to hide.
///
/// The view holds no selection, no security scope, no staging directory and no
/// bearer. It renders four published properties on `SendSelectionModel` and
/// `CloudUploadModel`'s state, and it reads `session.bearerToken` once, at the
/// moment Send is tapped.
struct SendView: View {
    @ObservedObject var upload: CloudUploadModel
    @ObservedObject var selection: SendSelectionModel
    /// Selects the Account tab. A closure rather than a session read, which is
    /// what lets `RootView` stay ignorant of the account entirely.
    let onOpenAccount: () -> Void

    @EnvironmentObject private var session: AccountSession

    @State private var isChoosingFiles = false
    /// The Photos picker's binding, reset to empty immediately after each
    /// capture so choosing the SAME items again is a change again.
    @State private var picked: [PhotosPickerItem] = []

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    availability
                }
                .padding()
                // Leading, not centred: at the largest Dynamic Type sizes a
                // centred ragged column is unreadable.
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle(L10n.t(.uploadHeading))
        }
    }

    // MARK: - the gate

    /// Presentation only. Every case is mapped in `SendAvailability`, where a
    /// test can read it, rather than in this `switch`.
    @ViewBuilder
    private var availability: some View {
        switch SendAvailability.state(for: session.state) {
        case .checking:
            ProgressView { Text(L10n.t(.accountRestoring)) }

        case .needsAccount:
            accountPanel(title: L10n.t(.sendAccountTitle),
                         message: L10n.t(.sendAccountBody))

        case .accountUnavailable:
            // A different fact from "you need an account": this user IS signed
            // in, and telling them to sign in would be a false sentence with a
            // useless remedy. Both route to the same place; neither renders a
            // second sign-in form.
            accountPanel(title: L10n.t(.contentAccountLoadFailed),
                         message: L10n.t(.sendAccountUnavailableBody))

        case .ready:
            flow
        }
    }

    private func accountPanel(title: String, message: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.headline)
            Text(message)
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button(action: onOpenAccount) {
                Text(L10n.t(.sendOpenAccount)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
    }

    // MARK: - the upload flow, under `.ready`

    @ViewBuilder
    private var flow: some View {
        switch upload.state {
        case .idle:
            choosing
        case .picked:
            choosing
            options
        case let .uploading(sent, total):
            uploading(sent: sent, total: total)
        case let .done(link, expiresAt, keyWarning):
            linkReady(link: link, expiresAt: expiresAt, keyWarning: keyWarning)
        case let .failed(message):
            failure(message)
        }
    }

    /// The two sources, the line describing what they produced, and the two
    /// failures that can come out of preparing it.
    ///
    /// Both controls are disabled while an import is running or an upload is in
    /// flight. That is a COURTESY, not the safety mechanism: the model
    /// supersedes a newer intent correctly either way, which is exactly what
    /// makes disabling them safe to be merely cosmetic.
    private var choosing: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let summary = selection.summary {
                HStack(spacing: 12) {
                    Text(summary).font(.headline)
                    Spacer(minLength: 0)
                    Button(L10n.t(.commonClear)) { selection.clear() }
                        .disabled(busy)
                }
                // One element, so VoiceOver reads "3 files" rather than
                // stopping on each fragment of the summary.
                .accessibilityElement(children: .combine)
            }

            if selection.isImportingPhotos {
                // Labelled rather than a bare spinner: staging copies bytes and
                // takes time, and a bare spinner says nothing at all to
                // VoiceOver.
                ProgressView { Text(L10n.t(.sendPreparingPhotos)) }
            }

            // Above the actions they qualify, in reading order.
            if let importError = selection.importError { failureLine(importError) }
            if let preparationError = selection.selectionError { failureLine(preparationError) }

            Button { isChoosingFiles = true } label: {
                Text(L10n.t(.commonChooseFilesOrFolders)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .disabled(busy)

            PhotosPicker(selection: $picked,
                         maxSelectionCount: PHOTO_IMPORT_MAX,
                         matching: .any(of: [.images, .videos])) {
                Text(L10n.t(.sendChoosePhotos)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .disabled(busy)
        }
        // `[.item, .folder]`, so a folder is choosable and its contents are
        // expanded inside the security scope the model starts before anything
        // enumerates them.
        .fileImporter(isPresented: $isChoosingFiles,
                      allowedContentTypes: [.item, .folder],
                      allowsMultipleSelection: true) { result in
            selection.chooseFiles(result)
        }
        .onChange(of: picked) { items in
            // An empty change is OUR OWN reset below — never a product change,
            // and never `importPhotos(count: 0)`, which would clear a selection
            // the user did not ask to clear. Cancelling the system picker
            // changes the binding not at all, so it changes nothing here either.
            guard case let .importItems(count) = PhotoPickerChange.decide(itemCount: items.count)
            else { return }
            let captured = items          // import from the CAPTURED array…
            picked = []                   // …and reset now, so choosing the same
                                          // items again fires this again.
            Task {
                await selection.importPhotos(count: count) { index in
                    guard let staged = try await captured[index]
                            .loadTransferable(type: StagedPhotoFile.self)
                    else { throw PhotoImportError.unusable }
                    return staged.candidate
                }
            }
        }
    }

    /// How long the link lives, whether it burns, and Send.
    ///
    /// `ttlChoices` is already narrowed to this account's plan by
    /// `SendSelectionModel`, which applies the caps the session and
    /// `GET /api/config` supply — so an option shown here is one the server will
    /// accept.
    private var options: some View {
        VStack(alignment: .leading, spacing: 16) {
            Picker(L10n.t(.uploadExpiresAfter), selection: $upload.ttl) {
                ForEach(upload.ttlChoices, id: \.self) { secs in
                    Text(TtlPresentation.label(seconds: secs)).tag(secs)
                }
            }
            .pickerStyle(.menu)

            Toggle(L10n.t(.uploadBurnAfterRead), isOn: $upload.burnAfterRead)

            Button(action: send) {
                Text(L10n.t(.commonSend)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(busy)
            // Hidden from the accessibility tree rather than merely dimmed
            // while a request is in flight: a dimmed control is still something
            // VoiceOver offers to activate.
            .accessibilityHidden(busy)
        }
    }

    private func uploading(sent: Int, total: Int) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            ProgressView(value: Double(sent), total: Double(max(total, 1))) {
                Text(L10n.t(.uploadHeading))
            } currentValueLabel: {
                Text(L10n.percent(done: sent, total: total) ?? L10n.t(.commonStarting))
            }
            // Above Cancel, in reading order: this is the foreground-only truth,
            // and there is no background transfer and no resume to soften it.
            Text(L10n.t(.uploadKeepOpen))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button(L10n.t(.commonCancel)) { upload.cancel() }
        }
    }

    /// Finished: one statement about the key, the link itself, and the
    /// platform's own hand-off.
    private func linkReady(link: String, expiresAt: Int64, keyWarning: String?) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(L10n.t(.uploadLinkReady)).font(.headline)
            // Exactly one statement, decided in `UploadPresentation` where it is
            // tested: after a successful save the key really is on this device
            // and the Account tab can hand this link back, so "this link is the
            // only copy" would be false on the common path and would contradict
            // the warning on the rare one.
            keyNotice(UploadPresentation.keyNotice(warning: keyWarning))
            // Selectable text and `ShareLink`, never a pasteboard write: an app
            // that puts things on the clipboard behind the user's back is doing
            // the thing this product promises not to do, and iOS would raise its
            // paste notification for it besides.
            Text(link)
                .textSelection(.enabled)
                .lineLimit(1)
                .truncationMode(.middle)
            ShareLink(item: link) {
                Text(L10n.t(.commonShare)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            Text(L10n.t(.commonExpires, [
                L10n.date(Date(timeIntervalSince1970: TimeInterval(expiresAt)),
                          dateStyle: .medium, timeStyle: .short),
            ]))
                .font(.footnote)
                .foregroundStyle(.secondary)
            Button(L10n.t(.uploadSendAnother)) { upload.reset() }
        }
    }

    private func failure(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            failureLine(text)
            // `reset`, not `clearSelection`: a failure must not make the user
            // choose every file again.
            Button(L10n.t(.commonTryAgain)) { upload.reset() }
                .buttonStyle(.bordered)
                .controlSize(.large)
        }
    }

    @ViewBuilder
    private func keyNotice(_ notice: UploadKeyNotice) -> some View {
        if notice.isWarning {
            failureLine(notice.text)
        } else {
            Text(notice.text)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// A failure line. The icon carries the label rather than sitting beside an
    /// unlabelled image, so VoiceOver reads the sentence and not "image".
    private func failureLine(_ text: String) -> some View {
        Label {
            Text(text)
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
        }
        .font(.callout)
        .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: - actions

    private var busy: Bool { upload.isBusy || selection.isImportingPhotos }

    /// The one place in this app that reads the bearer, and it reads it at the
    /// moment of use.
    ///
    /// It is stored in no `@State`, no stored property and no `@Published` — a
    /// credential has no business in the view-update surface — so the button's
    /// ENABLEMENT comes from the session state above and its ACTION re-reads the
    /// token. A sign-out that lands between the button being enabled and the
    /// button being tapped therefore produces an honest refusal rather than a
    /// request with an empty bearer.
    private func send() {
        guard let token = session.bearerToken, !token.isEmpty else {
            upload.fail(L10n.t(.errorCloudUnauthorized))
            return
        }
        upload.start(token: token)
    }
}
