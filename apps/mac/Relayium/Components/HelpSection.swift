import RelayiumAppKit
import SwiftUI

/// **The help that ends every browseable destination — one line of it always on
/// screen, the rest behind a control that is obviously a control.**
///
/// The owner's report: a screen says what it is and hands you the controls, and
/// somebody who does not already know what a pairing code is, or where a sent
/// file ends up, has to leave the app to find out. So each destination ends with
/// six answers — purpose, the shortest path, what Relayium can see, where things
/// end up, what goes wrong and what to do about it — and, only where a
/// maintained document exists, a link to it.
///
/// ## Why this is a button now, and not a disclosure label
///
/// It was a `DisclosureGroup`, which on macOS is a bare triangle beside text.
/// Three things were wrong with that and none of them is taste:
///
///  - **The hit target was the triangle.** About twelve points square, in the
///    corner of a two-line label, and clicking the words themselves did nothing.
///    A reader who wanted the help had to aim at it.
///  - **It did not read as a control.** Grey caption text with a small grey
///    glyph, in a column of grey caption text, in both appearances — there was
///    nothing to distinguish the one line on the screen that could be opened.
///  - **It was the only weak affordance on five otherwise consistent screens.**
///    Everything else a user can press on this app is a `Button` with real
///    chrome; this was the exception, and it was the one aimed at whoever
///    understood the screen least.
///
/// So it is a full-row button in `HelpRowStyle`: the whole row is the target,
/// it is at least `Metrics.hitTarget` tall, it takes a focus ring under Full
/// Keyboard Access, and it hovers. It is drawn in the reference's quiet
/// secondary-button colours — the button fill and edge, violet on hover — which
/// answer light, dark and Increase Contrast through the asset catalog. The
/// chevron says which way it will go; the accessible value says which way it
/// currently is.
///
/// **`DisclosureGroup` is now banned everywhere again**, including here. The ban
/// existed because the root view once hid every signed-out CAPABILITY inside two
/// collapsed groups and nobody found them; the exception this file used to hold
/// was for hiding a paragraph rather than a feature, and a button does that job
/// with an affordance the control never had.
///
/// ## What stays visible, and why it is the purpose
///
/// The collapsed row carries `topic.purpose` — what this screen is for, in one
/// sentence. It used to carry step one, which was the right answer when help was
/// three steps and a question: "what do I do first" was the whole of it. It is
/// the wrong answer now. A reader who has not worked out what the screen IS
/// cannot use its first step, and a reader who has does not need it spelled out
/// on the row they are about to open anyway. So the numbered path starts at one
/// inside, in one piece, instead of being split across the fold.
///
/// Every destination, the Device Inbox included, is a stack of `SectionCard`s
/// in the scaffold's scroll view, so there is one shape and it ends each of them.
struct HelpCard: View {
    let surface: MacSurface

    var body: some View {
        if let topic = HelpPresentation.topic(for: surface) {
            HelpBlock(topic: topic)
                // Not a `SectionCard`: help is still the quietest thing on the
                // screen, and giving it the same chrome as the controls says the
                // opposite. What changed is that its one control now looks like
                // one; the block around it has no chrome of its own.
                .padding(.top, Metrics.tight)
        }
    }
}

/// One button, and everything behind it.
private struct HelpBlock: View {
    let topic: HelpTopic

    /// Collapsed by default, and per screen rather than per app: a reader who
    /// opened the Device Inbox's help has said nothing about wanting the LAN
    /// screen's. `@State` also means it resets when the destination is left,
    /// which is the behaviour a reader who opened it once expects.
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.inner) {
            toggle
            if expanded {
                details
            }
        }
        .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
    }

    // MARK: - the control

    /// The whole row, and nothing smaller.
    ///
    /// `.frame(maxWidth: .infinity, minHeight:)` is on the LABEL rather than on
    /// the button, so the border the style draws is the size of the target
    /// instead of shrinking to the text inside it — a bordered button whose
    /// chrome stops short of its own hit area is the same miss the triangle was,
    /// with a rectangle around it.
    private var toggle: some View {
        Button {
            expanded.toggle()
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: Metrics.tight) {
                Image(systemName: "questionmark.circle")
                    .foregroundStyle(Palette.actionLabel)
                    // The heading beside it already says "Help"; spoken, the
                    // symbol would be a second name for the same thing.
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: Metrics.hairline) {
                    Text(L10n.t(.helpHeading))
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(Palette.text)
                    Text(L10n.t(topic.purpose))
                        .font(.subheadline)
                        .foregroundStyle(Palette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .multilineTextAlignment(.leading)
                }
                Spacer(minLength: Metrics.tight)
                Image(systemName: expanded ? "chevron.up" : "chevron.down")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(Palette.textTertiary)
                    // The direction is stated to VoiceOver as the button's
                    // VALUE below, which is the shape assistive technology
                    // expects for an expandable control. Read as a glyph name
                    // it would be a second, worse copy of the same fact.
                    .accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, minHeight: Metrics.hitTarget, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(HelpRowStyle())
        // On the button, which IS the accessibility element: it combines its
        // label into one, so there is no child left for an identifier to rename.
        .accessibilityIdentifier("destination-help")
        .accessibilityValue(L10n.t(expanded ? .helpExpandedValue : .helpCollapsedValue))
        .accessibilityHint(L10n.t(expanded ? .helpCollapseHint : .helpExpandHint))
    }

    // MARK: - what is behind it

    private var details: some View {
        VStack(alignment: .leading, spacing: Metrics.inner) {
            steps
            block(heading: .helpBoundaryHeading, body: topic.boundary)
            block(heading: .helpWhereHeading, body: topic.destination)
            trouble
            guideLink
        }
        .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
    }

    /// The shortest path that works, numbered from one and complete.
    private var steps: some View {
        VStack(alignment: .leading, spacing: Metrics.hairline) {
            Text(L10n.t(.helpStepsHeading))
                .font(.callout.weight(.semibold))
                .foregroundStyle(Palette.text)
            ForEach(Array(topic.steps.enumerated()), id: \.offset) { index, text in
                step(text, number: index + 1)
            }
        }
        // One spoken group. Read control by control, numbered fragments
        // announce as unrelated sentences.
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L10n.t(.helpStepsHeading))
    }

    /// The two halves of a dead end, under one heading: a screen that names the
    /// failure and stops has told the reader they are stuck.
    private var trouble: some View {
        VStack(alignment: .leading, spacing: Metrics.hairline) {
            Text(L10n.t(.helpTroubleHeading))
                .font(.callout.weight(.semibold))
                .foregroundStyle(Palette.text)
            prose(topic.failure)
            prose(topic.recovery)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L10n.t(.helpTroubleHeading))
    }

    private func block(heading: L10nKey, body: L10nKey) -> some View {
        VStack(alignment: .leading, spacing: Metrics.hairline) {
            Text(L10n.t(heading))
                .font(.callout.weight(.semibold))
                .foregroundStyle(Palette.text)
            prose(body)
        }
        .accessibilityElement(children: .combine)
    }

    private func prose(_ key: L10nKey) -> some View {
        Text(L10n.t(key))
            .font(.subheadline)
            .foregroundStyle(Palette.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// Numbered, with the numeral and its separator positioned by the catalog
    /// rather than composed here — `"\(n). "` is English punctuation, and this
    /// renders in both shipped languages.
    private func step(_ key: L10nKey, number: Int) -> some View {
        Text(L10n.t(.formatHelpStep, [L10n.number(number), L10n.t(key)]))
            .font(.subheadline)
            .foregroundStyle(Palette.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// Only where one exists. See `HelpPresentation` for why this is optional
    /// rather than a "learn more" on every screen, and for why a frozen locale
    /// is sent to the maintained page rather than to its own archive.
    @ViewBuilder
    private var guideLink: some View {
        if let guide = topic.guide {
            Link(L10n.t(.helpGuideLink),
                 destination: HelpPresentation.url(for: guide, language: L10n.current))
                .font(.subheadline)
                .accessibilityIdentifier("destination-help-guide")
        }
    }
}

/// The help row's chrome: the reference's quiet secondary button, at the size
/// of the whole row. Deliberately not a card — help stays the quietest thing on
/// a screen — and never violet at rest.
private struct HelpRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        HelpRow(configuration: configuration)
    }

    private struct HelpRow: View {
        let configuration: ButtonStyleConfiguration
        @State private var hovering = false

        var body: some View {
            configuration.label
                .padding(.horizontal, Metrics.rowHorizontal)
                .padding(.vertical, Metrics.hairline)
                .background(
                    RoundedRectangle(cornerRadius: Metrics.buttonCorner + 2)
                        .fill(hovering ? Palette.actionSurface : Palette.button)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: Metrics.buttonCorner + 2)
                        .strokeBorder(Palette.buttonBorder, lineWidth: 1)
                )
                .opacity(configuration.isPressed ? 0.85 : 1)
                .onHover { hovering = $0 }
        }
    }
}
