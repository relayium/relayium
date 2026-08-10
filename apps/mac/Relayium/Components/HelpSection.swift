import RelayiumAppKit
import SwiftUI

/// **The short tutorial that now ends every browseable destination.**
///
/// The owner's report: a screen says what it is and hands you the controls, and
/// somebody who does not already know what a pairing code is, or where a sent
/// file ends up, has to leave the app to find out. So each destination ends with
/// three steps, one common question, and — only where a maintained document
/// exists — a link to it.
///
/// ## Non-collapsed, on purpose, and not a `DisclosureGroup`
///
/// `DisclosureGroup` is banned in this app and `MacSurfaceGuardTests` enforces
/// that by name: the root view once hid every signed-out capability inside two
/// collapsed groups, and nobody found them. Help that has to be opened before it
/// can be read is help for people who already know it is there. It is short
/// enough to sit open — three steps and one answer — and it sits at the BOTTOM,
/// below the controls, so it costs a reader who does not need it nothing but
/// scroll.
///
/// It also adds no heading of the destination's own. The sidebar names the
/// screen and explains it; this names itself and nothing else.
///
/// ## Two shapes, one body
///
/// Four destinations are stacks of `SectionCard`s inside the scaffold's scroll
/// view; the Device Inbox is a grouped `Form`. A card dropped into a `Form`
/// draws a box inside a box, and a `Section` outside one draws nothing at all —
/// so the container differs and the content does not.
struct HelpCard: View {
    let surface: MacSurface

    var body: some View {
        if let topic = HelpPresentation.topic(for: surface) {
            SectionCard(title: L10n.t(.helpHeading)) {
                HelpBody(topic: topic)
            }
            .accessibilityIdentifier("destination-help")
        }
    }
}

/// The Device Inbox's shape: a `Form` section, and the LAST one.
///
/// Last because help below the controls is the whole arrangement, and because
/// this surface has three account/status branches that render different sets of
/// sections above it — putting it anywhere else would move it depending on
/// whether the user happens to be signed in.
struct HelpFormSection: View {
    let surface: MacSurface

    var body: some View {
        if let topic = HelpPresentation.topic(for: surface) {
            Section {
                HelpBody(topic: topic)
            } header: {
                // On the header LEAF, never on the `Section`: a container
                // identifier propagates down and renames the controls inside it,
                // which on this surface has already cost two controls.
                Text(L10n.t(.helpHeading))
                    .accessibilityIdentifier("destination-help")
            }
        }
    }
}

/// The content both shapes render.
private struct HelpBody: View {
    let topic: HelpTopic

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            steps
            question
            guideLink
        }
        .frame(maxWidth: 720, alignment: .leading)
    }

    /// Numbered, with the numeral and its separator positioned by the catalog
    /// rather than composed here — `"\(n). "` is English punctuation, and this
    /// renders in nine languages including one that reads right to left.
    private var steps: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(L10n.t(.helpStepsHeading))
                .font(.subheadline.weight(.semibold))
            ForEach(Array(topic.steps.enumerated()), id: \.offset) { index, step in
                Text(L10n.t(.formatHelpStep, [L10n.number(index + 1), L10n.t(step)]))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        // One spoken group. Read control by control, three numbered fragments
        // announce as three unrelated sentences.
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L10n.t(.helpStepsHeading))
    }

    private var question: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(L10n.t(topic.question))
                .font(.subheadline.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            Text(L10n.t(topic.answer))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    /// Only where one exists. See `HelpPresentation` for why this is optional
    /// rather than a "learn more" on every screen.
    @ViewBuilder
    private var guideLink: some View {
        if let guide = topic.guide {
            Link(L10n.t(.helpGuideLink),
                 destination: HelpPresentation.url(for: guide, language: L10n.current))
                .font(.caption)
                .accessibilityIdentifier("destination-help-guide")
        }
    }
}
