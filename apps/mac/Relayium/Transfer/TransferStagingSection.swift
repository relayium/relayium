import SwiftUI
import RelayiumAppKit

/// The files and folders a transfer is going to carry, rendered **inside** the
/// connection method that will carry them.
///
/// ## Dormant: nothing on macOS constructs this
///
/// The real-time transfer screens are connect-first. A session is established
/// before any file or folder is chosen, so neither `LanConnectPane` nor
/// `CrossNetworkConnectPane` renders this section, no app-scoped
/// `SelectionStore` is injected for it, and there is no macOS entry point —
/// button, drop, Finder **Open With** or Dock icon — that reaches pre-connect
/// staging at all. `MacSurfaceGuardTests` asserts each of those absences.
///
/// It is kept, whole and compiling, on purpose. The owner's decision was to
/// remove pre-staging from the product, not from the codebase: re-enabling it is
/// a matter of constructing this again with a store, and the rules below — one
/// drop target, the same live busy re-read the connect controls use, a heading
/// that is a level of hierarchy rather than a card — are the ones that took
/// several rounds to get right and must not have to be rediscovered.
///
/// The doc below describes the surface as it was when it last rendered.
///
/// ## Why it is not a card of its own
///
/// It was one: a third `SectionCard` sitting beside Same network and Pairing
/// code, at the same visual weight, on one merged screen. Three peer cards read
/// as three ways to send something, and staging is not one — it is the *what*
/// that both of the other two carry. So each transfer destination now nests this
/// at the end of its own connection card, where the sentences that point at it
/// ("Choose files or folders below…") are pointing at something inside the same
/// flow rather than at a sibling concept.
///
/// One instance is on screen at a time — the two transfer destinations are two
/// screens — so the accessibility identifiers are shared rather than prefixed
/// per destination, and UI automation addresses the staging controls the same
/// way wherever it navigated from.
///
/// The `SelectionStore` itself is app-scoped and shared by both destinations:
/// somebody who stages a batch and then decides to use a pairing code instead
/// must not have to stage it again.
struct TransferStagingSection: View {
    @ObservedObject var selection: SelectionStore
    /// A live read rather than a render-time copy: resolving dropped item
    /// providers is asynchronous, so a session can start between the drop being
    /// accepted and its URLs arriving.
    let isBusy: () -> Bool

    /// An `OpenSection` rather than a heading above a hand-placed `Divider`: it
    /// is the app's second level of hierarchy, which is exactly what this is —
    /// a named group inside the connection card, not a card of its own and not a
    /// paragraph break.
    var body: some View {
        OpenSection(title: L10n.t(.workspaceStagingHeading)) {
            Text(L10n.t(.workspaceStagingOptional))
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("transfer-staging-optional")
            FileDropZone(store: selection, isBusy: isBusy) {
                Text(selection.summary ?? L10n.t(.workspaceDropHint))
                    .font(.caption).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            PendingFileList(files: selection.files)
            if let message = selection.error {
                InlineMessage(.failure, message)
            }
            HStack {
                Button(L10n.t(.commonChooseFilesOrFolders)) {
                    chooseFilesOrFolders(into: selection)
                }
                .accessibilityIdentifier("transfer-choose-files")
                .disabled(isBusy())
                if !selection.isEmpty {
                    // A task mutation, never navigation: it drops the batch the
                    // user picked.
                    Button(L10n.t(.commonClear)) { selection.clear() }
                        .buttonStyle(.bordered)
                        .disabled(isBusy())
                }
            }
        }
        .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
    }
}
