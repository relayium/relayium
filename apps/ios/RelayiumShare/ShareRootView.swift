import SwiftUI
import RelayiumShareKit

/// The whole of what the share sheet shows.
///
/// One screen with four states and no navigation, because it is a sheet inside
/// somebody else's app and the user is two taps from being finished. Every state
/// says the same two things in some form: what is about to happen to their
/// files, and where those files are.
///
/// The layout is a `ScrollView` over a leading-aligned column. Both halves are
/// deliberate: a share sheet is short — roughly half the screen on an iPhone SE —
/// and at the largest Dynamic Type sizes the disclosure paragraph alone is taller
/// than that, so a fixed column would put the Continue button off the bottom with
/// no way to reach it. Leading rather than centred for the same reason `SendView`
/// is: a centred ragged column is unreadable at accessibility sizes.
struct ShareRootView: View {
    @ObservedObject var model: SharedDraftPreparation

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                Divider()
                content
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L10n.t(.shareHeading))
                .font(.headline)
            // ITEMS, not files. The share sheet hands over providers, and one
            // shared folder is one provider and may be a thousand files — so
            // "3 files" here would be a number nothing has measured. The copying
            // label below counts staged files, which is measured.
            //
            // A COUNT and nothing else, either way. The extension never lists
            // the user's file names back at them, never logs one and never puts
            // one on the pasteboard — this sheet is presented inside another
            // app's process tree, and what it draws is the most public surface
            // this product has.
            Text(L10n.plural(.shareItemCount, model.itemCount))
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        // One element, so VoiceOver reads "Send with Relayium, 3 items" rather
        // than stopping between the two.
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var content: some View {
        switch model.stage {
        case .ready:
            ready
        case let .copying(staged):
            // Labelled, not a bare spinner: on a large video this is the longest
            // part of the whole flow, and a bare `ProgressView()` says nothing at
            // all to VoiceOver. A count rather than a percentage, because a
            // shared folder's size is not known until it has been walked and a
            // bar that cannot fill is worse than a number that climbs.
            VStack(alignment: .leading, spacing: 16) {
                ProgressView {
                    Text(L10n.t(.shareCopying, [L10n.plural(.downloadFileCount, staged)]))
                }
                Button(L10n.t(.commonCancel)) { model.cancel() }
            }
        case .published:
            saved
        case let .failed(message):
            failure(message)
        }
    }

    /// Before anything has been copied. The disclosure is above the action, in
    /// reading order, because it is what the action means.
    private var ready: some View {
        VStack(alignment: .leading, spacing: 16) {
            paragraph(L10n.t(.shareDisclosure))
            paragraph(L10n.t(.shareStaysHere))
            Button(action: model.start) {
                Text(L10n.t(.shareContinue)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            Button(L10n.t(.commonCancel)) { model.cancel() }
                .frame(maxWidth: .infinity)
        }
    }

    /// The terminal success state: the draft is complete, durable, and on this
    /// device, and nothing has been uploaded.
    ///
    /// It reads as SUCCESS, with a checkmark and a title, because that is what
    /// it is — this is not a fallback for an open that failed, and there is no
    /// open. A Share Extension may not bring its containing app forward, so
    /// "now open Relayium" is the honest next step rather than an apology, and
    /// the sentence above it is the one the whole surface exists to say: the
    /// files are here and none of them has left the device.
    private var saved: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label {
                Text(L10n.t(.shareSavedTitle)).font(.headline)
            } icon: {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
            }
            paragraph(L10n.t(.shareSavedBody))
            paragraph(L10n.t(.shareStaysHere))
            Button(action: model.done) {
                Text(L10n.t(.commonDone)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
        .accessibilityElement(children: .contain)
    }

    private func failure(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            // The icon carries the label rather than sitting beside an
            // unlabelled image, so VoiceOver reads the sentence and not "image".
            Label {
                Text(text).fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            }
            .font(.callout)
            Button(action: model.cancel) {
                Text(L10n.t(.commonDone)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
        }
    }

    /// Wrapping rather than truncating. At the largest Dynamic Type sizes these
    /// sentences are several lines on an iPhone, and the part that would be cut
    /// is the part that says nothing has been uploaded.
    private func paragraph(_ text: String) -> some View {
        Text(text)
            .font(.callout)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// The App Group is unreachable, or the share carried nothing this product can
/// send. One sentence and one way out — no Continue, because there is nothing
/// this extension could do next.
struct ShareUnavailableView: View {
    let message: String
    let onDismiss: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text(L10n.t(.shareHeading)).font(.headline)
                Label {
                    Text(message).fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                }
                .font(.callout)
                Button(action: onDismiss) {
                    Text(L10n.t(.commonDone)).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
