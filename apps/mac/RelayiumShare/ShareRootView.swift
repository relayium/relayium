import RelayiumShareKit
import SwiftUI

/// The whole of what the Share menu shows on macOS.
///
/// One surface with four states and no navigation, because it is presented
/// inside somebody else's app and the user is two clicks from being finished.
/// Every state says the same two things in some form: what is about to happen to
/// their files, and where those files are.
///
/// **It is a separate file from the iOS one on purpose, and shares everything
/// that matters.** Both render the same `SharedDraftPreparation` states and the
/// same `L10n` keys, so the copy and the behaviour are single-sourced; only the
/// layout is per-platform, and it legitimately differs — this is a fixed-size
/// panel rather than an iPhone-height sheet, and the accessibility-size
/// reasoning that shapes the iOS column does not transfer. Unifying the two is a
/// recorded follow-up, deliberately not taken while the iOS extension is shipped
/// and can only be re-verified on a physical device.
///
/// ## The reference layout, from system colours
///
/// It follows the app's reference rhythm — a named head, one inset card with
/// 11pt corners and a hairline edge, and the panel's buttons trailing beneath
/// it. It cannot use the app's palette: this target's synchronized folder holds
/// only these two files, so neither the app's asset-catalog colours nor its
/// `Components` exist here. The card is drawn from AppKit's own semantic
/// colours instead, which answer light, dark and Increase Contrast inside
/// whichever app is hosting the panel, and the push buttons stay native because
/// Return and Escape have to behave the way that host's other panels do.
struct ShareRootView: View {
    @ObservedObject var model: SharedDraftPreparation

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                content
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 11) {
            ShareGlyph(symbol: "paperplane.fill")
            VStack(alignment: .leading, spacing: 1) {
                Text(L10n.t(.shareHeading))
                    .font(.body.weight(.semibold))
                // ITEMS, not files. The Share menu hands over providers, and one
                // shared folder is one provider and may be a thousand files — so
                // "3 files" here would be a number nothing has measured. The copying
                // label below counts staged files, which is measured.
                //
                // A COUNT and nothing else, either way. This extension never lists
                // the user's file names back at them, never logs one and never puts
                // one on the pasteboard: it draws inside another app's process tree,
                // which makes it the most public surface this product has.
                Text(L10n.plural(.shareItemCount, model.itemCount))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
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
            VStack(alignment: .leading, spacing: 14) {
                ShareCard {
                    ProgressView {
                        Text(L10n.t(.shareCopying, [L10n.plural(.downloadFileCount, staged)]))
                            .font(.callout)
                    }
                }
                HStack {
                    Spacer()
                    Button(L10n.t(.commonCancel)) { model.cancel() }
                }
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
        VStack(alignment: .leading, spacing: 14) {
            ShareCard {
                paragraph(L10n.t(.shareDisclosure))
                paragraph(L10n.t(.shareStaysHere))
            }
            // Trailing, which is where a macOS panel puts its confirming button,
            // and `.defaultAction` so Return does the obvious thing. Cancel sits
            // beside it rather than below: this is a panel, not a phone sheet.
            HStack {
                Spacer()
                Button(L10n.t(.commonCancel)) { model.cancel() }
                Button(L10n.t(.shareContinue), action: model.start)
                    .keyboardShortcut(.defaultAction)
            }
        }
    }

    /// The terminal success state: the draft is complete, durable, and on this
    /// device, and nothing has been uploaded.
    ///
    /// It reads as SUCCESS, with a checkmark and a title, because that is what it
    /// is — this is not a fallback for an open that failed, and there is no open.
    /// A Share extension may not bring its containing app forward, so "now open
    /// Relayium" is the honest next step rather than an apology, and the sentence
    /// above it is the one the whole surface exists to say: the files are here
    /// and none of them has left the device.
    private var saved: some View {
        VStack(alignment: .leading, spacing: 14) {
            ShareCard {
                Label {
                    Text(L10n.t(.shareSavedTitle)).font(.body.weight(.semibold))
                } icon: {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                }
                paragraph(L10n.t(.shareSavedBody))
                paragraph(L10n.t(.shareStaysHere))
            }
            HStack {
                Spacer()
                Button(L10n.t(.commonDone), action: model.done)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func failure(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            // The icon carries the label rather than sitting beside an
            // unlabelled image, so VoiceOver reads the sentence and not "image".
            ShareCard {
                Label {
                    Text(text).fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                }
                .font(.callout)
            }
            HStack {
                Spacer()
                Button(L10n.t(.commonDone), action: model.cancel)
                    .keyboardShortcut(.defaultAction)
            }
        }
    }

    /// Wrapping rather than truncating. These sentences are several lines in the
    /// longer languages at this panel's width, and the part that would be cut is
    /// the part that says nothing has been uploaded.
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
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .center, spacing: 11) {
                    ShareGlyph(symbol: "paperplane.fill")
                    Text(L10n.t(.shareHeading)).font(.body.weight(.semibold))
                    Spacer(minLength: 0)
                }
                ShareCard {
                    Label {
                        Text(message).fixedSize(horizontal: false, vertical: true)
                    } icon: {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    }
                    .font(.callout)
                }
                HStack {
                    Spacer()
                    Button(L10n.t(.commonDone), action: onDismiss)
                        .keyboardShortcut(.defaultAction)
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// The reference's inset card, from AppKit's semantic colours: the control
/// background as the fill and the separator as a one-point edge.
private struct ShareCard<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 12)
        .padding(.horizontal, 14)
        .background(RoundedRectangle(cornerRadius: 11)
            .fill(Color(nsColor: .controlBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 11)
            .strokeBorder(Color(nsColor: .separatorColor), lineWidth: 1))
    }
}

/// The head's glyph on a chip, in the system accent the hosting app draws with.
private struct ShareGlyph: View {
    let symbol: String

    var body: some View {
        Image(systemName: symbol)
            .font(.callout)
            .foregroundStyle(.tint)
            .frame(width: 30, height: 30)
            .background(RoundedRectangle(cornerRadius: 9)
                .fill(Color(nsColor: .quaternaryLabelColor)))
            .accessibilityHidden(true)
    }
}
