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
///
/// **Phase C: the same three roles the app uses, and no fourth one here.** This
/// was the last first-party iOS surface still drawing its own chrome — a
/// `Divider` under the heading, a hand-rolled orange triangle beside a failure,
/// and two secondary paragraphs, a primary action and a bare text Cancel all
/// twenty points apart down one column, so nothing on the screen said which of
/// them was the task. It now uses exactly what the five tabs use: `SectionCard`
/// where a state has content to group, `InlineMessage` for the sentence a state
/// is about, and `Metrics` for every gap. The rules it inherits with them are
/// the app's, not new ones:
///
///  * **A card only where there is something to group.** Copying is a wait, and
///    a card around a progress label is a box around a sentence — the same
///    reason `ReceiveView` leaves resolving and downloading uncarded. Ready and
///    Saved are grouped; copying and the two failures are not.
///  * **The card is untitled.** Its only honest title would be the item count,
///    which is the line directly above it.
///  * **One prominent button per state, and it is the way forward.** Continue,
///    then Done. Cancel is bordered beside it rather than bare text, which also
///    gives it the same 44-point target the rest of the app's controls have.
///
/// What did not change: the words, the states, the order they are read in, and
/// the count that is the only thing this sheet says about the share.
struct ShareRootView: View {
    @ObservedObject var model: SharedDraftPreparation

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.section) {
                header
                content
            }
            .padding(Metrics.section)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// The sheet's own title, and the count under it.
    ///
    /// It carries no `Divider` any more. The rule the app settled on is that a
    /// card's edge is the separation — one boundary vocabulary rather than a
    /// rule here and a fill below it — and in the two states that have no card
    /// there is nothing under the heading for a line to separate it from.
    private var header: some View {
        VStack(alignment: .leading, spacing: Metrics.tight) {
            Text(L10n.t(.shareHeading))
                .font(.headline)
                .fixedSize(horizontal: false, vertical: true)
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
                .fixedSize(horizontal: false, vertical: true)
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
            copying(staged)
        case .published:
            saved
        case let .failed(message):
            failure(message)
        }
    }

    /// Before anything has been copied. The disclosure is above the action, in
    /// reading order, because it is what the action means.
    ///
    /// Untitled, and deliberately: the only honest title this card could carry
    /// is the item count, which is the line immediately above it. That is the
    /// repetition `SectionCard` is documented against and the one the Mac's
    /// second audit removed.
    private var ready: some View {
        SectionCard {
            paragraph(L10n.t(.shareDisclosure))
            // The privacy promise, in the shared `info` role rather than as a
            // third grey paragraph. It is the sentence this whole surface
            // exists to say, and the role puts a symbol beside it so it still
            // reads as a standing fact to somebody skimming, with a colour
            // filter on, or in Increase Contrast.
            InlineMessage(.info, L10n.t(.shareStaysHere))
            Button(action: model.start) {
                Text(L10n.t(.shareContinue)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            cancelButton
        }
    }

    /// A wait, and therefore uncarded.
    ///
    /// Labelled, not a bare spinner: on a large video this is the longest part
    /// of the whole flow, and a bare `ProgressView()` says nothing at all to
    /// VoiceOver. A count rather than a percentage, because a shared folder's
    /// size is not known until it has been walked and a bar that cannot fill is
    /// worse than a number that climbs.
    private func copying(_ staged: Int) -> some View {
        VStack(alignment: .leading, spacing: Metrics.inner) {
            ProgressView {
                Text(L10n.t(.shareCopying, [L10n.plural(.downloadFileCount, staged)]))
                    .fixedSize(horizontal: false, vertical: true)
            }
            cancelButton
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
    ///
    /// The same shape as `ReceiveView`'s done card, for the same reason: a
    /// `SectionCard` title is a `String` and the green check has to sit beside
    /// the words, so the `Label` carries the header trait instead and VoiceOver
    /// still meets the result on entering the group.
    private var saved: some View {
        SectionCard {
            Label {
                Text(L10n.t(.shareSavedTitle))
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "checkmark.circle.fill") // nonlocalized: SF Symbol name
                    .foregroundStyle(.green)
            }
            .font(.headline)
            .accessibilityAddTraits(.isHeader)
            paragraph(L10n.t(.shareSavedBody))
            InlineMessage(.info, L10n.t(.shareStaysHere))
            Button(action: model.done) {
                Text(L10n.t(.commonDone)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
    }

    /// Nothing was published and nothing was left behind.
    ///
    /// Uncarded, like every other failure in the app: the sentence is the whole
    /// content, and a box around one sentence is chrome. `InlineMessage` is the
    /// shared warning role — this file used to draw its own triangle, its own
    /// orange and its own combine, which is exactly the duplication the
    /// component replaced on the five tabs.
    ///
    /// Done is prominent here, where `ReceiveView`'s failure keeps a bordered
    /// Try again: this is a sheet with nothing else on it and no second
    /// attempt, so acknowledging it IS the remaining task rather than the
    /// quieter of two choices.
    private func failure(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: Metrics.inner) {
            InlineMessage(.warning, text)
            Button(action: model.cancel) {
                Text(L10n.t(.commonDone)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
    }

    /// Bordered and large rather than bare text, which is what it was: the app
    /// gives every control a 44-point target and a visible edge, and a plain
    /// label under a prominent button reads as a caption rather than the way
    /// out.
    ///
    /// The width is on the LABEL, not on the button. `.frame` outside the style
    /// widens the button's slot and leaves the filled shape hugging its word in
    /// the middle of it, which is what this looked like first: a full-width
    /// Copy to Relayium above a small floating Cancel that belonged to neither
    /// edge. Inside, the shape fills — the same pair of stacked full-width
    /// actions `SendView` puts on a waiting draft.
    private var cancelButton: some View {
        Button(action: model.cancel) {
            Text(L10n.t(.commonCancel)).frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
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
///
/// It is the same shape as `ShareRootView`'s failure state and shares its roles:
/// the heading, the shared warning message, and one prominent way out. There is
/// no item count under the heading here, because in both of these cases there is
/// nothing this extension counted.
struct ShareUnavailableView: View {
    let message: String
    let onDismiss: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.section) {
                Text(L10n.t(.shareHeading))
                    .font(.headline)
                    .fixedSize(horizontal: false, vertical: true)
                VStack(alignment: .leading, spacing: Metrics.inner) {
                    InlineMessage(.warning, message)
                    Button(action: onDismiss) {
                        Text(L10n.t(.commonDone)).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                }
            }
            .padding(Metrics.section)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
